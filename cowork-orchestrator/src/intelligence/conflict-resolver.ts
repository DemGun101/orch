import OpenAI from 'openai';
import { z } from 'zod';
import type { Task, TaskResult } from '../core/types.js';
import type { MessageBus } from '../communication/message-bus.js';
import { getDefaultModel } from '../llm/client.js';
import type { ChatTool } from '../llm/client.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface Conflict {
  type: 'contradiction' | 'overlap' | 'inconsistency';
  agentIds: string[];
  description: string;
  severity: 'low' | 'medium' | 'high';
  suggestedResolution: string;
}

export type ResolutionStrategy = 'MERGE' | 'PREFER' | 'RETRY' | 'ESCALATE';

export interface Resolution {
  strategy: ResolutionStrategy;
  resolvedOutput?: Record<string, unknown>;
  reasoning: string;
  retryAgentIds?: string[];
}

export interface ConflictPrevention {
  riskLevel: 'none' | 'low' | 'medium' | 'high';
  guardrails: string[];
}

// ─── Zod Validation Schemas ──────────────────────────────────────────

const VALID_CONFLICT_TYPES = [
  'contradiction',
  'overlap',
  'inconsistency',
] as const;
const VALID_SEVERITIES = ['low', 'medium', 'high'] as const;
const VALID_STRATEGIES = ['MERGE', 'PREFER', 'RETRY', 'ESCALATE'] as const;
const VALID_RISK_LEVELS = ['none', 'low', 'medium', 'high'] as const;

const ConflictSchema = z.object({
  type: z.string().refine(
    (v): v is Conflict['type'] =>
      (VALID_CONFLICT_TYPES as readonly string[]).includes(v),
    { message: 'Invalid conflict type' },
  ),
  agentIds: z.array(z.string()),
  description: z.string(),
  severity: z.string().refine(
    (v): v is Conflict['severity'] =>
      (VALID_SEVERITIES as readonly string[]).includes(v),
    { message: 'Invalid severity' },
  ),
  suggestedResolution: z.string(),
});

const DetectConflictsSchema = z.object({
  conflicts: z.array(ConflictSchema),
});

const ResolutionSchema = z.object({
  strategy: z.string().refine(
    (v): v is ResolutionStrategy =>
      (VALID_STRATEGIES as readonly string[]).includes(v),
    { message: 'Invalid resolution strategy' },
  ),
  resolvedOutput: z.record(z.string(), z.unknown()).optional(),
  reasoning: z.string(),
  retryAgentIds: z.array(z.string()).optional(),
});

const PreventionSchema = z.object({
  riskLevel: z.string().refine(
    (v): v is ConflictPrevention['riskLevel'] =>
      (VALID_RISK_LEVELS as readonly string[]).includes(v),
    { message: 'Invalid risk level' },
  ),
  guardrails: z.array(z.string()),
});

// ─── OpenAI Tool Definitions ────────────────────────────────────────

const DETECT_CONFLICTS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'detect_conflicts',
    description:
      'Analyze multiple agent outputs and identify any contradictions, overlaps, or inconsistencies.',
    parameters: {
      type: 'object' as const,
      properties: {
        conflicts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['contradiction', 'overlap', 'inconsistency'],
              },
              agentIds: {
                type: 'array',
                items: { type: 'string' },
                description: 'IDs of the agents whose outputs conflict',
              },
              description: {
                type: 'string',
                description: 'Description of the conflict',
              },
              severity: {
                type: 'string',
                enum: ['low', 'medium', 'high'],
              },
              suggestedResolution: {
                type: 'string',
                description: 'How to resolve this conflict',
              },
            },
            required: [
              'type',
              'agentIds',
              'description',
              'severity',
              'suggestedResolution',
            ],
          },
        },
      },
      required: ['conflicts'],
    },
  },
};

const RESOLVE_CONFLICT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'resolve_conflict',
    description:
      'Choose a resolution strategy for a conflict between agent outputs.',
    parameters: {
      type: 'object' as const,
      properties: {
        strategy: {
          type: 'string',
          enum: ['MERGE', 'PREFER', 'RETRY', 'ESCALATE'],
          description:
            'MERGE = combine outputs, PREFER = pick one, RETRY = re-run agents, ESCALATE = needs human',
        },
        resolvedOutput: {
          type: 'object',
          description:
            'The merged/preferred output (for MERGE or PREFER strategies)',
        },
        reasoning: {
          type: 'string',
          description: 'Why this strategy was chosen',
        },
        retryAgentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent IDs to retry (for RETRY strategy)',
        },
      },
      required: ['strategy', 'reasoning'],
    },
  },
};

