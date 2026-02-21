import { describe, it, expect } from 'vitest';
import { QualityAssessor } from '../../src/intelligence/quality-assessor.js';
import { createMockOpenAI } from '../fixtures/mock-openai.js';
import type { Task, TaskResult, Workflow, WorkflowNode } from '../../src/core/types.js';

// ─── Helpers ────────────────────────────────────────────────────────

function createTestTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Write summary',
    description: 'Write a concise summary of the research',
    priority: 'medium',
    status: 'completed',
    input: {},
    dependencies: [],
    subtasks: [],
    metadata: { retryCount: 0, maxRetries: 3 },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function createTaskResult(overrides?: Partial<TaskResult>): TaskResult {
  return {
    taskId: 'task-1',
    success: true,
    output: { summary: 'A well-written summary of the research findings.' },
    duration: 500,
    ...overrides,
  };
}

function createTestWorkflow(): Workflow {
  const nodes: WorkflowNode[] = [
    {
      id: 'node-1',
      taskTemplate: {
        name: 'Research',
        description: 'Research the topic',
        priority: 'high',
        input: {},
        dependencies: [],
        subtasks: [],
        metadata: { retryCount: 0, maxRetries: 3 },
      },
    },
  ];

  return {
    id: 'wf-1',
    name: 'Research Workflow',
    description: 'Research and summarize a topic',
    nodes,
    edges: [],
    status: 'completed',
    context: {},
  };
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('QualityAssessor', () => {
  // ─── assess() ─────────────────────────────────────────────────────

  describe('assess', () => {
    it('returns valid QualityReport with scores', async () => {
      const { client } = createMockOpenAI();
      const assessor = new QualityAssessor(client);
      const task = createTestTask();
      const result = createTaskResult();

      const report = await assessor.assess(task, result);

      expect(report.overallScore).toBe(85);
      expect(report.dimensions.completeness).toBe(90);
      expect(report.dimensions.accuracy).toBe(85);
      expect(report.dimensions.coherence).toBe(80);
      expect(report.dimensions.relevance).toBe(85);
      expect(report.issues).toEqual([]);
      expect(report.improvementSuggestions).toEqual([
        'Consider adding more examples.',
      ]);
    });

    it('computes passesThreshold correctly from overallScore', async () => {
      const { client } = createMockOpenAI();
      const assessor = new QualityAssessor(client);

      // Medium priority → threshold 70 → score 85 passes
      const mediumTask = createTestTask({ priority: 'medium' });
      const report = await assessor.assess(mediumTask, createTaskResult());
      expect(report.passesThreshold).toBe(true);
    });
  });

  // ─── Threshold Logic ──────────────────────────────────────────────

  describe('threshold logic', () => {
    it('critical task with score 85 fails (needs 90)', async () => {
      const responses = new Map<string, unknown>([
        [
          'quality_report',
          {
            overallScore: 85,
            dimensions: {
              completeness: 85,
              accuracy: 85,
              coherence: 85,
              relevance: 85,
            },
            issues: [],
            passesThreshold: true, // LLM says true, but our code overrides
            improvementSuggestions: [],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const criticalTask = createTestTask({ priority: 'critical' });
      const report = await assessor.assess(criticalTask, createTaskResult());

      // critical threshold = 90, score = 85 → should fail
      expect(report.overallScore).toBe(85);
      expect(report.passesThreshold).toBe(false);
    });

    it('medium task with score 85 passes (needs 70)', async () => {
      const responses = new Map<string, unknown>([
        [
          'quality_report',
          {
            overallScore: 85,
            dimensions: {
              completeness: 85,
              accuracy: 85,
              coherence: 85,
              relevance: 85,
            },
            issues: [],
            passesThreshold: false, // LLM says false, but our code overrides
            improvementSuggestions: [],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const mediumTask = createTestTask({ priority: 'medium' });
      const report = await assessor.assess(mediumTask, createTaskResult());

      // medium threshold = 70, score = 85 → should pass
      expect(report.overallScore).toBe(85);
      expect(report.passesThreshold).toBe(true);
    });

    it('high task with score exactly at threshold passes', async () => {
      const responses = new Map<string, unknown>([
        [
          'quality_report',
          {
            overallScore: 80,
            dimensions: {
              completeness: 80,
              accuracy: 80,
              coherence: 80,
              relevance: 80,
            },
            issues: [],
            passesThreshold: false,
            improvementSuggestions: [],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const highTask = createTestTask({ priority: 'high' });
      const report = await assessor.assess(highTask, createTaskResult());

      // high threshold = 80, score = 80 → >= threshold → passes
      expect(report.passesThreshold).toBe(true);
    });

    it('low task with score 55 passes (needs 50)', async () => {
      const responses = new Map<string, unknown>([
        [
          'quality_report',
          {
            overallScore: 55,
            dimensions: {
              completeness: 55,
              accuracy: 55,
              coherence: 55,
              relevance: 55,
            },
            issues: [],
            passesThreshold: false,
            improvementSuggestions: [],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const lowTask = createTestTask({ priority: 'low' });
      const report = await assessor.assess(lowTask, createTaskResult());

      expect(report.passesThreshold).toBe(true);
    });
  });

  // ─── compare() ────────────────────────────────────────────────────

  describe('compare', () => {
    it('ranks results correctly', async () => {
      const responses = new Map<string, unknown>([
        [
          'compare_results',
          {
            rankings: [
              {
                taskResultIndex: 1,
                score: 60,
                reasoning: 'Less complete',
              },
              {
                taskResultIndex: 0,
                score: 90,
                reasoning: 'Most complete and accurate',
              },
            ],
            bestIndex: 0,
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const results: TaskResult[] = [
        createTaskResult({ output: { summary: 'Detailed summary' } }),
        createTaskResult({ output: { summary: 'Brief summary' } }),
      ];

      const comparison = await assessor.compare(createTestTask(), results);

      // Should be sorted by score descending
      expect(comparison.rankings[0].taskResultIndex).toBe(0);
      expect(comparison.rankings[0].score).toBe(90);
      expect(comparison.rankings[1].taskResultIndex).toBe(1);
      expect(comparison.rankings[1].score).toBe(60);
      expect(comparison.bestIndex).toBe(0);
    });

    it('returns empty rankings for no results', async () => {
      const { client } = createMockOpenAI();
      const assessor = new QualityAssessor(client);

      const comparison = await assessor.compare(createTestTask(), []);

      expect(comparison.rankings).toEqual([]);
      expect(comparison.bestIndex).toBe(-1);
    });

    it('returns single result with score 100', async () => {
      const { client, createSpy } = createMockOpenAI();
      const assessor = new QualityAssessor(client);

      const comparison = await assessor.compare(createTestTask(), [
        createTaskResult(),
      ]);

      expect(comparison.rankings).toHaveLength(1);
      expect(comparison.rankings[0].score).toBe(100);
      expect(comparison.bestIndex).toBe(0);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  // ─── validateWorkflowOutput() ─────────────────────────────────────

  describe('validateWorkflowOutput', () => {
    it('returns QualityReport for workflow output', async () => {
      const { client } = createMockOpenAI();
      const assessor = new QualityAssessor(client);
      const workflow = createTestWorkflow();
      const finalOutput = { research: 'AI topics', summary: 'AI is evolving' };

      const report = await assessor.validateWorkflowOutput(
        workflow,
        finalOutput,
      );

      expect(report.overallScore).toBe(85);
      expect(report.dimensions).toBeDefined();
      expect(report.passesThreshold).toBe(true); // 85 >= 70 (default threshold)
      expect(report.issues).toBeDefined();
      expect(report.improvementSuggestions).toBeDefined();
    });

    it('uses default threshold (70) for workflow validation', async () => {
      const responses = new Map<string, unknown>([
        [
          'quality_report',
          {
            overallScore: 65,
            dimensions: {
              completeness: 65,
              accuracy: 65,
              coherence: 65,
              relevance: 65,
            },
            issues: [],
            passesThreshold: true, // LLM says true but we override
            improvementSuggestions: [],
          },
        ],
      ]);
      const { client } = createMockOpenAI(responses);
      const assessor = new QualityAssessor(client);

      const report = await assessor.validateWorkflowOutput(
        createTestWorkflow(),
        { result: 'incomplete' },
      );

      // 65 < 70 → fails
      expect(report.passesThreshold).toBe(false);
    });
  });
});
