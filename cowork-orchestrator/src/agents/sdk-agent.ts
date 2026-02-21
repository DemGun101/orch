import type { Task, TaskResult, ExecutionAgentConfig } from '../core/types.js';
import type { PersistenceLayer } from '../memory/persistence.js';
import { BaseAgent } from './base-agent.js';
import { SDKExecutor } from '../execution/sdk-executor.js';
import { CLIExecutor } from '../execution/cli-executor.js';
import { SessionManager } from '../execution/session-manager.js';

// ─── SDK Agent ────────────────────────────────────────────────────────
// Extends BaseAgent with Claude Agent SDK / CLI execution.
// Execution order:
//   1. SDK  (unless mode === 'cli')
//   2. CLI fallback (if SDK fails and mode !== 'sdk')

export class SDKAgent extends BaseAgent {
  private readonly sdkExecutor: SDKExecutor;
  private readonly cliExecutor: CLIExecutor;
  private readonly sessionManager: SessionManager | null;
  private readonly sdkConfig: ExecutionAgentConfig;

  constructor(config: ExecutionAgentConfig, persistence?: PersistenceLayer) {
    super(config);
    this.sdkConfig = config;
    this.sdkExecutor = new SDKExecutor();
    this.cliExecutor = new CLIExecutor();
    this.sessionManager = persistence ? new SessionManager(persistence) : null;
  }

  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    this.assignTask(task);

    const prompt = this.buildPrompt(task);

    try {
      let sessionId: string | undefined;

      // Persist session if configured
      if (this.sdkConfig.sessionPersist && this.sessionManager) {
        sessionId = await this.sessionManager.createSession(this.id);
      }

      const mode = this.sdkConfig.executionMode ?? 'sdk';
      let executionResult = await this.runExecution(mode, prompt, sessionId);

      // Fallback: SDK failed and we're not locked to SDK-only
      if (!executionResult.success && mode !== 'sdk' && mode !== 'cli') {
        executionResult = await this.cliExecutor.execute(prompt, this.sdkConfig);
      }

      // Update session metadata
      if (sessionId && this.sessionManager) {
        await this.sessionManager.touchSession(sessionId, executionResult.messages.length);
      }

      const taskResult: TaskResult = {
        taskId: task.id,
        success: executionResult.success,
        output: {
          text: executionResult.output,
          sessionId: executionResult.sessionId,
          mode: executionResult.mode,
        },
        error: executionResult.error,
        tokenUsage: executionResult.tokenUsage,
        duration: Date.now() - start,
      };

      if (executionResult.success) {
        this.completeTask(task.id, taskResult);
      } else {
        this.failTask(task.id, executionResult.error ?? 'execution failed');
      }

      return taskResult;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      const taskResult: TaskResult = {
        taskId: task.id,
        success: false,
        output: {},
        error,
        duration: Date.now() - start,
      };
      this.failTask(task.id, error);
      return taskResult;
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────

  private buildPrompt(task: Task): string {
    const inputStr = Object.keys(task.input).length
      ? `\n\nInput:\n${JSON.stringify(task.input, null, 2)}`
      : '';
    return `${task.description}${inputStr}`;
  }

  private async runExecution(
    mode: 'sdk' | 'cli' | 'api',
    prompt: string,
    sessionId?: string,
  ) {
    if (mode === 'cli') {
      return this.cliExecutor.execute(prompt, this.sdkConfig);
    }
    return this.sdkExecutor.execute(prompt, this.sdkConfig, sessionId);
  }
}
