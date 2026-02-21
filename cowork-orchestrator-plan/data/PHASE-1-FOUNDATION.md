# Phase 1 — Core Foundation (Task Management, Agent Registry, Message Bus)

> **Copy-paste this entire prompt into Claude Code. This builds the runtime backbone.**

---

```
We are building the "cowork-orchestrator" project. The scaffold and types are already in place. Now implement the core foundation layer. Work through each file below in order. After each file, run `npx tsc --noEmit` to verify it compiles.

## 1. src/config/schema.ts — Configuration Validation

Implement Zod schemas that validate `OrchestratorConfig`. Include sensible defaults. Export a `validateConfig(input: unknown): OrchestratorConfig` function and a `DEFAULT_CONFIG` constant with these defaults:
- maxConcurrentAgents: 10
- maxConcurrentTasks: 50
- defaultTimeout: 300000 (5 min)
- checkpointInterval: 30000 (30s)
- rateLimits: { requestsPerMinute: 60, tokensPerMinute: 100000 }
- persistence: { enabled: true, dbPath: './data/orchestrator.db' }

## 2. src/config/defaults.ts — Re-export defaults

Simple re-export of DEFAULT_CONFIG and the validate function from schema.ts.

## 3. src/memory/persistence.ts — SQLite Persistence Layer

Implement a `PersistenceLayer` class using better-sqlite3:
- Constructor takes a db file path, creates the file/dir if needed
- `initialize()` creates these tables if not exist:
  - `tasks` (id TEXT PK, data JSON, status TEXT, created_at, updated_at)
  - `agents` (id TEXT PK, config JSON, status TEXT)
  - `messages` (id TEXT PK, data JSON, timestamp)
  - `checkpoints` (id TEXT PK, workflow_id TEXT, state JSON, created_at)
  - `audit_log` (id INTEGER PK AUTOINCREMENT, event_type TEXT, agent_id TEXT, task_id TEXT, data JSON, timestamp)
- CRUD methods for each table: `saveTask`, `getTask`, `updateTask`, `listTasks(filter?)`, etc.
- `saveCheckpoint(workflowId, state)` and `getLatestCheckpoint(workflowId)`
- `appendAuditLog(entry)` and `queryAuditLog(filter)`
- `close()` to cleanly close the DB
- All methods are synchronous (better-sqlite3 is sync) but wrap in try/catch with proper error types

## 4. src/memory/shared-memory.ts — SharedMemoryStore

Implement a `SharedMemoryStore` class:
- In-memory Map<string, unknown> for fast access, backed by persistence layer for durability
- `set(namespace: string, key: string, value: unknown)` — stores with composite key `${namespace}:${key}`
- `get<T>(namespace: string, key: string): T | undefined`
- `delete(namespace: string, key: string)`
- `getNamespace(namespace: string): Record<string, unknown>` — returns all keys in a namespace
- `subscribe(pattern: string, callback)` — watch for changes matching a glob pattern
- Thread-safe design using a simple lock mechanism (queue-based since JS is single-threaded but we want async safety)
- Emit events on changes via eventemitter3

## 5. src/memory/conversation-history.ts — ConversationHistory

Implement `ConversationHistory` class:
- Stores per-agent conversation histories as arrays of `{role, content, timestamp}`
- `addMessage(agentId, role, content)`
- `getHistory(agentId, limit?): Message[]`
- `getTokenCount(agentId): number` — estimate tokens (rough: chars/4)
- `trimToTokenBudget(agentId, maxTokens)` — removes oldest messages to fit budget, but always preserves the system message
- `summarize(agentId)` — returns a compact summary placeholder (will be AI-powered in Phase 2)
- `clear(agentId)`
- Backed by persistence for recovery

## 6. src/communication/protocols.ts — Message Protocols

Define message schema validation and factory functions:
- `createMessage(from, to, type, channel, payload): AgentMessage` — creates with UUID and timestamp
- `createRequest(from, to, channel, payload)` — shorthand
- `createResponse(originalMessage, payload)` — auto-sets correlationId
- `createBroadcast(from, channel, payload)` — sets to='*'
- `createDelegation(from, to, task, reason)` — delegation message
- `validateMessage(msg): boolean` — Zod validation
- Define channel constants: `CHANNELS = { TASK: 'task', STATUS: 'status', NEGOTIATION: 'negotiation', SYSTEM: 'system', DATA: 'data' }`

## 7. src/communication/message-bus.ts — MessageBus

Implement `MessageBus` class using eventemitter3:
- `subscribe(agentId, channel, handler: (msg: AgentMessage) => void)` — agent subscribes to a channel
- `unsubscribe(agentId, channel)`
- `publish(message: AgentMessage)` — delivers to correct subscribers. If `to='*'`, deliver to all subscribers on that channel. If specific `to`, deliver only to that agent.
- `request(message: AgentMessage, timeout?: number): Promise<AgentMessage>` — publish and wait for a correlated response
- Message history: store last N messages per channel (configurable, default 100)
- Dead letter queue: messages that fail delivery go here
- Metrics: track message counts, avg delivery time
- `getMetrics()` returns bus stats
- Persist messages via PersistenceLayer for audit

## 8. src/communication/negotiation.ts — Agent Negotiation

Implement `NegotiationManager` class:
- `requestDelegation(fromAgentId, toAgentId, task, reason): Promise<boolean>` — sends delegation request, waits for acceptance
- `proposeTaskSplit(agentId, task, proposedSplit: Task[]): Promise<Task[]>` — agent proposes breaking a task down, other agents can bid
- `resolveContention(taskId, candidateAgentIds: string[]): Promise<string>` — when multiple agents could handle a task, pick the best one (for now, simple scoring; AI-powered in Phase 2)
- Uses MessageBus internally for all communication

## 9. src/agents/base-agent.ts — Abstract BaseAgent

Implement abstract `BaseAgent` class:
- Constructor takes `AgentConfig`
- Properties: `id`, `name`, `role`, `status` ('idle' | 'busy' | 'error' | 'offline'), `currentTasks: Map<string, Task>`
- Abstract method: `execute(task: Task): Promise<TaskResult>`
- Concrete methods:
  - `canHandle(task: Task): boolean` — checks capabilities against task requirements
  - `getLoad(): number` — returns currentTasks.size / maxConcurrentTasks (0-1)
  - `assignTask(task)` / `completeTask(taskId, result)` / `failTask(taskId, error)`
  - `onMessage(msg: AgentMessage)` — default message handler (can be overridden)
  - `getStats()` — returns agent performance stats (tasks completed, avg time, error rate)
- Integrates with MessageBus: auto-subscribes to relevant channels on init
- Integrates with ConversationHistory: maintains its own history

## 10. src/agents/claude-agent.ts — ClaudeAgent

Implement `ClaudeAgent` extends `BaseAgent`:
- Constructor additionally takes an Anthropic client instance
- `execute(task)` implementation:
  - Builds messages array from conversation history + task context
  - Calls `anthropic.messages.create()` with the agent's model, system prompt, temperature, maxTokens
  - Handles tool_use responses by calling tool executor (stub for now — just return tool name + inputs)
  - Handles streaming for long responses (use `stream()`)
  - Returns structured `TaskResult` with output, token usage, duration
  - Implements retry on transient errors (429, 500, 529)
- `chat(userMessage: string): Promise<string>` — simple single-turn convenience method
- Token tracking: count input/output tokens from API responses
- Properly manages conversation history window (trim when approaching model context limit)

## 11. src/agents/tool-agent.ts — ToolAgent

Implement `ToolAgent` extends `ClaudeAgent`:
- Has a list of `ToolDefinition[]` available tools
- Overrides `execute()` to include tools in the API call
- Implements a tool execution loop:
  1. Send message to Claude with tools
  2. If response has `tool_use` blocks, execute each tool (via placeholder executor)
  3. Send tool results back to Claude
  4. Repeat until Claude returns a final `text` response or max iterations (10)
- `registerTool(tool: ToolDefinition)` / `removeTool(toolName: string)`

## 12. src/agents/human-in-the-loop.ts — HumanInTheLoopAgent

Implement `HumanInTheLoopAgent` extends `BaseAgent`:
- Used as an approval gate in workflows
- `execute(task)`:
  - Emits an event `approval-needed` with task details
  - Waits for `approve(taskId)` or `reject(taskId, reason)` to be called
  - Has a configurable timeout (default 5 minutes), auto-rejects on timeout
- `approve(taskId: string): void`
- `reject(taskId: string, reason: string): void`
- `getPendingApprovals(): Task[]`

## 13. src/core/agent-registry.ts — AgentRegistry

Implement `AgentRegistry` class:
- `register(agent: BaseAgent)` — adds agent to registry, persists config
- `unregister(agentId: string)`
- `get(agentId: string): BaseAgent | undefined`
- `findByCapability(capabilityName: string): BaseAgent[]` — find agents that have a specific capability
- `findBestMatch(task: Task): BaseAgent | undefined` — score agents by: capability match, current load, error rate, and pick the best
- `getAll(): BaseAgent[]`
- `getAvailable(): BaseAgent[]` — agents that aren't at max capacity
- `getMetrics()` — registry-wide stats

## 14. src/core/task-manager.ts — TaskManager

Implement `TaskManager` class:
- Priority queue for pending tasks (use a sorted array or simple heap)
- `createTask(input: Partial<Task>): Task` — creates with UUID, defaults, validation
- `submitTask(task: Task)` — adds to queue
- `getNextTask(): Task | undefined` — pops highest priority task that has all dependencies satisfied
- `updateStatus(taskId, status, output?)` — with audit logging
- `getTask(taskId): Task`
- `getSubtasks(parentId): Task[]`
- `decompose(taskId, subtasks: Partial<Task>[])` — splits a task into subtasks, links parentId
- `cancelTask(taskId)` — cascading cancel of subtasks too
- `getTaskTree(taskId)` — returns task with nested subtask tree
- `onTaskComplete(taskId)` — checks if parent task is now completable (all subtasks done)
- Dependency resolution: a task can only run when all its `dependencies` are in 'completed' status
- Events: emit `task:created`, `task:assigned`, `task:completed`, `task:failed`
- Backed by persistence

## 15. src/core/workflow-engine.ts — WorkflowEngine

Implement `WorkflowEngine` class:
- Takes a `Workflow` definition (DAG of nodes + edges)
- `execute(workflow: Workflow): Promise<WorkflowResult>`
  - Validates the DAG (no cycles — use DFS)
  - Determines execution order via topological sort
  - Runs nodes in parallel where the DAG allows it (nodes with no dependencies between them)
  - Passes output from completed nodes to dependent nodes via context
  - Handles conditional edges (evaluate condition against current context)
- `pause(workflowId)` / `resume(workflowId)` — pause/resume execution
- `getStatus(workflowId)` — current execution state
- `cancel(workflowId)` — cancel with cleanup
- Checkpointing: after each node completes, save checkpoint so we can resume from failures
- Uses TaskManager to create and track individual node tasks
- Uses AgentRegistry to assign agents to nodes

## 16. src/core/orchestrator.ts — Main OrchestrationEngine

Implement the top-level `OrchestrationEngine` class that wires everything together:
- Constructor takes `OrchestratorConfig` (or uses defaults)
- Initializes all subsystems: TaskManager, AgentRegistry, WorkflowEngine, MessageBus, SharedMemory, Persistence, ConversationHistory
- `start()` — initializes persistence, starts the main loop
- `stop()` — graceful shutdown (wait for running tasks, checkpoint, close DB)
- `registerAgent(config: AgentConfig): BaseAgent` — creates and registers an agent
- `submitTask(input)` — creates task, finds agent, assigns, monitors
- `executeWorkflow(workflow: Workflow)` — delegates to WorkflowEngine
- Main loop (runs on interval):
  1. Check for queued tasks that can be assigned
  2. Match tasks to available agents
  3. Monitor running tasks for timeouts
  4. Process completed tasks (notify dependents)
  5. Handle failed tasks (retry or escalate)
- `getStatus()` — full system status
- `getMetrics()` — aggregated metrics

## 17. src/index.ts — Public Exports

Export everything needed for external use:
```typescript
export { OrchestrationEngine } from './core/orchestrator';
export { TaskManager } from './core/task-manager';
export { AgentRegistry } from './core/agent-registry';
export { WorkflowEngine } from './core/workflow-engine';
export { ClaudeAgent } from './agents/claude-agent';
export { ToolAgent } from './agents/tool-agent';
export { HumanInTheLoopAgent } from './agents/human-in-the-loop';
export { MessageBus } from './communication/message-bus';
export { SharedMemoryStore } from './memory/shared-memory';
export * from './core/types';
```

## 18. Tests — Write unit tests for the foundation

Create these test files:
- `tests/unit/task-manager.test.ts` — test task CRUD, priority ordering, dependency resolution, decomposition, cancellation
- `tests/unit/agent-registry.test.ts` — test registration, capability matching, load balancing
- `tests/unit/message-bus.test.ts` — test pub/sub, request/response, broadcast, dead letters
- `tests/unit/workflow-engine.test.ts` — test DAG validation, topological sort, parallel execution, conditional edges, checkpointing
- `tests/unit/shared-memory.test.ts` — test CRUD, namespaces, subscriptions
- `tests/unit/persistence.test.ts` — test all DB operations, use in-memory SQLite for tests

Use vitest. Create mock agents for testing (simple classes extending BaseAgent with hardcoded execute).

After all files, run:
1. `npx tsc --noEmit` — must compile clean
2. `npm test` — all tests must pass
3. Fix any issues

Then commit: "feat: implement core foundation — task manager, agent registry, message bus, workflow engine"
```
