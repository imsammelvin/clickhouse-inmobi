# Automated diagnosis — 2026-06-01 to 2026-07-05

Produced unattended by `bun run diagnose` in 91.7s. Nobody supplied a metric or a window: the sweep found the incidents, ranked them, and investigated the top 6.

**Data:** 2026-06-01 to 2026-07-05 · 35 days · 9,000,000 requests · $17,020 revenue.
**Sweep:** revenue, requests, fill_rate, ecpm, ctr · 46 firing window(s) → 30 distinct incident(s) after joining across metrics → 6 investigated.
**Gates:** abs(change) >= 10% AND abs(sigma) >= 5, min 150 requests/day/segment
**Run:** `03bf6c2e`

## Summary

| # | Metric | Window | Cause | Channel | $/day | Grounded |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | fill_rate | 2026-06-23 to 2026-06-26 | `os_version='Android 15'` | technical_break | -$20.45 | 42/42 |
| 2 | ecpm | 2026-06-16 to 2026-06-22 | `ad_format='interstitial'` | demand_change | -$5.40 | 36/36 |
| 3 | fill_rate | 2026-06-28 to 2026-06-30 | `os_version='iOS 18.1'` | technical_break | -$1.50 | 46/46 |
| 4 | revenue | 2026-06-19 to 2026-06-26 | platform-wide | not_localizable | n/a | 16/16 |
| 5 | requests | 2026-06-21 to 2026-06-22 | platform-wide | not_localizable | n/a | 6/6 |
| 6 | revenue | 2026-06-15 to 2026-06-21 | platform-wide | no_anomaly | n/a | 7/7 |

## 1. fill_rate — 2026-06-23 to 2026-06-26

**Technical break — Engineering**

```
fill_rate moved -3.2% over 2026-06-23..2026-06-26, driven by os_version = 'Android 15' (-26.36pp on 9.6% of traffic). Worth -$20.45/day.

SO WHAT
  Technical break. Owner: Engineering.
  Fill rate collapsed while all 498 advertisers kept bidding, render rate held at 0.978, eCPM
  held at 2.464 and requests were up 4.4%. Demand and supply are both present; the match is
  failing. That is a delivery fault, not a market event.

WHERE
  os_version = 'Android 15'  -26.36pp on 9.6% of traffic
  device_model = 'Galaxy A54'  -0.29pp on 17.5% of traffic
  region = 'EU'  -0.20pp on 19.1% of traffic

RULED OUT
  x country = 'CA' moved -2.4% but only -4.8 sigma against its own same-weekday history — within this segment's normal range.
  x Advertiser exit: 500 bidding before, 498 during
  x Render failure: 0.978 vs 0.980, within band
  x Price / eCPM: 2.464 vs 2.472, within band
  x Request volume: +4.4%, supply is not the constraint
  x fill_rate moved -3.6%, worth -$18.96/day — not the driver.
  x render_rate moved -0.0%, worth -$0.01/day — not the driver.
  x ecpm moved 0.3%, worth $1.43/day — not the driver.
  x 824 segment(s) cleared as contamination:
      device_model = 'Redmi Note 12'  -6.36pp on the raw sweep, +0.21pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      region|device_model = 'EU|Galaxy A54'  -14.40pp on the raw sweep, +0.69pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      device_model = 'Galaxy S23'  -7.47pp on the raw sweep, -0.23pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      country = 'ID'  -4.83pp on the raw sweep, -0.12pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      country = 'UK'  -5.71pp on the raw sweep, +0.19pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      region|device_model = 'APAC|Redmi Note 12'  -8.02pp on the raw sweep, +0.51pp once os_version = 'Android 15' is excluded — dilution, not a cause.
      ... and 818 more
```

Diagnosed in 6.9s across 16 queries. 42/42 numerals in the text above resolve to a recorded evidence row.

