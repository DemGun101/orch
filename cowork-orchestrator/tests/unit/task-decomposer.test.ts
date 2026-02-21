import { describe, it, expect } from 'vitest';
import { TaskDecomposer } from '../../src/intelligence/task-decomposer.js';
import { createMockOpenAI } from '../fixtures/mock-openai.js';
import type { Task, AgentCapability } from '../../src/core/types.js';
import { z } from 'zod';

// ─── Helpers ────────────────────────────────────────────────────────

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Build a landing page',
    description: 'Create a responsive landing page with hero section and CTA',
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

function createCapabilities(): AgentCapability[] {
  return [
    {
      name: 'research',
      description: 'Research topics and gather information',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    },
    {
      name: 'writing',
      description: 'Write content and documentation',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    },
    {
      name: 'review',
      description: 'Review and quality-check work',
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ result: z.string() }),
    },
  ];
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('TaskDecomposer', () => {
  // ─── decompose() ──────────────────────────────────────────────────

  describe('decompose', () => {
    it('returns correct subtask structure from mock response', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      const result = await decomposer.decompose(task, capabilities);

      expect(result.subtasks).toHaveLength(3);
      expect(result.reasoning).toBe(
        'Task broken into research, writing, and review phases.',
      );
      expect(result.parallelGroups).toHaveLength(3);

      // Each subtask should be a proper Task object
      for (const subtask of result.subtasks) {
        expect(subtask.id).toBeDefined();
        expect(subtask.parentId).toBe('task-1');
        expect(subtask.status).toBe('pending');
        expect(subtask.metadata).toEqual({ retryCount: 0, maxRetries: 3 });
      }

      // Check that names were assigned correctly
      const names = result.subtasks.map((s) => s.name);
      expect(names).toEqual(['Research', 'Write', 'Review']);
    });

    it('wires up dependencies from names to IDs', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      const result = await decomposer.decompose(task, capabilities);

      // Research has no dependencies
      expect(result.subtasks[0].dependencies).toEqual([]);

      // Write depends on Research (should be resolved to Research's ID)
      expect(result.subtasks[1].dependencies).toEqual([result.subtasks[0].id]);

      // Review depends on Write (should be resolved to Write's ID)
      expect(result.subtasks[2].dependencies).toEqual([result.subtasks[1].id]);
    });

    it('throws on malformed response (Zod validation)', async () => {
      const malformedResponse = new Map<string, unknown>([
        [
          'decompose_task',
          {
            subtasks: [
              {
                name: 'Bad Task',
                description: 'Missing fields',
                requiredCapability: 'research',
                priority: 'INVALID_PRIORITY',
                estimatedComplexity: 'moderate',
                dependencies: [],
              },
            ],
            reasoning: 'test',
            parallelGroups: [['Bad Task']],
          },
        ],
      ]);

      const { client } = createMockOpenAI(malformedResponse);
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      await expect(decomposer.decompose(task, capabilities)).rejects.toThrow();
    });
  });

  // ─── estimateComplexity() ─────────────────────────────────────────

  describe('estimateComplexity', () => {
    it('returns valid complexity level', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();

      const complexity = await decomposer.estimateComplexity(task);

      const validRatings = ['trivial', 'simple', 'moderate', 'complex', 'epic'];
      expect(validRatings).toContain(complexity);
    });

    it('defaults to moderate for unrecognized text', async () => {
      const { client, createSpy } = createMockOpenAI();
      // Override the text response to return gibberish
      createSpy.mockResolvedValueOnce({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'gemini-2.0-flash',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'not a real rating', refusal: null },
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      });

      const decomposer = new TaskDecomposer(client);
      const complexity = await decomposer.estimateComplexity(createTestTask());

      expect(complexity).toBe('moderate');
    });
  });

  // ─── suggestWorkflow() ────────────────────────────────────────────

  describe('suggestWorkflow', () => {
    it('returns valid Workflow object', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      const workflow = await decomposer.suggestWorkflow(task, capabilities);

      expect(workflow.id).toBeDefined();
      expect(workflow.name).toBe('Test Workflow');
      expect(workflow.description).toBe('A test workflow');
      expect(workflow.status).toBe('pending');
      expect(workflow.context).toEqual({});
      expect(workflow.nodes).toHaveLength(2);
      expect(workflow.edges).toHaveLength(1);
    });

    it('creates nodes with correct structure', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      const workflow = await decomposer.suggestWorkflow(task, capabilities);

      for (const node of workflow.nodes) {
        expect(node.id).toBeDefined();
        expect(node.taskTemplate.name).toBeDefined();
        expect(node.taskTemplate.description).toBeDefined();
        expect(node.agentSelector?.strategy).toBe('capability-match');
        expect(node.agentSelector?.requiredCapabilities).toBeDefined();
      }
    });

    it('resolves edges from node names to IDs', async () => {
      const { client } = createMockOpenAI();
      const decomposer = new TaskDecomposer(client);
      const task = createTestTask();
      const capabilities = createCapabilities();

      const workflow = await decomposer.suggestWorkflow(task, capabilities);

      const edge = workflow.edges[0];
      expect(edge.from).toBe(workflow.nodes[0].id);
      expect(edge.to).toBe(workflow.nodes[1].id);
    });
  });
});