const PREVENT_CONFLICT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'prevent_conflict',
    description:
      'Assess conflict risk before parallel task execution and suggest guardrails.',
    parameters: {
      type: 'object' as const,
      properties: {
        riskLevel: {
          type: 'string',
          enum: ['none', 'low', 'medium', 'high'],
        },
        guardrails: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Recommended guardrails to prevent conflicts during execution',
        },
      },
      required: ['riskLevel', 'guardrails'],
    },
  },
};

// ─── Conflict Resolver ───────────────────────────────────────────────

export class ConflictResolver {
  private client: OpenAI;
  private model: string;
  private messageBus?: MessageBus;

  constructor(client: OpenAI, messageBus?: MessageBus, model?: string) {
    this.client = client;
    this.messageBus = messageBus;
    this.model = model ?? getDefaultModel();
  }

  // ─── Detect Conflicts ────────────────────────────────────────────

  async detectConflicts(
    outputs: Map<string, TaskResult>,
  ): Promise<Conflict[]> {
    if (outputs.size < 2) return [];

    const outputDescriptions = Array.from(outputs.entries())
      .map(
        ([agentId, result]) =>
          `Agent "${agentId}":\n  Success: ${result.success}\n  Output: ${JSON.stringify(result.output, null, 2)}${result.error ? `\n  Error: ${result.error}` : ''}`,
      )
      .join('\n\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at detecting conflicts between agent outputs. Analyze the outputs and identify any contradictions (directly opposing results), overlaps (duplicate work), or inconsistencies (mismatched assumptions or data). If there are no conflicts, return an empty conflicts array.',
        },
        {
          role: 'user',
          content: `The following agents produced these outputs for related tasks. Do any of them contradict, overlap, or conflict?\n\n${outputDescriptions}`,
        },
      ],
      tools: [DETECT_CONFLICTS_TOOL],
      tool_choice: { type: 'function', function: { name: 'detect_conflicts' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') return [];

    const parsed = DetectConflictsSchema.parse(JSON.parse(rawToolCall.function.arguments));
    return parsed.conflicts as Conflict[];
  }

  // ─── Resolve Conflict ────────────────────────────────────────────

  async resolve(
    conflict: Conflict,
    agentOutputs: Map<string, TaskResult>,
  ): Promise<Resolution> {
    const outputDescriptions = Array.from(agentOutputs.entries())
      .filter(([agentId]) => conflict.agentIds.includes(agentId))
      .map(
        ([agentId, result]) =>
          `Agent "${agentId}":\n  Output: ${JSON.stringify(result.output, null, 2)}`,
      )
      .join('\n\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at resolving conflicts between agent outputs. Choose the best resolution strategy: MERGE (combine the best parts), PREFER (pick the most reliable output), RETRY (have agents redo with clearer instructions), or ESCALATE (needs human intervention).',
        },
        {
          role: 'user',
          content: `Conflict: ${conflict.description}\nType: ${conflict.type}\nSeverity: ${conflict.severity}\nSuggested resolution: ${conflict.suggestedResolution}\n\nAgent outputs:\n${outputDescriptions}\n\nResolve this conflict.`,
        },
      ],
      tools: [RESOLVE_CONFLICT_TOOL],
      tool_choice: { type: 'function', function: { name: 'resolve_conflict' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      return {
        strategy: 'ESCALATE',
        reasoning: 'Unable to determine resolution automatically.',
      };
    }

    const parsed = ResolutionSchema.parse(JSON.parse(rawToolCall.function.arguments));

    // Notify via message bus if available
    if (this.messageBus) {
      this.messageBus.publish({
        id: '',
        from: 'conflict-resolver',
        to: '*',
        type: 'event',
        channel: 'system',
        payload: {
          event: 'conflict-resolved',
          conflict,
          resolution: parsed,
        },
        timestamp: new Date(),
      });
    }

    return parsed as Resolution;
  }

  // ─── Prevent Conflict ────────────────────────────────────────────

  async preventConflict(tasks: Task[]): Promise<ConflictPrevention> {
    if (tasks.length < 2) {
      return { riskLevel: 'none', guardrails: [] };
    }

    const taskDescriptions = tasks
      .map(
        (t) =>
          `- "${t.name}": ${t.description} (priority: ${t.priority})`,
      )
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at predicting conflicts in parallel task execution. Assess whether the following tasks might produce conflicting results if run simultaneously, and suggest guardrails to prevent issues.',
        },
        {
          role: 'user',
          content: `These tasks are about to run in parallel. Could they conflict?\n\n${taskDescriptions}\n\nAssess the conflict risk and suggest guardrails.`,
        },
      ],
      tools: [PREVENT_CONFLICT_TOOL],
      tool_choice: { type: 'function', function: { name: 'prevent_conflict' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      return { riskLevel: 'low', guardrails: [] };
    }

    const parsed = PreventionSchema.parse(JSON.parse(rawToolCall.function.arguments));
    return parsed as ConflictPrevention;
  }
}
