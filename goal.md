# Goal — what we are building

> **Status: DRAFT FOR RATIFICATION (T-001).** Zero `_TBD_` remain, but sections marked **LOCKED**
> (§ 1, § 4, § 7, § 8) need sign-off from all four before M1 starts — see § 11 decision log, rows
> D-001…D-010. If you disagree with a LOCKED section, say so **now**, in BROADCAST, before anyone
> builds against it. Silence past M0 = agreement.

---

## 1. One-liner  **LOCKED**

**We are building WHY — an API that tells a revenue owner exactly why their money moved, in seconds,
with every number computed rather than guessed.**

You give it a metric and a date. It gives you back the cause, the segment responsible, the dollar
impact, what it ruled out, and whether you should act.

---

## 2. The problem

**Who feels it:** the yield/revenue manager at an ad platform who owns a revenue number and gets
asked "why was yesterday down 12%?" at standup every morning.

**The workflow that is slow today:** an alert fires. A human opens a dashboard and starts slicing —
by region, then by OS, then by app category, then by advertiser — comparing each slice to a mental
model of "normal," trying to hold twenty numbers in their head at once. With revenue spread across
thousands of app × device × geo × advertiser combinations, this takes hours. In genuinely complex
cases it takes days. All the data existed the whole time; the bottleneck was never the data, it was
the manual sweep.

**Why that costs real money:** in adtech the diagnosis delay *is* the loss. A fill-rate break that
runs for three days leaks three days of revenue. The value of automating this is not the analyst's
salary — it is the **shortening of the leak**.

**The secondary pain — alert fatigue:** most ad-ops alert channels are muted, because blended
metrics move for boring reasons constantly. Weekends are lower. Traffic mix shifts toward cheaper
inventory and blended eCPM falls while every individual segment is flat. A system that cannot
*rule things out* makes this worse, not better.

### The insight we are building on

Revenue moves for six structurally different reasons. Naming *where* it moved is table stakes.
Naming **which kind of thing happened** is the product, because the owner and the action differ:

| # | Cause | Computable signature | Who acts |
|---|---|---|---|
| 1 | **Demand change** | advertiser entered/exited/cut spend; unfilled requests spike in their segment | Sales / AM — chase the budget |
| 2 | **Supply change** | request volume moves; an app gained or lost traffic | Publisher ops |
| 3 | **Technical break** | fill or render rate collapses on one OS / format / tier; rate-driven, not mix-driven | Engineering — page someone |
| 4 | **Mix shift** | every segment's rate is flat; weights moved toward cheaper inventory | **Nobody.** Nothing is broken |
| 5 | **Seasonality** | matches same-weekday trailing baseline within band | **Nobody.** Suppress the alert |
| 6 | **Exogenous event** | sharp onset *and* offset, geo+category concentrated, no same-weekday precedent | Planning — prep for the next one |

Every `/explain` response classifies into exactly one primary channel and prices the rest.

---

## 3. Why ClickHouse

A single investigation is a **combinatorial sweep**, not a query: one metric × ~10 dimensions ×
hundreds of dimension values × a baseline window × a mix-held-constant counterfactual. That is
dozens to low-hundreds of aggregations over 9M rows, and it must return in seconds or the product
premise ("alert to answer in seconds") is dead.

Specifically we depend on:

- **Vectorised conditional aggregates.** `sumIf(revenue, …)`, `countIf`, `uniqExact` let us compute
  the entire funnel — requests, fills, impressions, clicks, revenue — in **one pass per grain**
  instead of five self-joins. The whole metrics glossary is one SELECT.
- **`AggregatingMergeTree` + materialised views.** We pre-roll the fact table to
  `(hour × dimension × value)` at ingest. The drill-down sweep then reads a rollup of thousands of
  rows, not 9M, which is what turns a 200-query investigation into a sub-second one.
- **Dictionaries for the star schema.** `apps`, `advertisers`, `geo_device` load as `hashed`
  dictionaries; `dictGet` replaces a three-way JOIN on every single drill-down query. This is the
  idiomatic ClickHouse answer to a star schema and it matters here because we join on *every* query.
