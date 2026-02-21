# Phase 1 — Core Execution Layer: SDK Executor + CLI Fallback

> **Copy-paste this entire prompt into Claude Code. Phase 0 must be completed first.**

---

```
We are continuing the "cowork-orchestrator" Agent SDK migration. Phase 0 (setup) is complete. Now implement the core execution layer that actually runs Claude sessions for task execution.

CRITICAL DESIGN DECISION: We implement TWO execution backends:
1. SDKExecutor — uses @anthropic-ai/claude-agent-sdk (preferred)
2. CLIExecutor — uses `claude -p` CLI subprocess (fallback)

Both use the logged-in Claude Pro/Max subscription. No API key needed. The CLIExecutor exists because the Agent SDK may not be available in all environments, and `claude -p` is universally available wherever Claude Code is installed.

## 1. src/execution/result-parser.ts — Parse SDK/CLI Output

Implement `ResultParser` class that converts raw output into our `SDKExecutionResult` type:

```typescript
import type { SDKExecutionResult, SDKMessage } from '../core/types.js';

export class ResultParser {
  /**
   * Parse streaming messages from the Agent SDK into a structured result.
   * The SDK emits various message types — we normalize them.
   */
  parseSDKStream(messages: unknown[], sessionId: string, startTime: number): SDKExecutionResult {
    // Walk through all messages from the SDK stream
    // Extract: final result text, tools used, files modified, model used, turn count
    // Each SDK message has a type — handle:
    //   - 'assistant' messages with text content
    //   - 'tool_use' messages (track which tools were called)
    //   - 'tool_result' messages (track file modifications from Edit/Write tools)
    //   - 'error' messages
    // Build an SDKMessage[] array from the raw messages
    // The final text result is the last assistant message's text content
    // Return SDKExecutionResult with all fields populated
  }

  /**
   * Parse JSON output from `claude -p --output-format json` CLI command.
   */
  parseCLIOutput(jsonOutput: string, startTime: number): SDKExecutionResult {
    // Parse the JSON string
    // Expected shape from claude -p --output-format json:
    // {
    //   result: string,           // The text response
    //   session_id: string,       // Session UUID
    //   cost_usd: number,         // Cost (may be 0 for subscription)
    //   duration_ms: number,      // Execution time
    //   duration_api_ms: number,  // API time only
    //   is_error: boolean,
    //   num_turns: number,        // Number of agentic turns
    //   model: string,            // Model that was used
    //   total_cost_usd: number,
    // }
    // Map this to our SDKExecutionResult format
    // For CLI mode, we won't have detailed tool/file tracking — populate what we can
  }

  /**
   * Parse streaming JSON lines from `claude -p --output-format stream-json`.
   * Each line is a JSON object. Accumulate them into a full result.
   */
  parseStreamJSON(lines: string[]): SDKExecutionResult {
    // Parse each line as JSON
    // Stream events include:
    //   { type: "system", ... }        — session start
    //   { type: "assistant", ...}      — text chunks
    //   { type: "tool_use", ... }      — tool calls
    //   { type: "tool_result", ... }   — tool results
    //   { type: "result", ... }        — final result with metadata
    // Accumulate text, track tools used, build SDKMessage array
    // The last "result" event contains session_id, model, num_turns, etc.
  }
}
```

## 2. src/execution/session-manager.ts — Track Active Sessions

Implement `SessionManager` class:

```typescript
import type { SDKExecutionResult } from '../core/types.js';
import type { PersistenceLayer } from '../memory/persistence.js';

interface ActiveSession {
  sessionId: string;
  taskId: string;
  agentId: string;
  model: string;
  startedAt: number;
  pid?: number;          // Process ID for CLI sessions
  abortController?: AbortController;  // For SDK sessions
}

export class SessionManager {
  private activeSessions = new Map<string, ActiveSession>();
  private completedSessions: SDKExecutionResult[] = [];
  private persistence?: PersistenceLayer;

  constructor(persistence?: PersistenceLayer) {
    this.persistence = persistence;
    // If persistence is available, create a sessions table:
    // CREATE TABLE IF NOT EXISTS sdk_sessions (
    //   session_id TEXT PRIMARY KEY,
    //   task_id TEXT NOT NULL,
    //   agent_id TEXT NOT NULL,
    //   model TEXT NOT NULL,
    //   started_at INTEGER NOT NULL,
    //   completed_at INTEGER,
    //   duration INTEGER,
    //   turn_count INTEGER,
    //   tools_used TEXT,        -- JSON array
    //   files_modified TEXT,    -- JSON array
    //   success INTEGER,
    //   result_summary TEXT
    // )
  }

