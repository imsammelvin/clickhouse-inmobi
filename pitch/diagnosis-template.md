# Diagnosis output template

**Task:** T-026 · **Owner:** sam · **Date:** 2026-08-01
**This is the spec for T-019 (narration prompt) and T-023 (LibreChat rendering).**

Every number in the worked examples below is real, computed against the loaded 9M rows. Provenance
is in [`incident-dossier.md`](incident-dossier.md). If you change the shape here, tell Lane A and
Lane D — this is what they build against.

---

## 1. The five blocks, in this order

Order is not cosmetic. A revenue owner reads top-down and stops as soon as they know what to do, so
the _action_ must be reachable in the first two blocks and the _proof_ must sit below it.

| #   | Block          | Answers                                                           | Required?                                                 |
| --- | -------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| 1   | **HEADLINE**   | What moved, by how much, worth how much                           | Always                                                    |
| 2   | **SO WHAT**    | What kind of thing this is, who owns it, what it costs if ignored | Always                                                    |
| 3   | **WHAT MOVED** | Which factor of the revenue identity                              | Always for revenue; omit for single-metric queries        |
| 4   | **WHERE**      | The specific segment, with its size                               | Only if localizable — **say so explicitly when it isn't** |
| 5   | **RULED OUT**  | What was checked and cleared, with residuals                      | Always, even when empty                                   |

Block 5 is never omitted. An empty ruled-out list is itself information: it means we didn't check
anything, and the reader deserves to know that.

## 2. Prose rules

- **Every numeral carries an evidence id** — `[e7]`. No id, no numeral. The grounding check
  (T-019) rejects the response otherwise.
- **Percentage points vs percent are different words.** Fill rate fell _3.5pp_, which is _−4.4%_.
  Never write "3.5%" for a pp move.
- **Name the segment in the schema's own vocabulary.** `os_version = 'Android 15'`, not "Android
  devices". A reader must be able to paste it into a filter.
- **Always state the segment's size.** "−35pp on 9.6% of traffic" is a completely different fact
  from "−35pp on 0.2% of traffic".
- **Cleared means cleared.** "Checked and cleared at 6.1σ", never "probably fine", "seems normal",
  or "unlikely to be the cause". If we can't clear it, it goes in WHERE as a second cause.
- **Never attribute to anything outside the dataset** (D-019) — no events, calendars or holidays.
- **No adjectives on magnitude.** Not "a dramatic collapse" — "−35.04pp". The number is the drama.

---

## 3. Golden example — technical break _(incident A, real numbers)_

```
Fill rate fell to 0.750 on 2026-06-23 to 06-25, down 3.5pp [e1] from a
0.785 same-weekday baseline [e2] — a 4.4% relative move [e3], worth
about -$18/day [e4], -3.4% of daily revenue [e5].

SO WHAT
  Technical break. Owner: engineering.
  Demand and supply are both healthy; the match is failing on one OS version.
  Exposure if unfixed: -$18/day [e4] and it has already run 3 days [e6].

WHAT MOVED
  Requests    +7.8%   [e7]   -> not the cause
  Fill rate   -35.0pp [e8]   -> THE CAUSE
  Render rate  0.979 vs 0.980 [e9] -> not the cause
  eCPM         2.456 vs 2.482 [e10] -> not the cause
  Fill rate carries effectively all of the move.

WHERE
  os_version = 'Android 15'
  fill rate 0.7837 -> 0.4333 [e11], -35.04pp, on 9.6% of requests [e12].
  All 500 advertisers still bidding on this segment [e13], so this is not
  a demand loss.

RULED OUT
  x Advertiser exit      500 bidding before, 500 during [e13]
  x Render failure       0.979 vs 0.980, within band [e9]
  x Price/eCPM           2.456 vs 2.482, within band [e10]
  x Request volume       +7.8%, supply is up not down [e7]
  x Seasonality          same-weekday trailing baseline used [e2]
  x region = EU          -5.50pp raw, but -0.07pp once Android 15 is
                         excluded [e14] - dilution, not a cause
  x publisher_tier=tier_1 -3.89pp raw, +0.01pp excluding Android 15 [e15]
  x 18 further segments  all within +/-0.24pp once Android 15 is excluded [e16]
```

The last three ruled-out lines are the product. Without residualization (T-040) those 20 segments
appear in **WHERE** as co-causes, and the diagnosis is wrong in a way no reader can detect.

---

## 4. Golden example — not localizable _(incident B, real numbers)_

