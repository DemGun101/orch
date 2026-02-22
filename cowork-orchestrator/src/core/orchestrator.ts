import { v4 as uuidv4 } from 'uuid';
import type {
  Plan,
  PlanNode,
  CoworkConfig,
  TaskResult,
  WorkflowNode,
  WorkflowResult,
} from './types.js';
import { WorkflowEngine } from './workflow-engine.js';
import { SDKBridge } from '../sdk/bridge.js';
import { FileOwnershipManager } from '../sdk/file-ownership.js';
import { createAgentDef, createPlannerAgentDef } from '../sdk/agent-factory.js';
import { planToWorkflow } from '../feedback/feedback-loop.js';
import { MetricsCollector, METRICS } from '../monitoring/metrics.js';
import { DEFAULT_CONFIG, validateConfig } from '../config/schema.js';

// ─── Orchestrator ───────────────────────────────────────────────────
// Main class: plan → DAG → execute → aggregate
//
// Flow:
// 1. Run lead agent (SDK query, read-only) to produce a Plan (JSON)
// 2. Convert Plan → Workflow (DAG) with feedback loops for test nodes
// 3. Register file ownership for each node
// 4. Execute DAG via WorkflowEngine (parallel where possible)
// 5. Each node → AgentFactory → SDKBridge → SDK query()
// 6. Aggregate results

export class Orchestrator {
  private config: CoworkConfig;
  private metrics: MetricsCollector;
  private fileOwnership: FileOwnershipManager;
  private sdkBridge: SDKBridge;

  constructor(config?: Partial<CoworkConfig>) {
    this.config = config ? validateConfig(config) : DEFAULT_CONFIG;
    this.metrics = new MetricsCollector();
    this.fileOwnership = new FileOwnershipManager();
    this.sdkBridge = new SDKBridge(this.config, this.fileOwnership, this.metrics);
  }

  /**
   * Execute a task end-to-end: plan → DAG → execute → aggregate.
   */
  async run(taskDescription: string): Promise<TaskResult> {
    const taskId = uuidv4();
    const startTime = Date.now();
    this.metrics.increment(METRICS.TASKS_TOTAL);
    const stopWorkflowTimer = this.metrics.startTimer(METRICS.WORKFLOW_DURATION);

    try {
      // Step 1: Plan via lead agent
      const plan = await this.plan(taskDescription);

      if (!plan || plan.nodes.length === 0) {
        return {
          taskId,
          success: false,
          output: { error: 'Lead agent failed to produce a valid plan' },
          error: 'Planning failed',
          duration: Date.now() - startTime,
        };
      }

      // Step 2: Convert plan → workflow (DAG) with feedback loops
      const workflow = planToWorkflow(plan, this.config.maxFeedbackIterations);

      // Step 3: Register file ownership
      for (const node of plan.nodes) {
        if (node.ownedPaths.length > 0) {
          this.fileOwnership.register(node.id, node.ownedPaths);
        }
      }

      // Step 4: Execute DAG
      this.metrics.increment(METRICS.WORKFLOW_EXECUTIONS);
      const nodeExecutor = this.createNodeExecutor(plan);
      const engine = new WorkflowEngine(nodeExecutor);
      const workflowResult = await engine.execute(workflow);

      // Step 5: Aggregate results
      const result = this.aggregateResults(taskId, workflowResult, plan, startTime);

      // Cleanup
      this.fileOwnership.clear();

      return result;
    } catch (error) {
      this.metrics.increment(METRICS.TASKS_FAILED);
      return {
        taskId,
        success: false,
        output: {},
        error: error instanceof Error ? error.message : String(error),
        duration: Date.now() - startTime,
      };
    } finally {
      stopWorkflowTimer();
    }
  }

  /**
   * Run the lead/planner agent to produce a Plan.
   */
  async plan(taskDescription: string): Promise<Plan | null> {
    const plannerDef = createPlannerAgentDef(taskDescription, this.config);
    const result = await this.sdkBridge.execute(plannerDef);

    if (!result.success) {
      return null;
    }

    return this.parsePlan(result.output);
  }

