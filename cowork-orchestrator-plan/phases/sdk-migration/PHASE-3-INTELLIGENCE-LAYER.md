# Phase 3 — Intelligence Layer: Lightweight LLM for Planning

> **Copy-paste this entire prompt into Claude Code. Phases 0-2 must be completed first.**

---

```
We are continuing the "cowork-orchestrator" Agent SDK migration. Phases 0-2 are complete. Now we need to handle the intelligence layer — the parts of the system that do PLANNING (task decomposition, agent selection, quality assessment, conflict resolution).

## THE PROBLEM

The intelligence layer (src/intelligence/*.ts) currently uses the OpenAI SDK to call Groq/Gemini for lightweight planning LLM calls. These are NOT task execution calls — they're quick classification and structured output calls like:
- "Rate the complexity of this task: trivial/simple/moderate/complex/epic"
- "Break this task into subtasks"
- "Select the best agent for this task"
- "Assess the quality of this output"

These calls do NOT need tool access. They just need a fast, cheap LLM that can return structured JSON. The current Groq setup actually works fine for this.

## THE DECISION: DUAL-TRACK ARCHITECTURE

We keep TWO LLM backends:

1. **Intelligence Layer** → Groq/Gemini via OpenAI SDK (existing `src/llm/client.ts`)
   - For: TaskDecomposer, AgentSelector, QualityAssessor, ConflictResolver
   - Cheap, fast, no tool access needed
   - Uses GROQ_API_KEY or GEMINI_API_KEY from .env

2. **Execution Layer** → Claude Agent SDK or `claude -p` CLI (new `src/execution/`)
   - For: Actually doing tasks (reading files, writing code, running commands)
   - Uses Claude Pro/Max subscription
   - Model routing via ModelRouter

This is the optimal cost structure: planning calls use the FREE Groq tier, execution calls use the subscription.

## HOWEVER: If the user doesn't have Groq/Gemini keys

We need a fallback for the intelligence layer too. If no GROQ_API_KEY or GEMINI_API_KEY is set, the intelligence layer should fall back to using `claude -p` with the haiku model for its planning calls. This is more expensive than Groq but still cheap since haiku is the lightest model.

## 1. Create src/intelligence/planning-client.ts — Unified Planning LLM Client

Create a new file that abstracts the intelligence layer's LLM needs:

```typescript
import type OpenAI from 'openai';
import type { ChatMessage, ChatTool } from '../llm/client.js';
import { createLLMClient, getDefaultModel } from '../llm/client.js';
import { spawn } from 'child_process';

/**
 * PlanningClient provides a unified interface for lightweight LLM calls
 * used by the intelligence layer (task decomposition, agent selection, etc.).
 *
 * Strategy:
 * 1. If GROQ_API_KEY or GEMINI_API_KEY is set → use OpenAI-compatible API (free/cheap)
 * 2. If neither is set → use `claude -p --model haiku` CLI as fallback
 */
export class PlanningClient {
  private openaiClient: OpenAI | null = null;
  private openaiModel: string = '';
  private mode: 'openai' | 'claude-cli' = 'claude-cli';

  constructor() {
    this.detectMode();
  }

  private detectMode(): void {
    // Check if any LLM API key is available
    if (process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.LLM_API_KEY) {
      try {
        this.openaiClient = createLLMClient();
        this.openaiModel = getDefaultModel();
        this.mode = 'openai';
        console.log(`[PlanningClient] Using OpenAI-compatible API (${this.openaiModel})`);
      } catch {
        this.mode = 'claude-cli';
      }
    } else {
      this.mode = 'claude-cli';
      console.log('[PlanningClient] No LLM API key found, using claude -p haiku for planning');
    }
  }

  getMode(): string {
    return this.mode;
  }

  /**
   * Make a chat completion call for planning purposes.
   * Returns the same shape as OpenAI's ChatCompletion for compatibility.
   */
  async chatCompletion(params: {
    messages: ChatMessage[];
    tools?: ChatTool[];
    tool_choice?: unknown;
    max_tokens?: number;
    temperature?: number;
  }): Promise<OpenAI.ChatCompletion> {
    if (this.mode === 'openai' && this.openaiClient) {
      return this.openaiClient.chat.completions.create({
        model: this.openaiModel,
        max_tokens: params.max_tokens ?? 4096,
        messages: params.messages,
        ...(params.tools && params.tools.length > 0 ? { tools: params.tools } : {}),
        ...(params.tool_choice ? { tool_choice: params.tool_choice } : {}),
        ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      }) as Promise<OpenAI.ChatCompletion>;
    }

    // Fallback: use claude -p with haiku model
    return this.claudeCLICompletion(params);
  }

  /**
   * Simple text completion (no tools, no structured output).
   * Used for things like complexity estimation.
   */
  async simpleCompletion(prompt: string, maxTokens?: number): Promise<string> {
    if (this.mode === 'openai' && this.openaiClient) {
      const response = await this.openaiClient.chat.completions.create({
        model: this.openaiModel,
        max_tokens: maxTokens ?? 100,
        messages: [{ role: 'user', content: prompt }],
      }) as OpenAI.ChatCompletion;
      return response.choices[0]?.message?.content ?? '';
    }

    // Fallback: claude -p
    return this.claudeCLISimple(prompt);
  }

  // ─── Claude CLI Fallback Methods ──────────────────────────────────

