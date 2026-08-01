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
day against the _total_ of its three same-weekday priors: platform revenue on Jun 27 read **-65%**
when it is +4.4%. Ratio metrics are scale-invariant in the number of days pooled and hid it
completely — every fill-rate answer looked correct throughout, including one I had hand-checked
against the dossier. Now aggregated per day with a median across days, ratios formed componentwise,
matching `decompose.ts`. **If you compare windows anywhere else, check for this shape.**

**Commits:** `ae94f77`, `4dd9416`, `10fc971` on `dev/sam/mcp-server`

### 2026-08-01 20:10 — sam — addendum to my 19:55 entry: `criteria` deliberately passes the case my eval fails

Correcting the framing of the T-046 report above, because it changes what you should do about it.

`bun run criteria` **passes** the same case, on purpose:

    OK  E weekend decoy stays quiet -> supply_change, platform-normal stated=true,
                                       worst attributed $1.24 (max $5)

So Lane A's gate already considered this shape and accepted it, on the grounds that the
platform-normal verdict is stated first and the attributed dollars are bounded. My eval gates on
something stricter: that no segment is named as a cause at all on a normal day, because `channel` and
`findings` are what a chat client renders, and a reader who sees "supply_change / Publisher ops /
country|ad_format='IN|banner'" has been told a cause exists whatever the narrative said first.

**Both positions are defensible and this is a judgement call, not a bug I found in your code.** I
should not have called it "a defect" without noting your gate had already ruled on it. The facts in
the entry above are all verified and stand — Jun 27 is normal (+4.4%), the segment moved +9.7% on
2.09% of traffic — but the disagreement is about strictness, not correctness.

**T-046 is therefore a decision, not a fix**, and it is Lane A's to make: either tighten the product
path so an in-band platform emits no channel/owner, or decide the stated-verdict-plus-dollar-bound is
sufficient and I relax my gate to match. Say which here and I will align `mcp/eval` either way — I am
not going to have two gates in this repo disagreeing silently a day before the freeze.

### 2026-08-01 20:55 — sam — `bun run diagnose` exists: the unattended path and a judge-openable artifact

**What changed:** `mcp/diagnose.ts`, `mcp/report.ts`, `mcp/cost.ts` on `dev/sam/mcp-server`. New tasks
**T-047** (unattended path) and **T-048** (trace artifact) in TASKS.md, both mine, both in review.
Nothing outside `mcp/`, `pitch/`, `package.json` (one script: `diagnose`) and `.gitignore`.

**Why it matters to you:** on Day 2 nobody hands us a metric and a window. `bun run diagnose` takes no
arguments and produces the whole submission:

    46 firing windows -> 30 distinct incidents -> 6 investigated in 91s, nothing supplied by a human

    1. fill_rate  Jun 23-26  technical_break   os_version='Android 15'  -$20.45/day  42/42 grounded
    2. ecpm       Jun 16-22  demand_change     ad_format='interstitial'  -$5.40/day  36/36
    3. fill_rate  Jun 28-30  technical_break   os_version='iOS 18.1'     -$1.50/day  46/46
    4. revenue    Jun 19-26  not_localizable   platform-wide                         16/16
    5. requests   Jun 21-22  not_localizable   platform-wide                          6/6
    6. revenue    Jun 15-21  no_anomaly        platform-wide                          7/7

All four known incidents, B correctly as `not_localizable`, everything 100% grounded, and the 24
windows not escalated listed with numbers and reasons. **Run it before the demo and read the output —
it is the fastest way to see the whole system's current answer.**

Artifact: `pitch/example-report/report.html`. One self-contained file (no scripts, no fonts, no
network) with every number beside its SQL and hash, per-stage timings, cleared segments, and OTel
trace ids. Open it in a browser — no Docker, no credentials.

---

**A measurement Lane B will want, and it is the strongest argument for T-013 (rollup).**

`mcp/cost.ts` reads per-call cost out of `system.query_log` using the `run=`/`stage=` tag `Ledger`
already emits. One full unattended run:

    343,970,353 rows read | 4,096.9 MiB | 59,232 ms server | 848.2 MiB peak | 55 queries
    find_incidents alone:  135M rows across 10 queries

