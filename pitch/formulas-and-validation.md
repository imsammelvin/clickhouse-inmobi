# Formulas and validation

**Every calculation the engine performs, what it is for, and a query you can paste into ClickHouse
to check it yourself.**

If any number in a diagnosis cannot be reproduced by the validation query beside its formula, that
is a bug and it outranks a missed anomaly. Code lives in `backend/engine/`.

---

## 1. Base metrics

Fixed by `metrics_glossary.md`. Implemented in `backend/engine/metrics.ts`. **All are sum/sum over the
group — never an average of per-row or per-day ratios**, or rollups stop being correct.

| Metric      | Formula                                    | Unit  |
| ----------- | ------------------------------------------ | ----- |
| Requests    | `count()`                                  | count |
| Fills       | `sum(is_filled)`                           | count |
| Fill rate   | `sum(is_filled) / count()`                 | ratio |
| Impressions | `sum(is_impression)`                       | count |
| Render rate | `sum(is_impression) / sum(is_filled)`      | ratio |
| CTR         | `sum(is_click) / sum(is_impression)`       | ratio |
| Revenue     | `sum(revenue)`                             | USD   |
| eCPM        | `sum(revenue) / sum(is_impression) * 1000` | USD   |
| RPR         | `sum(revenue) / count()`                   | USD   |

**Validate — the whole funnel for one day:**

```sql
SELECT count() AS requests, sum(is_filled) AS fills,
       sum(is_filled)/count() AS fill_rate,
       sum(is_impression) AS impressions,
       sum(is_click)/nullIf(sum(is_impression),0) AS ctr,
       sum(revenue) AS revenue,
       sum(revenue)/nullIf(sum(is_impression),0)*1000 AS ecpm
FROM ad_events_enriched WHERE event_date = '2026-06-23';
```

> ⚠ `advertiser_id` is empty on unfilled requests, so `advertiser_vertical` and `campaign_type` are
> only populated on filled events. The engine excludes them from `fill_rate` and `requests` sweeps
> (`dimensionsFor()`), because slicing fill rate by them is definitionally broken.

---

## 2. Baseline — what "normal" means

**Formula.** For an incident window `[from, to]`, the baseline is every **same weekday** in the
preceding 4 weeks, excluding any date inside the incident window itself.

```
baseline_dates(from,to) = { d - 7k  :  d in [from,to],  k in 1..4,  d-7k >= 2026-06-01 }
                          minus [from,to]
```

**Centre and spread are robust, not classical:**

```
centre = median(baseline values)
spread = max( MAD(baseline) x 1.4826 ,  |centre| x 0.005 )
```

| Choice                      | Why                                                                                                                                                                   |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same weekday                | A flat average makes every weekend an anomaly. The glossary warns about this explicitly.                                                                              |
| **Median, not mean**        | A prior planted incident sitting inside the baseline window otherwise manufactures a fake anomaly. Real case below.                                                   |
| **MAD, not stddev**         | Same reason — one contaminated point in a 3-point sample wrecks a standard deviation.                                                                                 |
| **Spread floor at 0.5%**    | Fill rate is 0.785 ± 0.0005 across the window, so raw stddev → 0 and every move divides out to tens of sigma. A −2.4% eCPM move reported as −19.3σ before this floor. |
| Exclude the incident window | A multi-day incident would otherwise contaminate its own baseline and hide itself.                                                                                    |

**Validate — why the median matters.** Baseline for Sunday 2026-06-28:

```sql
SELECT event_date, count() AS requests
FROM ad_events_enriched
WHERE event_date IN ('2026-06-07','2026-06-14','2026-06-21')
GROUP BY event_date ORDER BY event_date;
-- Jun 07: 220,775   Jun 14: 225,383   Jun 21: 126,052  <- itself an incident
-- mean   = 190,737  -> Jun 28 reads +22.7%  (FABRICATED anomaly)
-- median = 220,775  -> Jun 28 reads  +6.0%  (correct, stays quiet)
```

**Known limit:** only 4–5 same-weekday observations exist in a 5-week dataset. The minimum is 2, so
the earliest dates carry a genuinely thin baseline. The response always reports the observation
count — discount accordingly.

---

## 3. Detection — is it real?

**Two gates, both required:**

```
delta_pct = (incident_per_day - centre) / centre x 100
sigma     = (incident_per_day - centre) / spread

anomalous = |delta_pct| >= 3.0  AND  |sigma| >= 2.5
```

Absolutes are averaged per day before comparison; ratios are averaged across days (still sum/sum
_within_ each day). Comparing a 3-day incident total to a 1-day baseline would show a 200%
"increase" that is pure arithmetic.

**Why both gates.** Sigma alone on 2–4 points calls noise significant. Relative size alone flags
every weekend. Requiring both is what keeps the output quiet enough to be read — and "avoid crying
wolf" is a scored criterion.

**Validate — the decoy must stay quiet:**

```
bun run backend/cli.ts --metric requests --from 2026-06-28
-> "No anomaly. 233943 vs baseline 220775 (1.9 sigma)."  6.0% passes size, 1.9 sigma fails.
```

---

## 4. Revenue identity — which factor moved?

```
Revenue = Requests x Fill rate x (Impressions/Fills) x eCPM/1000
```

Attribution is **sequential**: swap each factor from baseline to incident in turn, holding the
others at their current state, and record the change in rebuilt revenue.

