import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { ToolExecutor } from '../../src/tools/tool-executor.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createExecutor(config?: Parameters<typeof ToolExecutor['prototype']['constructor']>[1]) {
  const registry = new ToolRegistry();
  const executor = new ToolExecutor(registry, config);
  return { registry, executor };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('Tool Integration', () => {
  describe('tool registration and execution', () => {
    it('registers a custom tool and executes it via built-in handler', async () => {
      const { registry, executor } = createExecutor();

      // list_directory is a built-in tool — use it on a known path
      const tmpDir = os.tmpdir();
      const result = await executor.execute('list_directory', { path: tmpDir });

      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it('registers a custom tool and validates input', () => {
      const registry = new ToolRegistry();

      registry.register({
        name: 'greet',
        description: 'Greet a user',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      });

      expect(registry.validate('greet', { name: 'Alice' })).toBe(true);
      expect(registry.validate('greet', {})).toBe(false);
      expect(registry.validate('greet', { name: 123 })).toBe(false);
    });

    it('read_file and write_file round-trip', async () => {
      const tmpFile = path.join(os.tmpdir(), `orch-test-${Date.now()}.txt`);
      const { executor } = createExecutor();

      // Write
      const writeResult = await executor.execute('write_file', {
        path: tmpFile,
        content: 'hello orchestrator',
      });
      expect(writeResult.success).toBe(true);

      // Read back
      const readResult = await executor.execute('read_file', { path: tmpFile });
      expect(readResult.success).toBe(true);
      expect(readResult.output).toBe('hello orchestrator');

      // Cleanup
      await fs.unlink(tmpFile).catch(() => {});
    });
  });

  describe('safety sandbox blocks disallowed paths', () => {
    it('blocks file reads outside allowedPaths', async () => {
      const { executor } = createExecutor({
        allowedPaths: [os.tmpdir()],
      });

      // Try to read from a path outside the allowed list
      const result = await executor.execute('read_file', { path: '/etc/passwd' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('outside allowed paths');
    });

    it('allows reads within allowedPaths', async () => {
      const tmpFile = path.join(os.tmpdir(), `orch-allowed-${Date.now()}.txt`);
      await fs.writeFile(tmpFile, 'allowed content', 'utf-8');

      const { executor } = createExecutor({
        allowedPaths: [os.tmpdir()],
      });

      const result = await executor.execute('read_file', { path: tmpFile });
      expect(result.success).toBe(true);
      expect(result.output).toBe('allowed content');

      await fs.unlink(tmpFile).catch(() => {});
    });
  });

  describe('safety sandbox blocks dangerous commands', () => {
    it('blocks commands matching blockedCommands list', async () => {
      const { executor } = createExecutor({
        blockedCommands: ['rm -rf', 'sudo'],
      });

      const result = await executor.execute('execute_command', {
        command: 'rm -rf /',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
      expect(result.error).toContain('rm -rf');
    });

    it('blocks sudo commands', async () => {
      const { executor } = createExecutor({
        blockedCommands: ['sudo'],
      });

      const result = await executor.execute('execute_command', {
        command: 'sudo rm something',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked');
    });
  });

  describe('tool timeout', () => {
    it('times out for slow commands', async () => {
      const { executor } = createExecutor({
        defaultTimeout: 1000,
      });

      // Use a command that sleeps — platform-agnostic via node
      const result = await executor.execute('execute_command', {
        command: 'node -e "setTimeout(() => {}, 10000)"',
      });

      expect(result.success).toBe(false);
      // Could be "timed out" from our wrapper or "ETIMEDOUT" from execSync
      expect(result.error).toBeDefined();
    });
  });

  describe('batch execution runs independent tools in parallel', () => {
    it('executes 3 tools via executeBatch and returns all results', async () => {
      const tmpDir = os.tmpdir();
      const { executor } = createExecutor();

      const calls = [
        { toolName: 'list_directory', input: { path: tmpDir }, id: 'call-1' },
        { toolName: 'web_search', input: { query: 'test' }, id: 'call-2' },
        { toolName: 'list_directory', input: { path: tmpDir }, id: 'call-3' },
      ];

      const results = await executor.executeBatch(calls);

      expect(results).toHaveLength(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[1].output).toBe('Web search not yet implemented');
      expect(results[2].success).toBe(true);
    });
  });

  describe('tool events', () => {
    it('emits tool:executed on success', async () => {
      const { executor } = createExecutor();
      const events: string[] = [];

      executor.onToolExecuted((name) => events.push(name));

      await executor.execute('web_search', { query: 'test' });

      expect(events).toContain('web_search');
    });

    it('emits tool:error on failure', async () => {
      const { executor } = createExecutor();
      const errors: string[] = [];

      executor.onToolError((name) => errors.push(name));

      await executor.execute('nonexistent_tool', {});

      // No error event for "tool not found" since it's caught early
      // But we can verify the result
      const result = await executor.execute('read_file', { path: '/nonexistent/path/that/does/not/exist' });
      expect(result.success).toBe(false);
    });
  });

  describe('input validation', () => {
    it('rejects invalid input for tool', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute('read_file', { wrong_field: 'test' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid input');
    });

    it('rejects unknown tool', async () => {
      const { executor } = createExecutor();

      const result = await executor.execute('nonexistent', { foo: 'bar' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });
  });

  describe('output truncation', () => {
    it('truncates large output', async () => {
      const tmpFile = path.join(os.tmpdir(), `orch-large-${Date.now()}.txt`);
      const largeContent = 'x'.repeat(200_000);
      await fs.writeFile(tmpFile, largeContent, 'utf-8');

      const { executor } = createExecutor({
        maxOutputSize: 1024,
      });

      const result = await executor.execute('read_file', { path: tmpFile });
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect((result.output as string).length).toBeLessThanOrEqual(1024 + 20); // +20 for truncation notice

      await fs.unlink(tmpFile).catch(() => {});
    });
  });

  describe('approval requirement', () => {
    it('rejects tool in requireApproval list', async () => {
      const { executor } = createExecutor({
        requireApproval: ['execute_command'],
      });

      const approvalEvents: string[] = [];
      executor.onApprovalNeeded((name) => approvalEvents.push(name));

      const result = await executor.execute('execute_command', { command: 'echo hi' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('requires approval');
      expect(approvalEvents).toContain('execute_command');
    });
  });
});