### Receipts (30 of 1731 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c6/e1` fill_rate.incident | 0.759399 | ratio | `0c7b90cb9421` |
| `c6/e2` fill_rate.baseline.same_weekday_mean | 0.784594 | ratio | `0c7b90cb9421` |
| `c6/e3` fill_rate.delta_pct | -3.2112 | pct | `0c7b90cb9421` |
| `c6/e4` fill_rate.sigma | -6.422 | sigma | `0c7b90cb9421` |
| `c6/e5` gate.min_abs_pct | 3 | pct | `de52f0fe348f` |
| `c6/e6` gate.min_sigma | 2.5 | sigma | `1102c01b9088` |
| `c6/e7` fill_rate.delta_pp | -2.5195 | pp | `0c7b90cb9421` |
| `c6/e8` decompose.requests.delta_pct | 4.4359 | pct | `1609a2c64909` |
| `c6/e9` decompose.requests.revenue_effect_usd | 22.6417 | usd | `1609a2c64909` |
| `c6/e10` decompose.requests | 280179 | count | `1609a2c64909` |
| `c6/e11` decompose.fill_rate.delta_pct | -3.5574 | pct | `1609a2c64909` |
| `c6/e12` decompose.fill_rate.revenue_effect_usd | -18.9634 | usd | `1609a2c64909` |
| `c6/e13` decompose.fill_rate | 0.757243 | ratio | `1609a2c64909` |
| `c6/e14` decompose.render_rate.delta_pct | -0.0017 | pct | `1609a2c64909` |
| `c6/e15` decompose.render_rate.revenue_effect_usd | -0.0086 | usd | `1609a2c64909` |
| `c6/e16` decompose.render_rate | 0.980195 | ratio | `1609a2c64909` |
| `c6/e17` decompose.ecpm.delta_pct | 0.2775 | pct | `1609a2c64909` |
| `c6/e18` decompose.ecpm.revenue_effect_usd | 1.4266 | usd | `1609a2c64909` |
| `c6/e19` decompose.ecpm | 2.478919 | usd | `1609a2c64909` |
| `c6/e52` decompose.requests.delta_pct | 4.3923 | pct | `b3d3da12435a` |
| `c6/e53` decompose.requests.revenue_effect_usd | 2.1445 | usd | `b3d3da12435a` |
| `c6/e54` decompose.requests | 26714.5 | count | `b3d3da12435a` |
| `c6/e55` decompose.fill_rate.delta_pct | -44.0145 | pct | `b3d3da12435a` |
| `c6/e56` decompose.fill_rate.revenue_effect_usd | -22.4336 | usd | `b3d3da12435a` |
| `c6/e57` decompose.fill_rate | 0.44036 | ratio | `b3d3da12435a` |
| `c6/e58` decompose.render_rate.delta_pct | 0.057 | pct | `b3d3da12435a` |
| `c6/e59` decompose.render_rate.revenue_effect_usd | 0.0163 | usd | `b3d3da12435a` |
| `c6/e60` decompose.render_rate | 0.980661 | ratio | `b3d3da12435a` |
| `c6/e61` decompose.ecpm.delta_pct | -0.6356 | pct | `b3d3da12435a` |
| `c6/e62` decompose.ecpm.revenue_effect_usd | -0.1815 | usd | `b3d3da12435a` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 76 | 1 | -3.2% move at -6.4 sigma against 12 same-weekday days. |
| decompose | 127 | 2 | requests carries $22.64/day of $5.10/day. |
| localize | 1352 | 1 | 164 segment(s) outside band on a raw ranked sweep. |
| residualize | 4386 | 4 | 164 raw candidate(s) reduced to 4 cause(s); 824 cleared as contamination. |
| confirm | 511 | 4 | 3 of 4 cause(s) significant against their own history; 1 within their own normal range. |
| classify | 305 | 2 | technical_break — owner: Engineering |
| price | 0 | 0 | -$20.45/day over 4 day(s). |

## 2. ecpm — 2026-06-16 to 2026-06-22

**Demand change — Sales / account management**

