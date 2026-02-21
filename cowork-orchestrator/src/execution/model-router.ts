import type { ModelTier, ModelRoutingConfig, Task } from '../core/types.js';

// ─── Default tier → model mappings ───────────────────────────────────

const TIER_MODELS: Record<ModelTier, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

// ─── Model Router ─────────────────────────────────────────────────────

export class ModelRouter {
  /**
   * Determine which ModelTier to use for the given task.
   * Checks `config.tierMap` by task name, then falls back to `config.defaultTier`.
   */
  route(task: Task, config: ModelRoutingConfig): ModelTier {
    const mapped = config.tierMap[task.name];
    if (mapped) return mapped;
    return config.defaultTier;
  }

  /**
   * Resolve a tier to a concrete model ID.
   * `config.overrides` can map tier names to custom model IDs.
   */
  getTierModel(tier: ModelTier, overrides?: Record<string, string>): string {
    if (overrides && overrides[tier]) return overrides[tier];
    return TIER_MODELS[tier];
  }

  /**
   * Convenience: given a task and full config, return the resolved model ID.
   */
  resolveModel(task: Task, config: ModelRoutingConfig): string {
    const tier = this.route(task, config);
    return this.getTierModel(tier, config.overrides);
  }
}
