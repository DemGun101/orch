---
name: claude-brain
description: "Persistent memory for Claude Code via the `brain` MCP tool. Use this skill to remember decisions, recall context across sessions, track progress, and learn from mistakes. Triggers: any mention of 'remember', 'recall', 'what did we decide', 'last session', 'persistent memory', 'brain', 'project context', or when starting/ending work sessions."
---

# Claude Brain — Persistent Memory Skill

You have persistent memory via the `brain` MCP tool. It stores decisions, patterns, corrections, and progress across sessions so you never lose context.

## How It Works

One tool. Natural language. The server figures out the rest.

```
brain("your message here")
```

The `brain` tool auto-detects your intent from the message:

| You say | Brain does |
|---------|-----------|
| "What do I know about auth?" | **Recall** — searches memory for relevant results |
| "Decided to use JWT because sessions don't scale" | **Store** — saves as a decision |
| "Session summary: built the login page, next is dashboard" | **Store** — saves progress |
| "Changed my mind, use Postgres instead of MySQL" | **Update** — modifies last related memory |
| "Delete the memory about Redis caching" | **Delete** — removes specific memory |

You can also force an action explicitly:

```
brain("use Tailwind for styling", action: "store", project: "my-app")
```

## When to Call Brain

### Session Start (ALWAYS)
Before doing any real work, recall what you know:

```
brain("What do I know about this project?")
```

This pulls past decisions, preferences, progress, and lessons — so you don't repeat mistakes or contradict earlier choices.

### During Work (Store the WHY)
Call brain when you make or encounter something worth remembering:

```
brain("Decided to use Zod over Joi because it infers TypeScript types natively")
brain("The bug was caused by missing await on the database call — cost 2 hours debugging")
brain("User prefers explicit error messages over generic 500 responses")
brain("Architecture: API routes split by domain — /auth, /users, /billing as separate routers")
```

### Session End (ALWAYS)
Before finishing, store a 2-3 sentence summary:

```
brain("Session summary: Built auth flow for expense tracker. Chose JWT with refresh token rotation. Hit CORS issue on /api/login, fixed with credentials: include. Next: add password reset endpoint.")
```

### Before Answering Technical Questions
Check if there's relevant history before recommending something:

```
brain("What patterns have we used for error handling?")
brain("Have we made decisions about the database?")
brain("Any past issues with deployment?")
```

### After Making Mistakes
Document the lesson so it's never repeated:

```
brain("Correction: used any type to fix TS errors quickly, but it hid a null reference bug. Always define proper interfaces instead.")
```

## What NOT to Store

- File paths or creation events (captured automatically by hooks)
- Granular progress like "read file X" or "ran tests"
- Anything already in the codebase (just read the code)
- Temporary debugging notes

**Store the WHY — reasoning, preferences, and lessons. Hooks capture the WHAT.**

## Project Scoping

Always include the project name to keep memories organized:

```
brain("Decided to use SQLite for local storage", project: "mobile-app")
brain("What do I know about mobile-app?", project: "mobile-app")
```

If you don't specify a project, brain auto-detects it from context or defaults to "general".

## Code Search

A second tool, `search_code`, searches indexed code symbols:

```
search_code(query: "handleAuth", project: "my-app")
search_code(query: "UserSchema", project: "my-app", type: "symbols")
search_code(query: "auth.ts", project: "my-app", type: "files")
```

## Decision Auto-Save Rules

**ALWAYS call brain to store when your response contains:**

| Your response includes | Store it |
|----------------------|----------|
| "I recommend..." | Yes — save the decision with reasoning |
| "We should use X because..." | Yes — save with alternatives considered |
| "Don't use X" / "Avoid X" | Yes — save as an anti-pattern |
| "The bug was caused by..." | Yes — save as a correction |
| Architecture or library choice | Yes — save with tradeoffs |
| Coding standard established | Yes — save as a pattern |

## Complete Workflow

```
1. Session starts
   -> brain("What do I know about this project?")

2. User asks a technical question
   -> brain("What have we decided about [topic]?")
   -> Answer using recalled context
   -> brain("Decided to [decision] because [reasoning]")

3. You hit a bug or learn something
   -> brain("Correction: [what went wrong] -> [what to do instead]")

4. Work is done
   -> brain("Session summary: [what was done]. [key decisions]. [next steps].")
```

## Background Hooks

Tool events (installs, git commits, file edits, build failures) are captured automatically via PostToolUse/Stop hooks in `~/.claude/settings.json`. These fire invisibly — you don't need to call brain for them. Your job is to add the **reasoning and context** that hooks can't see.

## Common Mistakes

**Don't answer without checking memory first:**
```
Bad:  "I recommend PostgreSQL" (without checking past decisions)
Good: brain("database decisions?") -> then recommend based on context
```

**Don't make recommendations without saving them:**
```
Bad:  "Use Zustand for state management" (not saved)
Good: "Use Zustand..." + brain("Decided to use Zustand over Redux because...")
```

**Don't store too much:**
```
Bad:  brain("Read the package.json file")
Good: brain("Project uses Bun runtime with Hono for HTTP, important for deployment config")
```

For full tool reference with all parameters and advanced usage, see `references/TOOLS.md`.
