import { z } from 'zod';
import type { OrchestratorConfig } from '../core/types.js';

// ─── Sub-schemas ────────────────────────────────────────────────────

const RateLimitsSchema = z.object({
  requestsPerMinute: z.number().int().positive().default(60),
  tokensPerMinute: z.number().int().positive().default(100_000),
});

const PersistenceSchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default('./data/orchestrator.db'),
});

// ─── Main Config Schema ────────────────────────────────────────────

const OrchestratorConfigSchema = z.object({
  maxConcurrentAgents: z.number().int().positive().default(10),
  maxConcurrentTasks: z.number().int().positive().default(50),
  defaultTimeout: z.number().int().positive().default(300_000),
  checkpointInterval: z.number().int().positive().default(30_000),
  rateLimits: RateLimitsSchema.default({
    requestsPerMinute: 60,
    tokensPerMinute: 100_000,
  }),
  persistence: PersistenceSchema.default({
    enabled: true,
    dbPath: './data/orchestrator.db',
  }),
});

// ─── Exports ────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: OrchestratorConfig =
  OrchestratorConfigSchema.parse({});

export function validateConfig(input: unknown): OrchestratorConfig {
  return OrchestratorConfigSchema.parse(input);
}
