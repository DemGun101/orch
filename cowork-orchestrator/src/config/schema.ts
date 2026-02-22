import { z } from 'zod';
import type { CoworkConfig } from '../core/types.js';

// ─── Sub-schemas ────────────────────────────────────────────────────

const RateLimitsSchema = z.object({
  requestsPerMinute: z.number().int().positive().default(60),
  tokensPerMinute: z.number().int().positive().default(100_000),
});

const PersistenceSchema = z.object({
  enabled: z.boolean().default(false),
  dbPath: z.string().default('./data/orchestrator.db'),
});

// ─── Main Config Schema ────────────────────────────────────────────

const CoworkConfigSchema = z.object({
  maxConcurrency: z.number().int().positive().default(5),
  defaultTimeout: z.number().int().positive().default(600_000),
  rateLimits: RateLimitsSchema.default({
    requestsPerMinute: 60,
    tokensPerMinute: 100_000,
  }),
  persistence: PersistenceSchema.default({
    enabled: false,
    dbPath: './data/orchestrator.db',
  }),
  defaultModel: z.string().default('claude-sonnet-4-6'),
  plannerModel: z.string().default('claude-opus-4-6'),
  cwd: z.string().optional(),
  maxFeedbackIterations: z.number().int().nonnegative().default(2),
});

// ─── Exports ────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: CoworkConfig = CoworkConfigSchema.parse({});

export function validateConfig(input: unknown): CoworkConfig {
  return CoworkConfigSchema.parse(input);
}
