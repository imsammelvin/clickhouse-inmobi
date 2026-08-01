# Audit — our solution against the problem statement

**Date:** 2026-08-01, ~T+3h of 24 · **Measured, not estimated.** Reproduce with
`bun run backend/scan.ts`.

---

## 1. The four things we were asked to build

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | **Detect** when a key metric deviates from its expected baseline | ⚠️ **Partial — 2 of 4** | `scan.ts` finds incidents A and B, misses C and D |
| 2 | **Automatically drill down** to isolate the segment(s) responsible | ✅ **Strong** | 42 raw candidates → 1 cause on incident A, in ClickHouse |
| 3 | **Plain-language diagnosis**, every claim backed by a computed number | ⚠️ **Deterministic only** | CLI renders it; no LLM narration layer yet |
| 4 | **Bonus:** state what was checked and ruled out | ✅ **Strongest thing we have** | 38 segments cleared with residuals, free from the deflation loop |

## 2. The hard requirements

| Requirement | Status | Note |
|---|---|---|
| ClickHouse as primary datastore **and analytical engine** | ✅ | All analysis is SQL. No stage exports >1,000 rows. |
| **Meaningfully integrate ≥1 of ClickStack / Langfuse / LibreChat** | ❌ **ZERO** | Nothing. Not a partial — absent. "Superficial inclusion won't count," and we don't even have superficial. |
| Explainability over sophistication | ✅ | Median/MAD baselines, greedy deflation. Every threshold defensible. |
| Public repo, MIT / Apache-2.0 | ❌ | No `LICENSE` file exists. |

## 3. Deliverables

| Deliverable | Status |
|---|---|
| ≤500-word solution summary | ❌ not started (T-035) |
| ≤5-minute demo video | ❌ not started (T-037) |
| ≤15-slide pitch deck | ❌ not started (T-036) |
| Unseen-incident output **+ the trace that proves our system generated it** | ❌ **blocked** — no tracing exists |

---

## 4. Detection accuracy, measured

`bun run backend/scan.ts` replays Stage 0 across all 35 days × 5 metrics.

```
AGAINST KNOWN INCIDENTS
  FOUND   A Android 15 fill collapse  (fill_rate)
  FOUND   B global volume collapse    (requests)
  MISSED  C finance eCPM              (ecpm)
  MISSED  D mild fill dip             (fill_rate)
```

**Recall: 2/4.** And 19 further firings, which break down as:

| Cause | Count | Verdict |
|---|---|---|
| Jun 21 revenue −44.8% | 1 | **Legitimate** — same incident as B, seen through revenue |
| **Revenue +3.8%…+7.2%** on Jun 15, 16, 26, 27, 30, Jul 1, 2, 3, 4 | 9 | **False alarms — systematic** |
| **CTR −3.7%…−8.8%** on 7 days | 7 | **False alarms — noise** |
| requests +3.1% Jun 16 | 1 | marginal |

### Why the revenue false alarms happen — and why they matter

The glossary states the data has *"a slow growth trend."* Requests climb 264k/day → 288k/day across
the window, about **+9%**. Our baseline is the median of the trailing four same-weekdays, which by
construction **lags a rising trend by ~2 weeks**. So every day late in the window reads as a +5%
"anomaly" against its own past.

This is not noise we can threshold away. It is a **systematic bias that grows as the window
advances** — which means it will be *worst* on the unseen incident data, since that is the most
recent slice. We would fire a stream of fake +5% revenue alerts on exactly the dataset we are
scored on.

### Why CTR misfires

CTR ranges 0.0104–0.0114 with no trend — pure noise at ±5%. Our 0.5% spread floor is too tight for
it, so ordinary variation clears 2.5σ. Gates are currently global; they need to be per-metric.

### Why C and D are missed — the architectural one

- **C (finance eCPM):** the segment moved **−34.75%**, but finance is 7% of impressions, so blended
  eCPM moves only **−2.4%** — under our 3% gate. **Detection only ever looks at the blended
  metric.** Any incident confined to a small segment is invisible no matter how severe.
- **D (mild fill dip):** −1pp on a 0.785 base is −1.3% relative, under the same gate. Also masked at
  revenue level by the growth trend.

**This is the single most important finding in this audit.** The judging criterion is *"did you find
the planted anomalies… found, missed, or hallucinated."* We currently miss half of them and
hallucinate seventeen.

---

## 5. Where we are genuinely strong

Worth stating so the gaps above are read in proportion.

- **Localization is excellent and is the differentiator.** 42 → 1 on incident A, with 38 segments
  cleared *and their residuals given as proof*. Nothing else in the field is likely to do this.
- **We refuse to fabricate.** Incident B returns `not_localizable` rather than blaming `country=BR`.
  The weekend decoy stays quiet. Insufficient baselines return a refusal.
- **The ruled-out list — the stated bonus — falls out of the algorithm for free**, not as a bolted-on
  feature.
- **Evidence ledger already exists.** Every number carries its SQL and a hash; the narrator cannot
  reach a number any other way. The trustworthiness criterion is largely already won.
- **Speed.** 1.5s end-to-end, 6 queries, on 9M rows.

---

## 6. Ranked gaps

**P0 — scores zero without these**

1. **Integrate Langfuse.** It is a stated requirement *and* the "no trace, no credit" deliverable
   depends on it. The `Ledger` already records `planSteps` and evidence per stage — this is
   plumbing, not design. Highest value per hour of anything on this list.
2. **Add `LICENSE`** (MIT or Apache-2.0). Two minutes; it is a stated deliverable.

**P1 — directly scored**

3. **Detrend the baseline.** Kills 9 of 19 false alarms and prevents the bias being worst on the
   unseen data. Options: fit and subtract the linear trend, weight recent weeks higher, or compare
   against a trend-projected expectation rather than a flat median.
4. **Segment-level detection.** Sweep segments, not just blended totals, or incidents like C stay
   invisible. This is the recall fix and it is architectural, not a threshold tweak.
5. **Per-metric gates.** One global 3%/2.5σ cannot serve both fill rate (σ ≈ 0.0005) and CTR
   (σ ≈ 5%).

**P2 — needed, not yet urgent**

6. LLM narration layer (Stage 6) + the grounding check.
7. Pairwise dimension sweeps — an incident living only in `os_version × region` is currently unfindable.
8. Summary, deck, video (T-035/36/37).

---

## 7. Honest read

The **investigation** is strong and genuinely differentiated. The **detection** in front of it is
weak, and detection is what the answer key scores first — a perfect drill-down never runs if Stage 0
stays silent.

Two of our four training incidents would go unreported, and nine fake revenue alerts would fire on
the most recent data. The good news is that both failures are understood and neither is deep: the
trend bias is arithmetic, and segment-level scan is a known extension of the sweep we already run.

Against the clock, the ordering I would defend is: **Langfuse first** (a requirement, and blocks the
highest-weighted deliverable), **detrending second** (cheap, kills half the false alarms),
**segment-level detection third** (the recall fix). Narration last — our deterministic output
already satisfies "plain-language diagnosis," and every hour spent on the LLM is an hour not spent
on the thing being scored.
