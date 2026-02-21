import { describe, it, expect, vi } from 'vitest';
import { ConflictResolver } from '../../src/intelligence/conflict-resolver.js';
import type { Conflict } from '../../src/intelligence/conflict-resolver.js';
import { createMockOpenAI } from '../fixtures/mock-openai.js';
import type { Task, TaskResult, AgentMessage } from '../../src/core/types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Summarize document',
    description: 'Create a summary of the provided document',
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

function createTaskResult(
  agentId: string,
  output: Record<string, unknown>,
  success = true,
): TaskResult {
  return {
    taskId: `task-${agentId}`,
    success,
    output,
    duration: 100,
  };
}

function createOutputs(
  entries: [string, Record<string, unknown>][],
): Map<string, TaskResult> {
  const map = new Map<string, TaskResult>();
  for (const [agentId, output] of entries) {
    map.set(agentId, createTaskResult(agentId, output));
  }
  return map;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ConflictResolver', () => {
  // ─── detectConflicts() ────────────────────────────────────────────

  describe('detectConflicts', () => {
    it('returns empty array when no conflicts (default response)', async () => {
      const { client } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const outputs = createOutputs([
        ['agent-1', { summary: 'Document is about AI' }],
        ['agent-2', { summary: 'Document discusses AI topics' }],
      ]);

      const conflicts = await resolver.detectConflicts(outputs);

      expect(conflicts).toEqual([]);
    });

    it('returns Conflict objects when conflicts detected', async () => {
      const responses = new Map<string, unknown>([
        [
          'detect_conflicts',
          {
            conflicts: [
              {
                type: 'contradiction',
                agentIds: ['agent-1', 'agent-2'],
                description: 'Agents disagree on the main topic',
                severity: 'high',
                suggestedResolution: 'Prefer the more detailed analysis',
              },
            ],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const resolver = new ConflictResolver(client);

      const outputs = createOutputs([
        ['agent-1', { topic: 'machine learning' }],
        ['agent-2', { topic: 'natural language processing' }],
      ]);

      const conflicts = await resolver.detectConflicts(outputs);

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe('contradiction');
      expect(conflicts[0].agentIds).toEqual(['agent-1', 'agent-2']);
      expect(conflicts[0].severity).toBe('high');
      expect(conflicts[0].description).toBe(
        'Agents disagree on the main topic',
      );
      expect(conflicts[0].suggestedResolution).toBe(
        'Prefer the more detailed analysis',
      );
    });

    it('returns empty array for fewer than 2 outputs', async () => {
      const { client, createSpy } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const singleOutput = createOutputs([
        ['agent-1', { result: 'ok' }],
      ]);
      const conflicts = await resolver.detectConflicts(singleOutput);

      expect(conflicts).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('returns empty array for empty map', async () => {
      const { client, createSpy } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const conflicts = await resolver.detectConflicts(new Map());

      expect(conflicts).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  // ─── resolve() ────────────────────────────────────────────────────

  describe('resolve', () => {
    it('returns MERGE strategy from mock response', async () => {
      const { client } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const conflict: Conflict = {
        type: 'overlap',
        agentIds: ['agent-1', 'agent-2'],
        description: 'Both agents produced similar summaries',
        severity: 'low',
        suggestedResolution: 'Merge the summaries',
      };

      const outputs = createOutputs([
        ['agent-1', { summary: 'Summary A' }],
        ['agent-2', { summary: 'Summary B' }],
      ]);

      const resolution = await resolver.resolve(conflict, outputs);

      expect(resolution.strategy).toBe('MERGE');
      expect(resolution.reasoning).toBe(
        'Combined best parts of both outputs',
      );
      expect(resolution.resolvedOutput).toEqual({ merged: true });
    });

    it('returns PREFER strategy when configured', async () => {
      const responses = new Map<string, unknown>([
        [
          'resolve_conflict',
          {
            strategy: 'PREFER',
            resolvedOutput: { chosen: 'agent-1-output' },
            reasoning: 'Agent 1 produced more detailed results',
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const resolver = new ConflictResolver(client);

      const conflict: Conflict = {
        type: 'contradiction',
        agentIds: ['agent-1', 'agent-2'],
        description: 'Contradicting results',
        severity: 'high',
        suggestedResolution: 'Pick better output',
      };

      const outputs = createOutputs([
        ['agent-1', { detail: 'high' }],
        ['agent-2', { detail: 'low' }],
      ]);

      const resolution = await resolver.resolve(conflict, outputs);

      expect(resolution.strategy).toBe('PREFER');
      expect(resolution.resolvedOutput).toEqual({ chosen: 'agent-1-output' });
    });

    it('publishes conflict-resolved event to message bus', async () => {
      const { client } = createMockOpenAI();
      const publishSpy = vi.fn();
      const mockBus = { publish: publishSpy } as any;
      const resolver = new ConflictResolver(client, mockBus);

      const conflict: Conflict = {
        type: 'overlap',
        agentIds: ['agent-1', 'agent-2'],
        description: 'Overlap detected',
        severity: 'low',
        suggestedResolution: 'Merge',
      };

      await resolver.resolve(conflict, createOutputs([
        ['agent-1', { a: 1 }],
        ['agent-2', { b: 2 }],
      ]));

      expect(publishSpy).toHaveBeenCalledTimes(1);
      const msg: AgentMessage = publishSpy.mock.calls[0][0];
      expect(msg.from).toBe('conflict-resolver');
      expect(msg.to).toBe('*');
      expect(msg.type).toBe('event');
      expect(msg.channel).toBe('system');
      expect((msg.payload as any).event).toBe('conflict-resolved');
    });
  });

  // ─── preventConflict() ────────────────────────────────────────────

  describe('preventConflict', () => {
    it('returns risk level and guardrails', async () => {
      const { client } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const tasks = [
        createTestTask({ id: 't1', name: 'Write intro' }),
        createTestTask({ id: 't2', name: 'Write conclusion' }),
      ];

      const prevention = await resolver.preventConflict(tasks);

      expect(prevention.riskLevel).toBe('low');
      expect(prevention.guardrails).toHaveLength(2);
      expect(prevention.guardrails).toContain('Use separate output directories');
      expect(prevention.guardrails).toContain('Avoid shared state');
    });

    it('returns none risk for single task without API call', async () => {
      const { client, createSpy } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const prevention = await resolver.preventConflict([createTestTask()]);

      expect(prevention.riskLevel).toBe('none');
      expect(prevention.guardrails).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('returns none risk for empty task list without API call', async () => {
      const { client, createSpy } = createMockOpenAI();
      const resolver = new ConflictResolver(client);

      const prevention = await resolver.preventConflict([]);

      expect(prevention.riskLevel).toBe('none');
      expect(prevention.guardrails).toEqual([]);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });
});
