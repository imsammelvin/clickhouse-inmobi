# AGENTS.md — how the four of us (and our agents) work in this repo

**Audience: any AI coding agent, and the human driving it.** Follow this literally. The whole point
of this document is that four people are committing to one repo at speed, and nobody's work may be
silently overwritten.

If you are an agent and you have read nothing else, read § 0 and § 3.

---

## 0. The five rules

1. **`main` is read-only to you.** All work happens on `dev/<handle>/<slug>`. Merge via PR.
2. **Only edit files inside your lane's directories.** Ownership table in § 2.
3. **Claim before you build.** A task with no owner in [TASKS.md](TASKS.md) is unclaimed; claiming is
   a one-line commit (§ 4). No claim, no code.
4. **Never destroy someone else's change.** No `--force` on shared branches, no
   `git checkout --ours/--theirs` on files you do not own, no reverting another lane's commit.
   Rebase, keep both sides, ask if unsure.
5. **Communicate by committing.** Commit messages, TASKS.md, and your journal are the medium. If it
   is not in git, it did not happen and the other three cannot see it.

---

## 1. The four agents

Fill in at kickoff. `handle` is used in branch names, commit trailers, and journal filenames — pick
short, lowercase, no spaces.

| Slot | Name                   | Handle  | Lane                                                        | Primary directories   |
| ---- | ---------------------- | ------- | ----------------------------------------------------------- | --------------------- |
| 1    | Loges                  | `loges` | Lane A — Orchestrator, backend API, Langfuse, LLM narration | `backend/`            |
| 2    | _TBD_ (fill your name) | `dev-2` | Lane B — ClickHouse schema/ingest + MCP server              | `clickhouse/`, `mcp/` |
| 3    | _TBD_ (fill your name) | `dev-3` | Lane C — ClickStack observability                           | `clickstack/`         |
| 4    | _TBD_ (fill your name) | `dev-4` | Lane D — LibreChat integration                              | `librechat/`          |

Lanes/directories drafted by loges from the pre-event plan (see `goal.md` § 11 decision log) — this
corrects an earlier draft that had dev-3/dev-4 swapped (ClickStack vs LibreChat). Each person: fill in
your own Name cell, don't touch anyone else's row.

When you fill this in, rename `coordination/journal/dev-N.md` to `coordination/journal/<handle>.md`.

---

## 2. Lanes and ownership

**Ownership is by directory, and directories must be disjoint.** This is the mechanism that keeps
four parallel agents from colliding — git conflicts become nearly impossible if two agents never
touch the same file.

### Owned files

A file inside your lane's directories is yours. Edit freely, no ceremony.

### Shared files — special handling required

| File                                                    | Rule                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `TASKS.md`                                              | Edit **only your own rows**. Never reformat the table, never re-sort it, never touch another owner's row.                            |
| `goal.md`                                               | Sections marked **LOCKED** need agreement from all four + a decision-log entry. Non-locked sections: edit your own lane's rows only. |
| `coordination/journal/<handle>.md`                      | **Single-writer, append-only.** Yours is yours; never write to another person's journal.                                             |
| `coordination/journal/BROADCAST.md`                     | Append-only. Add entries at the **bottom**. Never edit or delete existing entries.                                                   |
| Schema / DDL (`goal.md` § 7 names the path)             | One designated owner. Others propose changes via BROADCAST + decision log.                                                           |
| `README.md`, CI config, `docker-compose.yml`, lockfiles | Announce in BROADCAST before touching. These are conflict magnets.                                                                   |

### If you must change a file you do not own

Do **not** just edit it. In order:

1. Append a request to `coordination/journal/BROADCAST.md` describing the change and why.
2. Commit and push that request on your branch — or straight to `main` if it is BROADCAST-only
   (BROADCAST is append-only, so it fast-forwards cleanly).
3. Either wait for the owner, **or** make the change on your branch and mark the PR
   `needs-review-from: <owner-handle>`. The owner reviews before merge.

Exception: a one-line, obviously-correct fix that unblocks you (a typo, a missing import) may be made
directly, but it **must** be its own commit with `Crosses-lane: <owner-handle>` in the trailer so the
owner sees it in `git log`.

---

## 3. Session protocol