```
Platform ecpm was normal (-1.2%, -2.5 sigma, within band). Below it, ad_format = 'interstitial' moved -7.5% on 17.4% of traffic over 2026-06-16..2026-06-22. Worth -$5.40/day.

SO WHAT
  Demand change. Owner: Sales / account management.
  eCPM moved -7.9% with advertiser count flat (500 -> 500). Bidders are still present but
  paying differently — a pricing change, not a withdrawal.

WHERE
  ad_format = 'interstitial'  -7.5% on 17.4% of traffic
  app_category = 'finance'  -18.6% on 5.9% of traffic

RULED OUT
  x Platform ecpm: -1.2% at -2.5 sigma — within band. This is a segment-level finding only.
  x region = 'EU' moved -1.1% but only -2.2 sigma against its own same-weekday history — within this segment's normal range.
  x app_id = 'app_00014' moved +1.5% but only 0.8 sigma against its own same-weekday history — within this segment's normal range.
  x Advertiser exit: 500 bidding before, 500 during
  x fill_rate moved 0.0%, worth $0.01/day — not the driver.
  x render_rate moved -0.0%, worth -$0.06/day — not the driver.
  x ecpm moved 0.2%, worth $0.78/day — not the driver.
  x 9 segment(s) cleared as contamination:
      ad_format = 'native'  +5.2% on the raw sweep, -0.0% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      app_category|ad_format = 'ecommerce|native'  +5.4% on the raw sweep, +0.1% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      app_category|ad_format = 'gaming|native'  +5.2% on the raw sweep, -0.1% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      app_category|ad_format = 'entertainment|native'  +5.1% on the raw sweep, -0.1% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      app_category|ad_format = 'utility|native'  +5.1% on the raw sweep, -0.5% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      app_category|ad_format = 'social|native'  +5.3% on the raw sweep, +0.0% once ad_format = 'interstitial' is excluded — dilution, not a cause.
      ... and 3 more
```

Diagnosed in 15.8s across 18 queries. 36/36 numerals in the text above resolve to a recorded evidence row.

### Receipts (30 of 100 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c8/e7` ecpm.incident | 2.028493 | usd | `2ff1e4d4752e` |
| `c8/e8` ecpm.baseline.same_weekday_mean | 2.576937 | usd | `2ff1e4d4752e` |
| `c8/e9` ecpm.delta_pct | -21.2828 | pct | `2ff1e4d4752e` |
| `c8/e10` ecpm.sigma | -10.136 | sigma | `2ff1e4d4752e` |
| `c8/e11` gate.min_abs_pct | 3 | pct | `de52f0fe348f` |
| `c8/e12` gate.min_sigma | 2.5 | sigma | `1102c01b9088` |
| `c8/e13` decompose.requests.delta_pct | 3.1305 | pct | `ff7c6cc7492e` |
| `c8/e14` decompose.requests.revenue_effect_usd | 15.7243 | usd | `ff7c6cc7492e` |
| `c8/e15` decompose.requests | 272413 | count | `ff7c6cc7492e` |
| `c8/e16` decompose.fill_rate.delta_pct | 0.0011 | pct | `ff7c6cc7492e` |
| `c8/e17` decompose.fill_rate.revenue_effect_usd | 0.0057 | usd | `ff7c6cc7492e` |
| `c8/e18` decompose.fill_rate | 0.784827 | ratio | `ff7c6cc7492e` |
| `c8/e19` decompose.render_rate.delta_pct | -0.0108 | pct | `ff7c6cc7492e` |
| `c8/e20` decompose.render_rate.revenue_effect_usd | -0.056 | usd | `ff7c6cc7492e` |
| `c8/e21` decompose.render_rate | 0.979658 | ratio | `ff7c6cc7492e` |
| `c8/e22` decompose.ecpm.delta_pct | 0.1503 | pct | `ff7c6cc7492e` |
| `c8/e23` decompose.ecpm.revenue_effect_usd | 0.7787 | usd | `ff7c6cc7492e` |
| `c8/e24` decompose.ecpm | 2.47674 | usd | `ff7c6cc7492e` |
| `c8/e53` decompose.requests.delta_pct | 3.7353 | pct | `822a492a8a84` |
| `c8/e54` decompose.requests.revenue_effect_usd | 3.5081 | usd | `822a492a8a84` |
| `c8/e55` decompose.requests | 47240 | count | `822a492a8a84` |
| `c8/e56` decompose.fill_rate.delta_pct | -0.3756 | pct | `822a492a8a84` |
| `c8/e57` decompose.fill_rate.revenue_effect_usd | -0.3659 | usd | `822a492a8a84` |
| `c8/e58` decompose.fill_rate | 0.771253 | ratio | `822a492a8a84` |
| `c8/e59` decompose.render_rate.delta_pct | 0.0183 | pct | `822a492a8a84` |
| `c8/e60` decompose.render_rate.revenue_effect_usd | 0.0177 | usd | `822a492a8a84` |
| `c8/e61` decompose.render_rate | 0.978976 | ratio | `822a492a8a84` |
| `c8/e62` decompose.ecpm.delta_pct | -8.8204 | pct | `822a492a8a84` |
| `c8/e63` decompose.ecpm.revenue_effect_usd | -8.5628 | usd | `822a492a8a84` |
| `c8/e64` decompose.ecpm | 2.481677 | usd | `822a492a8a84` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 4592 | 3 | platform series in band; segment sweep found app_category|ad_format='finance|interstitial' at -40.2% — investigating that. -21.3% move at -10.1 sigma against 15 same-weekday days. |
| decompose | 150 | 2 | requests carries $15.72/day of $16.45/day. |
| localize | 2617 | 1 | 35 segment(s) outside band on a raw ranked sweep. |
| residualize | 7411 | 4 | 35 raw candidate(s) reduced to 4 cause(s); 9 cleared as contamination. |
| confirm | 601 | 4 | 2 of 4 cause(s) significant against their own history; 2 within their own normal range. |
| classify | 235 | 2 | demand_change — owner: Sales / account management |
| price | 0 | 0 | -$5.40/day over 7 day(s). |