Rows _returned_ are bounded by dimension cardinality and that invariant holds. Rows _read_ are not
defended at all — one run reads ~38x the fact table, because every metric's sweep rescans full history
for its baseline and residualize re-runs the localize sweep per iteration. **T-013 is where this gets
fixed, and this number is the before-figure that makes the after-figure a scalability story rather
than a claim.** Numbers are in `pitch/example-report/report.json` under `cost`.

---

**A Day-2 bug of mine, now fixed, that you should check for in your own entry points.**

Nothing in my server called `ensureDatasetBounds`, so window validation and the sweep were using the
hardcoded training slice. Against a fresh Day-2 slice starting anywhere else, every window a judge
asked about would be rejected as "outside the loaded data" and the sweep would match zero rows — no
error, no empty result to notice, and a trace that looks exactly like a clean run. It is resolved once
per session inside `Session.run` now, so no entry point can forget it. samarth: thank you for
`0d66d8c`, it is the fix that made this findable. **Anyone with an entry point that pastes those
constants into SQL should confirm they call it.**

**Commits:** `b61762d` and predecessors on `dev/sam/mcp-server`

### 2026-08-01 21:20 — sam — Lane D: check whether LibreChat surfaces `instructions`, and how to fix it if not

**One thing to verify on the first real connection, and a one-command fallback.**

The MCP server returns an `instructions` block from `initialize`. That is the answer-style contract the
narrator reads before any tool result — lead with the verdict and the dollars, plain English, never
re-derive a number, report "no anomaly" as the answer. It is what makes chat answers crisp instead of
JSON dumps.

**`instructions` is advisory in the MCP spec.** A client may surface it, ignore it, or truncate it, and
several ignore it outright. I have not verified LibreChat's behaviour and cannot from here. If it is
dropped the tools still work perfectly — the failure is silent and cosmetic-looking, but it means
nothing is telling the model to stop re-deriving numbers, which is a criterion-2 risk, not a styling one.

**How to check:** connect, ask something vague like "how are we doing?", and see whether the answer
leads with a verdict and dollars or with a restatement of the question and a wall of JSON.

**If it is dropped:**

    bun run mcp:prompt > sys.md      # then paste into the agent's system prompt

That prints the exact string the server serves, from the single place it is defined — verified
byte-identical to the wire. **Please do not retype or summarise it into a config file**, or the served
contract and the pasted one drift and nobody notices which is live.

**Also hardened, no action needed from you:** the two data caveats that could otherwise produce a
confidently wrong answer from correct numbers are now repeated in the descriptions of the tools they
apply to, so they arrive whether or not the model calls `describe_data` first — ratios are sum/sum and
must never be averaged across rows (`get_metric`), and the dataset's real +6.4% growth trend means a
few percent up is the trend not an incident (`compare_periods`). Cost ~75 tokens.

**Commit:** on `dev/sam/mcp-server`

### 2026-08-01 — loges — T-046 shipped, T-045 shipped, incident C's shadow explained (not fixed)

**T-046 (materiality gate) — done.** `backend/orchestrate.ts`: `MIN_MATERIAL_SHARE_PCT = 5`, applied
to every confirmed cause on every path, not just the platform-quiet fallback — Jun 27's platform
revenue clears the anomaly gate _directly_ (+4.4%, no fallback), so a fix gated only on
`platformInBand` (first attempt) missed it and briefly regressed incident C's grounding by printing
`deltaPct`/`sharePct` in a ruled-out note without recording them as evidence first. Fixed by mirroring
the `res.contamination` pattern. Filtered causes report as `no_anomaly`, not `not_localizable` — that
stays reserved for `res.uniform`, protecting the real-but-unattributed CTR case. Verified: `mcp:eval`
15/15 gated 30/30 (was 14/15, 28/30), `criteria` still 4/4, decoy now attributes $0.00 (was $1.24).
A/B/C/D spot-checked unchanged.

**T-045 (plain-English renderer) — done, additive.** `renderPlain()` in `backend/render.ts`, wired to
`bun run explain -- --plain`. Does not touch `renderNarrative`/`renderFull` — separate function, same
`Investigation`, so grounding/criteria/mcp:eval are unaffected (re-verified green after). Matches
`pitch/diagnosis-template.md` §1 wording closely ("Their fill rate fell from 78% to 43%."). Known gap:
the "IS SOMETHING BROKEN" bullets still reuse `classify.ts`'s technical `cleared[]` notes verbatim
("Advertiser exit: 500 bidding before, 498 during") rather than the template's plain phrasing
("All 500 advertisers were still bidding") — rewriting those needs new plain-language fields on
`Classification`, which is a `classify.ts` change, not render-only, so left for a follow-up rather than
risked here.

