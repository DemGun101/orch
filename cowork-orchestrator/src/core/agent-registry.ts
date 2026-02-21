import { EventEmitter } from 'eventemitter3';
import type { Task } from './types.js';
import type { BaseAgent } from '../agents/base-agent.js';
import type { PersistenceLayer } from '../memory/persistence.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface RegistryMetrics {
  totalAgents: number;
  availableAgents: number;
  avgLoad: number;
  totalTasksCompleted: number;
}

interface RegistryEvents {
  'agent:registered': (agent: BaseAgent) => void;
  'agent:unregistered': (agentId: string) => void;
}

// ─── Agent Registry ─────────────────────────────────────────────────

export class AgentRegistry {
  private agents = new Map<string, BaseAgent>();
  private emitter = new EventEmitter<RegistryEvents>();
  private persistence?: PersistenceLayer;

  constructor(persistence?: PersistenceLayer) {
    this.persistence = persistence;
  }

  register(agent: BaseAgent): void {
    this.agents.set(agent.id, agent);
    this.persistence?.saveAgent(
      {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        systemPrompt: '',
        capabilities: [],
        maxConcurrentTasks: 1,
        model: '',
      },
      agent.status,
    );
    this.emitter.emit('agent:registered', agent);
  }

  unregister(agentId: string): void {
    this.agents.delete(agentId);
    this.persistence?.deleteAgent(agentId);
    this.emitter.emit('agent:unregistered', agentId);
  }

  get(agentId: string): BaseAgent | undefined {
    return this.agents.get(agentId);
  }

  findByCapability(capabilityName: string): BaseAgent[] {
    const results: BaseAgent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.canHandle({ name: capabilityName, description: '' } as Task)) {
        results.push(agent);
      }
    }
    return results;
  }

  findBestMatch(task: Task): BaseAgent | undefined {
    let bestAgent: BaseAgent | undefined;
    let bestScore = -Infinity;

    for (const agent of this.getAvailable()) {
      let score = 0;

      // Capability match: +10
      if (agent.canHandle(task)) {
        score += 10;
      }

      // Load score: +5 * (1 - load)
      score += 5 * (1 - agent.getLoad());

      // Error rate penalty: -5 * errorRate
      score -= 5 * agent.getStats().errorRate;

      if (score > bestScore) {
        bestScore = score;
        bestAgent = agent;
      }
    }

    return bestAgent;
  }

  getAll(): BaseAgent[] {
    return Array.from(this.agents.values());
  }

  getAvailable(): BaseAgent[] {
    return this.getAll().filter(
      (agent) => agent.status !== 'offline' && agent.getLoad() < 1,
    );
  }

  getMetrics(): RegistryMetrics {
    const all = this.getAll();
    const available = this.getAvailable();
    const totalLoad = all.reduce((sum, a) => sum + a.getLoad(), 0);
    const totalCompleted = all.reduce(
      (sum, a) => sum + a.getStats().tasksCompleted,
      0,
    );

    return {
      totalAgents: all.length,
      availableAgents: available.length,
      avgLoad: all.length > 0 ? totalLoad / all.length : 0,
      totalTasksCompleted: totalCompleted,
    };
  }

  onAgentRegistered(handler: (agent: BaseAgent) => void): () => void {
    this.emitter.on('agent:registered', handler);
    return () => this.emitter.off('agent:registered', handler);
  }

  onAgentUnregistered(handler: (agentId: string) => void): () => void {
    this.emitter.on('agent:unregistered', handler);
    return () => this.emitter.off('agent:unregistered', handler);
  }
}
