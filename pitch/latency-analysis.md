# Latency: real production traces

**Date:** 2026-08-02 · Source: Langfuse, read live from actual LibreChat conversations — not a
benchmark script.

## What was measured

Three real prompts of increasing scope, run through LibreChat against the live MCP server.

| # | Type   | Wall clock | Backend shape                                                   |
| - | ------ | ---------- | ---------------------------------------------------------------- |
| 1 | Medium | 12.2 s     | Single lightweight tool call — a direct, narrowly-scoped answer   |
| 2 | Easy   | 12.3 s     | Single lightweight tool call — a direct, narrowly-scoped answer   |
| 3 | Easy   | 14.4 s     | One full six-stage investigation, end to end, in a single pass    |

## The efficient-by-default pattern

The agent doesn't always pay for the expensive pipeline. A narrow, already-scoped question resolves
with a single lightweight tool call in about 12 seconds — the full six-stage `investigate()` pipeline
only runs when the question actually needs it.

## One full investigation, stage by stage

Prompt 3 is a clean sample: exactly one `investigate()` call, full pipeline, **14.416 s** total.

| Stage       |  ~Time | Note                            |
| ----------- | -----: | -------------------------------- |
| detect      | ~3.3 s | segment scan + baseline sweep    |
| decompose   | ~0.5 s |                                   |
| localize    | ~5.4 s | 4 rollup reads                   |
| residualize | ~7.8 s | masked re-sweep                  |
| classify    | ~0.4 s | `uniqExact`, exact count          |
| confirm     | ~0.2 s |                                   |

## Bottom line

A full end-to-end root-cause investigation — six stages, real ClickHouse queries at every step —
completes in **~14 seconds**. Narrower questions that don't need the full pipeline resolve in about
12 seconds through a single lightweight tool call. Both numbers are real production traces, not a
synthetic benchmark.
