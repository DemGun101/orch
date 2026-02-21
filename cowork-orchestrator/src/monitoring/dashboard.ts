import type { MetricsCollector } from './metrics.js';
import { METRICS } from './metrics.js';
import type { AgentRegistry } from '../core/agent-registry.js';
import type { TaskManager } from '../core/task-manager.js';

// ─── ANSI Colors ───────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

// ─── Dashboard ─────────────────────────────────────────────────────

export class Dashboard {
  private metrics: MetricsCollector;
  private agentRegistry: AgentRegistry;
  private taskManager: TaskManager;
  private startedAt = Date.now();
  private liveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    metrics: MetricsCollector,
    agentRegistry: AgentRegistry,
    taskManager: TaskManager,
  ) {
    this.metrics = metrics;
    this.agentRegistry = agentRegistry;
    this.taskManager = taskManager;
  }

  render(): string {
    const lines: string[] = [];

    lines.push(this.renderHeader());
    lines.push('');
    lines.push(this.renderAgentsTable());
    lines.push('');
    lines.push(this.renderTaskQueue());
    lines.push('');
    lines.push(this.renderRecentActivity());
    lines.push('');
    lines.push(this.renderErrors());
    lines.push('');
    lines.push(this.renderApiUsage());

    return lines.join('\n');
  }

  startLive(interval = 2000): void {
    this.stopLive();
    this.liveTimer = setInterval(() => {
      process.stdout.write('\x1b[2J\x1b[H'); // clear screen + move cursor to top
      process.stdout.write(this.render() + '\n');
    }, interval);
  }

  stopLive(): void {
    if (this.liveTimer) {
      clearInterval(this.liveTimer);
      this.liveTimer = null;
    }
  }

  // ── Sections ────────────────────────────────────────────────────

  private renderHeader(): string {
    const uptime = this.formatDuration(Date.now() - this.startedAt);
    const status = `${C.green}Running${C.reset}`;
    return [
      `${C.cyan}${C.bold}╔══════════════════════════════════════════════════╗${C.reset}`,
      `${C.cyan}${C.bold}║          COWORK ORCHESTRATOR                     ║${C.reset}`,
      `${C.cyan}${C.bold}╚══════════════════════════════════════════════════╝${C.reset}`,
      `  Status: ${status}  │  Uptime: ${C.white}${uptime}${C.reset}`,
    ].join('\n');
  }

  private renderAgentsTable(): string {
    const agents = this.agentRegistry.getAll();
    const lines: string[] = [];

    lines.push(`${C.cyan}${C.bold}  Agents${C.reset}`);
    lines.push(`  ┌──────────────────────┬──────────┬──────┬────────────┐`);
    lines.push(`  │ Name                 │ Status   │ Load │ Tasks Done │`);
    lines.push(`  ├──────────────────────┼──────────┼──────┼────────────┤`);

    if (agents.length === 0) {
      lines.push(`  │ ${C.dim}(no agents)${C.reset}          │          │      │            │`);
    } else {
      for (const agent of agents) {
        const name = agent.name.slice(0, 20).padEnd(20);
        const statusColor = agent.status === 'idle' ? C.green : agent.status === 'busy' ? C.yellow : C.red;
        const status = `${statusColor}${agent.status.padEnd(8)}${C.reset}`;
        const load = `${Math.round(agent.getLoad() * 100)}%`.padStart(4);
        const done = String(agent.getStats().tasksCompleted).padStart(10);
        lines.push(`  │ ${name} │ ${status} │ ${load} │ ${done} │`);
      }
    }

    lines.push(`  └──────────────────────┴──────────┴──────┴────────────┘`);
    return lines.join('\n');
  }

  private renderTaskQueue(): string {
    const tasks = this.taskManager.getAllTasks();
    const pending = tasks.filter((t) => t.status === 'pending' || t.status === 'queued');
    const running = tasks.filter((t) => t.status === 'running');

    const byCritical = pending.filter((t) => t.priority === 'critical').length;
    const byHigh = pending.filter((t) => t.priority === 'high').length;
    const byMedium = pending.filter((t) => t.priority === 'medium').length;
    const byLow = pending.filter((t) => t.priority === 'low').length;

    const lines: string[] = [];
    lines.push(`${C.cyan}${C.bold}  Task Queue${C.reset}`);
    lines.push(`  Pending: ${C.red}Critical: ${byCritical}${C.reset}  ${C.yellow}High: ${byHigh}${C.reset}  Medium: ${byMedium}  ${C.dim}Low: ${byLow}${C.reset}`);
    lines.push(`  Running: ${C.green}${running.length}${C.reset}`);

    return lines.join('\n');
  }

  private renderRecentActivity(): string {
    const tasks = this.taskManager.getAllTasks();
    const completed = tasks
      .filter((t) => t.status === 'completed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 5);

    const lines: string[] = [];
    lines.push(`${C.cyan}${C.bold}  Recent Activity${C.reset}`);

    if (completed.length === 0) {
      lines.push(`  ${C.dim}(none)${C.reset}`);
    } else {
      for (const task of completed) {
        const dur = this.formatDuration(task.updatedAt.getTime() - task.createdAt.getTime());
        lines.push(`  ${C.green}✓${C.reset} ${task.name.slice(0, 35).padEnd(35)} ${C.dim}${dur}${C.reset}`);
      }
    }

    return lines.join('\n');
  }

  private renderErrors(): string {
    const tasks = this.taskManager.getAllTasks();
    const failed = tasks
      .filter((t) => t.status === 'failed')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 5);

    const lines: string[] = [];
    lines.push(`${C.cyan}${C.bold}  Errors${C.reset}`);

    if (failed.length === 0) {
      lines.push(`  ${C.dim}(none)${C.reset}`);
    } else {
      for (const task of failed) {
        const err = (task.output?.error as string)?.slice(0, 50) ?? 'Unknown error';
        lines.push(`  ${C.red}✗${C.reset} ${task.name.slice(0, 25).padEnd(25)} ${C.red}${err}${C.reset}`);
      }
    }

    return lines.join('\n');
  }

  private renderApiUsage(): string {
    const snapshot = this.metrics.getMetrics();
    const find = (name: string) => snapshot.find((m) => m.name === name);

    const requests = find(METRICS.API_REQUESTS)?.current ?? 0;
    const tokensIn = find(METRICS.API_TOKENS_IN)?.current ?? 0;
    const tokensOut = find(METRICS.API_TOKENS_OUT)?.current ?? 0;
    const errors = find(METRICS.API_ERRORS)?.current ?? 0;

    const lines: string[] = [];
    lines.push(`${C.cyan}${C.bold}  API Usage${C.reset}`);
    lines.push(`  Requests: ${requests}  │  Tokens In: ${tokensIn}  │  Tokens Out: ${tokensOut}  │  Errors: ${errors > 0 ? C.red : ''}${errors}${errors > 0 ? C.reset : ''}`);

    return lines.join('\n');
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = Math.floor(ms / 1000);
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remainSecs = secs % 60;
    if (mins < 60) return `${mins}m ${remainSecs}s`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `${hrs}h ${remainMins}m`;
  }
}