  /**
   * Get current metrics snapshot.
   */
  getMetrics() {
    return {
      metrics: this.metrics.getMetrics(),
      rateLimiter: this.sdkBridge.getRateLimiterStats(),
      concurrency: this.sdkBridge.getConcurrencyInfo(),
      circuitBreakers: this.sdkBridge.getCircuitBreakerStats(),
    };
  }

  // ─── Private ────────────────────────────────────────────────────────

  /**
   * Create a NodeExecutor callback that the WorkflowEngine calls
   * for each DAG node. Routes through AgentFactory → SDKBridge.
   */
  private createNodeExecutor(plan: Plan) {
    const planNodeMap = new Map<string, PlanNode>();
    for (const node of plan.nodes) {
      planNodeMap.set(node.id, node);
    }

    return async (
      workflowNode: WorkflowNode,
      context: Record<string, unknown>,
    ): Promise<TaskResult> => {
      const startTime = Date.now();

      // Find the original plan node (may be a feedback sub-node)
      const originalId = this.resolveOriginalNodeId(workflowNode.id, planNodeMap);
      const planNode = planNodeMap.get(originalId);

      // Build a synthetic PlanNode for feedback sub-nodes
      const effectiveNode: PlanNode = planNode ?? {
        id: workflowNode.id,
        name: workflowNode.taskTemplate.name,
        description: workflowNode.taskTemplate.description,
        ownedPaths: [],
        dependsOn: [],
        isTest: workflowNode.id.includes('-test-'),
        priority: workflowNode.taskTemplate.priority,
      };

      // Gather predecessor outputs from context
      const predecessorOutputs = this.gatherPredecessorOutputs(
        effectiveNode.dependsOn,
        context,
      );

      // Create agent definition
      const agentDef = createAgentDef(effectiveNode, this.config, predecessorOutputs);

      // For fix nodes, inject test failure details into the prompt
      if (workflowNode.id.includes('-fix-')) {
        const testId = workflowNode.id.replace('-fix-', '-test-');
        const testOutput = context[testId] as Record<string, unknown> | undefined;
        if (testOutput) {
          agentDef.prompt = `Fix the test failures:\n\n${JSON.stringify(testOutput, null, 2)}\n\nOriginal task: ${agentDef.prompt}`;
        }
      }

      // Register file ownership for feedback sub-nodes
      if (effectiveNode.ownedPaths.length > 0) {
        this.fileOwnership.register(workflowNode.id, effectiveNode.ownedPaths);
      }

      // Execute via SDK bridge
      const sdkResult = await this.sdkBridge.execute(agentDef);

      return {
        taskId: workflowNode.id,
        success: sdkResult.success,
        output: {
          text: sdkResult.output,
          filesModified: sdkResult.filesModified,
          success: sdkResult.success,
        },
        error: sdkResult.error,
        tokenUsage: sdkResult.tokenUsage,
        duration: Date.now() - startTime,
      };
    };
  }

  /**
   * Resolve a feedback sub-node ID back to the original plan node ID.
   */
  private resolveOriginalNodeId(
    nodeId: string,
    planNodeMap: Map<string, PlanNode>,
  ): string {
    if (planNodeMap.has(nodeId)) return nodeId;

    const feedbackPattern = /^(.+?)-(test|fix)-\d+$/;
    const finalPattern = /^(.+?)-test-final$/;

    let match = nodeId.match(feedbackPattern);
    if (match && planNodeMap.has(match[1])) return match[1];

    match = nodeId.match(finalPattern);
    if (match && planNodeMap.has(match[1])) return match[1];

    return nodeId;
  }