## 3. fill_rate — 2026-06-28 to 2026-06-30

**Technical break — Engineering**

```
Platform fill_rate was normal (-0.5%, -1.0 sigma, within band). Below it, os_version = 'iOS 18.1' moved -9.99pp on 9.8% of traffic over 2026-06-28..2026-06-30. Worth -$1.50/day.

SO WHAT
  Technical break. Owner: Engineering.
  Fill rate collapsed while all 500 advertisers kept bidding, render rate held at 0.980, eCPM
  held at 2.722 and requests were up 7.6%. Demand and supply are both present; the match is
  failing. That is a delivery fault, not a market event.

WHERE
  os_version = 'iOS 18.1'  -9.99pp on 9.8% of traffic

RULED OUT
  x Platform fill_rate: -0.5% at -1.0 sigma — within band. This is a segment-level finding only.
  x app_category|os_version = 'utility|iOS 17.5' moved +1.3% but only 1.1 sigma against its own same-weekday history — within this segment's normal range.
  x country|ad_format = 'CA|rewarded' moved +1.2% but only 1.3 sigma against its own same-weekday history — within this segment's normal range.
  x app_category|os_version = 'social|iOS 17.5' moved +1.4% but only 0.8 sigma against its own same-weekday history — within this segment's normal range.
  x Advertiser exit: 500 bidding before, 500 during
  x Render failure: 0.980 vs 0.980, within band
  x Price / eCPM: 2.722 vs 2.573, within band
  x Request volume: +7.6%, supply is not the constraint
  x fill_rate moved -0.1%, worth -$0.76/day — not the driver.
  x render_rate moved -0.1%, worth -$0.40/day — not the driver.
  x ecpm moved 0.6%, worth $3.47/day — not the driver.
  x 13 segment(s) cleared as contamination:
      region = 'APAC'  -3.40pp on the raw sweep, +0.10pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      device_model = 'iPhone 14'  -4.69pp on the raw sweep, -0.05pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      region|device_model = 'APAC|iPhone 14'  -17.01pp on the raw sweep, -0.44pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      country = 'JP'  -8.75pp on the raw sweep, +0.11pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      region|device_model = 'APAC|iPhone 13'  -2.55pp on the raw sweep, +0.10pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      country|ad_format = 'JP|banner'  -9.33pp on the raw sweep, +0.02pp once os_version = 'iOS 18.1' is excluded — dilution, not a cause.
      ... and 7 more
```