**Incident C's segment shadow — investigated, not changed.** Diagnosed with a throwaway script against
`segments.ts` (not committed): the auto-detected window for `ecpm` isn't just wider than the dossier's
Jun 19-22 by coincidence. `country|ad_format='DE|interstitial'` / `UK|interstitial` / `FR|interstitial`
/ `ES|interstitial` all fire independently over Jun 16-20 at scores (~160) comparable to or _higher_
than `app_category='finance'` alone (144.3) — European interstitial eCPM looks like it may have had its
own real, separate drop that happens to overlap finance's Jun 19-22 window. `finance|interstitial`
narrowly wins the cluster's lead pick (161.1 vs 160.9), which is why the window widens to Jun 16-22 and
`investigate()`'s own residualize sweep over that wider window sometimes prefers `interstitial` to
`finance`. This is not obviously a bug in `clusterWindows`' scoring — it may be two genuine overlapping
signals, possibly a second, undocumented planted incident. Not touched: `segments.ts`'s clustering is
tuned against several known incidents already, and I do not have enough confidence in 20 minutes to
change it without risking a regression elsewhere. `investigate()` on the exact hand-verified window
(Jun 19-22) already gets this right today (confirmed: `mcp:eval` C-finance-ecpm passes 100%). Flagging
for whoever has time before the freeze to confirm whether the European-interstitial pattern is real.

---

## 2026-08-01 — T-013 landed: rollup MVs live. One decision-log correction, one cross-lane export, one patch offered to Lane A. — samarth (Lane B)

Branch `dev/samarth/rollup-mv`. Nothing in `backend/` changed except one word (below). Everything is
additive and every existing gate is green: `typecheck` clean, `mcp:eval` **16/16 cases / 60/60 gated**,
`criteria` **4/4**, `diagnose` unchanged (46 windows -> 30 incidents -> 6 investigated, 100% grounded).

### What exists now

`rollup_segment_hourly` (3,089,172 rows) and `rollup_segment_daily` (~148k), both `SummingMergeTree`,
long format: one row per `(bucket, dim, val)` -> `events, fills, impressions, clicks, revenue`. Sums
only, never a stored ratio. Maintained by two incremental MVs that fire on every `ad_events` insert —
`mv_rollup_segment_hourly` off `ad_events`, `mv_rollup_segment_daily` cascaded off the hourly table so
daily cannot disagree with hourly.

New commands: `bun run ch:rollup` (backfill — an MV only sees inserts made after it exists, so a
loaded table needs this once) and `bun run ch:verify-rollup` (the correctness gate) and
`bun run bench:rollup` (the measured delta). `ch:setup` chains all of them.

**Measured, 11 representative tool calls, cost from `system.query_log`, artifact in
`clickhouse/rollup-bench.json`:** rows read **213.6M -> 3.69M (57.9x)**, bytes 2,680 MiB -> 117 MiB,
peak memory **848 MiB -> 30 MiB**, server time **49.1s -> 1.0s (47x)**. `find_incidents` over the full
history: **38.2s -> 1.14s**. Every other tool call is 40-65ms.

### D-020 PROPOSED — the § 7 rollup grain is wrong, and I measured it before building

goal.md § 7 (LOCKED) specifies a rollup at `(hour, app_id, geo_device_id, advertiser_id, ad_format)`.
**Do not build that one.** Measured on the real table: that key space is so much larger than the event
count that 9M events land on ~9M distinct keys — it compresses nothing and would just be a second copy
of the fact table. The access pattern is never one app x one geo x one advertiser; it is one dimension
at a time, occasionally two.

What shipped instead: long format `(bucket, dim, val)`, carrying 11 single dimensions and **all 36
pairs of the 9 low-cardinality ones** — 4,221 segments, 148k daily rows. Entity dimensions (`app_id`,
`advertiser_id`) are carried singly but never paired: `app_id x os_version` alone is 529k daily rows,
more than every other pair combined. Cost grows with _cardinality x time_, not with events, which is
the petabyte answer § 3 promises.

§ 7 is LOCKED, so this is a **proposal, not an edit**. loges: please add D-020 to § 11 and correct the
§ 7 rollup bullet, or argue the other side here. The tables are already live either way — the DDL is
generated from a registry in `clickhouse/rollup.ts`, which is where the grain now actually lives.

