import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersistenceLayer } from '../../src/memory/persistence.js';
import type { Task, AgentConfig, AgentMessage, AuditEntry } from '../../src/core/types.js';

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'test-task',
    description: 'A test task',
    priority: 'medium',
    status: 'pending',
    input: { query: 'hello' },
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 3 },
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

describe('PersistenceLayer', () => {
  let persistence: PersistenceLayer;

  beforeEach(() => {
    persistence = new PersistenceLayer(':memory:');
    persistence.initialize();
  });

  afterEach(() => {
    persistence.close();
  });

  // ─── Schema Initialization ──────────────────────────────────────

  describe('initialize', () => {
    it('creates all required tables', () => {
      // If we get here without error, tables were created
      // Verify by doing operations on each table
      const task = createTestTask();
      persistence.saveTask(task);
      expect(persistence.getTask('task-1')).not.toBeNull();

      persistence.saveAgent(
        { id: 'a1', name: 'test', role: 'r', systemPrompt: '', capabilities: [], maxConcurrentTasks: 1, model: 'm' },
        'idle',
      );
      expect(persistence.getAgent('a1')).not.toBeNull();

      const msg: AgentMessage = {
        id: 'msg-1',
        from: 'a1',
        to: 'a2',
        type: 'request',
        channel: 'test',
        payload: {},
        timestamp: new Date(),
      };
      persistence.saveMessage(msg);
      expect(persistence.getMessage('msg-1')).not.toBeNull();

      const cpId = persistence.saveCheckpoint('wf-1', { step: 1 });
      expect(cpId).toBeTruthy();

      persistence.appendAuditLog({
        eventType: 'test',
        data: { info: 'test' },
        timestamp: new Date(),
      });
      const logs = persistence.queryAuditLog({ eventType: 'test' });
      expect(logs.length).toBe(1);
    });
  });

  // ─── Tasks CRUD ─────────────────────────────────────────────────

  describe('tasks', () => {
    it('saveTask and getTask roundtrip', () => {
      const task = createTestTask();
      persistence.saveTask(task);

      const retrieved = persistence.getTask('task-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.name).toBe('test-task');
      expect(retrieved!.priority).toBe('medium');
      expect(retrieved!.createdAt).toBeInstanceOf(Date);
    });

    it('getTask returns null for missing task', () => {
      expect(persistence.getTask('nonexistent')).toBeNull();
    });

    it('updateTask persists changes', () => {
      const task = createTestTask();
      persistence.saveTask(task);

      task.status = 'completed';
      task.output = { result: 'done' };
      task.updatedAt = new Date('2025-01-02');
      persistence.updateTask(task);

      const retrieved = persistence.getTask('task-1')!;
      expect(retrieved.status).toBe('completed');
      expect(retrieved.output).toEqual({ result: 'done' });
    });

    it('listTasks with status filter', () => {
      persistence.saveTask(createTestTask({ id: 't1', status: 'pending' }));
      persistence.saveTask(createTestTask({ id: 't2', status: 'completed' }));
      persistence.saveTask(createTestTask({ id: 't3', status: 'pending' }));

      const pending = persistence.listTasks({ status: 'pending' });
      expect(pending.length).toBe(2);

      const completed = persistence.listTasks({ status: 'completed' });
      expect(completed.length).toBe(1);
    });

    it('deleteTask removes the task', () => {
      persistence.saveTask(createTestTask());
      expect(persistence.deleteTask('task-1')).toBe(true);
      expect(persistence.getTask('task-1')).toBeNull();
    });

    it('deleteTask returns false for missing task', () => {
      expect(persistence.deleteTask('nonexistent')).toBe(false);
    });
  });

  // ─── Checkpoints ────────────────────────────────────────────────

  describe('checkpoints', () => {
    it('saveCheckpoint and getLatestCheckpoint roundtrip', () => {
      persistence.saveCheckpoint('wf-1', { step: 1, data: 'first' });
      persistence.saveCheckpoint('wf-1', { step: 2, data: 'second' });

      const latest = persistence.getLatestCheckpoint('wf-1');
      expect(latest).not.toBeNull();
      expect(latest!.state).toEqual({ step: 2, data: 'second' });
      expect(latest!.workflowId).toBe('wf-1');
    });

    it('getLatestCheckpoint returns null for unknown workflow', () => {
      expect(persistence.getLatestCheckpoint('nonexistent')).toBeNull();
    });
  });

  // ─── Audit Log ──────────────────────────────────────────────────

  describe('audit log', () => {
    it('appendAuditLog and queryAuditLog roundtrip', () => {
      const entry: AuditEntry = {
        eventType: 'task:created',
        agentId: 'agent-1',
        taskId: 'task-1',
        data: { info: 'created a task' },
        timestamp: new Date('2025-01-01'),
      };
      persistence.appendAuditLog(entry);

      const logs = persistence.queryAuditLog({ eventType: 'task:created' });
      expect(logs.length).toBe(1);
      expect(logs[0].eventType).toBe('task:created');
      expect(logs[0].agentId).toBe('agent-1');
    });

    it('queryAuditLog filters by agentId', () => {
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-1',
        data: {},
        timestamp: new Date(),
      });
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-2',
        data: {},
        timestamp: new Date(),
      });

      const logs = persistence.queryAuditLog({ agentId: 'agent-1' });
      expect(logs.length).toBe(1);
    });

    it('queryAuditLog respects limit', () => {
      for (let i = 0; i < 5; i++) {
        persistence.appendAuditLog({
          eventType: 'event',
          data: { i },
          timestamp: new Date(),
        });
      }

      const logs = persistence.queryAuditLog({ limit: 3 });
      expect(logs.length).toBe(3);
    });

    it('stores workflowId in data column', () => {
      persistence.appendAuditLog({
        eventType: 'wf:started',
        workflowId: 'wf-1',
        data: { step: 'init' },
        timestamp: new Date(),
      });

      const logs = persistence.queryAuditLog({ eventType: 'wf:started' });
      expect(logs[0].workflowId).toBe('wf-1');
    });
  });

  // ─── Subtasks ────────────────────────────────────────────────────

  describe('getSubtasks', () => {
    it('returns subtasks matching parentId', () => {
      const parent = createTestTask({ id: 'parent-1' });
      const child1 = createTestTask({ id: 'child-1', parentId: 'parent-1', name: 'child-task-1' });
      const child2 = createTestTask({ id: 'child-2', parentId: 'parent-1', name: 'child-task-2' });
      const unrelated = createTestTask({ id: 'other-1', parentId: 'parent-2', name: 'other-task' });

      persistence.saveTask(parent);
      persistence.saveTask(child1);
      persistence.saveTask(child2);
      persistence.saveTask(unrelated);

      const subtasks = persistence.getSubtasks('parent-1');
      expect(subtasks.length).toBe(2);
      expect(subtasks.map((t) => t.id).sort()).toEqual(['child-1', 'child-2']);
    });

    it('returns empty array when no subtasks exist', () => {
      const subtasks = persistence.getSubtasks('nonexistent');
      expect(subtasks).toEqual([]);
    });
  });

  // ─── List Checkpoints ───────────────────────────────────────────

  describe('listCheckpoints', () => {
    it('returns all checkpoints when no filter', () => {
      persistence.saveCheckpoint('wf-1', { step: 1 });
      persistence.saveCheckpoint('wf-2', { step: 2 });
      persistence.saveCheckpoint('wf-1', { step: 3 });

      const all = persistence.listCheckpoints();
      expect(all.length).toBe(3);
    });

    it('filters by workflowId', () => {
      persistence.saveCheckpoint('wf-1', { step: 1 });
      persistence.saveCheckpoint('wf-2', { step: 2 });
      persistence.saveCheckpoint('wf-1', { step: 3 });

      const wf1 = persistence.listCheckpoints('wf-1');
      expect(wf1.length).toBe(2);
      expect(wf1.every((cp) => cp.workflowId === 'wf-1')).toBe(true);
    });

    it('returns correct checkpoint shape', () => {
      persistence.saveCheckpoint('wf-1', { step: 1 });

      const [cp] = persistence.listCheckpoints();
      expect(cp).toHaveProperty('id');
      expect(cp).toHaveProperty('workflowId', 'wf-1');
      expect(cp).toHaveProperty('state');
      expect(cp.state).toEqual({ step: 1 });
      expect(cp).toHaveProperty('createdAt');
    });

    it('returns empty array for unknown workflow', () => {
      expect(persistence.listCheckpoints('nonexistent')).toEqual([]);
    });
  });

  // ─── Task Timeline ──────────────────────────────────────────────

  describe('getTaskTimeline', () => {
    it('returns audit entries for a task sorted ascending', () => {
      persistence.appendAuditLog({
        eventType: 'task:completed',
        agentId: 'agent-1',
        taskId: 'task-1',
        data: { result: 'done' },
        timestamp: new Date('2025-01-02'),
      });
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-1',
        taskId: 'task-1',
        data: { info: 'started' },
        timestamp: new Date('2025-01-01'),
      });
      persistence.appendAuditLog({
        eventType: 'task:created',
        taskId: 'task-2',
        data: {},
        timestamp: new Date('2025-01-01'),
      });

      const timeline = persistence.getTaskTimeline('task-1');
      expect(timeline.length).toBe(2);
      expect(timeline[0].eventType).toBe('task:created');
      expect(timeline[1].eventType).toBe('task:completed');
      expect(timeline[0].timestamp.getTime()).toBeLessThanOrEqual(timeline[1].timestamp.getTime());
    });

    it('returns empty array for unknown task', () => {
      expect(persistence.getTaskTimeline('nonexistent')).toEqual([]);
    });
  });

  // ─── Agent Activity ─────────────────────────────────────────────

  describe('getAgentActivity', () => {
    it('returns all entries for an agent', () => {
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-1',
        data: { a: 1 },
        timestamp: new Date('2025-01-01'),
      });
      persistence.appendAuditLog({
        eventType: 'task:completed',
        agentId: 'agent-1',
        data: { a: 2 },
        timestamp: new Date('2025-01-02'),
      });
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-2',
        data: { a: 3 },
        timestamp: new Date('2025-01-01'),
      });

      const activity = persistence.getAgentActivity('agent-1');
      expect(activity.length).toBe(2);
    });

    it('filters by date range', () => {
      persistence.appendAuditLog({
        eventType: 'e1',
        agentId: 'agent-1',
        data: {},
        timestamp: new Date('2025-01-01'),
      });
      persistence.appendAuditLog({
        eventType: 'e2',
        agentId: 'agent-1',
        data: {},
        timestamp: new Date('2025-01-15'),
      });
      persistence.appendAuditLog({
        eventType: 'e3',
        agentId: 'agent-1',
        data: {},
        timestamp: new Date('2025-02-01'),
      });

      const activity = persistence.getAgentActivity(
        'agent-1',
        new Date('2025-01-10'),
        new Date('2025-01-20'),
      );
      expect(activity.length).toBe(1);
      expect(activity[0].eventType).toBe('e2');
    });

    it('returns empty array for unknown agent', () => {
      expect(persistence.getAgentActivity('nonexistent')).toEqual([]);
    });
  });

  // ─── Export CSV ─────────────────────────────────────────────────

  describe('exportCSV', () => {
    it('returns header row when no data', () => {
      const csv = persistence.exportCSV();
      expect(csv).toBe('timestamp,event_type,agent_id,task_id,data');
    });

    it('includes all entries with correct columns', () => {
      persistence.appendAuditLog({
        eventType: 'task:created',
        agentId: 'agent-1',
        taskId: 'task-1',
        data: { info: 'hello' },
        timestamp: new Date('2025-01-01T00:00:00.000Z'),
      });

      const csv = persistence.exportCSV();
      const lines = csv.split('\n');
      expect(lines.length).toBe(2);
      expect(lines[0]).toBe('timestamp,event_type,agent_id,task_id,data');
      expect(lines[1]).toContain('task:created');
      expect(lines[1]).toContain('agent-1');
      expect(lines[1]).toContain('task-1');
    });

    it('filters by eventType', () => {
      persistence.appendAuditLog({
        eventType: 'task:created',
        data: {},
        timestamp: new Date('2025-01-01'),
      });
      persistence.appendAuditLog({
        eventType: 'task:completed',
        data: {},
        timestamp: new Date('2025-01-02'),
      });

      const csv = persistence.exportCSV({ eventType: 'task:created' });
      const lines = csv.split('\n');
      expect(lines.length).toBe(2); // header + 1 row
    });

    it('handles empty agent_id and task_id', () => {
      persistence.appendAuditLog({
        eventType: 'system:boot',
        data: { version: '1.0' },
        timestamp: new Date('2025-01-01T00:00:00.000Z'),
      });

      const csv = persistence.exportCSV();
      const lines = csv.split('\n');
      // agent_id and task_id should be empty strings
      const dataLine = lines[1];
      expect(dataLine).toContain('system:boot');
      expect(dataLine).toContain(',,'); // empty agent_id followed by empty task_id
    });

    it('escapes double quotes in JSON data', () => {
      persistence.appendAuditLog({
        eventType: 'test',
        data: { msg: 'say "hello"' },
        timestamp: new Date('2025-01-01T00:00:00.000Z'),
      });

      const csv = persistence.exportCSV();
      // The JSON data is wrapped in double-quotes and inner quotes are doubled
      expect(csv).toContain('""msg""');
      expect(csv).toContain('hello');
    });
  });

  // ─── Close ──────────────────────────────────────────────────────

  describe('close', () => {
    it('closes without error', () => {
      expect(() => persistence.close()).not.toThrow();
    });
  });
});
