import { describe, it, expect } from 'vitest';
import { WorkflowEngine, validateDAG, topologicalSort } from '../../src/core/workflow-engine.js';
import { TaskManager } from '../../src/core/task-manager.js';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { MockAgent, createMockCapability } from '../fixtures/mock-agent.js';
import type { Workflow, WorkflowNode, WorkflowEdge, TaskResult } from '../../src/core/types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createNode(id: string, name?: string): WorkflowNode {
  return {
    id,
    taskTemplate: {
      name: name ?? id,
      description: `Task for ${id}`,
      priority: 'medium',
      input: {},
      dependencies: [],
      subtasks: [],
      metadata: { retryCount: 0, maxRetries: 3 },
    },
  };
}

function createWorkflow(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
  context: Record<string, unknown> = {},
): Workflow {
  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    nodes,
    edges,
    status: 'pending',
    context,
  };
}

function createEngine(executeFn?: (taskName: string) => Promise<TaskResult>): {
  engine: WorkflowEngine;
  registry: AgentRegistry;
  taskManager: TaskManager;
} {
  const taskManager = new TaskManager();
  const registry = new AgentRegistry();

  // Register a mock agent that can handle any task
  const agent = new MockAgent(
    {
      id: 'agent-1',
      capabilities: [createMockCapability('general')],
      maxConcurrentTasks: 10,
    },
    executeFn
      ? async (task) => {
          return executeFn(task.name);
        }
      : undefined,
  );
  registry.register(agent);

  const engine = new WorkflowEngine(taskManager, registry);
  return { engine, registry, taskManager };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('validateDAG', () => {
  it('accepts a valid DAG', () => {
    const nodes = [createNode('A'), createNode('B'), createNode('C')];
    const edges: WorkflowEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];

    const result = validateDAG(nodes, edges);
    expect(result.valid).toBe(true);
  });

  it('detects cycles', () => {
    const nodes = [createNode('A'), createNode('B'), createNode('C')];
    const edges: WorkflowEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
      { from: 'C', to: 'A' },
    ];

    const result = validateDAG(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cycle');
  });

  it('rejects edges referencing unknown nodes', () => {
    const nodes = [createNode('A')];
    const edges: WorkflowEdge[] = [{ from: 'A', to: 'X' }];

    const result = validateDAG(nodes, edges);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('unknown');
  });

  it('accepts empty DAG', () => {
    const result = validateDAG([], []);
    expect(result.valid).toBe(true);
  });

  it('accepts DAG with no edges', () => {
    const nodes = [createNode('A'), createNode('B')];
    const result = validateDAG(nodes, []);
    expect(result.valid).toBe(true);
  });
});

describe('topologicalSort', () => {
  it('returns correct order for linear DAG', () => {
    const nodes = [createNode('A'), createNode('B'), createNode('C')];
    const edges: WorkflowEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'B', to: 'C' },
    ];

    const sorted = topologicalSort(nodes, edges);
    expect(sorted.indexOf('A')).toBeLessThan(sorted.indexOf('B'));
    expect(sorted.indexOf('B')).toBeLessThan(sorted.indexOf('C'));
  });

  it('handles diamond DAG', () => {
    const nodes = [
      createNode('A'),
      createNode('B'),
      createNode('C'),
      createNode('D'),
    ];
    const edges: WorkflowEdge[] = [
      { from: 'A', to: 'B' },
      { from: 'A', to: 'C' },
      { from: 'B', to: 'D' },
      { from: 'C', to: 'D' },
    ];

    const sorted = topologicalSort(nodes, edges);
    expect(sorted.indexOf('A')).toBeLessThan(sorted.indexOf('B'));
    expect(sorted.indexOf('A')).toBeLessThan(sorted.indexOf('C'));
    expect(sorted.indexOf('B')).toBeLessThan(sorted.indexOf('D'));
    expect(sorted.indexOf('C')).toBeLessThan(sorted.indexOf('D'));
  });

  it('returns all nodes', () => {
    const nodes = [createNode('A'), createNode('B'), createNode('C')];
    const edges: WorkflowEdge[] = [{ from: 'A', to: 'B' }];

    const sorted = topologicalSort(nodes, edges);
    expect(sorted.length).toBe(3);
    expect(sorted).toContain('A');
    expect(sorted).toContain('B');
    expect(sorted).toContain('C');
  });
});

