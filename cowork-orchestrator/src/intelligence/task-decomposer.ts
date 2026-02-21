import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { getDefaultModel } from '../llm/client.js';
import type {
  Task,
  TaskPriority,
  AgentCapability,
  Workflow,
  WorkflowNode,
  WorkflowEdge,
} from '../core/types.js';
import type { ChatTool } from '../llm/client.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface DecompositionResult {
  subtasks: Task[];
  reasoning: string;
  parallelGroups: string[][];
}

export type ComplexityRating =
  | 'trivial'
  | 'simple'
  | 'moderate'
  | 'complex'
  | 'epic';

interface TaskDecomposerConfig {
  model?: string;
  maxSubtasks?: number;
}

// ─── Zod Schemas for tool_use validation ────────────────────────────

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
const VALID_COMPLEXITIES = [
  'trivial',
  'simple',
  'moderate',
  'complex',
  'epic',
] as const;

const SubtaskSchema = z.object({
  name: z.string(),
  description: z.string(),
  requiredCapability: z.string(),
  priority: z.string().refine(
    (v): v is TaskPriority =>
      (VALID_PRIORITIES as readonly string[]).includes(v),
    { message: 'Invalid priority' },
  ),
  estimatedComplexity: z.string().refine(
    (v): v is (typeof VALID_COMPLEXITIES)[number] =>
      (VALID_COMPLEXITIES as readonly string[]).includes(v),
    { message: 'Invalid complexity' },
  ),
  dependencies: z.array(z.string()),
});

const DecompositionSchema = z.object({
  subtasks: z.array(SubtaskSchema),
  reasoning: z.string(),
  parallelGroups: z.array(z.array(z.string())),
});

const WorkflowSuggestionSchema = z.object({
  name: z.string(),
  description: z.string(),
  nodes: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      requiredCapability: z.string(),
      priority: z.string(),
    }),
  ),
  edges: z.array(
    z.object({
      fromNode: z.string(),
      toNode: z.string(),
      condition: z.string().optional(),
    }),
  ),
});

// ─── OpenAI Tool Definitions ────────────────────────────────────────

const DECOMPOSITION_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'decompose_task',
    description:
      'Break a task into subtasks that can each be handled by available agent capabilities.',
    parameters: {
      type: 'object' as const,
      properties: {
        subtasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Short subtask name' },
              description: {
                type: 'string',
                description: 'Detailed subtask description',
              },
              requiredCapability: {
                type: 'string',
                description:
                  'Name of the agent capability required to handle this subtask',
              },
              priority: {
                type: 'string',
                enum: ['critical', 'high', 'medium', 'low'],
              },
              estimatedComplexity: {
                type: 'string',
                enum: ['trivial', 'simple', 'moderate', 'complex', 'epic'],
              },
              dependencies: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Names of other subtasks this one depends on (empty if none)',
              },
            },
            required: [
              'name',
              'description',
              'requiredCapability',
              'priority',
              'estimatedComplexity',
              'dependencies',
            ],
          },
        },
        reasoning: {
          type: 'string',
          description: 'Explanation of the decomposition strategy',
        },
        parallelGroups: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
          },
          description:
            'Groups of subtask names that can run in parallel (each group runs after the previous)',
        },
      },
      required: ['subtasks', 'reasoning', 'parallelGroups'],
    },
  },
};

const WORKFLOW_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'suggest_workflow',
    description:
      'Design a workflow DAG with nodes (tasks) and edges (dependencies).',
    parameters: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        description: { type: 'string', description: 'Workflow description' },
        nodes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              description: { type: 'string' },
              requiredCapability: { type: 'string' },
              priority: {
                type: 'string',
                enum: ['critical', 'high', 'medium', 'low'],
              },
            },
            required: ['name', 'description', 'requiredCapability', 'priority'],
          },
        },
        edges: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fromNode: {
                type: 'string',
                description: 'Name of the source node',
              },
              toNode: {
                type: 'string',
                description: 'Name of the target node',
              },
              condition: {
                type: 'string',
                description: 'Optional condition for this edge',
              },
            },
            required: ['fromNode', 'toNode'],
          },
        },
      },
      required: ['name', 'description', 'nodes', 'edges'],
    },
  },
};