  private async claudeCLICompletion(params: {
    messages: ChatMessage[];
    tools?: ChatTool[];
    tool_choice?: unknown;
    max_tokens?: number;
  }): Promise<OpenAI.ChatCompletion> {
    // For structured output with tools, we use --json-schema approach
    // Build a prompt from the messages
    const prompt = this.messagesToPrompt(params.messages);

    // If tools are provided and tool_choice forces a specific function,
    // we can use --json-schema to get structured output matching the tool's parameters
    if (params.tools && params.tools.length > 0 && params.tool_choice) {
      const toolChoice = params.tool_choice as { type: string; function?: { name: string } };
      const targetTool = params.tools.find(t =>
        t.type === 'function' && t.function.name === toolChoice.function?.name
      );

      if (targetTool && targetTool.type === 'function') {
        const schema = JSON.stringify(targetTool.function.parameters);
        const result = await this.runClaude(
          prompt + `\n\nRespond with JSON matching this schema. Only output valid JSON, no other text:\n${schema}`,
          ['--model', 'haiku', '--max-turns', '1']
        );

        // Try to parse as JSON and wrap in OpenAI ChatCompletion format
        try {
          // Extract JSON from the result (it might have markdown code fences)
          const jsonStr = this.extractJSON(result);

          return {
            id: `cli-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: 'haiku',
            choices: [{
              index: 0,
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: `call-${Date.now()}`,
                  type: 'function',
                  function: {
                    name: targetTool.function.name,
                    arguments: jsonStr,
                  },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          } as unknown as OpenAI.ChatCompletion;
        } catch {
          // If JSON parsing fails, return as plain text
          return this.wrapAsCompletion(result);
        }
      }
    }

    // No tools — just get a text response
    const result = await this.runClaude(prompt, ['--model', 'haiku', '--max-turns', '1']);
    return this.wrapAsCompletion(result);
  }

  private async claudeCLISimple(prompt: string): Promise<string> {
    return this.runClaude(prompt, ['--model', 'haiku', '--max-turns', '1']);
  }

  private messagesToPrompt(messages: ChatMessage[]): string {
    const parts: string[] = [];
    for (const msg of messages) {
      if (typeof msg === 'object' && msg !== null && 'role' in msg && 'content' in msg) {
        const role = (msg as { role: string }).role;
        const content = (msg as { content: string | null }).content;
        if (content) {
          if (role === 'system') {
            parts.push(`[System Instructions]\n${content}\n`);
          } else if (role === 'user') {
            parts.push(content);
          }
        }
      }
    }
    return parts.join('\n\n');
  }

  private extractJSON(text: string): string {
    // Try to extract JSON from potential markdown code fences
    const codeBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    // Try to find raw JSON object
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return jsonMatch[0];
    }
    return text.trim();
  }

  private wrapAsCompletion(text: string): OpenAI.ChatCompletion {
    return {
      id: `cli-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'haiku',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    } as unknown as OpenAI.ChatCompletion;
  }

  private runClaude(prompt: string, extraArgs: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['-p', ...extraArgs, '--no-session-persistence', prompt];
      const proc = spawn('claude', args, {
        timeout: 60_000,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Claude CLI failed (code ${code}): ${stderr}`));
        }
      });

      proc.on('error', reject);
    });
  }
}
```

## 2. Update Intelligence Layer to Use PlanningClient

The intelligence layer files currently import `OpenAI` and use `this.client.chat.completions.create()`. We need to give them the OPTION to use PlanningClient instead, while keeping backward compatibility.

### Update src/intelligence/task-decomposer.ts

Add a constructor overload that accepts PlanningClient:

At the top of the file, add the import:
```typescript
import { PlanningClient } from './planning-client.js';
```

Add a new private field and update the constructor:
```typescript
private planningClient?: PlanningClient;

constructor(clientOrPlanning: OpenAI | PlanningClient, config?: TaskDecomposerConfig) {
  if (clientOrPlanning instanceof PlanningClient) {
    this.planningClient = clientOrPlanning;
    this.client = null as unknown as OpenAI; // Won't be used
  } else {
    this.client = clientOrPlanning;
  }
  this.model = config?.model ?? getDefaultModel();
  this.maxSubtasks = config?.maxSubtasks ?? 10;
}
```

Then update every `this.client.chat.completions.create(...)` call to first check if planningClient is available:

```typescript
// Replace:
const response = await this.client.chat.completions.create({...}) as OpenAI.ChatCompletion;

// With:
const response = this.planningClient
  ? await this.planningClient.chatCompletion({...})
  : await this.client.chat.completions.create({...}) as OpenAI.ChatCompletion;
```

Do the same pattern for `estimateComplexity()` — if planningClient is available, use `this.planningClient.simpleCompletion()` instead.

### Update src/intelligence/agent-selector.ts

Same pattern: add PlanningClient support alongside the existing OpenAI client.

### Update src/intelligence/quality-assessor.ts

Same pattern.

### Update src/intelligence/conflict-resolver.ts

Same pattern.

## 3. Update src/index.ts

Add export:
```typescript
export { PlanningClient } from './intelligence/planning-client.js';
```

## 4. Verify

1. `npx tsc --noEmit` — must compile with ZERO errors
2. `npm test` — all existing tests must still pass
3. Run a quick smoke test:
```bash
npx tsx -e "
import { PlanningClient } from './src/intelligence/planning-client.js';
const client = new PlanningClient();
console.log('Mode:', client.getMode());
"
```

Fix any compilation or test errors.

Commit: "feat: add PlanningClient with Groq/claude-cli dual-track for intelligence layer"
```
