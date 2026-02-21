# Claude Brain — Workflow Patterns

## Pattern 1: New Project Kickoff

```
1. brain("starting new project: task-manager app with React + Supabase")
2. Work on the project...
3. brain("Architecture decisions: using Supabase for auth + DB, React Query for data fetching, Zustand for client state. Chose Supabase over Firebase because of Postgres flexibility and row-level security.")
4. brain("Session summary: scaffolded project with Vite + React + TypeScript. Set up Supabase client, created tasks table with RLS policies. Next: build task CRUD UI.")
```

## Pattern 2: Continuing Previous Work

```
1. brain("What do I know about task-manager?")
   -> Returns: architecture decisions, last session's progress, known issues
2. Pick up where you left off with full context
3. brain("Completed task CRUD UI with optimistic updates via React Query. Hit issue with RLS policy blocking anonymous reads — fixed by adding a public read policy. Next: add user authentication flow.")
```

## Pattern 3: Technical Decision Making

```
1. User asks: "Should we use REST or GraphQL for the API?"
2. brain("What API decisions have we made before?")
   -> Returns: past decisions about API design across projects
3. Make recommendation informed by history
4. brain("Decided to use REST for task-manager because: simple CRUD operations, Supabase has built-in REST via PostgREST, team is more familiar with REST. GraphQL would be overkill for this use case.")
```

## Pattern 4: Debugging with Memory

```
1. Hit a bug
2. brain("Any past issues with Supabase RLS or auth?")
   -> Returns: previous corrections and patterns
3. Debug informed by past experience
4. brain("Correction: Supabase RLS policies need explicit service_role bypass for server-side operations. Using anon key from client only allows public policies. Always use service_role key in API routes.")
```

## Pattern 5: Cross-Project Learning

```
# In project A:
brain("Solved infinite re-render loop by memoizing context value with useMemo", project: "dashboard")

# Later, in project B:
brain("React performance issues with context?", project: "mobile-app")
-> Returns the fix from project A, preventing the same mistake
```

## Pattern 6: Team Knowledge Building

```
# Document patterns the team should follow:
brain("Pattern: all API errors should return { error: string, code: string, details?: unknown } shape. This is our standard error envelope.")
brain("Anti-pattern: never throw raw Error objects from API routes. Always wrap in AppError with a code.")
brain("Best practice: use Zod for all input validation at API boundaries. Define schemas next to route handlers.")
```

## Pattern 7: Long-Running Feature Development

```
# Day 1
brain("Starting multi-day feature: real-time collaboration. Plan: WebSocket server, CRDT for conflict resolution, presence indicators.")

# Day 2
brain("What's the status of the collaboration feature?")
brain("Completed WebSocket server with Socket.io. Tested basic message passing. Issue: reconnection doesn't restore room state. Next: implement CRDT with Yjs.")

# Day 3
brain("What issues did we have with the collaboration feature?")
brain("Integrated Yjs for CRDT. Reconnection now works via Yjs state sync. Performance concern: large documents cause slow initial sync. Next: add presence cursors and optimize initial load.")

# Day 4
brain("Session summary: collaboration feature complete. WebSocket + Yjs + presence cursors. Optimized initial sync with lazy loading of document history. Ready for code review.")
```

## Anti-Patterns to Avoid

### Over-storing
```
Bad:  brain("reading the README file")
Bad:  brain("ran npm install")
Bad:  brain("opened src/index.ts")
Good: brain("Project uses unconventional src/app/ structure instead of src/pages/ — important for routing")
```

### Under-storing
```
Bad:  Make 5 architecture decisions without storing any
Good: Store each decision with reasoning as you make it
```

### Storing without project context
```
Bad:  brain("use PostgreSQL")  # which project?
Good: brain("use PostgreSQL for data warehouse", project: "analytics-platform")
```

### Forgetting to recall
```
Bad:  Recommend a library without checking if there's a prior decision
Good: brain("what libraries have we chosen for this project?") -> then recommend
```
