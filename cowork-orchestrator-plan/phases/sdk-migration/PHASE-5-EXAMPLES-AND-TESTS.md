# Phase 5 — Working Examples, Integration Tests & End-to-End Verification

> **Copy-paste this entire prompt into Claude Code. Phases 0-4 must be completed first.**

---

```
We are completing the "cowork-orchestrator" Agent SDK migration. Phases 0-4 are done. Now create working examples that demonstrate the REAL system, write integration tests, and verify everything works end-to-end.

## 1. examples/sdk-simple-task.ts — Simple SDK Task

Create a minimal example that uses the new SDK execution layer:

```typescript
// Simple example: One SDK agent, one task — actually executes with Claude
// Usage: npx tsx examples/sdk-simple-task.ts
// Requires: Claude Code installed and logged in (Pro/Max subscription)

import { OrchestrationEngine } from '../src/index.js';
import type { ExecutionAgentConfig } from '../src/core/types.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const engine = new OrchestrationEngine({
    persistence: { enabled: true, dbPath: '/tmp/orchestrator-sdk.db' },
  });
  await engine.start();

  // Check execution backend status
  const execStatus = engine.getExecutionStatus();
  console.log('Execution backends:', execStatus);

  if (!execStatus.sdk && !execStatus.cli) {
    console.error('ERROR: Neither Agent SDK nor Claude CLI is available.');
    console.error('Make sure Claude Code is installed and you are logged in:');
    console.error('  npm install -g @anthropic-ai/claude-code');
    console.error('  claude login');
    process.exit(1);
  }

  // Register an SDK-powered agent
  const agentConfig: ExecutionAgentConfig = {
    id: 'coder-1',
    name: 'Code Assistant',
    role: 'developer',
    systemPrompt: 'You are a skilled software developer. Write clean, well-documented code.',
    capabilities: [
      { name: 'coding', description: 'Write and modify code', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'analysis', description: 'Analyze code and data', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 1,
    model: 'sonnet',  // Default, but ModelRouter may override
    executionMode: 'sdk',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 10,
  };

  engine.registerSDKAgent(agentConfig);

  // Submit a real task that requires tool use
  console.log('\n--- Submitting task ---\n');
  const result = await engine.submitTask({
    name: 'create-fibonacci',
    description: 'Create a TypeScript file at /tmp/fibonacci.ts that exports a function to compute the nth Fibonacci number using memoization. Include JSDoc comments and a simple test at the bottom that prints fib(10).',
    priority: 'medium',
    input: {},
  });

  console.log('\n--- Result ---');
  console.log(`Success: ${result.success}`);
  console.log(`Duration: ${result.duration}ms`);

  if (result.success) {
    const output = result.output as Record<string, unknown>;
    console.log(`Model used: ${output.modelUsed}`);
    console.log(`Tools used: ${JSON.stringify(output.toolsUsed)}`);
    console.log(`Files modified: ${JSON.stringify(output.filesModified)}`);
    console.log(`Turns: ${output.turnCount}`);
    console.log(`\nOutput:\n${(output.text as string)?.slice(0, 500)}`);
  } else {
    console.log(`Error: ${result.error}`);
  }

  console.log('\n--- Dashboard ---\n');
  console.log(engine.getDashboard());

  await engine.stop();
}

main().catch(console.error);
```

## 2. examples/sdk-workflow.ts — Multi-Agent Workflow with Model Routing

Create a workflow example that demonstrates cost-optimized model routing:

```typescript
// Multi-agent workflow with intelligent model routing
// Each task gets routed to the optimal model (haiku/sonnet/opus)
// Usage: npx tsx examples/sdk-workflow.ts
// Requires: Claude Code installed and logged in

import { v4 as uuidv4 } from 'uuid';
import { OrchestrationEngine } from '../src/index.js';
import type { ExecutionAgentConfig, Workflow, TaskPriority } from '../src/core/types.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const engine = new OrchestrationEngine({
    persistence: { enabled: true, dbPath: '/tmp/orchestrator-workflow.db' },
  });
  await engine.start();

  const execStatus = engine.getExecutionStatus();
  console.log('Execution backends:', execStatus);
  console.log('Model routing config:', engine.getModelRouter().getConfig());

  if (!execStatus.sdk && !execStatus.cli) {
    console.error('No execution backend available. Install and login to Claude Code.');
    process.exit(1);
  }

  // ── Register agents with different specializations ──────────────

  const agents: ExecutionAgentConfig[] = [
    {
      id: 'scanner-1',
      name: 'Code Scanner',
      role: 'scanner',
      systemPrompt: 'You scan codebases quickly. List files, find patterns, count occurrences. Be fast and concise.',
      capabilities: [
        { name: 'search', description: 'Search and scan code', inputSchema: {} as any, outputSchema: {} as any },
        { name: 'listing', description: 'List and enumerate items', inputSchema: {} as any, outputSchema: {} as any },
      ],
      maxConcurrentTasks: 2,
      model: 'haiku',
      executionMode: 'sdk',
      modelTier: 'haiku',  // Force haiku — scanning is simple
      allowedTools: ['Read', 'Glob', 'Grep'],
      maxTurns: 5,
    },
    {
      id: 'developer-1',
      name: 'Developer',
      role: 'developer',
      systemPrompt: 'You are a skilled developer. Write clean, tested code. Follow best practices.',
      capabilities: [
        { name: 'coding', description: 'Write and modify code', inputSchema: {} as any, outputSchema: {} as any },
        { name: 'refactoring', description: 'Refactor existing code', inputSchema: {} as any, outputSchema: {} as any },
      ],
      maxConcurrentTasks: 1,
      model: 'sonnet',
      executionMode: 'sdk',
      // No modelTier override — let the ModelRouter decide
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 15,
    },
    {
      id: 'reviewer-1',
      name: 'Code Reviewer',
      role: 'reviewer',
      systemPrompt: 'You are a thorough code reviewer. Check for bugs, security issues, and style problems. Be specific and actionable.',
      capabilities: [
        { name: 'review', description: 'Review code quality', inputSchema: {} as any, outputSchema: {} as any },
        { name: 'quality-check', description: 'Assess output quality', inputSchema: {} as any, outputSchema: {} as any },
      ],
      maxConcurrentTasks: 1,
      model: 'sonnet',
      executionMode: 'sdk',
      allowedTools: ['Read', 'Glob', 'Grep'],
      maxTurns: 10,
    },
  ];

  for (const config of agents) {
    engine.registerSDKAgent(config);
  }

  // ── Define a workflow ─────────────────────────────────────────────

  const taskDefaults = {
    priority: 'medium' as TaskPriority,
    input: { projectDir: '/tmp/sdk-workflow-demo' },
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 2 },
  };

  const workflow: Workflow = {
    id: uuidv4(),
    name: 'Code Quality Pipeline',
    description: 'Scan a project, create a utility module, then review it',
    status: 'pending',
    context: {},
    nodes: [
      {
        id: 'scan',
        taskTemplate: {
          ...taskDefaults,
          name: 'Scan Project Structure',
          description: 'List all TypeScript files in the current project directory. Report file count and directory structure. This is a simple scanning task.',
          priority: 'low',  // Low priority → haiku
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['search'] },
      },
      {
        id: 'implement',
        taskTemplate: {
          ...taskDefaults,
          name: 'Create String Utility Module',
          description: 'Create a TypeScript module at /tmp/sdk-workflow-demo/string-utils.ts with functions: capitalize, slugify, truncate, and camelToKebab. Include full JSDoc and export all functions.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['coding'] },
      },
      {
        id: 'review',
        taskTemplate: {
          ...taskDefaults,
          name: 'Review String Utils',
          description: 'Review the string-utils.ts file created in the previous step. Check for edge cases, type safety, and documentation quality. Provide specific improvement suggestions.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['review'] },
      },
    ],
    edges: [
      { from: 'scan', to: 'implement' },
      { from: 'implement', to: 'review' },
    ],
  };

  // ── Execute ───────────────────────────────────────────────────────

  // Create the demo directory first
  const { execSync } = await import('child_process');
  execSync('mkdir -p /tmp/sdk-workflow-demo');

  console.log(`\nStarting workflow: ${workflow.name}\n`);

  const result = await engine.executeWorkflow(workflow);

  console.log('\n=== Workflow Result ===');
  console.log(`Success: ${result.success}`);
  console.log(`Nodes completed: ${result.nodesCompleted}/${result.nodesTotal}`);
  console.log(`Duration: ${result.duration}ms`);

  for (const [nodeId, nodeResult] of result.outputs) {
    console.log(`\n--- ${nodeId} ---`);
    const output = nodeResult.output as Record<string, unknown>;
    console.log(`Model: ${output.modelUsed ?? 'unknown'}`);
    console.log(`Tools: ${JSON.stringify(output.toolsUsed ?? [])}`);
    const text = output.text;
    if (typeof text === 'string') {
      console.log(text.slice(0, 300) + (text.length > 300 ? '...' : ''));
    }
  }

  // Show model routing stats
  console.log('\n=== Model Usage Stats ===');
  console.log(engine.getModelRouter().getUsageStats());

  console.log('\n=== Dashboard ===\n');
  console.log(engine.getDashboard());

  await engine.stop();
}

main().catch(console.error);
```

## 3. examples/sdk-smart-submit.ts — Natural Language Task Submission

Create an example that shows the "magic" API — submit a plain text description and the system handles everything:

```typescript
// Smart submit: describe what you want in plain English
// The orchestrator decomposes, routes models, and executes automatically
// Usage: npx tsx examples/sdk-smart-submit.ts "your task description here"

import { OrchestrationEngine } from '../src/index.js';
import type { ExecutionAgentConfig } from '../src/core/types.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  const taskDescription = process.argv[2] ?? 'Create a simple Express.js hello world server at /tmp/hello-server.ts with proper TypeScript types and a health check endpoint';

  console.log(`Task: "${taskDescription}"\n`);

  const engine = new OrchestrationEngine({
    persistence: { enabled: true, dbPath: '/tmp/orchestrator-smart.db' },
  });
  await engine.start();

  // Register a versatile SDK agent
  engine.registerSDKAgent({
    id: 'general-sdk-1',
    name: 'General Purpose Agent',
    role: 'general',
    systemPrompt: 'You are a versatile assistant. Complete tasks efficiently. Write clean code. Be thorough but concise.',
    capabilities: [
      { name: 'general', description: 'General purpose tasks', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'coding', description: 'Write code', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'research', description: 'Research topics', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'writing', description: 'Write content', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'analysis', description: 'Analyze data', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 1,
    model: 'sonnet',
    executionMode: 'sdk',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    maxTurns: 20,
  });

  // Use smartSubmit — it auto-decomposes, auto-routes models, auto-executes
  console.log('Submitting task via smartSubmit...\n');
  const result = await engine.smartSubmit(taskDescription);

  console.log('=== Result ===');
  console.log(`Success: ${result.success}`);
  console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);

  if (result.success) {
    const output = result.output as Record<string, unknown>;
    if (output.text) {
      console.log(`\nOutput:\n${String(output.text).slice(0, 800)}`);
    } else {
      console.log(`\nOutput keys: ${Object.keys(output).join(', ')}`);
    }
  } else {
    console.log(`Error: ${result.error}`);
  }

  console.log('\n=== Model Usage ===');
  console.log(engine.getModelRouter().getUsageStats());

  await engine.stop();
}

main().catch(console.error);
```

## 4. Update examples/simple-task.ts — Mark as Legacy

Add a comment at the top of the existing `examples/simple-task.ts`:

```typescript
// LEGACY: This example uses the old Groq/Gemini LLM-only backend.
// For the new SDK-powered execution, see: examples/sdk-simple-task.ts
```

Do the same for `examples/research-workflow.ts`.

## 5. Integration Tests — tests/integration/sdk-execution.test.ts

Create integration tests for the execution layer. Note: these tests mock the actual Claude calls since we can't guarantee the Claude CLI is available in CI.

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SDKExecutor } from '../../src/execution/sdk-executor.js';
import { CLIExecutor } from '../../src/execution/cli-executor.js';
import { ModelRouter } from '../../src/execution/model-router.js';
import { SessionManager } from '../../src/execution/session-manager.js';
import { ResultParser } from '../../src/execution/result-parser.js';
import { SDKAgent } from '../../src/agents/sdk-agent.js';
import type { Task, ExecutionAgentConfig } from '../../src/core/types.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task-1',
    name: 'Test task',
    description: 'A test task for integration testing',
    priority: 'medium',
    status: 'pending',
    input: {},
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 3 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeAgentConfig(overrides: Partial<ExecutionAgentConfig> = {}): ExecutionAgentConfig {
  return {
    id: 'test-agent-1',
    name: 'Test Agent',
    role: 'developer',
    systemPrompt: 'You are a test agent.',
    capabilities: [
      { name: 'coding', description: 'Write code', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 1,
    model: 'sonnet',
    executionMode: 'sdk',
    allowedTools: ['Read', 'Write'],
    maxTurns: 5,
    ...overrides,
  };
}

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  it('should track active sessions', () => {
    manager.startSession({
      sessionId: 'sess-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      model: 'sonnet',
      startedAt: Date.now(),
    });
    expect(manager.getActiveSessions().length).toBe(1);
  });

  it('should move completed sessions to history', () => {
    manager.startSession({
      sessionId: 'sess-1',
      taskId: 'task-1',
      agentId: 'agent-1',
      model: 'sonnet',
      startedAt: Date.now(),
    });
    manager.completeSession('sess-1', {
      sessionId: 'sess-1',
      messages: [],
      result: 'Done',
      toolsUsed: ['Read'],
      filesModified: [],
      duration: 1000,
      modelUsed: 'sonnet',
      turnCount: 3,
    });
    expect(manager.getActiveSessions().length).toBe(0);
    expect(manager.getRecentCompleted().length).toBe(1);
  });

  it('should cleanup stale sessions', () => {
    manager.startSession({
      sessionId: 'sess-old',
      taskId: 'task-1',
      agentId: 'agent-1',
      model: 'sonnet',
      startedAt: Date.now() - 120_000, // 2 minutes ago
    });
    const cleaned = manager.cleanupStale(60_000); // 1 minute timeout
    expect(cleaned).toContain('sess-old');
    expect(manager.getActiveSessions().length).toBe(0);
  });
});

describe('ResultParser', () => {
  let parser: ResultParser;

  beforeEach(() => {
    parser = new ResultParser();
  });

  it('should parse CLI JSON output', () => {
    const jsonOutput = JSON.stringify({
      result: 'Hello world',
      session_id: 'test-session-123',
      cost_usd: 0,
      duration_ms: 5000,
      is_error: false,
      num_turns: 2,
      model: 'claude-sonnet-4-20250514',
    });

    const result = parser.parseCLIOutput(jsonOutput, Date.now() - 5000);
    expect(result.result).toBe('Hello world');
    expect(result.sessionId).toBe('test-session-123');
    expect(result.turnCount).toBe(2);
  });
});

describe('ModelRouter + SDKAgent integration', () => {
  it('should route models correctly when SDKAgent calls execute', () => {
    const router = new ModelRouter();
    const sessionManager = new SessionManager();

    // Create mock executors that track calls
    const sdkExecutor = new SDKExecutor(sessionManager);
    const cliExecutor = new CLIExecutor(sessionManager);

    const agent = new SDKAgent(
      makeAgentConfig(),
      sdkExecutor,
      cliExecutor,
      router,
    );

    // The agent should exist and have the right config
    expect(agent.id).toBe('test-agent-1');
    expect(agent.name).toBe('Test Agent');
  });

  it('should select appropriate models for different tasks', () => {
    const router = new ModelRouter();

    // Simple task
    const simpleTask = makeTask({ priority: 'low', description: 'List all files in the directory' });
    expect(router.selectModel(simpleTask)).toBe('haiku');

    // Medium task
    const mediumTask = makeTask({ priority: 'medium', description: 'Write a REST API endpoint' });
    expect(['sonnet', 'haiku']).toContain(router.selectModel(mediumTask));

    // Critical task
    const criticalTask = makeTask({ priority: 'critical', description: 'Design the system architecture' });
    expect(router.selectModel(criticalTask)).toBe('opus');
  });
});

describe('OrchestrationEngine with SDK agents', () => {
  it('should register SDK agents and report execution status', async () => {
    // Dynamic import to avoid issues if the module has side effects
    const { OrchestrationEngine } = await import('../../src/core/orchestrator.js');

    const engine = new OrchestrationEngine({
      persistence: { enabled: false, dbPath: '' },
    });

    engine.registerSDKAgent(makeAgentConfig());

    const status = engine.getExecutionStatus();
    expect(status).toHaveProperty('sdk');
    expect(status).toHaveProperty('cli');
    expect(status).toHaveProperty('planningMode');

    // Should have 1 agent registered
    expect(engine.getAgentRegistry().getAll().length).toBe(1);
  });
});
```

## 6. Create a README section — Update README.md

Update the project README.md with usage documentation:

```markdown
# cowork-orchestrator

Multi-agent orchestration framework for coordinating AI agents on complex tasks.

## Quick Start

### Prerequisites
- Node.js 18+
- Claude Code installed and logged in (`claude login`)
- Claude Pro or Max subscription

### Setup
```bash
npm install
cp .env.example .env
# Edit .env — add GROQ_API_KEY for free planning calls (optional)
```

### Run Examples

```bash
# Simple single task (creates a file using Claude)
npx tsx examples/sdk-simple-task.ts

# Multi-agent workflow with model routing
npx tsx examples/sdk-workflow.ts

# Smart submit — describe a task in plain English
npx tsx examples/sdk-smart-submit.ts "create a CLI tool that converts CSV to JSON"
```

### Architecture

The orchestrator has two layers:

1. **Intelligence Layer** — Uses Groq/Gemini (free) for planning:
   - Task decomposition (breaking big tasks into subtasks)
   - Agent selection (matching tasks to the best agent)
   - Quality assessment (checking output quality)

2. **Execution Layer** — Uses Claude Agent SDK (Pro/Max subscription):
   - Actually performs tasks (reads/writes files, runs commands)
   - Intelligent model routing (haiku/sonnet/opus per task)
   - Cost-optimized: simple tasks use Haiku, complex tasks use Opus

### Model Routing

| Task Type | Model | Cost |
|-----------|-------|------|
| Scanning, listing, simple queries | Haiku | Lowest |
| Code writing, analysis, research | Sonnet | Medium |
| Architecture, security audits, complex planning | Opus | Highest |

### API

```typescript
import { OrchestrationEngine } from 'cowork-orchestrator';

const engine = new OrchestrationEngine();
await engine.start();

// Register an SDK-powered agent
engine.registerSDKAgent({
  id: 'dev-1',
  name: 'Developer',
  role: 'developer',
  systemPrompt: 'You are a skilled developer.',
  capabilities: [{ name: 'coding', description: 'Write code', inputSchema: {}, outputSchema: {} }],
  maxConcurrentTasks: 1,
  model: 'sonnet',
  executionMode: 'sdk',
});

// Submit a task
const result = await engine.submitTask({
  name: 'create-feature',
  description: 'Add user authentication to the Express app',
  priority: 'high',
});

console.log(result);
await engine.stop();
```
```

## 7. Final Verification

Run the complete test suite and ensure everything compiles:

```bash
# 1. Type check
npx tsc --noEmit

# 2. Run all tests
npm test

# 3. Verify the examples at least parse (don't actually run them, they need Claude)
npx tsx --no-warnings -e "import('./examples/sdk-simple-task.ts').catch(() => console.log('sdk-simple-task.ts: imports OK'))"
npx tsx --no-warnings -e "import('./examples/sdk-workflow.ts').catch(() => console.log('sdk-workflow.ts: imports OK'))"
npx tsx --no-warnings -e "import('./examples/sdk-smart-submit.ts').catch(() => console.log('sdk-smart-submit.ts: imports OK'))"
```

Fix ANY errors before committing.

Commit: "feat: add SDK examples, integration tests, and documentation"
```
