import type { PlanNode, CoworkAgentDef, CoworkConfig } from '../core/types.js';

// ─── Model ID mapping ───────────────────────────────────────────────

const MODEL_IDS: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

function resolveModel(tier: string | undefined, defaultModel: string): string {
  if (!tier) return defaultModel;
  return MODEL_IDS[tier] ?? defaultModel;
}

// ─── Prompt Templates ───────────────────────────────────────────────

function buildSystemPrompt(node: PlanNode, predecessorOutputs: string[]): string {
  const sections: string[] = [];

  sections.push(`You are a specialized agent working on: "${node.name}"`);
  sections.push(`\nTask description:\n${node.description}`);

  if (node.ownedPaths.length > 0) {
    sections.push(
      `\nYou are responsible for these files/patterns:\n${node.ownedPaths.map((p) => `  - ${p}`).join('\n')}`,
    );
    sections.push('Only create or modify files that match these patterns.');
  }

  if (predecessorOutputs.length > 0) {
    sections.push(
      '\nContext from completed predecessor tasks:\n' +
        predecessorOutputs
          .map((output, i) => `--- Predecessor ${i + 1} ---\n${output}`)
          .join('\n\n'),
    );
  }

  if (node.isTest) {
    sections.push(
      '\nThis is a TEST task. Run the relevant tests and report results clearly.',
      'If tests fail, output the failure details so they can be fixed.',
    );
  }

  sections.push(
    '\nIMPORTANT: Focus only on your assigned task. Do not modify files outside your ownership.',
    'When done, provide a clear summary of what you accomplished.',
  );

  return sections.join('\n');
}

function buildPrompt(node: PlanNode): string {
  return node.description;
}

// ─── Agent Factory ──────────────────────────────────────────────────

/**
 * Creates a CoworkAgentDef from a PlanNode.
 * Each agent def contains everything needed for a single SDK query() call.
 */
export function createAgentDef(
  node: PlanNode,
  config: CoworkConfig,
  predecessorOutputs: string[] = [],
): CoworkAgentDef {
  const model = resolveModel(node.modelTier, config.defaultModel);

  // Test nodes get read-only tools
  const tools = node.isTest
    ? ['Bash', 'Read', 'Glob', 'Grep']
    : undefined; // undefined = all tools

  return {
    id: node.id,
    name: node.name,
    prompt: buildPrompt(node),
    systemPrompt: buildSystemPrompt(node, predecessorOutputs),
    model,
    ownedPaths: node.ownedPaths,
    tools,
    maxTurns: node.isTest ? 10 : 30,
  };
}

/**
 * Creates a CoworkAgentDef for the lead/planner agent.
 * This agent explores the codebase and outputs a JSON plan.
 */
export function createPlannerAgentDef(
  taskDescription: string,
  config: CoworkConfig,
): CoworkAgentDef {
  const systemPrompt = `You are a lead architect planning a software task. Your job is to:

1. Explore the codebase using Read, Glob, and Grep tools to understand the structure
2. Break the task into parallel-safe subtasks
3. Output a JSON plan

CRITICAL: Your final output MUST be a JSON block wrapped in \`\`\`json fences with this exact schema:

\`\`\`json
{
  "summary": "Brief description of the plan",
  "nodes": [
    {
      "id": "unique-id",
      "name": "Human-readable name",
      "description": "Detailed instructions for the agent executing this node",
      "ownedPaths": ["src/path/to/file.ts", "src/other/**/*.ts"],
      "dependsOn": ["id-of-predecessor"],
      "modelTier": "sonnet",
      "isTest": false,
      "priority": "medium"
    }
  ]
}
\`\`\`

Rules for creating the plan:
- Each node's ownedPaths must NOT overlap with any other node's ownedPaths
- Use dependsOn to express ordering constraints (e.g., tests depend on implementation)
- Nodes without dependencies can run in parallel
- Include test nodes where appropriate (isTest: true)
- Use "opus" modelTier only for complex architectural tasks
- Use "sonnet" (default) for most implementation tasks
- Use "haiku" for simple tasks like formatting or small fixes
- Keep descriptions detailed enough that an agent can work independently`;

  return {
    id: 'planner',
    name: 'Lead Planner',
    prompt: taskDescription,
    systemPrompt,
    model: config.plannerModel,
    ownedPaths: [], // planner doesn't write files
    tools: ['Read', 'Glob', 'Grep', 'Bash'], // read-only exploration
    maxTurns: 20,
  };
}
