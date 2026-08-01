# TASKS — shared board

**Rules (see [AGENTS.md](AGENTS.md) § 4):**

- Edit **only your own rows**. Never re-sort, reformat, or re-number the table.
- Claiming = set `Owner` + `Status: doing` + `Branch`, in its own commit, pushed immediately.
- Add new tasks at the **bottom** of the backlog with the next free ID. Never reuse an ID.
- Status: `todo` → `doing` → `review` → `done`, plus `blocked` / `dropped`.
- If a row conflicts on rebase, the answer is almost always **keep both rows**.

---

## Active

| ID | Task | Lane | Owner | Status | Branch | Depends on | Notes |
|---|---|---|---|---|---|---|---|
| T-001 | Fill in `goal.md` — all `_TBD_` resolved | all | — | todo | — | — | Kickoff, all four together. Blocks everything. |
| T-002 | Assign handles + lanes + directories in `AGENTS.md` § 1 and § 2 | all | — | todo | — | T-001 | Directories must be disjoint. |
| T-003 | Repo scaffold: directory per lane, `.gitignore`, `docker-compose.yml` for ClickHouse | — | — | todo | — | T-002 | One person only. Announce in BROADCAST when merged. |
| T-004 | Everyone can run ClickHouse locally and query it | all | — | todo | — | T-003 | Each person confirms in their journal. |
| T-005 | Pick + download the dataset, document size/shape in `goal.md` § 7 | — | — | todo | — | T-001 | |
| T-006 | Write canonical DDL (`schema.sql`) — engine, `ORDER BY`, MVs | — | — | todo | — | T-005 | Schema owner only. `Breaking:` on every later change. |
| T-007 | Define cross-lane interfaces in `goal.md` § 8 so lanes can mock each other | all | — | todo | — | T-002 | Do this early — it is what unblocks parallel work. |
| T-008 | Ingest path: raw data → ClickHouse, repeatable and idempotent | — | — | todo | — | T-006 | |
| T-009 | Vertical slice: one query path working end to end | — | — | todo | — | T-008, T-007 | M2. Ugly is fine. |
| T-010 | Demo script written out beat by beat in `goal.md` § 4 | all | — | todo | — | T-001 | Write before building the polish. |
| T-011 | Demo fallback recorded (video / seeded local data) | — | — | todo | — | T-009 | Do not leave to the last hour. |
| T-012 | README: what it is, how to run it, screenshots | — | — | todo | — | T-009 | Judges read this. |

## Backlog

| ID | Task | Lane | Owner | Status | Branch | Depends on | Notes |
|---|---|---|---|---|---|---|---|
| T-013 | _add yours here_ | | — | todo | — | | |

## Done

| ID | Task | Owner | Merged as |
|---|---|---|---|
| | | | |

---

## Blocked — needs a human decision

Move a row here when it is stuck on something no agent can resolve. Say **what** would unblock it.

| ID | Blocked on | Who can unblock | Since |
|---|---|---|---|
| | | | |
