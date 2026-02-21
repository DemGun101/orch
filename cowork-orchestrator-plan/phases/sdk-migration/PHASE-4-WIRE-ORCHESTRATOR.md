# Phase 4 — Wire Everything Together: Orchestrator Integration

> **Copy-paste this entire prompt into Claude Code. Phases 0-3 must be completed first.**

---

```
We are continuing the "cowork-orchestrator" Agent SDK migration. Phases 0-3 are complete. Now we wire ALL the new components into the main OrchestrationEngine so the system actually works end-to-end.

This is the integration phase — we modify `src/core/orchestrator.ts` to support BOTH the old LLM-only agents AND the new SDK-powered agents, with intelligent model routing.

## 1. Update src/core/orchestrator.ts — Add Execution Layer

Add imports at the top:

```typescript
import { SDKExecutor } from '../execution/sdk-executor.js';
import { CLIExecutor } from '../execution/cli-executor.js';
import { ModelRouter } from '../execution/model-router.js';
import { SessionManager } from '../execution/session-manager.js';
import { SDKAgent } from '../agents/sdk-agent.js';
import { PlanningClient } from '../intelligence/planning-client.js';
import type { ExecutionAgentConfig, ModelTier } from './types.js';
```

Add new private fields to the `OrchestrationEngine` class (after the existing fields):

```typescript
// ─── Execution Layer ─────────────────────────────────────────────
private sdkExecutor: SDKExecutor;
private cliExecutor: CLIExecutor;
private modelRouter: ModelRouter;
private sessionManager: SessionManager;
private planningClient: PlanningClient;
```

Update the constructor — after the existing initialization code, add:

```typescript
// Initialize execution layer
this.sessionManager = new SessionManager(this.persistence);
this.sdkExecutor = new SDKExecutor(this.sessionManager);
this.cliExecutor = new CLIExecutor(this.sessionManager);
this.modelRouter = new ModelRouter(this.config.modelRouting);

// Initialize planning client (for intelligence layer)
this.planningClient = new PlanningClient();

// Re-initialize intelligence layer with PlanningClient
this.initializeIntelligence(this.llmClient);
```

Update `initializeIntelligence()` to use PlanningClient:

```typescript
private initializeIntelligence(client: OpenAI): void {
  const model = this.config.llm?.model;
  // Use PlanningClient if available, fallback to raw OpenAI client
  const planningSource = this.planningClient ?? client;
  this.taskDecomposer = new TaskDecomposer(planningSource as any, { model });
  this.agentSelector = new AgentSelector(planningSource as any, model);
  this.conflictResolver = new ConflictResolver(planningSource as any, undefined, model);
  this.qualityAssessor = new QualityAssessor(planningSource as any, { model });
}
```

Note: The `as any` casts are needed because PlanningClient and OpenAI have different types. The intelligence layer classes were updated in Phase 3 to accept both.

## 2. Add registerSDKAgent() Method

Add a new method alongside the existing `registerAgent()`:

```typescript
/**
 * Register an SDK-powered agent that uses the Claude Agent SDK for execution.
 * Unlike registerAgent() which creates LLM-only agents, this creates agents
 * that can actually read/write files, run commands, etc.
 */
registerSDKAgent(config: ExecutionAgentConfig): SDKAgent {
  const agent = new SDKAgent(
    config,
    this.sdkExecutor,
    this.cliExecutor,
    this.modelRouter,
  );

  // Wire up subsystems (same as registerAgent)
  agent.setMessageBus(this.messageBus);
  agent.setHistory(this.conversationHistory);

  this.agentRegistry.register(agent);

  // Create per-agent circuit breaker
  this.agentCircuitBreakers.set(config.id, new CircuitBreaker());

  // Monitoring
  this.metricsCollector.record(METRICS.AGENTS_ACTIVE, this.agentRegistry.getAll().length);
  this.audit(AUDIT_EVENTS.AGENT_REGISTERED, {
    agentId: config.id,
    data: { name: config.name, role: config.role, executionMode: config.executionMode },
  });

  return agent;
}
```

## 3. Update the existing registerAgent() — Keep It Working

The existing `registerAgent()` method should CONTINUE to work as-is for backward compatibility. It creates LLM-only agents that use Groq/Gemini. No changes needed here.

## 4. Add Execution Layer Accessors

Add these accessor methods to the OrchestrationEngine class:

```typescript
// ─── Execution Layer Accessors ──────────────────────────────────