describe('WorkflowEngine', () => {
  describe('execute', () => {
    it('runs nodes in correct dependency order', async () => {
      const executionOrder: string[] = [];

      const { engine } = createEngine(async (name) => {
        executionOrder.push(name);
        return {
          taskId: 'x',
          success: true,
          output: { result: name },
          duration: 10,
        };
      });

      const workflow = createWorkflow(
        [createNode('A'), createNode('B'), createNode('C')],
        [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
      );

      const result = await engine.execute(workflow);

      expect(result.success).toBe(true);
      expect(result.nodesCompleted).toBe(3);
      expect(result.nodesTotal).toBe(3);
      expect(executionOrder).toEqual(['A', 'B', 'C']);
    });

    it('runs independent nodes concurrently', async () => {
      const timestamps: Record<string, number> = {};

      const { engine } = createEngine(async (name) => {
        timestamps[`${name}_start`] = Date.now();
        // Small delay to simulate work
        await new Promise((r) => setTimeout(r, 50));
        timestamps[`${name}_end`] = Date.now();
        return {
          taskId: 'x',
          success: true,
          output: { result: name },
          duration: 50,
        };
      });

      // A and B are independent, C depends on both
      const workflow = createWorkflow(
        [createNode('A'), createNode('B'), createNode('C')],
        [
          { from: 'A', to: 'C' },
          { from: 'B', to: 'C' },
        ],
      );

      const result = await engine.execute(workflow);

      expect(result.success).toBe(true);
      expect(result.nodesCompleted).toBe(3);

      // A and B should start at approximately the same time (within 20ms)
      const startDiff = Math.abs(timestamps['A_start'] - timestamps['B_start']);
      expect(startDiff).toBeLessThan(20);

      // C should start after both A and B finish
      expect(timestamps['C_start']).toBeGreaterThanOrEqual(
        Math.max(timestamps['A_end'], timestamps['B_end']),
      );
    });

    it('handles conditional edges (condition=false skips node)', async () => {
      const executionOrder: string[] = [];

      const { engine } = createEngine(async (name) => {
        executionOrder.push(name);
        return {
          taskId: 'x',
          success: true,
          output: { result: name },
          duration: 10,
        };
      });

      // A → B with condition that evaluates to false
      const workflow = createWorkflow(
        [createNode('A'), createNode('B')],
        [{ from: 'A', to: 'B', condition: 'shouldContinue == true' }],
        { shouldContinue: false }, // condition will fail
      );

      const result = await engine.execute(workflow);

      expect(result.success).toBe(true);
      // A runs, B is skipped
      expect(executionOrder).toEqual(['A']);
    });

    it('passes context between nodes — output of A available to B', async () => {
      const receivedInputs: Record<string, unknown> = {};

      const { engine } = createEngine(async (name) => {
        return {
          taskId: 'x',
          success: true,
          output: { result: `output-from-${name}` },
          duration: 10,
        };
      });

      const workflow = createWorkflow(
        [createNode('A'), createNode('B')],
        [{ from: 'A', to: 'B' }],
      );

      const result = await engine.execute(workflow);

      expect(result.success).toBe(true);
      // After A completes, workflow.context.A should contain its output
      expect(workflow.context['A']).toEqual({ result: 'output-from-A' });
    });

    it('returns failure when DAG has cycle', async () => {
      const { engine } = createEngine();

      const workflow = createWorkflow(
        [createNode('A'), createNode('B')],
        [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'A' },
        ],
      );

      const result = await engine.execute(workflow);
      expect(result.success).toBe(false);
      expect(result.nodesCompleted).toBe(0);
    });

    it('handles node failure gracefully', async () => {
      const { engine } = createEngine(async (name) => {
        if (name === 'B') {
          return {
            taskId: 'x',
            success: false,
            output: {},
            error: 'B failed',
            duration: 10,
          };
        }
        return {
          taskId: 'x',
          success: true,
          output: { result: name },
          duration: 10,
        };
      });

      const workflow = createWorkflow(
        [createNode('A'), createNode('B'), createNode('C')],
        [
          { from: 'A', to: 'B' },
          { from: 'B', to: 'C' },
        ],
      );

      const result = await engine.execute(workflow);
      expect(result.success).toBe(false);
      // A completes, B fails, C is skipped
      expect(result.nodesCompleted).toBe(1);
    });
  });

  // ─── Cancel ─────────────────────────────────────────────────────

  describe('cancel', () => {
    it('stops pending nodes', async () => {
      const { engine } = createEngine(async (name) => {
        // A takes a while
        if (name === 'A') {
          await new Promise((r) => setTimeout(r, 200));
        }
        return {
          taskId: 'x',
          success: true,
          output: { result: name },
          duration: 10,
        };
      });

      const workflow = createWorkflow(
        [createNode('A'), createNode('B')],
        [{ from: 'A', to: 'B' }],
      );

      // Start execution but don't await yet
      const promise = engine.execute(workflow);

      // Cancel quickly
      await new Promise((r) => setTimeout(r, 20));
      engine.cancel('wf-1');

      const result = await promise;
      expect(result.success).toBe(false);
    });
  });

  // ─── getStatus ──────────────────────────────────────────────────

  describe('getStatus', () => {
    it('returns undefined for unknown workflow', () => {
      const { engine } = createEngine();
      expect(engine.getStatus('nonexistent')).toBeUndefined();
    });
  });
});