  /**
   * Gather predecessor node outputs from workflow context.
   */
  private gatherPredecessorOutputs(
    dependsOn: string[],
    context: Record<string, unknown>,
  ): string[] {
    const outputs: string[] = [];
    for (const depId of dependsOn) {
      const depOutput = context[depId];
      if (depOutput && typeof depOutput === 'object') {
        const text = (depOutput as Record<string, unknown>).text;
        if (typeof text === 'string') {
          outputs.push(text);
        } else {
          outputs.push(JSON.stringify(depOutput));
        }
      }
    }
    return outputs;
  }

  /**
   * Parse the lead agent's output into a Plan.
   */
  private parsePlan(output: string): Plan | null {
    const jsonMatch = output.match(/```json\s*\n([\s\S]*?)\n\s*```/);
    const jsonStr = jsonMatch ? jsonMatch[1] : output;

    try {
      const parsed = JSON.parse(jsonStr.trim());

      if (!parsed.nodes || !Array.isArray(parsed.nodes)) {
        return null;
      }

      const nodes: PlanNode[] = parsed.nodes.map((n: Record<string, unknown>) => ({
        id: (n.id as string) ?? uuidv4(),
        name: (n.name as string) ?? 'Unnamed task',
        description: (n.description as string) ?? '',
        ownedPaths: (n.ownedPaths as string[]) ?? [],
        dependsOn: (n.dependsOn as string[]) ?? [],
        modelTier: n.modelTier as string | undefined,
        isTest: (n.isTest as boolean) ?? false,
        priority: (n.priority as string) ?? 'medium',
      }));

      return {
        nodes,
        summary: (parsed.summary as string) ?? 'Auto-generated plan',
      };
    } catch {
      // Fallback: try to find any JSON-like structure
      const fallbackMatch = output.match(/\{[\s\S]*"nodes"\s*:\s*\[[\s\S]*\][\s\S]*\}/);
      if (fallbackMatch) {
        try {
          const parsed = JSON.parse(fallbackMatch[0]);
          const nodes: PlanNode[] = parsed.nodes.map((n: Record<string, unknown>) => ({
            id: (n.id as string) ?? uuidv4(),
            name: (n.name as string) ?? 'Unnamed task',
            description: (n.description as string) ?? '',
            ownedPaths: (n.ownedPaths as string[]) ?? [],
            dependsOn: (n.dependsOn as string[]) ?? [],
            modelTier: n.modelTier as string | undefined,
            isTest: (n.isTest as boolean) ?? false,
            priority: (n.priority as string) ?? 'medium',
          }));

          return {
            nodes,
            summary: (parsed.summary as string) ?? 'Auto-generated plan',
          };
        } catch {
          return null;
        }
      }

      return null;
    }
  }

  /**
   * Aggregate individual node results into a single TaskResult.
   */
  private aggregateResults(
    taskId: string,
    workflowResult: WorkflowResult,
    plan: Plan,
    startTime: number,
  ): TaskResult {
    const nodeResults: Record<string, unknown> = {};
    const allFilesModified: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const [nodeId, result] of workflowResult.outputs) {
      nodeResults[nodeId] = result.output;

      if (result.tokenUsage) {
        totalInputTokens += result.tokenUsage.input;
        totalOutputTokens += result.tokenUsage.output;
      }

      const files = (result.output as Record<string, unknown>)?.filesModified;
      if (Array.isArray(files)) {
        for (const f of files) {
          if (typeof f === 'string' && !allFilesModified.includes(f)) {
            allFilesModified.push(f);
          }
        }
      }
    }

    return {
      taskId,
      success: workflowResult.success,
      output: {
        plan: plan.summary,
        nodesCompleted: workflowResult.nodesCompleted,
        nodesTotal: workflowResult.nodesTotal,
        nodeResults,
        filesModified: allFilesModified,
      },
      error: workflowResult.success ? undefined : 'One or more nodes failed',
      tokenUsage: { input: totalInputTokens, output: totalOutputTokens },
      duration: Date.now() - startTime,
    };
  }
}
