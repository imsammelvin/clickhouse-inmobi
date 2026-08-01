/**
 * Stage 4 — classify the surviving cause into one of the channels (goal.md § 2).
 *
 * This is the stage that turns a finding into a decision. "Fill rate fell in Android 15" is
 * analytics; "technical break, engineering owns it, demand and supply are both fine" is an
 * instruction. The classification is evidence-driven, never a guess: each channel has a signature
 * and the signature is queried.
 */
import type { Ledger } from "../ledger";
import { baselineDates, datesBetween, median, sqlDateList } from "../baseline";
import type { Candidate } from "./localize";
import type { Decomposition } from "./decompose";
import { type Channel, segmentPredicate } from "../types";
import { withSpan } from "../../../shared/utils/telemetryUtils";

export interface Classification {
  channel: Channel;
  owner: string;
  rationale: string;
  evidenceIds: string[];
  /** Checks that were run and came back clean — these become RULED OUT lines. */
  cleared: Array<{ check: string; detail: string }>;
}

interface SignalRow {
  advs_base: string | number;
  advs_inc: string | number;
  render_base: number | null;
  render_inc: number | null;
  ecpm_base: number | null;
  ecpm_inc: number | null;
  reqs_base: string | number;
  reqs_inc: string | number;
  base_days: string | number;
  inc_days: string | number;
}

const OWNERS: Record<Channel, string> = {
  demand_change: "Sales / account management",
  supply_change: "Publisher ops",
  technical_break: "Engineering",
  mix_shift: "Nobody — nothing is broken",
  seasonality: "Nobody — expected pattern",
  not_localizable: "Platform / on-call",
  no_anomaly: "Nobody",
};

/**
 * Probe the cause segment for the four signals that separate the channels:
 * did advertisers leave, did rendering break, did price move, did volume move?
 */
export async function classify(
  ledger: Ledger,
  from: string,
  to: string,
  cause: Candidate | null,
  decomposition: Decomposition,
  uniform: boolean,
): Promise<Classification> {
  return withSpan(
    "stage.classify",
    {
      "app.stage": "classify",
      "app.window.from": from,
      "app.window.to": to,
      "app.classify.cause": cause ? `${cause.dimension}='${cause.value}'` : "none",
      "app.classify.uniform": uniform,
    },
    async (span) => {
      const result = await classifyInner(ledger, from, to, cause, decomposition, uniform);
      // The channel and the owner ARE the output of the pipeline — the thing an operator acts on.
      // On the span they become filterable: "show me every run that ended in technical_break".
      span.setAttributes({
        "app.classify.channel": result.channel,
        "app.classify.owner": result.owner,
        "app.classify.cleared_checks": result.cleared.length,
      });
      return result;
    },
  );
}

