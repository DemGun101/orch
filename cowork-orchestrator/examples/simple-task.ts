// Simple example: One agent, one task
// Usage: npx tsx examples/simple-task.ts
// Set GROQ_API_KEY or GEMINI_API_KEY in .env

import { OrchestrationEngine, getDefaultModel } from '../src/index.js';
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

  // Register a general-purpose agent
  engine.registerAgent({
    id: 'general-1',
    name: 'General Assistant',
    role: 'general',
    systemPrompt: 'You are a helpful assistant. Complete tasks concisely and accurately.',
    capabilities: [
      { name: 'general', description: 'General purpose tasks', inputSchema: {} as any, outputSchema: {} as any },
    ],
    maxConcurrentTasks: 3,
    model,
  });

  const result = await engine.submitTask({
    name: 'summarize-typescript',
    description: 'Summarize the key benefits of TypeScript over JavaScript in 3 bullet points',
    priority: 'medium',
    input: {},
  });

  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('\nDashboard:\n', engine.getDashboard());

  await engine.stop();
}

main().catch(console.error);
