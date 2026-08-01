# clickhouse-hackathon

Four people and their agents building on ClickHouse, in parallel, in one repo.

**Start here:**

| File                                                         | What it is                                                                                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| [context/AGENTS.md](context/AGENTS.md)                       | How we work: branch discipline, file ownership, how to claim work, how not to clobber each other. **Read before your first commit.** |
| [context/goal.md](context/goal.md)                           | What we are building. Fill in at kickoff.                                                                                            |
| [context/TASKS.md](context/TASKS.md)                         | The shared board. Claim a task before writing code.                                                                                  |
| [context/journal/BROADCAST.md](context/journal/BROADCAST.md) | Things everyone must know. `tail -40` it every session.                                                                              |
| `context/journal/<handle>.md`                                | Your own append-only log and end-of-session handoff.                                                                                 |

The one-line version: **never commit to `main`, only edit files in your lane, claim tasks in
TASKS.md before you start, and write a journal entry before you stop.**

**Repo layout:** `frontend/` (the dashboard UI) · `backend/` (investigation engine, MCP server,
ClickHouse client, API, dashboard server, observability, ops scripts) · `shared/` (utils, constants,
enums, interfaces used across `backend/`) · `context/` (team coordination docs — not shippable
product, safe to remove before final submission) · `pitch/` (judge-facing deliverables) · `inmobi/`
(dataset + problem statement).
