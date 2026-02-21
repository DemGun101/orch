import OpenAI from 'openai';
import { z } from 'zod';
import type { Task, Workflow } from '../core/types.js';
import type { BaseAgent } from '../agents/base-agent.js';
import { getDefaultModel } from '../llm/client.js';
import type { ChatTool } from '../llm/client.js';

// ─── Types ───────────────────────────────────────────────────────────

export interface AgentSelectionResult {
  selectedAgentId: string;
  reasoning: string;
  confidence: number;
  alternativeId?: string;
  needsHumanReview?: boolean;
}

export interface RankedAgent {
  agentId: string;
  score: number;
  reasoning: string;
}

export interface TeamAssignment {
  nodeId: string;
  agentId: string;
  reasoning: string;
}

// ─── LRU Cache ───────────────────────────────────────────────────────

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class LRUCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;
  private ttlMs: number;

  constructor(maxSize: number, ttlMs: number) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key)
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

// ─── Zod Validation Schemas ──────────────────────────────────────────

const SelectionResponseSchema = z.object({
  selectedAgentId: z.string(),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
  alternativeId: z.string().optional(),
});

const RankingResponseSchema = z.object({
  rankings: z.array(
    z.object({
      agentId: z.string(),
      score: z.number().min(0).max(100),
      reasoning: z.string(),
    }),
  ),
});

const TeamResponseSchema = z.object({
  assignments: z.array(
    z.object({
      nodeId: z.string(),
      agentId: z.string(),
      reasoning: z.string(),
    }),
  ),
});

// ─── OpenAI Tool Definitions ────────────────────────────────────────

const SELECT_AGENT_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'select_agent',
    description: 'Select the best agent for a task from the candidates.',
    parameters: {
      type: 'object' as const,
      properties: {
        selectedAgentId: {
          type: 'string',
          description: 'ID of the selected agent',
        },
        reasoning: {
          type: 'string',
          description: 'Why this agent was chosen',
        },
        confidence: {
          type: 'number',
          description: 'Confidence score from 0 to 1',
        },
        alternativeId: {
          type: 'string',
          description: 'ID of a backup agent if the primary is unavailable',
        },
      },
      required: ['selectedAgentId', 'reasoning', 'confidence'],
    },
  },
};

const RANK_AGENTS_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'rank_agents',
    description: 'Rank all candidate agents for a task by suitability.',
    parameters: {
      type: 'object' as const,
      properties: {
        rankings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              agentId: { type: 'string' },
              score: {
                type: 'number',
                description: 'Suitability score from 0 to 100',
              },
              reasoning: { type: 'string' },
            },
            required: ['agentId', 'score', 'reasoning'],
          },
        },
      },
      required: ['rankings'],
    },
  },
};

const SUGGEST_TEAM_TOOL: ChatTool = {
  type: 'function',
  function: {
    name: 'suggest_team',
    description:
      'Assign agents to workflow nodes considering load balancing and specialization.',
    parameters: {
      type: 'object' as const,
      properties: {
        assignments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              nodeId: {
                type: 'string',
                description: 'Workflow node ID',
              },
              agentId: {
                type: 'string',
                description: 'Assigned agent ID',
              },
              reasoning: { type: 'string' },
            },
            required: ['nodeId', 'agentId', 'reasoning'],
          },
        },
      },
      required: ['assignments'],
    },
  },
};

// ─── Agent Selector ──────────────────────────────────────────────────

export class AgentSelector {
  private client: OpenAI;
  private model: string;
  private cache: LRUCache<AgentSelectionResult>;

  constructor(client: OpenAI, model?: string) {
    this.client = client;
    this.model = model ?? getDefaultModel();
    this.cache = new LRUCache<AgentSelectionResult>(100, 5 * 60 * 1000);
  }

  // ─── Select Agent ────────────────────────────────────────────────

