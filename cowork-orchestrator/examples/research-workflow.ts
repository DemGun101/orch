// Multi-agent workflow example: Research → Analyze (parallel) → Write → Review
// Usage: npx tsx examples/research-workflow.ts
// Set GROQ_API_KEY or GEMINI_API_KEY in .env

import { v4 as uuidv4 } from 'uuid';
import { OrchestrationEngine, getDefaultModel } from '../src/index.js';
import type { Workflow, TaskPriority } from '../src/core/types.js';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
  if (!process.env.GROQ_API_KEY && !process.env.GEMINI_API_KEY) {
    console.error('Please set GROQ_API_KEY or GEMINI_API_KEY in your .env file');
    process.exit(1);
  }

  const engine = new OrchestrationEngine({
    persistence: { enabled: true, dbPath: '/tmp/orchestrator.db' },
  });
  await engine.start();

  const model = getDefaultModel();

  // ── Register 4 specialized agents ───────────────────────────────

  engine.registerAgent({
    id: 'researcher-1',
    name: 'Researcher',
    role: 'researcher',
    systemPrompt: 'You are a thorough research assistant. Gather comprehensive information on the given topic.',
    capabilities: [
      { name: 'research', description: 'Research topics', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'search', description: 'Search for information', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 2,
    model,
    tools: [{ name: 'web_search', description: 'Search the web', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  });

  engine.registerAgent({
    id: 'analyst-1',
    name: 'Analyst',
    role: 'analyst',
    systemPrompt: 'You are an analytical thinker. Analyze data and findings to extract insights and patterns.',
    capabilities: [
      { name: 'analysis', description: 'Analyze information', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'synthesis', description: 'Synthesize findings', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 2,
    model,
  });

  engine.registerAgent({
    id: 'writer-1',
    name: 'Writer',
    role: 'writer',
    systemPrompt: 'You are a skilled writer. Create clear, well-structured reports from analyzed findings.',
    capabilities: [
      { name: 'writing', description: 'Write reports and documents', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'drafting', description: 'Draft content', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 1,
    model,
    tools: [{ name: 'write_file', description: 'Write content to a file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }],
  });

  engine.registerAgent({
    id: 'reviewer-1',
    name: 'Reviewer',
    role: 'reviewer',
    systemPrompt: 'You are a quality reviewer. Check reports for accuracy, completeness, and clarity.',
    capabilities: [
      { name: 'review', description: 'Review and evaluate work', inputSchema: {} as any, outputSchema: {} as any },
      { name: 'quality-check', description: 'Assess quality of output', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 1,
    model,
  });

  // ── Define workflow DAG ─────────────────────────────────────────

  const topic = 'The impact of AI on software development in 2025';
  const taskDefaults = {
    priority: 'medium' as TaskPriority,
    input: { topic },
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 2 },
  };

  const workflow: Workflow = {
    id: uuidv4(),
    name: 'Research Report Workflow',
    description: `Produce a research report on: ${topic}`,
    status: 'pending',
    context: { topic },
    nodes: [
      {
        id: 'research',
        taskTemplate: {
          ...taskDefaults,
          name: 'Research Topic',
          description: `Research the topic: "${topic}". Gather key facts, trends, and data points.`,
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['research'] },
      },
      {
        id: 'analyze-a',
        taskTemplate: {
          ...taskDefaults,
          name: 'Analyze Findings - Perspective A',
          description: 'Analyze the research findings from a technical perspective: tools, frameworks, and productivity impacts.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['analysis'] },
      },
      {
        id: 'analyze-b',
        taskTemplate: {
          ...taskDefaults,
          name: 'Analyze Findings - Perspective B',
          description: 'Analyze the research findings from a human perspective: job market, skills evolution, and ethical considerations.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['analysis'] },
      },
      {
        id: 'write',
        taskTemplate: {
          ...taskDefaults,
          name: 'Write Draft Report',
          description: 'Write a comprehensive draft report combining both analysis perspectives into a cohesive narrative.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['writing'] },
      },
      {
        id: 'review',
        taskTemplate: {
          ...taskDefaults,
          name: 'Review Report',
          description: 'Review the draft report for accuracy, completeness, clarity, and provide improvement suggestions.',
        },
        agentSelector: { strategy: 'capability-match', requiredCapabilities: ['review'] },
      },
    ],
    edges: [
      { from: 'research', to: 'analyze-a' },
      { from: 'research', to: 'analyze-b' },
      { from: 'analyze-a', to: 'write' },
      { from: 'analyze-b', to: 'write' },
      { from: 'write', to: 'review' },
    ],
  };

  // ── Execute ─────────────────────────────────────────────────────

  console.log(`Starting workflow: ${workflow.name}`);
  console.log(`Topic: ${topic}\n`);

  const result = await engine.executeWorkflow(workflow);

  console.log('\n=== Workflow Result ===');
  console.log(`Success: ${result.success}`);
  console.log(`Nodes completed: ${result.nodesCompleted}/${result.nodesTotal}`);
  console.log(`Duration: ${result.duration}ms`);

  for (const [nodeId, nodeResult] of result.outputs) {
    console.log(`\n--- ${nodeId} ---`);
    const text = (nodeResult.output as Record<string, unknown>).text;
    if (typeof text === 'string') {
      console.log(text.slice(0, 500) + (text.length > 500 ? '...' : ''));
    }
  }

  console.log('\n=== Dashboard ===\n');
  console.log(engine.getDashboard());

  await engine.stop();
}

main().catch(console.error);
