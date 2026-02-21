import { v4 as uuidv4 } from 'uuid';
import type { PersistenceLayer } from '../memory/persistence.js';

// ─── Session Record ───────────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  agentId: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

// ─── Session Manager ──────────────────────────────────────────────────
// Stores SDK session metadata using the existing PersistenceLayer shared-memory
// API (setSharedValue / getSharedValue) to avoid needing raw DB access.

const KEY_PREFIX = 'sdk_session:';

export class SessionManager {
  constructor(private readonly persistence: PersistenceLayer) {}

  /** Create a new session record and return its ID. */
  async createSession(agentId: string): Promise<string> {
    const sessionId = uuidv4();
    const record: SessionRecord = {
      sessionId,
      agentId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      messageCount: 0,
    };
    this.persistence.setSharedValue(`${KEY_PREFIX}${sessionId}`, record);
    return sessionId;
  }

  /** Retrieve a session record by ID, or null if not found. */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const raw = this.persistence.getSharedValue(`${KEY_PREFIX}${sessionId}`);
    if (!raw) return null;
    return raw as SessionRecord;
  }

  /** Update fields on an existing session record. */
  async updateSession(sessionId: string, partial: Partial<SessionRecord>): Promise<void> {
    const existing = await this.getSession(sessionId);
    if (!existing) return;
    const updated: SessionRecord = { ...existing, ...partial };
    this.persistence.setSharedValue(`${KEY_PREFIX}${sessionId}`, updated);
  }

  /** Delete a session record. */
  async deleteSession(sessionId: string): Promise<void> {
    this.persistence.deleteSharedValue(`${KEY_PREFIX}${sessionId}`);
  }

  /** List all session records for a given agent. */
  async listSessionsForAgent(agentId: string): Promise<SessionRecord[]> {
    const all = this.persistence.listSharedValues(KEY_PREFIX);
    return all
      .map((entry) => entry.value as SessionRecord)
      .filter((r) => r.agentId === agentId);
  }

  /** Bump the lastActiveAt timestamp and increment the message counter. */
  async touchSession(sessionId: string, newMessages = 0): Promise<void> {
    await this.updateSession(sessionId, {
      lastActiveAt: new Date().toISOString(),
      messageCount: ((await this.getSession(sessionId))?.messageCount ?? 0) + newMessages,
    });
  }
}