async function classifyInner(
  ledger: Ledger,
  from: string,
  to: string,
  cause: Candidate | null,
  decomposition: Decomposition,
  uniform: boolean,
): Promise<Classification> {
  if (uniform) {
    return {
      channel: "not_localizable",
      owner: OWNERS.not_localizable,
      rationale:
        "The move is uniform across every dimension tested, so no segment is responsible. " +
        "This is platform-level, not a segment problem.",
      evidenceIds: [],
      cleared: [
        {
          check: "Any single segment",
          detail: "all tested values moved together within a narrow band",
        },
      ],
    };
  }

  if (!cause) {
    return {
      channel: "no_anomaly",
      owner: OWNERS.no_anomaly,
      rationale: "No segment cleared the significance and size gates.",
      evidenceIds: [],
      cleared: [],
    };
  }

  const base = baselineDates(from, to);
  // Via the shared builder: a pair dimension has to be split back into two columns, and the
  // hand-rolled version here emitted `region|os_version = 'EU|iOS 17.5'`. Third place this bug
  // appeared, which is the argument for there being exactly one function that knows the rule.
  const seg = segmentPredicate(cause.dimension, cause.value);

  const sql = `
SELECT
  uniqExactIf(advertiser_id, is_base AND advertiser_id != '') AS advs_base,
  uniqExactIf(advertiser_id, is_inc  AND advertiser_id != '') AS advs_inc,
  sumIf(is_impression, is_base) / nullIf(sumIf(is_filled, is_base), 0) AS render_base,
  sumIf(is_impression, is_inc)  / nullIf(sumIf(is_filled, is_inc),  0) AS render_inc,
  sumIf(revenue, is_base) / nullIf(sumIf(is_impression, is_base), 0) * 1000 AS ecpm_base,
  sumIf(revenue, is_inc)  / nullIf(sumIf(is_impression, is_inc),  0) * 1000 AS ecpm_inc,
  countIf(is_base) AS reqs_base,
  countIf(is_inc)  AS reqs_inc,
  uniqExactIf(event_date, is_base) AS base_days,
  uniqExactIf(event_date, is_inc)  AS inc_days
FROM (
  SELECT *,
    event_date BETWEEN '${from}' AND '${to}' AS is_inc,
    event_date IN (${sqlDateList(base)})     AS is_base
  FROM ad_events_enriched
  WHERE ${seg}
    AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
)`.trim();

  const [r] = await ledger.run<SignalRow>(sql);
  if (!r) throw new Error("classify: signal query returned no rows");

  /**
   * Distinct advertisers must be counted PER DAY and compared on a per-day centre.
   *
   * `uniqExact` is not additive, so pooling an N-day baseline against a 1-day incident inflates
   * the baseline for free and manufactures an advertiser exit out of nothing. Measured on the
   * seasonality decoy (2026-06-28, segment `region|os_version = 'EU|iOS 17.5'`):
   *
   *     per day   Jun 07: 394   Jun 14: 400   Jun 21: 315   Jun 28: 421
   *     3 baseline Sundays POOLED: 481
   *
   * Jun 28 is the HIGHEST of the four Sundays, yet 421-vs-481 reported "advertisers fell 12%" and
   * classified a perfectly normal weekend as a demand change owned by Sales. Per-day medians give
   * 421 vs 394 -- participation up 7%, no exit.
   *
   * This fires on any narrow segment, which is now the common path since detection gained a
   * segment-level fallback, and it fires on the one channel with a named counterparty.
   */
  const perDay = await ledger.run<{ d: string; advs: string | number; reqs: string | number }>(
    `
SELECT toString(event_date)                        AS d,
       uniqExactIf(advertiser_id, advertiser_id != '') AS advs,
       count()                                     AS reqs
FROM ad_events_enriched
WHERE ${seg}
  AND (event_date BETWEEN '${from}' AND '${to}' OR event_date IN (${sqlDateList(base)}))
GROUP BY d
ORDER BY d`.trim(),
  );
  const incidentDays = new Set(datesBetween(from, to));
  const onDays = (
    want: boolean,
    pick: (x: { advs: string | number; reqs: string | number }) => number,
  ) => perDay.filter((x) => incidentDays.has(x.d) === want).map(pick);
  const advsOf = (x: { advs: string | number }) => Number(x.advs);
  const reqsOf = (x: { reqs: string | number }) => Number(x.reqs);

  const baseDays = Number(r.base_days) || 1;
  const incDays = Number(r.inc_days) || 1;
  const advsBase = Math.round(median(onDays(false, advsOf))) || Number(r.advs_base);
  const advsInc = Math.round(median(onDays(true, advsOf))) || Number(r.advs_inc);
  const renderBase = Number(r.render_base ?? 0);
  const renderInc = Number(r.render_inc ?? 0);
  const ecpmBase = Number(r.ecpm_base ?? 0);
  const ecpmInc = Number(r.ecpm_inc ?? 0);
  // Median per day, for the same reason: a pooled mean puts Jun 21's collapse into every Sunday
  // baseline, which read the decoy's +13% segment move as +27.5% in the rationale -- a number that
  // contradicted the headline in the same response.
  const reqsBase = median(onDays(false, reqsOf)) || Number(r.reqs_base) / baseDays;
  const reqsInc = median(onDays(true, reqsOf)) || Number(r.reqs_inc) / incDays;

  const evidenceIds = [
    ledger.record({
      label: `classify.advertisers_bidding`,
      value: advsInc,
      unit: "count",
      sql,
      window: { from, to },
      filters: { segment: seg },
      segmentSharePct: cause.sharePct,
    }),
    ledger.record({
      label: `classify.render_rate`,
      value: Number(renderInc.toFixed(4)),
      unit: "ratio",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.ecpm`,
      value: Number(ecpmInc.toFixed(3)),
      unit: "usd",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.requests_per_day`,
      value: Math.round(reqsInc),
      unit: "count",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    // Baseline sides are printed too ("2.456 vs 2.473"), so they must be recorded, not just the
    // incident side. Half a comparison is not evidence for the comparison.
    ledger.record({
      label: `classify.advertisers_bidding.baseline`,
      value: advsBase,
      unit: "count",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.render_rate.baseline`,
      value: Number(renderBase.toFixed(4)),
      unit: "ratio",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.ecpm.baseline`,
      value: Number(ecpmBase.toFixed(3)),
      unit: "usd",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.requests_delta_pct`,
      value: Number((reqsBase === 0 ? 0 : ((reqsInc - reqsBase) / reqsBase) * 100).toFixed(4)),
      unit: "pct",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.ecpm_delta_pct`,
      value: Number((ecpmBase === 0 ? 0 : ((ecpmInc - ecpmBase) / ecpmBase) * 100).toFixed(4)),
      unit: "pct",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.render_delta_pp`,
      value: Number(((renderInc - renderBase) * 100).toFixed(4)),
      unit: "pp",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.advertisers_delta_pct`,
      value: Number((advsBase === 0 ? 0 : ((advsInc - advsBase) / advsBase) * 100).toFixed(4)),
      unit: "pct",
      sql,
      window: { from, to },
      filters: { segment: seg },
    }),
  ];

  const pctMove = (a: number, b: number) => (b === 0 ? 0 : ((a - b) / b) * 100);
  const advDrop = pctMove(advsInc, advsBase);
  const renderDrop = (renderInc - renderBase) * 100;
  const ecpmDrop = pctMove(ecpmInc, ecpmBase);
  const reqDrop = pctMove(reqsInc, reqsBase);

  const cleared: Array<{ check: string; detail: string }> = [];
  const driver = decomposition.driver?.name;

  // Order matters: the most specific signature wins. Advertiser exit is checked first because it
  // is the only one with a named, actionable counterparty.
  let channel: Channel;
  let rationale: string;

  if (advDrop <= -10) {
    channel = "demand_change";
    rationale =
      `Advertisers bidding on this segment fell ${Math.abs(advDrop).toFixed(0)}% ` +
      `(${advsBase} -> ${advsInc}). Demand left; supply and delivery are intact.`;
  } else if (driver === "requests" || Math.abs(reqDrop) >= 15) {
    channel = "supply_change";
    rationale =
      `Request volume moved ${reqDrop.toFixed(1)}% while downstream rates held. ` +
      `This is a supply-side change, not a monetisation failure.`;
    cleared.push({ check: "Fill / render / price", detail: "all within band" });
  } else if (renderDrop <= -2) {
    channel = "technical_break";
    rationale = `Render rate fell ${Math.abs(renderDrop).toFixed(1)}pp — fills are not becoming impressions.`;
  } else if (driver === "fill_rate") {
    // Demand present, supply present, rendering fine, but the match stopped happening.
    channel = "technical_break";
    rationale =
      `Fill rate collapsed while all ${advsInc} advertisers kept bidding, render rate held at ` +
      `${renderInc.toFixed(3)}, eCPM held at ${ecpmInc.toFixed(3)} and requests were ` +
      `${reqDrop >= 0 ? "up" : "down"} ${Math.abs(reqDrop).toFixed(1)}%. Demand and supply are ` +
      `both present; the match is failing. That is a delivery fault, not a market event.`;
    cleared.push(
      { check: "Advertiser exit", detail: `${advsBase} bidding before, ${advsInc} during` },
      {
        check: "Render failure",
        detail: `${renderInc.toFixed(3)} vs ${renderBase.toFixed(3)}, within band`,
      },
      {
        check: "Price / eCPM",
        detail: `${ecpmInc.toFixed(3)} vs ${ecpmBase.toFixed(3)}, within band`,
      },
      {
        check: "Request volume",
        detail: `${reqDrop >= 0 ? "+" : ""}${reqDrop.toFixed(1)}%, supply is not the constraint`,
      },
    );
  } else if (driver === "ecpm" || Math.abs(ecpmDrop) >= 10) {
    channel = "demand_change";
    rationale =
      `eCPM moved ${ecpmDrop.toFixed(1)}% with advertiser count flat (${advsBase} -> ${advsInc}). ` +
      `Bidders are still present but paying differently — a pricing change, not a withdrawal.`;
    cleared.push({
      check: "Advertiser exit",
      detail: `${advsBase} bidding before, ${advsInc} during`,
    });
  } else {
    channel = "demand_change";
    rationale = `Segment moved on ${driver ?? "an unattributed factor"} without a matching supply or delivery signal.`;
  }

  return { channel, owner: OWNERS[channel], rationale, evidenceIds, cleared };
}
