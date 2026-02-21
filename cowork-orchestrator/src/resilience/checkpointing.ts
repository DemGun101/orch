import type { PersistenceLayer, CheckpointData } from '../memory/persistence.js';
import type { TaskResult } from '../core/types.js';

// ─── Interfaces ─────────────────────────────────────────────────────

export interface WorkflowState {
  nodeOutputs: Record<string, TaskResult>;
  nodeStatuses: Record<string, string>;
  context: Record<string, unknown>;
  conversationSnapshots: Record<string, unknown[]>;
  pendingTasks: string[];
  timestamp: Date;
}

export interface RestorationPlan {
  skipNodes: string[];
  resumeNodes: string[];
  rerunNodes: string[];
  context: Record<string, unknown>;
}

export interface CheckpointInfo {
  id: string;
  workflowId: string;
  timestamp: Date;
  nodeCount: number;
}

// ─── Serialized Shape ───────────────────────────────────────────────

interface SerializedWorkflowState {
  nodeOutputs: Record<string, TaskResult>;
  nodeStatuses: Record<string, string>;
  context: Record<string, unknown>;
  conversationSnapshots: Record<string, unknown[]>;
  pendingTasks: string[];
  timestamp: string;
}

// ─── CheckpointManager ─────────────────────────────────────────────

export class CheckpointManager {
  private persistence: PersistenceLayer;

  constructor(persistence: PersistenceLayer) {
    this.persistence = persistence;
  }

  createCheckpoint(workflowId: string, state: WorkflowState): string {
    const serialized: Record<string, unknown> = {
      nodeOutputs: state.nodeOutputs,
      nodeStatuses: state.nodeStatuses,
      context: state.context,
      conversationSnapshots: state.conversationSnapshots,
      pendingTasks: state.pendingTasks,
      timestamp: state.timestamp.toISOString(),
    };

    return this.persistence.saveCheckpoint(workflowId, serialized);
  }

  getCheckpoint(checkpointId: string): WorkflowState | undefined {
    const all = this.persistence.listCheckpoints();
    const match = all.find((cp) => cp.id === checkpointId);
    if (!match) return undefined;
    return this.deserializeState(match);
  }

  getLatestCheckpoint(workflowId: string): WorkflowState | undefined {
    const checkpoint = this.persistence.getLatestCheckpoint(workflowId);
    if (!checkpoint) return undefined;
    return this.deserializeState(checkpoint);
  }

  restoreFromCheckpoint(checkpointId: string): RestorationPlan {
    const state = this.getCheckpoint(checkpointId);
    if (!state) {
      return { skipNodes: [], resumeNodes: [], rerunNodes: [], context: {} };
    }

    const skipNodes: string[] = [];
    const resumeNodes: string[] = [];
    const rerunNodes: string[] = [];

    for (const [nodeId, status] of Object.entries(state.nodeStatuses)) {
      switch (status) {
        case 'completed':
          skipNodes.push(nodeId);
          break;
        case 'running':
        case 'paused':
          resumeNodes.push(nodeId);
          break;
        default:
          rerunNodes.push(nodeId);
          break;
      }
    }

    return {
      skipNodes,
      resumeNodes,
      rerunNodes,
      context: { ...state.context },
    };
  }

  listCheckpoints(workflowId: string): CheckpointInfo[] {
    const checkpoints = this.persistence.listCheckpoints(workflowId);

    return checkpoints.map((cp) => {
      const raw = cp.state as unknown as SerializedWorkflowState;
      const nodeCount = raw.nodeStatuses
        ? Object.keys(raw.nodeStatuses).length
        : 0;

      return {
        id: cp.id,
        workflowId: cp.workflowId,
        timestamp: new Date(cp.createdAt),
        nodeCount,
      };
    });
  }

  pruneCheckpoints(_workflowId: string, _keepLast: number): void {
    // TODO: Implement once PersistenceLayer supports checkpoint deletion
  }

  private deserializeState(checkpoint: CheckpointData): WorkflowState {
    const raw = checkpoint.state as unknown as SerializedWorkflowState;

    return {
      nodeOutputs: raw.nodeOutputs ?? {},
      nodeStatuses: raw.nodeStatuses ?? {},
      context: raw.context ?? {},
      conversationSnapshots: raw.conversationSnapshots ?? {},
      pendingTasks: raw.pendingTasks ?? [],
      timestamp: new Date(raw.timestamp),
    };
  }
}