```
R0 = f(req_b, fill_b, rend_b, ecpm_b)
R1 = f(req_i, fill_b, rend_b, ecpm_b)   effect(requests)    = R1 - R0
R2 = f(req_i, fill_i, rend_b, ecpm_b)   effect(fill_rate)   = R2 - R1
R3 = f(req_i, fill_i, rend_i, ecpm_b)   effect(render_rate) = R3 - R2
R4 = f(req_i, fill_i, rend_i, ecpm_i)   effect(ecpm)        = R4 - R3
```

Effects sum to the total by construction; the residual carries interaction terms. **The driver is
the factor with the largest absolute dollar effect, not the largest percentage move** — a 40% swing
on a factor worth $2 is not the story.

Running this first prunes the search space by roughly two thirds: if fill rate carries the move,
there is no reason to sweep dimensions for eCPM.

---

## 5. Localization — which segment?

One `arrayJoin` scan produces every single-dimension cut at once (N dimensions, one pass). Per
segment:

```
delta_abs    = value_incident - value_baseline
delta_pp     = delta_abs x 100                    (ratio metrics only)
share_pct    = segment_requests / total_requests x 100
contribution = |delta_abs| x (share_pct / 100)     <- the ranking key
```

**Ranking is by contribution, not by delta.** A −60pp move on 0.1% of traffic moves nothing. This is
also why every reported segment carries its share: _"−35pp on 9.6% of traffic"_ is a completely
different fact from _"−35pp on 0.2%"_.

**Absolute metrics are divided by their window's day count; ratios are not.** Ratios are
self-normalising. Getting this wrong reported Jun 21 as −71% against a real −43.5%.

---

## 6. Residualization — cause vs contamination _(the differentiator)_

```
causes = []
mask   = TRUE
loop (max 4):
    top = highest-contribution candidate that qualifies
    if none: break
    causes.push(top)
    mask = mask AND NOT top.predicate
    after = localize(metric, window, mask)          <- re-sweep the remainder
    for each prior candidate now inside the band:
        mark cleared_as_contamination, keep its residual as proof
    if nothing in `after` qualifies: break
```

**Qualifies as a cause:** `share >= 0.5%` **and** (`|delta_pp| >= 2.0` for ratios, or
`|delta_pct| >= 5.0` for absolutes).
**Returned to band:** `|residual_pp| <= 0.75` or `|residual_pct| <= 2.0`.

**Uniformity test — runs first, and can return zero causes:**

```
moved   = candidates with |delta| > 1        (require >= 8)
spread  = (max|delta| - min|delta|) / median|delta|
uniform = spread <= 0.25
```

If everything moved together, nothing is localized and the engine says so. **This is not an edge
case** — Jun 21 is 52 segments across 7 dimensions all moving 42.3–46.4 against a platform −43.5%.
An engine obliged to name a top segment would report `country = 'BR'` (−46.4%) as the cause, which
is fabricated.

**Validate — one cause, not twenty-one:**

```sql
-- raw sweep: 21+ segments look guilty
SELECT os_version, sum(is_filled)/count() AS fr FROM ad_events_enriched
WHERE event_date BETWEEN '2026-06-23' AND '2026-06-25' GROUP BY os_version ORDER BY fr;
-- Android 15 = 0.4333, everything else ~0.78

-- now exclude the cause and re-check any "guilty" segment
SELECT region, sum(is_filled)/count() AS fr FROM ad_events_enriched
WHERE event_date BETWEEN '2026-06-23' AND '2026-06-25' AND os_version != 'Android 15'
GROUP BY region;
-- EU returns to 0.7845 vs 0.7852 baseline: -0.07pp, was -5.50pp. Dilution, not a cause.
```

---

## 7. Classification — what kind of thing is this?

Four signals are queried on the cause segment, then matched in order (most specific first):

| Order | Channel           | Trigger                                                                    | Owner              |
| ----- | ----------------- | -------------------------------------------------------------------------- | ------------------ |
| 1     | `demand_change`   | advertisers bidding fell ≥10%                                              | Sales / AM         |
| 2     | `supply_change`   | requests the driver, or \|Δrequests\| ≥ 15%                                | Publisher ops      |
| 3     | `technical_break` | render rate fell ≥ 2pp                                                     | Engineering        |
| 4     | `technical_break` | fill rate is the driver **while** advertisers flat, render flat, eCPM flat | Engineering        |
| 5     | `demand_change`   | eCPM the driver, or \|ΔeCPM\| ≥ 10%, advertisers flat                      | Sales / AM         |
| —     | `not_localizable` | uniformity test fired                                                      | Platform / on-call |

Rule 4 is the interesting one: demand present, supply present, rendering fine, but the match stopped
happening. That is a delivery fault, not a market event — and it is exactly the Android 15 case.

**Validate — the four signals for Jun 23–25:**

```sql
SELECT uniqExactIf(advertiser_id, advertiser_id!='') AS advertisers,
       sum(is_impression)/sum(is_filled) AS render_rate,
       sum(revenue)/sum(is_impression)*1000 AS ecpm,
       count()/3 AS requests_per_day
FROM ad_events_enriched
WHERE os_version='Android 15' AND event_date BETWEEN '2026-06-23' AND '2026-06-25';
-- 500 advertisers (unchanged), render 0.979, eCPM 2.456, requests UP 4.3%
```

---
