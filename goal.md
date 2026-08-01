# Goal — what we are building

> **Status: DRAFTED.** Filled solo by `loges` once the InMobi data package landed (see `inmobi/`),
> synthesized from the problem statement, `metrics_glossary.md`, and the team's pre-hackathon plan.
> **This still needs a fast all-four confirm at kickoff** — not a rewrite, a sanity check. Flag
> disagreements in `coordination/journal/BROADCAST.md` or the decision log (§ 11), don't silently
> edit LOCKED sections.

---

## 1. One-liner  **LOCKED**

We are building an **automated incident investigator** so that anyone watching InMobi's ad metrics
gets a plain-English, evidence-backed root-cause diagnosis in seconds instead of spending hours
manually slicing dashboards.

## 2. The problem

Revenue, fill rate, and related ad-funnel metrics move across thousands of app × device × geo ×
advertiser × ad-format combinations. When one moves, a human today has to open dashboards and manually
filter by dimension after dimension, comparing each slice to "normal," to assemble an explanation —
this takes minutes to hours even though every number needed already exists in the data. The bottleneck
is the manual investigation, not the data itself.

## 3. Why ClickHouse

The core operation is: for a metric that moved, compute baseline-vs-current for **every single
dimension AND every pairwise dimension combination** (ad_format, category, publisher_tier, vertical,
campaign_type, region, country, device_model, os_version) over a 9M-row, 5-week fact table — in
seconds, not as N sequential queries. This is exactly `GROUP BY ... GROUPING SETS` (or `WITH CUBE`)
over a columnar store: one scan returns every cut simultaneously. Postgres-style row-store scanning
would require either N separate queries or pre-materialized rollups per dimension combo; ClickHouse's
columnar engine + `AggregatingMergeTree` rollups make this a single fast pass. This is a genuinely
ClickHouse-shaped problem, not "we just need a database."

## 4. The demo we will give  **LOCKED**

Write the demo **first** and build backwards from it. Judges see the demo, not the repo.

- **Duration:** ~4 minutes live walkthrough (within the 5-minute demo-video cap)
- **The "wow" moment:** the Langfuse trace opened live, showing every dimension checked (found AND
  ruled out) in order — proving the diagnosis wasn't hand-picked, immediately followed by the
  unseen-incident run producing the same shape of output on data nobody has seen.
- **Beat-by-beat:**
  1. Trigger a rehearsed training-set incident (metric drop). Detection sweep fires automatically —
     no human points at the metric.
  2. LibreChat renders the diagnosis as a chat message: checks (✓/✗ per sub-metric), ruled-out list,
     root-cause segment, contribution %, confidence — citing real numbers throughout.
  3. Open the matching Langfuse trace live: walk through Stage 0–6, what was checked, in what order.
  4. Ask a follow-up question in LibreChat ("why not CTR?") — a live ClickHouse query runs, LLM
     explains the real result.
  5. Close with the **unseen incident**: same pipeline, fresh data released on Day 2, output + trace,
     run once, untouched by hand.
- **Fallback if live fails:** pre-recorded screen capture of the exact same run (rehearsed at least
  twice against the training dataset), plus the raw JSON/trace links as backup evidence.

## 5. Scope

### In scope (we will build this)
- Detection sweep across core metrics × time buckets (seasonality-aware baseline, two-gate flag)
- Revenue-identity walk (Requests → Fill rate → Impressions/Fills → eCPM) to find which factor moved
- Single parameterized ClickHouse drill-down query (GROUPING SETS) across all listed dimensions +
  pairwise combinations
- Statistical significance gating before calling any segment anomalous
- Contribution-to-delta ranking + a simple, explainable confidence score
- LLM narration stage (numbers-only-from-JSON, never raw events)
- Langfuse trace per investigation (every stage as a span)
- LibreChat wiring: diagnosis rendering + follow-up Q&A against the live backend
- One command/one API call that runs the whole pipeline unattended, for the unseen-incident submission

### Out of scope (we will deliberately NOT build this)
- Authentication, production deployment, alerting integrations (PagerDuty etc.) — explicitly called
  out as not rewarded by the problem statement