The case that breaks naive tools. **A system must be able to conclude "no segment is responsible."**

```
Requests fell to 126,052 on 2026-06-21, down 44% [e1] from a ~225,000
same-weekday Sunday baseline [e2]. Revenue -$200 [e3], -46% [e4].

SO WHAT
  Platform-level supply event. Owner: publisher ops / platform.
  This is NOT a segment problem - do not go hunting for one.
  Single day; volume returned to normal on 06-22 [e5].

WHAT MOVED
  Requests    -44%   [e1]  -> THE CAUSE
  Fill rate   0.7855 [e6]  -> normal
  eCPM        2.419  [e7]  -> normal
  CTR         0.0109 [e8]  -> normal
  Volume only. Every downstream rate is healthy.

WHERE
  No localizable segment. The drop is uniform across every dimension
  tested: the widest spread across 6 dimensions and 40 values is
  -47.2% to -45.2% [e9], against a platform total of -44%.
  The largest single deviation (country = 'BR', -47.2% [e10]) is within
  normal dispersion for a segment of its size and is NOT the cause.

RULED OUT
  x Any single segment   40 values across 6 dimensions, all -45% +/-2 [e9]
  x country = 'BR'       -47.2%, ranked first, but the platform moved
                         -44% - it is a draw from the same distribution [e10]
  x Fill / eCPM / CTR    all within band [e6][e7][e8]
  x Seasonality          Sunday baseline used; other Sundays are 220-239k [e2]
```

Note what this forbids: **the engine may not be required to return a top segment.** T-040's loop has
to be allowed to terminate with an empty cause set. Naming BR here would be a fabricated cause.

---

## 5. Golden example — seasonality, no alarm _(incident E, real numbers)_

The shortest and possibly the most valuable output we produce.

```
No anomaly. Requests on 2026-06-28 were 233,943 [e1], which is 4.6%
above the trailing same-weekday Sunday baseline of 223,600 [e2]
(0.7 sigma [e3]).

SO WHAT
  No action. This is the normal weekend pattern.

RULED OUT
  x Weekend seasonality   flagged only against a flat all-day average;
                          against same-weekday it is +0.7 sigma [e3]
  x Fill rate             0.7772, within band [e4]
  x eCPM                  2.491, within band [e5]
```

Being able to emit this confidently is a scored criterion (`goal.md` § 10) and it is the demo's
trust beat.

---

## 6. Golden example — insufficient data

Rarer, but it must exist or we will confidently answer questions we cannot answer.

```
Cannot call this. 2026-06-03 has only 2 prior same-weekday observations
[e1]; the baseline needs 3 (D-012).

SO WHAT
  No diagnosis offered. Re-run after 2026-06-15 for a valid baseline,
  or widen the window and accept a weaker signal.
```

Never dress this up as a finding. It is a refusal, and a refusal is a legitimate output.

---

## 7. Templates without a found training case

Structurally supported, **not yet evidenced in this dataset.** Flagged so nobody mistakes a template
for a validated capability — the standard D-017 set.

**Demand change (advertiser exit).** WHERE names `advertiser_id` last-seen inside the window;
RULED OUT must clear render rate and volume; SO WHAT states run-rate exposure and — if T-033 lands —
substitutable advertisers on the same inventory.

**Mix shift.** The one where the answer is _"nothing is broken."_ WHAT MOVED splits Δblended into
rate effect and mix effect; WHERE names the dimension whose weights moved, not a broken segment;
SO WHAT is explicitly **no action**. Requires T-041. _No training case found_ — see T-031.

~~**Exogenous event.**~~ **Dropped under D-019** — external attribution is out of scope, and the
data has no event structure to find (largest hourly deviations in entertainment apps are 1.6× on
49–85 requests at random hours, i.e. noise). There is no fingerprint stage and no `external_events`
join.

---

## 8. What Lane A needs from this

1. `Finding.channel` must include a **`not_localizable`** value. § 4 shows why — it is not an edge
   case, it is one of our five training incidents.
2. `Finding.status` needs **`cleared_as_contamination`**, distinct from `cleared_as_normal`. The
   § 3 example's last three lines depend on that distinction, and it is our differentiator.
3. Every `Evidence` row needs a `segmentSharePct`. "−35pp" is meaningless without "on 9.6%".
4. The narrator must be able to emit **zero** findings and still produce §5 or §6 output. An empty
   result is a valid, and sometimes the correct, answer.
