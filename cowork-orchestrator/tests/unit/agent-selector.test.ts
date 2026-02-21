import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentSelector } from '../../src/intelligence/agent-selector.js';
import { createMockOpenAI } from '../fixtures/mock-openai.js';
import { MockAgent, createMockCapability } from '../fixtures/mock-agent.js';
import type { Task, Workflow, WorkflowNode } from '../../src/core/types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Code review',
    description: 'Review the authentication module code',
    priority: 'high',
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

function createCandidates() {
  return [
    new MockAgent({
      id: 'agent-1',
      name: 'Coder',
      role: 'developer',
      capabilities: [createMockCapability('coding', 'Write and review code')],
    }),
    new MockAgent({
      id: 'agent-2',
      name: 'Writer',
      role: 'writer',
      capabilities: [createMockCapability('writing', 'Write documentation')],
    }),
  ];
}

function createTestWorkflow(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: 'node-1',
      taskTemplate: {
        name: 'Research',
        description: 'Research the topic',
        priority: 'high',
        input: {},
        dependencies: [],
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 3 },
      },
      agentSelector: {
        strategy: 'capability-match',
        requiredCapabilities: ['research'],
      },
    },
    {
      id: 'node-2',
      taskTemplate: {
        name: 'Write',
        description: 'Write the content',
        priority: 'medium',
        input: {},
        dependencies: [],
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 3 },
      },
      agentSelector: {
        strategy: 'capability-match',
        requiredCapabilities: ['writing'],
      },
    },
  ];

  return {
    id: 'wf-1',
    name: 'Test Workflow',
    description: 'A test workflow',
    nodes,
    edges: [{ from: 'node-1', to: 'node-2' }],
    status: 'pending',
    context: {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('AgentSelector', () => {
  // ─── selectAgent() ────────────────────────────────────────────────

  describe('selectAgent', () => {
    it('returns correct agent from mock response', async () => {
      const responses = new Map<string, unknown>([
        [
          'select_agent',
          {
            selectedAgentId: 'agent-1',
            reasoning: 'Best capability match',
            confidence: 0.85,
            alternativeId: 'agent-2',
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);
      const candidates = createCandidates();

      const result = await selector.selectAgent(createTestTask(), candidates);

      expect(result.selectedAgentId).toBe('agent-1');
      expect(result.reasoning).toBe('Best capability match');
      expect(result.confidence).toBe(0.85);
      expect(result.alternativeId).toBe('agent-2');
      expect(result.needsHumanReview).toBe(false); // confidence >= 0.5
    });

    it('returns single candidate without API call', async () => {
      const { client, createSpy } = createMockOpenAI();
      const selector = new AgentSelector(client);
      const single = [createCandidates()[0]];

      const result = await selector.selectAgent(createTestTask(), single);

      expect(result.selectedAgentId).toBe('agent-1');
      expect(result.confidence).toBe(1);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('returns empty result for no candidates', async () => {
      const { client, createSpy } = createMockOpenAI();
      const selector = new AgentSelector(client);

      const result = await selector.selectAgent(createTestTask(), []);

      expect(result.selectedAgentId).toBe('');
      expect(result.confidence).toBe(0);
      expect(result.needsHumanReview).toBe(true);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('flags low-confidence results for human review', async () => {
      const responses = new Map<string, unknown>([
        [
          'select_agent',
          {
            selectedAgentId: 'agent-1',
            reasoning: 'Uncertain match',
            confidence: 0.3,
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);

      const result = await selector.selectAgent(
        createTestTask(),
        createCandidates(),
      );

      expect(result.needsHumanReview).toBe(true);
    });
  });

  // ─── rankAgents() ─────────────────────────────────────────────────

  describe('rankAgents', () => {
    it('returns sorted list', async () => {
      const responses = new Map<string, unknown>([
        [
          'rank_agents',
          {
            rankings: [
              { agentId: 'agent-2', score: 70, reasoning: 'Decent match' },
              { agentId: 'agent-1', score: 90, reasoning: 'Best match' },
            ],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);

      const ranked = await selector.rankAgents(
        createTestTask(),
        createCandidates(),
      );

      expect(ranked).toHaveLength(2);
      // Should be sorted descending by score
      expect(ranked[0].agentId).toBe('agent-1');
      expect(ranked[0].score).toBe(90);
      expect(ranked[1].agentId).toBe('agent-2');
      expect(ranked[1].score).toBe(70);
    });

    it('returns empty array for no candidates', async () => {
      const { client } = createMockOpenAI();
      const selector = new AgentSelector(client);

      const ranked = await selector.rankAgents(createTestTask(), []);

      expect(ranked).toEqual([]);
    });
  });

  // ─── suggestTeam() ────────────────────────────────────────────────

  describe('suggestTeam', () => {
    it('assigns agents to all workflow nodes', async () => {
      const responses = new Map<string, unknown>([
        [
          'suggest_team',
          {
            assignments: [
              {
                nodeId: 'node-1',
                agentId: 'agent-1',
                reasoning: 'Best for research',
              },
              {
                nodeId: 'node-2',
                agentId: 'agent-2',
                reasoning: 'Best for writing',
              },
            ],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);
      const workflow = createTestWorkflow();
      const agents = createCandidates();

      const assignments = await selector.suggestTeam(workflow, agents);

      expect(assignments).toHaveLength(2);
      expect(assignments[0].nodeId).toBe('node-1');
      expect(assignments[0].agentId).toBe('agent-1');
      expect(assignments[1].nodeId).toBe('node-2');
      expect(assignments[1].agentId).toBe('agent-2');
    });

    it('returns empty for no agents or no nodes', async () => {
      const { client } = createMockOpenAI();
      const selector = new AgentSelector(client);

      expect(await selector.suggestTeam(createTestWorkflow(), [])).toEqual([]);
      expect(
        await selector.suggestTeam(
          { ...createTestWorkflow(), nodes: [] },
          createCandidates(),
        ),
      ).toEqual([]);
    });
  });

  // ─── LRU Cache ────────────────────────────────────────────────────

  describe('cache', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns cached result on second call without API call', async () => {
      const responses = new Map<string, unknown>([
        [
          'select_agent',
          {
            selectedAgentId: 'agent-1',
            reasoning: 'Cached result',
            confidence: 0.85,
          },
        ],
      ]);
      const { client, createSpy } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);
      const task = createTestTask();
      const candidates = createCandidates();

      // First call — hits API
      const result1 = await selector.selectAgent(task, candidates);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Second call — should use cache
      const result2 = await selector.selectAgent(task, candidates);
      expect(createSpy).toHaveBeenCalledTimes(1); // no new call
      expect(result2).toEqual(result1);
      expect(selector.cacheSize).toBe(1);
    });

    it('makes new API call after TTL expires', async () => {
      const responses = new Map<string, unknown>([
        [
          'select_agent',
          {
            selectedAgentId: 'agent-1',
            reasoning: 'Fresh result',
            confidence: 0.85,
          },
        ],
      ]);
      const { client, createSpy } = createMockOpenAI(responses);
      const selector = new AgentSelector(client);
      const task = createTestTask();
      const candidates = createCandidates();

      // First call
      await selector.selectAgent(task, candidates);
      expect(createSpy).toHaveBeenCalledTimes(1);

      // Advance past 5-minute TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Second call — cache expired, new API call
      await selector.selectAgent(task, candidates);
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
  });
});
