import type { ExecutionAgentConfig, SDKExecutionResult } from '../core/types.js';
import { ResultParser } from './result-parser.js';

// ─── SDK Executor ─────────────────────────────────────────────────────
// Runs prompts through the @anthropic-ai/claude-agent-sdk `query` function.
// Uses a dynamic import so that the SDK (ESM) can be loaded from CJS and so
// that a missing SDK does not hard-crash the module.

export class SDKExecutor {
  private readonly parser = new ResultParser();

  async execute(
    prompt: string,
    config: ExecutionAgentConfig,
    sessionId?: string,
  ): Promise<SDKExecutionResult> {
    const start = Date.now();

    let sdk: { query: (params: unknown) => AsyncIterable<unknown> };
    try {
      // Dynamic import allows CJS → ESM crossing and graceful failure.
      sdk = (await import('@anthropic-ai/claude-agent-sdk')) as typeof sdk;
    } catch (err) {
      return this.errorResult(sessionId ?? '', Date.now() - start, `SDK not available: ${String(err)}`);
    }

    try {
      const options: Record<string, unknown> = {
        systemPrompt: config.systemPrompt,
        model: config.model,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: config.sessionPersist ?? false,
      };

      if (sessionId) {
        options['resume'] = sessionId;
      }

      const queryStream = sdk.query({ prompt, options });
      const result = await this.parser.parseSDKStream(queryStream, 'sdk');

      // Preserve the original start time for accurate durationMs
      return { ...result, durationMs: Date.now() - start };
    } catch (err) {
      return this.errorResult(
        sessionId ?? '',
        Date.now() - start,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private errorResult(
    sessionId: string,
    durationMs: number,
    error: string,
  ): SDKExecutionResult {
    return {
      sessionId,
      mode: 'sdk',
      output: '',
      messages: [],
      durationMs,
      success: false,
      error,
    };
  }
}