getModelRouter(): ModelRouter {
  return this.modelRouter;
}

getSessionManager(): SessionManager {
  return this.sessionManager;
}

getSDKExecutor(): SDKExecutor {
  return this.sdkExecutor;
}

getCLIExecutor(): CLIExecutor {
  return this.cliExecutor;
}

getPlanningClient(): PlanningClient {
  return this.planningClient;
}

/** Get execution backend status */
getExecutionStatus(): { sdk: boolean; cli: boolean; planningMode: string } {
  return {
    sdk: this.sdkExecutor.isAvailable(),
    cli: this.cliExecutor.isAvailable(),
    planningMode: this.planningClient.getMode(),
  };
}
```

## 5. Update the Dashboard — Show Execution Status

Update `src/monitoring/dashboard.ts` to display execution layer information.

Find the `render()` method and add a new section that shows:
- Execution backends: SDK (available/unavailable), CLI (available/unavailable)
- Planning mode: openai (groq/gemini) or claude-cli
- Model routing stats: how many tasks routed to haiku/sonnet/opus
- Active SDK sessions count
- Recent session completions

You'll need to pass the new components to the Dashboard. Update the Dashboard constructor to optionally accept:
```typescript
private modelRouter?: ModelRouter;
private sessionManager?: SessionManager;
```

Add a new method to set them:
```typescript
setExecutionLayer(modelRouter: ModelRouter, sessionManager: SessionManager): void {
  this.modelRouter = modelRouter;
  this.sessionManager = sessionManager;
}
```

Call this from the OrchestrationEngine constructor after creating the Dashboard and execution layer.

In the `render()` method, add a section like:
```
╔══════════════════════════════════════════╗
║         EXECUTION LAYER                  ║
╠══════════════════════════════════════════╣
║ SDK Backend:    ✓ Available              ║
║ CLI Backend:    ✓ Available              ║
║ Planning Mode:  openai (groq)            ║
║                                          ║
║ Model Usage:                             ║
║   Haiku:   12 tasks                      ║
║   Sonnet:  8 tasks                       ║
║   Opus:    2 tasks                       ║
║                                          ║
║ Active Sessions: 1                       ║
╚══════════════════════════════════════════╝
```

## 6. Update src/index.ts — Export Everything

Make sure ALL new components are exported:

```typescript
// ─── Execution Layer ────────────────────────────────────────────────
export { SDKExecutor } from './execution/sdk-executor.js';
export { CLIExecutor } from './execution/cli-executor.js';
export { ModelRouter } from './execution/model-router.js';
export { ResultParser } from './execution/result-parser.js';
export { SessionManager } from './execution/session-manager.js';
export { SDKAgent } from './agents/sdk-agent.js';
export { PlanningClient } from './intelligence/planning-client.js';
export type {
  ModelTier,
  ExecutionMode,
  SDKExecutionResult,
  SDKMessage,
  ModelRoutingConfig,
  ExecutionAgentConfig,
} from './core/types.js';
```

## 7. Update src/core/orchestrator.ts stop() method

Update the `stop()` method to clean up the execution layer:

After the existing cleanup code (waiting for running tasks, closing persistence), add:

```typescript
// Clean up stale SDK sessions
this.sessionManager.cleanupStale(60_000);
```

## 8. Verify

1. `npx tsc --noEmit` — must compile with ZERO errors
2. `npm test` — all existing tests must still pass
3. No behavior changes to existing code — the new execution layer is opt-in via registerSDKAgent()
4. Fix any compilation errors

Commit: "feat: wire execution layer into orchestrator — registerSDKAgent, dashboard, planning client"
```
