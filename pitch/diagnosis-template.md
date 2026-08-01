# What the system says when it finds something

**Task:** T-026 · **Owner:** sam · **Date:** 2026-08-01
**Spec for T-019 (narration) and T-023 (LibreChat rendering).**

Every number below is real, computed against the loaded 9M rows. Provenance is in
[`incident-dossier.md`](incident-dossier.md). If you change the shape here, tell Lane A and Lane D.

---

## Human first. The rest comes later.

This document previously tried to serve a human and a verifier at once, which is why it read badly
for both — reference marks like `[e7]` are essential for checking and pure noise for reading.

**§1 is the one that matters now.** Plain English, for a person. Build to that.

§2 (the tagged version) and the LLM narrator are the same content re-rendered, and they only become
relevant when we wire the narrator in. Both read from the one `Investigation` object the engine
already emits, so they cannot drift from §1 or from each other — which is exactly why deferring
them costs nothing.

|                 | Who reads it                     | When                            |
| --------------- | -------------------------------- | ------------------------------- |
| **§1 Plain**    | Revenue manager, demo, deck      | **Now**                         |
| **§2 Receipts** | Judges, anyone auditing a figure | When the narrator lands (T-019) |

> ⚠ **What we actually print today is neither.** `backend/render.ts` emits something in between —
> `-35.17pp on 9.6% of traffic`, `0.7837` — readable to us, not to a revenue manager. Writing the
> §1 renderer is the next piece of work, and it is presentation only: no engine change, and the
> grounding check keeps working because it verifies whatever string we print.

---

## 1. The plain version

The flagship incident, in the words we would actually use:

```
WHAT HAPPENED
  Between 23 and 25 June we filled 75% of ad requests instead of the
  usual 78.5%. That is worth about $18 a day.

WHY
  Phones running Android 15 stopped getting ads.
  Their fill rate fell from 78% to 43%.
  They are about 1 in every 10 requests we receive.

IS SOMETHING BROKEN, OR IS IT THE MARKET?
  Something is broken. This one is for engineering, not sales:

    - All 500 advertisers were still bidding. Nobody walked away.
    - Ads that did get filled still displayed fine (97.9%, normal).
    - Prices were normal: $2.46 per thousand views, against $2.47.
    - We actually received 4.3% MORE traffic than usual.

  Buyers were there. Inventory was there. The system simply failed to
  put the two together, and only on Android 15.

WHAT WE CHECKED AND RULED OUT
  At first glance 178 different slices looked broken - Europe down 5.5
  points, tier-1 publishers down 3.9, banner ads down 3.7.

  None of them were. When we took Android 15 phones out of the numbers
  and looked again, every one of those slices was normal. They only
  looked broken because Android 15 phones sit inside all of them.

  One real cause. 151 false leads eliminated.
```

**That last block is the product.** Anyone can show a chart going down and say "Europe is down".
Saying _"Europe looked down, here is the arithmetic showing it wasn't, and here is the one thing
that was"_ is what nobody else will have.

---

## 2. The same answer, with receipts

Identical facts. Every figure carries a tag resolving to a stored number and its SQL, so any single
claim can be verified without rerunning the pipeline.

```
Fill rate 0.7500 over 2026-06-23..06-25, down 3.50pp [e1] from a 0.7850
same-weekday baseline [e2]. A -4.4% move [e3] at -8.7 sigma [e4],
worth -$18/day [e5].

CAUSE
  os_version = 'Android 15'
  fill rate 0.7837 -> 0.4333 [e6], -35.04pp, on 9.6% of requests [e7]

CHANNEL: technical_break        OWNER: engineering
  advertisers bidding  500 -> 500      [e8]   no demand loss
  render rate          0.980 -> 0.979  [e9]   delivery healthy
  eCPM                 2.473 -> 2.456  [e10]  price healthy
  requests             +4.3%           [e11]  supply healthy

RULED OUT
  region = 'EU'             -5.50pp raw -> -0.07pp once the cause is excluded [e12]
  publisher_tier = 'tier_1' -3.89pp raw -> +0.01pp once the cause is excluded [e13]
  149 further segments      all within +/-0.24pp once excluded                [e14]
```

---

## 3. Rules for the plain version

A busy person must understand it in one read.

- **Money before mechanism.** "$18 a day" before "fill rate".
- **Percentages, never ratios.** "75%", not "0.750".
- **No jargon without its meaning attached.** Not "render rate 0.979" — "ads that were filled still
  displayed fine (97.9%)". Not "9.6% share" — "about 1 in every 10 requests".
- **Sidestep the pp-vs-% trap.** Say "down 3.5 points, from 78.5% to 75%" and show both numbers.
- **Name the owner, not the channel.** "One for engineering, not sales" beats `technical_break`.
- **Name segments the way the data does** — `Android 15`, not "newer Android phones". Someone has to
  be able to filter on it.
- **Never say "probably".** If we cleared it, say cleared and show the residual. If we couldn't, it
  is a second cause, not a hedge.
- **Always say what it is worth.** A 35-point collapse on 0.2% of traffic is not an incident.

## 4. Rules for the receipts version

- **Every numeral carries a tag.** No tag, no numeral — `bun run criteria` rejects the response
  otherwise, and it checks the exact text we print.
- **Both sides of a comparison are recorded.** "2.456 vs 2.473" needs two stored numbers; half a
  comparison is not evidence for the comparison.
- **Segment names are excluded from checking.** `'Galaxy A54'` is an identifier, not a measurement.
  Leaving them in caused a false _pass_, where `'Android 15'` matched an unrelated value.

---

## 5. The other four things it can say

Worked numbers for each are in [`incident-dossier.md`](incident-dossier.md).

### "Nothing in particular is broken" — Jun 21, when 44% of traffic vanished

> Requests fell 44% on 21 June. But every slice fell by the same amount — every country, every
> device, every app category, all between 42% and 46%. Nothing is specifically wrong; the whole
> platform was down. Do not go hunting for a culprit. The worst-looking slice, Brazil at −46%, is
> not the cause — it is just the noisiest number in a uniform drop.

This one matters: a tool obliged to name a top segment would have blamed Brazil.

### "This is normal, ignore it" — the weekend decoy

> No anomaly. Sunday 28 June had 233,943 requests against a Sunday baseline of 220,775 — 6% up,
> well inside normal. Weekends are always quieter than weekdays; measured against other Sundays
> this is unremarkable.

### "I do not have enough history to answer"

> Cannot call this. There are only 2 comparable prior weeks and the baseline needs 3. No diagnosis
> offered — widen the window, or ask again once more data exists.

A refusal is a legitimate answer. Dressing one up as a finding is how tools lose trust.

### "Nothing broke, the mix changed" — supported, no training case (see T-031)

> Revenue per view fell 8%, but every segment's price is flat or up. More of our traffic simply came
> from cheaper inventory this week. No action needed.

---

## 6. What Lane A needs from this

1. `Finding.channel` needs a **`not_localizable`** value. §5's first case is one of five real
   training incidents, not an edge case.
2. `Finding.status` needs **`cleared_as_contamination`**, distinct from `cleared_as_normal`. The
   "178 looked broken, 151 weren't" line depends entirely on that distinction.
3. Every `Evidence` row needs `segmentSharePct`. "−35 points" is meaningless without "on 1 in 10
   requests".
4. The narrator must be able to emit **zero** findings and still produce §5 output. An empty result
   is frequently the correct answer.
