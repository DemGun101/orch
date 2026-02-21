import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Task, AgentConfig, AgentMessage, AuditEntry } from '../core/types.js';

// ─── Filter Types ───────────────────────────────────────────────────

export interface TaskFilter {
  status?: string;
  assignedAgentId?: string;
  priority?: string;
}

export interface AuditLogFilter {
  eventType?: string;
  agentId?: string;
  taskId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface CheckpointData {
  id: string;
  workflowId: string;
  state: Record<string, unknown>;
  createdAt: string;
}

// ─── Error Type ─────────────────────────────────────────────────────

export class PersistenceError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PersistenceError';
  }
}

// ─── Persistence Layer ──────────────────────────────────────────────

export class PersistenceLayer {
  private db: Database.Database;

  constructor(dbPath: string) {
    try {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
    } catch (err) {
      throw new PersistenceError(
        `Failed to open database at ${dbPath}`,
        'constructor',
        err,
      );
    }
  }

  // ─── Schema Initialization ─────────────────────────────────────────

  initialize(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          data JSON NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS agents (
          id TEXT PRIMARY KEY,
          config JSON NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle'
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          data JSON NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          state JSON NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          agent_id TEXT,
          task_id TEXT,
          data JSON NOT NULL,
          timestamp TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS shared_memory (
          key TEXT PRIMARY KEY,
          value JSON NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS conversation_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          agent_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          timestamp TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_workflow ON checkpoints(workflow_id);
        CREATE INDEX IF NOT EXISTS idx_audit_event_type ON audit_log(event_type);
        CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversation_messages(agent_id);
      `);
    } catch (err) {
      throw new PersistenceError('Failed to initialize database schema', 'initialize', err);
    }
  }

  // ─── Tasks ──────────────────────────────────────────────────────────

  saveTask(task: Task): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO tasks (id, data, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      stmt.run(
        task.id,
        JSON.stringify(task),
        task.status,
        task.createdAt.toISOString(),
        task.updatedAt.toISOString(),
      );
    } catch (err) {
      throw new PersistenceError(`Failed to save task ${task.id}`, 'saveTask', err);
    }
  }

  getTask(id: string): Task | null {
    try {
      const stmt = this.db.prepare('SELECT data FROM tasks WHERE id = ?');
      const row = stmt.get(id) as { data: string } | undefined;
      if (!row) return null;
      return this.deserializeTask(row.data);
    } catch (err) {
      throw new PersistenceError(`Failed to get task ${id}`, 'getTask', err);
    }
  }

  updateTask(task: Task): void {
    try {
      const stmt = this.db.prepare(
        'UPDATE tasks SET data = ?, status = ?, updated_at = ? WHERE id = ?',
      );
      stmt.run(
        JSON.stringify(task),
        task.status,
        task.updatedAt.toISOString(),
        task.id,
      );
    } catch (err) {
      throw new PersistenceError(`Failed to update task ${task.id}`, 'updateTask', err);
    }
  }

  listTasks(filter?: TaskFilter): Task[] {
    try {
      let sql = 'SELECT data FROM tasks';
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.status) {
        conditions.push('status = ?');
        params.push(filter.status);
      }
      if (filter?.assignedAgentId) {
        conditions.push("json_extract(data, '$.assignedAgentId') = ?");
        params.push(filter.assignedAgentId);
      }
      if (filter?.priority) {
        conditions.push("json_extract(data, '$.priority') = ?");
        params.push(filter.priority);
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as { data: string }[];
      return rows.map((row) => this.deserializeTask(row.data));
    } catch (err) {
      throw new PersistenceError('Failed to list tasks', 'listTasks', err);
    }
  }

  deleteTask(id: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM tasks WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (err) {
      throw new PersistenceError(`Failed to delete task ${id}`, 'deleteTask', err);
    }
  }

  getSubtasks(parentTaskId: string): Task[] {
    try {
      const stmt = this.db.prepare(
        "SELECT data FROM tasks WHERE json_extract(data, '$.parentId') = ?",
      );
      const rows = stmt.all(parentTaskId) as { data: string }[];
      return rows.map((row) => this.deserializeTask(row.data));
    } catch (err) {
      throw new PersistenceError(
        `Failed to get subtasks for ${parentTaskId}`,
        'getSubtasks',
        err,
      );
    }
  }

  // ─── Agents ─────────────────────────────────────────────────────────

  saveAgent(config: AgentConfig, status: string = 'idle'): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO agents (id, config, status) VALUES (?, ?, ?)',
      );
      stmt.run(config.id, JSON.stringify(config), status);
    } catch (err) {
      throw new PersistenceError(`Failed to save agent ${config.id}`, 'saveAgent', err);
    }
  }

  getAgent(id: string): { config: AgentConfig; status: string } | null {
    try {
      const stmt = this.db.prepare('SELECT config, status FROM agents WHERE id = ?');
      const row = stmt.get(id) as { config: string; status: string } | undefined;
      if (!row) return null;
      return { config: JSON.parse(row.config) as AgentConfig, status: row.status };
    } catch (err) {
      throw new PersistenceError(`Failed to get agent ${id}`, 'getAgent', err);
    }
  }

  updateAgentStatus(id: string, status: string): void {
    try {
      const stmt = this.db.prepare('UPDATE agents SET status = ? WHERE id = ?');
      stmt.run(status, id);
    } catch (err) {
      throw new PersistenceError(`Failed to update agent status ${id}`, 'updateAgentStatus', err);
    }
  }

  listAgents(): { config: AgentConfig; status: string }[] {
    try {
      const stmt = this.db.prepare('SELECT config, status FROM agents');
      const rows = stmt.all() as { config: string; status: string }[];
      return rows.map((row) => ({
        config: JSON.parse(row.config) as AgentConfig,
        status: row.status,
      }));
    } catch (err) {
      throw new PersistenceError('Failed to list agents', 'listAgents', err);
    }
  }

  deleteAgent(id: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM agents WHERE id = ?');
      const result = stmt.run(id);
      return result.changes > 0;
    } catch (err) {
      throw new PersistenceError(`Failed to delete agent ${id}`, 'deleteAgent', err);
    }
  }

  // ─── Messages ───────────────────────────────────────────────────────

  saveMessage(message: AgentMessage): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO messages (id, data, timestamp) VALUES (?, ?, ?)',
      );
      stmt.run(message.id, JSON.stringify(message), message.timestamp.toISOString());
    } catch (err) {
      throw new PersistenceError(`Failed to save message ${message.id}`, 'saveMessage', err);
    }
  }

  getMessage(id: string): AgentMessage | null {
    try {
      const stmt = this.db.prepare('SELECT data FROM messages WHERE id = ?');
      const row = stmt.get(id) as { data: string } | undefined;
      if (!row) return null;
      return this.deserializeMessage(row.data);
    } catch (err) {
      throw new PersistenceError(`Failed to get message ${id}`, 'getMessage', err);
    }
  }

  listMessages(channel?: string): AgentMessage[] {
    try {
      let sql = 'SELECT data FROM messages';
      const params: unknown[] = [];

      if (channel) {
        sql += " WHERE json_extract(data, '$.channel') = ?";
        params.push(channel);
      }
      sql += ' ORDER BY timestamp ASC';

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as { data: string }[];
      return rows.map((row) => this.deserializeMessage(row.data));
    } catch (err) {
      throw new PersistenceError('Failed to list messages', 'listMessages', err);
    }
  }

  // ─── Checkpoints ───────────────────────────────────────────────────

  saveCheckpoint(workflowId: string, state: Record<string, unknown>): string {
    try {
      const id = uuidv4();
      const stmt = this.db.prepare(
        'INSERT INTO checkpoints (id, workflow_id, state) VALUES (?, ?, ?)',
      );
      stmt.run(id, workflowId, JSON.stringify(state));
      return id;
    } catch (err) {
      throw new PersistenceError(
        `Failed to save checkpoint for workflow ${workflowId}`,
        'saveCheckpoint',
        err,
      );
    }
  }

  getLatestCheckpoint(workflowId: string): CheckpointData | null {
    try {
      const stmt = this.db.prepare(
        'SELECT id, workflow_id, state, created_at FROM checkpoints WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
      );
      const row = stmt.get(workflowId) as
        | { id: string; workflow_id: string; state: string; created_at: string }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        workflowId: row.workflow_id,
        state: JSON.parse(row.state) as Record<string, unknown>,
        createdAt: row.created_at,
      };
    } catch (err) {
      throw new PersistenceError(
        `Failed to get checkpoint for workflow ${workflowId}`,
        'getLatestCheckpoint',
        err,
      );
    }
  }

  listCheckpoints(workflowId?: string): CheckpointData[] {
    try {
      let sql = 'SELECT id, workflow_id, state, created_at FROM checkpoints';
      const params: unknown[] = [];

      if (workflowId) {
        sql += ' WHERE workflow_id = ?';
        params.push(workflowId);
      }

      sql += ' ORDER BY created_at ASC';

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as {
        id: string;
        workflow_id: string;
        state: string;
        created_at: string;
      }[];

      return rows.map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        state: JSON.parse(row.state) as Record<string, unknown>,
        createdAt: row.created_at,
      }));
    } catch (err) {
      throw new PersistenceError('Failed to list checkpoints', 'listCheckpoints', err);
    }
  }

  // ─── Audit Log ─────────────────────────────────────────────────────

  appendAuditLog(entry: AuditEntry): void {
    try {
      const data = entry.workflowId
        ? { ...entry.data, workflowId: entry.workflowId }
        : entry.data;

      const stmt = this.db.prepare(
        'INSERT INTO audit_log (event_type, agent_id, task_id, data, timestamp) VALUES (?, ?, ?, ?, ?)',
      );
      stmt.run(
        entry.eventType,
        entry.agentId ?? null,
        entry.taskId ?? null,
        JSON.stringify(data),
        entry.timestamp.toISOString(),
      );
    } catch (err) {
      throw new PersistenceError('Failed to append audit log', 'appendAuditLog', err);
    }
  }

  queryAuditLog(filter?: AuditLogFilter): AuditEntry[] {
    try {
      let sql = 'SELECT event_type, agent_id, task_id, data, timestamp FROM audit_log';
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.eventType) {
        conditions.push('event_type = ?');
        params.push(filter.eventType);
      }
      if (filter?.agentId) {
        conditions.push('agent_id = ?');
        params.push(filter.agentId);
      }
      if (filter?.taskId) {
        conditions.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter?.from) {
        conditions.push('timestamp >= ?');
        params.push(filter.from.toISOString());
      }
      if (filter?.to) {
        conditions.push('timestamp <= ?');
        params.push(filter.to.toISOString());
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY timestamp DESC';

      if (filter?.limit) {
        sql += ' LIMIT ?';
        params.push(filter.limit);
      }

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as {
        event_type: string;
        agent_id: string | null;
        task_id: string | null;
        data: string;
        timestamp: string;
      }[];

      return rows.map((row) => {
        const parsed = JSON.parse(row.data) as Record<string, unknown>;
        const { workflowId, ...data } = parsed as Record<string, unknown> & { workflowId?: string };
        return {
          eventType: row.event_type,
          agentId: row.agent_id ?? undefined,
          taskId: row.task_id ?? undefined,
          workflowId,
          data,
          timestamp: new Date(row.timestamp),
        };
      });
    } catch (err) {
      throw new PersistenceError('Failed to query audit log', 'queryAuditLog', err);
    }
  }

  getTaskTimeline(taskId: string): AuditEntry[] {
    try {
      const stmt = this.db.prepare(
        'SELECT event_type, agent_id, task_id, data, timestamp FROM audit_log WHERE task_id = ? ORDER BY timestamp ASC',
      );
      const rows = stmt.all(taskId) as {
        event_type: string;
        agent_id: string | null;
        task_id: string | null;
        data: string;
        timestamp: string;
      }[];

      return rows.map((row) => {
        const parsed = JSON.parse(row.data) as Record<string, unknown> & { workflowId?: string };
        const { workflowId, ...data } = parsed;
        return {
          eventType: row.event_type,
          agentId: row.agent_id ?? undefined,
          taskId: row.task_id ?? undefined,
          workflowId,
          data,
          timestamp: new Date(row.timestamp),
        };
      });
    } catch (err) {
      throw new PersistenceError(
        `Failed to get task timeline for ${taskId}`,
        'getTaskTimeline',
        err,
      );
    }
  }

  getAgentActivity(agentId: string, from?: Date, to?: Date): AuditEntry[] {
    try {
      let sql = 'SELECT event_type, agent_id, task_id, data, timestamp FROM audit_log WHERE agent_id = ?';
      const params: unknown[] = [agentId];

      if (from) {
        sql += ' AND timestamp >= ?';
        params.push(from.toISOString());
      }
      if (to) {
        sql += ' AND timestamp <= ?';
        params.push(to.toISOString());
      }

      sql += ' ORDER BY timestamp ASC';

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as {
        event_type: string;
        agent_id: string | null;
        task_id: string | null;
        data: string;
        timestamp: string;
      }[];

      return rows.map((row) => {
        const parsed = JSON.parse(row.data) as Record<string, unknown> & { workflowId?: string };
        const { workflowId, ...data } = parsed;
        return {
          eventType: row.event_type,
          agentId: row.agent_id ?? undefined,
          taskId: row.task_id ?? undefined,
          workflowId,
          data,
          timestamp: new Date(row.timestamp),
        };
      });
    } catch (err) {
      throw new PersistenceError(
        `Failed to get agent activity for ${agentId}`,
        'getAgentActivity',
        err,
      );
    }
  }

  exportCSV(filter?: { eventType?: string; agentId?: string; taskId?: string; from?: Date; to?: Date }): string {
    try {
      let sql = 'SELECT event_type, agent_id, task_id, data, timestamp FROM audit_log';
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (filter?.eventType) {
        conditions.push('event_type = ?');
        params.push(filter.eventType);
      }
      if (filter?.agentId) {
        conditions.push('agent_id = ?');
        params.push(filter.agentId);
      }
      if (filter?.taskId) {
        conditions.push('task_id = ?');
        params.push(filter.taskId);
      }
      if (filter?.from) {
        conditions.push('timestamp >= ?');
        params.push(filter.from.toISOString());
      }
      if (filter?.to) {
        conditions.push('timestamp <= ?');
        params.push(filter.to.toISOString());
      }

      if (conditions.length > 0) {
        sql += ' WHERE ' + conditions.join(' AND ');
      }

      sql += ' ORDER BY timestamp ASC';

      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params) as {
        event_type: string;
        agent_id: string | null;
        task_id: string | null;
        data: string;
        timestamp: string;
      }[];

      const lines = ['timestamp,event_type,agent_id,task_id,data'];
      for (const row of rows) {
        const escapedData = '"' + row.data.replace(/"/g, '""') + '"';
        lines.push(
          `${row.timestamp},${row.event_type},${row.agent_id ?? ''},${row.task_id ?? ''},${escapedData}`,
        );
      }

      return lines.join('\n');
    } catch (err) {
      throw new PersistenceError('Failed to export CSV', 'exportCSV', err);
    }
  }

  // ─── Shared Memory ──────────────────────────────────────────────────

  setSharedValue(key: string, value: unknown): void {
    try {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO shared_memory (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))',
      );
      stmt.run(key, JSON.stringify(value));
    } catch (err) {
      throw new PersistenceError(`Failed to set shared value ${key}`, 'setSharedValue', err);
    }
  }

  getSharedValue(key: string): unknown | undefined {
    try {
      const stmt = this.db.prepare('SELECT value FROM shared_memory WHERE key = ?');
      const row = stmt.get(key) as { value: string } | undefined;
      if (!row) return undefined;
      return JSON.parse(row.value);
    } catch (err) {
      throw new PersistenceError(`Failed to get shared value ${key}`, 'getSharedValue', err);
    }
  }

  deleteSharedValue(key: string): boolean {
    try {
      const stmt = this.db.prepare('DELETE FROM shared_memory WHERE key = ?');
      const result = stmt.run(key);
      return result.changes > 0;
    } catch (err) {
      throw new PersistenceError(`Failed to delete shared value ${key}`, 'deleteSharedValue', err);
    }
  }

  listSharedValues(prefix: string): Array<{ key: string; value: unknown }> {
    try {
      const stmt = this.db.prepare('SELECT key, value FROM shared_memory WHERE key LIKE ?');
      const rows = stmt.all(`${prefix}%`) as { key: string; value: string }[];
      return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
    } catch (err) {
      throw new PersistenceError('Failed to list shared values', 'listSharedValues', err);
    }
  }

  // ─── Conversation History ─────────────────────────────────────────

  saveConversationMessage(agentId: string, role: string, content: string, timestamp: string): void {
    try {
      const stmt = this.db.prepare(
        'INSERT INTO conversation_messages (agent_id, role, content, timestamp) VALUES (?, ?, ?, ?)',
      );
      stmt.run(agentId, role, content, timestamp);
    } catch (err) {
      throw new PersistenceError('Failed to save conversation message', 'saveConversationMessage', err);
    }
  }

  getConversationMessages(agentId: string, limit?: number): Array<{ role: string; content: string; timestamp: string }> {
    try {
      let sql = 'SELECT role, content, timestamp FROM conversation_messages WHERE agent_id = ? ORDER BY id ASC';
      const params: unknown[] = [agentId];
      if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
      }
      const stmt = this.db.prepare(sql);
      return stmt.all(...params) as Array<{ role: string; content: string; timestamp: string }>;
    } catch (err) {
      throw new PersistenceError('Failed to get conversation messages', 'getConversationMessages', err);
    }
  }

  clearConversationMessages(agentId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM conversation_messages WHERE agent_id = ?');
      stmt.run(agentId);
    } catch (err) {
      throw new PersistenceError('Failed to clear conversation messages', 'clearConversationMessages', err);
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      throw new PersistenceError('Failed to close database', 'close', err);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────

  private deserializeTask(json: string): Task {
    const raw = JSON.parse(json);
    raw.createdAt = new Date(raw.createdAt);
    raw.updatedAt = new Date(raw.updatedAt);
    return raw as Task;
  }

  private deserializeMessage(json: string): AgentMessage {
    const raw = JSON.parse(json);
    raw.timestamp = new Date(raw.timestamp);
    return raw as AgentMessage;
  }
}