  /** Register a new active session */
  startSession(session: ActiveSession): void

  /** Mark a session as complete and archive it */
  completeSession(sessionId: string, result: SDKExecutionResult): void

  /** Get all currently active sessions */
  getActiveSessions(): ActiveSession[]

  /** Get a specific active session */
  getSession(sessionId: string): ActiveSession | undefined

  /** Abort a running session (cancel SDK or kill CLI process) */
  async abortSession(sessionId: string): Promise<boolean>

  /** Clean up stale sessions (older than timeout) */
  cleanupStale(timeoutMs: number): string[]

  /** Get recent completed sessions for monitoring */
  getRecentCompleted(limit?: number): SDKExecutionResult[]

  /** Get session history from persistence */
  getSessionHistory(filter?: { agentId?: string; taskId?: string; limit?: number }): SDKExecutionResult[]
}
```

## 3. src/execution/sdk-executor.ts — Agent SDK Wrapper

This is the PRIMARY execution backend. It uses the Claude Agent SDK to spawn real Claude sessions.

```typescript
import type { Task, TaskResult, SDKExecutionResult, ModelTier, ExecutionAgentConfig } from '../core/types.js';
import { ResultParser } from './result-parser.js';
import { SessionManager } from './session-manager.js';

export class SDKExecutor {
  private parser: ResultParser;
  private sessionManager: SessionManager;
  private available: boolean = false;

  constructor(sessionManager: SessionManager) {
    this.parser = new ResultParser();
    this.sessionManager = sessionManager;
    // Try to import the SDK and set this.available accordingly
    this.checkAvailability();
  }

