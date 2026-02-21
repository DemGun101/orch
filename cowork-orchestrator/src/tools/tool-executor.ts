import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { EventEmitter } from 'eventemitter3';
import type { ToolCall, ToolResult } from '../core/types.js';
import type { ToolRegistry } from './tool-registry.js';
import { CircuitBreaker, CircuitOpenError } from '../resilience/retry-strategies.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface ToolSafetyConfig {
  allowedPaths: string[];
  blockedCommands: string[];
  maxOutputSize: number;
  requireApproval: string[];
  defaultTimeout: number;
}

interface ExecutorEvents {
  'tool:executed': (toolName: string, result: ToolResult) => void;
  'tool:error': (toolName: string, error: string) => void;
  'approval-needed': (toolName: string, input: unknown) => void;
}

const DEFAULT_SAFETY: ToolSafetyConfig = {
  allowedPaths: [],
  blockedCommands: ['rm -rf /', 'mkfs', 'dd', ':(){', 'shutdown', 'reboot'],
  maxOutputSize: 102400,
  requireApproval: [],
  defaultTimeout: 30000,
};

// ─── Tool Executor ─────────────────────────────────────────────────

export class ToolExecutor {
  private registry: ToolRegistry;
  private safety: ToolSafetyConfig;
  private emitter = new EventEmitter<ExecutorEvents>();
  private toolCircuitBreakers = new Map<string, CircuitBreaker>();

  constructor(registry: ToolRegistry, config?: Partial<ToolSafetyConfig>) {
    this.registry = registry;
    this.safety = { ...DEFAULT_SAFETY, ...config };
  }

  private getToolCircuitBreaker(toolName: string): CircuitBreaker {
    if (!this.toolCircuitBreakers.has(toolName)) {
      this.toolCircuitBreakers.set(toolName, new CircuitBreaker({
        failureThreshold: 3,
        recoveryTimeout: 15000,
      }));
    }
    return this.toolCircuitBreakers.get(toolName)!;
  }

  // ── Event helpers (typed, avoids EE3 v5 variance issues) ────────

  onToolExecuted(handler: (toolName: string, result: ToolResult) => void): () => void {
    this.emitter.on('tool:executed', handler);
    return () => this.emitter.off('tool:executed', handler);
  }

  onToolError(handler: (toolName: string, error: string) => void): () => void {
    this.emitter.on('tool:error', handler);
    return () => this.emitter.off('tool:error', handler);
  }

  onApprovalNeeded(handler: (toolName: string, input: unknown) => void): () => void {
    this.emitter.on('approval-needed', handler);
    return () => this.emitter.off('approval-needed', handler);
  }

  // ── Single tool execution ───────────────────────────────────────

  async execute(toolName: string, input: unknown): Promise<ToolResult> {
    const start = Date.now();
    try {
      // 1. Check tool exists
      const tool = this.registry.get(toolName);
      if (!tool) {
        return this.fail(`Unknown tool: ${toolName}`, start);
      }

      // 2. Validate input
      if (!this.registry.validate(toolName, input)) {
        return this.fail(`Invalid input for tool: ${toolName}`, start);
      }

      // 3. Safety: approval
      if (this.safety.requireApproval.includes(toolName)) {
        this.emitter.emit('approval-needed', toolName, input);
        return this.fail(`Tool "${toolName}" requires approval`, start);
      }

      // 4. Safety: path / command checks
      const safetyError = this.checkSafety(toolName, input as Record<string, unknown>);
      if (safetyError) {
        return this.fail(safetyError, start);
      }

      // 5. Check circuit breaker
      const circuitBreaker = this.getToolCircuitBreaker(toolName);
      try {
        const output = await circuitBreaker.execute(() =>
          this.withTimeout(
            this.dispatch(toolName, input as Record<string, unknown>),
            this.safety.defaultTimeout,
          ),
        );

        // 6. Truncate if needed
        const truncated = this.truncate(output);

        const result: ToolResult = { success: true, output: truncated, duration: Date.now() - start };
        this.emitter.emit('tool:executed', toolName, result);
        return result;
      } catch (cbErr) {
        if (cbErr instanceof CircuitOpenError) {
          return this.fail(`Tool "${toolName}" temporarily unavailable`, start);
        }
        throw cbErr;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const result = this.fail(message, start);
      this.emitter.emit('tool:error', toolName, message);
      return result;
    }
  }

  // ── Batch execution ─────────────────────────────────────────────

  async executeBatch(calls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(calls.map((c) => this.execute(c.toolName, c.input)));
  }

  // ── Built-in handlers ───────────────────────────────────────────

  private async dispatch(toolName: string, input: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'read_file':
        return fs.readFile(input.path as string, 'utf-8');

      case 'write_file':
        await fs.writeFile(input.path as string, input.content as string, 'utf-8');
        return `Written ${(input.content as string).length} bytes to ${input.path}`;

      case 'list_directory': {
        const entries = await fs.readdir(input.path as string, { withFileTypes: true });
        return entries.map((e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`).join('\n');
      }

      case 'execute_command': {
        const stdout = execSync(input.command as string, {
          timeout: this.safety.defaultTimeout,
          encoding: 'utf-8',
          maxBuffer: this.safety.maxOutputSize,
        });
        return stdout;
      }

      case 'web_search':
        return 'Web search not yet implemented';

      default:
        throw new Error(`No handler for tool: ${toolName}`);
    }
  }

  // ── Safety checks ──────────────────────────────────────────────

  private checkSafety(toolName: string, input: Record<string, unknown>): string | null {
    // Path safety for file tools
    if (['read_file', 'write_file', 'list_directory'].includes(toolName)) {
      const targetPath = path.resolve(input.path as string);
      if (
        this.safety.allowedPaths.length > 0 &&
        !this.safety.allowedPaths.some((ap) => targetPath.startsWith(path.resolve(ap)))
      ) {
        return `Path "${targetPath}" is outside allowed paths`;
      }
    }

    // Command blocklist
    if (toolName === 'execute_command') {
      const cmd = (input.command as string).toLowerCase();
      for (const blocked of this.safety.blockedCommands) {
        if (cmd.includes(blocked.toLowerCase())) {
          return `Command blocked: contains "${blocked}"`;
        }
      }
    }

    return null;
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private fail(error: string, start: number): ToolResult {
    return { success: false, output: null, error, duration: Date.now() - start };
  }

  private truncate(output: unknown): unknown {
    if (typeof output === 'string' && output.length > this.safety.maxOutputSize) {
      return output.slice(0, this.safety.maxOutputSize) + '\n... [truncated]';
    }
    return output;
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  }
}