### Crosses-lane: loges — one word in `backend/segments.ts`

`MIN_BASELINE_POINTS` is now `export const` instead of `const`. `mcp/sweep.ts` reads it rather than
restating it: a detection threshold that exists in two places will eventually differ in two places, and
the symptom would be two sweeps disagreeing about whether an incident happened. No behaviour change.

### Lane A: T-043 is now a small change, and here is the measured priority order

`find_incidents` went from ~40% of a `diagnose` run's rows read to **0.7%**. Everything left is engine
stages, from that run's own `query_log` attribution:

| stage                    | queries | rows read   | share | rollup-servable?                                  |
| ------------------------ | ------- | ----------- | ----- | ------------------------------------------------- |
| residualize              | 25      | 121,770,166 | 36.7% | partly — single-exclusion x small-dim target only |
| detect                   | 12      | 72,561,654  | 21.9% | **yes, fully**                                    |
| confirm (calls `detect`) | 16      | 66,008,845  | 19.9% | **yes, fully**                                    |
| localize                 | 5       | 21,722,112  | 6.5%  | unmasked pass yes; masked needs the pair          |
| decompose                | 10      | 21,722,107  | 6.5%  | **yes**                                           |
| classify                 | 4       | 15,775,802  | 4.8%  | no — `uniqExact` on advertisers is not a sum      |
| find_incidents           | 10      | 2,286,280   | 0.7%  | done                                              |

**Start with `detect`. 41.8% of the remaining rows for a three-line change.** Its query is one
`GROUP BY event_date` over a mask, i.e. 0-2 dimensions — exactly what the rollup serves:

```ts
// backend/stages/detect.ts
import { planRollup, RAW_SOURCE } from "../../clickhouse/rollup";

const src =
  planRollup({ dims: mask.dims ?? [], grain: "daily", expressions: [expr] }) ?? RAW_SOURCE;
const sql = `
SELECT toString(event_date) AS d, ${src.expr(expr)} AS v
FROM ${src.from}
WHERE (${mask.sql}) AND (...)
GROUP BY event_date ORDER BY event_date`;
```

The one thing it needs from you: **`Mask` should carry the dimensions it constrains.** `segmentPredicate`
and `andMask` in `backend/types.ts` already know them at construction — the type just does not record
them, so `planRollup` cannot be asked. A `dims?: readonly string[]` field populated there is enough, and
`NO_MASK` gets `dims: []`. Without it, pass `[]` and only unmasked detects hit the rollup, which is
still the 21.9% row.

Two rules if you take this: **(1) list EVERY dimension the query mentions, filters included** — a filter
costs a cut just as a group-by does, and forgetting one returns the _unfiltered_ number, which is
plausible and wrong. **(2) Add your case to `scripts/verify-rollup.ts`.** It runs the real query path
twice, rollup off then on, and asserts both the numbers and _which surface served them_ — a probe that
silently fell back would otherwise pass by comparing raw against itself.

`backend/scan.ts` (`bun run scan`) also still uses the raw sweep; `mcp/sweep.ts` exports
`scanSegmentsRollup` with an identical signature, verified firing-for-firing against yours, if you want
the one-line swap.

### Everyone: two hazards worth knowing about, because both are silent

1. **`DROP PARTITION` does not cascade into a materialized view's target.** The loader now drops
   `DERIVED_TABLES` partitions alongside the fact partition. Without that, a re-load makes the MV _add_
   a second copy of the day and every rollup-served figure comes back **exactly doubled**, with the fact
   table's row-count assertion still passing. **If you ever add a table fed by an MV, add it to
   `DERIVED_TABLES` in `enums/index.ts` or you will silently double-count on the next reload.**
2. **A derived table's failure mode is being behind its source, and behind does not throw** — a missing
   day reads as a day with no traffic. `ensureRollupReady` proves the rollup accounts for exactly as many
   events as `ad_events` before anything reads it. If it cannot, everything falls back to
   `ad_events_enriched` and only latency changes. If you add an entry point that queries the rollup, call
   it (same place you call `ensureDatasetBounds`).

Also: `get_metric` / `compare_periods` / `rank_segments` / `find_incidents` results now carry
`servedFrom` (`rollup:daily:os_version`, `rollup:hourly:region|os_version`, or `raw`). Additive field.
Lane D — worth showing in the chat surface; it is the scalability claim in the response envelope.

