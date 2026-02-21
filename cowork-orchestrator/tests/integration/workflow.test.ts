import { describe, it, expect } from 'vitest';
import { OrchestrationEngine } from '../../src/core/orchestrator.js';
import { createMockOpenAI } from '../fixtures/mock-openai.js';
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
): Workflow {
  return {
    id: 'wf-test',
    name: 'Integration Test Workflow',
    description: 'Workflow for integration testing',
    nodes,
    edges,
    status: 'pending',
    context: {},
  };
}

function createEngineWithMockAgents(
  executeFn?: (taskName: string) => Promise<TaskResult>,
): OrchestrationEngine {
  const { client } = createMockOpenAI();
  const engine = new OrchestrationEngine({ persistence: { enabled: false, dbPath: '' } });
  engine.setLLMClient(client);

  // Register agents directly via the registry using MockAgent
  const registry = engine.getAgentRegistry();

  const agent1 = new MockAgent(
    {
      id: 'agent-1',
      name: 'Agent 1',
      capabilities: [createMockCapability('general')],
      maxConcurrentTasks: 10,
    },
    executeFn
      ? async (task) => executeFn(task.name)
      : undefined,
  );

  const agent2 = new MockAgent(
    {
      id: 'agent-2',
      name: 'Agent 2',
      capabilities: [createMockCapability('general')],
      maxConcurrentTasks: 10,
    },
    executeFn
      ? async (task) => executeFn(task.name)
      : undefined,
  );

  registry.register(agent1);
  registry.register(agent2);

  return engine;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Workflow Integration', () => {
  it('complete workflow executes all nodes in order', async () => {
    const executionOrder: string[] = [];

    const engine = createEngineWithMockAgents(async (name) => {
      executionOrder.push(name);
      return {
        taskId: 'x',
        success: true,
        output: { result: name },
        duration: 10,
      };
    });

    await engine.start();

    const workflow = createWorkflow(
      [createNode('A'), createNode('B'), createNode('C')],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
      ],
    );

    const result = await engine.executeWorkflow(workflow);

    expect(result.success).toBe(true);
    expect(result.nodesCompleted).toBe(3);
    expect(result.nodesTotal).toBe(3);
    expect(executionOrder).toEqual(['A', 'B', 'C']);

    // Verify results are captured for each node
    expect(result.outputs.size).toBe(3);
    expect(result.outputs.get('A')?.success).toBe(true);
    expect(result.outputs.get('B')?.success).toBe(true);
    expect(result.outputs.get('C')?.success).toBe(true);

    await engine.stop();
  });

  it('parallel nodes execute concurrently', async () => {
    const timestamps: Record<string, number> = {};

    const engine = createEngineWithMockAgents(async (name) => {
      timestamps[`${name}_start`] = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      timestamps[`${name}_end`] = Date.now();
      return {
        taskId: 'x',
        success: true,
        output: { result: name },
        duration: 50,
      };
    });

    await engine.start();

    // A → [B, C] → D
    const workflow = createWorkflow(
      [createNode('A'), createNode('B'), createNode('C'), createNode('D')],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'D' },
      ],
    );

    const result = await engine.executeWorkflow(workflow);

    expect(result.success).toBe(true);
    expect(result.nodesCompleted).toBe(4);

    // B and C should start at approximately the same time (after A)
    expect(timestamps['B_start']).toBeDefined();
    expect(timestamps['C_start']).toBeDefined();
    const bcStartDiff = Math.abs(timestamps['B_start'] - timestamps['C_start']);
    expect(bcStartDiff).toBeLessThan(30);

    // D should start after both B and C finish
    expect(timestamps['D_start']).toBeGreaterThanOrEqual(
      Math.max(timestamps['B_end'], timestamps['C_end']),
    );

    await engine.stop();
  });

  it('workflow with checkpoint saves state after phases', async () => {
    const executionOrder: string[] = [];

    const engine = createEngineWithMockAgents(async (name) => {
      executionOrder.push(name);
      if (name === 'C') {
        return {
          taskId: 'x',
          success: false,
          output: {},
          error: 'Node C failed',
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

    await engine.start();

    const workflow = createWorkflow(
      [createNode('A'), createNode('B'), createNode('C'), createNode('D')],
      [
        { from: 'A', to: 'B' },
        { from: 'B', to: 'C' },
        { from: 'C', to: 'D' },
      ],
    );

    const result = await engine.executeWorkflow(workflow);

    // A and B succeeded, C failed, D was skipped
    expect(result.success).toBe(false);
    expect(result.nodesCompleted).toBe(2); // A and B
    expect(executionOrder).toContain('A');
    expect(executionOrder).toContain('B');
    expect(executionOrder).toContain('C');
    expect(executionOrder).not.toContain('D');

    await engine.stop();
  });

  it('conflict detection in parallel nodes with different outputs', async () => {
    const engine = createEngineWithMockAgents(async (name) => {
      // B and C produce different outputs (potential conflict)
      return {
        taskId: 'x',
        success: true,
        output: { result: `output-from-${name}`, answer: name === 'B' ? 'yes' : 'no' },
        duration: 10,
      };
    });

    await engine.start();

    // A → [B, C] (parallel with potentially conflicting outputs)
    const workflow = createWorkflow(
      [createNode('A'), createNode('B'), createNode('C')],
      [
        { from: 'A', to: 'B' },
        { from: 'A', to: 'C' },
      ],
    );

    const result = await engine.executeWorkflow(workflow);

    expect(result.success).toBe(true);
    expect(result.nodesCompleted).toBe(3);

    // Both B and C should have completed with different outputs
    const bOutput = result.outputs.get('B')?.output as Record<string, unknown>;
    const cOutput = result.outputs.get('C')?.output as Record<string, unknown>;
    expect(bOutput.answer).toBe('yes');
    expect(cOutput.answer).toBe('no');

    await engine.stop();
  });
});
