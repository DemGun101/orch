#!/usr/bin/env node

import { Orchestrator } from '../core/orchestrator.js';

// ─── CLI Entry Point ────────────────────────────────────────────────
// Usage: cowork "Add auth to my Next.js app"

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
cowork - Orchestrate parallel Claude agents for complex tasks

Usage:
  cowork "<task description>"
  cowork --concurrency 3 "<task description>"
  cowork --model claude-sonnet-4-6 "<task description>"

Options:
  --concurrency, -c  Max concurrent agents (default: 5)
  --model, -m        Default model for worker agents (default: claude-sonnet-4-6)
  --planner-model    Model for the planning agent (default: claude-opus-4-6)
  --timeout, -t      Default timeout per agent in seconds (default: 600)
  --help, -h         Show this help
`);
    process.exit(0);
  }

  // Parse flags
  let concurrency = 5;
  let model = 'claude-sonnet-4-6';
  let plannerModel = 'claude-opus-4-6';
  let timeout = 600_000;
  let taskDescription = '';

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--concurrency':
      case '-c':
        concurrency = parseInt(args[++i], 10);
        break;
      case '--model':
      case '-m':
        model = args[++i];
        break;
      case '--planner-model':
        plannerModel = args[++i];
        break;
      case '--timeout':
      case '-t':
        timeout = parseInt(args[++i], 10) * 1000;
        break;
      default:
        taskDescription = args[i];
    }
  }

  if (!taskDescription) {
    console.error('Error: No task description provided.');
    process.exit(1);
  }

  console.log(`\n  cowork v2.0\n`);
  console.log(`  Task: ${taskDescription}`);
  console.log(`  Model: ${model} | Planner: ${plannerModel} | Concurrency: ${concurrency}\n`);

  // Create and run orchestrator
  const orchestrator = new Orchestrator({
    maxConcurrency: concurrency,
    defaultModel: model,
    plannerModel,
    defaultTimeout: timeout,
    cwd: process.cwd(),
  });

  // Progress indicator
  const spinner = ['|', '/', '-', '\\'];
  let spinIdx = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r  Working... ${spinner[spinIdx++ % spinner.length]}`);
  }, 200);

  try {
    const result = await orchestrator.run(taskDescription);

    clearInterval(interval);
    process.stdout.write('\r');

    if (result.success) {
      console.log(`  Done! (${(result.duration / 1000).toFixed(1)}s)\n`);

      const output = result.output as Record<string, unknown>;
      console.log(`  Plan: ${output.plan}`);
      console.log(`  Nodes: ${output.nodesCompleted}/${output.nodesTotal} completed`);

      const files = output.filesModified as string[] | undefined;
      if (files && files.length > 0) {
        console.log(`  Files modified:`);
        for (const f of files) {
          console.log(`    - ${f}`);
        }
      }

      if (result.tokenUsage) {
        const total = result.tokenUsage.input + result.tokenUsage.output;
        console.log(`  Tokens: ${total.toLocaleString()} (${result.tokenUsage.input.toLocaleString()} in, ${result.tokenUsage.output.toLocaleString()} out)`);
      }

      console.log();
    } else {
      console.error(`  Failed: ${result.error}\n`);
      process.exit(1);
    }
  } catch (error) {
    clearInterval(interval);
    process.stdout.write('\r');
    console.error(`  Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Fatal: ${error}`);
  process.exit(1);
});
