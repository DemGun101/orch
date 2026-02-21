# Claude Brain — Full Tool Reference

## brain() — Unified Memory Tool

The `brain` tool is the primary interface. It accepts natural language and auto-detects the action.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string | Yes | Natural language — what you're doing, decided, learned, or need |
| `project` | string | No | Project name to scope memories (auto-detected if omitted) |
| `action` | string | No | Force action: `store`, `recall`, `update`, `delete`, `auto` (default) |

### Actions

#### Store (auto-detected from declarative statements)
```
brain("Decided to use JWT over sessions because the app is stateless")
brain("User prefers Tailwind CSS and explicit error handling")
brain("Architecture: microservices with shared event bus for inter-service communication")
```

Explicit:
```
brain("use Redis for caching", action: "store", project: "my-api")
```

#### Recall (auto-detected from questions)
```
brain("What do I know about this project?")
brain("What database decisions have we made?")
brain("Any past issues with CORS?")
```

Explicit:
```
brain("auth patterns", action: "recall", project: "my-api")
```

#### Update (auto-detected from "changed mind" / "actually" / "instead")
```
brain("Changed my mind, use Postgres instead of MySQL")
brain("Actually, switch from REST to GraphQL for the admin API")
```

Explicit:
```
brain("update: now using Bun instead of Node", action: "update")
```

#### Delete (auto-detected from "delete" / "remove" / "forget")
```
brain("Delete the memory about Redis caching")
brain("Forget the old database decision")
```

Explicit:
```
brain("remove auth pattern memory", action: "delete")
```

---

## search_code() — Code Symbol Search

Searches indexed code for functions, classes, types, files, and dependencies.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Symbol name, file name, or search term |
| `project` | string | Yes | Project name |
| `type` | string | No | `symbols` (default), `files`, or `dependencies` |
| `limit` | number | No | Max results (default: 20) |
| `file_path` | string | No | Required when type is `dependencies` |

### Examples

```
search_code(query: "handleAuth", project: "my-app")
search_code(query: "UserSchema", project: "my-app", type: "symbols")
search_code(query: "auth.ts", project: "my-app", type: "files")
search_code(query: "", project: "my-app", type: "dependencies", file_path: "src/server.ts")
```

---

## Legacy Tools (Available in non-unified mode)

When `unifiedToolMode` is disabled in config, individual tools are exposed:

### Context Retrieval

| Tool | When to Use | Key Parameters |
|------|------------|----------------|
| `smart_context` | Starting any task | `project_name`, `current_task` |
| `recall_similar` | Before answering technical questions | `query`, `min_similarity` (default 0.3), `limit` |
| `get_project_context` | Need complete project state | `project_name`, `include_memories` |
| `get_code_standards` | Writing or reviewing code | `project_name`, `language` |
| `get_patterns` | Designing solutions | `project_name`, `pattern_type`, `query` |
| `get_corrections` | Debugging or implementing tricky features | `project_name`, `query` |

### Memory Storage

| Tool | When to Use | Key Parameters |
|------|------------|----------------|
| `remember_decision` | After making recommendations | `project_name`, `decision`, `reasoning`, `alternatives_considered`, `tags` |
| `recognize_pattern` | Noticed reusable solution | `project_name`, `pattern_type`, `description`, `example`, `confidence` |
| `record_correction` | Something went wrong | `project_name`, `original`, `correction`, `reasoning`, `confidence` |
| `update_progress` | Completed a task | `project_name`, `completed_task`, `next_steps`, `notes` |
| `auto_remember` | Auto-extract decisions from text | `project_name`, `text`, `confidence_threshold` |

### Project Management

| Tool | When to Use | Key Parameters |
|------|------------|----------------|
| `init_project` | First time on existing codebase | `project_path`, `project_name`, `save_to_memory` |
| `create_project` | Starting a new project | `project_name`, `description`, `tech_stack`, `tags`, `status` |
| `list_projects` | See all projects | `status_filter` (`active`, `archived`, `planning`, `all`) |

### System

| Tool | When to Use | Key Parameters |
|------|------------|----------------|
| `get_phase12_status` | Debugging or health check | (none) |

---

## Similarity & Confidence Scores

### Similarity (for recall)
| Score | Meaning |
|-------|---------|
| 0.7+ | Highly relevant |
| 0.5–0.7 | Somewhat relevant |
| 0.3–0.5 | Loosely related |
| < 0.3 | Probably not relevant |

**Use `min_similarity: 0.3` for broad searches, `0.7` for precise matches.**

### Confidence (for storage)
| Score | Meaning |
|-------|---------|
| 0.9–1.0 | Verified, high confidence |
| 0.7–0.9 | Well-reasoned |
| 0.5–0.7 | Moderate confidence |
| < 0.5 | Uncertain, needs validation |

---

## Background Automation

Claude Brain installs hooks in `~/.claude/settings.json` that fire automatically:

| Hook | Trigger | What It Captures |
|------|---------|-----------------|
| `PostToolUse` | After file edits, installs, git commits | Tool name, arguments, file paths |
| `Stop` | Session ends | Session duration, final state |
| `SessionStart` | Session begins | Project detection, context loading |

These hooks capture the **WHAT**. Your job via `brain()` is to capture the **WHY**.

---

## Installation

### Via npm (global)
```bash
npm install -g claude-brain
```

### Via MCP config
Add to your Claude Code MCP settings:
```json
{
  "mcpServers": {
    "claude-brain": {
      "command": "bun",
      "args": ["run", "/path/to/claude-brain/src/index.ts"],
      "env": {
        "PORT": "3333"
      }
    }
  }
}
```

### CLAUDE.md injection
Add to your project's `CLAUDE.md`:
```markdown
# Claude Brain
Call `brain()` with what you are doing. The server handles the rest.
```

This ensures Claude uses brain in every session without explicit instructions.
