# Cowork Orchestrator — Build Plan

## How To Use

Open Claude Code, then copy-paste each numbered prompt file **in order** from the `phases/` folder. Wait for each to compile and pass tests before moving to the next.

---

## Phase 0 — Project Init (3 prompts)

| # | File | What It Does |
|---|------|-------------|
| 0.1 | `0.1-init-and-deps.md` | npm init, install all dependencies, tsconfig, vitest |
| 0.2 | `0.2-folder-structure.md` | Create the full src/ folder tree (empty files) |
| 0.3 | `0.3-types-and-commit.md` | Define all TypeScript interfaces in types.ts, initial commit |

## Phase 1 — Core Foundation (6 prompts)

| # | File | What It Does |
|---|------|-------------|
| 1.1 | `1.1-config-and-persistence.md` | Zod config validation, SQLite persistence layer |
| 1.2 | `1.2-memory-and-comms.md` | SharedMemory, ConversationHistory, MessageBus, Negotiation |
| 1.3 | `1.3-agents.md` | BaseAgent, ClaudeAgent, ToolAgent, HumanInTheLoopAgent |
| 1.4 | `1.4-core-managers.md` | AgentRegistry, TaskManager with priority queue |
| 1.5 | `1.5-workflow-and-orchestrator.md` | WorkflowEngine (DAG), OrchestrationEngine, exports |
| 1.6 | `1.6-foundation-tests.md` | Unit tests for all foundation modules |

## Phase 2 — Intelligence Layer (4 prompts)

| # | File | What It Does |
|---|------|-------------|
| 2.1 | `2.1-task-decomposer.md` | AI-powered task breakdown using Claude |
| 2.2 | `2.2-agent-selector-and-conflict-resolver.md` | AI agent matching + conflict detection/resolution |
| 2.3 | `2.3-quality-and-orchestrator-update.md` | AI quality scoring + wire intelligence into orchestrator |
| 2.4 | `2.4-intelligence-tests.md` | Mock Anthropic client + intelligence layer tests |

## Phase 3 — Integration Layer (5 prompts)

| # | File | What It Does |
|---|------|-------------|
| 3.1 | `3.1-tool-registry-and-executor.md` | Tool registry with built-ins + safe sandbox executor |
| 3.2 | `3.2-mcp-client.md` | MCP protocol client (stdio JSON-RPC) + wire into ToolAgent |
| 3.3 | `3.3-monitoring.md` | MetricsCollector, AuditLogger, CLI Dashboard |
| 3.4 | `3.4-examples.md` | Wire monitoring + create simple-task and research-workflow examples |
| 3.5 | `3.5-integration-tests.md` | End-to-end workflow + tool execution integration tests |

## Phase 4 — Resilience & Polish (4 prompts)

| # | File | What It Does |
|---|------|-------------|
| 4.1 | `4.1-retry-and-circuit-breaker.md` | ExponentialBackoff, CircuitBreaker, withRetry utility |
| 4.2 | `4.2-rate-limiter-and-checkpointing.md` | Token bucket rate limiter, checkpoint manager |
| 4.3 | `4.3-error-handler-and-wiring.md` | Error hierarchy, ErrorHandler, wire resilience into all modules |
| 4.4 | `4.4-resilience-tests-and-polish.md` | Resilience tests, full test suite, README, final commit |

---

## Total: 22 prompts across 4 phases

## Architecture

```
┌─────────────────────────────────────────────┐
│              OrchestrationEngine            │
├─────────────┬─────────────┬─────────────────┤
│  Intelligence│  Integration │   Resilience   │
│  - Decomposer│  - MCP Client│   - Retry      │
│  - Selector  │  - Tools     │   - CircuitBrkr│
│  - Conflicts │  - Monitoring│   - RateLimit  │
│  - Quality   │  - Dashboard │   - Checkpoint │
├─────────────┴─────────────┴─────────────────┤
│              Core Foundation                 │
│  TaskManager │ AgentRegistry │ WorkflowEngine│
│  MessageBus  │ SharedMemory  │ Persistence   │
├─────────────────────────────────────────────┤
│              Agents                          │
│  ClaudeAgent │ ToolAgent │ HumanInTheLoop   │
└─────────────────────────────────────────────┘
```

## Tips

- After each prompt, verify: `npx tsc --noEmit && npm test`
- If Claude Code hits context limits, just say "continue"
- Keep `.env` with your `ANTHROPIC_API_KEY` for integration tests
- The old monolithic PHASE-*.md files are still available as reference but use the `phases/` sub-tasks instead
