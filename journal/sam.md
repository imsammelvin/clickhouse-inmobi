# sam — session log

## 2026-08-01 · handoff (read this to resume)

**Hackathon:** ClickHouse Click-a-thon, InMobi problem — automated root-cause analyst.
Started 12:00 Aug 1, **code freeze 12:00 Aug 2**. Unseen incident dataset drops mid-window.

**My lane:** Biz (`pitch/`), but I also built `backend/` — the investigation engine. `goal.md` § 6
assigns `backend/` to `loges`; my commits carry `Crosses-lane: loges` and it is unmerged on
`dev/sam/biz-specs`. Other lanes: `clickhouse/` + `scripts/` (samarth), `observability/` + `main.ts`
+ `api/` (MOHANSUNDAR K), Langfuse PoC in `backend/langfuse/` (loges, not wired to the engine).

---

### The three judging criteria — never deviate

1. **Detection & localization accuracy** — found / missed / hallucinated, vs a private answer key.
2. **Explanation trustworthiness** — every number reproducible. *One fabricated figure costs more
   than a missed anomaly.*
3. **Analytical depth in ClickHouse** — drill-down in queries, not in the LLM.

`bun run criteria` is these as a **gate that exits non-zero**. Currently all pass. Run it after
every change.

---

### Commands

```
bun install                      # REQUIRED on fresh clone; OTel deps missing otherwise
bun run criteria                 # the judging gate — run this constantly
bun run explain -- --metric fill_rate --from 2026-06-23 --to 2026-06-25
bun run scan                     # blended + segment sweep across all 35 days
bun run bench -- --compare pitch/bench-baseline.json
bun run serve                    # api on :3000 — /health /ping /ad-events/count only
```

`.env` holds ClickHouse Cloud creds (gitignored). 9M rows live, dictionaries + `ad_events_enriched`
view exist.

---

### Engine architecture (`backend/`)

`detect → decompose → localize → residualize → classify → price`, fixed order, **no LLM in the
control flow**. Every query goes through `Ledger.run`, which records SQL + hash; nothing else
imports the ClickHouse client. `render.ts` produces the text; `grounding.ts` verifies every numeral
in that exact text resolves to an `Evidence` row.

**Residualization is the differentiator.** Rank candidates, exclude the top one, re-sweep; anything
that returns to band was contamination not a cause. On the flagship: 178 candidates → 1 cause, 151
cleared. It can also return **zero** causes (incident B) rather than fabricating one.

---

### The five training incidents (`pitch/incident-dossier.md`)

| | Window | Cause | Product path says |
|---|---|---|---|
| A | Jun 23–25 | `os_version='Android 15'` fill 0.784→0.433 | technical_break, −$21.05/day ✅ |
| B | Jun 21 | none — uniform −44% everywhere | not_localizable ✅ |
| C | Jun 19–22 | `app_category='finance'` eCPM −35% | found, −$13.05/day, **channel wrong** |
| D | Jun 28–30 | fill dip, segment-level | found, **channel wrong** |
| E | weekends | seasonality decoy | platform-normal stated, $1.98 attributed ✅ |

---

### Open items, ranked

1. **C and D classify as `supply_change`** (C was `demand_change`). Unscoped `decompose` over C's
   window makes requests the driver because **Jun 21 sits inside it**. Localization and dollars are
   right, the channel is not. Same window-contamination pattern, one stage over.
2. **Unattended entry point** — `sweep → windows → investigate each`, one command, no human. This
   *is* the unseen-incident submission artifact. Nobody will hand you metric + window on Day 2.
3. **`demand_change` branch has never executed.** Zero advertisers enter or exit the training
   window. Synthesize an advertiser exit, drive it through (2), assert it lands on `demand_change`.
   (2) and (3) are one piece of work; `segment` is now a parameter so it is straightforward.
4. **Plain-English renderer (T-045).** `render.ts` prints `-35.17pp on 9.6% of traffic`; § 1 of
   `pitch/diagnosis-template.md` is the target wording. Presentation only.
5. **BROADCAST the `bun install` drift** before demo morning.

---

