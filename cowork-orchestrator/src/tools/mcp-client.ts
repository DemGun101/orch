import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'eventemitter3';
import type { ToolDefinition } from '../core/types.js';
import type { ToolRegistry } from './tool-registry.js';

// ─── Types ─────────────────────────────────────────────────────────

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface ResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface MCPClientEvents {
  'connected': () => void;
  'disconnected': () => void;
  'error': (error: string) => void;
  'notification': (method: string, params: unknown) => void;
}

const REQUEST_TIMEOUT = 30_000;

// ─── MCP Client ────────────────────────────────────────────────────

export class MCPClient {
  private registry?: ToolRegistry;
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private connected = false;
  private serverCapabilities: unknown = null;
  private emitter = new EventEmitter<MCPClientEvents>();

  constructor(registry?: ToolRegistry) {
    this.registry = registry;
  }

  // ── Event helpers ───────────────────────────────────────────────

  onConnected(handler: () => void): () => void {
    this.emitter.on('connected', handler);
    return () => this.emitter.off('connected', handler);
  }

  onDisconnected(handler: () => void): () => void {
    this.emitter.on('disconnected', handler);
    return () => this.emitter.off('disconnected', handler);
  }

  onError(handler: (error: string) => void): () => void {
    this.emitter.on('error', handler);
    return () => this.emitter.off('error', handler);
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.emitter.on('notification', handler);
    return () => this.emitter.off('notification', handler);
  }

  // ── Connection lifecycle ────────────────────────────────────────

  async connect(serverConfig: MCPServerConfig): Promise<void> {
    this.process = spawn(serverConfig.command, serverConfig.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...serverConfig.env },
    });

    this.process.stdout!.on('data', (chunk: Buffer) => this.onData(chunk));
    this.process.stderr!.on('data', (chunk: Buffer) => {
      this.emitter.emit('error', `MCP stderr: ${chunk.toString()}`);
    });
    this.process.on('close', () => {
      this.connected = false;
      this.rejectAllPending('MCP process exited');
      this.emitter.emit('disconnected');
    });
    this.process.on('error', (err) => {
      this.emitter.emit('error', `MCP process error: ${err.message}`);
    });

    // Initialize handshake
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'cowork-orchestrator', version: '1.0.0' },
    });
    this.serverCapabilities = initResult;

    await this.sendNotification('notifications/initialized');
    this.connected = true;
    this.emitter.emit('connected');

    // Auto-register tools
    if (this.registry) {
      const tools = await this.listTools();
      for (const tool of tools) {
        this.registry.register(tool);
      }
    }
  }

  async disconnect(): Promise<void> {
    if (!this.process) return;
    this.connected = false;
    this.rejectAllPending('Client disconnecting');

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.process?.kill('SIGKILL');
        resolve();
      }, 5000);

      this.process!.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      this.process!.kill('SIGTERM');
      this.process = null;
    });
  }

  isConnected(): boolean {
    return this.connected && this.process !== null;
  }

  getServerCapabilities(): unknown {
    return this.serverCapabilities;
  }

  // ── MCP operations ──────────────────────────────────────────────

  async listTools(): Promise<ToolDefinition[]> {
    const result = (await this.sendRequest('tools/list')) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };

    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    const result = (await this.sendRequest('tools/call', { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>;
    };

    // Return text from first text content block, or the full result
    const textBlock = result.content?.find((c) => c.type === 'text');
    return textBlock?.text ?? result;
  }

  async listResources(): Promise<Resource[]> {
    const result = (await this.sendRequest('resources/list')) as {
      resources?: Resource[];
    };
    return result.resources ?? [];
  }

  async readResource(uri: string): Promise<ResourceContent> {
    const result = (await this.sendRequest('resources/read', { uri })) as {
      contents?: ResourceContent[];
    };
    const content = result.contents?.[0];
    if (!content) throw new Error(`No content returned for resource: ${uri}`);
    return content;
  }

  // ── JSON-RPC transport ──────────────────────────────────────────

  private sendRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) {
        return reject(new Error('MCP process not connected'));
      }

      const id = this.nextId++;
      const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };

      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method} (id=${id})`));
      }, REQUEST_TIMEOUT);

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.process.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  private sendNotification(method: string, params?: unknown): void {
    if (!this.process?.stdin?.writable) return;
    const notification: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) };
    this.process.stdin.write(JSON.stringify(notification) + '\n');
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString();

    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).trim();
      this.buffer = this.buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line) as JsonRpcResponse | JsonRpcNotification;

        if ('id' in msg && msg.id !== undefined) {
          // Response to a request
          const pending = this.pending.get(msg.id as number);
          if (pending) {
            this.pending.delete(msg.id as number);
            const response = msg as JsonRpcResponse;
            if (response.error) {
              pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
            } else {
              pending.resolve(response.result);
            }
          }
        } else if ('method' in msg) {
          // Server notification
          this.emitter.emit('notification', msg.method, (msg as JsonRpcNotification).params);
        }
      } catch {
        // Ignore non-JSON lines (e.g. server debug output)
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }
}
