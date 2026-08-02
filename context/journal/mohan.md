# Journal — mohan

**Single-writer, append-only. Only `mohan` writes to this file. Newest entry at the bottom.**

---

### 2026-08-02 — session 1

**Done**

- Audited OpenTelemetry span coverage across the whole post-restructure tree (spans vs. actual work,
  per file), then closed every gap it found. Branch `dev/mohan/otel-coverage-gaps`, 8 commits.
  Full write-up in `context/journal/BROADCAST.md` under today's date — not repeated here.
  - `dashboard-server/server.ts`: SERVER span + W3C propagation + CLIENT span on the Langfuse call
    - flush on SIGINT/SIGTERM.
  - `clickhouse/rollup.ts`: `rollup.plan` / `rollup.ready` spans and a `rollup.plan.decisions`
    counter, with a named reason on every fallback.
  - `mcp/query.ts`: a `query.*` span per op, carrying `servedFrom`.
  - Nine CLI entry points: a root span each, with outcome attributes.
  - `narrate.ts`: `gen_ai.*` attributes on the one real LLM call.
- Replaced `bun run build` (which built one of 28 entry points) with
  `backend/scripts/build.ts` — typecheck, bundle everything derived from `package.json` scripts,
  copy the runtime assets into a mirrored `dist/`.
- Verified against live ClickHouse/ClickStack, not fixtures: `mcp:eval` 16/16 (60/60 gated),
  `criteria` 4/4, `parity` 5/5, `ch:verify-rollup` 283/283, `build` 28/28, and the new span names
  confirmed present in `otel_traces`.

**Half-done — where the loose end is**

- **Nothing is pushed.** The branch is local only. It crosses into Lane A (`backend/`) and Lane B
  (`backend/mcp/`, `backend/clickhouse/`) and edits `package.json`, so per AGENTS.md § 2 it wants
  `needs-review-from: loges` (dashboard, scripts, build) and `samarth` (`rollup.ts`) before merge.
  BROADCAST entry is committed and says so.
- **`dev/mohan/otel-span-coverage` is stranded.** Two commits of span-attribute enrichment
  (`benchmark`, `criteria`, `ledger`, `scan`, `segments`, the five stages, `client`, `collector`,
  `load`, `verify`, `common.utils`) written against pre-restructure paths — `backend/scan.ts`,
  `clickhouse/client.ts`, `utils/`. `main` moved all of them in `eaaa9aa`, so `git rebase` will
  conflict on every file. Next session: either rebase it path-by-path or re-apply the attribute
  additions by hand onto the current tree. Nothing in `dev/mohan/otel-coverage-gaps` overlaps it,
  so the order does not matter.

**Blocked on**

- Nobody. Review is wanted, not required, to keep going.

**Worth knowing next time**

- Span/init ordering in this codebase is load-bearing and easy to get wrong in a way that fails
  silently: a span opened before `initObservability()` binds to the no-op tracer and vanishes, and a
  span still open when `shutdownObservability()` runs is never exported. Several entry points called
  `process.exit()` from inside a `finally`, which does both. The pattern that works is
  init -> `withSpan` -> return an exit code -> flush -> exit once, in `main`.
- `SERVICE_NAME` reads `OTEL_SERVICE_NAME` and defaults to `clickhouse-inmobi-ingest`. Running a
  bundle directly (`bun dist/backend/...`) skips the `package.json` script that sets it, so those
  spans land under `-ingest`. Not a bug, but it will confuse anyone filtering by service.
