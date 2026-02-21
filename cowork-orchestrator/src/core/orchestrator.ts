import OpenAI from 'openai';
import type {
  AgentConfig,
  AuditEntry,
  OrchestratorConfig,
  Task,
  TaskResult,
  Workflow,
  WorkflowResult,
} from './types.js';
import { TaskManager } from './task-manager.js';
import { AgentRegistry } from './agent-registry.js';
import { WorkflowEngine } from './workflow-engine.js';
import { MessageBus } from '../communication/message-bus.js';
import { SharedMemoryStore } from '../memory/shared-memory.js';
import { ConversationHistory } from '../memory/conversation-history.js';
import { PersistenceLayer } from '../memory/persistence.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { createLLMClient } from '../llm/client.js';
import { LLMAgent } from '../agents/llm-agent.js';
import { ToolAgent } from '../agents/tool-agent.js';
import type { BaseAgent } from '../agents/base-agent.js';
import { TaskDecomposer } from '../intelligence/task-decomposer.js';
import { AgentSelector } from '../intelligence/agent-selector.js';
import { ConflictResolver } from '../intelligence/conflict-resolver.js';
import { QualityAssessor } from '../intelligence/quality-assessor.js';
import { MetricsCollector, METRICS } from '../monitoring/metrics.js';
import { AuditLogger, AUDIT_EVENTS } from '../monitoring/audit-log.js';
import type { AuditQueryFilter } from '../monitoring/audit-log.js';
import { Dashboard } from '../monitoring/dashboard.js';
import { ToolExecutor } from '../tools/tool-executor.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { ErrorHandler, OrchestratorError } from '../resilience/error-handler.js';
import { APIRateLimiter } from '../resilience/rate-limiter.js';
import { ConcurrencyLimiter } from '../resilience/rate-limiter.js';
import { CircuitBreaker } from '../resilience/retry-strategies.js';
import { CheckpointManager } from '../resilience/checkpointing.js';

// ─── Types ──────────────────────────────────────────────────────────

interface RunningTask {
  task: Task;
  agentId: string;
  startedAt: number;
  promise: Promise<TaskResult>;
}

export interface OrchestratorStatus {
  isRunning: boolean;
  activeAgents: number;
  pendingTasks: number;
  runningTasks: number;
  completedTasks: number;
}

export interface OrchestratorMetrics {
  registry: ReturnType<AgentRegistry['getMetrics']>;
  messageBus: ReturnType<MessageBus['getMetrics']>;
  tasks: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
  };
}

// ─── Orchestration Engine ───────────────────────────────────────────

export class OrchestrationEngine {
  private config: OrchestratorConfig;
  private persistence?: PersistenceLayer;
  private taskManager: TaskManager;
  private agentRegistry: AgentRegistry;
  private workflowEngine: WorkflowEngine;
  private messageBus: MessageBus;
  private sharedMemory: SharedMemoryStore;
  private conversationHistory: ConversationHistory;
  private llmClient: OpenAI;

  // Intelligence layer (lazy-initialized when LLM client is available)
  private taskDecomposer?: TaskDecomposer;
  private agentSelector?: AgentSelector;
  private conflictResolver?: ConflictResolver;
  private qualityAssessor?: QualityAssessor;

  // Monitoring
  private metricsCollector: MetricsCollector;
  private auditLogger?: AuditLogger;
  private dashboard: Dashboard;

  // Tools
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;

  // Resilience
  private errorHandler: ErrorHandler;
  private apiRateLimiter: APIRateLimiter;
  private concurrencyLimiter: ConcurrencyLimiter;
  private checkpointManager?: CheckpointManager;
  private agentCircuitBreakers = new Map<string, CircuitBreaker>();
  private isShuttingDown = false;

  private isRunning = false;
  private loopInterval?: ReturnType<typeof setInterval>;
  private runningTasks = new Map<string, RunningTask>();
  private completedCount = 0;
  private failedCount = 0;

