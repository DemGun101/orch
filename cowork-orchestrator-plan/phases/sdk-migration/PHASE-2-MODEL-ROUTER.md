# Phase 2 — Intelligent Model Router: Cost-Optimized Model Selection

> **Copy-paste this entire prompt into Claude Code. Phases 0-1 must be completed first.**

---

```
We are continuing the "cowork-orchestrator" Agent SDK migration. Phases 0-1 are complete. Now implement the intelligent model router that selects the optimal Claude model (haiku/sonnet/opus) for each task based on complexity, priority, and cost.

This is the KEY cost optimization piece. The user is on a Claude Pro/Max plan with limited usage:
- Haiku: Cheapest, fast, good for simple tasks (classification, formatting, basic generation)
- Sonnet: Mid-tier, good for standard tasks (code writing, analysis, research)
- Opus: Most expensive, reserved for complex/critical tasks (architecture, deep reasoning)

The goal: NEVER use Opus for a task that Sonnet could handle. NEVER use Sonnet for a task that Haiku could handle. Save expensive model usage for tasks that truly need it.

## 1. src/execution/model-router.ts — Full Implementation

Implement `ModelRouter` class:

```typescript
import type {
  Task,
  TaskPriority,
  ModelTier,
  ModelRoutingConfig,
} from '../core/types.js';
import type { ComplexityRating } from '../intelligence/task-decomposer.js';

// ─── Default Configuration ─────────────────────────────────────────

const DEFAULT_ROUTING_CONFIG: ModelRoutingConfig = {
  defaultModel: 'sonnet',
  planningModel: 'haiku',

  // Priority-based defaults
  priorityOverrides: {
    critical: 'opus',
    high: 'sonnet',
    medium: 'sonnet',
    low: 'haiku',
  },

  // Complexity-based defaults (from TaskDecomposer.estimateComplexity)
  complexityOverrides: {
    trivial: 'haiku',
    simple: 'haiku',
    moderate: 'sonnet',
    complex: 'opus',
    epic: 'opus',
  },

  // Max agentic turns per session (cost control)
  maxTurnsDefault: 10,
  maxTurnsByPriority: {
    critical: 30,
    high: 20,
    medium: 15,
    low: 5,
  },
};

// ─── Capability → Model Mapping ─────────────────────────────────────

// Some capabilities inherently need more powerful models
const CAPABILITY_MODEL_HINTS: Record<string, ModelTier> = {
  // Haiku-suitable: simple, well-defined tasks
  'formatting': 'haiku',
  'classification': 'haiku',
  'extraction': 'haiku',
  'summarization': 'haiku',
  'translation': 'haiku',
  'search': 'haiku',
  'listing': 'haiku',
  'validation': 'haiku',

  // Sonnet-suitable: standard complexity
  'writing': 'sonnet',
  'analysis': 'sonnet',
  'research': 'sonnet',
  'coding': 'sonnet',
  'review': 'sonnet',
  'debugging': 'sonnet',
  'testing': 'sonnet',
  'refactoring': 'sonnet',
  'documentation': 'sonnet',

  // Opus-suitable: deep reasoning required
  'architecture': 'opus',
  'planning': 'opus',
  'design': 'opus',
  'optimization': 'opus',
  'security-audit': 'opus',
  'complex-analysis': 'opus',
};

// ─── Task Description Heuristics ────────────────────────────────────

// Keywords that suggest simple tasks (haiku)
const SIMPLE_KEYWORDS = [
  'list', 'count', 'format', 'rename', 'move', 'copy', 'delete',
  'find', 'search', 'check', 'validate', 'extract', 'convert',
  'simple', 'basic', 'quick', 'trivial',
];

// Keywords that suggest complex tasks (opus)
const COMPLEX_KEYWORDS = [
  'architect', 'design', 'optimize', 'refactor entire', 'security audit',
  'performance analysis', 'migrate', 'complex', 'critical', 'comprehensive',
  'deep dive', 'investigate', 'root cause', 'system design',
];

// ─── Model Router ───────────────────────────────────────────────────

export class ModelRouter {
  private config: ModelRoutingConfig;
  private usageTracker: Map<ModelTier, { count: number; lastUsed: number }>;

  constructor(config?: Partial<ModelRoutingConfig>) {
    this.config = { ...DEFAULT_ROUTING_CONFIG, ...config };
    this.usageTracker = new Map([
      ['haiku', { count: 0, lastUsed: 0 }],
      ['sonnet', { count: 0, lastUsed: 0 }],
      ['opus', { count: 0, lastUsed: 0 }],
    ]);
  }