Diagnosed in 10.9s across 18 queries. 46/46 numerals in the text above resolve to a recorded evidence row.

### Receipts (30 of 112 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c7/e8` fill_rate.incident | 0.387911 | ratio | `31f16a64a78f` |
| `c7/e9` fill_rate.baseline.same_weekday_mean | 0.76775 | ratio | `31f16a64a78f` |
| `c7/e10` fill_rate.delta_pct | -49.4743 | pct | `31f16a64a78f` |
| `c7/e11` fill_rate.sigma | -28.562 | sigma | `31f16a64a78f` |
| `c7/e12` gate.min_abs_pct | 3 | pct | `de52f0fe348f` |
| `c7/e13` gate.min_sigma | 2.5 | sigma | `1102c01b9088` |
| `c7/e14` fill_rate.delta_pp | -37.9839 | pp | `31f16a64a78f` |
| `c7/e15` decompose.requests.delta_pct | 5.2916 | pct | `75e8bdfc19e5` |
| `c7/e16` decompose.requests.revenue_effect_usd | 27.1722 | usd | `75e8bdfc19e5` |
| `c7/e17` decompose.requests | 287562 | count | `75e8bdfc19e5` |
| `c7/e18` decompose.fill_rate.delta_pct | -0.1397 | pct | `75e8bdfc19e5` |
| `c7/e19` decompose.fill_rate.revenue_effect_usd | -0.7553 | usd | `75e8bdfc19e5` |
| `c7/e20` decompose.fill_rate | 0.775412 | ratio | `75e8bdfc19e5` |
| `c7/e21` decompose.render_rate.delta_pct | -0.0739 | pct | `75e8bdfc19e5` |
| `c7/e22` decompose.render_rate.revenue_effect_usd | -0.399 | usd | `75e8bdfc19e5` |
| `c7/e23` decompose.render_rate | 0.979572 | ratio | `75e8bdfc19e5` |
| `c7/e24` decompose.ecpm.delta_pct | 0.6434 | pct | `75e8bdfc19e5` |
| `c7/e25` decompose.ecpm.revenue_effect_usd | 3.4711 | usd | `75e8bdfc19e5` |
| `c7/e26` decompose.ecpm | 2.485904 | usd | `75e8bdfc19e5` |
| `c7/e59` decompose.requests.delta_pct | 5.9531 | pct | `cd55c58f06aa` |
| `c7/e60` decompose.requests.revenue_effect_usd | 3.1495 | usd | `cd55c58f06aa` |
| `c7/e61` decompose.requests | 28201 | count | `cd55c58f06aa` |
| `c7/e62` decompose.fill_rate.delta_pct | -13.315 | pct | `cd55c58f06aa` |
| `c7/e63` decompose.fill_rate.revenue_effect_usd | -7.4637 | usd | `cd55c58f06aa` |
| `c7/e64` decompose.fill_rate | 0.682352 | ratio | `cd55c58f06aa` |
| `c7/e65` decompose.render_rate.delta_pct | 0.0807 | pct | `cd55c58f06aa` |
| `c7/e66` decompose.render_rate.revenue_effect_usd | 0.0392 | usd | `cd55c58f06aa` |
| `c7/e67` decompose.render_rate | 0.979837 | ratio | `cd55c58f06aa` |
| `c7/e68` decompose.ecpm.delta_pct | 5.714 | pct | `cd55c58f06aa` |
| `c7/e69` decompose.ecpm.revenue_effect_usd | 2.7788 | usd | `cd55c58f06aa` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 3262 | 3 | platform series in band; segment sweep found region|os_version='APAC|iOS 18.1' at -51.3% — investigating that. -49.5% move at -28.6 sigma against 11 same-weekday days. |
| decompose | 195 | 2 | requests carries $27.17/day of $29.49/day. |
| localize | 1293 | 1 | 28 segment(s) outside band on a raw ranked sweep. |
| residualize | 5070 | 4 | 28 raw candidate(s) reduced to 4 cause(s); 13 cleared as contamination. |
| confirm | 592 | 4 | 1 of 4 cause(s) significant against their own history; 3 within their own normal range. |
| classify | 334 | 2 | technical_break — owner: Engineering |
| price | 0 | 0 | -$1.50/day over 3 day(s). |

