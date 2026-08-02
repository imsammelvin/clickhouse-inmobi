# Incident dossier — training set

**Source:** ClickHouse Cloud, `ad_events_enriched`, 9,000,000 rows, 2026-06-01 → 2026-07-05.
Every number below was computed against the loaded data. Nothing here is estimated.

Read with [`diagnosis-template.md`](diagnosis-template.md) — this file is the _evidence_, that one is
the _output format_.

---

## The window at a glance

Blended daily metrics are remarkably stable: fill rate ~0.785, eCPM ~2.475, CTR ~0.011, RPR ~0.0019,
with a slow upward growth trend in requests (264k/day on Jun 1 → 288k/day on Jul 1) and weekends
~20% below weekdays. Against that flatness, five things stand out.

> **Scale note.** Total revenue is ~$500/day across the whole platform in this synthetic set. Dollar
> impacts are therefore small in absolute terms — quote percentages _and_ dollars, and never inflate
> the dollars to make the demo sound bigger. R-001 applies to our own slides.

---

## A — Android 15 fill-rate collapse · **the flagship**

|                  |                                                                       |
| ---------------- | --------------------------------------------------------------------- |
| **Window**       | 2026-06-23 → 2026-06-25 (3 days, Tue–Thu)                             |
| **Headline**     | Blended fill rate 0.785 → 0.750 (−3.5pp, −4.4%)                       |
| **True cause**   | `os_version = 'Android 15'` — fill rate **0.7837 → 0.4333, −35.04pp** |
| **Segment size** | 9.6% of requests                                                      |
| **Channel**      | **Technical break** — engineering owns it                             |
| **Revenue**      | ~$512/day actual vs ~$530 expected ≈ **−$18/day, −3.4%**              |

**Why technical, not demand** — all four checks point the same way:

| Check                        | Baseline | Incident | Reading               |
| ---------------------------- | -------- | -------- | --------------------- |
| Distinct advertisers bidding | 500      | 500      | Nobody left           |
| Render rate (imps/fills)     | 0.9797   | 0.9790   | Rendering is fine     |
| eCPM                         | 2.482    | 2.456    | Price is fine         |
| Requests/day                 | 24,987   | 26,933   | Supply is **up** 7.8% |

Demand present, supply present, rendering fine — but the match stopped happening on one OS version.
That is an SDK/targeting/compatibility failure, not a market event.

### Why this is the flagship: 1 cause, 20 false leads

A plain contribution-ranked sweep returns **21 segments** outside band:

```
os_version=Android 15   0.7837 -> 0.4333   -35.04pp    <- the only real one
region=EU               0.7850 -> 0.7300    -5.50pp
publisher_tier=tier_1   0.9121 -> 0.8732    -3.89pp
app_category=finance    0.7687 -> 0.7311    -3.76pp
ad_format=banner        0.8232 -> 0.7867    -3.65pp
ad_format=interstitial  0.7735 -> 0.7381    -3.54pp
app_category=utility    0.7502 -> 0.7152    -3.50pp
publisher_tier=tier_2   0.8122 -> 0.7776    -3.46pp
... 13 more, all between -2.3pp and -3.4pp
```

Re-run the identical sweep excluding `os_version = 'Android 15'`:

```
region=EU               -0.07pp     publisher_tier=tier_1   +0.01pp
ad_format=banner        -0.15pp     publisher_tier=tier_2    0.00pp
ad_format=interstitial  -0.24pp     publisher_tier=tier_3   -0.16pp
region=APAC             -0.11pp     region=LATAM            +0.04pp
every dimension, every value: within +/-0.24pp
```

Twenty of the 21 were **dilution**, not causes. Android 15 is 9.6% of traffic, so a −35pp collapse
inside it drags every blended slice it touches down by roughly 3pp. This is the evidence behind
D-017 and T-040 (residualization).

---

## B — Global request collapse · **the "not localizable" case**

|                |                                                                   |
| -------------- | ----------------------------------------------------------------- |
| **Window**     | 2026-06-21 (single day, Sunday)                                   |
| **Headline**   | Requests 126,052 vs ~225k expected for a Sunday (**−44%**)        |
| **True cause** | **None localizable — the drop is uniform across every dimension** |
| **Channel**    | **Supply change**, platform-wide                                  |
| **Revenue**    | $235 vs ~$435 expected ≈ **−$200/day, −46%**                      |

