import { EventEmitter } from 'eventemitter3';
import type {
  AgentConfig,
  AgentMessage,
  AgentStatus,
  Task,
  TaskResult,
} from '../core/types.js';
import type { MessageBus } from '../communication/message-bus.js';
import type { ConversationHistory } from '../memory/conversation-history.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentStats {
  tasksCompleted: number;
  tasksFailed: number;
  avgExecutionTime: number;
  errorRate: number;
}

// ─── Abstract Base Agent ────────────────────────────────────────────

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  status: AgentStatus = 'idle';
  currentTasks = new Map<string, Task>();

  protected config: AgentConfig;
  protected messageBus?: MessageBus;
  protected history?: ConversationHistory;
  protected emitter = new EventEmitter();

  private tasksCompleted = 0;
  private tasksFailed = 0;
  private totalExecutionTime = 0;

  constructor(config: AgentConfig) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.role = config.role;
  }

  abstract execute(task: Task): Promise<TaskResult>;

  canHandle(task: Task): boolean {
    return this.config.capabilities.some(
      (cap) =>
        cap.name === task.name ||
        task.description.toLowerCase().includes(cap.name.toLowerCase()),
    );
  }

  getLoad(): number {
    return this.currentTasks.size / this.config.maxConcurrentTasks;
  }

  assignTask(task: Task): void {
    this.currentTasks.set(task.id, task);
    if (this.currentTasks.size >= this.config.maxConcurrentTasks) {
      this.status = 'busy';
    }
  }

  completeTask(taskId: string, result: TaskResult): void {
    this.currentTasks.delete(taskId);
    this.tasksCompleted++;
    this.totalExecutionTime += result.duration;
    if (this.currentTasks.size < this.config.maxConcurrentTasks) {
      this.status = 'idle';
    }
  }

  failTask(taskId: string, _error: string): void {
    this.currentTasks.delete(taskId);
    this.tasksFailed++;
    if (this.currentTasks.size < this.config.maxConcurrentTasks) {
      this.status = 'idle';
    }
  }

  onMessage(_msg: AgentMessage): void {
    // Default no-op; subclasses can override
  }

  getStats(): AgentStats {
    const total = this.tasksCompleted + this.tasksFailed;
    return {
      tasksCompleted: this.tasksCompleted,
      tasksFailed: this.tasksFailed,
      avgExecutionTime:
        this.tasksCompleted > 0
          ? this.totalExecutionTime / this.tasksCompleted
          : 0,
      errorRate: total > 0 ? this.tasksFailed / total : 0,
    };
  }

  setMessageBus(bus: MessageBus): void {
    this.messageBus = bus;
  }

  setHistory(history: ConversationHistory): void {
    this.history = history;
  }
}
