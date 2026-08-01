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

### 2026-08-01 14:45 — sam — proposed scope addition: residualization (T-040), affects Lane A

**What changed:** `goal.md` § 5 gains a residualization bullet, decision row **D-017** carries the
evidence, and `TASKS.md` gains **T-040** (residualization) and **T-041** (mix-vs-rate split).
Nothing in anyone's lane was edited. T-018 is untouched — T-040 sits _after_ it, it does not
replace it.

**Why, with numbers.** I ran the drill-down by hand against the loaded data for the Jun 23–25
fill-rate incident. A plain contribution-ranked sweep returns **21 segments** outside band:

    os_version=Android 15   0.7837 -> 0.4333   -35.04pp   (9.6% of traffic)
    region=EU               0.7850 -> 0.7300    -5.50pp
    publisher_tier=tier_1   0.9121 -> 0.8732    -3.89pp
    app_category=finance    0.7687 -> 0.7311    -3.76pp
    ad_format=banner        0.8232 -> 0.7867    -3.65pp   ... and 16 more

Re-running the identical sweep with `os_version != 'Android 15'` excluded:

    region=EU               -0.07pp      publisher_tier=tier_1   +0.01pp
    ad_format=banner        -0.15pp      publisher_tier=tier_3   -0.16pp
    every dimension, every value:  within +/-0.24pp

Twenty of those 21 were never causes. They were dilution — Android 15 is ~9.6% of traffic, so its
collapse drags every blended slice it appears in down by ~3pp. **One cause, twenty false leads.**

**Who is affected:** Lane A (`loges`) — this is your stage, your call. Lane D indirectly: the
diagnosis message needs a "cleared" list, not just a cause list.

**What you must do:** accept or reject T-040. If you reject it, please say so here so I stop
building the demo narrative on it. My argument for accepting: reporting those 20 segments is
precisely the "hallucinated segment" failure the rubric punishes hardest, it is an _algorithm_
problem that no amount of better narration fixes, and the ruled-out list the rubric asks for as a
bonus falls out of the deflation loop for free. Cost is ~2–4 extra ClickHouse round trips.

**Caveat, stated plainly:** greedy deflation assumes one dominant cause per pass. Genuinely
independent co-occurring causes need the loop to run to convergence rather than stopping at one —
that is handled, but it is the part most likely to be wrong, and it is worth a test.

**Commit:** branch `dev/sam/biz-specs`
