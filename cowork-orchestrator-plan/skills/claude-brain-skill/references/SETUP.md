# Claude Brain — Setup & Configuration

## Quick Start (3 steps)

### 1. Install
```bash
npm install -g claude-brain
```

### 2. Add MCP server
Add to `~/.claude/settings.json` or your project's `.mcp.json`:
```json
{
  "mcpServers": {
    "claude-brain": {
      "command": "claude-brain",
      "args": ["serve"]
    }
  }
}
```

### 3. Add to CLAUDE.md
Add this to your project's `CLAUDE.md` (or `~/.claude/CLAUDE.md` for global):
```markdown
# Claude Brain
Call `brain()` with what you are doing. The server handles the rest.

Examples:
- brain("starting work on the auth system")
- brain("decided to use JWT because sessions don't scale")
- brain("what auth patterns have we used?")
```

## Configuration

Claude Brain uses environment variables or a `.env` file in the project root.

### Core Settings
| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3333` | HTTP API port |
| `VAULT_PATH` | `~/.claude-brain/vault` | Obsidian vault path (auto-detected) |
| `DB_PATH` | `./data/memory.db` | SQLite database path |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `LOG_FILE_PATH` | `./logs/claude-brain.log` | Log file location |
| `NODE_ENV` | `development` | Environment mode |

### ChromaDB (Optional — for semantic search)
| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMA_MODE` | `embedded` | `embedded` or `client-server` |
| `CHROMA_HOST` | — | ChromaDB server URL |
| `CHROMA_API_KEY` | — | API key for cloud ChromaDB |
| `CHROMA_TENANT` | — | Tenant ID |
| `CHROMA_DATABASE` | — | Database name |

### Path Resolution
All paths support:
- **Relative paths** (`./data/memory.db`) — resolved from project root
- **Home directory** (`~/Documents/vault`) — `~` expands to `os.homedir()`
- **Absolute paths** (`/opt/claude-brain/data`) — used as-is

## Hooks Setup

Claude Brain auto-installs hooks when you run:
```bash
claude-brain hooks install
```

This adds PostToolUse and Stop hooks to `~/.claude/settings.json` that silently capture tool events in the background.

### Windows Note
Hooks use platform-detected syntax:
- **Windows**: `set CLAUDE_BRAIN_PORT=3333&& bun "path\to\hook.ts" --event Stop`
- **Unix**: `CLAUDE_BRAIN_PORT=3333 bun "path/to/hook.ts" --event Stop`

## Multi-Project Setup

Each project gets its own memory space. Brain auto-detects the project from the working directory, but you can always specify explicitly:

```
brain("auth decision", project: "api-server")
brain("auth decision", project: "mobile-app")
```

These are stored separately and recalled independently.

## Verification

Test your setup:
```
brain("Testing claude-brain connection. Status: working.")
brain("What do I know about this project?")
```

If both succeed, you're good to go.