- **Columnar scans + sparse primary index** for the baseline window: same-weekday trailing lookups
  touch only the relevant granules.
- **`quantilesTDigest` / `stddevPop`** computed in-engine for the anomaly bands, so significance
  testing is a query, not a Python round-trip over exported rows.

If the analysis lived in Python over exported rows we would be slower by orders of magnitude and the
judges' "is ClickHouse doing the real work?" criterion would be answered "no."

---

## 4. The demo we will give  **LOCKED**

Written first; we build backwards from this.

- **Duration:** 5 minutes (hard cap — matches the submitted video limit).
- **The "wow" moment:** the **RULED OUT** block. Anyone can show a chart going down and an LLM
  saying "revenue fell in APAC." The lean-in moment is the system saying *"seasonality checked and
  cleared at 6.1σ; traffic mix explains only −$2k of the −$58k; render rate normal; four other
  regions within band"* — and every one of those numbers being clickable through to the SQL that
  produced it. We are selling **trust**, and trust is demonstrated by what a system refuses to claim.

- **Beat-by-beat:**
  1. **(0:00–0:30) The ask.** Terminal. `POST /explain {metric: "revenue", date: "2026-06-23"}`.
     One line, no UI. State the premise: alert already told us it moved; we want why.
  2. **(0:30–1:15) The answer lands.** Response in under 10 seconds. Read the headline aloud:
     revenue −12.4%, −$58,720, **primary channel: demand change**, localized to
     `os_version × publisher_tier`, one named advertiser stopped bidding. Point out: this took a
     human four hours yesterday.
  3. **(1:15–2:15) The receipts.** Expand `evidence[]`. Every figure in the prose carries an id.
     Show the SQL behind two of them. Show the **grounding check** — a numeral in the narrative that
     is not in the evidence set gets the response rejected. State plainly: the LLM cannot invent a
     number here, structurally.
  4. **(2:15–3:00) The ruling-out.** The wow beat. Walk the RULED OUT block. Then run `/explain` on
     the **seasonality decoy** date and show the system return *"no anomaly — this is a weekend,
     within band"* instead of crying wolf.
  5. **(3:00–3:45) What changed.** Show `/changes` — advertiser entry/exit and budget step-changes
     detected structurally. This is the "check the deploy log" move that makes the diagnosis causal
     rather than correlational.
  6. **(3:45–4:30) The second act.** `GET /campaign/{id}/repeatability` → "yes, but cap at $8k/day;
     60% of its best days fell inside an exogenous-event window and do not recur." A forward-looking
     answer, not a post-mortem.
  7. **(4:30–5:00) The unseen incident.** Show the trace for the released dataset — what was checked,
     in what order, why. Close on: no trace, no credit; here is ours.

- **Fallback if live fails:** three layers, built in this order — (a) recorded 5-min screen capture
  of the full run, made at M4 and re-made after any breaking change; (b) local ClickHouse via
  `docker-compose` with the dataset seeded, so we are not dependent on Cloud or the network;
  (c) checked-in JSON fixtures of the exact `/explain` responses, served by a `--replay` flag on the
  API. Owner: Lane D. **T-011 must not slip past M4.**

---

## 5. Scope

### In scope (we will build this)

- **`POST /explain`** — the flagship. Fixed investigation plan: detect → decompose the revenue
  identity → localize the driving factor → test structural changes → ruleout battery → price it →
  narrate.
- **`GET /scan {date}`** — every anomaly worth caring about that day, **ranked by dollar impact**.
- **`POST /decompose`** — revenue-identity walk, numbers only, no prose.
- **`POST /changes`** — advertiser entry/exit, spend step-changes, mix shifts, concentration risk.
- **`POST /compare {window_a, window_b}`** — arbitrary two-window diff.
- **`POST /rule_out {hypothesis, window}`** — explicit hypothesis test, returns cleared / not cleared
  with the test that was run.
- **`GET /campaign/{id}/repeatability`** — the should-I-spend-again verdict.
- **Mix-vs-rate decomposition** — mix-held-constant counterfactual on every localization.
- **Event fingerprinting** — computes the *shape* of an exogenous event; joins an optional
  operator-supplied `external_events` calendar to name it. Never names an event without the join.
