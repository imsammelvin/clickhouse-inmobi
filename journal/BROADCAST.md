# BROADCAST — everyone must read this

**Append-only. Newest at the bottom. Never edit or delete an existing entry.**

Post here when something affects a lane that is not yours:

- you changed the schema or a cross-lane interface (anything with a `Breaking:` trailer)
- you edited, or need to edit, a file you do not own (`Crosses-lane:`)
- you merged something that changes how others run the project (scaffold, docker, deps, config)
- you are declaring a freeze, or you are blocked and it will hold someone else up

Read `tail -40` of this file at the start of every session. Format:

```
### YYYY-MM-DD HH:MM — <handle> — <one-line headline>
**What changed:** …
**Who is affected:** …
**What you must do:** …
**Commit:** <sha or branch>
```

---

### 0000-00-00 00:00 — setup — coordination scaffold added
**What changed:** `goal.md`, `AGENTS.md`, `TASKS.md`, `CLAUDE.md`, and `coordination/journal/` created.
**Who is affected:** everyone.
**What you must do:** read `AGENTS.md` before your first commit. Fill in `goal.md` and the handle/lane
tables in `AGENTS.md` § 1–2 at kickoff (tasks T-001, T-002). Rename your `dev-N.md` journal to your handle.
**Commit:** initial scaffold

<!-- append new entries below this line -->

### 2026-08-01 13:54 — loges — goal.md/AGENTS.md/TASKS.md drafted for kickoff review
**What changed:** `goal.md` fully drafted (architecture, data model against the real `inmobi/` package,
milestones pinned to today's actual event clock, decision log, risks). `AGENTS.md` §1 lanes/directories
assigned: loges→`backend/`, dev-2→`clickhouse/`+`mcp/`, dev-3→`clickstack/`, dev-4→`librechat/`.
`TASKS.md` T-005 marked done (data already landed), T-006 given to Lane B, T-013–T-025 added covering
the full pipeline.
**Who is affected:** everyone — please read `goal.md` in full before claiming a task, it's the plan
we're building against.
**What you must do:** confirm or dispute §7/§8 (LOCKED) in this file, don't silently edit them. Fill in
your Name cell in `AGENTS.md` §1. Note: this corrects an earlier informal draft that had dev-3
(ClickStack) and dev-4 (LibreChat) swapped — if you were already working under the swapped
assignment, stop and re-check which lane is actually yours.
**Commit:** branch `dev/loges/kickoff-goal`