- A polished/custom frontend beyond LibreChat — same reason; team decision (see decision log) is
  LibreChat-only, no separate tree UI
- An LLM that plans investigation steps dynamically — pipeline is deterministic by design (reproducibility on the unseen incident)
- ML-based anomaly detection — baselines + statistical gating are sufficient and far more explainable

> Anything not listed under "In scope" needs a decision-log entry (§ 11) before someone starts on it.

## 6. Architecture

```
inmobi/data/*  →  [ clickhouse/ ingest ]  →  [ ClickHouse Cloud: raw + rollup tables ]
                                                        │
                                    [ clickhouse/ + mcp/ : detection sweep +
                                      GROUPING SETS drill-down + significance gate ]
                                                        │
                                         [ backend/ : orchestrator (Stages 0-6),
                                           contribution ranking, confidence,
                                           Langfuse tracing, LLM narration ]
                                                        │
                                    ┌───────────────────┼───────────────────┐
                                    ▼                   ▼                   ▼
                            [ librechat/ ]        [ Langfuse cloud ]   [ clickstack/ ]
                            diagnosis + follow-up  trace per incident  service latency/
                            chat surface                                error observability
```

| Component | What it does | Tech | Lane owner | Directory |
|---|---|---|---|---|
| ClickHouse schema + ingest | Star schema load (ad_events + 3 dims), rollup table, detection + GROUPING SETS drill-down queries | ClickHouse Cloud, SQL | Lane B (dev-2) | `clickhouse/` |
| ClickHouse MCP server | Exposes drill-down queries as MCP tools for the backend and the follow-up-chat loop | ClickHouse MCP server | Lane B (dev-2) | `mcp/` |
| Investigation orchestrator + API | Stages 0–6: detection, baseline, attribution, dimension explorer, significance gate, ranking/confidence, narration; Langfuse tracing | Node/TS or Python API | Lane A (loges) | `backend/` |
| ClickStack observability | Instruments the backend service: per-stage latency, error rate, request traces | ClickStack (HyperDX) | Lane C (dev-3) | `clickstack/` |
| LibreChat integration | Custom endpoint/plugin: renders diagnosis as chat message, runs follow-up queries live | LibreChat | Lane D (dev-4) | `librechat/` |

Lane owners are assigned in [AGENTS.md](AGENTS.md) § Lanes and ownership. Directory boundaries here
are the **source of truth for who may edit what** — keep them disjoint.

## 7. Data model  **LOCKED**

The schema is the contract between all four lanes. Change it only via § 11 + a heads-up commit.

- **Dataset / source:** InMobi synthetic ad-events package, now in `inmobi/` — `ad_events.parquet`
  (9,000,000 rows, ~5 weeks: Jun 1 – Jul 5, 2026), `apps.csv` (2,000 rows), `advertisers.csv` (500
  rows), `geo_device.csv` (5,000 rows). Star schema: `ad_events` fact table joined to `apps`,
  `advertisers`, `geo_device` dimension tables. See `inmobi/README_START_HERE.md`.
- **Primary table(s):**
  - `ad_events` (fact): `event_time, app_id, geo_device_id, advertiser_id, ad_format, is_filled,
    is_impression, is_click, revenue`. `advertiser_id` is empty on unfilled requests.
  - `apps` (dim): `app_id, category, publisher_tier`
  - `advertisers` (dim): `advertiser_id, vertical, campaign_type`
  - `geo_device` (dim): `geo_device_id, region, country, device_model, os_version`
  - Rollup (derived, not raw): pre-aggregate to `(hour_bucket, app_id, geo_device_id, advertiser_id,
    ad_format) → count() AS requests, sum(is_filled) AS fills, sum(is_impression) AS impressions,
    sum(is_click) AS clicks, sum(revenue) AS revenue`. **Never store or average pre-computed ratios**
    (fill rate, eCPM, CTR, RPR) — always `sum(x)/sum(y)` at query time over rolled-up sums, per
    `metrics_glossary.md`.
