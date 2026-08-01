# Goal — what we are building

> **Status: DRAFTED, needs a fast all-four confirm at kickoff.** Drafted solo by `loges` once the
> InMobi data package landed, then amended by `sam` with the business framing (§ 2), the
> schema corrections forced by what actually shipped in `bec2a35` (§ 7), and decision rows D-005…
> D-018. **D-018 is the one to read first — it fixes whose product this is (InMobi's own marketplace
> view, not an advertiser tool) and reframes the § 5 second act accordingly.**
> **This is a sanity check, not a rewrite.** Flag disagreements in `journal/BROADCAST.md` or
> the decision log (§ 11); don't silently edit LOCKED sections (§ 1, § 4, § 7, § 8). Silence past
> M0 = agreement.

---

## 1. One-liner  **LOCKED**

We are building an **automated incident investigator** so that anyone watching InMobi's ad metrics
gets a plain-English, evidence-backed root-cause diagnosis in seconds instead of spending hours
manually slicing dashboards.

Concretely: you give it a metric and a time window. It gives you back **the cause, the segment
responsible, the dollar impact, what it checked and ruled out, and whether you should act** — with
every number computed from ClickHouse rather than guessed by a model.

---

## 2. The problem

### The business case

**Who feels it:** the yield/revenue manager **at InMobi** who owns the marketplace revenue number and
gets asked "why was yesterday down 12%?" at standup every morning. Secondarily InMobi's publisher
ops lead ("which of our supply partners' fill rate broke?") and InMobi's demand desk ("which
advertiser's spend fell away, and who can backfill that inventory?").

> **Every persona is inside InMobi.** This is the platform's own marketplace view, not a tool we
> hand to an advertiser or a publisher (D-018). The dataset settles it: `fill_rate` is a marketplace
> metric, `revenue` is money the platform *earns* on impressions, `publisher_tier` is InMobi's own
> classification of its supply, and `advertiser_id` is a 500-value slicing dimension — an advertiser
> would only ever see their own row. Buy-side questions ("should I spend on this again?") are
> **out of scope**; the platform-side version of that question is demand durability and backfill
> capacity, below.

**The workflow that is slow today:** an alert fires. A human opens a dashboard and starts slicing —
by region, then by OS, then by app category, then by advertiser — comparing each slice to a mental
model of "normal," trying to hold twenty numbers in their head at once. With revenue spread across
thousands of app × device × geo × advertiser × ad-format combinations, this takes minutes to hours,
and in genuinely complex cases days. Every number needed already existed; the bottleneck was never
the data, it was the manual sweep.

**Why that costs real money:** in adtech the diagnosis delay *is* the loss. A fill-rate break that
runs three days leaks three days of revenue. The value of automating this is not the analyst's
salary — it is the **shortening of the leak**.

**The secondary pain — alert fatigue:** most ad-ops alert channels are muted, because blended
metrics move for boring reasons constantly. Weekends are lower. Traffic mix shifts toward cheaper
inventory and blended eCPM falls while every individual segment is flat. A system that cannot
*rule things out* makes this worse, not better.

### The insight we are building on

Revenue moves for a small number of structurally different reasons. Naming *where* it moved is
table stakes. Naming **which kind of thing happened** is the product, because the owner and the
action differ:

| # | Cause | Computable signature | Who acts |
|---|---|---|---|
| 1 | **Demand change** | advertiser entered/exited/cut spend; unfilled requests spike in their segment | Sales / AM — chase the budget |
| 2 | **Supply change** | request volume moves; an app gained or lost traffic | Publisher ops |
| 3 | **Technical break** | fill or render rate collapses on one OS / format / tier; rate-driven, not mix-driven | Engineering — page someone |
| 4 | **Mix shift** | every segment's rate is flat; weights moved toward cheaper inventory | **Nobody.** Nothing is broken |
| 5 | **Seasonality** | matches same-weekday trailing baseline within band | **Nobody.** Suppress the alert |
| 6 | ~~Exogenous event~~ | **Dropped (D-019)** — not attributable from this dataset, and external data is out of scope | — |

Every investigation classifies into exactly one primary channel and prices the rest. This is what
turns a drill-down tool into something a business owner acts on.

---

## 3. Why ClickHouse

The core operation is: for a metric that moved, compute baseline-vs-current for **every single
dimension AND every pairwise dimension combination** (`ad_format`, `category`, `publisher_tier`,
`vertical`, `campaign_type`, `region`, `country`, `device_model`, `os_version`) over a 9M-row,
5-week fact table — in seconds, not as N sequential queries.

That is exactly `GROUP BY ... GROUPING SETS` (or `WITH CUBE`) over a columnar store: **one scan
returns every cut simultaneously.** A row-store would need either N separate queries or a
pre-materialized rollup per dimension combo. This is a genuinely ClickHouse-shaped problem, not "we
just need a database."

Specifically we depend on:

- **`GROUPING SETS` over a columnar scan** — the whole drill-down is one query, not one per cut.
- **Vectorised conditional aggregates.** `sumIf(revenue, …)`, `countIf` compute the entire funnel —
  requests, fills, impressions, clicks, revenue — in **one pass per grain** instead of five
  self-joins. The whole metrics glossary is one SELECT.