  constructor(config?: Partial<OrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize LLM client (Gemini via OpenAI-compatible endpoint)
    this.llmClient = createLLMClient(this.config.llm);

    // Initialize persistence
    if (this.config.persistence.enabled) {
      this.persistence = new PersistenceLayer(this.config.persistence.dbPath);
    }

    // Initialize subsystems
    this.taskManager = new TaskManager(this.persistence);
    this.agentRegistry = new AgentRegistry(this.persistence);
    this.messageBus = new MessageBus({ persistence: this.persistence });
    this.sharedMemory = new SharedMemoryStore(this.persistence);
    this.conversationHistory = new ConversationHistory(this.persistence);
    this.workflowEngine = new WorkflowEngine(
      this.taskManager,
      this.agentRegistry,
      this.persistence,
    );

    // Initialize tools
    this.toolRegistry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor(this.toolRegistry);

    // Initialize resilience
    this.errorHandler = new ErrorHandler();
    this.apiRateLimiter = new APIRateLimiter({
      requestsPerMinute: this.config.rateLimits.requestsPerMinute,
      tokensPerMinute: this.config.rateLimits.tokensPerMinute,
    });
    this.concurrencyLimiter = new ConcurrencyLimiter({
      maxConcurrent: this.config.maxConcurrentTasks,
    });
    if (this.persistence) {
      this.checkpointManager = new CheckpointManager(this.persistence);
      this.workflowEngine.setCheckpointManager(this.checkpointManager);
    }

    // Initialize monitoring
    this.metricsCollector = new MetricsCollector();
    if (this.persistence) {
      this.auditLogger = new AuditLogger(this.persistence);
    }
    this.dashboard = new Dashboard(this.metricsCollector, this.agentRegistry, this.taskManager);

    // Wire tool executor events to metrics
    this.toolExecutor.onToolExecuted((toolName, result) => {
      this.metricsCollector.increment(METRICS.TOOLS_EXECUTIONS, { tool: toolName });
      this.metricsCollector.record(METRICS.TOOLS_DURATION, result.duration, { tool: toolName });
    });
    this.toolExecutor.onToolError((toolName) => {
      this.metricsCollector.increment(METRICS.TOOLS_ERRORS, { tool: toolName });
    });

    // Initialize intelligence layer if LLM client is available
    this.initializeIntelligence(this.llmClient);
  }

  // ─── LLM Client Configuration ──────────────────────────────────

  setLLMClient(client: OpenAI): void {
    this.llmClient = client;
    this.initializeIntelligence(client);
  }

  private initializeIntelligence(client: OpenAI): void {
    const model = this.config.llm?.model;
    this.taskDecomposer = new TaskDecomposer(client, { model });
    this.agentSelector = new AgentSelector(client, model);
    this.conflictResolver = new ConflictResolver(client, undefined, model);
    this.qualityAssessor = new QualityAssessor(client, { model });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.isRunning) return;

    // Initialize persistence schema
    this.persistence?.initialize();

    this.isRunning = true;

    // Start main processing loop (every 1 second)
    this.loopInterval = setInterval(() => this.processLoop(), 1000);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isShuttingDown = true;
    this.isRunning = false;
    this.dashboard.stopLive();