  /**
   * Select the optimal model for a task.
   * Uses a scoring system that considers: priority, complexity, capabilities, and description keywords.
   * The CHEAPEST model that can handle the task wins.
   */
  selectModel(task: Task, complexity?: ComplexityRating): ModelTier {
    const scores: Record<ModelTier, number> = { haiku: 0, sonnet: 0, opus: 0 };

    // 1. Priority signal
    const priorityModel = this.config.priorityOverrides[task.priority];
    scores[priorityModel] += 3;

    // 2. Complexity signal (if available)
    if (complexity) {
      const complexityModel = this.config.complexityOverrides[complexity] as ModelTier;
      if (complexityModel) {
        scores[complexityModel] += 4; // Complexity is the strongest signal
      }
    }

    // 3. Description keyword analysis
    const descLower = task.description.toLowerCase();
    const nameAndDesc = `${task.name} ${task.description}`.toLowerCase();

    let simpleScore = 0;
    let complexScore = 0;

    for (const kw of SIMPLE_KEYWORDS) {
      if (nameAndDesc.includes(kw)) simpleScore++;
    }
    for (const kw of COMPLEX_KEYWORDS) {
      if (nameAndDesc.includes(kw)) complexScore++;
    }

    if (simpleScore > complexScore) {
      scores.haiku += 2;
    } else if (complexScore > simpleScore) {
      scores.opus += 2;
    } else {
      scores.sonnet += 1;
    }

    // 4. Input size signal (larger inputs need more capable models)
    const inputSize = JSON.stringify(task.input).length;
    if (inputSize > 10000) {
      scores.opus += 1;
      scores.sonnet += 1;
    } else if (inputSize > 2000) {
      scores.sonnet += 1;
    }

    // 5. Description length heuristic (longer = more complex)
    if (task.description.length > 500) {
      scores.sonnet += 1;
    }
    if (task.description.length > 1500) {
      scores.opus += 1;
    }

    // 6. Resolve: pick the cheapest model that has the highest score
    // In case of ties, prefer the cheaper model
    let selected: ModelTier = this.config.defaultModel;
    let maxScore = -1;

    // Check in order from cheapest to most expensive
    const tiers: ModelTier[] = ['haiku', 'sonnet', 'opus'];
    for (const tier of tiers) {
      if (scores[tier] > maxScore) {
        maxScore = scores[tier];
        selected = tier;
      }
    }

    // Track usage
    const tracker = this.usageTracker.get(selected)!;
    tracker.count++;
    tracker.lastUsed = Date.now();

    return selected;
  }

  /**
   * Get the max turns allowed for a task based on its priority and model.
   */
  getMaxTurns(task: Task, model: ModelTier): number {
    const priorityTurns = this.config.maxTurnsByPriority[task.priority]
      ?? this.config.maxTurnsDefault;

    // Cap expensive models at fewer turns
    const modelCaps: Record<ModelTier, number> = {
      haiku: 10,
      sonnet: 25,
      opus: 35,
    };

    return Math.min(priorityTurns, modelCaps[model]);
  }

  /**
   * Get the model to use for intelligence layer calls
   * (task decomposition, agent selection, quality assessment).
   * These are lightweight, cheap calls — always use the cheapest model.
   */
  getPlanningModel(): ModelTier {
    return this.config.planningModel;
  }

  /**
   * Get current usage statistics by model tier.
   */
  getUsageStats(): Record<ModelTier, { count: number; lastUsed: number }> {
    return Object.fromEntries(this.usageTracker) as Record<ModelTier, { count: number; lastUsed: number }>;
  }