- **Evidence store + numeric grounding check** — every number carries its SQL and a hash; any
  numeral in generated prose that is absent from the evidence set fails the response.
- **Langfuse tracing** on every investigation — the trace *is* a deliverable (§ 10).
- **Seeded local ClickHouse** via `docker-compose`, so the demo has no network dependency.

### Out of scope (we will deliberately NOT build this)

- **Auth, users, multi-tenancy, deployment.** Problem statement puts these out of scope explicitly.
- **A polished frontend.** Judges reward the investigation loop, not the scaffolding. LibreChat or a
  single-page evidence viewer at most, and only after M3.
- **Alerting integrations** (PagerDuty et al). We *detect*; we do not page.
- **Streaming / real-time ingest.** The dataset is a batch of five weeks. Idempotent batch load only.
- **ML anomaly detection.** Explainability beats sophistication per the rubric. Same-weekday trailing
  baselines with σ bands, and we can defend every threshold. No black boxes.
- **ROAS, incrementality, LTV, frequency capping.** There are no conversion events and no `user_id`
  in this dataset. Claiming these would be fabrication — see § 12 R-006.
- **Writing SQL with the LLM at query time.** The LLM routes and narrates. It does not author
  analysis. This is a correctness decision, not a style one (D-004).

> Anything not listed under "In scope" needs a decision-log entry (§ 11) before someone starts on it.

---

## 6. Architecture

```
  data/*.parquet ─┐
  data/*.csv      │
                  ▼
           [ Lane A: ingest ]────────────────────────────┐
             load + idempotent                           │ dictionaries
             MV rollups                                  │ (apps, advertisers,
                  │                                      │  geo_device)
                  ▼                                      ▼
           ┌──────────────────────────────────────────────────┐
           │  ClickHouse                                      │
           │   ad_events (9M, MergeTree)                      │
           │   events_hourly_agg (AggregatingMergeTree)       │
           │   baselines_same_weekday (MV)                    │
           │   external_events (optional, operator-supplied)  │
           └──────────────────────────────────────────────────┘
                  ▲                                      ▲
                  │ parameterised SQL only               │
           [ Lane B: analysis ]                          │
             detectors · decompose · localize            │
             mix-vs-rate · changes · ruleouts            │
             event fingerprint · repeatability           │
                  │  Finding[] + Evidence[]              │
                  ▼                                      │
           [ Lane C: api ]───────────────────────────────┘
             investigation plan runner (deterministic order)
             evidence store · HTTP surface · Langfuse traces
                  │  filled evidence struct (never raw rows)
                  ▼
           [ Lane D: narrate ]
             LLM narrator (narration only)
             numeric grounding check ── rejects ungrounded prose
             demo surface · replay fixtures
                  │
                  ▼
             JSON response + human-readable diagnosis
```

| Component | What it does | Tech | Lane owner | Directory |
|---|---|---|---|---|
| Ingest & schema | Parquet/CSV → ClickHouse; DDL, dictionaries, MV rollups, baseline views; idempotent reload | TypeScript / Bun + `@clickhouse/client` | Lane A (`samarth`) | `clickhouse/`, `scripts/`, `interfaces/`, `constants/`, `enums/`, `utils/` |
| Analysis engine | Every detector and drill-down as parameterised SQL; emits `Finding[]` + `Evidence[]` | ClickHouse SQL + thin TS | Lane B | `analysis/` |
| API & orchestration | Investigation-plan runner, evidence store, HTTP surface, Langfuse tracing | TypeScript / Bun HTTP | Lane C | `api/` |
| Narration & demo | LLM narrator, numeric grounding check, demo surface, replay fixtures | LLM + LibreChat (optional) | Lane D | `narrate/` |

Directory boundaries above are the **source of truth for who may edit what** — they are disjoint.
Shared root files (`docker-compose.yml`, `.gitignore`, `README.md`, `package.json`, `bun.lock`,
`tsconfig.json`) follow the AGENTS.md § 2 rule: announce in BROADCAST first. `bun.lock` in
particular will conflict if two lanes add dependencies in the same hour.

