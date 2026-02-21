import type { SDKExecutionResult, ExecutionMessage } from '../core/types.js';

// ─── Result Parser ────────────────────────────────────────────────────
// Converts raw SDK stream messages and CLI output into SDKExecutionResult.

export class ResultParser {
  /**
   * Iterate an async SDK query generator and accumulate a result.
   * `stream` is typed as AsyncIterable<unknown> to avoid a hard dependency
   * on the SDK's declared types (which pull in @anthropic-ai/sdk).
   */
  async parseSDKStream(
    stream: AsyncIterable<unknown>,
    mode: 'sdk' | 'cli' | 'api' = 'sdk',
  ): Promise<SDKExecutionResult> {
    const start = Date.now();
    const messages: ExecutionMessage[] = [];
    let output = '';
    let sessionId = '';
    let tokenUsage: { input: number; output: number } | undefined;
    let success = true;
    let error: string | undefined;

    try {
      for await (const raw of stream) {
        const msg = raw as Record<string, unknown>;

        // Capture session_id from the first message that provides it
        if (!sessionId && typeof msg['session_id'] === 'string') {
          sessionId = msg['session_id'];
        }

        if (msg['type'] === 'assistant') {
          const content = this.extractAssistantText(msg);
          if (content) {
            messages.push({ role: 'assistant', content, timestamp: new Date() });
            output = content;
          }
        } else if (msg['type'] === 'user') {
          const userMsg = msg['message'] as Record<string, unknown> | undefined;
          const text = this.extractUserText(userMsg);
          if (text) {
            messages.push({ role: 'user', content: text, timestamp: new Date() });
          }
        } else if (msg['type'] === 'result') {
          const subtype = msg['subtype'];
          if (subtype === 'success') {
            output = typeof msg['result'] === 'string' ? msg['result'] : output;
            const usage = msg['usage'] as Record<string, unknown> | undefined;
            if (usage) {
              tokenUsage = {
                input: (usage['input_tokens'] as number) ?? 0,
                output: (usage['output_tokens'] as number) ?? 0,
              };
            }
          } else {
            success = false;
            const errors = msg['errors'];
            error = Array.isArray(errors) ? errors.join('; ') : String(subtype);
          }
        }
      }
    } catch (err) {
      success = false;
      error = err instanceof Error ? err.message : String(err);
    }

    return {
      sessionId,
      mode,
      output,
      messages,
      tokenUsage,
      durationMs: Date.now() - start,
      success,
      error,
    };
  }

  /**
   * Parse line-delimited JSON from `claude -p --output-format stream-json`.
   */
  parseCLIOutput(raw: string, sessionId: string, durationMs: number): SDKExecutionResult {
    const messages: ExecutionMessage[] = [];
    let output = '';
    let tokenUsage: { input: number; output: number } | undefined;
    let success = true;
    let error: string | undefined;
    let resolvedSessionId = sessionId;

    const lines = raw.split('\n').filter((l) => l.trim().length > 0);

    for (const line of lines) {
      const msg = this.parseStreamJSON(line);
      if (!msg) continue;

      if (!resolvedSessionId && typeof msg['session_id'] === 'string') {
        resolvedSessionId = msg['session_id'] as string;
      }

      if (msg['type'] === 'assistant') {
        const content = this.extractAssistantText(msg);
        if (content) {
          messages.push({ role: 'assistant', content, timestamp: new Date() });
          output = content;
        }
      } else if (msg['type'] === 'result') {
        if (msg['subtype'] === 'success') {
          output = typeof msg['result'] === 'string' ? (msg['result'] as string) : output;
          const usage = msg['usage'] as Record<string, unknown> | undefined;
          if (usage) {
            tokenUsage = {
              input: (usage['input_tokens'] as number) ?? 0,
              output: (usage['output_tokens'] as number) ?? 0,
            };
          }
        } else {
          success = false;
          const errors = msg['errors'];
          error = Array.isArray(errors)
            ? (errors as string[]).join('; ')
            : String(msg['subtype']);
        }
      }
    }

    return {
      sessionId: resolvedSessionId,
      mode: 'cli',
      output,
      messages,
      tokenUsage,
      durationMs,
      success,
      error,
    };
  }

  /**
   * Parse a single newline-delimited JSON line from the CLI stream.
   * Returns null if the line is not valid JSON.
   */
  parseStreamJSON(line: string): Record<string, unknown> | null {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  // ─── Private Helpers ─────────────────────────────────────────────────

  private extractAssistantText(msg: Record<string, unknown>): string {
    const message = msg['message'] as Record<string, unknown> | undefined;
    if (!message) return '';
    const content = message['content'];
    if (!Array.isArray(content)) return '';
    return content
      .filter((b) => (b as Record<string, unknown>)['type'] === 'text')
      .map((b) => (b as { type: 'text'; text: string }).text)
      .join('');
  }

  private extractUserText(msg: Record<string, unknown> | undefined): string {
    if (!msg) return '';
    const content = msg['content'];
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((b) => (b as Record<string, unknown>)['type'] === 'text')
        .map((b) => (b as { type: 'text'; text: string }).text)
        .join('');
    }
    return '';
  }
}