    // Stop the main loop
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = undefined;
    }

    // Wait for running tasks with 30s timeout
    if (this.runningTasks.size > 0) {
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      const waitForTasks = Promise.all(
        Array.from(this.runningTasks.values()).map((rt) =>
          rt.promise.catch(() => {}),
        ),
      ).then(() => {});

      await Promise.race([waitForTasks, timeout]);
    }

    // Close persistence
    this.persistence?.close();
    this.isShuttingDown = false;
  }

  // ─── Agent Registration ────────────────────────────────────────

  registerAgent(config: AgentConfig): BaseAgent {
    let agent: BaseAgent;

    if (config.tools && config.tools.length > 0) {
      const toolAgent = new ToolAgent(config, this.llmClient, config.tools);
      toolAgent.setToolExecutor(this.toolExecutor);
      agent = toolAgent;
    } else {
      agent = new LLMAgent(config, this.llmClient);
    }

    // Wire up subsystems
    agent.setMessageBus(this.messageBus);
    agent.setHistory(this.conversationHistory);

    this.agentRegistry.register(agent);

    // Create per-agent circuit breaker
    this.agentCircuitBreakers.set(config.id, new CircuitBreaker());

    // Monitoring
    this.metricsCollector.record(METRICS.AGENTS_ACTIVE, this.agentRegistry.getAll().length);
    this.audit(AUDIT_EVENTS.AGENT_REGISTERED, { agentId: config.id, data: { name: config.name, role: config.role } });

    return agent;
  }

  // ─── Task Submission (Intelligence-Enhanced) ──────────────────

  async submitTask(input: Partial<Task>): Promise<TaskResult> {
    const task = this.taskManager.createTask(input);
    this.taskManager.submitTask(task);

    // Monitoring: task created
    this.metricsCollector.increment(METRICS.TASKS_TOTAL);
    this.audit(AUDIT_EVENTS.TASK_CREATED, { taskId: task.id, data: { name: task.name, priority: task.priority } });

    // 1. Estimate complexity and auto-decompose if needed
    if (this.taskDecomposer) {
      const complexity = await this.taskDecomposer.estimateComplexity(task);

      if (complexity === 'complex' || complexity === 'epic') {
        const allCapabilities = this.agentRegistry
          .getAll()
          .flatMap((a) => a['config'].capabilities);

        const decomposition = await this.taskDecomposer.decompose(task, allCapabilities);

        if (decomposition.subtasks.length > 1) {
          // Submit each subtask and collect results
          const subtaskInputs = decomposition.subtasks.map((st) => ({
            name: st.name,
            description: st.description,
            priority: st.priority,
            parentId: task.id,
            dependencies: st.dependencies,
          }));
          this.taskManager.decompose(task.id, subtaskInputs);

          const subtaskResults: TaskResult[] = [];
          for (const subtask of this.taskManager.getSubtasks(task.id)) {
            const result = await this.executeTask(subtask);
            subtaskResults.push(result);
          }

          // Merge outputs from all subtasks
          const mergedOutput: Record<string, unknown> = {};
          for (const r of subtaskResults) {
            Object.assign(mergedOutput, r.output);
          }
          const allSucceeded = subtaskResults.every((r) => r.success);
          const totalDuration = subtaskResults.reduce((sum, r) => sum + r.duration, 0);

          const compositeResult: TaskResult = {
            taskId: task.id,
            success: allSucceeded,
            output: mergedOutput,
            duration: totalDuration,
            error: allSucceeded
              ? undefined
              : subtaskResults
                  .filter((r) => !r.success)
                  .map((r) => r.error)
                  .join('; '),
          };

          // Quality check the composite result
          if (this.qualityAssessor && compositeResult.success) {
            const quality = await this.qualityAssessor.assess(task, compositeResult);
            if (!quality.passesThreshold && task.metadata.retryCount < task.metadata.maxRetries) {
              return this.retryWithSuggestions(task, compositeResult, quality.improvementSuggestions);
            }
          }

          if (allSucceeded) {
            this.taskManager.updateStatus(task.id, 'completed', mergedOutput);
            this.completedCount++;
            this.recordTaskCompletion(task, totalDuration);
          } else {
            this.taskManager.updateStatus(task.id, 'failed');
            this.failedCount++;
            this.recordTaskFailure(task, compositeResult.error);
          }
          return compositeResult;
        }
      }
    }

    // 2. Simple task path: find agent and execute
    const result = await this.executeTask(task);

    // 3. Quality check
    if (this.qualityAssessor && result.success) {
      const quality = await this.qualityAssessor.assess(task, result);
      if (!quality.passesThreshold && task.metadata.retryCount < task.metadata.maxRetries) {
        return this.retryWithSuggestions(task, result, quality.improvementSuggestions);
      }
    }

    return result;
  }

  // ─── Smart Submit (High-Level Magic API) ──────────────────────

  async smartSubmit(description: string): Promise<TaskResult> {
    // 1. Create a task from the plain text description
    const task = this.taskManager.createTask({
      name: description.slice(0, 80),
      description,
      priority: 'medium',
    });
    this.taskManager.submitTask(task);

    this.metricsCollector.increment(METRICS.TASKS_TOTAL);
    this.audit(AUDIT_EVENTS.TASK_CREATED, { taskId: task.id, data: { name: task.name, priority: task.priority } });

    // 2. Decompose if needed
    if (this.taskDecomposer) {
      const complexity = await this.taskDecomposer.estimateComplexity(task);

      if (complexity === 'complex' || complexity === 'epic') {
        const allCapabilities = this.agentRegistry
          .getAll()
          .flatMap((a) => a['config'].capabilities);

        // 3. Generate workflow via suggestWorkflow
        const workflow = await this.taskDecomposer.suggestWorkflow(task, allCapabilities);

        // 4. Execute the workflow
        this.metricsCollector.increment(METRICS.WORKFLOW_EXECUTIONS);
        this.audit(AUDIT_EVENTS.WORKFLOW_STARTED, { workflowId: workflow.id, data: { name: workflow.name } });
        const stopWorkflowTimer = this.metricsCollector.startTimer(METRICS.WORKFLOW_DURATION);

        const workflowResult = await this.workflowEngine.execute(workflow);
        stopWorkflowTimer();

        this.audit(AUDIT_EVENTS.WORKFLOW_COMPLETED, {
          workflowId: workflow.id,
          data: { success: workflowResult.success, duration: workflowResult.duration },
        });

        // Merge workflow outputs
        const mergedOutput: Record<string, unknown> = {};
        for (const [nodeId, nodeResult] of workflowResult.outputs) {
          mergedOutput[nodeId] = nodeResult.output;
        }

        const result: TaskResult = {
          taskId: task.id,
          success: workflowResult.success,
          output: mergedOutput,
          duration: workflowResult.duration,
        };

        // 5. Quality-check the final output
        if (this.qualityAssessor && workflowResult.success) {
          const quality = await this.qualityAssessor.validateWorkflowOutput(
            workflow,
            mergedOutput,
          );
          if (!quality.passesThreshold && task.metadata.retryCount < task.metadata.maxRetries) {
            return this.retryWithSuggestions(task, result, quality.improvementSuggestions);
          }
        }

        if (result.success) {
          this.taskManager.updateStatus(task.id, 'completed', result.output);
          this.completedCount++;
          this.recordTaskCompletion(task, result.duration);
        } else {
          this.taskManager.updateStatus(task.id, 'failed');
          this.failedCount++;
          this.recordTaskFailure(task);
        }

        return result;
      }
    }

    // Simple task — just execute directly
    const result = await this.executeTask(task);

    if (this.qualityAssessor && result.success) {
      const quality = await this.qualityAssessor.assess(task, result);
      if (!quality.passesThreshold && task.metadata.retryCount < task.metadata.maxRetries) {
        return this.retryWithSuggestions(task, result, quality.improvementSuggestions);
      }
    }

    return result;
  }

  // ─── Workflow Execution ────────────────────────────────────────

  async executeWorkflow(workflow: Workflow): Promise<WorkflowResult> {
    this.metricsCollector.increment(METRICS.WORKFLOW_EXECUTIONS);
    this.audit(AUDIT_EVENTS.WORKFLOW_STARTED, { workflowId: workflow.id, data: { name: workflow.name } });
    const stopTimer = this.metricsCollector.startTimer(METRICS.WORKFLOW_DURATION);

    const result = await this.workflowEngine.execute(workflow);
    stopTimer();

    this.audit(AUDIT_EVENTS.WORKFLOW_COMPLETED, {
      workflowId: workflow.id,
      data: { success: result.success, duration: result.duration, nodesCompleted: result.nodesCompleted },
    });

    return result;
  }

  // ─── Monitoring ────────────────────────────────────────────────

  getDashboard(): string {
    return this.dashboard.render();
  }

  startMonitoring(interval?: number): void {
    this.dashboard.startLive(interval);
  }

  stopMonitoring(): void {
    this.dashboard.stopLive();
  }

  getAuditLog(filter?: AuditQueryFilter): AuditEntry[] {
    return this.auditLogger?.query(filter) ?? [];
  }

  exportAuditCSV(filter?: AuditQueryFilter): string {
    return this.auditLogger?.exportCSV(filter) ?? '';
  }

  getMetricsCollector(): MetricsCollector {
    return this.metricsCollector;
  }

  // ─── Status & Metrics ─────────────────────────────────────────

  getStatus(): OrchestratorStatus {
    const allTasks = this.taskManager.getAllTasks();
    return {
      isRunning: this.isRunning,
      activeAgents: this.agentRegistry.getAvailable().length,
      pendingTasks: allTasks.filter((t) => t.status === 'pending' || t.status === 'queued').length,
      runningTasks: this.runningTasks.size,
      completedTasks: this.completedCount,
    };
  }

  getMetrics(): OrchestratorMetrics {
    const allTasks = this.taskManager.getAllTasks();
    return {
      registry: this.agentRegistry.getMetrics(),
      messageBus: this.messageBus.getMetrics(),
      tasks: {
        total: allTasks.length,
        pending: allTasks.filter((t) => t.status === 'pending' || t.status === 'queued').length,
        running: allTasks.filter((t) => t.status === 'running').length,
        completed: allTasks.filter((t) => t.status === 'completed').length,
        failed: allTasks.filter((t) => t.status === 'failed').length,
      },
    };
  }

  // ─── Accessors (for advanced usage) ───────────────────────────

  getTaskManager(): TaskManager {
    return this.taskManager;
  }

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  getWorkflowEngine(): WorkflowEngine {
    return this.workflowEngine;
  }

  getMessageBus(): MessageBus {
    return this.messageBus;
  }

  getSharedMemory(): SharedMemoryStore {
    return this.sharedMemory;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getToolExecutor(): ToolExecutor {
    return this.toolExecutor;
  }

  getErrorHandler(): ErrorHandler {
    return this.errorHandler;
  }

  getCheckpointManager(): CheckpointManager | undefined {
    return this.checkpointManager;
  }

  // ─── Internal: Execute a single task ──────────────────────────

  private async executeTask(task: Task): Promise<TaskResult> {
    if (this.isShuttingDown) {
      return {
        taskId: task.id,
        success: false,
        output: {},
        error: 'Orchestrator is shutting down',
        duration: 0,
      };
    }

    // Use AI agent selection if available, fallback to registry
    let agent: BaseAgent | undefined;

    if (this.agentSelector) {
      const candidates = this.agentRegistry.getAvailable();
      if (candidates.length > 0) {
        const selection = await this.agentSelector.selectAgent(task, candidates);
        if (selection.selectedAgentId) {
          agent = this.agentRegistry.get(selection.selectedAgentId);
        }
      }
    }

    // Fallback to registry-based matching
    if (!agent) {
      agent = this.agentRegistry.findBestMatch(task);
    }

    if (!agent) {
      const result: TaskResult = {
        taskId: task.id,
        success: false,
        output: {},
        error: 'No suitable agent found for this task',
        duration: 0,
      };
      this.taskManager.updateStatus(task.id, 'failed');
      this.failedCount++;
      this.recordTaskFailure(task, result.error);
      return result;
    }

    // Acquire concurrency slot
    const releaseConcurrency = await this.concurrencyLimiter.acquire();

    // Assign and execute
    this.taskManager.updateStatus(task.id, 'assigned', undefined);
    task.assignedAgentId = agent.id;
    this.taskManager.updateStatus(task.id, 'running');
    agent.assignTask(task);

    this.audit(AUDIT_EVENTS.TASK_ASSIGNED, { taskId: task.id, agentId: agent.id, data: { agentName: agent.name } });

    const stopApiTimer = this.metricsCollector.startTimer(METRICS.API_LATENCY);

    // Get circuit breaker for this agent
    const circuitBreaker = this.agentCircuitBreakers.get(agent.id);

    try {
      // Rate limit before API call
      await this.apiRateLimiter.acquireRequest();

      this.metricsCollector.increment(METRICS.API_REQUESTS);

      // Execute through circuit breaker if available
      const executeAgent = () => agent!.execute(task);
      const result = circuitBreaker
        ? await circuitBreaker.execute(executeAgent)
        : await executeAgent();

      stopApiTimer();

      agent.completeTask(task.id, result);

      // Record token usage
      if (result.tokenUsage) {
        this.metricsCollector.record(METRICS.API_TOKENS_IN, result.tokenUsage.input);
        this.metricsCollector.record(METRICS.API_TOKENS_OUT, result.tokenUsage.output);
        this.apiRateLimiter.recordUsage(result.tokenUsage.input, result.tokenUsage.output);
      }

      if (result.success) {
        this.taskManager.updateStatus(task.id, 'completed', result.output);
        this.taskManager.onTaskComplete(task.id);
        this.completedCount++;
        this.recordTaskCompletion(task, result.duration);
      } else {
        this.taskManager.updateStatus(task.id, 'failed');
        this.failedCount++;
        this.recordTaskFailure(task, result.error);
      }

      return result;
    } catch (error) {
      stopApiTimer();
      const errMsg = error instanceof Error ? error.message : String(error);
      agent.failTask(task.id, errMsg);
      this.taskManager.updateStatus(task.id, 'failed');
      this.failedCount++;
      this.metricsCollector.increment(METRICS.API_ERRORS);
      this.recordTaskFailure(task, errMsg);

      // Record error for pattern detection
      if (agent.id) {
        const orchError = error instanceof OrchestratorError
          ? error
          : new OrchestratorError(errMsg, 'TASK_EXECUTION', true, { taskId: task.id, agentId: agent.id });
        this.errorHandler.recordError(agent.id, orchError);
      }

      return {
        taskId: task.id,
        success: false,
        output: {},
        error: errMsg,
        duration: 0,
      };
    } finally {
      releaseConcurrency();
    }
  }

  // ─── Internal: Retry with improvement suggestions ─────────────

  private async retryWithSuggestions(
    task: Task,
    _previousResult: TaskResult,
    suggestions: string[],
  ): Promise<TaskResult> {
    task.metadata.retryCount++;
    const originalDescription = task.description;
    task.description = `${originalDescription}\n\n[Quality improvement suggestions from previous attempt]:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    task.status = 'pending';

    const retryResult = await this.executeTask(task);

    // Restore original description
    task.description = originalDescription;

    return retryResult;
  }

  // ─── Internal: Monitoring helpers ──────────────────────────────

  private recordTaskCompletion(task: Task, duration: number): void {
    this.metricsCollector.increment(METRICS.TASKS_COMPLETED);
    this.metricsCollector.record(METRICS.TASKS_DURATION, duration);
    this.audit(AUDIT_EVENTS.TASK_COMPLETED, { taskId: task.id, agentId: task.assignedAgentId, data: { name: task.name, duration } });
  }

  private recordTaskFailure(task: Task, error?: string): void {
    this.metricsCollector.increment(METRICS.TASKS_FAILED);
    this.audit(AUDIT_EVENTS.TASK_FAILED, { taskId: task.id, agentId: task.assignedAgentId, data: { name: task.name, error } });
  }

  private audit(eventType: string, fields: Omit<AuditEntry, 'eventType' | 'timestamp' | 'data'> & { data: Record<string, unknown> }): void {
    this.auditLogger?.log({
      eventType,
      timestamp: new Date(),
      ...fields,
    });
  }

  // ─── Main Processing Loop ─────────────────────────────────────

  private processLoop(): void {
    if (!this.isRunning) return;

    // Update agent utilization metric
    const agents = this.agentRegistry.getAll();
    if (agents.length > 0) {
      const avgUtilization = agents.reduce((sum, a) => sum + a.getLoad(), 0) / agents.length;
      this.metricsCollector.record(METRICS.AGENTS_UTILIZATION, avgUtilization);
    }

    // 1. Get next task from queue
    const task = this.taskManager.getNextTask();
    if (task) {
      // 2. Find available agent
      const agent = this.agentRegistry.findBestMatch(task);
      if (agent) {
        // 3. Assign and execute (fire-and-forget)
        this.taskManager.updateStatus(task.id, 'assigned');
        task.assignedAgentId = agent.id;
        this.taskManager.updateStatus(task.id, 'running');
        agent.assignTask(task);

        this.audit(AUDIT_EVENTS.TASK_ASSIGNED, { taskId: task.id, agentId: agent.id, data: { agentName: agent.name } });

        const promise = agent.execute(task).then(
          (result) => {
            agent.completeTask(task.id, result);
            if (result.success) {
              this.taskManager.updateStatus(task.id, 'completed', result.output);
              this.taskManager.onTaskComplete(task.id);
              this.completedCount++;
              this.recordTaskCompletion(task, result.duration);
            } else {
              this.taskManager.updateStatus(task.id, 'failed');
              this.failedCount++;
              this.recordTaskFailure(task, result.error);
            }
            this.runningTasks.delete(task.id);
            return result;
          },
          (error) => {
            const errMsg = error instanceof Error ? error.message : String(error);
            agent.failTask(task.id, errMsg);
            this.taskManager.updateStatus(task.id, 'failed');
            this.failedCount++;
            this.recordTaskFailure(task, errMsg);
            this.runningTasks.delete(task.id);
            return {
              taskId: task.id,
              success: false,
              output: {},
              error: errMsg,
              duration: 0,
            } as TaskResult;
          },
        );

        this.runningTasks.set(task.id, {
          task,
          agentId: agent.id,
          startedAt: Date.now(),
          promise,
        });
      } else {
        // No agent available — put task back by re-submitting
        this.taskManager.submitTask(task);
      }
    }

    // 4. Check running tasks for timeouts
    const now = Date.now();
    for (const [taskId, running] of this.runningTasks) {
      const timeout = running.task.timeout ?? this.config.defaultTimeout;
      if (now - running.startedAt > timeout) {
        // Timeout — fail the task
        const agent = this.agentRegistry.get(running.agentId);
        agent?.failTask(taskId, 'Task timed out');
        this.taskManager.updateStatus(taskId, 'failed');
        this.failedCount++;
        this.recordTaskFailure(running.task, 'Task timed out');
        this.runningTasks.delete(taskId);
      }
    }
  }
}