### Traps — each of these cost real time

- **`advertiser_id` is empty on unfilled requests.** Advertiser-sliced fill rate is definitionally
  broken. Guarded by `FILLED_ONLY_DIMENSIONS`; do not regress it.
- **Baselines contain prior incidents.** Jun 21's collapse sits in Jun 28's baseline. Use **median +
  MAD**, never mean + stddev. This bit `detect` once and `localize` again later — a mean-based
  baseline made a normal Sunday read +22.9%.
- **Pair dimensions** are synthetic (`region|os_version` = `EU|Android 15`). Rendering them as SQL
  needs `segmentPredicate()` in `types.ts`. Hand-rolling it broke three times.
- **The growth trend is real** (+6.4% over the window). Estimate it from the whole series, never
  from 3–4 baseline points — Theil-Sen on 3 points got hijacked by an outlier and reported +213% at
  427σ.
- **Multiple testing.** Segment sweep runs ~98k tests; at 2.5σ ~1% fire by chance. Segment gates are
  5σ/10%. The more places you look, the higher the bar.
- **A gate never seen red is not known to work.** Force it to fail before trusting it. I shipped a
  vacuous assertion (`!x === false || y`) *inside* the fix for another vacuous gate.
- **Grounding verifies arithmetic, not relevance.** We once answered a CTR question with a fill-rate
  number — every figure real, every figure grounded, sentence still wrong.
- **Scale rule (standing):** every function and query must be written with scale in mind. Bound
  windows, push work into SQL, return only what is needed.

---

### Key decisions (`goal.md` § 11)

- **D-017** residualize, don't just rank.
- **D-018** this is **InMobi's** marketplace view, not an advertiser tool. Buy-side questions out of
  scope. Median advertiser is 116 impressions/day — per-advertiser detection would be noise.
- **D-019** attribute using the **given dataset only**. No calendars, no event/contextual modelling.
  Tested first: vertical↔category affinity does not exist (eCPM 2.4654 vs 2.4721) and there is no
  event structure. Latency, scale and bounded LLM cost are the primary axis.

### Reviewer's standing verdict

> "The analysis engine is better than most of what will be in that room. It refuses to fabricate, it
> de-shadows, it grounds every number." — the gaps have been the *front door*, not the engine.

---

## 2026-08-01 · session 2 — MCP server (T-021)

**Built the front door.** `mcp/` — the user layer. LibreChat talks to it, it talks to `backend/`.
Contract in `mcp/README.md`; read that, not this. Claimed T-021 cross-lane (it is Lane B's directory,
it was unclaimed, and the front door was the gap — the reviewer's standing verdict was that the engine
was never the problem). Branch `dev/sam/mcp-server`, four commits, **not pushed yet**.

### The one decision that shaped everything

**No `run_sql` tool.** The LLM is the reasoning and stitching layer; it never authors a query. All ten
tools take typed parameters and `mcp/query.ts` composes the SQL. Coverage comes from parameters, not
from raw SQL. Consequences, all three of them scored by the rubric:

- one code path per tool, in version control, every query through `Ledger.run` → reproducible;
- the definitionally-broken questions become **refusals that explain themselves** rather than
  plausible wrong answers (fill rate by `advertiser_id`, `geo_device_id` as an entity). A model with a
  SQL tool writes the advertiser join on its first attempt;
- grouping/ordering/floors/comparison stay in SQL → tens of rows back, never thousands.

### What exists

Ten tools: `describe_data`, `list_dimension_values`, `get_metric`, `compare_periods`,
`rank_segments`, `find_incidents`, `investigate`, `explain_revenue`, `get_evidence`, `export_trace`.
Two transports over one dispatcher (stdio; streamable HTTP because LibreChat is in its own container).
Hand-rolled JSON-RPC — no SDK, so `bun.lock` stays untouched a day before freeze.