## 4. revenue — 2026-06-19 to 2026-06-26

**Platform-level, not a segment problem — Platform / on-call**

```
revenue moved -9.6% but no segment cleared the significance gates.

SO WHAT
  Platform-level, not a segment problem. Owner: Platform / on-call.

RULED OUT
  x device_model = 'iPhone 14' moved -8.4% but only -2.4 sigma against its own same-weekday history — within this segment's normal range.
  x country|ad_format = 'US|interstitial' moved -7.9% but only -2.1 sigma against its own same-weekday history — within this segment's normal range.
  x region|device_model = 'EU|iPhone 15' moved -7.5% but only -1.8 sigma against its own same-weekday history — within this segment's normal range.
  x country|ad_format = 'US|video' moved -7.5% but only -1.7 sigma against its own same-weekday history — within this segment's normal range.
  x fill_rate moved -2.3%, worth -$11.89/day — not the driver.
  x render_rate moved 0.0%, worth $0.10/day — not the driver.
  x ecpm moved -0.1%, worth -$0.69/day — not the driver.
  x 1 segment(s) cleared as contamination:
      app_category|os_version = 'news|iOS 17.5'  -3.1% on the raw sweep, -1.6% once undefined = 'undefined' is excluded — dilution, not a cause.
```

Diagnosed in 10.9s across 12 queries. 16/16 numerals in the text above resolve to a recorded evidence row.

### Receipts (14 of 50 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c3/e7` decompose.requests.delta_pct | 4.6993 | pct | `426cc422d514` |
| `c3/e8` decompose.requests.revenue_effect_usd | 23.423 | usd | `426cc422d514` |
| `c3/e9` decompose.requests | 274003.5 | count | `426cc422d514` |
| `c3/e10` decompose.fill_rate.delta_pct | -2.2791 | pct | `426cc422d514` |
| `c3/e11` decompose.fill_rate.revenue_effect_usd | -11.894 | usd | `426cc422d514` |
| `c3/e12` decompose.fill_rate | 0.767171 | ratio | `426cc422d514` |
| `c3/e13` decompose.render_rate.delta_pct | 0.0201 | pct | `426cc422d514` |
| `c3/e14` decompose.render_rate.revenue_effect_usd | 0.1027 | usd | `426cc422d514` |
| `c3/e15` decompose.render_rate | 0.979951 | ratio | `426cc422d514` |
| `c3/e16` decompose.ecpm.delta_pct | -0.1344 | pct | `426cc422d514` |
| `c3/e17` decompose.ecpm.revenue_effect_usd | -0.6853 | usd | `426cc422d514` |
| `c3/e18` decompose.ecpm | 2.472832 | usd | `426cc422d514` |
| `c3/e47` price.revenue_impact_per_day | 10.95 | usd | `eb972d0a69f1` |
| `c3/e50` cleared_as_contamination.count | 1 | count | `5c1bca85a18e` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 101 | 1 | -9.6% move at -2.7 sigma against 18 same-weekday days. |
| decompose | 152 | 2 | requests carries $23.42/day of $10.95/day. |
| localize | 2102 | 1 | 47 segment(s) outside band on a raw ranked sweep. |
| residualize | 7742 | 4 | 47 raw candidate(s) reduced to 4 cause(s); 1 cleared as contamination. |
| confirm | 784 | 4 | 0 of 4 cause(s) significant against their own history; 4 within their own normal range. |
| classify | 1 | 0 | no_anomaly — owner: Nobody |
| price | 0 | 0 | $10.95/day over 8 day(s). |

## 5. requests — 2026-06-21 to 2026-06-22

**Platform-level, not a segment problem — Platform / on-call**

Also visible in fill_rate over the same days — one incident, not 2.

```
requests moved -22.9% but no segment cleared the significance gates.

SO WHAT
  Platform-level, not a segment problem. Owner: Platform / on-call.

RULED OUT
  x fill_rate moved 0.1%, worth $0.41/day — not the driver.
  x render_rate moved 0.0%, worth $0.02/day — not the driver.
  x ecpm moved -2.1%, worth -$8.31/day — not the driver.
```

