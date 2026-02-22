import type { Workflow, WorkflowNode, WorkflowEdge, PlanNode } from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';

// ─── Feedback Loop: Unrolled DAG Pattern ────────────────────────────
//
// Since DAGs can't have cycles, feedback loops (code → test → fix → retest)
// are "unrolled" into a linear chain:
//
//   code → test-0 → fix-0 → test-1 → fix-1 → test-2
//
// Conditional edges skip fix/retest nodes when tests pass.
// The condition checks `{nodeId}.success == true` in workflow context.

/**
 * Create a feedback sub-workflow from a code node and test node.
 * Unrolls the test→fix→retest cycle for `maxIterations` rounds.
 */
export function createFeedbackWorkflow(
  codeNodeId: string,
  testNode: PlanNode,
  maxIterations: number,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];

  let previousNodeId = codeNodeId;

  for (let i = 0; i < maxIterations; i++) {
    // Test node
    const testId = `${testNode.id}-test-${i}`;
    const testWorkflowNode: WorkflowNode = {
      id: testId,
      taskTemplate: {
        name: `${testNode.name} (attempt ${i + 1})`,
        description: testNode.description,
        priority: testNode.priority ?? 'medium',
        input: {},
        dependencies: [],
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 0 },
      },
    };
    nodes.push(testWorkflowNode);

    // Edge from previous node → test
    edges.push({ from: previousNodeId, to: testId });

    // Fix node (only runs if test fails)
    const fixId = `${testNode.id}-fix-${i}`;
    const fixWorkflowNode: WorkflowNode = {
      id: fixId,
      taskTemplate: {
        name: `Fix failures from ${testNode.name} (attempt ${i + 1})`,
        description: `The previous test run failed. Analyze the test output and fix the issues.\n\nOriginal task: ${testNode.description}`,
        priority: testNode.priority ?? 'medium',
        input: {},
        dependencies: [],
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 0 },
      },
    };
    nodes.push(fixWorkflowNode);

    // Edge from test → fix (only if test failed)
    // The condition checks that the test node output was NOT successful
    edges.push({
      from: testId,
      to: fixId,
      condition: `${testId}.success == false`,
    });

    previousNodeId = fixId;
  }

  // Final test after last fix
  const finalTestId = `${testNode.id}-test-final`;
  const finalTestNode: WorkflowNode = {
    id: finalTestId,
    taskTemplate: {
      name: `${testNode.name} (final)`,
      description: testNode.description,
      priority: testNode.priority ?? 'medium',
      input: {},
      dependencies: [],
      subtasks: [],
      metadata: { retryCount: 0, maxRetries: 0 },
    },
  };
  nodes.push(finalTestNode);
  edges.push({ from: previousNodeId, to: finalTestId });

  return { nodes, edges };
}

/**
 * Convert a Plan with test nodes into a Workflow with feedback loops.
 * Non-test nodes are converted directly. Test nodes get unrolled
 * into feedback sub-workflows.
 */
export function planToWorkflow(
  plan: { nodes: PlanNode[]; summary: string },
  maxFeedbackIterations: number,
): Workflow {
  const workflowNodes: WorkflowNode[] = [];
  const workflowEdges: WorkflowEdge[] = [];

  // Separate test and non-test nodes
  const codeNodes = plan.nodes.filter((n) => !n.isTest);
  const testNodes = plan.nodes.filter((n) => n.isTest);

  // Convert code nodes directly
  for (const node of codeNodes) {
    workflowNodes.push({
      id: node.id,
      taskTemplate: {
        name: node.name,
        description: node.description,
        priority: node.priority ?? 'medium',
        input: {},
        dependencies: node.dependsOn,
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 0 },
      },
    });

    // Add dependency edges
    for (const depId of node.dependsOn) {
      workflowEdges.push({ from: depId, to: node.id });
    }
  }

  // Convert test nodes with feedback loops
  for (const testNode of testNodes) {
    // Find the code node this test depends on
    const codeDeps = testNode.dependsOn;

    if (codeDeps.length > 0 && maxFeedbackIterations > 0) {
      // Create feedback sub-workflow
      const lastCodeDep = codeDeps[codeDeps.length - 1];
      const feedback = createFeedbackWorkflow(
        lastCodeDep,
        testNode,
        maxFeedbackIterations,
      );
      workflowNodes.push(...feedback.nodes);
      workflowEdges.push(...feedback.edges);

      // Add edges from other dependencies to first test node
      for (let i = 0; i < codeDeps.length - 1; i++) {
        const firstTestId = `${testNode.id}-test-0`;
        workflowEdges.push({ from: codeDeps[i], to: firstTestId });
      }
    } else {
      // No feedback - just add as a simple node
      workflowNodes.push({
        id: testNode.id,
        taskTemplate: {
          name: testNode.name,
          description: testNode.description,
          priority: testNode.priority ?? 'medium',
          input: {},
          dependencies: testNode.dependsOn,
          subtasks: [],
          metadata: { retryCount: 0, maxRetries: 0 },
        },
      });

      for (const depId of testNode.dependsOn) {
        workflowEdges.push({ from: depId, to: testNode.id });
      }
    }
  }

  return {
    id: uuidv4(),
    name: plan.summary,
    description: plan.summary,
    nodes: workflowNodes,
    edges: workflowEdges,
    status: 'pending',
    context: {},
  };
}
