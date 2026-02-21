# Agent SDK Migration — Phase Guide

## Overview

This migration rewires cowork-orchestrator from Groq/Gemini text-only LLM calls to the Claude Agent SDK, enabling agents to **actually execute tasks** (read/write files, run commands, etc.) using your Claude Pro/Max subscription.

## Architecture After Migration

```
┌─────────────────────────────────────────────────────┐
│                 OrchestrationEngine                  │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │          INTELLIGENCE LAYER                  │    │
│  │  (Task Decomposition, Agent Selection,       │    │
│  │   Quality Assessment, Conflict Resolution)   │    │
│  │                                              │    │
│  │  Backend: Groq (free) or claude -p haiku     │    │
│  │  Purpose: Planning only — no tool access     │    │
│  └─────────────────────────────────────────────┘    │
│                        │                             │
│                        ▼                             │
│  ┌─────────────────────────────────────────────┐    │
│  │           MODEL ROUTER                       │    │
│  │  Selects haiku/sonnet/opus per task based    │    │
│  │  on: priority, complexity, keywords, size    │    │
│  └─────────────────────────────────────────────┘    │
│                        │                             │
│                        ▼                             │
│  ┌─────────────────────────────────────────────┐    │
│  │          EXECUTION LAYER                     │    │
│  │                                              │    │
│  │  Primary:  Agent SDK (@anthropic-ai/         │    │
│  │            claude-agent-sdk)                  │    │
│  │  Fallback: claude -p CLI subprocess          │    │
│  │                                              │    │
│  │  Backend: Claude Pro/Max subscription        │    │
│  │  Purpose: Real work — files, code, commands  │    │
│  └─────────────────────────────────────────────┘    │
│                                                      │
│  ┌─────────────────────────────────────────────┐    │
│  │  Existing Infrastructure (unchanged)         │    │
│  │  - Task Manager    - Workflow Engine (DAGs)  │    │
│  │  - Agent Registry  - Message Bus             │    │
│  │  - Persistence     - Monitoring/Dashboard    │    │
│  │  - Resilience      - Checkpointing           │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

## Phase Execution Order

Run these phases **in order**. Each phase is a self-contained prompt to paste into Claude Code.

| Phase | File | What It Does | Est. Time |
|-------|------|-------------|-----------|
| **0** | `PHASE-0-SETUP.md` | Install SDK, add types, create directory structure | 5 min |
| **1** | `PHASE-1-EXECUTION-LAYER.md` | SDK executor, CLI fallback, session manager, SDKAgent | 15 min |
| **2** | `PHASE-2-MODEL-ROUTER.md` | Intelligent model selection (haiku/sonnet/opus) | 10 min |
| **3** | `PHASE-3-INTELLIGENCE-LAYER.md` | PlanningClient with Groq + claude-cli dual-track | 10 min |
| **4** | `PHASE-4-WIRE-ORCHESTRATOR.md` | Wire everything into OrchestrationEngine | 10 min |
| **5** | `PHASE-5-EXAMPLES-AND-TESTS.md` | Working examples, integration tests, docs | 10 min |

## Cost Structure After Migration

| Component | Backend | Cost |
|-----------|---------|------|
| Task decomposition | Groq (Llama 3.3) | **Free** |
| Agent selection | Groq (Llama 3.3) | **Free** |
| Quality assessment | Groq (Llama 3.3) | **Free** |
| Simple task execution | Claude Haiku | **Low** (subscription) |
| Standard task execution | Claude Sonnet | **Medium** (subscription) |
| Complex task execution | Claude Opus | **High** (subscription) |

## Key Design Decisions

1. **Backward compatible**: Existing LLMAgent and registerAgent() still work. New SDKAgent and registerSDKAgent() are opt-in.

2. **Dual execution backends**: Agent SDK is preferred, but `claude -p` CLI is always available as fallback.

3. **Dual planning backends**: Groq/Gemini is preferred (free), but `claude -p haiku` is the fallback if no API key is set.

4. **Model routing by default**: The ModelRouter automatically picks the cheapest model that can handle each task. No manual model selection needed (but you can override per-agent).

5. **No Anthropic API key required**: Everything uses the logged-in Claude Code session (Pro/Max subscription).
