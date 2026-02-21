import OpenAI from 'openai';
import { z } from 'zod';
import type { Task, TaskResult, TaskPriority, Workflow } from '../core/types.js';
import { getDefaultModel } from '../llm/client.js';
import type { ChatTool } from '../llm/client.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface QualityIssue {
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  suggestion: string;
}

export interface QualityDimensions {
  completeness: number;
  accuracy: number;
  coherence: number;
  relevance: number;
}

export interface QualityReport {
  overallScore: number;
  dimensions: QualityDimensions;
  issues: QualityIssue[];
  passesThreshold: boolean;
  improvementSuggestions: string[];
}

export interface ComparisonRanking {
  taskResultIndex: number;
  score: number;
  reasoning: string;
}

export interface ComparisonReport {
  rankings: ComparisonRanking[];
  bestIndex: number;
}

interface QualityAssessorConfig {
  defaultThreshold?: number;
  model?: string;
}

// ─── Priority Thresholds ────────────────────────────────────────────

const PRIORITY_THRESHOLDS: Record<TaskPriority, number> = {
  critical: 90,
  high: 80,
  medium: 70,
  low: 50,
};

// ─── Zod Validation Schemas ─────────────────────────────────────────

const VALID_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

const QualityReportSchema = z.object({
  overallScore: z.number().min(0).max(100),
  dimensions: z.object({
    completeness: z.number().min(0).max(100),
    accuracy: z.number().min(0).max(100),
    coherence: z.number().min(0).max(100),
    relevance: z.number().min(0).max(100),
  }),
  issues: z.array(
    z.object({
      severity: z.string().refine(
        (v): v is QualityIssue['severity'] =>
          (VALID_SEVERITIES as readonly string[]).includes(v),
        { message: 'Invalid severity' },
      ),
      description: z.string(),
      suggestion: z.string(),
    }),
  ),
  passesThreshold: z.boolean(),
  improvementSuggestions: z.array(z.string()),
});

const ComparisonSchema = z.object({
  rankings: z.array(
    z.object({
      taskResultIndex: z.number(),
      score: z.number().min(0).max(100),
      reasoning: z.string(),
    }),
  ),
  bestIndex: z.number(),
});

// ─── OpenAI Tool Definitions ────────────────────────────────────────

const QUALITY_REPORT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'quality_report',
    description:
      'Assess the quality of a task result across multiple dimensions.',
    parameters: {
      type: 'object' as const,
      properties: {
        overallScore: {
          type: 'number',
          description: 'Overall quality score from 0 to 100',
        },
        dimensions: {
          type: 'object',
          properties: {
            completeness: {
              type: 'number',
              description: 'How complete the output is (0-100)',
            },
            accuracy: {
              type: 'number',
              description: 'How accurate the output is (0-100)',
            },
            coherence: {
              type: 'number',
              description: 'How coherent and well-structured the output is (0-100)',
            },
            relevance: {
              type: 'number',
              description: 'How relevant the output is to the task (0-100)',
            },
          },
          required: ['completeness', 'accuracy', 'coherence', 'relevance'],
        },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              severity: {
                type: 'string',
                enum: ['low', 'medium', 'high', 'critical'],
              },
              description: {
                type: 'string',
                description: 'What the issue is',
              },
              suggestion: {
                type: 'string',
                description: 'How to fix the issue',
              },
            },
            required: ['severity', 'description', 'suggestion'],
          },
        },
        passesThreshold: {
          type: 'boolean',
          description: 'Whether the output meets the quality threshold',
        },
        improvementSuggestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Actionable suggestions for improving the output',
        },
      },
      required: [
        'overallScore',
        'dimensions',
        'issues',
        'passesThreshold',
        'improvementSuggestions',
      ],
    },
  },
};

const COMPARISON_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'compare_results',
    description:
      'Compare multiple task results and rank them by quality.',
    parameters: {
      type: 'object' as const,
      properties: {
        rankings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              taskResultIndex: {
                type: 'number',
                description: 'Zero-based index of the result in the input array',
              },
              score: {
                type: 'number',
                description: 'Quality score from 0 to 100',
              },
              reasoning: {
                type: 'string',
                description: 'Why this result received this score',
              },
            },
            required: ['taskResultIndex', 'score', 'reasoning'],
          },
        },
        bestIndex: {
          type: 'number',
          description: 'Index of the best result',
        },
      },
      required: ['rankings', 'bestIndex'],
    },
  },
};

// ─── Quality Assessor ───────────────────────────────────────────────

export class QualityAssessor {
  private client: OpenAI;
  private model: string;
  private defaultThreshold: number;

  constructor(client: OpenAI, config?: QualityAssessorConfig) {
    this.client = client;
    this.model = config?.model ?? getDefaultModel();
    this.defaultThreshold = config?.defaultThreshold ?? 70;
  }