> **Stack is TypeScript/Bun, not Python** — settled by what landed in `bec2a35`, not by debate.
> Lanes B/C/D: your contracts are `.ts`, not `.py`.

**Lane assignment is otherwise unclaimed pending T-002.** Lane A is held by `samarth` by virtue of
having shipped it. The other three slots in AGENTS.md § 1 are still `dev-2`…`dev-4`; pick one at
kickoff and fill in your handle there. The *decomposition* is what needs ratifying here, not who
takes which slot.

⚠ **Ownership hazard:** `interfaces/index.ts`, `constants/`, `enums/` and `utils/` are Lane A's but
every lane will want to add types to them. Do **not**. Each lane declares its own types in
`<lane>/types.ts` and imports from `interfaces/` read-only. A shared type that genuinely belongs to
everyone goes to Lane A via BROADCAST.

---

## 7. Data model  **LOCKED**

The schema is the contract between all four lanes. Change it only via § 11 + a `Breaking:` commit.

- **Dataset / source:** `github.com/sidagarwal04/click-a-thon-2026` → `InMobi/`, mirrored locally at
  `inmobi/` (gitignored). Synthetic; no license constraint stated; provided for this event.
  - `ad_events.parquet` — 103,082,870 bytes, **9,000,000 rows**, 2026-06-01 → 2026-07-05 (~5 weeks)
  - `apps.csv` — 2,000 rows · `advertisers.csv` — 500 rows · `geo_device.csv` — 5,000 rows
  - ⚠ The three CSVs are **Git LFS pointers** on `raw.githubusercontent.com`. Fetch them from
    `media.githubusercontent.com/media/...` or you will load 130-byte stubs.

- **Primary table(s):**
  - `ad_events` — the fact. `event_time, app_id, geo_device_id, advertiser_id, ad_format,
    is_filled, is_impression, is_click, revenue`
  - `apps`, `advertisers`, `geo_device` — dimensions, loaded **both** as tables (for
    reproducibility) and as `hashed` dictionaries (for `dictGet` on the hot path).
  - `external_events` — optional, operator-supplied: `(date, country, region, name, type)`. Empty by
    default. Populated only by a human confirming what an event was. Never inferred.

- **Engine + `ORDER BY`:** as shipped in `bec2a35` —
  ```sql
  ENGINE = MergeTree
  PARTITION BY toYYYYMMDD(event_time)                      -- 35 partitions over the 5wk window
  ORDER BY (event_time, ad_format, app_id, geo_device_id)
  ```
  **Justification:** *every* query in this product is time-bounded first — an incident window versus
  a same-weekday baseline window. Leading the sort key with `event_time` makes both contiguous
  granule reads; `ad_format` follows as the cheapest prune (5 values). Daily partitions are what
  make the loader idempotent: one source chunk maps 1:1 to one partition, so a re-run is
  `DROP PARTITION` + re-`INSERT` with no dedup logic and no double-counted revenue. That
  reload-safety argument beat the monthly-partition proposal (D-011) and it is the right call —
  R-002 says we will reload under time pressure when the unseen incident lands.

- **The query interface is `ad_events_enriched`, not `ad_events`.** A plain VIEW that resolves all
  eight dimension columns via `dictGet` — zero storage, zero ingest cost, no JOINs for any lane to
  get wrong. **Lanes B/C/D query this view and nothing else.** Its column names are a frozen
  contract (§ 8).

- **Materialized views / projections — NOT YET BUILT, and they are the perf story (§ 3):**
  - `events_hourly_agg` (`AggregatingMergeTree`) — the workhorse. Grain
    `(hour, dimension_name, dimension_value)` with `sumState`/`countState` for requests, fills,
    impressions, clicks, revenue. Turns the drill-down sweep from 9M-row scans into thousands.
  - `baselines_same_weekday` — trailing same-weekday aggregates per grain, with `stddevPop`, feeding
    the σ bands.
  - Projection on `ad_events` ordered by `(advertiser_id, event_time)` for the advertiser
    entry/exit and spend-step detectors, which invert the normal access pattern.
  - **These three are the difference between a 10-second `/explain` and a 3-minute one.** They are
    unclaimed. Lane A should file them as a task off T-006 before Lane B starts optimising queries
    against a raw fact table.