- **`AggregatingMergeTree` + materialized views.** We pre-roll the fact table at ingest, so the
  sweep reads thousands of rows rather than 9M. This is what makes "seconds" achievable.
- **Dictionaries for the star schema.** `apps`, `advertisers`, `geo_device` are held in RAM;
  `dictGet` replaces a three-way JOIN on *every* drill-down query. Idiomatic, and it matters here
  because we join on every query.
- **Columnar scans + sparse primary index** for the baseline window: same-weekday trailing lookups
  touch only the relevant granules.
- **`quantilesTDigest` / `stddevPop`** computed in-engine for the anomaly bands, so significance
  testing is a query, not an export-and-compute round trip.

If the analysis lived in application code over exported rows we would be slower by orders of
magnitude, and the judges' "is ClickHouse doing the real work?" criterion would be answered "no."

---

## 4. The demo we will give  **LOCKED**

Written first; we build backwards from it. Judges see the demo, not the repo.

- **Duration:** ~4 minutes live, inside the 5-minute video cap.

- **The "wow" moment:** the **ruled-out list, proven by the trace.** Anyone can show a chart going
  down and an LLM saying "revenue fell in APAC." The lean-in moment is the system saying
  *"seasonality checked and cleared at 6.1σ; traffic mix explains only −$2k of the −$58k; render
  rate normal; four other regions within band"* — and then opening the Langfuse trace live to show
  every dimension it checked, in order, proving the diagnosis wasn't hand-picked. We are selling
  **trust**, and trust is demonstrated by what a system refuses to claim.

- **Beat-by-beat:**
  1. **Trigger.** A rehearsed training-set incident. The detection sweep fires on its own — no human
     points at the metric. This matters: the unseen incident won't come with a pointer either.
  2. **The answer lands.** LibreChat renders the diagnosis: revenue −12.4%, −$58,720, **primary
     channel: demand change**, localized to `os_version × publisher_tier`, one named advertiser
     stopped bidding — with per-sub-metric ✓/✗ checks, contribution %, and confidence. Every figure
     is a real computed number. Point out: this took a human four hours yesterday.
  3. **The ruled-out block.** Walk it. Then run the **seasonality decoy** date and show the system
     return *"no anomaly — this is a weekend, within band"* instead of crying wolf.
  4. **The trace.** Open the matching Langfuse trace live and walk Stages 0–6: what was checked, in
     what order, why. Mention the grounding check — a numeral in the narrative that isn't in the
     evidence set gets the response **rejected**. The LLM cannot invent a number here, structurally.
  5. **Follow-up.** Ask "why not CTR?" in LibreChat. A live ClickHouse query runs; the LLM explains
     the real result. Not canned.
  6. **The unseen incident.** Same pipeline, fresh Day-2 data, output + trace, run once, untouched by
     hand. Close on: no trace, no credit — here is ours.

- **Fallback if live fails:** in this order — (a) pre-recorded screen capture of the exact same run,
  made at M4 and re-made after any breaking change; (b) local ClickHouse seeded with the same data,
  so we are not dependent on Cloud or the network; (c) raw JSON + trace links as backup evidence.
  Owner: Lane D. **T-011 must not slip past M4.**

---

## 5. Scope

### In scope (we will build this)

**The investigation pipeline (Stages 0–6):**
- Detection sweep across core metrics × time buckets — seasonality-aware baseline, two-gate flag
  (relative % **and** stddev)
- Revenue-identity walk (Requests → Fill rate → Impressions/Fills → eCPM) to find *which factor* moved
- One parameterized `GROUPING SETS` drill-down across all single + pairwise dimension cuts
- **Mix-vs-rate decomposition** — a mix-held-constant counterfactual on every localization, so
  "nothing broke, the mix shifted" is distinguishable from a real fault (D-010)
- Statistical significance gating before any segment is called anomalous
- Contribution-to-delta ranking + a simple, explainable confidence score
- **Residualization — iterative deflation to separate causes from contamination** (D-017). After
  ranking, take the top candidate, **exclude its rows, and re-sweep**. Any segment that returns to
  normal was never a cause — it was contaminated by overlap with the real one. Repeat until nothing
  exceeds the band. Output is the *minimal* set of true causes, plus every cleared segment with its
  residual delta as proof. Costs ~2–4 extra ClickHouse round trips. **This is the difference between
  naming one cause and naming twenty-one** — see the worked evidence in the D-017 row.
- **Every finding priced in dollars** before it is reported, so findings across metrics are
  comparable and rankable (D-007)
- **Structural change detection** — advertiser entry/exit, spend step-changes, mix shifts,
  concentration risk. "What changed?" before "what's different?"

**Performance and scale — the primary axis (D-019):**
- **Rollup-backed queries so cost is independent of event volume.** Today every investigation
  full-scans the fact table: 9.00M rows, 77.77 MiB, 216 MiB peak, ~1.2s per sweep. An
  `AggregatingMergeTree` at `(hour × dimension × value)` grain is ~59k rows for this window — the
  rollup grows with *cardinality × time*, not with events, so the same query costs the same at 9M
  events or 9T. **This is the petabyte answer and it is T-013.**
