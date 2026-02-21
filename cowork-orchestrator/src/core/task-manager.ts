import { EventEmitter } from 'eventemitter3';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import type { Task, TaskStatus, TaskPriority } from './types.js';
import type { PersistenceLayer } from '../memory/persistence.js';

// ─── Priority Ranking ───────────────────────────────────────────────

const PRIORITY_RANK: Record<TaskPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// ─── Validation Schema ──────────────────────────────────────────────

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;

const TaskInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  priority: z.string().default('medium').refine(
    (v): v is TaskPriority => (VALID_PRIORITIES as readonly string[]).includes(v),
    { message: 'Invalid priority' },
  ),
  input: z.record(z.string(), z.unknown()).default({}),
  dependencies: z.array(z.string()).default([]),
  parentId: z.string().optional(),
  timeout: z.number().positive().optional(),
  metadata: z
    .object({
      maxRetries: z.number().int().nonnegative().default(3),
      estimatedTokens: z.number().optional(),
    })
    .default({ maxRetries: 3 }),
});

// ─── Task Tree Node ─────────────────────────────────────────────────

export interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

// ─── Task Manager ───────────────────────────────────────────────────

export class TaskManager {
  private tasks = new Map<string, Task>();
  private queue: Task[] = [];
  private emitter = new EventEmitter();
  private persistence?: PersistenceLayer;

  constructor(persistence?: PersistenceLayer) {
    this.persistence = persistence;
  }

  createTask(input: Partial<Task>): Task {
    const validated = TaskInputSchema.parse(input);
    const now = new Date();

    const task: Task = {
      id: uuidv4(),
      name: validated.name,
      description: validated.description,
      priority: validated.priority as TaskPriority,
      status: 'pending',
      input: validated.input,
      dependencies: validated.dependencies,
      subtasks: [],
      parentId: validated.parentId,
      timeout: validated.timeout,
      metadata: {
        retryCount: 0,
        maxRetries: validated.metadata.maxRetries,
        estimatedTokens: validated.metadata.estimatedTokens,
      },
      createdAt: now,
      updatedAt: now,
    };

    return task;
  }

  submitTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.insertIntoQueue(task);
    this.persistence?.saveTask(task);
    this.emitter.emit('task:created', task);
  }

  getNextTask(): Task | undefined {
    for (let i = 0; i < this.queue.length; i++) {
      const task = this.queue[i];
      if (task.status === 'pending' && this.areDependenciesMet(task)) {
        this.queue.splice(i, 1);
        return task;
      }
    }
    return undefined;
  }

  updateStatus(
    taskId: string,
    status: TaskStatus,
    output?: Record<string, unknown>,
  ): void {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    task.status = status;
    task.updatedAt = new Date();
    if (output) task.output = output;

    this.persistence?.updateTask(task);
    this.emitter.emit(`task:${status}`, task);
  }

  getTask(taskId: string): Task {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }

  getSubtasks(parentId: string): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.parentId === parentId,
    );
  }

  decompose(taskId: string, subtaskInputs: Partial<Task>[]): Task[] {
    const parent = this.getTask(taskId);
    const subtasks: Task[] = [];

    for (const input of subtaskInputs) {
      const subtask = this.createTask({ ...input, parentId: taskId });
      subtasks.push(subtask);
      parent.subtasks.push(subtask.id);
      this.submitTask(subtask);
    }

    this.updateStatus(taskId, 'running');
    return subtasks;
  }

  cancelTask(taskId: string): void {
    this.updateStatus(taskId, 'cancelled');

    // Cascade: cancel all subtasks
    const subtasks = this.getSubtasks(taskId);
    for (const subtask of subtasks) {
      if (subtask.status !== 'completed' && subtask.status !== 'cancelled') {
        this.cancelTask(subtask.id);
      }
    }
  }

  getTaskTree(taskId: string): TaskTreeNode {
    const task = this.getTask(taskId);
    const children = this.getSubtasks(taskId).map((st) =>
      this.getTaskTree(st.id),
    );
    return { task, children };
  }

  onTaskComplete(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task.parentId) return;

    const siblings = this.getSubtasks(task.parentId);
    const allComplete = siblings.every((s) => s.status === 'completed');

    if (allComplete) {
      this.updateStatus(task.parentId, 'completed');
    }
  }

  areDependenciesMet(task: Task): boolean {
    return task.dependencies.every((depId) => {
      const dep = this.tasks.get(depId);
      return dep?.status === 'completed';
    });
  }

  getAllTasks(): Task[] {
    return Array.from(this.tasks.values());
  }

  // ─── Event Helpers ──────────────────────────────────────────────────

  on(event: string, handler: (...args: unknown[]) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  // ─── Private ────────────────────────────────────────────────────────

  private insertIntoQueue(task: Task): void {
    // Binary insert into sorted queue (priority rank asc, then createdAt asc)
    let low = 0;
    let high = this.queue.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.compareTasks(task, this.queue[mid]) < 0) {
        high = mid;
      } else {
        low = mid + 1;
      }
    }

    this.queue.splice(low, 0, task);
  }

  private compareTasks(a: Task, b: Task): number {
    const rankA = PRIORITY_RANK[a.priority];
    const rankB = PRIORITY_RANK[b.priority];
    if (rankA !== rankB) return rankA - rankB;
    return a.createdAt.getTime() - b.createdAt.getTime();
  }
}