Every dimension moves together, within a couple of points of −45%:

```
country=BR      -47.2%     os_version=iOS 16.4    -45.5%
country=FR      -46.0%     publisher_tier=tier_1  -45.4%
app_category=news -46.0%   ad_format=interstitial -45.4%
ad_format=rewarded -45.8%  region=MEA             -45.4%
country=AE      -45.8%     app_category=gaming    -45.3%
country=ZA      -45.6%     os_version=Android 15  -45.3%
```

**Why this case matters more than it looks.** It is the _opposite_ failure mode to incident A. A
naive top-segment ranker names **BR (−47.2%)** as the cause — but BR is not special, it is just the
noisiest draw from a uniform −45%. The correct diagnosis is _"uniform across all dimensions; this is
platform-level, not a segment problem."_

Fill rate (0.7855), eCPM (2.419) and CTR (0.0109) are all **normal** — this is purely volume. So
the residualization loop must be able to terminate with **zero** localized causes and say so, rather
than being forced to name its top-ranked candidate. **That is a design requirement for T-040 and it
would otherwise have been missed.**

---

## C — Finance eCPM drop

|                   |                                                                                |
| ----------------- | ------------------------------------------------------------------------------ |
| **Window**        | 2026-06-19 → 2026-06-22 (4 days)                                               |
| **Headline**      | Blended eCPM 2.475 → ~2.416 (−2.4%); RPR 0.0019 → 0.00186                      |
| **True cause**    | `app_category = 'finance'` — eCPM **2.472 → 1.613, −34.75%**                   |
| **Segment size**  | 7.0% of impressions                                                            |
| **Contamination** | `ad_format = interstitial` shows −5.17% — finance inventory skews interstitial |
| **Channel**       | **Demand change** (price), pending advertiser-level confirmation               |

Same one-cause/one-false-lead shape as incident A, on a **different metric family** (price rather
than fill). Useful precisely because it proves the pipeline is metric-agnostic — which is R-005, the
risk that the unseen incident lands on something other than revenue.

Mix was checked and is **not** the explanation: impression share by `ad_format` is identical between
baseline and incident (banner 36.45% → 36.46%, interstitial 17.13% → 17.16%, native 26.37% → 26.33%,
rewarded 8.26% → 8.17%, video 11.79% → 11.88%). This is a rate move, not a mix move.

Overlaps incident B on Jun 21, so the two are disentangled by window: each is investigated over its
own detected dates, never a union.

---

## E — Weekends · **the decoy, do not alarm**

Every Saturday and Sunday runs ~20% below the weekday level:

```
Sat Jun 06  214,353      Sun Jun 07  220,775
Sat Jun 13  219,420      Sun Jun 14  225,383
Sat Jun 27  228,266      Sun Jun 28  233,943
Sat Jul 04  232,726      Sun Jul 05  239,194
```

Fill rate, eCPM and CTR are all **normal** on these days — only volume moves, and it moves the same
way every week. A flat-average baseline flags all eight as anomalies. A trailing same-weekday
baseline (D-012) flags none.

The glossary states at least one planted movement is pure seasonality. **This is it**, and `/scan`
must return it as _cleared_, not alarmed. Success criterion in `goal.md` § 10.

---

## Recommended demo set

| Order   | Incident              | What it proves                                                                          |
| ------- | --------------------- | --------------------------------------------------------------------------------------- |
| 1       | **A — Android 15**    | Localization + residualization. 1 cause vs 21. The differentiator.                      |
| 2       | **E — weekend decoy** | We don't cry wolf. Trust through refusal.                                               |
| 3       | **B — Jun 21 global** | We say "not localizable" instead of blaming BR. Honesty under a different failure mode. |
| reserve | **C — finance eCPM**  | Metric-agnostic, if a follow-up question needs it                                       |

Beats 1–3 map onto `goal.md` § 4 beats 2, 3 and 5. Feeds T-010 (demo script), T-025 (rehearsal) and
T-037 (video script).

---