Diagnosed in 0.9s across 4 queries. 6/6 numerals in the text above resolve to a recorded evidence row.

### Receipts (13 of 19 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c4/e7` decompose.requests.delta_pct | -17.4006 | pct | `b0d98a3112b6` |
| `c4/e8` decompose.requests.revenue_effect_usd | -81.517 | usd | `b0d98a3112b6` |
| `c4/e9` decompose.requests | 203567.5 | count | `b0d98a3112b6` |
| `c4/e10` decompose.fill_rate.delta_pct | 0.1063 | pct | `b0d98a3112b6` |
| `c4/e11` decompose.fill_rate.revenue_effect_usd | 0.4112 | usd | `b0d98a3112b6` |
| `c4/e12` decompose.fill_rate | 0.785327 | ratio | `b0d98a3112b6` |
| `c4/e13` decompose.render_rate.delta_pct | 0.004 | pct | `b0d98a3112b6` |
| `c4/e14` decompose.render_rate.revenue_effect_usd | 0.0154 | usd | `b0d98a3112b6` |
| `c4/e15` decompose.render_rate | 0.979843 | ratio | `b0d98a3112b6` |
| `c4/e16` decompose.ecpm.delta_pct | -2.1462 | pct | `b0d98a3112b6` |
| `c4/e17` decompose.ecpm.revenue_effect_usd | -8.314 | usd | `b0d98a3112b6` |
| `c4/e18` decompose.ecpm | 2.419927 | usd | `b0d98a3112b6` |
| `c4/e19` price.revenue_impact_per_day | -89.4 | usd | `eb972d0a69f1` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 50 | 1 | -22.9% move at -3.2 sigma against 5 same-weekday days. |
| decompose | 160 | 2 | requests carries -$81.52/day of -$89.40/day. |
| localize | 681 | 1 | 0 segment(s) outside band on a raw ranked sweep. |
| residualize | 1 | 0 | 0 raw candidate(s) reduced to 0 cause(s); 0 cleared as contamination. |
| confirm | 0 | 0 | 0 of 0 cause(s) significant against their own history; 0 within their own normal range. |
| classify | 0 | 0 | no_anomaly — owner: Nobody |
| price | 0 | 0 | -$89.40/day over 2 day(s). |

## 6. revenue — 2026-06-15 to 2026-06-21

**No anomaly — no action**

Also visible in ctr over the same days — one incident, not 2.

```
No anomaly. revenue was 463.39 against a same-weekday baseline of 499.61 (-1.9 sigma).

SO WHAT
  No action.

RULED OUT
  x Within band: -7.2% (gate 3%), -1.9 sigma (gate 2.5).
```

Diagnosed in 4.6s across 3 queries. 7/7 numerals in the text above resolve to a recorded evidence row.

### Receipts (6 of 12 rows)

| Evidence | Value | Unit | SQL hash |
| --- | --- | --- | --- |
| `c5/e1` revenue.incident | 463.394084 | usd | `2b7367251736` |
| `c5/e2` revenue.baseline.same_weekday_mean | 499.612774 | usd | `2b7367251736` |
| `c5/e3` revenue.delta_pct | -7.2494 | pct | `2b7367251736` |
| `c5/e4` revenue.sigma | -1.858 | sigma | `2b7367251736` |
| `c5/e5` gate.min_abs_pct | 3 | pct | `de52f0fe348f` |
| `c5/e6` gate.min_sigma | 2.5 | sigma | `1102c01b9088` |

### Plan

| Stage | ms | Queries | Result |
| --- | --- | --- | --- |
| detect | 4579 | 3 | Within band: -7.2% (gate 3%), -1.9 sigma (gate 2.5). |

## Seen and not escalated

These fired the detector but were not worth an investigation. Listed rather than dropped, so the digest cannot be accused of hiding what it saw.