// ─── Task Decomposer ────────────────────────────────────────────────

export class TaskDecomposer {
  private client: OpenAI;
  private model: string;
  private maxSubtasks: number;

  constructor(client: OpenAI, config?: TaskDecomposerConfig) {
    this.client = client;
    this.model = config?.model ?? getDefaultModel();
    this.maxSubtasks = config?.maxSubtasks ?? 10;
  }

  // ─── Decompose ───────────────────────────────────────────────────

  async decompose(
    task: Task,
    availableCapabilities: AgentCapability[],
  ): Promise<DecompositionResult> {
    const capabilityList = availableCapabilities
      .map((c) => `- ${c.name}: ${c.description}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are a task decomposition expert. Break the given task into subtasks that can each be handled by one of the available agent capabilities. Return structured JSON via the decompose_task tool. If the task is too simple to decompose, return it as a single subtask.',
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\nPriority: ${task.priority}\n\nAvailable capabilities:\n${capabilityList}\n\nDecompose this task into subtasks (max ${this.maxSubtasks}). Each subtask must use one of the listed capabilities. Specify dependencies between subtasks by name and group parallelizable subtasks.`,
        },
      ],
      tools: [DECOMPOSITION_TOOL],
      tool_choice: { type: 'function', function: { name: 'decompose_task' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      // Task too simple — return original task unchanged
      return {
        subtasks: [task],
        reasoning: 'Task is atomic and does not need decomposition.',
        parallelGroups: [[task.name]],
      };
    }

    const parsed = DecompositionSchema.parse(JSON.parse(rawToolCall.function.arguments));

    // Convert parsed subtasks to Task objects
    const nameToId = new Map<string, string>();
    const subtasks: Task[] = parsed.subtasks.map((st) => {
      const id = uuidv4();
      nameToId.set(st.name, id);
      return this.createSubtask(task, id, st.name, st.description, st.priority as TaskPriority);
    });

    // Wire up dependency links (name → id)
    for (let i = 0; i < parsed.subtasks.length; i++) {
      const depNames = parsed.subtasks[i].dependencies;
      subtasks[i].dependencies = depNames
        .map((name) => nameToId.get(name))
        .filter((id): id is string => id !== undefined);
    }

    // Resolve parallel groups from names to IDs
    const parallelGroups = parsed.parallelGroups.map((group) =>
      group
        .map((name) => nameToId.get(name))
        .filter((id): id is string => id !== undefined),
    );

    // If too many subtasks, recursively decompose the largest ones
    if (subtasks.length > this.maxSubtasks) {
      return this.handleOverflow(subtasks, parsed.reasoning, parallelGroups, availableCapabilities);
    }

    return {
      subtasks,
      reasoning: parsed.reasoning,
      parallelGroups,
    };
  }

  // ─── Estimate Complexity ─────────────────────────────────────────

