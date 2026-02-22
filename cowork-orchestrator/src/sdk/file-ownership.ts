// ─── File Ownership Manager ─────────────────────────────────────────
// Enforces that each agent can only write to files it owns via the
// SDK's canUseTool callback. No two agents share write access.

// ─── Glob Pattern Matching ──────────────────────────────────────────

function matchGlob(pattern: string, filePath: string): boolean {
  // Normalize path separators
  const normalized = filePath.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  // Convert glob to regex:
  // ** matches any path segments, * matches within a segment
  const escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '{{DOUBLESTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{DOUBLESTAR}}/g, '.*')
    .replace(/\?/g, '.');

  return new RegExp(`^${escaped}$`).test(normalized);
}

// ─── Types ──────────────────────────────────────────────────────────

interface OwnershipEntry {
  agentId: string;
  patterns: string[];
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  message?: string;
}

// ─── File Ownership Manager ─────────────────────────────────────────

export class FileOwnershipManager {
  private registry = new Map<string, OwnershipEntry>();

  /** Register file ownership patterns for an agent */
  register(agentId: string, patterns: string[]): void {
    this.registry.set(agentId, { agentId, patterns });
  }

  /** Remove an agent's ownership registrations */
  unregister(agentId: string): void {
    this.registry.delete(agentId);
  }

  /** Check if an agent can write to a specific file */
  canWrite(agentId: string, filePath: string): boolean {
    const entry = this.registry.get(agentId);
    if (!entry) return false;

    return entry.patterns.some((pattern) => matchGlob(pattern, filePath));
  }

  /** Check if a file is owned by any agent (to detect conflicts) */
  getOwner(filePath: string): string | undefined {
    for (const [agentId, entry] of this.registry) {
      if (entry.patterns.some((pattern) => matchGlob(pattern, filePath))) {
        return agentId;
      }
    }
    return undefined;
  }

  /**
   * Create a canUseTool callback for the SDK's query() options.
   * Intercepts Edit/Write tool calls and denies if the agent
   * doesn't own the target file path.
   */
  createCanUseToolCallback(
    agentId: string,
  ): (toolName: string, input: Record<string, unknown>) => PermissionResult {
    return (toolName: string, input: Record<string, unknown>): PermissionResult => {
      // Only intercept write operations
      if (toolName !== 'Edit' && toolName !== 'Write') {
        return { behavior: 'allow' };
      }

      const filePath = input.file_path as string | undefined;
      if (!filePath) {
        return { behavior: 'allow' };
      }

      if (this.canWrite(agentId, filePath)) {
        return { behavior: 'allow' };
      }

      const owner = this.getOwner(filePath);
      const ownerMsg = owner
        ? ` It is owned by agent "${owner}".`
        : ' It is not in your assigned file list.';

      return {
        behavior: 'deny',
        message: `You cannot modify "${filePath}".${ownerMsg} Only modify files in your assigned paths.`,
      };
    };
  }

  /** Get all registered agents and their patterns */
  getAll(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [agentId, entry] of this.registry) {
      result.set(agentId, [...entry.patterns]);
    }
    return result;
  }

  /** Clear all registrations */
  clear(): void {
    this.registry.clear();
  }
}