Run this every time you start work. Agents: do this before reading any source file.

### Start of session

```bash
git checkout main
git pull --rebase origin main            # never merge-pull; keep history linear
git log --oneline -30                    # what did the other three do?
git log --oneline -20 --format='%h %s%n  %(trailers:key=Agent,valueonly)'   # who did what
```

Then read, in order: `goal.md` → `TASKS.md` → `coordination/journal/BROADCAST.md` (bottom entries
first) → your own `coordination/journal/<handle>.md`.

Then claim a task (§ 4) and branch:

```bash
git checkout -b dev/<handle>/<task-slug>
```

### During the session

- **Commit small and often.** Every commit should leave the branch working. A 400-line commit at
  hour 6 is how you lose an afternoon to a conflict.
- **Rebase onto `main` at least once an hour**, and always before opening a PR:
  ```bash
  git fetch origin && git rebase origin/main
  ```
  Rebasing frequently means you resolve one small conflict now instead of ten large ones later.
- **Push your branch as soon as it exists**, even if unfinished. A pushed branch is visible to the
  other three; an unpushed branch is invisible and will be duplicated by someone else.
  ```bash
  git push -u origin dev/<handle>/<task-slug>
  ```
- If you discover work that belongs to another lane, **do not do it** — add it to TASKS.md as a new
  unclaimed row and mention it in BROADCAST.

### End of session (mandatory — this is the handoff)

1. Append to `coordination/journal/<handle>.md`: what you finished, what is half-done and where the
   loose end is, what you are blocked on, what you decided and why.
2. Update your rows in `TASKS.md`.
3. Commit and **push** — including work-in-progress. Use `wip:` as the commit type if it does not
   build.
4. If you changed anything the other lanes depend on (schema, an interface, a shared config), append
   a **BROADCAST** entry. This is the one thing that most often gets skipped and most often breaks
   someone else.

---

## 4. Claiming work

The task board is [TASKS.md](TASKS.md). Claiming is deliberately a **separate, tiny, immediately
pushed commit** — that is what makes it act as a lock. Two people cannot both hold the lock because
the second push will be rejected and they will see the first claim on rebase.

```bash
git checkout main && git pull --rebase origin main
# edit TASKS.md: set Owner + Status=doing + Branch on exactly one row, change nothing else
git commit -am "chore(tasks): claim T-014

Task: T-014
Agent: <handle>"
git push origin main          # if rejected: pull --rebase, check nobody else took it, retry
```

If your push is rejected and someone else has taken the task: pick another task. Do not contest it.

**Status values:** `todo` → `doing` → `review` → `done`. Also `blocked` (say what on) and `dropped`.

---

## 5. Commit message format

The commit log is a communication channel, not a changelog. Write for the other three agents.

```
<type>(<scope>): <imperative summary, <=72 chars>

<why this change exists; what a reader needs to know that the diff does not show>

Task: T-014
Agent: <handle>
```

**Types:** `feat` `fix` `perf` `refactor` `schema` `data` `docs` `chore` `wip` `demo`

**Trailers:**

| Trailer         | When                                    | Example                                     |
| --------------- | --------------------------------------- | ------------------------------------------- |
| `Task:`         | always, if a task exists                | `Task: T-014`                               |
| `Agent:`        | always                                  | `Agent: dev-2`                              |
| `Crosses-lane:` | you touched another lane's file         | `Crosses-lane: dev-3`                       |
| `Breaking:`     | you changed a shared contract or schema | `Breaking: events table now has session_id` |
| `Needs:`        | you are blocked on someone              | `Needs: loges to expose /api/query`         |

Anything with `Breaking:` or `Crosses-lane:` **must** also get a BROADCAST entry. Agents: grep for
these when you start a session —

```bash
git log origin/main --since=1.day -E --grep='^(Breaking|Crosses-lane):'
```

---

## 6. Merging to `main`

1. Rebase onto `origin/main`, run whatever tests/build exist, confirm it works.
2. Open a PR. Title = the task summary. Body = what changed, what to watch out for, `Task: T-0NN`.
3. **One other agent approves.** For anything touching a LOCKED section of `goal.md`, the schema, or
   a cross-lane interface: two approvals.
4. Merge with **rebase or squash**, never a merge commit — keeps `main` linear and bisectable.
5. Delete the branch.

