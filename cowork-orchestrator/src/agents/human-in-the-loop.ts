import type { AgentConfig, Task, TaskResult } from '../core/types.js';
import { BaseAgent } from './base-agent.js';

// ─── Types ──────────────────────────────────────────────────────────

interface PendingApproval {
  task: Task;
  resolve: (result: TaskResult) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Human-in-the-Loop Agent ────────────────────────────────────────

export class HumanInTheLoopAgent extends BaseAgent {
  private pendingApprovals = new Map<string, PendingApproval>();
  private approvalTimeout: number;

  constructor(config: AgentConfig, approvalTimeout: number = 300_000) {
    super(config);
    this.approvalTimeout = approvalTimeout;
  }

  async execute(task: Task): Promise<TaskResult> {
    const startTime = Date.now();

    return new Promise<TaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(task.id);
        resolve({
          taskId: task.id,
          success: false,
          output: {},
          error: 'Approval timed out',
          duration: Date.now() - startTime,
        });
      }, this.approvalTimeout);

      this.pendingApprovals.set(task.id, { task, resolve, reject, timer });

      this.emitter.emit('approval-needed', {
        taskId: task.id,
        taskName: task.name,
        description: task.description,
        priority: task.priority,
        input: task.input,
      });
    });
  }

  approve(taskId: string): void {
    const pending = this.pendingApprovals.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingApprovals.delete(taskId);

    pending.resolve({
      taskId,
      success: true,
      output: { approved: true, approvedBy: this.id },
      duration: 0,
    });
  }

  reject(taskId: string, reason: string): void {
    const pending = this.pendingApprovals.get(taskId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingApprovals.delete(taskId);

    pending.resolve({
      taskId,
      success: false,
      output: { approved: false, reason },
      error: reason,
      duration: 0,
    });
  }

  getPendingApprovals(): Task[] {
    return Array.from(this.pendingApprovals.values()).map((p) => p.task);
  }

  onApprovalNeeded(
    handler: (details: {
      taskId: string;
      taskName: string;
      description: string;
      priority: string;
      input: Record<string, unknown>;
    }) => void,
  ): () => void {
    this.emitter.on('approval-needed', handler);
    return () => this.emitter.off('approval-needed', handler);
  }
}