- **Engine + `ORDER BY`:** `ad_events` as `MergeTree`, `ORDER BY (event_time, app_id, geo_device_id,
  advertiser_id)` for fast time+dimension filtering. Rollup as `AggregatingMergeTree` (or
  `SummingMergeTree` on the five sum columns), `ORDER BY (hour_bucket, app_id, geo_device_id,
  advertiser_id, ad_format)` — matches the dimension-cut access pattern the drill-down query needs.
  Dimension tables as small `MergeTree` tables (or joined via dictionaries for the hottest lookups:
  `region`, `device_model`, `category`, `vertical`).
- **Materialized views / projections:** one MV maintaining the rollup table from `ad_events` inserts;
  revisit projections for the hottest single-dimension cuts only if query latency demands it.
- **Canonical DDL lives at:** `clickhouse/schema.sql` — one file, dev-2 owns it, everyone else reads
  it.
- **The revenue identity (from `metrics_glossary.md` — do not re-derive):**
  `Revenue = Requests × Fill rate × (Impressions/Fills) × eCPM/1000`, which simplifies to
  `Revenue ≈ Requests × Fill rate × eCPM/1000` since impressions ≈ fills. CTR is a sibling
  engagement/quality signal, not a direct revenue factor in this CPM model — check it, but don't
  attribute revenue moves to it.
- **Dimensions to slice (single + pairwise, per GROUPING SETS):** `ad_format`; `category`,
  `publisher_tier` (via `apps`); `vertical`, `campaign_type` (via `advertisers`); `region`, `country`,
  `device_model`, `os_version` (via `geo_device`).
- **Known data characteristics to design for:** real daily (hour-of-day) and weekly (weekend-lower)
  seasonality, a slow growth trend, random noise. **At least one planted movement is pure seasonality
  and must be checked and ruled out, not alarmed on** — baseline must compare like-for-like (same
  weekday/hour, trailing weeks), never a flat global average.

## 8. Interfaces between lanes  **LOCKED**

Agree these early so the four lanes can build in parallel against stubs instead of blocking.

| Contract | Producer | Consumer | Shape / where defined |
|---|---|---|---|
| Rolled-up event data (sums, not ratios) | Lane B (`clickhouse/`) | Lane A (`backend/`) | `clickhouse/schema.sql` rollup table; queried directly or via MCP |
| ClickHouse drill-down query results (detection + GROUPING SETS output) | Lane B (`mcp/`) | Lane A (`backend/`), LibreChat follow-up (Lane D) | MCP tool calls — schema/tool names defined in `mcp/README.md` |
| Investigation JSON (metric, delta%, root cause, contribution%, confidence, ruled-out list) | Lane A (`backend/`) | Lane D (`librechat/`) | `backend/schemas/investigation.schema.json` |
| Investigation trace (Stage 0–6 spans) | Lane A (`backend/`) | Langfuse (external), judges | Langfuse SDK calls in `backend/`; no other lane consumes this directly |
| Service latency/error telemetry | Lane A (`backend/`, instrumented) | Lane C (`clickstack/`) | OTel/HTTP instrumentation emitted by `backend/`, ClickStack ingests |

Rule: **mock the other side, never wait for it.** If a contract is defined, you are unblocked — e.g.
Lane D can build against a hand-written sample `investigation.schema.json` payload before Lane A's API
is live.

## 9. Milestones

Timebox hard. When a box expires, ship what exists and move on. (Hack started 12:00 pm, 1 Aug 2026;
code freeze 12:00 pm, 2 Aug 2026 — server-enforced, no extensions.)

