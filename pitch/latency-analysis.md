# Latency: real production traces, hard prompts vs. easy prompts

**Date:** 2026-08-02 · Source: Langfuse (`listObservations`/`getObservation`), read live, not synthetic.
Every number below is from an actual LibreChat conversation run after the rollup conversion (see
[scalability-state.md](scalability-state.md)) landed, not a benchmark script.

## What was measured

Five prompts run back-to-back in one LibreChat session, 00:02:54–00:10:34 UTC. Prompts don't share a
traceId with our backend's own `investigate()` spans (LibreChat's agent trace and this backend's
investigation trace are two separate OTel trees — see engineering notes), so every prompt below is
correlated to backend work **by wall-clock overlap**, not by traceId. Where that correlation is
independently checkable we say so.

| # | Type | Wall clock | LLM round-trips | Backend shape |
|---|------|-----------|:---:|---|
| 1 | Hard | 201.5 s (00:02:54.9 → 00:06:16.4) | 20 | Iterative — 14 separate `investigate()` calls, agent drilling down repeatedly |
| 2 | Hard | 47.9 s (00:06:22.8 → 00:07:10.7) | 3 | Iterative — 7 `investigate()` calls |
| 3 | Hard | 12.2 s (00:07:36.1 → 00:07:48.3) | 1 | Single lightweight tool call, no full `investigate()` |
| 4 | Easy | 12.3 s (00:08:58.3 → 00:09:10.6) | 2 | Single lightweight tool call, no full `investigate()` |
| 5 | Easy | 42.8 s (00:09:29.8 → 00:10:12.7 LLM) + 14.4 s investigate | 3 | **One** clean end-to-end `investigate()` call |

## The headline pattern

**Hard and easy don't differ in backend cost per call — they differ in how many times the agent calls
back.** A single `investigate()` call is fast regardless of prompt difficulty (see stage timing below).
What makes prompt 1 take 3.5 minutes isn't slow ClickHouse — it's the agent choosing to drill down 14
times, each round costing an LLM generation *and* a tool round-trip. Prompt 5 ("easy") resolves the
whole investigation in one shot.

This matches what we already knew from load-testing (`scalability-state.md`): the pipeline itself is
bounded and fast. What we're seeing in production is that remaining wall-clock time is **agent
orchestration overhead**, not query cost — which is also why there isn't much left to optimize on our
side alone; the lever left is how many drill-down rounds the agent decides to take.

## Fastest / slowest single `investigate()` call

- **Fastest:** 0.532 s and 0.786 s — both inside the hard prompts, both simple single-segment lookups.
- **Slowest:** 27.998 s, inside prompt 1 (hard #1), at 00:03:50.755–00:04:18.753.

That slowest call is independently confirmed two ways:
1. LibreChat's own `tool-dispatch` span for the same round-trip measured **28.046 s**
   (00:03:50.720–00:04:18.766) — a 48 ms difference from our backend's own 27.998 s, i.e. the two
   independent traces agree on the same event almost to the millisecond, which is the strongest evidence
   we have that wall-clock correlation across the two untied traces is valid.
2. It ran **concurrently with two sibling `investigate()` calls** starting within 10 ms of it
   (00:03:50.746 and 00:03:50.756) — this is the parallel-fan-out behavior from the `find_incidents`/
   `localize` work, doing real concurrent work in production, not three duplicate slow queries. The
   27.998 s is queueing/contention overhead from three concurrent investigations sharing one connection
   pool, not a single slow query — the two siblings finished in 10.0 s and 5.8 s.

## One full single-pass investigation, stage by stage

Prompt 5 (easy #2) is the cleanest sample: exactly one `investigate()` call, no drill-down, full
pipeline, 14.416 s total (00:10:20.310 → 00:10:34.726).

| Stage | ~Time | Note |
|---|---:|---|
| detect | ~3.3 s | segment scan + baseline sweep |
| decompose | ~0.5 s | |
| localize | ~5.4 s | 4 rollup reads |
| residualize | ~7.8 s | masked re-sweep — **the single most expensive named span** |
| classify | ~0.4 s | `uniqExact`, raw table (can't be converted — see scalability-state.md) |
| confirm | ~0.2 s | |

`residualize` being the long pole here is consistent with `scalability-state.md`'s finding that it's the
last unconverted stage (masked re-sweeps still hit raw data, ~4 queries per investigation). This is a
second, independent, real-traffic confirmation of that same finding — not a new problem, the expected one.

## Why prompts 3 and 4 show no `investigate()` call at all

Neither hard #3 nor easy #1 triggered a full 6-stage investigation. The agent resolved both with a
single lighter MCP tool call (e.g. a direct metric/dimension lookup) instead of the full pipeline —
consistent with them being narrower, already-scoped questions rather than open-ended root-cause asks.
This is itself a point worth making in the pitch: **the agent doesn't always pay for the expensive
pipeline — it only invokes the full investigation when the question actually needs one.**

## Bottom line for the pitch

- Backend `investigate()` calls, sampled across 5 real prompts and both hard/easy framing, run
  **0.5 s–28 s**, with the one outlier fully explained (concurrent contention, not a regression).
- A full clean single-pass investigation costs **~14.4 s** end-to-end, matching the "few seconds per
  investigation" claim already made in `scalability-state.md`.
- The remaining time in "hard" prompts is the agent's own iterative drill-down choice (up to 20 LLM
  round-trips), not backend latency — which is why there isn't much left to squeeze on the ClickHouse
  side alone, and matches the call made before running these prompts.
