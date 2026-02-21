# Phase 3 — Integration Layer (MCP Tools, Monitoring, Dashboard)

> **Copy-paste this entire prompt into Claude Code. This adds tool execution, observability, and a working example.**

---

```
We are continuing the "cowork-orchestrator" project. Phases 1-2 (foundation + intelligence) are complete. Now implement the integration layer — MCP tool support, monitoring, and a working end-to-end example.

## 1. src/tools/tool-registry.ts — Tool Registry

Implement `ToolRegistry` class:
- `register(tool: ToolDefinition)` — register a tool with its schema
- `unregister(toolName: string)`
- `get(toolName: string): ToolDefinition | undefined`
- `getAll(): ToolDefinition[]`
- `search(query: string): ToolDefinition[]` — fuzzy search tools by name/description
- `validate(toolName: string, input: unknown): boolean` — validate input against tool's inputSchema
- `toClaudeTools(): Tool[]` — convert all registered tools to the format Claude API expects for tool_use
- Built-in tools to register by default:
  - `read_file` — reads a file path and returns contents
  - `write_file` — writes content to a file path
  - `list_directory` — lists files in a directory
  - `execute_command` — runs a shell command (with safety restrictions)
  - `web_search` — placeholder for web search
  - `memory_store` / `memory_retrieve` — interface to SharedMemoryStore

## 2. src/tools/tool-executor.ts — Safe Tool Execution

Implement `ToolExecutor` class:
- Constructor takes `ToolRegistry` and safety config
- `execute(toolName: string, input: unknown): Promise<ToolResult>`
  - Validates input against tool schema
  - Executes the tool handler
  - Wraps result in `ToolResult` type: `{ success: boolean, output: unknown, error?: string, duration: number }`
  - Timeout enforcement per tool (default 30s)
  - Error isolation: tool failures don't crash the orchestrator
- Safety sandbox config:
  - `allowedPaths: string[]` — restrict file access to specific directories
  - `blockedCommands: string[]` — commands that can never run (rm -rf, etc.)
  - `maxOutputSize: number` — truncate large outputs (default 100KB)
  - `requireApproval: string[]` — tool names that need human approval before execution
- `executeBatch(calls: ToolCall[]): Promise<ToolResult[]>` — execute multiple tools, independent ones in parallel
- Audit logging for every tool execution

## 3. src/tools/mcp-client.ts — MCP Protocol Client

Implement `MCPClient` class:
- This is a client that connects to MCP (Model Context Protocol) servers
- `connect(serverConfig: MCPServerConfig): Promise<void>` — connect to an MCP server
  - Support stdio-based transport (spawn a child process)
  - Send initialize request, negotiate capabilities
- `disconnect()`
- `listTools(): Promise<ToolDefinition[]>` — get available tools from the server
- `callTool(name: string, args: unknown): Promise<unknown>` — call a tool on the server
- `listResources(): Promise<Resource[]>` — list available resources
- `readResource(uri: string): Promise<ResourceContent>` — read a resource
- Auto-register discovered MCP tools into the ToolRegistry
- Handle MCP server lifecycle (start, health check, restart on crash)
- For now, implement the stdio JSON-RPC transport:
  - Spawn process, communicate via stdin/stdout
  - JSON-RPC 2.0 message format
  - Handle notifications and responses

## 4. Update src/agents/tool-agent.ts — Wire Real Tool Execution

Update `ToolAgent` to use the real `ToolExecutor`:
- Replace the stub tool execution with actual `ToolExecutor.execute()` calls
- Handle tool approval flow: if tool requires approval, delegate to HumanInTheLoopAgent
- Track tool usage metrics per agent
- Handle tool errors gracefully: send error result back to Claude, let it recover

## 5. src/monitoring/metrics.ts — Metrics Collection

Implement `MetricsCollector` class:
- Collects time-series metrics with labels
- `record(metric: string, value: number, labels?: Record<string, string>)`
- `increment(metric: string, labels?)`
- `startTimer(metric: string, labels?): () => void` — returns a stop function that records duration
- Built-in metrics to track:
  - `tasks.total`, `tasks.completed`, `tasks.failed`, `tasks.duration_ms`
  - `agents.active`, `agents.utilization`
  - `api.requests`, `api.tokens.input`, `api.tokens.output`, `api.latency_ms`, `api.errors`
  - `tools.executions`, `tools.errors`, `tools.duration_ms`
  - `workflow.executions`, `workflow.duration_ms`
  - `messages.sent`, `messages.failed`
- `getMetrics(): MetricsSummary` — returns current snapshot
- `getTimeSeries(metric: string, duration: number): DataPoint[]` — get recent data points
- Store in memory with configurable retention (default: last 1 hour of data points, 10s granularity)

## 6. src/monitoring/audit-log.ts — Audit Trail

Implement `AuditLogger` class:
- Uses PersistenceLayer to store audit entries
- `log(entry: AuditEntry)` — where AuditEntry is:
  ```
  { eventType, agentId?, taskId?, workflowId?, data: Record<string, unknown>, timestamp }
  ```
- Event types: `TASK_CREATED`, `TASK_ASSIGNED`, `TASK_COMPLETED`, `TASK_FAILED`, `AGENT_REGISTERED`, `TOOL_EXECUTED`, `WORKFLOW_STARTED`, `WORKFLOW_COMPLETED`, `CONFLICT_DETECTED`, `CONFLICT_RESOLVED`, `QUALITY_CHECK`, `HUMAN_APPROVAL`, `ERROR`, `CONFIG_CHANGED`
- `query(filter: AuditFilter): AuditEntry[]` — filter by event type, agent, task, time range
- `getTaskTimeline(taskId): AuditEntry[]` — full history of a task
- `getAgentActivity(agentId, timeRange): AuditEntry[]`
- `exportCSV(filter): string` — export audit log as CSV

## 7. src/monitoring/dashboard.ts — CLI Dashboard

Implement a simple CLI dashboard that displays system status:
- `Dashboard` class with `render(): string` method that returns a formatted string
- Shows:
  - System status (running/stopped, uptime)
  - Active agents (name, status, current load, tasks completed)
  - Task queue (pending count by priority, running count)
  - Recent completions (last 5, with duration and quality score)
  - Recent errors (last 5)
  - API usage (tokens used, requests made, rate limit remaining)
  - Workflow status (any active workflows and their progress)
- `startLive(interval?: number)` — refreshes and reprints every N seconds (default 2s) using `console.clear()` + `console.log()`
- `stopLive()`
- Use basic ASCII formatting (box drawing chars, colors via ANSI codes)

## 8. Wire Monitoring into Orchestrator

Update `OrchestrationEngine`:
- Initialize MetricsCollector, AuditLogger, Dashboard
- Instrument all operations with metrics recording
- Log audit entries at every significant state change
- Add `getDashboard(): string` — returns current dashboard render
- Add `startMonitoring()` / `stopMonitoring()` — starts/stops live dashboard

## 9. examples/research-workflow.ts — End-to-End Example

Create a working example that demonstrates the full system:
```
Research Workflow: Given a topic, produce a comprehensive research report

