import type {
  Task,
  TaskResult,
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  WorkflowResult,
} from './types.js';
import type { TaskManager } from './task-manager.js';
import type { AgentRegistry } from './agent-registry.js';
import type { PersistenceLayer } from '../memory/persistence.js';
import type { CheckpointManager } from '../resilience/checkpointing.js';

// ─── Types ──────────────────────────────────────────────────────────

type NodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

interface ActiveWorkflow {
  workflow: Workflow;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  nodeStatuses: Map<string, NodeStatus>;
  nodeOutputs: Map<string, TaskResult>;
  resolve?: (result: WorkflowResult) => void;
  reject?: (error: Error) => void;
}

// ─── DAG Helpers (exported for testing) ─────────────────────────────

export function validateDAG(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): { valid: boolean; error?: string } {
  const nodeIds = new Set(nodes.map((n) => n.id));

  // Validate edge references
  for (const edge of edges) {
    if (!nodeIds.has(edge.from)) {
      return { valid: false, error: `Edge references unknown source node: ${edge.from}` };
    }
    if (!nodeIds.has(edge.to)) {
      return { valid: false, error: `Edge references unknown target node: ${edge.to}` };
    }
  }

  // DFS-based cycle detection
  const adjacency = new Map<string, string[]>();
  for (const id of nodeIds) {
    adjacency.set(id, []);
  }
  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodeIds) {
    color.set(id, WHITE);
  }

  function dfs(nodeId: string): boolean {
    color.set(nodeId, GRAY);
    for (const neighbor of adjacency.get(nodeId)!) {
      if (color.get(neighbor) === GRAY) return true; // back edge = cycle
      if (color.get(neighbor) === WHITE && dfs(neighbor)) return true;
    }
    color.set(nodeId, BLACK);
    return false;
  }

  for (const id of nodeIds) {
    if (color.get(id) === WHITE && dfs(id)) {
      return { valid: false, error: 'Workflow contains a cycle' };
    }
  }

  return { valid: true };
}