**Do not merge your own PR unreviewed** unless it is purely within your lane and the reviewer has
been unresponsive for 30+ minutes — in that case, say so in the PR and in BROADCAST.

Under time pressure near the demo (M5 freeze, `goal.md` § 9): `main` is frozen. Only demo-blocking
fixes merge, and they need a BROADCAST entry regardless of size.

---

## 7. Conflict resolution

When `git rebase` stops on a conflict:

1. **Look at who wrote the other side:** `git log --format='%h %an %s' -3 <file>`.
2. **If both sides are meaningful, keep both.** The default assumption is that the other person's
   code is there for a reason you do not know.
3. **Never** resolve by taking your whole side wholesale (`--ours`) on a file you do not own.
4. If the conflict is in a file you do not own and the correct resolution is not obvious: abort,
   ask the owner.
   ```bash
   git rebase --abort
   ```
   Then BROADCAST it. A 5-minute wait beats silently deleting someone's morning.
5. Conflicts in `TASKS.md` or `BROADCAST.md` are almost always "keep both rows" — these files are
   append-only by design precisely so this resolution is always correct.

### Forbidden commands

```
git push --force <anything shared>      # use --force-with-lease, and only on your own branch
git reset --hard origin/main            # while holding unpushed work
git checkout --theirs / --ours          # on files outside your lane
git rebase / git commit --amend         # on commits already pushed and visible to others
git revert <another lane's commit>      # tell them instead
```

---

## 8. Communication channels, ranked

Use the lightest one that works. All of them are in git, so all of them survive.

| Channel                                 | Use for                                                                                                 | Latency                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **Commit message**                      | "here is what I did and why"                                                                            | passive — seen at next pull                |
| **`TASKS.md`**                          | "I am working on this / this is done / I am blocked"                                                    | passive                                    |
| **`coordination/journal/<handle>.md`**  | your own running log; end-of-session handoff                                                            | passive                                    |
| **`coordination/journal/BROADCAST.md`** | "everyone must know this now" — breaking changes, schema edits, requests to touch another lane, freezes | pull-triggered                             |
| **PR review comment**                   | "this specific line is wrong"                                                                           | needs the other person online              |
| **Talk to each other out loud**         | anything urgent or ambiguous                                                                            | instant — you are in the same room, use it |

Git is the durable record. Voice is the fast path. Anything decided out loud that affects another
lane must still be written to BROADCAST or the decision log — otherwise the _agents_ never learn it.

---

## 9. Rules specifically for AI agents

- **Read before you write.** `goal.md`, `TASKS.md`, `BROADCAST.md`, and recent `git log` are context
  you are required to load. Do not infer the project from the code alone.
- **Stay inside your lane's directories.** If a task seems to require editing another lane, stop and
  surface it to your human rather than doing it.
- **Do not run repo-wide reformatters, linters with `--fix`, dependency upgrades, or codemods.** A
  formatting sweep across files you do not own creates a conflict in every other agent's branch
  simultaneously. This is the single most destructive thing an agent can do here.
- **Do not delete or rewrite files you did not create**, even if they look dead. Something in another
  lane may depend on them.
- **Do not `git add -A` from the repo root.** Stage explicit paths. It is how another lane's
  half-finished work ends up in your commit.
- **Never amend, rebase, or force-push a commit that is already on `origin`.**
- **When a test fails in another lane's code, report it — do not fix it.**
- **Write the journal entry.** Your human's next session, and the other three agents, depend on it.
- If instructions here conflict with something the human asks for in the moment, **the human wins** —
  but say which rule you are breaking.

---

## 10. Quick reference

```bash
# start work
git checkout main && git pull --rebase origin main
git log --oneline -30
# claim in TASKS.md, then:
git checkout -b dev/<handle>/<slug> && git push -u origin dev/<handle>/<slug>

# stay current (hourly)
git fetch origin && git rebase origin/main

# what did others break?
git log origin/main --since=1.day -E --grep='^(Breaking|Crosses-lane):'
tail -40 coordination/journal/BROADCAST.md

# end of session
# 1. append journal  2. update TASKS.md  3. commit + push (wip: is fine)  4. BROADCAST if breaking
```