- **Canonical DDL lives at:** `clickhouse/schema.sql` — **one file, `samarth` owns it, everyone else
  reads it.** Any change needs `Breaking:` in the commit trailer plus a BROADCAST entry.

### Data facts that constrain the design (read before building detectors)

1. **There is no `campaign_id`.** The campaign grain is `(advertiser_id, campaign_type)`, or
   `advertiser_id` alone as proxy. Decide once, apply everywhere. (D-007)
2. **Only ~5 same-weekday observations exist**, and the first two weeks are effectively baseline
   burn-in. Baselines are trailing same-weekday, up to 4 back. Do not alert on Jun 1–14.
3. **`advertiser_id` is empty on unfilled requests.** Advertiser-sliced *fill rate* is therefore
   undefined. Unfilled-demand analysis runs on supply-side dimensions only. This is the single
   easiest way to produce a confidently wrong number in this dataset.
4. **North America is `NAM`, not `NA`** — `NA` is read as null by most loaders.
5. **Ratio metrics are `sum/sum` over the group**, never an average of per-row or per-day ratios, or
   rollups stop being correct.
6. **No conversions, no installs, no `user_id`.** Bounds § 5 out-of-scope.

---

## 8. Interfaces between lanes  **LOCKED**

Agreed now so all four lanes build against stubs from hour one. **Mock the other side, never wait
for it.** If a contract below is defined, you are unblocked — if it is not yet implemented, stub it.

| Contract | Producer | Consumer | Shape / where defined |
|---|---|---|---|
| `ad_events_enriched` — **the** query surface; flat dimension columns, no JOINs | Lane A | Lanes B, C | `clickhouse/schema.sql`. Column names frozen; adding is fine, renaming/removing is `Breaking:`. Lane B writes SQL against these names before any data is loaded. |
| `Evidence` — one computed number + its provenance | Lane B | Lanes C, D | `analysis/types.ts`. `{id, label, value, unit, sql, sqlHash, window, filters}` |
| `Finding` — one conclusion, with its evidence | Lane B | Lanes C, D | `analysis/types.ts`. `{channel, segment, metric, deltaAbs, deltaPct, revenueImpactUsd, significanceSigma, status: 'found'\|'cleared', evidenceIds[]}` |
| `Investigation` — the full ordered result | Lane C | Lane D | `api/types.ts`. `{request, planSteps[], findings[], evidence[], ruledOut[], primaryChannel, traceId}` |
| HTTP surface — the seven endpoints in § 5 | Lane C | Lane D, judges | `api/openapi.json`, generated. Frozen at M2; additive changes only after. |
| Narration input — **evidence struct only, never raw rows** | Lane C | Lane D | The narrator receives `Investigation` and nothing else. Enforced, not by convention. (D-004) |
| Trace schema — what was checked, in what order, why | Lane C | judges | Langfuse span per plan step, named for the step. `trace_id` returned in every response. |
| Replay fixtures — canned `Investigation` JSON | Lane C | Lane D | `narrate/fixtures/*.json`. Lets Lane D build the demo before the engine is finished. |

**Day-one unblock:** Lane C ships `Investigation` fixtures within the first hour. Lane D builds the
entire narrator and grounding check against fixtures. Lane B writes SQL against `schema.sql` names
before Lane A has loaded a row. Nobody waits.

---

## 9. Milestones

Hackathon is a 24-hour window; times are relative to kickoff (`H+`) because the wall-clock start is
announced at kickoff. Timebox hard — when a box expires, ship what exists and move on.

