import type { AuditEntry } from '../core/types.js';
import type { PersistenceLayer } from '../memory/persistence.js';

// ─── Event Type Constants ──────────────────────────────────────────

export const AUDIT_EVENTS = {
  TASK_CREATED: 'TASK_CREATED',
  TASK_ASSIGNED: 'TASK_ASSIGNED',
  TASK_COMPLETED: 'TASK_COMPLETED',
  TASK_FAILED: 'TASK_FAILED',
  AGENT_REGISTERED: 'AGENT_REGISTERED',
  TOOL_EXECUTED: 'TOOL_EXECUTED',
  WORKFLOW_STARTED: 'WORKFLOW_STARTED',
  WORKFLOW_COMPLETED: 'WORKFLOW_COMPLETED',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  CONFLICT_RESOLVED: 'CONFLICT_RESOLVED',
  QUALITY_CHECK: 'QUALITY_CHECK',
  HUMAN_APPROVAL: 'HUMAN_APPROVAL',
  ERROR: 'ERROR',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
} as const;

// ─── Filter Types ──────────────────────────────────────────────────

export interface AuditQueryFilter {
  eventType?: string;
  agentId?: string;
  taskId?: string;
  workflowId?: string;
  startTime?: Date;
  endTime?: Date;
}

// ─── Audit Logger ──────────────────────────────────────────────────

export class AuditLogger {
  private persistence: PersistenceLayer;

  constructor(persistence: PersistenceLayer) {
    this.persistence = persistence;
  }

  log(entry: AuditEntry): void {
    if (!entry.timestamp) {
      entry.timestamp = new Date();
    }
    this.persistence.appendAuditLog(entry);
  }

  query(filter?: AuditQueryFilter): AuditEntry[] {
    return this.persistence.queryAuditLog(
      filter
        ? {
            eventType: filter.eventType,
            agentId: filter.agentId,
            taskId: filter.taskId,
            from: filter.startTime,
            to: filter.endTime,
          }
        : undefined,
    );
  }

  getTaskTimeline(taskId: string): AuditEntry[] {
    return this.persistence.getTaskTimeline(taskId);
  }

  getAgentActivity(agentId: string, timeRange?: { start: Date; end: Date }): AuditEntry[] {
    return this.persistence.getAgentActivity(agentId, timeRange?.start, timeRange?.end);
  }

  exportCSV(filter?: AuditQueryFilter): string {
    return this.persistence.exportCSV(
      filter
        ? {
            eventType: filter.eventType,
            agentId: filter.agentId,
            taskId: filter.taskId,
            from: filter.startTime,
            to: filter.endTime,
          }
        : undefined,
    );
  }
}
