# Demo video — script

**Target: 2 min 45 s.** Spoken words only are in the **> blockquotes** — read those and nothing else.
Everything in `[brackets]` is a screen action, not something to say.

Written to be read aloud: short sentences, no clauses to get lost in, no number you have to
pronounce awkwardly. Every figure in it is one the system actually prints — if a take goes wrong,
re-record rather than paraphrase, because the numbers are the point.

---

## Before you record

1. **Redeploy the demo box from current `main`.** The Anomalies tab is the centrepiece and it is
   currently dropping the connection there (~12 s, stale build without the rollup). Verify:
   `curl -s -o /dev/null -w "%{http_code} %{time_total}\n" http://161.97.122.198:4500/api/anomalies`
   — you want `200` in about a second.
2. Open three tabs: Mission Control, a terminal, and LibreChat.
3. In the terminal, pre-type the `explain` command but **do not run it** — you run it on camera.
4. Anomalies tab: set the range to **23 – 25 June** before you start, so the incident is on screen.
5. Screen recording at 1080p or better. The table text has to be legible.

---

## 0:00 – 0:18 · What it is

`[Mission Control, Anomalies tab, already loaded]`

> An ad marketplace has thousands of segments. When revenue drops, somebody spends the morning
> slicing dashboards to find out why. This does it in about a second, and it shows its work.
>
> Every number you are about to see was computed in ClickHouse. The language model never touches the
> data.

---

## 0:18 – 0:45 · Detection

`[Point at the Anomalies table. Hover the fill_rate row for 23–25 June.]`

> It sweeps every metric, every day, against a same-weekday baseline — Saturdays against Saturdays,
> because this marketplace has a hard weekly cycle.
>
> And it uses the median, never the mean. An incident sitting in your baseline inflates the standard
> deviation and hides the very thing you are looking for. The median does not move.
>
> Here it has flagged fill rate, 23 to 25 June.

---

## 0:45 – 1:35 · The investigation, and the part we are proudest of

`[Switch to terminal. Run it live:]`

```bash
bun run explain -- --metric fill_rate --from 2026-06-23 --to 2026-06-25 --plain
```

> One command, and this is the whole investigation running against nine million rows.

`[Output appears. Point at each part as you say it.]`

> Between the 23rd and the 25th we filled 75 percent of ad requests instead of the usual 79. That is
> about twenty dollars and fifty cents a day.
>
> The cause is Android 15. Their fill rate fell from 78 percent to 43 percent, and they are about one
> in every ten requests.
>
> Now the part that matters. When one segment breaks, everything containing it looks broken too.
> Europe looks broken. Galaxy A54 looks broken. A naive drill-down blames all of them.
>
> So we remove the cause's contribution and measure everything again. Here that clears **840 slices**
> — checked, and explicitly ruled out, each with its residual as proof.
>
> It doesn't just say what broke. It says what it checked and dismissed.

---

## 1:35 – 2:05 · Why you can trust it

`[Scroll to the "is something broken, or is it the market?" section.]`

> It also separates a technical break from a market shift. Advertisers did not leave — 500 bidding
> before, 498 during. Render rate held. Price held. So this is engineering's problem, not sales'.
>
> And every number there is checked. A grounding pass re-reads the finished text and maps each
> numeral back to the query that produced it. If one can't be traced to a recorded row, the answer
> fails.
>
> The model only writes the sentence. It cannot query the database — there is no SQL tool to call,
> and our tests fail the build if anyone adds one.

---

## 2:05 – 2:30 · Chat and the unattended path

`[LibreChat. Type: "Was the 23 to 25 June revenue dip a volume problem or a price problem?"]`

> Follow-ups go through LibreChat over MCP, using the same thirteen tools — so a conversational
> answer carries the same evidence.

`[Switch to the Alerts tab.]`

> And it runs unattended. A scheduled sweep found this one while nobody was watching, with the full
> diagnosis already attached.

---

## 2:30 – 2:45 · Close

`[Mission Control, wide shot.]`

> ClickHouse Cloud does the analysis, on materialized views. ClickStack traces every stage down to
> the SQL. Langfuse tracks what the model costs.
>
> Deterministic code finds the answer. The model reads it out. That is the whole idea.

---

## If you need to cut to 2:00

Drop the **Chat and the unattended path** section entirely, and cut the baseline explanation at 0:18
to one line: _"The engine sweeps every metric, every day, against a same-weekday baseline."_ The
residualization beat at 0:45 is the one thing that must survive — it is what separates this from a
dashboard with a threshold on it.

## Numbers, and where they come from

Say them exactly as written. All are printed by the command you run on camera, except the last two.

| Said                     | Source                                          |
| ------------------------ | ----------------------------------------------- |
| 75% instead of usual 79% | `explain` output, line 1                        |
| $20.54 a day             | `explain` output, line 2                        |
| 78% → 43%                | `explain` output, WHY section                   |
| ~1 in 10 requests        | `explain` output, WHY section (9.6% of traffic) |
| 840 slices cleared       | `inv.ruledOut.length` for this window           |
| 500 bidding → 498        | `explain` output, advertiser-exit check         |
| nine million rows        | `SELECT count() FROM ad_events` → 9,000,000     |
| thirteen tools           | `bun run sanity -- --only mcp:handshake`        |