- **Measured latency budget** end to end, per stage, published in the README.
- **Bounded LLM cost** — one narration call per investigation, evidence struct only, token count
  measured and reported. The LLM must never scale with data volume.
- LLM narration stage — numbers-only-from-JSON, never raw events
- **Numeric grounding check** — any numeral in generated prose absent from the evidence set fails
  the response

**Surfaces and instrumentation:**
- Langfuse trace per investigation, every stage as a span — the trace *is* a deliverable (§ 10)
- LibreChat wiring: diagnosis rendering + follow-up Q&A against the live backend
- ClickStack instrumentation of the backend: per-stage latency, error rate, request traces
- One command / one API call that runs the whole pipeline unattended, for the unseen-incident
  submission
- Local seeded ClickHouse as the demo fallback path

**Second act, if M3 lands early — demand durability and backfill (platform-side):**
- **Concentration:** what share of a segment's revenue rests on one advertiser, i.e. our single
  points of failure. Computed today in `classify`, not yet surfaced.
- **Durability:** is a segment's revenue recurring or event-dependent? Revenue that only appeared
  inside an exogenous-event window is not run-rate and must not be forecast as such.
- **Backfill capacity:** when demand exits a segment, which *other* advertisers already bid on that
  same inventory, at what eCPM, and with how much unused headroom? This is what turns a diagnosis
  into a recovery plan — *"−$51k/day exposure; adv_0107 and adv_0455 bid the same inventory at
  within 8% of the lost eCPM and are taking 61% of available volume."*

> Reframed from an earlier "campaign repeatability / should I spend on this again?" draft, which was
> a **buy-side** question we cannot answer and should not ask (D-018). Same machinery, aimed at the
> yield manager's decision instead of the advertiser's.

### Out of scope (we will deliberately NOT build this)

- **Authentication, production deployment, alerting integrations** (PagerDuty etc.) — explicitly
  called out as not rewarded by the problem statement. We *detect*; we do not page.
- **A polished/custom frontend beyond LibreChat** — same reason. Team decision is LibreChat-only, no
  separate tree UI (D-003).
- **An LLM that plans investigation steps dynamically** — the pipeline is deterministic by design,
  because reproducibility on the unseen incident requires identical behaviour every run (D-002).
- **Writing SQL with the LLM at query time.** It routes and narrates; it does not author analysis.
  A correctness decision, not a style one (D-008).
- **ML-based anomaly detection** — baselines + statistical gating are sufficient and far more
  explainable. Explainability beats sophistication per the rubric.
- **Streaming / real-time ingest.** The dataset is a five-week batch. Idempotent batch load only.
- **ROAS, incrementality, LTV, frequency capping.** There are no conversion events and no `user_id`
  in this dataset. Claiming these would be fabrication — see § 12 R-011.
- **Any attribution to data outside the dataset (D-019).** No event calendars, no holiday tables, no
  contextual/affinity modelling, no `external_events` join. Anomalies are found and explained
  **using `ad_events` and its three dimensions, and nothing else.** Tested before cutting: matching
  advertiser vertical to app category moves eCPM 2.4654 vs 2.4721 and CTR 0.01084 vs 0.01089 — no
  effect exists to model; and the largest hourly deviations in entertainment apps are 1.6× on 49–85
  requests at random hours, which is Poisson noise, not events. There is nothing there to attribute.
- **Elaborate anomaly detection.** Keep detection to what the problem statement asks for. Effort
  goes to latency, scale and bounded LLM cost, not to a cleverer detector (D-019).

> Anything not listed under "In scope" needs a decision-log entry (§ 11) before someone starts on it.

---

## 6. Architecture

```
inmobi/data/*  →  [ clickhouse/ ingest ]  →  [ ClickHouse Cloud ]
                                              ad_events (9M, MergeTree, daily partitions)
                                              apps · advertisers · geo_device  + dict_*
                                              ad_events_enriched  (VIEW — the query surface)
                                              rollup / baseline MVs   ← not yet built
                                                        │
                                    [ clickhouse/ + mcp/ : detection sweep +
                                      GROUPING SETS drill-down + significance gate ]
                                                        │
                                         [ backend/ : orchestrator (Stages 0-6),
                                           mix-vs-rate, contribution ranking, confidence,
                                           dollar pricing, Langfuse tracing, LLM narration,
                                           grounding check ]
                                                        │
                                    ┌───────────────────┼───────────────────┐
                                    ▼                   ▼                   ▼
                            [ librechat/ ]        [ Langfuse cloud ]   [ clickstack/ ]
                            diagnosis + follow-up  trace per incident  service latency/
                            chat surface                                error observability
```

| Component | What it does | Tech | Lane owner | Directory |
|---|---|---|---|---|
| ClickHouse schema + ingest | Star schema load (`ad_events` + 3 dims), dictionaries, rollup tables, detection + `GROUPING SETS` drill-down queries | ClickHouse Cloud, SQL, TS/Bun | Lane B (dev-2 · `samarth`) | `clickhouse/`, `scripts/`, `interfaces/`, `constants/`, `enums/`, `utils/` |
| ClickHouse MCP server | Exposes drill-down queries as MCP tools for the backend and the follow-up-chat loop | ClickHouse MCP server | Lane B (dev-2) | `mcp/` |
| Investigation orchestrator + API | Stages 0–6: detection, baseline, attribution, dimension explorer, significance gate, ranking/confidence, narration; dollar pricing; Langfuse tracing | TS/Bun API | Lane A (`loges`) | `backend/` |
| ClickStack observability | Instruments the backend service: per-stage latency, error rate, request traces | ClickStack (HyperDX) | Lane C (dev-3) | `clickstack/` |
| LibreChat integration | Custom endpoint/plugin: renders diagnosis as chat message, runs follow-up queries live | LibreChat | Lane D (dev-4) | `librechat/` |

