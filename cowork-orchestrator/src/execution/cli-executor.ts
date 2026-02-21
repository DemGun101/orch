import { spawn } from 'node:child_process';
import type { ExecutionAgentConfig, SDKExecutionResult } from '../core/types.js';
import { ResultParser } from './result-parser.js';

// ─── CLI Executor ─────────────────────────────────────────────────────
// Runs prompts by spawning `claude -p <prompt> --output-format stream-json`.
// Collects line-delimited JSON output and parses it via ResultParser.

export class CLIExecutor {
  private readonly parser = new ResultParser();

  execute(prompt: string, config: ExecutionAgentConfig): Promise<SDKExecutionResult> {
    const start = Date.now();

    return new Promise<SDKExecutionResult>((resolve) => {
      const args = ['-p', prompt, '--output-format', 'stream-json'];

      if (config.model) {
        args.push('--model', config.model);
      }

      const proc = spawn('claude', args, {
        env: process.env as Record<string, string>,
        shell: false,
      });

      const chunks: string[] = [];

      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk.toString());
      });

      let stderrText = '';
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrText += chunk.toString();
      });

      proc.on('error', (err) => {
        resolve({
          sessionId: '',
          mode: 'cli',
          output: '',
          messages: [],
          durationMs: Date.now() - start,
          success: false,
          error: `Failed to spawn claude CLI: ${err.message}`,
        });
      });

      proc.on('close', (code) => {
        const raw = chunks.join('');
        if (code !== 0 && raw.trim().length === 0) {
          resolve({
            sessionId: '',
            mode: 'cli',
            output: '',
            messages: [],
            durationMs: Date.now() - start,
            success: false,
            error: stderrText || `CLI exited with code ${String(code)}`,
          });
          return;
        }
        const result = this.parser.parseCLIOutput(raw, '', Date.now() - start);
        resolve(result);
      });
    });
  }
}