| Metric | Window | Segment | Move | Traffic | Why not escalated |
| --- | --- | --- | --- | --- | --- |
| requests | 2026-06-18 to 2026-06-20 | `app_id='app_00149'` | -20.4% | 0.07% | ranked 7 of 30 by severity (drop x traffic share x duration) |
| requests | 2026-06-23 to 2026-06-24 | `app_id='app_00144'` | -12.2% | 0.09% | ranked 8 of 30 by severity (drop x traffic share x duration) |
| requests | 2026-06-29 | `app_id='app_00150'` | -19.9% | 0.08% | ranked 9 of 30 by severity (drop x traffic share x duration) |
| fill_rate | 2026-06-15 | `app_id='app_00214'` | -16.9% | 0.06% | ranked 10 of 30 by severity (drop x traffic share x duration) |
| fill_rate | 2026-06-16 | `app_id='app_00189'` | -17.9% | 0.06% | ranked 11 of 30 by severity (drop x traffic share x duration) |
| fill_rate | 2026-06-27 | `app_id='app_00103'` | -12.5% | 0.10% | ranked 12 of 30 by severity (drop x traffic share x duration) |
| fill_rate | 2026-07-04 | `app_id='app_00142'` | -11.0% | 0.08% | ranked 13 of 30 by severity (drop x traffic share x duration) |
| fill_rate | 2026-07-03 | `app_id='app_00140'` | -11.0% | 0.10% | ranked 14 of 30 by severity (drop x traffic share x duration) |
| revenue | 2026-06-26 to 2026-07-02 | `app_id='app_00141'` | +53.9% | 0.09% | moved up 54%, not a loss — not escalated |
| ctr | 2026-06-22 to 2026-06-29 | `region|os_version='MEA|iOS 16.4'` | +57.6% | 3.02% | moved up 58%, not a loss — not escalated |
| ctr | 2026-07-02 to 2026-07-03 | `app_category|ad_format='finance|native'` | +40.4% | 2.01% | moved up 40%, not a loss — not escalated |
| ctr | 2026-06-29 to 2026-06-30 | `country='ZA'` | +36.6% | 2.66% | moved up 37%, not a loss — not escalated |
| requests | 2026-06-27 to 2026-06-28 | `app_id='app_00141'` | +29.4% | 0.09% | moved up 29%, not a loss — not escalated |
| ctr | 2026-07-05 | `app_category|os_version='utility|Android 14'` | +54.2% | 1.86% | moved up 54%, not a loss — not escalated |
| revenue | 2026-07-03 to 2026-07-04 | `app_id='app_00167'` | +21.9% | 0.08% | moved up 22%, not a loss — not escalated |
| requests | 2026-06-30 to 2026-07-01 | `app_id='app_00117'` | +15.5% | 0.12% | moved up 15%, not a loss — not escalated |
| requests | 2026-06-16 to 2026-06-17 | `app_id='app_00189'` | +28.5% | 0.08% | moved up 29%, not a loss — not escalated |
| ctr | 2026-07-01 | `app_category|os_version='ecommerce|Android 15'` | +26.8% | 2.87% | moved up 27%, not a loss — not escalated |
| requests | 2026-06-26 | `app_id='app_00064'` | +18.5% | 0.22% | moved up 19%, not a loss — not escalated |
| requests | 2026-06-25 | `app_id='app_00172'` | +17.7% | 0.08% | moved up 18%, not a loss — not escalated |
| fill_rate | 2026-07-02 | `app_id='app_00202'` | +14.9% | 0.06% | moved up 15%, not a loss — not escalated |
| fill_rate | 2026-06-17 | `app_id='app_00142'` | +12.6% | 0.09% | moved up 13%, not a loss — not escalated |
| ecpm | 2026-06-30 | `app_id='app_00039'` | +11.4% | 0.33% | moved up 11%, not a loss — not escalated |
| fill_rate | 2026-06-20 | `app_id='app_00150'` | +10.2% | 0.07% | moved up 10%, not a loss — not escalated |

## Cost

Measured from `system.query_log`: 381,604,164 rows read, 4566.1 MiB, 62,572ms server time, 848.2 MiB peak memory across 66 queries.

Full trace: 8 tool call(s), 82 queries, 2024 evidence rows. See `report.json` for the complete record.
