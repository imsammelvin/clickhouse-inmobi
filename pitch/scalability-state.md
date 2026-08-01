# Scalability: what is measured, what is converted, what is not

**Owner:** sam · **Date:** 2026-08-02 · For the pitch, and written to be defensible under questioning.

Every number here came from `system.query_log` or from a gate in this repo. Where a figure is a share
rather than an absolute, it says so — one earlier draft of this page quoted an absolute that was really
a sum across several runs, and that is exactly the kind of number a judge asks the follow-up about.

## The claim we can actually defend

**Rows returned to the client are bounded by dimension cardinality, not by event volume.** That is
gated: `criteria` fails the build if any stage streams more than 5,000 rows back, and the flagship
investigation's largest result set is 1,009 rows.

**Rows read are now bounded too, wherever the rollup serves the query.** Two materialized views,
maintained on insert, no manual step:

    mv_rollup_segment_hourly    ad_events             -> rollup_segment_hourly    3,089,172 rows
    mv_rollup_segment_daily     rollup_segment_hourly -> rollup_segment_daily       148,767 rows

The daily table is _derived from_ the hourly one rather than being a second independent fan-out, so the
two grains cannot disagree — a derivation cannot drift where two parallel aggregations can.

Measured across a representative call mix (`backend/clickhouse/rollup-bench.json`):

|             | raw         | rollup    |
| ----------- | ----------- | --------- |
| rows read   | 213,625,303 | 3,690,604 |
| bytes read  | 2.6 GiB     | 117 MiB   |
| server time | 41,235 ms   | 923 ms    |
| peak memory | 884 MiB     | 40.5 MiB  |

The compression factor is `events_per_day / distinct_attribute_combinations`, so it **improves** with
scale: the rollup grows with dimension cardinality x time, not with events.

## What is converted, and what is not

| Component                        | Reads the MV   | Evidence                                             |
| -------------------------------- | -------------- | ---------------------------------------------------- |
| All 10 MCP tools                 | yes            | `servedFrom=rollup:daily:...`, 40-65 ms per call     |
| `find_incidents` sweep           | yes            | 9,446 ms -> 325 ms                                   |
| `detect`, `confirm`, `decompose` | yes            | `bun run parity` reports `rollup-served`             |
| `localize` (unmasked sweep)      | yes            | `parity` bit-identical with the rollup in use        |
| `residualize` (masked re-sweeps) | **no**         | ~4 queries per investigation, see below              |
| `classify`                       | no, and cannot | `uniqExact(advertiser_id)` is not additive over sums |

**Five of six investigation stages are converted.** The sixth cannot be: `classify` counts distinct
advertisers, and a distinct count cannot be recovered from sums.

What remains on raw is `residualize`'s _masked_ re-sweeps — about four queries per investigation.
A measurement is 40 ms; a full investigation is a few seconds.

## Why the last masked path is not done

Not time, and not oversight. `detect` and `decompose` were a two-line swap. `localize`'s unmasked sweep
was better than that — the rollup already stores one row per (dimension, value), which is exactly what
localize's `arrayJoin` was constructing, so the fan-out simply disappeared. `residualize` is a different
shape.

It re-sweeps every dimension **with an exclusion mask** — "everything except Android 15" — and a
pre-aggregated table cannot subtract a segment unless that segment's dimension is part of the key. It is
answerable, from the pair keys, by summing the complement. But it needs three fallbacks (entity
dimensions cannot be paired, three-or-more-dimension cuts exceed the key space, non-additive metrics
never qualify), and the loop is **inherently sequential**: each iteration's exclusion is built from the
previous iteration's chosen cause, so it cannot be parallelised either.

And it is the arithmetic behind the _cleared-as-contamination_ list, which is our differentiator. A
wrong residual does not error. It prints a plausible list of segments we claim to have ruled out.

That is the whole reason it is not done: the remaining work is the part where being wrong is invisible,
and we chose not to do it in the hours before a freeze.

## What makes finishing it safe rather than hopeful

`bun run parity` runs the same investigation twice in one process — once on the rollup, once with the
rollup forced off — and compares **every recorded number by label**, not just the headline. 799 evidence
values across five channel scenarios, currently bit-identical.

It also reports **VACUOUS** rather than PASS when no stage actually read the rollup, because the first
version of it silently compared raw against raw and would have blessed anything. A gate that reads green
having compared nothing is worse than no gate.

Two real defects were found by verification rather than by review while wiring the three stages that
are done: a mask constructed without its dimensions, planned against the wrong rollup key; and a second
such site found only by making the field required so the compiler had to point at it. Both would have
returned plausible numbers.

## The honest summary

- The scalability _design_ is proven: rows read and rows returned are both bounded by cardinality
  rather than by event count, and the measured delta is 58x on rows and 45x on server time.
- The _conversion_ is the tool layer plus five of six investigation stages. The sixth is arithmetically
  impossible to convert, not merely unfinished.
- What remains is one masked query shape inside `residualize`, roughly four queries per investigation,
  with a documented approach and a gate that can prove it correct. It is a deferred decision, not a
  mystery.

## One figure we corrected, and why it is written down

An earlier draft of this page said `residualize` cost 97 seconds. That was a sum over a six-minute
`system.query_log` window containing many runs, not the cost of one investigation, which is ~1.4 s
across 8 queries. The share claim survived the correction — it is still the most expensive stage — but
the absolute did not, and the remaining win is therefore smaller than that number implied. It is
recorded here because a figure quoted once tends to be quoted again.