Directory boundaries above are the **source of truth for who may edit what** — keep them disjoint.
Lane owners are also listed in [AGENTS.md](AGENTS.md) § 1.

> **Stack is TypeScript/Bun** — settled by what landed in `bec2a35`, not by debate (D-015).

⚠ **Ownership hazard.** `interfaces/`, `constants/`, `enums/` and `utils/` sit at the repo root but
belong to Lane B. Every lane will want to add types to them. **Do not.** Each lane declares its own
types under its own directory and imports from `interfaces/` read-only. A type that genuinely
belongs to everyone goes to Lane B via BROADCAST.

Shared root files (`docker-compose.yml`, `.gitignore`, `README.md`, `package.json`, `bun.lock`,
`tsconfig.json`) follow AGENTS.md § 2: announce in BROADCAST first. `bun.lock` in particular will
conflict if two lanes add dependencies in the same hour.

---

## 7. Data model  **LOCKED**

The schema is the contract between all four lanes. Change it only via § 11 + a `Breaking:` commit.

- **Dataset / source:** InMobi synthetic ad-events package from
  `github.com/sidagarwal04/click-a-thon-2026` → `InMobi/`, mirrored locally at `inmobi/`
  (gitignored). See `inmobi/README_START_HERE.md`.
  - `ad_events.parquet` — 103,082,870 bytes, **9,000,000 rows**, 2026-06-01 → 2026-07-05 (~5 weeks)
  - `apps.csv` — 2,000 rows · `advertisers.csv` — 500 rows · `geo_device.csv` — 5,000 rows
  - ⚠ The three CSVs are **Git LFS pointers** on `raw.githubusercontent.com`. Fetch them from
    `media.githubusercontent.com/media/...` or you will silently load 130-byte stubs.

- **Primary table(s):**
  - `ad_events` (fact): `event_time, app_id, geo_device_id, advertiser_id, ad_format, is_filled,
    is_impression, is_click, revenue`
  - `apps` (dim): `app_id, category, publisher_tier`
  - `advertisers` (dim): `advertiser_id, vertical, campaign_type`
  - `geo_device` (dim): `geo_device_id, region, country, device_model, os_version`
  - `dict_apps`, `dict_advertisers`, `dict_geo_device` — the dims held in RAM as `hashed`
    dictionaries for `dictGet` on the hot path (D-013)
  - **No other tables.** No event calendar, no holiday table, no external join surface. Attribution
    uses `ad_events` and its three dimensions only (D-019).

- **Engine + `ORDER BY`:** as shipped in `bec2a35` —
  ```sql
  ENGINE = MergeTree
  PARTITION BY toYYYYMMDD(event_time)                      -- 35 partitions over the 5wk window
  ORDER BY (event_time, ad_format, app_id, geo_device_id)
  ```
  **Justification:** every query in this product is time-bounded first — an incident window versus a
  same-weekday baseline window. Leading the sort key with `event_time` makes both contiguous granule
  reads; `ad_format` follows as the cheapest prune (5 values). Daily partitions are what make the
  loader idempotent: one source chunk maps 1:1 to one partition, so a re-run is `DROP PARTITION` +
  re-`INSERT` with no dedup logic and no double-counted revenue. That reload-safety property is why
  daily beat monthly (D-014), and it matters because R-007 has us reloading under time pressure when
  the unseen incident lands.

- **The query surface is `ad_events_enriched`, not `ad_events`.** A plain VIEW that resolves all
  eight dimension columns via `dictGet` — zero storage, zero ingest cost, and no JOINs for any lane
  to get wrong. **Lanes A/C/D query this view and nothing else.** Its column names are a frozen
  contract (§ 8, D-016).

- **Rollups (derived, not raw) — NOT YET BUILT, and they are the § 3 perf story:**
  - Pre-aggregate to `(hour_bucket, app_id, geo_device_id, advertiser_id, ad_format) → count() AS
    requests, sum(is_filled) AS fills, sum(is_impression) AS impressions, sum(is_click) AS clicks,
    sum(revenue) AS revenue`, as `AggregatingMergeTree` (or `SummingMergeTree` on the five sums),
    `ORDER BY (hour_bucket, app_id, geo_device_id, advertiser_id, ad_format)` — matching the
    dimension-cut access pattern the drill-down needs. Maintained by one MV off `ad_events` inserts.
  - **Never store or average pre-computed ratios** (fill rate, eCPM, CTR, RPR). Always `sum(x)/sum(y)`
    at query time over rolled-up sums, per `metrics_glossary.md`.
  - A same-weekday trailing baseline view with `stddevPop`, feeding the σ bands.
  - A projection ordered by `(advertiser_id, event_time)` for the advertiser entry/exit and
    spend-step detectors, which invert the normal access pattern.
  - **These are the difference between a 10-second investigation and a 3-minute one, and they are
    unclaimed** (T-013). Lane B should land them before Lane A starts optimizing against a raw fact
    table.