export function topologicalSort(
  nodes: WorkflowNode[],
  edges: WorkflowEdge[],
): string[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const id of nodeIds) {
    inDegree.set(id, 0);
    adjacency.set(id, []);
  }

  for (const edge of edges) {
    adjacency.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  const sorted: string[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const neighbor of adjacency.get(current)!) {
      const newDeg = inDegree.get(neighbor)! - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return sorted;
}

// ─── Condition Evaluator ────────────────────────────────────────────

function evaluateCondition(
  condition: string,
  context: Record<string, unknown>,
): boolean {
  // Simple dot-path accessor with comparison operators
  // Supports: "path.to.value == expected", "path.to.value != expected",
  //           "path.to.value" (truthy check)
  const operators = ['===', '!==', '==', '!=', '>=', '<=', '>', '<'];
  let op: string | undefined;
  let parts: [string, string] | undefined;

  for (const operator of operators) {
    const idx = condition.indexOf(operator);
    if (idx !== -1) {
      op = operator;
      parts = [
        condition.slice(0, idx).trim(),
        condition.slice(idx + operator.length).trim(),
      ];
      break;
    }
  }

  if (!parts || !op) {
    // Truthy check on path
    return !!resolvePath(context, condition.trim());
  }

  const leftValue = resolvePath(context, parts[0]);
  let rightValue: unknown = parts[1];

  // Parse right side: booleans, numbers, quoted strings, null
  if (rightValue === 'true') rightValue = true;
  else if (rightValue === 'false') rightValue = false;
  else if (rightValue === 'null') rightValue = null;
  else if (/^-?\d+(\.\d+)?$/.test(parts[1])) rightValue = Number(parts[1]);
  else if (
    (parts[1].startsWith('"') && parts[1].endsWith('"')) ||
    (parts[1].startsWith("'") && parts[1].endsWith("'"))
  ) {
    rightValue = parts[1].slice(1, -1);
  }

  switch (op) {
    case '==':
    case '===':
      return leftValue === rightValue;
    case '!=':
    case '!==':
      return leftValue !== rightValue;
    case '>':
      return (leftValue as number) > (rightValue as number);
    case '<':
      return (leftValue as number) < (rightValue as number);
    case '>=':
      return (leftValue as number) >= (rightValue as number);
    case '<=':
      return (leftValue as number) <= (rightValue as number);
    default:
      return false;
  }
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = obj;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ─── Workflow Engine ────────────────────────────────────────────────

export class WorkflowEngine {
  private taskManager: TaskManager;
  private agentRegistry: AgentRegistry;
  private persistence?: PersistenceLayer;
  private checkpointManager?: CheckpointManager;
  private activeWorkflows = new Map<string, ActiveWorkflow>();

  constructor(
    taskManager: TaskManager,
    agentRegistry: AgentRegistry,
    persistence?: PersistenceLayer,
  ) {
    this.taskManager = taskManager;
    this.agentRegistry = agentRegistry;
    this.persistence = persistence;
  }

  setCheckpointManager(manager: CheckpointManager): void {
    this.checkpointManager = manager;
  }

  async execute(workflow: Workflow): Promise<WorkflowResult> {
    const startTime = Date.now();

    // Validate the DAG
    const validation = validateDAG(workflow.nodes, workflow.edges);
    if (!validation.valid) {
      return {
        workflowId: workflow.id,
        success: false,
        outputs: new Map(),
        duration: Date.now() - startTime,
        nodesCompleted: 0,
        nodesTotal: workflow.nodes.length,
      };
    }

    // Initialize active workflow state
    const nodeStatuses = new Map<string, NodeStatus>();
    const nodeOutputs = new Map<string, TaskResult>();
    for (const node of workflow.nodes) {
      nodeStatuses.set(node.id, 'pending');
    }

    const active: ActiveWorkflow = {
      workflow,
      status: 'running',
      nodeStatuses,
      nodeOutputs,
    };
    this.activeWorkflows.set(workflow.id, active);

    // Build adjacency for quick lookups
    const incomingEdges = new Map<string, WorkflowEdge[]>();
    for (const node of workflow.nodes) {
      incomingEdges.set(node.id, []);
    }
    for (const edge of workflow.edges) {
      incomingEdges.get(edge.to)!.push(edge);
    }

    // Execute the DAG
    return new Promise<WorkflowResult>((resolve) => {
      active.resolve = resolve;

      const processReadyNodes = () => {
        if (active.status === 'paused' || active.status === 'cancelled') return;

        // Phase 1: Resolve all skippable nodes (cascading)
        let madeProgress = true;
        while (madeProgress) {
          madeProgress = false;
          for (const node of workflow.nodes) {
            if (nodeStatuses.get(node.id) !== 'pending') continue;

            const incoming = incomingEdges.get(node.id)!;
            let shouldSkip = false;

            for (const edge of incoming) {
              const sourceStatus = nodeStatuses.get(edge.from)!;

              if (sourceStatus === 'failed' || sourceStatus === 'cancelled') {
                shouldSkip = true;
                break;
              }

              if (sourceStatus === 'completed' && edge.condition) {
                if (!evaluateCondition(edge.condition, workflow.context)) {
                  shouldSkip = true;
                  break;
                }
              }
            }

            if (shouldSkip) {
              nodeStatuses.set(node.id, 'skipped');
              madeProgress = true;
            }
          }
        }

        // Phase 2: Check for completion
        const statuses = Array.from(nodeStatuses.values());
        const hasFailure = statuses.some((s) => s === 'failed');
        const allDone = statuses.every(
          (s) => s === 'completed' || s === 'failed' || s === 'skipped' || s === 'cancelled',
        );

        if (allDone) {
          active.status = hasFailure ? 'failed' : 'completed';
          const nodesCompleted = statuses.filter((s) => s === 'completed').length;

          const result: WorkflowResult = {
            workflowId: workflow.id,
            success: !hasFailure,
            outputs: new Map(nodeOutputs),
            duration: Date.now() - startTime,
            nodesCompleted,
            nodesTotal: workflow.nodes.length,
          };

          this.activeWorkflows.delete(workflow.id);
          resolve(result);
          return;
        }

        // Phase 3: Find ready nodes (pending + all incoming edges satisfied)
        const readyNodes: WorkflowNode[] = [];
        for (const node of workflow.nodes) {
          if (nodeStatuses.get(node.id) !== 'pending') continue;

          const incoming = incomingEdges.get(node.id)!;
          const allSatisfied = incoming.every((edge) => {
            const s = nodeStatuses.get(edge.from)!;
            return s === 'completed' || s === 'skipped';
          });

          if (allSatisfied) {
            readyNodes.push(node);
          }
        }

        if (readyNodes.length === 0) return;

        // Execute ready nodes in parallel
        const nodePromises = readyNodes.map((node) => this.executeNode(node, active));
        Promise.all(nodePromises).then(() => {
          this.checkpoint(active);
          processReadyNodes();
        });
      };

      processReadyNodes();
    });
  }

  pause(workflowId: string): void {
    const active = this.activeWorkflows.get(workflowId);
    if (active && active.status === 'running') {
      active.status = 'paused';
    }
  }

  resume(workflowId: string): void {
    const active = this.activeWorkflows.get(workflowId);
    if (active && active.status === 'paused') {
      active.status = 'running';
      // Re-trigger processing by resolving ready nodes
      this.resumeExecution(active);
    }
  }

  getStatus(
    workflowId: string,
  ): { status: string; nodeStatuses: Record<string, NodeStatus> } | undefined {
    const active = this.activeWorkflows.get(workflowId);
    if (!active) return undefined;

    const nodeStatuses: Record<string, NodeStatus> = {};
    for (const [id, status] of active.nodeStatuses) {
      nodeStatuses[id] = status;
    }

    return { status: active.status, nodeStatuses };
  }

  cancel(workflowId: string): void {
    const active = this.activeWorkflows.get(workflowId);
    if (!active) return;

    active.status = 'cancelled';

    // Cancel all pending/running tasks
    for (const [nodeId, status] of active.nodeStatuses) {
      if (status === 'pending' || status === 'running') {
        active.nodeStatuses.set(nodeId, 'cancelled');
      }
    }

    // Resolve the workflow promise
    if (active.resolve) {
      const nodesCompleted = Array.from(active.nodeStatuses.values()).filter(
        (s) => s === 'completed',
      ).length;

      active.resolve({
        workflowId,
        success: false,
        outputs: new Map(active.nodeOutputs),
        duration: 0,
        nodesCompleted,
        nodesTotal: active.workflow.nodes.length,
      });
    }

    this.activeWorkflows.delete(workflowId);
  }

  // ─── Private ────────────────────────────────────────────────────────

  private async executeNode(
    node: WorkflowNode,
    active: ActiveWorkflow,
  ): Promise<void> {
    if (active.status !== 'running') return;

    active.nodeStatuses.set(node.id, 'running');

    // Create a real task from the node template
    const task = this.taskManager.createTask({
      name: node.taskTemplate.name,
      description: node.taskTemplate.description,
      priority: node.taskTemplate.priority,
      input: { ...node.taskTemplate.input, ...active.workflow.context },
      dependencies: node.taskTemplate.dependencies,
      timeout: node.taskTemplate.timeout,
    });
    this.taskManager.submitTask(task);
    this.taskManager.updateStatus(task.id, 'assigned');

    // Find the best agent
    const agent = this.agentRegistry.findBestMatch(task);
    if (!agent) {
      active.nodeStatuses.set(node.id, 'failed');
      active.nodeOutputs.set(node.id, {
        taskId: task.id,
        success: false,
        output: {},
        error: 'No agent available to handle this task',
        duration: 0,
      });
      this.taskManager.updateStatus(task.id, 'failed');
      return;
    }

    // Execute the task
    this.taskManager.updateStatus(task.id, 'running');
    agent.assignTask(task);

    try {
      const result = await agent.execute(task);
      agent.completeTask(task.id, result);

      if (result.success) {
        active.nodeStatuses.set(node.id, 'completed');
        active.nodeOutputs.set(node.id, result);
        this.taskManager.updateStatus(task.id, 'completed', result.output);
        // Pass output into workflow context
        active.workflow.context[node.id] = result.output;
      } else {
        active.nodeStatuses.set(node.id, 'failed');
        active.nodeOutputs.set(node.id, result);
        this.taskManager.updateStatus(task.id, 'failed');
      }
    } catch (error) {
      agent.failTask(task.id, error instanceof Error ? error.message : String(error));
      active.nodeStatuses.set(node.id, 'failed');
      active.nodeOutputs.set(node.id, {
        taskId: task.id,
        success: false,
        output: {},
        error: error instanceof Error ? error.message : String(error),
        duration: 0,
      });
      this.taskManager.updateStatus(task.id, 'failed');
    }
  }

  private checkpoint(active: ActiveWorkflow): void {
    if (this.checkpointManager) {
      const nodeOutputs: Record<string, TaskResult> = {};
      for (const [k, v] of active.nodeOutputs) {
        nodeOutputs[k] = v;
      }
      const nodeStatuses: Record<string, string> = {};
      for (const [k, v] of active.nodeStatuses) {
        nodeStatuses[k] = v;
      }

      this.checkpointManager.createCheckpoint(active.workflow.id, {
        nodeOutputs,
        nodeStatuses,
        context: active.workflow.context,
        conversationSnapshots: {},
        pendingTasks: [],
        timestamp: new Date(),
      });
      return;
    }

    if (!this.persistence) return;

    const state: Record<string, unknown> = {
      context: active.workflow.context,
      nodeStatuses: Object.fromEntries(active.nodeStatuses),
      nodeOutputs: Object.fromEntries(
        Array.from(active.nodeOutputs).map(([k, v]) => [k, v]),
      ),
      status: active.status,
    };

    this.persistence.saveCheckpoint(active.workflow.id, state);
  }

  private resumeExecution(active: ActiveWorkflow): void {
    // Build incoming edges map
    const incomingEdges = new Map<string, WorkflowEdge[]>();
    for (const node of active.workflow.nodes) {
      incomingEdges.set(node.id, []);
    }
    for (const edge of active.workflow.edges) {
      incomingEdges.get(edge.to)!.push(edge);
    }

    const processReadyNodes = () => {
      if (active.status !== 'running') return;

      // Phase 1: Resolve skippable nodes (cascading)
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;
        for (const node of active.workflow.nodes) {
          if (active.nodeStatuses.get(node.id) !== 'pending') continue;

          const incoming = incomingEdges.get(node.id)!;
          let shouldSkip = false;

          for (const edge of incoming) {
            const sourceStatus = active.nodeStatuses.get(edge.from)!;
            if (sourceStatus === 'failed' || sourceStatus === 'cancelled') {
              shouldSkip = true;
              break;
            }
            if (sourceStatus === 'completed' && edge.condition) {
              if (!evaluateCondition(edge.condition, active.workflow.context)) {
                shouldSkip = true;
                break;
              }
            }
          }

          if (shouldSkip) {
            active.nodeStatuses.set(node.id, 'skipped');
            madeProgress = true;
          }
        }
      }

      // Phase 2: Check for completion
      const statuses = Array.from(active.nodeStatuses.values());
      const hasFailure = statuses.some((s) => s === 'failed');
      const allDone = statuses.every(
        (s) => s === 'completed' || s === 'failed' || s === 'skipped' || s === 'cancelled',
      );

      if (allDone) {
        active.status = hasFailure ? 'failed' : 'completed';

        if (active.resolve) {
          active.resolve({
            workflowId: active.workflow.id,
            success: !hasFailure,
            outputs: new Map(active.nodeOutputs),
            duration: 0,
            nodesCompleted: statuses.filter((s) => s === 'completed').length,
            nodesTotal: active.workflow.nodes.length,
          });
        }
        this.activeWorkflows.delete(active.workflow.id);
        return;
      }

      // Phase 3: Find ready nodes
      const readyNodes: WorkflowNode[] = [];
      for (const node of active.workflow.nodes) {
        if (active.nodeStatuses.get(node.id) !== 'pending') continue;

        const incoming = incomingEdges.get(node.id)!;
        const allSatisfied = incoming.every((edge) => {
          const s = active.nodeStatuses.get(edge.from)!;
          return s === 'completed' || s === 'skipped';
        });

        if (allSatisfied) {
          readyNodes.push(node);
        }
      }

      if (readyNodes.length === 0) return;

      const nodePromises = readyNodes.map((node) => this.executeNode(node, active));
      Promise.all(nodePromises).then(() => {
        this.checkpoint(active);
        processReadyNodes();
      });
    };

    processReadyNodes();
  }
}
