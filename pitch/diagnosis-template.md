# What the system says when it finds something

Every number below is real, computed against the loaded 9M rows. Provenance is in
[`incident-dossier.md`](incident-dossier.md).

---

## Two audiences, one source of truth

§1 is plain English, for a person — a revenue manager, a demo, the deck. §2 is the same content with
inline evidence references, for anyone auditing a specific figure. Both render from the same
`Investigation` object the engine emits, so the two views can never drift apart.

|                 | Who reads it                     |
| --------------- | --------------------------------- |
| **§1 Plain**    | Revenue manager, demo, deck        |
| **§2 Receipts** | Anyone auditing a figure           |

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

### "Nothing broke, the mix changed"

> Revenue per view fell 8%, but every segment's price is flat or up. More of our traffic simply came
> from cheaper inventory this week. No action needed.