Agents:
1. Researcher — searches and gathers information (has web_search tool)
2. Analyst — analyzes and synthesizes findings
3. Writer — produces the final report (has write_file tool)
4. Reviewer — quality checks the output

Workflow:
[Research Topic] → [Gather Sources] → [Analyze Findings] → [Write Draft] → [Review] → [Final Report]
                                    ↗ [Analyze Findings 2] ↗  (parallel analysis)

The example should:
- Create an OrchestrationEngine
- Register 4 agents with appropriate system prompts and capabilities
- Define the workflow DAG
- Execute the workflow with a sample topic
- Print the dashboard at the end
- Handle the case where ANTHROPIC_API_KEY is not set (show helpful message)
```

## 10. examples/simple-task.ts — Simple Single-Task Example

A minimal example:
- Create engine with one ClaudeAgent
- Submit a single task: "Summarize the key benefits of TypeScript over JavaScript"
- Print result
- Show token usage

## 11. Integration Tests

Create `tests/integration/workflow.test.ts`:
- Test a complete workflow execution end-to-end using mock Anthropic client
- Verify task decomposition → agent assignment → execution → quality check flow
- Verify checkpoint/resume: start workflow, simulate crash after node 2, resume from checkpoint
- Verify conflict detection and resolution in parallel nodes

Create `tests/integration/tool-execution.test.ts`:
- Test tool registration and execution
- Test safety sandbox (blocked paths, blocked commands)
- Test approval flow with HumanInTheLoopAgent

After all files:
1. `npx tsc --noEmit` — must compile clean
2. `npm test` — all tests must pass
3. Fix any issues

Commit: "feat: implement integration layer — MCP tools, monitoring, dashboard, examples"
```
