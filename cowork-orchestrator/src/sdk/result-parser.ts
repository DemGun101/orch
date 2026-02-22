import type { SDKNodeResult } from '../core/types.js';

// ─── SDK Message types (from @anthropic-ai/claude-agent-sdk) ────────

interface SDKMessage {
  type: string;
  [key: string]: unknown;
}

interface SDKResultMessage extends SDKMessage {
  type: 'result';
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  session_id?: string;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

interface SDKAssistantMessage extends SDKMessage {
  type: 'assistant';
  content?: Array<{ type: string; text?: string }>;
}

// ─── Parse SDK async stream → SDKNodeResult ─────────────────────────

export async function parseSDKStream(
  nodeId: string,
  stream: AsyncIterable<SDKMessage>,
): Promise<SDKNodeResult> {
  const startTime = Date.now();
  const textChunks: string[] = [];
  const filesModified: string[] = [];
  let tokenUsage: { input: number; output: number } | undefined;
  let isError = false;
  let resultText: string | undefined;

  for await (const message of stream) {
    switch (message.type) {
      case 'assistant': {
        const msg = message as SDKAssistantMessage;
        if (msg.content) {
          for (const block of msg.content) {
            if (block.type === 'text' && block.text) {
              textChunks.push(block.text);
            }
          }
        }
        break;
      }

      case 'result': {
        const msg = message as SDKResultMessage;
        isError = msg.is_error ?? false;
        resultText = msg.result;
        if (msg.usage) {
          tokenUsage = {
            input: msg.usage.input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
          };
        }
        break;
      }

      case 'tool_progress': {
        // Track file modifications from Edit/Write tool calls
        const toolName = message.tool_name as string | undefined;
        const input = message.input as Record<string, unknown> | undefined;
        if (
          (toolName === 'Edit' || toolName === 'Write') &&
          input?.file_path &&
          typeof input.file_path === 'string'
        ) {
          if (!filesModified.includes(input.file_path)) {
            filesModified.push(input.file_path);
          }
        }
        break;
      }
    }
  }

  const output = resultText ?? textChunks.join('\n');
  const duration = Date.now() - startTime;

  return {
    nodeId,
    success: !isError,
    output,
    error: isError ? output : undefined,
    tokenUsage,
    duration,
    filesModified,
  };
}