- **Canonical DDL lives at:** `clickhouse/schema.sql` — **one file, dev-2 (`samarth`) owns it,
  everyone else reads it.** Any change needs `Breaking:` in the commit trailer plus a BROADCAST entry.

- **The revenue identity (from `metrics_glossary.md` — do not re-derive):**
  `Revenue = Requests × Fill rate × (Impressions/Fills) × eCPM/1000`, which simplifies to
  `Revenue ≈ Requests × Fill rate × eCPM/1000` since impressions ≈ fills. CTR is a sibling
  engagement/quality signal, not a direct revenue factor in this CPM model — check it, but don't
  attribute revenue moves to it.

- **Dimensions to slice (single + pairwise, per `GROUPING SETS`):** `ad_format`; `category`,
  `publisher_tier` (via `apps`); `vertical`, `campaign_type` (via `advertisers`); `region`,
  `country`, `device_model`, `os_version` (via `geo_device`).

### Data facts that constrain the design — read before building detectors

1. **`advertiser_id` is empty on unfilled requests.** Advertiser-sliced *fill rate* is therefore
   undefined, and `vertical` / `campaign_type` exist only on filled events. Unfilled-demand analysis
   runs on supply-side dimensions only. **This is the single easiest way to produce a confidently
   wrong number in this dataset.**
2. **There is no `campaign_id`.** The campaign grain is `(advertiser_id, campaign_type)`, or
   `advertiser_id` alone as proxy. Decided once, applied everywhere (D-011).
3. **Only ~5 same-weekday observations exist**, and the first two weeks are effectively baseline
   burn-in. Baselines are trailing same-weekday, up to 4 back. Do not alert on Jun 1–14 (D-012).
4. **North America is `NAM`, not `NA`** — `NA` is read as null by most loaders.
5. **Ratio metrics are `sum/sum` over the group**, never an average of per-row or per-day ratios, or
   rollups stop being correct.
6. **No conversions, no installs, no `user_id`.** This is what bounds § 5's out-of-scope list.
7. **Known data characteristics:** real daily (hour-of-day) and weekly (weekend-lower) seasonality, a
   slow growth trend, random noise. **At least one planted movement is pure seasonality and must be
   checked and ruled out, not alarmed on** — the baseline must be like-for-like (same weekday/hour,
   trailing weeks), never a flat global average.

---

## 8. Interfaces between lanes  **LOCKED**

Agreed early so the four lanes build against stubs instead of blocking. **Mock the other side, never
wait for it.** If a contract below is defined, you are unblocked — if it is not yet implemented,
stub it.

| Contract | Producer | Consumer | Shape / where defined |
|---|---|---|---|
| `ad_events_enriched` — **the** query surface; flat dimension columns, no JOINs | Lane B (`clickhouse/`) | Lanes A, D | `clickhouse/schema.sql`. Column names frozen; adding is fine, renaming/removing is `Breaking:`. Lane A writes SQL against these names before any data is loaded. |
| Rolled-up event data (sums, never ratios) | Lane B (`clickhouse/`) | Lane A (`backend/`) | `clickhouse/schema.sql` rollup table; queried directly or via MCP |
| Drill-down query results (detection + `GROUPING SETS` output) | Lane B (`mcp/`) | Lane A (`backend/`), LibreChat follow-up (Lane D) | MCP tool calls — tool names + schemas in `mcp/README.md` |
| `Evidence` — one computed number + its provenance | Lane A (`backend/`) | Lane D | `backend/types.ts`. `{id, label, value, unit, sql, sqlHash, window, filters}` |
| `Finding` — one conclusion, with its evidence | Lane A (`backend/`) | Lane D | `backend/types.ts`. `{channel, segment, metric, deltaAbs, deltaPct, revenueImpactUsd, significanceSigma, status: 'found'\|'cleared', evidenceIds[]}` |
| Investigation JSON — the full ordered result | Lane A (`backend/`) | Lane D (`librechat/`) | `backend/schemas/investigation.schema.json`. `{metric, deltaPct, primaryChannel, findings[], evidence[], ruledOut[], contributionPct, confidence, traceId}` |
| Narration input — **evidence struct only, never raw rows** | Lane A | Lane A's narrator | The narrator receives the Investigation JSON and nothing else. Enforced in code, not by convention (D-008). |
| Investigation trace (Stage 0–6 spans) | Lane A (`backend/`) | Langfuse (external), judges | Langfuse SDK calls in `backend/`; `traceId` returned in every response |
| Service latency/error telemetry | Lane A (`backend/`, instrumented) | Lane C (`clickstack/`) | OTel/HTTP instrumentation emitted by `backend/`, ClickStack ingests |
| Replay fixtures — canned Investigation JSON | Lane A | Lane D | `librechat/fixtures/*.json`. Lets Lane D build the chat surface before the engine exists. |

**Day-one unblock:** Lane A ships a hand-written sample `investigation.schema.json` payload within
the first hour. Lane D builds the entire LibreChat rendering against it. Lane A writes SQL against
`schema.sql` names before Lane B has loaded a row. Nobody waits.