  // ─── Assess ─────────────────────────────────────────────────────

  async assess(task: Task, result: TaskResult): Promise<QualityReport> {
    const threshold = PRIORITY_THRESHOLDS[task.priority] ?? this.defaultThreshold;

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: `You are a quality assessment expert. Evaluate the output of a completed task across four dimensions: completeness, accuracy, coherence, and relevance. Score each from 0-100. The quality threshold for this task is ${threshold} (priority: ${task.priority}). Set passesThreshold based on whether overallScore >= ${threshold}.`,
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\nPriority: ${task.priority}\n\nTask Result (success: ${result.success}):\n${JSON.stringify(result.output, null, 2)}\n${result.error ? `Error: ${result.error}` : ''}\n\nAssess the quality of this output.`,
        },
      ],
      tools: [QUALITY_REPORT_TOOL],
      tool_choice: { type: 'function', function: { name: 'quality_report' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      // Fallback: auto-fail for failed results, auto-pass for successful ones
      return this.fallbackReport(result, threshold);
    }

    const parsed = QualityReportSchema.parse(
      JSON.parse(rawToolCall.function.arguments),
    );

    // Override passesThreshold with our own threshold logic
    return {
      ...parsed,
      passesThreshold: parsed.overallScore >= threshold,
    };
  }

  // ─── Compare ────────────────────────────────────────────────────

  async compare(
    task: Task,
    results: TaskResult[],
  ): Promise<ComparisonReport> {
    if (results.length === 0) {
      return { rankings: [], bestIndex: -1 };
    }

    if (results.length === 1) {
      return {
        rankings: [{ taskResultIndex: 0, score: 100, reasoning: 'Only one result to compare.' }],
        bestIndex: 0,
      };
    }

    const resultsDescription = results
      .map((r, i) => `Result ${i} (success: ${r.success}):\n${JSON.stringify(r.output, null, 2)}${r.error ? `\nError: ${r.error}` : ''}`)
      .join('\n\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are a quality comparison expert. Compare multiple outputs for the same task and rank them by quality. Consider completeness, accuracy, coherence, and relevance.',
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\n\n${resultsDescription}\n\nRank these results from best to worst.`,
        },
      ],
      tools: [COMPARISON_TOOL],
      tool_choice: { type: 'function', function: { name: 'compare_results' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      // Fallback: prefer first successful result
      const rankings = results.map((r, i) => ({
        taskResultIndex: i,
        score: r.success ? 70 : 30,
        reasoning: r.success ? 'Successful result' : 'Failed result',
      }));
      rankings.sort((a, b) => b.score - a.score);
      return { rankings, bestIndex: rankings[0].taskResultIndex };
    }

    const parsed = ComparisonSchema.parse(
      JSON.parse(rawToolCall.function.arguments),
    );

    // Sort rankings by score descending
    parsed.rankings.sort((a, b) => b.score - a.score);
    return parsed;
  }

  // ─── Validate Workflow Output ──────────────────────────────────

  async validateWorkflowOutput(
    workflow: Workflow,
    finalOutput: unknown,
  ): Promise<QualityReport> {
    const threshold = this.defaultThreshold;

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content: `You are a quality assessment expert. Evaluate whether a workflow's final output satisfies the original workflow description and goals. The quality threshold is ${threshold}. Score across completeness, accuracy, coherence, and relevance (0-100 each). Set passesThreshold based on whether overallScore >= ${threshold}.`,
        },
        {
          role: 'user',
          content: `Workflow: ${workflow.name}\nDescription: ${workflow.description}\nNodes: ${workflow.nodes.map((n) => n.taskTemplate.name).join(', ')}\n\nFinal Output:\n${JSON.stringify(finalOutput, null, 2)}\n\nDoes this output satisfy the workflow's goals?`,
        },
      ],
      tools: [QUALITY_REPORT_TOOL],
      tool_choice: { type: 'function', function: { name: 'quality_report' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      return this.fallbackReport(
        { taskId: workflow.id, success: true, output: {}, duration: 0 },
        threshold,
      );
    }

    const parsed = QualityReportSchema.parse(
      JSON.parse(rawToolCall.function.arguments),
    );

    return {
      ...parsed,
      passesThreshold: parsed.overallScore >= threshold,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────

  private fallbackReport(result: TaskResult, threshold: number): QualityReport {
    const score = result.success ? 65 : 20;
    return {
      overallScore: score,
      dimensions: {
        completeness: score,
        accuracy: score,
        coherence: score,
        relevance: score,
      },
      issues: result.success
        ? []
        : [
            {
              severity: 'high',
              description: result.error ?? 'Task failed',
              suggestion: 'Review the error and retry with corrected input.',
            },
          ],
      passesThreshold: score >= threshold,
      improvementSuggestions: result.success
        ? []
        : ['Fix the error that caused the task to fail.'],
    };
  }
}