  async estimateComplexity(task: Task): Promise<ComplexityRating> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 50,
      messages: [
        {
          role: 'user',
          content: `Rate the complexity of this task on a scale: trivial, simple, moderate, complex, epic.\nTask: ${task.description}\nReply with just the rating.`,
        },
      ],
    }) as OpenAI.ChatCompletion;

    const text = response.choices[0]?.message?.content?.trim().toLowerCase() ?? 'moderate';
    const validRatings: ComplexityRating[] = [
      'trivial',
      'simple',
      'moderate',
      'complex',
      'epic',
    ];
    const matched = validRatings.find((r) => text.includes(r));
    return matched ?? 'moderate';
  }

  // ─── Suggest Workflow ────────────────────────────────────────────

  async suggestWorkflow(
    task: Task,
    capabilities: AgentCapability[],
  ): Promise<Workflow> {
    const capabilityList = capabilities
      .map((c) => `- ${c.name}: ${c.description}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are a workflow design expert. Design a workflow as a directed acyclic graph (DAG) with nodes representing tasks and edges representing dependencies. Use the suggest_workflow tool to return your design.',
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\n\nAvailable capabilities:\n${capabilityList}\n\nDesign a workflow DAG to accomplish this task. Each node should map to one capability. Define edges for dependencies between nodes.`,
        },
      ],
      tools: [WORKFLOW_TOOL],
      tool_choice: { type: 'function', function: { name: 'suggest_workflow' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      // Fallback: single-node workflow
      return this.singleNodeWorkflow(task);
    }

    const parsed = WorkflowSuggestionSchema.parse(JSON.parse(rawToolCall.function.arguments));

    // Build name→UUID mapping for nodes
    const nameToId = new Map<string, string>();
    const nodes: WorkflowNode[] = parsed.nodes.map((n) => {
      const id = uuidv4();
      nameToId.set(n.name, id);
      return {
        id,
        taskTemplate: {
          name: n.name,
          description: n.description,
          priority: (n.priority as TaskPriority) || task.priority,
          input: {},
          dependencies: [],
          subtasks: [],
          metadata: { retryCount: 0, maxRetries: 3 },
        },
        agentSelector: {
          strategy: 'capability-match' as const,
          requiredCapabilities: [n.requiredCapability],
        },
      };
    });

    // Convert edges using node name→id mapping
    const edges: WorkflowEdge[] = parsed.edges
      .map((e) => ({
        from: nameToId.get(e.fromNode) ?? '',
        to: nameToId.get(e.toNode) ?? '',
        condition: e.condition,
      }))
      .filter((e) => e.from !== '' && e.to !== '');

    return {
      id: uuidv4(),
      name: parsed.name,
      description: parsed.description,
      nodes,
      edges,
      status: 'pending',
      context: {},
    };
  }

  // ─── Private Helpers ─────────────────────────────────────────────

  private createSubtask(
    parent: Task,
    id: string,
    name: string,
    description: string,
    priority: TaskPriority,
  ): Task {
    const now = new Date();
    return {
      id,
      parentId: parent.id,
      name,
      description,
      priority,
      status: 'pending',
      input: {},
      dependencies: [],
      subtasks: [],
      metadata: { retryCount: 0, maxRetries: 3 },
      createdAt: now,
      updatedAt: now,
    };
  }

  private singleNodeWorkflow(task: Task): Workflow {
    const nodeId = uuidv4();
    return {
      id: uuidv4(),
      name: `Workflow: ${task.name}`,
      description: task.description,
      nodes: [
        {
          id: nodeId,
          taskTemplate: {
            name: task.name,
            description: task.description,
            priority: task.priority,
            input: task.input,
            dependencies: [],
            subtasks: [],
            metadata: { retryCount: 0, maxRetries: 3 },
          },
        },
      ],
      edges: [],
      status: 'pending',
      context: {},
    };
  }

  private async handleOverflow(
    subtasks: Task[],
    reasoning: string,
    parallelGroups: string[][],
    capabilities: AgentCapability[],
  ): Promise<DecompositionResult> {
    // Keep the first maxSubtasks subtasks, recursively decompose the rest
    // by merging overflow items into the last kept subtask
    const kept = subtasks.slice(0, this.maxSubtasks);
    const overflow = subtasks.slice(this.maxSubtasks);

    if (overflow.length > 0) {
      // Create a synthetic parent for overflow items
      const syntheticParent = this.createSubtask(
        kept[0],
        uuidv4(),
        'Remaining tasks',
        overflow.map((t) => t.description).join('; '),
        kept[0].priority,
      );
      syntheticParent.parentId = kept[0].parentId;

      const subResult = await this.decompose(syntheticParent, capabilities);
      kept.push(...subResult.subtasks);
    }

    return {
      subtasks: kept,
      reasoning: reasoning + ' (overflow subtasks were recursively decomposed)',
      parallelGroups,
    };
  }
}
