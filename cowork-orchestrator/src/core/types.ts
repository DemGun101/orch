import { z } from 'zod';

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

// ─── Agent Capability Descriptor ─────────────────────────────────────
export interface AgentCapability {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  costEstimate?: 'low' | 'medium' | 'high';
}

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

// ─── MCP Tool Definition ─────────────────────────────────────────────
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler?: string;
}

// ─── Tool Execution Result ───────────────────────────────────────────
export interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  duration: number;
}

// ─── Tool Call (from LLM API response) ──────────────────────────────
export interface ToolCall {
  toolName: string;
  input: unknown;
  id: string;
}

// ─── Agent Configuration ─────────────────────────────────────────────
export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  capabilities: AgentCapability[];
  maxConcurrentTasks: number;
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDefinition[];
}

// ─── Agent Status ────────────────────────────────────────────────────
export type AgentStatus = 'idle' | 'busy' | 'error' | 'offline';

// ─── Agent Selector Config ───────────────────────────────────────────
export interface AgentSelectorConfig {
  strategy: 'capability-match' | 'least-loaded' | 'round-robin' | 'ai-selected';
  preferredAgentId?: string;
  requiredCapabilities?: string[];
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
  agentSelector?: AgentSelectorConfig;
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

// ─── Inter-Agent Message ─────────────────────────────────────────────
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

// ─── Orchestrator Configuration ──────────────────────────────────────
export interface OrchestratorConfig {
  maxConcurrentAgents: number;
  maxConcurrentTasks: number;
  defaultTimeout: number;
  checkpointInterval: number;
  rateLimits: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
  persistence: {
    enabled: boolean;
    dbPath: string;
  };
  llm?: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
  };
  modelRouting?: Partial<ModelRoutingConfig>;
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

// ─── Execution Layer Types ────────────────────────────────────────────

export type ModelTier = 'haiku' | 'sonnet' | 'opus';

export type ExecutionMode = 'sdk' | 'cli' | 'api';

export interface ExecutionMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface SDKExecutionResult {
  sessionId: string;
  mode: ExecutionMode;
  output: string;
  messages: ExecutionMessage[];
  tokenUsage?: { input: number; output: number };
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ModelRoutingConfig {
  defaultTier: ModelTier;
  /** Task name → ModelTier override */
  tierMap: Record<string, ModelTier>;
  /** Tier → full model ID override (e.g. 'sonnet' → 'claude-sonnet-4-6') */
  overrides: Record<string, string>;
}

export interface ExecutionAgentConfig extends AgentConfig {
  executionMode?: ExecutionMode;
  modelTier?: ModelTier;
  sessionPersist?: boolean;
}