---

## 9. Milestones

Timebox hard. When a box expires, ship what exists and move on. (Hack started 12:00 pm, 1 Aug 2026;
code freeze 12:00 pm, 2 Aug 2026 — server-enforced, no extensions.)

| ID | Milestone | Definition of done | Deadline |
|---|---|---|---|
| M0 | Kickoff | This file has zero `_TBD_`; lanes assigned; repo scaffolded; everyone can run ClickHouse locally | 12:30 pm, 1 Aug |
| M1 | Data in | `ad_events` + 3 dims loaded into ClickHouse Cloud; dictionaries live; rollup table live; canonical query reproduces `metrics_glossary` totals | 2:00 pm, 1 Aug |
| M2 | Vertical slice | One incident, end to end: detection → attribution → narration → Langfuse trace. Ugly but real. Investigation JSON frozen. | 6:00 pm, 1 Aug |
| M3 | Feature complete | Everything in § 5 "In scope" exists: full dimension drill-down, mix-vs-rate, significance gate, confidence, grounding check enforcing, LibreChat both surfaces, ClickStack instrumented | 12:00 am, 2 Aug |
| M4 | Demo-ready | Demo rehearsed twice, **fallback recorded**, README written, deck drafted | 9:00 am, 2 Aug |
| M5 | Freeze | No merges to `main` except demo-blocking fixes, each with a BROADCAST entry | 12:00 pm, 2 Aug (hard) |

> **Internal freeze note:** freeze pipeline *logic/thresholds* 1–2 hours before the announced
> unseen-incident release time (exact time announced at kickoff) — stricter than M5, and it exists
> specifically so the unseen-incident run is untouched by hand-tuning. Only bug fixes after that
> point.

**The unseen-incident release lands during M3/M4.** Reserve a named person to run it the moment it
drops — that output plus its trace is a submission deliverable carrying significant weight. Nobody
should be mid-refactor when it lands, and `main` must be runnable at all times.

---

## 10. Success criteria

How we know we won, in measurable terms. Mapped to the published judging criteria.

- [ ] **Query cost is independent of event volume.** After T-013, an investigation reads rollup rows,
      not raw events. Baseline to beat: **9.00M rows / 77.71 MiB / 216 MiB peak / ~1.2s per sweep**
      today. *(D-019 — the primary axis)*
- [ ] **p95 end-to-end investigation < 3s** with per-stage latency published in the README.
- [ ] **Exactly one LLM call per investigation**, taking the evidence struct only, with token count
      measured and reported. LLM cost must not scale with data volume.
- [ ] **Detection sweep finds the planted training-set anomalies** — including the pure-seasonality
      one, correctly *ruled out* rather than alarmed on — with zero manual threshold tuning per
      incident. *(rubric: detection & localization accuracy, "avoid crying wolf")*
- [ ] **Every planted anomaly we find is named to a specific segment**, not a region-level hand-wave.
      *(rubric: "localized")*
- [ ] **Zero ungrounded numerals.** Every number in a narrated diagnosis is reproducible by
      re-running the cited ClickHouse query. Measured by the grounding check's own reject counter
      over the full demo run. *(rubric: trustworthiness — one fabricated figure costs more than a
      miss)*
- [ ] **End-to-end (trigger → narrated diagnosis) in single-digit seconds** on the full 9M-row
      dataset; well under a minute in the worst case. *(rubric: "fast")*
- [ ] **≥90% of the analytical work happens in ClickHouse**, measured as: no stage exports more than
      1,000 rows to the backend. *(rubric: "analytical depth in ClickHouse")*
- [ ] **Every response carries a `traceId`** that opens a readable, ordered investigation in
      Langfuse. *(rubric: traceability — no trace, no credit)*
- [ ] **The unseen-incident run produces a diagnosis + a complete, openable trace with no human
      intervention** between data release and submission.
- [ ] **LibreChat follow-up** ("why not CTR?") triggers a real ClickHouse query and returns a
      grounded answer, not a canned one.
- [ ] **The demo runs start to finish with no manual intervention**, twice, before M4 closes.

---

## 11. Decision log

Append-only. Newest at the bottom. One line per decision. Never edit or delete someone else's row.