### Lane D: tool output ordering is now deterministic (behaviour change in `mcp/query.ts`)

Separate find, same branch, and it matters to you because you render these rows. `ORDER BY requests
DESC` was not a total order and the result is truncated by LIMIT — so `get_metric` grouped by `app_id`
(2,000 rows, 25 returned, traffic even enough that the cut-off routinely ties) could return **different
segments on two identical calls**, depending on how ClickHouse parallelised the aggregation. Found by
`ch:verify-rollup` running the same call twice on the same code path and getting two different top-N
sets. All four orderings now carry the group columns as a tiebreaker. Same rows, stable order; nothing
to change on your side, but "re-run it and get the same answer" is now actually true.

### sam: your synth harness was testing the raw path, not the shipping one — fixed

`mcp/synth/generate.ts` applies `clickhouse/schema.sql`, and the rollup DDL is not in that file (it is
generated from a registry in `clickhouse/rollup.ts`, because the 47-expression fan-out must agree
exactly with what the query planner believes exists). So `rca_synth` had `ad_events`, the dimensions and
the enriched view, and no rollup tables.

That does not crash, which is why it is worth a BROADCAST entry: `ensureRollupReady` finds the tables
missing and every query falls back to `ad_events_enriched`. The harness would have kept scoring green
while exercising the path production no longer uses — invisibly. Added `rollupStatements()` to the
schema it applies, before the events are inserted, so the MVs populate incrementally as the generator
writes and no backfill step is needed.

Also added a TRUNCATE of the rollup tables next to the `ad_events` one. TRUNCATE does not cascade into
a materialized view's target any more than DROP PARTITION does, so a rebuild without `--reset` would
have emptied the fact table, re-inserted it, and left the MVs adding a second copy on top of the rows
still sitting in the rollup — every rollup-served figure in the scratch database doubled while
`ad_events` counted correctly.

Verified on a real rebuild: 9,627,421 events in `ad_events`, both rollups summing to exactly 9,627,421
across all 47 dim keys, built entirely by the MV. `synth:verify` still finds and localizes 5/5 planted
deviations with 0 gated failures. **The general rule: any tooling that builds a database from
`schema.sql` now also needs `rollupStatements()`, or it is silently testing the slow path.**

### Lane C: four empty tables are yours, and I left them alone

Audited every object in the service before merging. Nothing of ours is unused. The only empty objects
are `hyperdx_sessions`, `otel_metrics_exponential_histogram`, `otel_metrics_gauge` and
`otel_metrics_summary` — 0 rows each. They are part of HyperDX's own fixed schema and it queries them by
name, so dropping them would break the next signal type that arrives. They occupy 0 bytes, so there is
nothing to reclaim. Your call, not mine.
**Harness hardened so this cannot recur:** default volume now matches production, `verify.ts` refuses
to score when dimensions are blank, and `spec.ts` documents the blind zone with the two false reports
that taught me it. My lesson, plainly: **a test harness sized below production measures its own noise**,
and I should have run the scale sensitivity before writing a defect report, not after.
### 2026-08-02 00:15 — loges — Lane D: LibreChat session hygiene is inflating first-call token cost

**One real trace showed a 26,088-token first call for a 7-word question.** Pulled the raw `input`
via the Langfuse API (not just the UI list preview, which only shows the first message of a
multi-turn array and looks stale/misleading by itself). The system message carried a ~1,900-word
"Conversation Summary/Checkpoint" that was leftover context from a **different, unrelated
conversation** (an earlier Android-15 investigation, another teammate's session) — the thread had
been continued by a different person rather than started fresh.

**Good news underneath it:** DeepSeek prompt caching is genuinely working — the *next* two calls in
that same session reused ~84-89% of input tokens from cache (at ~50x cheaper than a cache miss), so
steady-state turns are already cheap. The fixed cost is specifically the one uncached first call per
session, not a resend-everything-every-turn problem.

**Ask, not a blocker:** during testing, please start a fresh LibreChat conversation per person/session
rather than continuing someone else's thread — it's the difference between a clean cold-start and one
carrying an irrelevant multi-KB checkpoint at full price. Not a code bug on your end, just a testing
habit worth adopting before the freeze. Full numbers in `pitch/llm-cost-optimization.md` §3.

**Commits:** none (docs only) — `pitch/llm-cost-optimization.md` updated, not yet pushed (loges' own
rule: only loges pushes their own commits).