**Trace, for "no trace, no credit":** every call = one OTel span + one JSONL line written *as it
happens*, `export_trace` for the artifact, OTel trace id in both so the file and ClickStack join.
**Crispness lives in `initialize.instructions`** — the answer contract the narrator reads before any
tool result, worded from `pitch/diagnosis-template.md` § 1. Plus two prompts (`diagnose`,
`daily_briefing` — the latter is the unattended path from open item #2).

### `bun run mcp:eval` — the accuracy harness, and the thing I am most glad I built

15 cases scored **through `callTool`**, not against the engine: a regression in an argument name, an
envelope field or a refusal message is as much a wrong answer as a wrong number. Two tiers — gated
(localization, no-false-alarm, grounding, refusals) and reported (channel, dollars), because gating
channel would ratify today's output rather than test it. **14/15, gated 28/30.**

### Traps, added to the list at the top

- **It caught my own bug on its first run, and the bug was the family this repo keeps losing time to.**
  `compare_periods` aggregated each side with one conditional sum, so an absolute metric compared one
  day against the **total** of its N same-weekday priors. Jun 27 platform revenue read **-65%**; it is
  **+4.4%**. Fixed by aggregating per day then taking a median across days, ratios formed
  componentwise (same construction as `decompose.ts`).
  **The lesson worth keeping: ratio metrics are scale-invariant in the number of days pooled, so they
  hid it completely.** Every fill-rate answer looked right throughout — including one I had
  hand-checked against the dossier and treated as proof the tool worked. A ratio that agrees with the
  dossier does not validate the window arithmetic underneath it. Check an absolute metric too.
- **I called another lane's behaviour a defect before checking their gate had ruled on it.** I reported
  the Jun 27 decoy (`supply_change` naming `country|ad_format='IN|banner'`, +9.7% on 2.09% of traffic)
  as a backend defect. `bun run criteria` **passes** that case deliberately: platform-normal stated,
  dollars bounded at $5. Both positions are defensible; mine is stricter because `channel`/`findings`
  are what the chat renders. Corrected in BROADCAST and reframed as **T-046, a decision for Lane A**.
  Next time: run the other lane's gate before writing the word "defect".
- **One `investigate` records ~1,700 evidence rows** (one per cleared candidate). Inlining those ids
  would spend the context window on identifiers. Envelope caps at 12; `get_evidence` takes a label
  filter; full set stays in the artifact.
- **In stdio mode stdout IS the protocol.** Diagnostics to stderr, and `OTEL_LOG_LEVEL` must stay unset
  or the diag logger corrupts the stream.

### Open items, ranked

1. **T-046 is blocking my gate red.** Lane A's call: suppress channel/owner when the platform is in
   band, or tell me the current bound is sufficient and I relax `mcp/eval` to match. I will align
   either way — two gates disagreeing silently before a freeze is worse than either answer.
2. **Not pushed.** Branch is local. Push `dev/sam/mcp-server` and open the PR (`needs-review-from:
   dev-2` for the lane crossing, and loges for the T-046 finding).
3. **Nobody has driven this from LibreChat yet.** The HTTP transport is verified by hand and by the
   eval, not by a real client. That is the T-024 hand-off and the riskiest remaining unknown.
4. `investigate` is 5–10s over Cloud round trips (server time is ~1.2s per `bench-baseline.json`).
   "Diagnosed in seconds" holds, but T-013's rollup is what would make it feel instant.
5. Still open from session 1: the plain-English renderer (T-045), and the `bun install` drift.

---

## 2026-08-01 · session 3 — the unattended path (T-047, T-048)

Rebased onto merged main first. **Corrections to my session-2 handoff:** samarth's branch is merged
(PR #11), and `backend/benchmark.ts` exists and is a real asset — it pulls per-stage
read_rows/read_bytes/peak_memory out of `system.query_log` tagged by run id.

Acted on samarth's review. Took its **#1 and #2** (unattended path, judge-openable artifact) because
both are in my lane and carry the most weight. **Did not** take #3 (rollup MV) — Lane B's schema, and
the review itself ranks it third. Skipped the LLM narrator: it is Lane A's T-019, and the MCP server
is already the narration path.

### `bun run diagnose` — takes no arguments

    46 firing windows -> 30 distinct incidents -> 6 investigated in 91s, nothing supplied by a human
    1. fill_rate Jun 23-26  technical_break  os_version='Android 15'  -$20.45/day  42/42 grounded
    2. ecpm      Jun 16-22  demand_change    ad_format='interstitial'  -$5.40/day  36/36
    3. fill_rate Jun 28-30  technical_break  os_version='iOS 18.1'     -$1.50/day  46/46
    4. revenue   Jun 19-26  not_localizable  platform-wide                         16/16
    5. requests  Jun 21-22  not_localizable  platform-wide                          6/6
    6. revenue   Jun 15-21  no_anomaly       platform-wide                          7/7

All four known incidents, B correctly `not_localizable`, all 100% grounded, 24 not-escalated windows
listed with numbers and reasons. Artifact: `pitch/example-report/report.html`, self-contained.

### Traps — three of them are the SAME trap, and it is the one this repo keeps falling into

- **Never widen an investigation window.** My first join merged overlapping windows and investigated
  the union: an eight-day `ctr` window spanning two incidents, both diluted to `no_anomaly`, Android 15
  lost entirely. Grouping must only change what the report *says*.
- **Do not group across metrics on a shared lead segment.** The sweep leads both the Jun 19-26 revenue
  window and the Jun 23-26 fill window with the pair `finance|Android 15`, so that rule folded the
  flagship incident into a revenue window containing Jun 21 — and the one investigation that ran said
  `not_localizable`. Cross-metric grouping is identical-window only. **A metric and a window together
  are the question being asked.**
- **Rank on losses, not on movement.** Three of the top six windows by |move| were CTR *up* 30-58%.
  Ranking on absolute movement buries real losses under noise on a metric the glossary itself calls a
  sibling signal, not a driver.
- **The sweep's lead segment is usually a narrow pair,** so a platform-wide event looks small: Jun 21
  leads with `app_id=app_00091` on 0.11% of traffic. `correlatedSegments` is the tell — 425 co-moving
  vs 27 for the widest genuinely-narrow incident. Breadth is in the severity score for that reason.
- **I shipped a Day-2 landmine and samarth's `0d66d8c` is what exposed it.** Nothing in my server
  called `ensureDatasetBounds`, so validation and the sweep used the hardcoded training slice. On a
  fresh slice every window a judge asked about would be rejected as "outside the loaded data" and the
  sweep would match zero rows — silently, with a clean-looking trace. Resolved once per session inside
  `Session.run` so no entry point can forget it. **Anything that pastes those constants into SQL needs
  to call it.**

### The cost number, and what it means

`mcp/cost.ts` attributes ClickHouse cost per tool call from `system.query_log` (the `run=`/`stage=` tag
`Ledger` already emits). One full run: **344M rows read, 4.1 GiB, 59s server, 848 MiB peak, 55
queries** — `find_incidents` alone 135M rows. Rows *returned* are bounded by dimension cardinality and
that invariant holds; rows *read* are undefended, ~38x the fact table per run. **This is the
before-number that makes T-013's rollup a measured delta instead of a paragraph.** In
`pitch/example-report/report.json` under `cost`.

### Open items, ranked

1. **T-046 still red.** `mcp:eval` is 14/15, and the miss is the Jun 27 decoy: `investigate` names
   `country|ad_format='IN|banner'` (+9.7% on 2.09% of traffic) on a normal Saturday. `criteria` passes
   it deliberately (platform-normal stated, dollars bounded). Lane A's decision; I will align either
   way rather than leave two gates disagreeing.
2. **Nobody has driven the MCP server from a real LibreChat instance.** Still the riskiest unknown,
   and still the T-024 hand-off.
3. Incident C localizes to `ad_format='interstitial'` over the sweep's Jun 16-22 window rather than
   `app_category='finance'` over Jun 19-22. Finance-vs-interstitial is the known shadow pair; over a
   wider window the engine picks the other one. Worth a look, not obviously wrong.
4. `diagnose` takes 91s, dominated by 6 sequential investigations. Investigating in parallel is the
   easy win if Day-2 time pressure matters.
5. Still open: plain-English renderer (T-045), `bun install` drift.
