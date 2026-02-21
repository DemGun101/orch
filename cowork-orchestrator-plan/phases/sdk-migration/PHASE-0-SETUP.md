# Phase 0 — Setup: Install Agent SDK & Restructure Dependencies

> **Copy-paste this entire prompt into Claude Code.**

---

```
We are migrating the "cowork-orchestrator" project from Groq/OpenAI-compatible LLM API calls to the Claude Agent SDK. This will allow agents to ACTUALLY execute tasks (read/write files, run commands, browse the web) instead of just generating text responses.

The user is on a Claude Pro/Max subscription — there is NO Anthropic API key. The Agent SDK will use the logged-in Claude Code session directly.

## IMPORTANT CONTEXT

The project currently uses:
- `openai` npm package to call Groq's OpenAI-compatible API
- Groq API key in .env (GROQ_API_KEY)
- Model: llama-3.3-70b-versatile via Groq

We are KEEPING the `openai` package for now (the intelligence layer still needs lightweight LLM calls for planning/decomposition — we'll handle that in Phase 3). But the EXECUTION layer (agents doing real work) will use the Claude Agent SDK.

## 1. Install the Claude Agent SDK

Run:
```bash
npm install @anthropic-ai/claude-agent-sdk
```

Verify it installed correctly:
```bash
node -e "const sdk = require('@anthropic-ai/claude-agent-sdk'); console.log('SDK loaded:', Object.keys(sdk))"
```

If the above fails, try:
```bash
node -e "import('@anthropic-ai/claude-agent-sdk').then(sdk => console.log('SDK loaded:', Object.keys(sdk)))"
```

Document which exports are available (query, ClaudeAgentOptions, etc.) — we need to know the exact API surface.

## 2. Update .env and .env.example

Update `.env.example` to:
```
# ─── Intelligence Layer (lightweight planning LLM) ──────────────────
# Used for task decomposition, agent selection, quality assessment.
# These are cheap/fast calls that don't need tool access.
# Options: Groq (free), Gemini (free), or any OpenAI-compatible API.
GROQ_API_KEY=your-groq-key-here
# GEMINI_API_KEY=your-gemini-key-here
# LLM_API_KEY=your-key
# LLM_BASE_URL=https://api.example.com/v1
# LLM_MODEL=llama-3.3-70b-versatile

# ─── Execution Layer (Claude Agent SDK) ─────────────────────────────
# Uses your Claude Pro/Max subscription via logged-in Claude Code session.
# No API key needed — authentication is handled by your Claude Code login.
# Model routing is configured in src/execution/model-router.ts
```

Keep the existing `.env` as-is (it has the GROQ_API_KEY which we still need for the intelligence layer).

## 3. Update src/core/types.ts — Add Execution Types

Add the following NEW types at the end of `src/core/types.ts` (do NOT modify existing types):

```typescript
// ─── Execution Layer Types ──────────────────────────────────────────

/** Model tier for cost-optimized routing */
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

/** Execution mode for agents */
export type ExecutionMode = 'sdk' | 'cli' | 'llm-only';

/** Result from Agent SDK execution */
export interface SDKExecutionResult {
  sessionId: string;
  messages: SDKMessage[];
  result: string;
  toolsUsed: string[];
  filesModified: string[];
  duration: number;
  modelUsed: string;
  turnCount: number;
}

