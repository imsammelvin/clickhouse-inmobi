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

Rows *returned* are bounded by dimension cardinality and that invariant holds. Rows *read* are not
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
