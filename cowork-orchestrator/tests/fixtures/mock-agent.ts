import { BaseAgent } from '../../src/agents/base-agent.js';
import type { AgentConfig, AgentCapability, Task, TaskResult } from '../../src/core/types.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';

// ─── Custom Execute Function Type ───────────────────────────────────

type ExecuteFn = (task: Task) => Promise<TaskResult>;

// ─── Mock Agent ─────────────────────────────────────────────────────

export class MockAgent extends BaseAgent {
  private executeFn: ExecuteFn;

  constructor(config?: Partial<AgentConfig>, executeFn?: ExecuteFn) {
    super(createMockAgentConfig(config));

    this.executeFn =
      executeFn ??
      (async (task: Task): Promise<TaskResult> => ({
        taskId: task.id,
        success: true,
        output: { result: `mock response for ${task.name}` },
        duration: 100,
      }));
  }

  async execute(task: Task): Promise<TaskResult> {
    return this.executeFn(task);
  }
}

// ─── Config Factory ─────────────────────────────────────────────────

export function createMockAgentConfig(
  overrides?: Partial<AgentConfig>,
): AgentConfig {
  return {
    id: overrides?.id ?? uuidv4(),
    name: overrides?.name ?? 'mock-agent',
    role: overrides?.role ?? 'general',
    systemPrompt: overrides?.systemPrompt ?? 'You are a test mock agent.',
    capabilities: overrides?.capabilities ?? [createMockCapability()],
    maxConcurrentTasks: overrides?.maxConcurrentTasks ?? 3,
    model: overrides?.model ?? 'claude-sonnet-4-5-20250929',
    temperature: overrides?.temperature,
    maxTokens: overrides?.maxTokens,
    tools: overrides?.tools,
  };
}

// ─── Capability Factory ─────────────────────────────────────────────

export function createMockCapability(
  name: string = 'general',
  description: string = 'General purpose tasks',
): AgentCapability {
  return {
    name,
    description,
    inputSchema: z.object({ query: z.string() }),
    outputSchema: z.object({ result: z.string() }),
  };
}
