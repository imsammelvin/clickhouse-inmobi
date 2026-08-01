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
| T-001 | Fill in `goal.md` — all `_TBD_` resolved | all | loges | doing | dev/loges/kickoff-goal | — | Drafted solo by loges from problem statement + team plan since data package landed mid-session; needs the other three to review/amend, not re-do from scratch. |
| T-002 | Assign handles + lanes + directories in `AGENTS.md` § 1 and § 2 | all | loges | doing | dev/loges/kickoff-goal | T-001 | Directories must be disjoint. Names left `_TBD_` for each person to fill their own row. |
| T-003 | Repo scaffold: directory per lane, `.gitignore`, `docker-compose.yml` for ClickHouse | — | — | todo | — | T-002 | One person only. Announce in BROADCAST when merged. |
| T-004 | Everyone can run ClickHouse locally and query it | all | — | todo | — | T-003 | Each person confirms in their journal. |
| T-005 | Pick + download the dataset, document size/shape in `goal.md` § 7 | — | — | done | — | T-001 | Already landed in `inmobi/` (dev-2's commit `924059a`) and documented in `goal.md` § 7. |
| T-006 | Write canonical DDL (`schema.sql`) — engine, `ORDER BY`, MVs | Lane B | — | todo | — | T-005 | Schema owner only. `Breaking:` on every later change. Target shape drafted in `goal.md` § 7 — ad_events + 3 dims + rollup. |
| T-007 | Define cross-lane interfaces in `goal.md` § 8 so lanes can mock each other | all | — | todo | — | T-002 | Do this early — it is what unblocks parallel work. |
| T-008 | Ingest path: raw data → ClickHouse, repeatable and idempotent | — | — | todo | — | T-006 | |
| T-009 | Vertical slice: one query path working end to end | — | — | todo | — | T-008, T-007 | M2. Ugly is fine. |
| T-010 | Demo script written out beat by beat in `goal.md` § 4 | all | — | todo | — | T-001 | Write before building the polish. |
| T-011 | Demo fallback recorded (video / seeded local data) | — | — | todo | — | T-009 | Do not leave to the last hour. |
| T-012 | README: what it is, how to run it, screenshots | — | — | todo | — | T-009 | Judges read this. |

## Backlog

| ID | Task | Lane | Owner | Status | Branch | Depends on | Notes |
|---|---|---|---|---|---|---|---|
| T-013 | Rollup table + MV from `ad_events` (sums only, never pre-averaged ratios) | Lane B | — | todo | — | T-006 | Per `metrics_glossary.md` — ratio metrics must be sum/sum at query time. |
| T-014 | Detection sweep query: seasonality-aware baseline (same weekday/hour, trailing weeks) + two-gate flag (% AND stddev) | Lane B | — | todo | — | T-013 | Must catch the planted pure-seasonality movement and rule it out, not alarm on it. |
| T-015 | Revenue-identity attribution query (Requests × Fill rate × Impressions/Fills × eCPM/1000) | Lane A | — | todo | — | T-013 | Formula fixed in `goal.md` § 7 from `metrics_glossary.md` — do not re-derive. |
| T-016 | One parameterized GROUPING SETS drill-down query across all single + pairwise dimension cuts | Lane B | — | todo | — | T-013 | Dimensions listed in `goal.md` § 7. One query, not N. |
| T-017 | Statistical significance gate (sample-size floor for rates, min-volume floor for absolutes) | Lane A | — | todo | — | T-016 | Failing segments logged as "ruled out: insufficient volume," not dropped silently. |
| T-018 | Contribution-to-delta ranking + simple explainable confidence score | Lane A | — | todo | — | T-016, T-017 | Rank by share of total delta, not raw %. |
| T-019 | LLM narration prompt: JSON-in only, forbid any number not present in input | Lane A | — | todo | — | T-018 | The single-worst scoring outcome is one fabricated number — guard this hard. |
| T-020 | Langfuse tracing: one trace per investigation, Stage 0–6 as nested spans | Lane A | — | todo | — | T-015 | This is the direct "traceability" judging criterion. |
| T-021 | ClickHouse MCP server wired to the drill-down/detection queries | Lane B | — | todo | — | T-016 | Handbook's own starting point — should be quick. |
| T-022 | ClickStack instrumentation of the investigation backend (per-stage latency, errors, traces) | Lane C | — | todo | — | T-009 | Produces the evidence for "diagnosed in seconds." |
| T-023 | LibreChat: render investigation JSON as a formatted diagnosis chat message | Lane D | — | todo | — | T-018 | Mock against a sample JSON payload per `goal.md` § 8 — don't block on Lane A's API. |
| T-024 | LibreChat: follow-up question loop (triggers a real ClickHouse/MCP query, not canned) | Lane D | — | todo | — | T-021, T-023 | Bonus feature — build after T-023 is solid. |
| T-025 | Rehearse full pipeline end-to-end, unattended, on 3+ training-set incidents (incl. a non-revenue metric) | all | — | todo | — | T-019, T-022, T-023 | Validates the "unseen incident" readiness before Day 2. No hand-tuning during this. |

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