| ID | Date | Decision | Why | Decided by |
|---|---|---|---|---|
| D-001 | 2026-08-01 | Detection sweep is a required Stage 0, not an assumed given | Problem statement requirement #1 is "detect when a metric deviates"; the unseen incident has no human pointing at it | loges (pre-kickoff plan) |
| D-002 | 2026-08-01 | Deterministic fixed pipeline; the LLM never chooses investigation steps | Reproducibility on the unseen incident with zero tuning requires identical behaviour every run | loges (pre-kickoff plan) |
| D-003 | 2026-08-01 | UI is LibreChat only — no separate custom tree UI | Problem statement lists "polished frontends" as out of scope; concentrates our one frontend surface into the tool that is already scored | loges + user, confirmed in planning session |
| D-004 | 2026-08-01 | Lane assignment: dev-2 → MCP + ClickHouse schema, dev-3 → ClickStack, dev-4 → LibreChat, loges → orchestrator/backend/Langfuse | Matches the actual pre-event ownership split; supersedes an earlier draft that had swapped dev-3/dev-4, and an `ingest/analysis/api/narrate` split proposed before the real one was known | loges |
| D-005 | 2026-08-01 | The product is a **diagnosis engine with an API**; chat is one client of it, not the product | Judges reward the investigation loop, not scaffolding. An API is testable and traceable in a way a chat UI is not. Compatible with D-003 — LibreChat stays the only *UI*. | sam (proposed) |
| D-006 | 2026-08-01 | Primary persona is the **yield/revenue manager**; the AM/campaign persona is the second act | One persona makes the demo coherent. The revenue owner is who this dataset is shaped for. | sam (proposed) |
| D-007 | 2026-08-01 | Every finding is **priced in dollars** before it is reported | Gives one ranking key across metrics. A 40% drop in a $12 segment is noise; 3% in a $400k segment is the story. Rank by dollars, gate by significance. | sam (proposed) |
| D-008 | 2026-08-01 | **LLM narrates only.** It never authors analysis SQL and never sees raw rows | Directly targets the largest scoring risk (fabricated figures) and the explicit hint in the problem statement. Structural, not advisory. Extends D-002. | sam (proposed) |
| D-009 | 2026-08-01 | ~~Never name an external event unless it joins an operator-supplied `external_events` row; otherwise report the fingerprint.~~ **SUPERSEDED BY D-019.** External attribution is out of scope entirely — no calendar, no join, no fingerprint stage. | Original reasoning still holds ("there was a cricket match" is not computable from `ad_events`), but D-019 goes further and drops the whole branch rather than keeping a mechanism we will not feed. | sam (proposed), superseded |
| D-010 | 2026-08-01 | **Mix-vs-rate decomposition is mandatory** on every localization | Simpson's paradox is the #1 false-alarm source in blended ad metrics — blended eCPM can fall while every segment is flat. Distinguishes "nothing broke" from "something broke." | sam (proposed) |
| D-011 | 2026-08-01 | Campaign grain is **`(advertiser_id, campaign_type)`** | There is no `campaign_id` in the dataset. Fixing this once prevents two lanes defining "campaign" differently. | sam (proposed) |
| D-012 | 2026-08-01 | Baseline is **trailing same-weekday, up to 4 back**; no alerting on 2026-06-01 → 06-14 | Only 5 weeks of data exist and the glossary warns that a flat average makes every weekend look anomalous. | sam (proposed) |
| D-013 | 2026-08-01 | Dimensions loaded as **ClickHouse dictionaries**, not JOINed per query | Every drill-down needs all three dimensions. `dictGet` removes a 3-way join from the hot path. | sam (proposed), samarth (shipped in `bec2a35`) |
| D-014 | 2026-08-01 | Fact table is **daily-partitioned**, not monthly | Daily partitions make the loader idempotent — one chunk per partition, so a reload is DROP+INSERT with no dedup and no double-counted revenue. Reload safety matters more than partition count, because R-007 has us reloading under time pressure. | samarth (shipped), sam (conceded) |
| D-015 | 2026-08-01 | Stack is **TypeScript/Bun**, not Python. All lane contracts are `.ts` | Settled by what landed on `main` first. Re-litigating it costs more than either option is worth. | samarth (shipped), sam (conceded) |
| D-016 | 2026-08-01 | **`ad_events_enriched` is the only query surface** for Lanes A/C/D. Nobody queries `ad_events` directly | One place where dimension enrichment can be wrong, instead of four. Makes every drill-down a plain GROUP BY. | samarth (shipped) |
| D-017 | 2026-08-01 | **Localization must residualize, not just rank.** Contribution ranking (T-018) is necessary but not sufficient; add iterative deflation (T-040) before anything is reported as a cause | Measured on the real Jun 23–25 fill-rate incident: a plain ranked sweep returns **21 segments** outside band (EU −5.50pp, tier_1 −3.89pp, finance −3.76pp, banner −3.65pp…). Excluding the single true cause — `os_version = 'Android 15'`, fill rate 0.7837 → 0.4333, −35.04pp on 9.6% of traffic — every one of those 21 collapses to within **±0.24pp** (EU → −0.07pp, tier_1 → +0.01pp). They were dilution artifacts, not causes. Reporting them is exactly the "hallucinated segment" failure the rubric punishes, and no amount of better narration fixes it — it is an algorithm problem. | sam (proposed) |
| D-018 | 2026-08-01 | **The product is InMobi's own marketplace view. Every persona is inside InMobi; buy-side questions are out of scope.** Supersedes the "campaign repeatability / should I spend again" second act, which is reframed to demand durability + backfill capacity. | The dataset is unambiguously the platform's: `fill_rate` is a marketplace metric an advertiser does not have, `revenue` is money *earned* on impressions (an advertiser's *cost*), `publisher_tier` is InMobi's own supply classification, and `advertiser_id` is a 500-value slicing dimension no advertiser could see. Volume settles it too — the median advertiser runs **116 impressions and 1.3 clicks a day**, and 355 of 500 are under 200 impressions/day, so per-advertiser detection would be pure noise. Decisively: we are scored against planted anomalies that are all marketplace-level (Android 15 fill collapse, global volume drop, finance eCPM); built buy-side we would miss every one. | sam (proposed) |

| D-019 | 2026-08-01 | **Attribute using the given dataset only, and keep detection minimal.** No event calendars, holiday tables, contextual/affinity modelling or any external join. The primary axis of this hackathon is **latency, scalability and bounded LLM cost**, not a cleverer detector. Supersedes D-009 and drops the exogenous-event channel. | Tested before cutting, so this is a measurement not a preference: vertical↔category affinity does not exist in the data (matched eCPM 2.4654 vs mismatched 2.4721; CTR 0.01084 vs 0.01089), and there is no event structure to find (largest hourly deviations in entertainment apps are 1.6× on 49–85 requests at random hours — Poisson noise). Any calendar we authored would attribute synthetic anomalies to invented causes, which the private answer key would contradict, and one fabricated figure costs more than a missed anomaly. Meanwhile every investigation currently full-scans 9.00M rows / 77.71 MiB, which is the thing that actually will not survive scale. | user (directed), sam (recorded) |

> Rows D-005…D-012 are **proposed** and were added after the initial draft. Ratify or contest at M0
> kickoff — change `(proposed)` to the ratifying handle, or open a BROADCAST entry arguing the other
> side.

---

## 12. Risks

| ID | Risk | Likelihood | Blast radius | Mitigation | Owner |
|---|---|---|---|---|---|
| R-001 | LLM invents a number in the narrative | High | **Fatal** — one fabricated figure outscores a missed anomaly | Grounding check rejects any prose numeral absent from the evidence set; narrator never sees raw rows (D-008) | Lane A |
| R-002 | Seasonality misfires (weekday/weekend, hour-of-day) cause false positives on the unseen incident | Medium | High — direct hit on detection accuracy scoring | Two-gate (relative % AND stddev) + like-for-like baseline (same weekday/hour, trailing weeks), never a flat average | loges / dev-2 |
| R-003 | We cry wolf on the planted seasonality decoy specifically | Medium | High — explicitly in the rubric | Ruleout battery runs *before* narration; a finding that fails significance is reported as `cleared`, never dropped silently | Lane A |
| R-004 | Blended-metric mix shift is misread as a real fault | Medium | High — a confident wrong diagnosis is worse than none | Mix-held-constant counterfactual on every localization; report how much of the delta mix explains (D-010) | Lane A |
| R-005 | Unseen incident lands on a metric other than revenue (fill rate, CTR…) | Medium | High — a revenue-first pipeline might not generalize | Keep the metric tree config-driven; validate against fill-rate-only and CTR-only synthetic incidents during rehearsal | loges |
| R-006 | Pipeline hand-tuned to known training anomalies, breaks on the unseen set | Medium | High — "no trace, no credit" / hallucination penalty | Internal freeze rule before the announced release time (§ 9); no threshold changes after | all |
| R-007 | Unseen-incident dataset differs in shape from the sample | Medium | High — the highest-weighted deliverable | Ingest is schema-driven and idempotent; dry-reload the *sample* data through the full path at M3 to prove the loader is re-runnable | Lane B |
| R-008 | 5-week window is too thin for reliable baselines | High | Medium — false alarms or missed detections | Trailing same-weekday up to 4 back; suppress alerting on the first 14 days; report σ so weak signals are visibly weak (D-012) | Lane A |
| R-009 | Advertiser-sliced fill rate computed on empty `advertiser_id` | Medium | High — a plausible-looking, definitionally wrong number | § 7 fact #1; unfilled-demand analysis restricted to supply-side dimensions in code, not by convention | Lane A |
| R-010 | ClickHouse Cloud credits exhausted, or unreachable mid-demo | Low | **Fatal** to the demo | Pause services when not actively querying (event handbook, $400/team ceiling); local seeded ClickHouse as the demo fallback from M1 | dev-2 |
| R-011 | We imply advertiser outcomes (ROAS, incrementality, LTV) the data cannot support | Medium | High — same class as R-001 | Out of scope entirely under D-018: we report marketplace yield, never buy-side performance. No conversion, install or `user_id` data exists, so any such claim is fabrication. | Lane A |
| R-016 | Buy-side framing creeps back into the narration or the deck | Medium | Medium — a judge who reads the dataset will spot the mismatch immediately | D-018 fixes the lens; § 2 states every persona is inside InMobi. Any output phrased as advice to an advertiser is a bug. | Biz |
| R-012 | LibreChat customization takes longer than expected | Medium | Medium — only frontend surface, no fallback UI | Start LibreChat wiring early (not blocked on M3); keep the § 8 contract stable so dev-4 can mock the backend response | dev-4 |
| R-013 | Two lanes define "campaign" or "baseline" differently | Medium | Medium — inconsistent numbers across surfaces reads as untrustworthy | D-011 and D-012 fix both once, here; detectors import shared types rather than redefining | Lane A |
| R-014 | Scope creep into a polished frontend | High | Medium — eats M3 | Explicitly out of scope (§ 5, D-003). No UI work beyond LibreChat. | all |
| R-015 | `main` diverges badly because four agents rebase late | Medium | Medium | AGENTS.md § 3 — rebase hourly, push branches immediately, commit small | all |