  /**
   * Suggest allowed tools based on task type and model tier.
   * Cheaper models get fewer tools (to prevent runaway execution).
   */
  suggestAllowedTools(task: Task, model: ModelTier): string[] {
    // Base tools available to all models
    const baseTools = ['Read', 'Glob', 'Grep'];

    if (model === 'haiku') {
      // Haiku: read-only + basic operations
      return [...baseTools];
    }

    if (model === 'sonnet') {
      // Sonnet: read + write + bash
      return [...baseTools, 'Write', 'Edit', 'Bash'];
    }

    // Opus: full access
    return [...baseTools, 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch'];
  }

  /**
   * Update routing config at runtime.
   */
  updateConfig(updates: Partial<ModelRoutingConfig>): void {
    Object.assign(this.config, updates);
  }

  /**
   * Get current routing config.
   */
  getConfig(): Readonly<ModelRoutingConfig> {
    return { ...this.config };
  }
}
```

## 2. Wire ModelRouter into SDKAgent

Update `src/agents/sdk-agent.ts` — the SDKAgent should use the ModelRouter to also determine max turns and allowed tools:

In the `execute()` method, after determining the model tier, add:

```typescript
// Get max turns from router
const maxTurns = this.modelRouter?.getMaxTurns(task, modelTier)
  ?? this.executionConfig.maxTurns
  ?? 10;

// Get suggested tools from router (if agent config doesn't override)
const allowedTools = this.executionConfig.allowedTools
  ?? this.modelRouter?.suggestAllowedTools(task, modelTier)
  ?? ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'];
```

Make sure the SDKAgent passes these values to both the sdkExecutor.execute() and cliExecutor.execute() calls.

## 3. Update the CLI executor to respect max turns

In `src/execution/cli-executor.ts`, update the `buildArgs()` method to accept maxTurns as a parameter instead of reading from agentConfig, so the caller can pass the router-determined value.

Update the `execute()` method signature to accept `maxTurns: number` and `allowedTools: string[]` as additional parameters (or bundle them in an options object).

## 4. Create src/config/defaults.ts — Add Model Routing Defaults

Update `src/config/defaults.ts` (or create if it doesn't exist) to include default model routing:

Add a `DEFAULT_MODEL_ROUTING` export:

```typescript
import type { ModelRoutingConfig } from '../core/types.js';

export const DEFAULT_MODEL_ROUTING: ModelRoutingConfig = {
  defaultModel: 'sonnet',
  planningModel: 'haiku',
  priorityOverrides: {
    critical: 'opus',
    high: 'sonnet',
    medium: 'sonnet',
    low: 'haiku',
  },
  complexityOverrides: {
    trivial: 'haiku',
    simple: 'haiku',
    moderate: 'sonnet',
    complex: 'opus',
    epic: 'opus',
  },
  maxTurnsDefault: 10,
  maxTurnsByPriority: {
    critical: 30,
    high: 20,
    medium: 15,
    low: 5,
  },
};
```

## 5. Unit Tests — tests/unit/model-router.test.ts

Create tests for the ModelRouter:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { ModelRouter } from '../../src/execution/model-router.js';
import type { Task } from '../../src/core/types.js';

// Helper to create a minimal task
function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-1',
    name: 'Test task',
    description: 'A test task',
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

describe('ModelRouter', () => {
  let router: ModelRouter;

  beforeEach(() => {
    router = new ModelRouter();
  });

  it('should select haiku for low priority tasks', () => {
    const task = makeTask({ priority: 'low', description: 'List all files' });
    expect(router.selectModel(task)).toBe('haiku');
  });

  it('should select opus for critical priority tasks', () => {
    const task = makeTask({ priority: 'critical', description: 'Architect the system' });
    expect(router.selectModel(task)).toBe('opus');
  });

  it('should respect complexity rating over priority', () => {
    // High priority but trivial complexity → haiku should still win
    const task = makeTask({ priority: 'high', description: 'Count files' });
    const model = router.selectModel(task, 'trivial');
    expect(model).toBe('haiku');
  });

  it('should detect simple tasks from keywords', () => {
    const task = makeTask({ description: 'Find all TODO comments and list them' });
    expect(router.selectModel(task)).toBe('haiku');
  });

  it('should detect complex tasks from keywords', () => {
    const task = makeTask({ description: 'Architect a comprehensive microservices migration strategy' });
    expect(router.selectModel(task)).toBe('opus');
  });

  it('should default to sonnet for ambiguous tasks', () => {
    const task = makeTask({ description: 'Process the data and generate output' });
    const model = router.selectModel(task);
    expect(['sonnet', 'haiku']).toContain(model); // Should be sonnet or haiku, not opus
  });

  it('should cap max turns by model', () => {
    const task = makeTask({ priority: 'critical' });
    const turns = router.getMaxTurns(task, 'haiku');
    expect(turns).toBeLessThanOrEqual(10); // Haiku capped at 10
  });

  it('should track usage stats', () => {
    const task = makeTask({ priority: 'low' });
    router.selectModel(task);
    router.selectModel(task);
    const stats = router.getUsageStats();
    expect(stats.haiku.count).toBeGreaterThan(0);
  });

  it('should suggest limited tools for haiku', () => {
    const task = makeTask();
    const tools = router.suggestAllowedTools(task, 'haiku');
    expect(tools).not.toContain('Bash'); // Haiku shouldn't get Bash
    expect(tools).toContain('Read');
  });

  it('should suggest full tools for opus', () => {
    const task = makeTask();
    const tools = router.suggestAllowedTools(task, 'opus');
    expect(tools).toContain('Bash');
    expect(tools).toContain('WebSearch');
  });
});
```

## 6. Verify

1. `npx tsc --noEmit` — must compile with ZERO errors
2. `npm test` — ALL tests must pass (including new model-router tests)
3. Fix any issues

Commit: "feat: implement intelligent model router with cost-optimized selection"
```
