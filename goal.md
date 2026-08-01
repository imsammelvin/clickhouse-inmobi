# Goal — what we are building

> **Status: SKELETON.** Fill this in together at kickoff, in one sitting, before anyone writes code.
> Every `_TBD_` must be resolved before Milestone M1 starts. Sections marked **LOCKED** must not be
> changed by a single person — see [AGENTS.md](AGENTS.md) § Changing this file.

---

## 1. One-liner  **LOCKED**

_TBD_ — one sentence, plain language, no jargon. "We are building X so that Y can Z."

## 2. The problem

_TBD_ — What is painful today? Who feels it? Be concrete; name a real workflow that is slow,
expensive, or impossible right now.

## 3. Why ClickHouse

_TBD_ — What specifically about ClickHouse makes this possible? Columnar scans, materialized views,
`AggregatingMergeTree`, `JOIN` performance, S3 table engine, sparse indexes, TTL, real-time inserts?
If the answer is "we just need a database," the idea is not a ClickHouse hackathon project yet.

## 4. The demo we will give  **LOCKED**

Write the demo **first** and build backwards from it. Judges see the demo, not the repo.

- **Duration:** _TBD_ minutes
- **The "wow" moment:** _TBD_ — the single screen/number/interaction that makes someone lean in.
- **Beat-by-beat:**
  1. _TBD_
  2. _TBD_
  3. _TBD_
- **Fallback if live fails:** _TBD_ (recorded video? seeded local dataset? screenshots?)

## 5. Scope

### In scope (we will build this)
- _TBD_
- _TBD_

### Out of scope (we will deliberately NOT build this)
- _TBD_
- _TBD_

> Anything not listed under "In scope" needs a decision-log entry (§ 11) before someone starts on it.

## 6. Architecture

```
_TBD_ — ASCII diagram. Boxes and arrows. Keep it to one screen.

  [ source ] --> [ ingest ] --> [ ClickHouse ] --> [ API ] --> [ UI ]
```

| Component | What it does | Tech | Lane owner | Directory |
|---|---|---|---|---|
| _TBD_ | _TBD_ | _TBD_ | Lane A | `_TBD_/` |
| _TBD_ | _TBD_ | _TBD_ | Lane B | `_TBD_/` |
| _TBD_ | _TBD_ | _TBD_ | Lane C | `_TBD_/` |
| _TBD_ | _TBD_ | _TBD_ | Lane D | `_TBD_/` |

Lane owners are assigned in [AGENTS.md](AGENTS.md) § Lanes and ownership. Directory boundaries here
are the **source of truth for who may edit what** — keep them disjoint.

## 7. Data model  **LOCKED**

The schema is the contract between all four lanes. Change it only via § 11 + a heads-up commit.

- **Dataset / source:** _TBD_ (URL, size, row count, license)
- **Primary table(s):** _TBD_
- **Engine + `ORDER BY`:** _TBD_ — this is the single most important perf decision; justify it.
- **Materialized views / projections:** _TBD_
- **Canonical DDL lives at:** `_TBD_/schema.sql` — one file, one owner, everyone else reads it.

## 8. Interfaces between lanes  **LOCKED**

Agree these early so the four lanes can build in parallel against stubs instead of blocking.

| Contract | Producer | Consumer | Shape / where defined |
|---|---|---|---|
| _TBD_ | Lane _ | Lane _ | `_TBD_` |
| _TBD_ | Lane _ | Lane _ | `_TBD_` |

Rule: **mock the other side, never wait for it.** If a contract is defined, you are unblocked.

## 9. Milestones

Timebox hard. When a box expires, ship what exists and move on.

| ID | Milestone | Definition of done | Deadline |
|---|---|---|---|
| M0 | Kickoff | This file has zero `_TBD_`; lanes assigned; repo scaffolded; everyone can run ClickHouse locally | _TBD_ |
| M1 | Data in | Real data loaded, canonical query returns correct results | _TBD_ |
| M2 | Vertical slice | One path works end-to-end, ugly but real | _TBD_ |
| M3 | Feature complete | Everything in § 5 "In scope" exists | _TBD_ |
| M4 | Demo-ready | Demo rehearsed twice, fallback recorded, README written | _TBD_ |
| M5 | Freeze | No merges to `main` except demo-blocking fixes | _TBD_ |

## 10. Success criteria

How we know we won, in measurable terms.

- [ ] _TBD_ — e.g. "p95 query latency under 200 ms on N rows"
- [ ] _TBD_ — e.g. "ingests N events/sec sustained"
- [ ] _TBD_ — e.g. "demo runs start-to-finish with no manual intervention"

## 11. Decision log

Append-only. Newest at the bottom. One line per decision. Never edit or delete someone else's row.

| Date | Decision | Why | Decided by |
|---|---|---|---|
| _TBD_ | _TBD_ | _TBD_ | _TBD_ |

## 12. Risks

| Risk | Likelihood | Blast radius | Mitigation | Owner |
|---|---|---|---|---|
| _TBD_ | _TBD_ | _TBD_ | _TBD_ | _TBD_ |
