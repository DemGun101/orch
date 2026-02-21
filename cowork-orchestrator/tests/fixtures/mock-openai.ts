import { vi } from 'vitest';
import type OpenAI from 'openai';

// ─── Response Builders ──────────────────────────────────────────────

function makeToolCompletion(
  functionName: string,
  args: Record<string, unknown>,
): OpenAI.ChatCompletion {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gemini-2.0-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_mock',
              type: 'function',
              function: {
                name: functionName,
                arguments: JSON.stringify(args),
              },
            },
          ],
          refusal: null,
        },
        finish_reason: 'tool_calls',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  } as unknown as OpenAI.ChatCompletion;
}

function makeTextCompletion(content: string): OpenAI.ChatCompletion {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'gemini-2.0-flash',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          refusal: null,
        },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  } as unknown as OpenAI.ChatCompletion;
}

// ─── Default Responses ──────────────────────────────────────────────

const DEFAULT_RESPONSES = new Map<string, Record<string, unknown>>([
  [
    'decompose_task',
    {
      subtasks: [
        {
          name: 'Research',
          description: 'Research the topic',
          requiredCapability: 'research',
          priority: 'high',
          estimatedComplexity: 'moderate',
          dependencies: [],
        },
        {
          name: 'Write',
          description: 'Write the content',
          requiredCapability: 'writing',
          priority: 'medium',
          estimatedComplexity: 'moderate',
          dependencies: ['Research'],
        },
        {
          name: 'Review',
          description: 'Review the output',
          requiredCapability: 'review',
          priority: 'medium',
          estimatedComplexity: 'simple',
          dependencies: ['Write'],
        },
      ],
      reasoning: 'Task broken into research, writing, and review phases.',
      parallelGroups: [['Research'], ['Write'], ['Review']],
    },
  ],
  [
    'select_agent',
    {
      selectedAgentId: 'agent-1',
      reasoning: 'Best capability match with lowest load',
      confidence: 0.85,
      alternativeId: 'agent-2',
    },
  ],
  [
    'rank_agents',
    {
      rankings: [
        { agentId: 'agent-1', score: 90, reasoning: 'Best match' },
        { agentId: 'agent-2', score: 70, reasoning: 'Good alternative' },
      ],
    },
  ],
  [
    'suggest_team',
    {
      assignments: [
        { nodeId: 'node-1', agentId: 'agent-1', reasoning: 'Best for this task' },
      ],
    },
  ],
  [
    'detect_conflicts',
    {
      conflicts: [],
    },
  ],
  [
    'resolve_conflict',
    {
      strategy: 'MERGE',
      resolvedOutput: { merged: true },
      reasoning: 'Combined best parts of both outputs',
    },
  ],
  [
    'prevent_conflict',
    {
      riskLevel: 'low',
      guardrails: ['Use separate output directories', 'Avoid shared state'],
    },
  ],
  [
    'quality_report',
    {
      overallScore: 85,
      dimensions: {
        completeness: 90,
        accuracy: 85,
        coherence: 80,
        relevance: 85,
      },
      issues: [],
      passesThreshold: true,
      improvementSuggestions: ['Consider adding more examples.'],
    },
  ],
  [
    'compare_results',
    {
      rankings: [
        { taskResultIndex: 0, score: 90, reasoning: 'Best quality' },
        { taskResultIndex: 1, score: 70, reasoning: 'Good but less complete' },
      ],
      bestIndex: 0,
    },
  ],
  [
    'suggest_workflow',
    {
      name: 'Test Workflow',
      description: 'A test workflow',
      nodes: [
        {
          name: 'Step 1',
          description: 'First step',
          requiredCapability: 'research',
          priority: 'high',
        },
        {
          name: 'Step 2',
          description: 'Second step',
          requiredCapability: 'writing',
          priority: 'medium',
        },
      ],
      edges: [{ fromNode: 'Step 1', toNode: 'Step 2' }],
    },
  ],
]);

// ─── Mock Factory ───────────────────────────────────────────────────

export function createMockOpenAI(responses?: Map<string, unknown>) {
  const merged = new Map<string, unknown>([
    ...DEFAULT_RESPONSES,
    ...(responses ?? []),
  ]);

  const createSpy = vi.fn().mockImplementation(async (params: Record<string, unknown>) => {
    const toolChoice = params.tool_choice as
      | { type: string; function: { name: string } }
      | undefined;
    const toolName = toolChoice?.function?.name;

    if (!toolName) {
      // Text-only response (e.g., estimateComplexity)
      return makeTextCompletion('moderate');
    }

    const responseData = merged.get(toolName);
    if (!responseData) {
      return makeTextCompletion('No matching mock response');
    }

    return makeToolCompletion(toolName, responseData as Record<string, unknown>);
  });

  const client = {
    chat: {
      completions: {
        create: createSpy,
      },
    },
  } as unknown as OpenAI;

  return { client, createSpy };
}

// Re-export builders for custom test setups
export { makeToolCompletion, makeTextCompletion };
