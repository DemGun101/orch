import { describe, it, expect, vi } from 'vitest';
import { TaskManager } from '../../src/core/task-manager.js';

describe('TaskManager', () => {
  // ─── createTask ─────────────────────────────────────────────────

  describe('createTask', () => {
    it('generates a UUID and sets defaults', () => {
      const tm = new TaskManager();
      const task = tm.createTask({ name: 'test-task' });

      expect(task.id).toBeTruthy();
      expect(task.id.length).toBe(36); // UUID v4 format
      expect(task.name).toBe('test-task');
      expect(task.status).toBe('pending');
      expect(task.priority).toBe('medium');
      expect(task.dependencies).toEqual([]);
      expect(task.subtasks).toEqual([]);
      expect(task.metadata.retryCount).toBe(0);
      expect(task.metadata.maxRetries).toBe(3);
      expect(task.createdAt).toBeInstanceOf(Date);
    });

    it('respects provided priority', () => {
      const tm = new TaskManager();
      const task = tm.createTask({ name: 'urgent', priority: 'critical' });

      expect(task.priority).toBe('critical');
    });

    it('rejects invalid input (missing name)', () => {
      const tm = new TaskManager();
      expect(() => tm.createTask({})).toThrow();
    });
  });

  // ─── Priority Ordering ──────────────────────────────────────────

  describe('priority ordering', () => {
    it('getNextTask returns highest priority first', () => {
      const tm = new TaskManager();

      const low = tm.createTask({ name: 'low', priority: 'low' });
      const critical = tm.createTask({ name: 'critical', priority: 'critical' });
      const medium = tm.createTask({ name: 'medium', priority: 'medium' });
      const high = tm.createTask({ name: 'high', priority: 'high' });

      tm.submitTask(low);
      tm.submitTask(critical);
      tm.submitTask(medium);
      tm.submitTask(high);

      expect(tm.getNextTask()?.priority).toBe('critical');
      expect(tm.getNextTask()?.priority).toBe('high');
      expect(tm.getNextTask()?.priority).toBe('medium');
      expect(tm.getNextTask()?.priority).toBe('low');
      expect(tm.getNextTask()).toBeUndefined();
    });

    it('same priority tasks return in FIFO order', () => {
      const tm = new TaskManager();

      const first = tm.createTask({ name: 'first', priority: 'medium' });
      const second = tm.createTask({ name: 'second', priority: 'medium' });
      const third = tm.createTask({ name: 'third', priority: 'medium' });

      tm.submitTask(first);
      tm.submitTask(second);
      tm.submitTask(third);

      expect(tm.getNextTask()?.name).toBe('first');
      expect(tm.getNextTask()?.name).toBe('second');
      expect(tm.getNextTask()?.name).toBe('third');
    });
  });

  // ─── Dependency Resolution ──────────────────────────────────────

  describe('dependency resolution', () => {
    it('task with unmet dependencies is NOT returned by getNextTask', () => {
      const tm = new TaskManager();

      const dep = tm.createTask({ name: 'dependency' });
      tm.submitTask(dep);

      const dependent = tm.createTask({
        name: 'dependent',
        dependencies: [dep.id],
      });
      tm.submitTask(dependent);

      // getNextTask should return the dependency first, not the dependent
      const next = tm.getNextTask();
      expect(next?.name).toBe('dependency');

      // Now only the dependent is in the queue, but deps not met
      const next2 = tm.getNextTask();
      expect(next2).toBeUndefined();
    });

    it('task IS returned once all dependencies are completed', () => {
      const tm = new TaskManager();

      const dep = tm.createTask({ name: 'dependency' });
      tm.submitTask(dep);

      const dependent = tm.createTask({
        name: 'dependent',
        dependencies: [dep.id],
      });
      tm.submitTask(dependent);

      // Complete the dependency
      tm.getNextTask(); // dequeue dep
      tm.updateStatus(dep.id, 'completed');

      // Now the dependent should be available
      const next = tm.getNextTask();
      expect(next?.name).toBe('dependent');
    });
  });

  // ─── Decompose ──────────────────────────────────────────────────

  describe('decompose', () => {
    it('creates subtasks with correct parentId', () => {
      const tm = new TaskManager();
      const parent = tm.createTask({ name: 'parent-task' });
      tm.submitTask(parent);

      const subtasks = tm.decompose(parent.id, [
        { name: 'sub-1' },
        { name: 'sub-2' },
      ]);

      expect(subtasks.length).toBe(2);
      expect(subtasks[0].parentId).toBe(parent.id);
      expect(subtasks[1].parentId).toBe(parent.id);
      expect(parent.subtasks).toContain(subtasks[0].id);
      expect(parent.subtasks).toContain(subtasks[1].id);
    });

    it('sets parent task to running status', () => {
      const tm = new TaskManager();
      const parent = tm.createTask({ name: 'parent-task' });
      tm.submitTask(parent);

      tm.decompose(parent.id, [{ name: 'sub-1' }]);

      const retrieved = tm.getTask(parent.id);
      expect(retrieved.status).toBe('running');
    });
  });

  // ─── Cancel ─────────────────────────────────────────────────────

  describe('cancelTask', () => {
    it('cancels a task', () => {
      const tm = new TaskManager();
      const task = tm.createTask({ name: 'to-cancel' });
      tm.submitTask(task);

      tm.cancelTask(task.id);
      expect(tm.getTask(task.id).status).toBe('cancelled');
    });

    it('cascades cancellation to subtasks', () => {
      const tm = new TaskManager();
      const parent = tm.createTask({ name: 'parent' });
      tm.submitTask(parent);

      const subtasks = tm.decompose(parent.id, [
        { name: 'sub-1' },
        { name: 'sub-2' },
      ]);

      tm.cancelTask(parent.id);

      expect(tm.getTask(subtasks[0].id).status).toBe('cancelled');
      expect(tm.getTask(subtasks[1].id).status).toBe('cancelled');
    });

    it('does not cancel already completed subtasks', () => {
      const tm = new TaskManager();
      const parent = tm.createTask({ name: 'parent' });
      tm.submitTask(parent);

      const subtasks = tm.decompose(parent.id, [
        { name: 'sub-1' },
        { name: 'sub-2' },
      ]);

      // Complete sub-1
      tm.updateStatus(subtasks[0].id, 'completed');

      tm.cancelTask(parent.id);

      expect(tm.getTask(subtasks[0].id).status).toBe('completed');
      expect(tm.getTask(subtasks[1].id).status).toBe('cancelled');
    });
  });

  // ─── onTaskComplete ─────────────────────────────────────────────

  describe('onTaskComplete', () => {
    it('marks parent complete when all subtasks done', () => {
      const tm = new TaskManager();
      const parent = tm.createTask({ name: 'parent' });
      tm.submitTask(parent);

      const subtasks = tm.decompose(parent.id, [
        { name: 'sub-1' },
        { name: 'sub-2' },
      ]);

      tm.updateStatus(subtasks[0].id, 'completed');
      tm.onTaskComplete(subtasks[0].id);
      // Parent should still be running (sub-2 not done)
      expect(tm.getTask(parent.id).status).toBe('running');

      tm.updateStatus(subtasks[1].id, 'completed');
      tm.onTaskComplete(subtasks[1].id);
      // Now parent should be completed
      expect(tm.getTask(parent.id).status).toBe('completed');
    });

    it('does nothing for tasks without parent', () => {
      const tm = new TaskManager();
      const task = tm.createTask({ name: 'orphan' });
      tm.submitTask(task);
      tm.updateStatus(task.id, 'completed');

      // Should not throw
      expect(() => tm.onTaskComplete(task.id)).not.toThrow();
    });
  });

  // ─── Events ─────────────────────────────────────────────────────

  describe('events', () => {
    it('emits task:created on submitTask', () => {
      const tm = new TaskManager();
      const handler = vi.fn();

      tm.on('task:created', handler);
      const task = tm.createTask({ name: 'event-test' });
      tm.submitTask(task);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('emits task:{status} on updateStatus', () => {
      const tm = new TaskManager();
      const handler = vi.fn();

      tm.on('task:completed', handler);
      const task = tm.createTask({ name: 'event-test' });
      tm.submitTask(task);
      tm.updateStatus(task.id, 'completed');

      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  // ─── Error Handling ─────────────────────────────────────────────

  describe('error handling', () => {
    it('getTask throws for unknown taskId', () => {
      const tm = new TaskManager();
      expect(() => tm.getTask('nonexistent')).toThrow('Task not found');
    });

    it('updateStatus throws for unknown taskId', () => {
      const tm = new TaskManager();
      expect(() => tm.updateStatus('nonexistent', 'completed')).toThrow(
        'Task not found',
      );
    });
  });

  // ─── getAllTasks ─────────────────────────────────────────────────

  describe('getAllTasks', () => {
    it('returns all tasks', () => {
      const tm = new TaskManager();
      const t1 = tm.createTask({ name: 't1' });
      const t2 = tm.createTask({ name: 't2' });
      tm.submitTask(t1);
      tm.submitTask(t2);

      expect(tm.getAllTasks().length).toBe(2);
    });
  });
});
