// ─── Task Status Lifecycle ───────────────────────────────────────────
export type TaskStatus =
  | 'pending'
  | 'queued'
  | 'assigned'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

// ─── Task Priority ───────────────────────────────────────────────────
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

// ─── Task Metadata ───────────────────────────────────────────────────
export interface TaskMetadata {
  estimatedTokens?: number;
  actualTokens?: number;
  retryCount: number;
  maxRetries: number;
  checkpointId?: string;
}

// ─── Task Definition ─────────────────────────────────────────────────
export interface Task {
  id: string;
  parentId?: string;
  name: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgentId?: string;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  dependencies: string[];
  subtasks: string[];
  metadata: TaskMetadata;
  createdAt: Date;
  updatedAt: Date;
  timeout?: number;
}

// ─── Task Result ─────────────────────────────────────────────────────
export interface TaskResult {
  taskId: string;
  success: boolean;
  output: Record<string, unknown>;
  error?: string;
  tokenUsage?: { input: number; output: number };
  duration: number;
}

// ─── Workflow Edge ───────────────────────────────────────────────────
export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

// ─── Workflow Node ───────────────────────────────────────────────────
export interface WorkflowNode {
  id: string;
  taskTemplate: Omit<Task, 'id' | 'status' | 'createdAt' | 'updatedAt'>;
}

// ─── Workflow Definition (DAG) ───────────────────────────────────────
export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  status: TaskStatus;
  context: Record<string, unknown>;
}

// ─── Workflow Result ─────────────────────────────────────────────────
export interface WorkflowResult {
  workflowId: string;
  success: boolean;
  outputs: Map<string, TaskResult>;
  duration: number;
  nodesCompleted: number;
  nodesTotal: number;
}

// ─── Audit Log Entry ─────────────────────────────────────────────────
export interface AuditEntry {
  eventType: string;
  agentId?: string;
  taskId?: string;
  workflowId?: string;
  data: Record<string, unknown>;
  timestamp: Date;
}

// ─── Model Tier ──────────────────────────────────────────────────────
export type ModelTier = 'haiku' | 'sonnet' | 'opus';

// ─── Plan Node (lead agent output) ──────────────────────────────────
export interface PlanNode {
  id: string;
  name: string;
  description: string;
  /** Glob patterns for files this agent owns (can write to) */
  ownedPaths: string[];
  /** IDs of nodes this depends on */
  dependsOn: string[];
  /** Model tier override (default: sonnet) */
  modelTier?: ModelTier;
  /** Whether this is a test node (triggers feedback loop on failure) */
  isTest?: boolean;
  /** Priority */
  priority?: TaskPriority;
}

// ─── Plan (lead agent output) ────────────────────────────────────────
export interface Plan {
  nodes: PlanNode[];
  summary: string;
}

// ─── Cowork Agent Definition ─────────────────────────────────────────
// Represents the configuration for a single SDK query() call
export interface CoworkAgentDef {
  id: string;
  name: string;
  prompt: string;
  systemPrompt: string;
  model: string;
  ownedPaths: string[];
  /** Tools allowed for this agent. undefined = all tools */
  tools?: string[];
  /** Max turns for the SDK query */
  maxTurns?: number;
}

// ─── SDK Node Result ─────────────────────────────────────────────────
export interface SDKNodeResult {
  nodeId: string;
  success: boolean;
  output: string;
  error?: string;
  tokenUsage?: { input: number; output: number };
  duration: number;
  /** Files modified by this agent */
  filesModified: string[];
}

// ─── Cowork Configuration ────────────────────────────────────────────
export interface CoworkConfig {
  /** Max concurrent SDK query() calls */
  maxConcurrency: number;
  /** Default timeout per agent in ms */
  defaultTimeout: number;
  /** Rate limits for API calls */
  rateLimits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  /** Persistence settings */
  persistence: {
    enabled: boolean;
    dbPath: string;
  };
  /** Default model for worker agents */
  defaultModel: string;
  /** Model for lead/planning agent */
  plannerModel: string;
  /** Working directory for agents */
  cwd?: string;
  /** Max feedback loop iterations (code→test→fix) */
  maxFeedbackIterations: number;
}

// ─── Node Executor callback type ─────────────────────────────────────
// Used by WorkflowEngine to delegate execution
export type NodeExecutor = (
  node: WorkflowNode,
  context: Record<string, unknown>,
) => Promise<TaskResult>;

// ─── Inter-Agent Message (kept for persistence compat) ───────────────
export interface AgentMessage {
  id: string;
  from: string;
  to: string | '*';
  type: 'request' | 'response' | 'event' | 'delegation' | 'negotiation';
  channel: string;
  payload: unknown;
  timestamp: Date;
  correlationId?: string;
}

// ─── Agent Config (kept for persistence compat) ──────────────────────
export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  capabilities: Array<{ name: string; description: string }>;
  maxConcurrentTasks: number;
  model: string;
}