| ID | Milestone | Definition of done | Deadline |
|---|---|---|---|
| M0 | Kickoff | This file ratified, zero `_TBD_`; lanes assigned in AGENTS.md § 1; repo scaffolded; everyone can query ClickHouse | H+2 |
| M1 | Data in | All four files loaded, dictionaries live, `metrics_glossary` formulas reproduce correct totals | H+5 |
| M2 | Vertical slice | `/explain` returns a real diagnosis for one known date, end to end, ugly but real. HTTP surface frozen. | H+10 |
| M3 | Feature complete | Everything in § 5 "In scope" exists; grounding check enforcing; Langfuse traces on every run | H+17 |
| M4 | Demo-ready | Demo rehearsed twice, **fallback recorded**, README written, deck drafted | H+20 |
| M5 | Freeze | `main` frozen. Only demo-blocking fixes, each with a BROADCAST entry. | H+22 |

**The unseen-incident release lands during M3/M4.** Whoever is free runs it the moment it drops —
that output plus its trace is a submission deliverable and carries significant weight. Do not be
mid-refactor when it lands. Reserve a person.

---

## 10. Success criteria

How we know we won, in measurable terms. Mapped to the published judging criteria.

- [ ] **p95 `/explain` latency < 10s** end to end, including narration, on the 9M-row dataset.
      *(rubric: "fast")*
- [ ] **Zero ungrounded numerals.** Every number in every generated narrative resolves to an
      `Evidence` row. Measured by the grounding check's own reject counter over the full demo run.
      *(rubric: "explanation trustworthiness" — a single fabricated figure costs more than a miss)*
- [ ] **Every planted anomaly we find is named to a specific segment**, not a region-level
      hand-wave. *(rubric: "localized")*
- [ ] **Zero false alarms on the seasonality decoy.** The glossary says at least one planted movement
      is pure seasonality; `/scan` must return it as cleared, not alarmed.
      *(rubric: "avoid crying wolf")*
- [ ] **≥90% of the analytical work happens in ClickHouse**, measured as: no detector exports more
      than 1,000 rows to Python. *(rubric: "analytical depth in ClickHouse")*
- [ ] **Every response carries a `trace_id`** that opens a readable ordered investigation in
      Langfuse. *(rubric: "traceability" — no trace, no credit)*
- [ ] **The unseen incident is run by our system**, with the trace, within 30 minutes of release.
- [ ] **The demo runs start to finish with no manual intervention**, twice, before M4 closes.

---

## 11. Decision log

Append-only. Newest at the bottom. One line per decision. Never edit or delete someone else's row.

| Date | Decision | Why | Decided by |
|---|---|---|---|
| 2026-08-01 | D-001: Product is a **diagnosis API**, not a chat app. Chat is one optional client. | Judges reward the investigation loop, not scaffolding. An API is also testable and traceable in a way a chat UI is not. | sam (proposed) |
| 2026-08-01 | D-002: Primary persona is the **yield/revenue manager**; AM/campaign persona is the second act. | One persona makes the demo coherent. The revenue owner is who the dataset is shaped for. | sam (proposed) |
| 2026-08-01 | D-003: Every finding is **priced in dollars** before it is reported. | Gives one ranking key across metrics. A 40% drop in a $12 segment is noise; 3% in a $400k segment is the story. Rank by dollars, gate by significance. | sam (proposed) |
| 2026-08-01 | D-004: **LLM narrates and routes only.** It never authors analysis SQL and never sees raw rows. | Directly targets the largest scoring risk (fabricated figures) and the explicit hint in the problem statement. Structural, not advisory. | sam (proposed) |
| 2026-08-01 | D-005: **Never name an external event** (match, festival) unless it joins to an operator-supplied `external_events` row. Otherwise report the computed *fingerprint* only. | "There was a cricket match" is not computable from `ad_events`. Naming the shape without naming the cause is both honest and more credible. | sam (proposed) |
| 2026-08-01 | D-006: **Mix-vs-rate decomposition is mandatory** on every localization. | Simpson's paradox is the #1 false-alarm source in blended ad metrics. Distinguishes "nothing broke" from "something broke." | sam (proposed) |
| 2026-08-01 | D-007: Campaign grain is **`(advertiser_id, campaign_type)`**. | There is no `campaign_id` in the dataset. Fixing this once prevents two lanes defining "campaign" differently. | sam (proposed) |
| 2026-08-01 | D-008: Baseline is **trailing same-weekday, up to 4 back**; no alerting on 2026-06-01→06-14. | Only 5 weeks of data exist and the glossary warns a flat average makes every weekend an anomaly. | sam (proposed) |
| 2026-08-01 | D-009: Dimensions loaded as **ClickHouse dictionaries**, not JOINed per query. | Every drill-down query needs all three dimensions. `dictGet` removes a 3-way join from the hot path. | sam (proposed) |
| 2026-08-01 | D-010: Four lanes = **ingest / analysis / api / narrate**, disjoint directories. | Matches the natural seams of the product and lets Lane D build on fixtures from hour one. | sam (proposed) |
| 2026-08-01 | D-011: Fact table is **daily-partitioned**, not monthly. Supersedes the monthly proposal in the first draft of § 7. | Daily partitions make the loader idempotent — one chunk per partition, so a reload is DROP+INSERT with no dedup and no double-counted revenue. Reload safety matters more here than partition count, because R-002 has us reloading under time pressure. | samarth (shipped in `bec2a35`), sam (conceded) |
| 2026-08-01 | D-012: Stack is **TypeScript/Bun**, not Python. All lane contracts are `.ts`. | Settled by what landed on `main` first. Not worth a debate; re-litigating it costs more than either option is worth. | samarth (shipped), sam (conceded) |
| 2026-08-01 | D-013: **`ad_events_enriched` is the only query surface** for Lanes B/C/D. Nobody queries `ad_events` directly. | One place where dimension enrichment can be wrong, instead of four. Makes every drill-down a plain GROUP BY. | samarth (shipped) |

