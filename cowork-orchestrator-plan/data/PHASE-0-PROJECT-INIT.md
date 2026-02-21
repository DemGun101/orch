# Phase 0 — Project Initialization

> **Copy-paste this entire prompt into Claude Code to scaffold the project.**

---

```
I need you to initialize a new TypeScript project called "cowork-orchestrator". This is an AI agent orchestration platform that manages multi-agent workflows using Claude as the backbone LLM.

## Project Setup

1. Create the project folder `cowork-orchestrator` and initialize it:
   - `npm init -y` with name "cowork-orchestrator"
   - Initialize TypeScript with `tsconfig.json` (strict mode, ES2022 target, NodeNext module resolution)
   - Initialize git repo with a `.gitignore` for node_modules, dist, .env, logs, *.db

2. Install core dependencies:
   - `typescript`, `ts-node`, `@types/node` (dev)
   - `@anthropic-ai/sdk` (Claude API)
   - `zod` (schema validation)
   - `uuid` (ID generation)
   - `winston` (logging)
   - `better-sqlite3` and `@types/better-sqlite3` (local state persistence)
   - `eventemitter3` (typed events)
   - `dotenv` (env config)

3. Install dev/test dependencies:
   - `vitest` (testing)
   - `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`
   - `prettier`

4. Create this exact folder structure (empty files are fine, just set up the tree):

```
cowork-orchestrator/
├── src/
│   ├── index.ts                       # Main entry point / exports
│   ├── core/
│   │   ├── orchestrator.ts            # Main OrchestrationEngine class
│   │   ├── task-manager.ts            # TaskManager - lifecycle, queue, priorities
│   │   ├── agent-registry.ts          # AgentRegistry - register/discover/match agents
│   │   ├── workflow-engine.ts         # WorkflowEngine - DAG execution, parallel/sequential
│   │   ├── context-manager.ts         # ContextManager - shared memory, token budgets
│   │   └── types.ts                   # All core TypeScript interfaces & types
│   ├── agents/
│   │   ├── base-agent.ts              # Abstract BaseAgent class
│   │   ├── claude-agent.ts            # ClaudeAgent - wraps Anthropic SDK calls
│   │   ├── tool-agent.ts             # ToolAgent - agents that use MCP tools
│   │   └── human-in-the-loop.ts       # HumanInTheLoopAgent - approval gates
│   ├── communication/
│   │   ├── message-bus.ts             # MessageBus - pub/sub between agents
│   │   ├── protocols.ts              # Message schemas and protocol definitions
│   │   └── negotiation.ts            # Agent negotiation / delegation logic
│   ├── memory/
│   │   ├── shared-memory.ts           # SharedMemoryStore - cross-agent state
│   │   ├── conversation-history.ts    # ConversationHistory - per-agent history management
│   │   └── persistence.ts            # SQLite-backed persistence layer
│   ├── intelligence/
│   │   ├── task-decomposer.ts         # AI-powered task breakdown
│   │   ├── agent-selector.ts          # AI-powered agent matching
│   │   ├── conflict-resolver.ts       # Detect & resolve agent conflicts
│   │   └── quality-assessor.ts        # Output quality scoring
│   ├── tools/
│   │   ├── mcp-client.ts             # MCP protocol client
│   │   ├── tool-registry.ts          # Available tools registry
│   │   └── tool-executor.ts          # Safe tool execution with sandboxing
│   ├── resilience/
│   │   ├── error-handler.ts           # Centralized error handling & recovery
│   │   ├── retry-strategies.ts        # Exponential backoff, circuit breaker
│   │   ├── checkpointing.ts          # Workflow state checkpoints
│   │   └── rate-limiter.ts           # API rate limiting
│   ├── monitoring/
│   │   ├── metrics.ts                # Performance metrics collection
│   │   ├── dashboard.ts              # Simple CLI dashboard
│   │   └── audit-log.ts             # Audit trail for all actions
│   └── config/
│       ├── defaults.ts               # Default configuration values
│       └── schema.ts                 # Zod config validation schemas
├── tests/
│   ├── unit/
│   │   └── .gitkeep
│   ├── integration/
│   │   └── .gitkeep
│   └── fixtures/
│       └── .gitkeep
├── examples/
│   └── .gitkeep
├── .env.example                       # ANTHROPIC_API_KEY=your-key-here
├── tsconfig.json
├── vitest.config.ts
├── package.json
└── README.md
```

5. In `src/core/types.ts`, define all the foundational interfaces (leave implementations empty elsewhere). Here are the key types to define:

```typescript
// Task status lifecycle
type TaskStatus = 'pending' | 'queued' | 'assigned' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

// Task priority
type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

// Agent capability descriptor
interface AgentCapability {
  name: string;
  description: string;
  inputSchema: z.ZodSchema;
  outputSchema: z.ZodSchema;
  costEstimate?: 'low' | 'medium' | 'high';
}

// Task definition
interface Task {
  id: string;
  parentId?: string;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgentId?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  dependencies: string[];       // task IDs this depends on
  subtasks: string[];           // child task IDs
  metadata: TaskMetadata;
  createdAt: Date;
  updatedAt: Date;
  timeout?: number;             // ms
}

interface TaskMetadata {
  estimatedTokens?: number;
  actualTokens?: number;
  retryCount: number;
  maxRetries: number;
  checkpointId?: string;
}

// Agent definition
interface AgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  capabilities: AgentCapability[];
  maxConcurrentTasks: number;
  model: string;                // e.g. 'claude-sonnet-4-20250514'
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

// Workflow definition (DAG)
interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  status: TaskStatus;
  context: Record<string, unknown>;
}

interface WorkflowNode {
  id: string;
  taskTemplate: Omit<Task, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
  agentSelector?: AgentSelectorConfig;
}

interface WorkflowEdge {
  from: string;  // node ID
  to: string;    // node ID
  condition?: string;  // optional conditional expression
}

// Message types for inter-agent communication
interface AgentMessage {
  id: string;
  from: string;       // agent ID
  to: string | '*';   // agent ID or broadcast
  type: 'request' | 'response' | 'event' | 'delegation' | 'negotiation';
  channel: string;
  payload: unknown;
  timestamp: Date;
  correlationId?: string;
}

// Orchestration config
interface OrchestratorConfig {
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
}

// MCP Tool definition
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler?: string;  // reference to tool executor
}
```

6. Create a basic `vitest.config.ts`:
```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'json'] }
  }
});
```

7. Add these scripts to package.json:
   - `"build": "tsc"`
   - `"dev": "ts-node src/index.ts"`
   - `"test": "vitest run"`
   - `"test:watch": "vitest"`
   - `"lint": "eslint src/ --ext .ts"`

8. Create `.env.example` with: `ANTHROPIC_API_KEY=your-key-here`

9. Write a minimal README.md with project name, one-line description, and setup instructions.

10. Make an initial git commit: "chore: project scaffold and type definitions"

After you're done, run `npm install` and `npx tsc --noEmit` to verify everything compiles cleanly. Fix any issues.
```
