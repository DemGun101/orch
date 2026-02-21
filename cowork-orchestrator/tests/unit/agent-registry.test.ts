import { describe, it, expect, vi } from 'vitest';
import { AgentRegistry } from '../../src/core/agent-registry.js';
import { MockAgent, createMockCapability } from '../fixtures/mock-agent.js';
import type { Task, TaskResult } from '../../src/core/types.js';

function createTestTask(name: string = 'general'): Task {
  return {
    id: 'task-1',
    name,
    description: 'A test task for general purpose',
    priority: 'medium',
    status: 'pending',
    input: {},
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 3 },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe('AgentRegistry', () => {
  // ─── Register / Unregister / Get ────────────────────────────────

  describe('register/unregister/get', () => {
    it('registers an agent and retrieves it', () => {
      const registry = new AgentRegistry();
      const agent = new MockAgent({ id: 'a1', name: 'Agent 1' });

      registry.register(agent);
      expect(registry.get('a1')).toBe(agent);
    });

    it('unregisters an agent', () => {
      const registry = new AgentRegistry();
      const agent = new MockAgent({ id: 'a1' });

      registry.register(agent);
      registry.unregister('a1');
      expect(registry.get('a1')).toBeUndefined();
    });

    it('get returns undefined for unknown agent', () => {
      const registry = new AgentRegistry();
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('getAll returns all registered agents', () => {
      const registry = new AgentRegistry();
      registry.register(new MockAgent({ id: 'a1' }));
      registry.register(new MockAgent({ id: 'a2' }));

      expect(registry.getAll().length).toBe(2);
    });
  });

  // ─── findByCapability ───────────────────────────────────────────

  describe('findByCapability', () => {
    it('returns agents with matching capability', () => {
      const registry = new AgentRegistry();
      registry.register(
        new MockAgent({ id: 'a1', capabilities: [createMockCapability('coding')] }),
      );
      registry.register(
        new MockAgent({ id: 'a2', capabilities: [createMockCapability('writing')] }),
      );
      registry.register(
        new MockAgent({ id: 'a3', capabilities: [createMockCapability('coding')] }),
      );

      const coders = registry.findByCapability('coding');
      expect(coders.length).toBe(2);
      expect(coders.map((a) => a.id).sort()).toEqual(['a1', 'a3']);
    });

    it('returns empty array when no match', () => {
      const registry = new AgentRegistry();
      registry.register(
        new MockAgent({ id: 'a1', capabilities: [createMockCapability('coding')] }),
      );

      expect(registry.findByCapability('dancing').length).toBe(0);
    });
  });

  // ─── findBestMatch ──────────────────────────────────────────────

  describe('findBestMatch', () => {
    it('prefers agents with matching capability', () => {
      const registry = new AgentRegistry();
      const noMatch = new MockAgent({
        id: 'no-match',
        capabilities: [createMockCapability('writing')],
      });
      const hasMatch = new MockAgent({
        id: 'has-match',
        capabilities: [createMockCapability('general')],
      });

      registry.register(noMatch);
      registry.register(hasMatch);

      const best = registry.findBestMatch(createTestTask('general'));
      expect(best?.id).toBe('has-match');
    });

    it('considers load when scoring agents', () => {
      const registry = new AgentRegistry();
      // Both match, but one is more loaded
      const idle = new MockAgent({
        id: 'idle',
        maxConcurrentTasks: 3,
        capabilities: [createMockCapability('general')],
      });
      const busy = new MockAgent({
        id: 'busy',
        maxConcurrentTasks: 3,
        capabilities: [createMockCapability('general')],
      });

      // Load up the busy agent
      const fakeTask = createTestTask();
      busy.assignTask({ ...fakeTask, id: 't1' });
      busy.assignTask({ ...fakeTask, id: 't2' });

      registry.register(idle);
      registry.register(busy);

      const best = registry.findBestMatch(createTestTask('general'));
      expect(best?.id).toBe('idle');
    });

    it('considers error rate when scoring agents', () => {
      const registry = new AgentRegistry();
      // Both match, both idle, but one has high error rate
      const reliable = new MockAgent({
        id: 'reliable',
        capabilities: [createMockCapability('general')],
      });
      const flaky = new MockAgent({
        id: 'flaky',
        capabilities: [createMockCapability('general')],
      });

      // Give flaky agent a bad track record
      const fakeTask = createTestTask();
      flaky.assignTask({ ...fakeTask, id: 'ft1' });
      flaky.failTask('ft1', 'error');
      flaky.assignTask({ ...fakeTask, id: 'ft2' });
      flaky.failTask('ft2', 'error');

      registry.register(reliable);
      registry.register(flaky);

      const best = registry.findBestMatch(createTestTask('general'));
      expect(best?.id).toBe('reliable');
    });

    it('returns undefined when no agents available', () => {
      const registry = new AgentRegistry();
      expect(registry.findBestMatch(createTestTask())).toBeUndefined();
    });
  });

  // ─── getAvailable ───────────────────────────────────────────────

  describe('getAvailable', () => {
    it('excludes offline agents', () => {
      const registry = new AgentRegistry();
      const online = new MockAgent({ id: 'online' });
      const offline = new MockAgent({ id: 'offline' });
      offline.status = 'offline';

      registry.register(online);
      registry.register(offline);

      const available = registry.getAvailable();
      expect(available.length).toBe(1);
      expect(available[0].id).toBe('online');
    });

    it('excludes overloaded agents', () => {
      const registry = new AgentRegistry();
      const idle = new MockAgent({ id: 'idle', maxConcurrentTasks: 1 });
      const full = new MockAgent({ id: 'full', maxConcurrentTasks: 1 });

      // Fill the agent to capacity
      full.assignTask(createTestTask());

      registry.register(idle);
      registry.register(full);

      const available = registry.getAvailable();
      expect(available.length).toBe(1);
      expect(available[0].id).toBe('idle');
    });
  });

  // ─── Metrics ────────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('returns correct aggregate metrics', () => {
      const registry = new AgentRegistry();
      const agent1 = new MockAgent({ id: 'a1' });
      const agent2 = new MockAgent({ id: 'a2' });

      // Give agent1 some completed tasks
      const fakeTask = createTestTask();
      agent1.assignTask({ ...fakeTask, id: 't1' });
      agent1.completeTask('t1', {
        taskId: 't1',
        success: true,
        output: {},
        duration: 100,
      });

      registry.register(agent1);
      registry.register(agent2);

      const metrics = registry.getMetrics();
      expect(metrics.totalAgents).toBe(2);
      expect(metrics.availableAgents).toBe(2);
      expect(metrics.totalTasksCompleted).toBe(1);
    });
  });

  // ─── Events ─────────────────────────────────────────────────────

  describe('events', () => {
    it('emits agent:registered event', () => {
      const registry = new AgentRegistry();
      const handler = vi.fn();

      registry.onAgentRegistered(handler);
      const agent = new MockAgent({ id: 'a1' });
      registry.register(agent);

      expect(handler).toHaveBeenCalledWith(agent);
    });

    it('emits agent:unregistered event', () => {
      const registry = new AgentRegistry();
      const handler = vi.fn();

      registry.onAgentUnregistered(handler);
      const agent = new MockAgent({ id: 'a1' });
      registry.register(agent);
      registry.unregister('a1');

      expect(handler).toHaveBeenCalledWith('a1');
    });
  });
});