/** A message from the Agent SDK stream */
export interface SDKMessage {
  type: 'text' | 'tool_use' | 'tool_result' | 'error' | 'system';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/** Configuration for model routing */
export interface ModelRoutingConfig {
  /** Default model for general tasks */
  defaultModel: ModelTier;
  /** Model for planning/decomposition (intelligence layer) */
  planningModel: ModelTier;
  /** Model overrides by task priority */
  priorityOverrides: Record<TaskPriority, ModelTier>;
  /** Model overrides by complexity rating */
  complexityOverrides: Record<string, ModelTier>;
  /** Maximum turns per SDK session */
  maxTurnsDefault: number;
  /** Maximum turns by priority */
  maxTurnsByPriority: Record<TaskPriority, number>;
}

/** Agent execution configuration — extends AgentConfig */
export interface ExecutionAgentConfig extends AgentConfig {
  /** Which execution mode this agent uses */
  executionMode: ExecutionMode;
  /** Override model tier for this specific agent */
  modelTier?: ModelTier;
  /** Which tools the Agent SDK session is allowed to use */
  allowedTools?: string[];
  /** Custom working directory for this agent's SDK sessions */
  workingDirectory?: string;
  /** Maximum turns for this agent's SDK sessions */
  maxTurns?: number;
}
```

Also update `OrchestratorConfig` to add the new field (add it as optional so existing code doesn't break):

```typescript
export interface OrchestratorConfig {
  maxConcurrentAgents: number;
  maxConcurrentTasks: number;
  defaultTimeout: number;
  checkpointInterval: number;
  rateLimits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  persistence: {
    enabled: boolean;
    dbPath: string;
  };
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  /** NEW: Model routing configuration for Agent SDK execution */
  modelRouting?: Partial<ModelRoutingConfig>;
}
```

## 4. Create src/execution/ directory structure

Create these new files (empty stubs for now — we'll implement them in subsequent phases):

```
src/execution/
├── sdk-executor.ts          # Core Agent SDK wrapper
├── cli-executor.ts          # Fallback: claude -p CLI wrapper
├── model-router.ts          # Intelligent model selection
├── result-parser.ts         # Parse SDK stream into structured results
└── session-manager.ts       # Track active SDK sessions
```

Create each file with this minimal stub content:

### src/execution/sdk-executor.ts
```typescript
// Agent SDK executor — spawns real Claude sessions for task execution
// Implemented in Phase 1

export class SDKExecutor {
  // TODO: Phase 1
}
```

### src/execution/cli-executor.ts
```typescript
// CLI executor fallback — uses `claude -p` for environments without SDK
// Implemented in Phase 1

export class CLIExecutor {
  // TODO: Phase 1
}
```

### src/execution/model-router.ts
```typescript
// Intelligent model routing based on task complexity and priority
// Implemented in Phase 2

export class ModelRouter {
  // TODO: Phase 2
}
```

### src/execution/result-parser.ts
```typescript
// Parse Agent SDK streaming output into structured TaskResult
// Implemented in Phase 1

export class ResultParser {
  // TODO: Phase 1
}
```

### src/execution/session-manager.ts
```typescript
// Track active Agent SDK sessions, handle cleanup
// Implemented in Phase 1

export class SessionManager {
  // TODO: Phase 1
}
```

## 5. Update src/index.ts — Add new exports

Add these exports at the end of `src/index.ts`:

```typescript
// ─── Execution Layer ────────────────────────────────────────────────
export { SDKExecutor } from './execution/sdk-executor.js';
export { CLIExecutor } from './execution/cli-executor.js';
export { ModelRouter } from './execution/model-router.js';
export { ResultParser } from './execution/result-parser.js';
export { SessionManager } from './execution/session-manager.js';
export type {
  ModelTier,
  ExecutionMode,
  SDKExecutionResult,
  SDKMessage,
  ModelRoutingConfig,
  ExecutionAgentConfig,
} from './core/types.js';
```

## 6. Verify

1. Run `npx tsc --noEmit` — must compile with ZERO errors
2. Run `npm test` — all existing tests must still pass (we haven't changed any behavior yet)
3. Verify the Agent SDK is importable:
```bash
npx tsx -e "import('@anthropic-ai/claude-agent-sdk').then(m => console.log('Exports:', Object.keys(m))).catch(e => console.log('Import failed:', e.message))"
```

4. If the SDK import fails, investigate and document the error. It may need:
   - A specific Node.js version
   - The `claude` CLI to be installed and logged in
   - Different import syntax

   If the SDK cannot be installed or imported, document the exact error and we'll use the CLI fallback (claude -p) approach in Phase 1 instead.

Fix any compilation errors before proceeding.

Commit: "chore: install Agent SDK, add execution layer types and directory structure"
```
