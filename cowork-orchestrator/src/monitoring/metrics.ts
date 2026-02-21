// ─── Types ─────────────────────────────────────────────────────────

export interface DataPoint {
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

export interface MetricSummary {
  name: string;
  current: number;
  min: number;
  max: number;
  avg: number;
  count: number;
  labels: Record<string, string>;
}

export type MetricsSummary = MetricSummary[];

export interface MetricsConfig {
  retentionMs: number;
  granularityMs: number;
}

// ─── Built-in Metric Names ─────────────────────────────────────────

export const METRICS = {
  TASKS_TOTAL: 'tasks.total',
  TASKS_COMPLETED: 'tasks.completed',
  TASKS_FAILED: 'tasks.failed',
  TASKS_DURATION: 'tasks.duration_ms',
  AGENTS_ACTIVE: 'agents.active',
  AGENTS_UTILIZATION: 'agents.utilization',
  API_REQUESTS: 'api.requests',
  API_TOKENS_IN: 'api.tokens.input',
  API_TOKENS_OUT: 'api.tokens.output',
  API_LATENCY: 'api.latency_ms',
  API_ERRORS: 'api.errors',
  TOOLS_EXECUTIONS: 'tools.executions',
  TOOLS_ERRORS: 'tools.errors',
  TOOLS_DURATION: 'tools.duration_ms',
  WORKFLOW_EXECUTIONS: 'workflow.executions',
  WORKFLOW_DURATION: 'workflow.duration_ms',
  MESSAGES_SENT: 'messages.sent',
  MESSAGES_FAILED: 'messages.failed',
} as const;

// ─── Metrics Collector ─────────────────────────────────────────────

export class MetricsCollector {
  private data = new Map<string, DataPoint[]>();
  private config: MetricsConfig;

  constructor(config?: Partial<MetricsConfig>) {
    this.config = {
      retentionMs: config?.retentionMs ?? 3_600_000,
      granularityMs: config?.granularityMs ?? 10_000,
    };
  }

  record(metric: string, value: number, labels?: Record<string, string>): void {
    const points = this.data.get(metric) ?? [];
    points.push({ value, labels: labels ?? {}, timestamp: Date.now() });
    this.data.set(metric, points);
    this.prune(metric);
  }

  increment(metric: string, labels?: Record<string, string>): void {
    const points = this.data.get(metric);
    const current = points?.length ? points[points.length - 1].value : 0;
    this.record(metric, current + 1, labels);
  }

  startTimer(metric: string, labels?: Record<string, string>): () => void {
    const start = Date.now();
    return () => {
      this.record(metric, Date.now() - start, labels);
    };
  }

  getMetrics(): MetricsSummary {
    const summary: MetricsSummary = [];

    for (const [name, points] of this.data) {
      if (points.length === 0) continue;

      let min = Infinity;
      let max = -Infinity;
      let sum = 0;

      for (const p of points) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
        sum += p.value;
      }

      summary.push({
        name,
        current: points[points.length - 1].value,
        min,
        max,
        avg: sum / points.length,
        count: points.length,
        labels: points[points.length - 1].labels,
      });
    }

    return summary;
  }

  getTimeSeries(metric: string, duration: number): DataPoint[] {
    const points = this.data.get(metric) ?? [];
    const cutoff = Date.now() - duration;
    return points.filter((p) => p.timestamp >= cutoff);
  }

  reset(): void {
    this.data.clear();
  }

  private prune(metric: string): void {
    const points = this.data.get(metric);
    if (!points) return;
    const cutoff = Date.now() - this.config.retentionMs;
    const firstValid = points.findIndex((p) => p.timestamp >= cutoff);
    if (firstValid > 0) {
      points.splice(0, firstValid);
    }
  }
}