> All rows above are **proposed**. Ratify or contest at M0 kickoff; change `(proposed)` to the
> ratifying handle, or open a BROADCAST entry arguing the other side.

---

## 12. Risks

| Risk | Likelihood | Blast radius | Mitigation | Owner |
|---|---|---|---|---|
| R-001: LLM invents a number in the narrative | High | **Fatal** — one fabricated figure outscores a missed anomaly | Numeric grounding check rejects any prose numeral absent from `Evidence[]`; narrator never sees raw rows (D-004) | Lane D |
| R-002: Unseen-incident dataset differs in shape from the sample | Medium | High — the highest-weighted deliverable | Ingest is schema-driven and idempotent; run a dry reload of the *sample* data through the full path at M3 to prove the loader is re-runnable | Lane A |
| R-003: 5-week window is too thin for reliable baselines | High | Medium — false alarms or missed detections | Trailing same-weekday up to 4 back; suppress alerting on the first 14 days; report σ so weak signals are visibly weak (D-008) | Lane B |
| R-004: We cry wolf on the planted seasonality decoy | Medium | High — explicitly in the rubric | Ruleout battery runs *before* narration; a finding that fails significance is reported as `cleared`, never dropped silently | Lane B |
| R-005: ClickHouse Cloud credits exhausted or unreachable mid-demo | Low | **Fatal** to the demo | `docker-compose` local ClickHouse seeded with the same data, from M1. Demo runs locally by default. | Lane A |
| R-006: We imply ROAS/incrementality the data cannot support | Medium | High — same class as R-001 | Repeatability output states its own limits inline: efficiency and repeatability, not ROAS. No conversion events exist. | Lane B |
| R-007: Scope creep into a polished frontend | High | Medium — eats M3 | Explicitly out of scope (§ 5). No UI work before M3 is green. | all |
| R-008: Two lanes define "campaign" or "baseline" differently | Medium | Medium — inconsistent numbers across endpoints, reads as untrustworthy | D-007 and D-008 fix both once, in this file; detectors import from `analysis/types.ts` rather than redefining | Lane B |
| R-009: Unseen incident lands mid-refactor and nobody is free | Medium | High | § 9 reserves a named person from M3 onward; `main` must be runnable at all times | all |
| R-010: `main` diverges badly because four agents rebase late | Medium | Medium | AGENTS.md § 3 — rebase hourly, push branches immediately, commit small | all |
