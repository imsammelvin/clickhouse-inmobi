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

### 2026-08-01 18:20 — samarth — four relevance fixes in backend/ (Lane A files)
**What changed:** `backend/stages/decompose.ts`, `backend/stages/classify.ts`,
`backend/orchestrate.ts` on branch `dev/samarth/relevance-fixes` (`4e8a318`). All four defects were
the same shape — arithmetic correct, sentence wrong — which grounding cannot catch by design.
(1) decompose compared a 4-day window against a 9-day baseline pool with a different weekday mix;
baseline is now aligned day-for-day on weekday with a median across days. (2) classify received the
platform decomposition for a segment finding; classify and price now share one cause-scoped
decomposition. (3) `uniqExact` pooled over an N-day baseline inflated advertiser counts and
manufactured demand-change on any narrow segment; now per-day medians. (4) the headline joined the
scope's delta to a platform-wide cause with "driven by".
**Who is affected:** Lane A (`loges`) — these are your files, please review. Lane D — diagnosis
channels changed for two incidents, so any fixtures keyed on them need regenerating.
**What you must do:** `bun install` before running anything (`@opentelemetry/api` is missing on a
fresh clone). Channels through the product path are now A technical_break, B not_localizable,
C demand_change, D technical_break, decoy supply_change. All four criteria pass.
**Still open:** the decoy states the platform verdict first and prices at $1.24/day but still emits
a channel and an owner. Suppressing it needs a materiality rule; dollars alone cannot separate it
from incident D ($1.50/day), share of traffic can (1.7% vs 9.8%). I deliberately did not ship a
threshold tuned to split those two.
**Commit:** `4e8a318` on `dev/samarth/relevance-fixes`

### 2026-08-01 19:55 — sam — MCP server is up (T-021), one cross-lane defect found, two shared files touched

**What changed:** new directory `mcp/` — MCP server exposing the engine as 10 tools, on branch
`dev/sam/mcp-server`. This is the front door: LibreChat talks to it, it talks to `backend/`.
Contract, tool table and JSON shapes are in **`mcp/README.md`** — that is the file to read, not this
entry.

**Lane note:** `mcp/` is Lane B's directory per goal.md § 6 and T-021 was unclaimed. I claimed it and
built it because the front door was the gap, not the engine. Commits carry `Crosses-lane: dev-2`.
samarth — if you want it back, say so here and I will stop.

**Two shared files touched, announcing as § 2 requires:**
- `package.json` — three new scripts, nothing else edited: `mcp:stdio`, `mcp:http`, `mcp:eval`.
- `.gitignore` — ignores `mcp/traces/` (a trace is written on every tool call; keep an exhibit by
  copying it into `pitch/` deliberately).

---

**A defect in `backend/orchestrate.ts`, which is not my file — reporting, not fixing (§ 9).**

`investigate(metric='revenue', from='2026-06-27', to='2026-06-27')` returns channel
`supply_change` and names `country|ad_format='IN|banner'` as the cause. Verified independently
with three separate tool calls:

    platform revenue Jun 27      434.42  vs  416.23 same-weekday baseline   =  +4.4%
    Jun 20 (prev Saturday)       416.23 / 224,327 requests
    Jun 27                       434.42 / 228,266 requests
    Jul 04 (next Saturday)       440.87 / 232,726 requests
    country|ad_format=IN|banner    2.13  vs    1.95                         =  +9.7%
                                 4,764 of 228,266 requests                  =  2.09% of traffic

Jun 27 is an ordinary Saturday, and the segment we blame moved **up 9.7% on 2.09% of traffic**,
worth $2.13/day. So we emit a cause, a channel and an owner for a normal day. This is the
seasonality-decoy failure the rubric punishes hardest, and it is the materiality gap samarth already
flagged in the 18:20 entry ("dollars alone cannot separate it from incident D; share of traffic can")
— this is a second, independently-found instance of it, on a different date and metric.

**Who is affected:** loges (`backend/` owner), samarth (you flagged the underlying gap). Lane D
indirectly: a chat client that renders `channel` and `findings` will show a cause on a normal day
even when the narrative says the platform was in band.

**What you must do:** nothing for me — my lane is unblocked and the eval reports it rather than
hiding it. But this is worth a materiality rule before the demo. The input it needs is already in the
payload: every finding carries `segmentSharePct`, and 2.09% vs incident D's 9.8% separates cleanly
where dollars ($2.13 vs $1.50) do not. **Added as unclaimed T-046 in TASKS.md** — deliberately not
claimed by me, since it is a threshold decision in your stage and your call.

**Also worth knowing — a bug of the same family that WAS mine, now fixed (`10fc971`).**
`compare_periods` aggregated each side with one conditional sum, so an absolute metric compared one
day against the *total* of its three same-weekday priors: platform revenue on Jun 27 read **-65%**
when it is +4.4%. Ratio metrics are scale-invariant in the number of days pooled and hid it
completely — every fill-rate answer looked correct throughout, including one I had hand-checked
against the dossier. Now aggregated per day with a median across days, ratios formed componentwise,
matching `decompose.ts`. **If you compare windows anywhere else, check for this shape.**

**Commits:** `ae94f77`, `4dd9416`, `10fc971` on `dev/sam/mcp-server`