| ID | Milestone | Definition of done | Deadline |
|---|---|---|---|
| M0 | Kickoff | This file has zero `_TBD_`; lanes assigned; repo scaffolded; everyone can run ClickHouse locally | 12:30 pm, 1 Aug |
| M1 | Data in | `ad_events` + 3 dims loaded into ClickHouse Cloud; rollup table live; canonical query returns correct results | 2:00 pm, 1 Aug |
| M2 | Vertical slice | One incident, end to end: detection → attribution → narration → Langfuse trace, ugly but real | 6:00 pm, 1 Aug |
| M3 | Feature complete | Everything in § 5 "In scope" exists: full dimension drill-down, significance gate, confidence, LibreChat both surfaces, ClickStack instrumented | 12:00 am, 2 Aug |
| M4 | Demo-ready | Demo rehearsed twice, fallback recorded, README written | 9:00 am, 2 Aug |
| M5 | Freeze | No merges to `main` except demo-blocking fixes | 12:00 pm, 2 Aug (hard) |

> **Internal freeze note:** freeze pipeline *logic/thresholds* 1–2 hours before the announced
> unseen-incident release time (exact time TBD, announced at kickoff) — this is stricter than M5 and
> exists specifically so the unseen-incident run is untouched by hand-tuning. Only bug-fixes after
> that point, same as M5.

## 10. Success criteria

How we know we won, in measurable terms.

- [ ] Detection sweep finds the planted training-set anomalies (including the pure-seasonality one,
      correctly *ruled out*, not alarmed on) with zero manual threshold tuning per incident
- [ ] Every number in a narrated diagnosis is reproducible by re-running the cited ClickHouse query
- [ ] End-to-end pipeline (trigger → narrated diagnosis) completes in well under a minute, ideally
      single-digit seconds, on the full 9M-row dataset
- [ ] The unseen-incident run produces a diagnosis + a complete, openable Langfuse trace with **no
      human intervention** between data release and submission
- [ ] LibreChat follow-up question ("why not CTR?") triggers a real ClickHouse query and returns a
      grounded answer, not a canned one

## 11. Decision log

Append-only. Newest at the bottom. One line per decision. Never edit or delete someone else's row.

| Date | Decision | Why | Decided by |
|---|---|---|---|
| 2026-08-01 | Detection sweep is a required Stage 0, not assumed given | Problem statement requirement #1 is "detect when a metric deviates"; the unseen incident has no human pointing at it | loges (pre-kickoff plan) |
| 2026-08-01 | Deterministic fixed pipeline; LLM never chooses investigation steps | Reproducibility on the unseen incident with zero tuning requires identical behavior every run | loges (pre-kickoff plan) |
| 2026-08-01 | UI is LibreChat only — no separate custom tree UI | Problem statement lists "polished frontends" as out of scope; concentrates the team's one frontend surface into the tool that's already scored | loges + user, confirmed in planning session |
| 2026-08-01 | Real team lane assignment locked as: dev-2 → MCP + ClickHouse schema, dev-3 → ClickStack, dev-4 → LibreChat, loges → orchestrator/backend/Langfuse | Matches the actual pre-event ownership split, supersedes an earlier draft that had swapped dev-3/dev-4 | loges |

## 12. Risks

| Risk | Likelihood | Blast radius | Mitigation | Owner |
|---|---|---|---|---|
| Seasonality misfires (weekday/weekend, hour-of-day) cause false positives on the unseen incident | Medium | High — direct hit on detection accuracy scoring | Two-gate (relative % AND stddev) + like-for-like baseline (same weekday/hour, trailing weeks), never a flat average | loges / dev-2 |
| Unseen incident lands on a metric other than Revenue (fill rate, CTR, etc.) | Medium | High — pipeline built revenue-first might not generalize | Keep the metric tree config-driven; validate against fill-rate-only and CTR-only synthetic incidents during rehearsal | loges |
| Pipeline hand-tuned to known training anomalies, breaks on the unseen set | Medium | High — "no trace, no credit" / hallucination penalty | Internal freeze rule before the announced release time (§ 9); no threshold changes after | all |
| ClickHouse Cloud credits burn from idle services overnight | Low | Medium — could hit the $400/team ceiling | Pause services when not actively querying; confirmed in event handbook notes | dev-2 |
| LibreChat customization (custom endpoint/plugin) takes longer than expected | Medium | Medium — only frontend surface, no fallback UI | Start LibreChat wiring early (not blocked on M3), keep the contract (§ 8) stable so dev-4 can mock the backend response | dev-4 |