  async selectAgent(
    task: Task,
    candidates: BaseAgent[],
  ): Promise<AgentSelectionResult> {
    if (candidates.length === 0) {
      return {
        selectedAgentId: '',
        reasoning: 'No candidates available.',
        confidence: 0,
        needsHumanReview: true,
      };
    }

    if (candidates.length === 1) {
      return {
        selectedAgentId: candidates[0].id,
        reasoning: 'Only one candidate available.',
        confidence: 1,
      };
    }

    // Check cache
    const cacheKey = this.buildCacheKey(task, candidates);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const candidateDescriptions = candidates
      .map((a) => {
        const stats = a.getStats();
        return `- ID: ${a.id}, Name: ${a.name}, Role: ${a.role}, Capabilities: [${a['config'].capabilities.map((c: { name: string }) => c.name).join(', ')}], Load: ${(a.getLoad() * 100).toFixed(0)}%, Completed: ${stats.tasksCompleted}, Failed: ${stats.tasksFailed}, AvgTime: ${stats.avgExecutionTime.toFixed(0)}ms, ErrorRate: ${(stats.errorRate * 100).toFixed(1)}%`;
      })
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at matching tasks to the best available agent. Consider capabilities, current load, past performance, and error rates when making your selection.',
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\nPriority: ${task.priority}\n\nCandidate agents:\n${candidateDescriptions}\n\nSelect the best agent for this task.`,
        },
      ],
      tools: [SELECT_AGENT_TOOL],
      tool_choice: { type: 'function', function: { name: 'select_agent' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') {
      return {
        selectedAgentId: candidates[0].id,
        reasoning: 'Fallback to first candidate (no structured response).',
        confidence: 0.3,
        needsHumanReview: true,
      };
    }

    const parsed = SelectionResponseSchema.parse(JSON.parse(rawToolCall.function.arguments));
    const result: AgentSelectionResult = {
      ...parsed,
      needsHumanReview: parsed.confidence < 0.5,
    };

    this.cache.set(cacheKey, result);
    return result;
  }

  // ─── Rank Agents ─────────────────────────────────────────────────

  async rankAgents(
    task: Task,
    candidates: BaseAgent[],
  ): Promise<RankedAgent[]> {
    if (candidates.length === 0) return [];

    const candidateDescriptions = candidates
      .map((a) => {
        const stats = a.getStats();
        return `- ID: ${a.id}, Name: ${a.name}, Role: ${a.role}, Capabilities: [${a['config'].capabilities.map((c: { name: string }) => c.name).join(', ')}], Load: ${(a.getLoad() * 100).toFixed(0)}%, ErrorRate: ${(stats.errorRate * 100).toFixed(1)}%`;
      })
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 2048,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at evaluating agent suitability. Rank all candidates by how well they match the task requirements. Score from 0 (worst) to 100 (best).',
        },
        {
          role: 'user',
          content: `Task: ${task.name}\nDescription: ${task.description}\nPriority: ${task.priority}\n\nCandidate agents:\n${candidateDescriptions}\n\nRank all agents by suitability for this task.`,
        },
      ],
      tools: [RANK_AGENTS_TOOL],
      tool_choice: { type: 'function', function: { name: 'rank_agents' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') return [];

    const parsed = RankingResponseSchema.parse(JSON.parse(rawToolCall.function.arguments));
    return parsed.rankings.sort((a, b) => b.score - a.score);
  }

  // ─── Suggest Team ────────────────────────────────────────────────

  async suggestTeam(
    workflow: Workflow,
    availableAgents: BaseAgent[],
  ): Promise<TeamAssignment[]> {
    if (availableAgents.length === 0 || workflow.nodes.length === 0) return [];

    const nodeDescriptions = workflow.nodes
      .map((n) => {
        const caps = n.agentSelector?.requiredCapabilities?.join(', ') ?? 'any';
        return `- NodeID: ${n.id}, Task: ${n.taskTemplate.name}, Description: ${n.taskTemplate.description}, RequiredCapabilities: [${caps}]`;
      })
      .join('\n');

    const agentDescriptions = availableAgents
      .map((a) => {
        const stats = a.getStats();
        return `- ID: ${a.id}, Name: ${a.name}, Role: ${a.role}, Capabilities: [${a['config'].capabilities.map((c: { name: string }) => c.name).join(', ')}], Load: ${(a.getLoad() * 100).toFixed(0)}%, ErrorRate: ${(stats.errorRate * 100).toFixed(1)}%`;
      })
      .join('\n');

    const edgeDescriptions = workflow.edges
      .map((e) => `  ${e.from} → ${e.to}${e.condition ? ` (if: ${e.condition})` : ''}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: 4096,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert at team assembly for workflows. Assign agents to workflow nodes considering: capability match, load balancing across agents, specialization, and minimizing context switches (prefer reusing the same agent for related nodes).',
        },
        {
          role: 'user',
          content: `Workflow: ${workflow.name}\nDescription: ${workflow.description}\n\nNodes:\n${nodeDescriptions}\n\nEdges (dependencies):\n${edgeDescriptions || '  (none)'}\n\nAvailable agents:\n${agentDescriptions}\n\nAssign an agent to each node.`,
        },
      ],
      tools: [SUGGEST_TEAM_TOOL],
      tool_choice: { type: 'function', function: { name: 'suggest_team' } },
    }) as OpenAI.ChatCompletion;

    const rawToolCall = response.choices[0]?.message?.tool_calls?.[0];

    if (!rawToolCall || rawToolCall.type !== 'function') return [];

    const parsed = TeamResponseSchema.parse(JSON.parse(rawToolCall.function.arguments));
    return parsed.assignments;
  }

  // ─── Cache Helpers ───────────────────────────────────────────────

  clearCache(): void {
    this.cache.clear();
  }

  get cacheSize(): number {
    return this.cache.size;
  }

  // ─── Private ─────────────────────────────────────────────────────

  private buildCacheKey(task: Task, candidates: BaseAgent[]): string {
    const agentIds = candidates
      .map((a) => a.id)
      .sort()
      .join(',');
    return `${task.name}::${agentIds}`;
  }
}
