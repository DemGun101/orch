# Phase 2 — Intelligence Layer (AI-Powered Decomposition, Selection, Quality)

> **Copy-paste this entire prompt into Claude Code. This adds the "brain" — Claude-powered intelligence on top of the foundation.**

---

```
We are continuing the "cowork-orchestrator" project. Phase 1 (foundation) is complete. Now implement the intelligence layer — the AI-powered components that make the orchestrator smart. These modules all use Claude API calls to make decisions.

Important: Import the Anthropic SDK and use it for all AI calls. Use `claude-sonnet-4-20250514` as the default model for intelligence operations (fast + capable). Each intelligence module should accept an Anthropic client instance in its constructor.

## 1. src/intelligence/task-decomposer.ts — AI Task Decomposition

Implement `TaskDecomposer` class:
- Constructor takes `Anthropic` client and optional config (model, maxSubtasks)
- `decompose(task: Task, availableCapabilities: AgentCapability[]): Promise<DecompositionResult>`
  - Sends the task description + available capabilities to Claude
  - System prompt instructs Claude to break the task into subtasks that map to available capabilities
  - Claude returns structured JSON (use tool_use with a decomposition schema):
    ```
    {
      subtasks: [{ name, description, requiredCapability, priority, estimatedComplexity, dependencies }],
      reasoning: string,
      parallelGroups: string[][]  // which subtasks can run in parallel
    }
    ```
  - Validate the response with Zod
  - Convert to Task objects and set up dependency links
  - Handle edge cases: task too simple to decompose (return single task), task too complex (recursive decomposition)
- `estimateComplexity(task: Task): Promise<'trivial' | 'simple' | 'moderate' | 'complex' | 'epic'>`
  - Quick Claude call to estimate how complex a task is
- `suggestWorkflow(task: Task, capabilities: AgentCapability[]): Promise<Workflow>`
  - Given a high-level task, generate a complete Workflow DAG
  - Claude designs the workflow structure, the code converts it to proper Workflow/Node/Edge objects

## 2. src/intelligence/agent-selector.ts — AI Agent Selection

Implement `AgentSelector` class:
- Constructor takes `Anthropic` client
- `selectAgent(task: Task, candidates: BaseAgent[]): Promise<AgentSelectionResult>`
  - Sends task requirements + candidate agent profiles (capabilities, current load, historical performance) to Claude
  - Claude returns:
    ```
    {
      selectedAgentId: string,
      reasoning: string,
      confidence: number,       // 0-1
      alternativeId?: string    // fallback agent
    }
    ```
  - If confidence < 0.5, flag for human review
- `rankAgents(task: Task, candidates: BaseAgent[]): Promise<RankedAgent[]>`
  - Returns all candidates ranked with scores and reasoning
- `suggestTeam(workflow: Workflow, availableAgents: BaseAgent[]): Promise<TeamAssignment[]>`
  - Given a full workflow, suggest which agent should handle each node
  - Considers load balancing, specialization, and minimizing context switches
- Cache recent selections to avoid redundant API calls (LRU cache, 5 min TTL)

## 3. src/intelligence/conflict-resolver.ts — AI Conflict Resolution

Implement `ConflictResolver` class:
- Constructor takes `Anthropic` client and `MessageBus`
- `detectConflicts(outputs: Map<string, TaskResult>): Promise<Conflict[]>`
  - Takes outputs from multiple agents working on related tasks
  - Sends to Claude to detect contradictions, inconsistencies, or overlaps
  - Returns array of `Conflict` objects: `{ type, agentIds, description, severity, suggestedResolution }`
- `resolve(conflict: Conflict, agentOutputs: Map<string, TaskResult>): Promise<Resolution>`
  - Given a specific conflict, Claude decides how to resolve it:
    - MERGE: combine outputs intelligently
    - PREFER: pick one agent's output with reasoning
    - RETRY: ask one or more agents to redo with additional context
    - ESCALATE: flag for human review
  - Returns `Resolution` with the chosen strategy and the merged/resolved output
- `preventConflict(tasks: Task[]): Promise<ConflictPrevention>`
  - Before assigning parallel tasks, check if they might conflict
  - Suggest guardrails: namespaced outputs, explicit boundaries, coordination protocol

## 4. src/intelligence/quality-assessor.ts — AI Quality Assessment

Implement `QualityAssessor` class:
- Constructor takes `Anthropic` client
- `assess(task: Task, result: TaskResult): Promise<QualityReport>`
  - Evaluates the output quality against the original task requirements
  - Claude scores on multiple dimensions:
    ```
    {
      overallScore: number,        // 0-100
      dimensions: {
        completeness: number,      // did it address all requirements?
        accuracy: number,          // is the output correct?
        coherence: number,         // is it logically consistent?
        relevance: number          // is it focused on the task?
      },
      issues: [{ severity, description, suggestion }],
      passesThreshold: boolean,    // above minimum quality bar (default 70)
      improvementSuggestions: string[]
    }
    ```
- `compare(task: Task, results: TaskResult[]): Promise<ComparisonReport>`
  - Compare multiple outputs for the same task, rank them
- `validateWorkflowOutput(workflow: Workflow, finalOutput: unknown): Promise<QualityReport>`
  - End-to-end quality check on the entire workflow output
- Configurable quality thresholds per task priority (critical tasks need score > 90, low priority > 50)

## 5. Update src/core/orchestrator.ts — Integrate Intelligence

Update the `OrchestrationEngine` to use the intelligence layer:
- Add intelligence modules as properties (TaskDecomposer, AgentSelector, ConflictResolver, QualityAssessor)
- Update `submitTask()` flow:
  1. Estimate complexity via TaskDecomposer
  2. If complex/epic, auto-decompose into subtasks
  3. Use AgentSelector to pick agents (instead of simple findBestMatch)
  4. After task completion, run QualityAssessor
  5. If quality below threshold, retry with feedback
- Update workflow execution:
  1. Use suggestTeam for agent assignment
  2. After parallel node completion, run conflict detection
  3. Resolve any conflicts before proceeding to dependent nodes
- Add `smartSubmit(description: string): Promise<TaskResult>` — takes a plain text description, decomposes, creates workflow, executes, and returns final result. This is the "magic" high-level API.

## 6. Update src/memory/conversation-history.ts — AI-Powered Summarization

Update the `summarize(agentId)` method:
- Now actually calls Claude to summarize the conversation history
- System prompt: "Summarize this conversation concisely, preserving key decisions, facts, and context needed for continuation"
- Returns the summary as a string
- Add `compressHistory(agentId, targetTokens)` — summarizes older messages while keeping recent ones intact, to fit within token budget

## 7. Tests for Intelligence Layer

Create these test files:
- `tests/unit/task-decomposer.test.ts` — mock Claude responses, test decomposition logic, Zod validation, edge cases
- `tests/unit/agent-selector.test.ts` — mock Claude responses, test ranking, team suggestion, caching
- `tests/unit/conflict-resolver.test.ts` — test conflict detection with mock outputs, resolution strategies
- `tests/unit/quality-assessor.test.ts` — test scoring, threshold logic, comparison

For tests, mock the Anthropic client. Create a helper `createMockAnthropic()` that returns a mock client whose `messages.create()` returns predetermined responses. Put this mock in `tests/fixtures/mock-anthropic.ts`.

After all files:
1. `npx tsc --noEmit` — must compile clean
2. `npm test` — all tests must pass
3. Fix any issues

Commit: "feat: implement intelligence layer — AI decomposition, selection, conflict resolution, quality assessment"
```
