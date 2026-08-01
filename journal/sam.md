# sam — session log

## 2026-08-01 · handoff (read this to resume)

**Hackathon:** ClickHouse Click-a-thon, InMobi problem — automated root-cause analyst.
Started 12:00 Aug 1, **code freeze 12:00 Aug 2**. Unseen incident dataset drops mid-window.

**My lane:** Biz (`pitch/`), but I also built `backend/` — the investigation engine. `goal.md` § 6
assigns `backend/` to `loges`; my commits carry `Crosses-lane: loges` and it is unmerged on
`dev/sam/biz-specs`. Other lanes: `clickhouse/` + `scripts/` (samarth), `observability/` + `main.ts`
+ `api/` (MOHANSUNDAR K), Langfuse PoC in `backend/langfuse/` (loges, not wired to the engine).

---

### The three judging criteria — never deviate

1. **Detection & localization accuracy** — found / missed / hallucinated, vs a private answer key.
2. **Explanation trustworthiness** — every number reproducible. *One fabricated figure costs more
   than a missed anomaly.*
3. **Analytical depth in ClickHouse** — drill-down in queries, not in the LLM.

`bun run criteria` is these as a **gate that exits non-zero**. Currently all pass. Run it after
every change.

---

### Commands

```
bun install                      # REQUIRED on fresh clone; OTel deps missing otherwise
bun run criteria                 # the judging gate — run this constantly
bun run explain -- --metric fill_rate --from 2026-06-23 --to 2026-06-25
bun run scan                     # blended + segment sweep across all 35 days
bun run bench -- --compare pitch/bench-baseline.json
bun run serve                    # api on :3000 — /health /ping /ad-events/count only
```

`.env` holds ClickHouse Cloud creds (gitignored). 9M rows live, dictionaries + `ad_events_enriched`
view exist.

---

### Engine architecture (`backend/`)

`detect → decompose → localize → residualize → classify → price`, fixed order, **no LLM in the
control flow**. Every query goes through `Ledger.run`, which records SQL + hash; nothing else
imports the ClickHouse client. `render.ts` produces the text; `grounding.ts` verifies every numeral
in that exact text resolves to an `Evidence` row.

**Residualization is the differentiator.** Rank candidates, exclude the top one, re-sweep; anything
that returns to band was contamination not a cause. On the flagship: 178 candidates → 1 cause, 151
cleared. It can also return **zero** causes (incident B) rather than fabricating one.

---

### The five training incidents (`pitch/incident-dossier.md`)

| | Window | Cause | Product path says |
|---|---|---|---|
| A | Jun 23–25 | `os_version='Android 15'` fill 0.784→0.433 | technical_break, −$21.05/day ✅ |
| B | Jun 21 | none — uniform −44% everywhere | not_localizable ✅ |
| C | Jun 19–22 | `app_category='finance'` eCPM −35% | found, −$13.05/day, **channel wrong** |
| D | Jun 28–30 | fill dip, segment-level | found, **channel wrong** |
| E | weekends | seasonality decoy | platform-normal stated, $1.98 attributed ✅ |

---

### Open items, ranked

1. **C and D classify as `supply_change`** (C was `demand_change`). Unscoped `decompose` over C's
   window makes requests the driver because **Jun 21 sits inside it**. Localization and dollars are
   right, the channel is not. Same window-contamination pattern, one stage over.
2. **Unattended entry point** — `sweep → windows → investigate each`, one command, no human. This
   *is* the unseen-incident submission artifact. Nobody will hand you metric + window on Day 2.
3. **`demand_change` branch has never executed.** Zero advertisers enter or exit the training
   window. Synthesize an advertiser exit, drive it through (2), assert it lands on `demand_change`.
   (2) and (3) are one piece of work; `segment` is now a parameter so it is straightforward.
4. **Plain-English renderer (T-045).** `render.ts` prints `-35.17pp on 9.6% of traffic`; § 1 of
   `pitch/diagnosis-template.md` is the target wording. Presentation only.
5. **BROADCAST the `bun install` drift** before demo morning.

---

### Traps — each of these cost real time

- **`advertiser_id` is empty on unfilled requests.** Advertiser-sliced fill rate is definitionally
  broken. Guarded by `FILLED_ONLY_DIMENSIONS`; do not regress it.
- **Baselines contain prior incidents.** Jun 21's collapse sits in Jun 28's baseline. Use **median +
  MAD**, never mean + stddev. This bit `detect` once and `localize` again later — a mean-based
  baseline made a normal Sunday read +22.9%.
- **Pair dimensions** are synthetic (`region|os_version` = `EU|Android 15`). Rendering them as SQL
  needs `segmentPredicate()` in `types.ts`. Hand-rolling it broke three times.
- **The growth trend is real** (+6.4% over the window). Estimate it from the whole series, never
  from 3–4 baseline points — Theil-Sen on 3 points got hijacked by an outlier and reported +213% at
  427σ.
- **Multiple testing.** Segment sweep runs ~98k tests; at 2.5σ ~1% fire by chance. Segment gates are
  5σ/10%. The more places you look, the higher the bar.
- **A gate never seen red is not known to work.** Force it to fail before trusting it. I shipped a
  vacuous assertion (`!x === false || y`) *inside* the fix for another vacuous gate.
- **Grounding verifies arithmetic, not relevance.** We once answered a CTR question with a fill-rate
  number — every figure real, every figure grounded, sentence still wrong.
- **Scale rule (standing):** every function and query must be written with scale in mind. Bound
  windows, push work into SQL, return only what is needed.

---

### Key decisions (`goal.md` § 11)

- **D-017** residualize, don't just rank.
- **D-018** this is **InMobi's** marketplace view, not an advertiser tool. Buy-side questions out of
  scope. Median advertiser is 116 impressions/day — per-advertiser detection would be noise.
- **D-019** attribute using the **given dataset only**. No calendars, no event/contextual modelling.
  Tested first: vertical↔category affinity does not exist (eCPM 2.4654 vs 2.4721) and there is no
  event structure. Latency, scale and bounded LLM cost are the primary axis.

### Reviewer's standing verdict

> "The analysis engine is better than most of what will be in that room. It refuses to fabricate, it
> de-shadows, it grounds every number." — the gaps have been the *front door*, not the engine.