  /** Check if the Agent SDK is importable and usable */
  private async checkAvailability(): Promise<void> {
    try {
      // Dynamic import to avoid hard failure if SDK isn't installed
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      if (sdk && typeof sdk.query === 'function') {
        this.available = true;
        console.log('[SDKExecutor] Agent SDK available');
      }
    } catch {
      this.available = false;
      console.log('[SDKExecutor] Agent SDK not available, will use CLI fallback');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Execute a task using the Claude Agent SDK.
   * This spawns a real Claude session that can read/write files, run commands, etc.
   */
  async execute(
    task: Task,
    agentConfig: ExecutionAgentConfig,
    modelTier: ModelTier,
  ): Promise<TaskResult> {
    const startTime = Date.now();
    const abortController = new AbortController();

    try {
      // Dynamic import the SDK
      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      // Build the prompt from the task
      const prompt = this.buildPrompt(task, agentConfig);

      // Map ModelTier to Claude model alias
      const model = this.resolveModel(modelTier);

      // Determine allowed tools based on agent config
      const allowedTools = agentConfig.allowedTools ?? [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
      ];

      // Determine max turns
      const maxTurns = agentConfig.maxTurns ?? this.getDefaultMaxTurns(modelTier);

      // Collect all messages from the SDK stream
      const messages: unknown[] = [];
      let sessionId = '';

      for await (const message of query({
        prompt,
        options: {
          model,
          allowedTools,
          maxTurns,
          systemPrompt: agentConfig.systemPrompt,
          cwd: agentConfig.workingDirectory,
          abortController,
        },
      })) {
        messages.push(message);

        // Extract session ID from first message if available
        if (!sessionId && message && typeof message === 'object') {
          const msg = message as Record<string, unknown>;
          if (msg.session_id) sessionId = String(msg.session_id);
          if (msg.sessionId) sessionId = String(msg.sessionId);
        }
      }

      // Parse the stream into our structured format
      const sdkResult = this.parser.parseSDKStream(messages, sessionId, startTime);

      // Track in session manager
      this.sessionManager.completeSession(sessionId, sdkResult);

      // Convert to TaskResult
      return {
        taskId: task.id,
        success: true,
        output: {
          text: sdkResult.result,
          toolsUsed: sdkResult.toolsUsed,
          filesModified: sdkResult.filesModified,
          turnCount: sdkResult.turnCount,
          modelUsed: sdkResult.modelUsed,
          sessionId: sdkResult.sessionId,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        output: {},
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /** Build a focused prompt for the Agent SDK session */
  private buildPrompt(task: Task, agentConfig: ExecutionAgentConfig): string {
    // Combine task description with input data into a clear, actionable prompt
    // Include:
    //   - Task name and description
    //   - Input data (formatted as context)
    //   - Priority level (so Claude knows how thorough to be)
    //   - Any dependencies/context from parent tasks
    //   - Clear instruction to produce a concrete result
    const parts: string[] = [
      `# Task: ${task.name}`,
      '',
      task.description,
      '',
    ];

    if (Object.keys(task.input).length > 0) {
      parts.push('## Context / Input Data');
      parts.push(JSON.stringify(task.input, null, 2));
      parts.push('');
    }

    parts.push(`Priority: ${task.priority}`);
    parts.push('');
    parts.push('Complete this task thoroughly. Provide your final result as clear, actionable output.');

    return parts.join('\n');
  }

  /** Map our ModelTier enum to Claude model aliases */
  private resolveModel(tier: ModelTier): string {
    // The claude CLI and Agent SDK accept these aliases:
    switch (tier) {
      case 'haiku': return 'haiku';
      case 'sonnet': return 'sonnet';
      case 'opus': return 'opus';
      default: return 'sonnet';
    }
  }

  /** Default max turns based on model tier (cost optimization) */
  private getDefaultMaxTurns(tier: ModelTier): number {
    switch (tier) {
      case 'haiku': return 5;    // Quick tasks, limit turns
      case 'sonnet': return 15;  // Standard tasks
      case 'opus': return 25;    // Complex tasks, more room
      default: return 10;
    }
  }
}
```

IMPORTANT: The actual Agent SDK API might differ slightly from what's shown above. When implementing, you MUST:
1. Import the SDK and inspect its actual exports: `Object.keys(require('@anthropic-ai/claude-agent-sdk'))`
2. Check the SDK's TypeScript types for the `query()` function signature
3. Adapt the code to match the REAL API — the above is based on documented behavior but the exact options/message shapes may differ
4. If `query()` doesn't exist or has a different name, find the equivalent function
5. Document any differences you find

## 4. src/execution/cli-executor.ts — CLI Fallback

This is the FALLBACK execution backend. It uses `claude -p` CLI subprocess.

```typescript
import { spawn } from 'child_process';
import type { Task, TaskResult, SDKExecutionResult, ModelTier, ExecutionAgentConfig } from '../core/types.js';
import { ResultParser } from './result-parser.js';
import { SessionManager } from './session-manager.js';

export class CLIExecutor {
  private parser: ResultParser;
  private sessionManager: SessionManager;
  private claudePath: string;
  private available: boolean = false;

  constructor(sessionManager: SessionManager) {
    this.parser = new ResultParser();
    this.sessionManager = sessionManager;
    this.claudePath = 'claude'; // Assumes claude is in PATH
    this.checkAvailability();
  }

  /** Check if the claude CLI is available */
  private async checkAvailability(): Promise<void> {
    try {
      // Run: claude --version
      const result = await this.runCommand('claude', ['--version']);
      if (result.exitCode === 0) {
        this.available = true;
        console.log(`[CLIExecutor] Claude CLI available: ${result.stdout.trim()}`);
      }
    } catch {
      this.available = false;
      console.log('[CLIExecutor] Claude CLI not available');
    }
  }

  isAvailable(): boolean {
    return this.available;
  }

  /**
   * Execute a task using `claude -p` CLI.
   * Spawns a subprocess, collects JSON output, parses into TaskResult.
   */
  async execute(
    task: Task,
    agentConfig: ExecutionAgentConfig,
    modelTier: ModelTier,
  ): Promise<TaskResult> {
    const startTime = Date.now();

    try {
      // Build the prompt
      const prompt = this.buildPrompt(task, agentConfig);

      // Build CLI arguments
      const args = this.buildArgs(agentConfig, modelTier);

      // Run: claude -p "prompt" --output-format json --model <model> ...
      const result = await this.runClaude(prompt, args, task.timeout);

      if (result.exitCode !== 0) {
        return {
          taskId: task.id,
          success: false,
          output: { stderr: result.stderr },
          error: `Claude CLI exited with code ${result.exitCode}: ${result.stderr}`,
          duration: Date.now() - startTime,
        };
      }

      // Parse the JSON output
      const sdkResult = this.parser.parseCLIOutput(result.stdout, startTime);

      // Track session
      this.sessionManager.completeSession(sdkResult.sessionId, sdkResult);

      return {
        taskId: task.id,
        success: true,
        output: {
          text: sdkResult.result,
          toolsUsed: sdkResult.toolsUsed,
          filesModified: sdkResult.filesModified,
          turnCount: sdkResult.turnCount,
          modelUsed: sdkResult.modelUsed,
          sessionId: sdkResult.sessionId,
        },
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        taskId: task.id,
        success: false,
        output: {},
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    }
  }

  /** Build CLI arguments array */
  private buildArgs(agentConfig: ExecutionAgentConfig, modelTier: ModelTier): string[] {
    const args: string[] = [
      '-p',                              // Print mode (non-interactive)
      '--output-format', 'json',         // Structured JSON output
      '--model', modelTier,              // Model alias (haiku/sonnet/opus)
    ];

    // Allowed tools
    if (agentConfig.allowedTools && agentConfig.allowedTools.length > 0) {
      args.push('--allowedTools', agentConfig.allowedTools.join(','));
    } else {
      // Default safe set
      args.push('--allowedTools', 'Read,Write,Edit,Bash,Glob,Grep');
    }

    // Max turns
    const maxTurns = agentConfig.maxTurns ?? 10;
    args.push('--max-turns', String(maxTurns));

    // System prompt
    if (agentConfig.systemPrompt) {
      args.push('--system-prompt', agentConfig.systemPrompt);
    }

    // No session persistence for automated tasks (cleaner)
    args.push('--no-session-persistence');

    return args;
  }

  /** Build prompt from task */
  private buildPrompt(task: Task, _agentConfig: ExecutionAgentConfig): string {
    const parts: string[] = [
      `# Task: ${task.name}`,
      '',
      task.description,
    ];

    if (Object.keys(task.input).length > 0) {
      parts.push('');
      parts.push('## Context / Input Data');
      parts.push(JSON.stringify(task.input, null, 2));
    }

    parts.push('');
    parts.push('Complete this task. Provide your final result clearly.');

    return parts.join('\n');
  }

  /** Spawn claude CLI and collect output */
  private runClaude(
    prompt: string,
    args: string[],
    timeout?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.claudePath, [...args, prompt], {
        timeout: timeout ?? 300_000,  // 5 min default
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', (err) => {
        reject(err);
      });
    });
  }

  /** Generic command runner (for version check etc.) */
  private runCommand(
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(cmd, args, {
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      proc.on('error', reject);
    });
  }
}
```

## 5. Create src/agents/sdk-agent.ts — New Agent Type

Create a NEW agent class that uses the execution layer instead of direct LLM calls.
This DOES NOT modify the existing LLMAgent — it creates a new agent type alongside it.

```typescript
import type { Task, TaskResult, ExecutionAgentConfig, ModelTier } from '../core/types.js';
import { BaseAgent } from './base-agent.js';
import type { SDKExecutor } from '../execution/sdk-executor.js';
import type { CLIExecutor } from '../execution/cli-executor.js';
import type { ModelRouter } from '../execution/model-router.js';

/**
 * SDKAgent — executes tasks using Claude Agent SDK or CLI fallback.
 * Unlike LLMAgent (which just gets text responses from an LLM API),
 * SDKAgent spawns real Claude sessions that can read/write files,
 * run commands, browse the web, etc.
 */
export class SDKAgent extends BaseAgent {
  private sdkExecutor: SDKExecutor;
  private cliExecutor: CLIExecutor;
  private modelRouter?: ModelRouter;
  private executionConfig: ExecutionAgentConfig;

  constructor(
    config: ExecutionAgentConfig,
    sdkExecutor: SDKExecutor,
    cliExecutor: CLIExecutor,
    modelRouter?: ModelRouter,
  ) {
    super(config);
    this.executionConfig = config;
    this.sdkExecutor = sdkExecutor;
    this.cliExecutor = cliExecutor;
    this.modelRouter = modelRouter;
  }

  async execute(task: Task): Promise<TaskResult> {
    // 1. Determine which model to use
    const modelTier: ModelTier = this.executionConfig.modelTier
      ?? this.modelRouter?.selectModel(task)
      ?? 'sonnet';

    // 2. Try SDK first, fall back to CLI
    if (this.sdkExecutor.isAvailable()) {
      return this.sdkExecutor.execute(task, this.executionConfig, modelTier);
    }

    if (this.cliExecutor.isAvailable()) {
      return this.cliExecutor.execute(task, this.executionConfig, modelTier);
    }

    // 3. Neither available
    return {
      taskId: task.id,
      success: false,
      output: {},
      error: 'No execution backend available. Ensure Claude Code is installed and you are logged in.',
      duration: 0,
    };
  }
}
```

## 6. Update src/index.ts exports

Add to the exports:

```typescript
export { SDKAgent } from './agents/sdk-agent.js';
```

## 7. Verify

1. `npx tsc --noEmit` — must compile with ZERO errors
2. `npm test` — all existing tests must still pass
3. Fix any compilation errors

Note: We are NOT changing the orchestrator's registerAgent or execution flow yet — that happens in Phase 4 when we wire everything together. For now we're building the components.

Commit: "feat: implement execution layer — SDK executor, CLI fallback, session manager, SDK agent"
```
