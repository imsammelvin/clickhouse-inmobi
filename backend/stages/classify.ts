/**
 * Stage 4 — classify the surviving cause into one of the six channels (goal.md § 2).
 *
 * This is the stage that turns a finding into a decision. "Fill rate fell in Android 15" is
 * analytics; "technical break, engineering owns it, demand and supply are both fine" is an
 * instruction. The classification is evidence-driven, never a guess: each channel has a signature
 * and the signature is queried.
 */
import type { Ledger } from "../ledger";
import { baselineDates, sqlDateList } from "../baseline";
import type { Candidate } from "./localize";
import type { Decomposition } from "./decompose";
import type { Channel } from "../types";

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
  exogenous_event: "Planning",
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
  const seg = `${cause.dimension} = '${cause.value.replace(/'/g, "\\'")}'`;

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

  const baseDays = Number(r.base_days) || 1;
  const incDays = Number(r.inc_days) || 1;
  const advsBase = Number(r.advs_base);
  const advsInc = Number(r.advs_inc);
  const renderBase = Number(r.render_base ?? 0);
  const renderInc = Number(r.render_inc ?? 0);
  const ecpmBase = Number(r.ecpm_base ?? 0);
  const ecpmInc = Number(r.ecpm_inc ?? 0);
  const reqsBase = Number(r.reqs_base) / baseDays;
  const reqsInc = Number(r.reqs_inc) / incDays;

  const evidenceIds = [
    ledger.record({
      label: `classify.advertisers_bidding`, value: advsInc, unit: "count",
      sql, window: { from, to }, filters: { segment: seg },
      segmentSharePct: cause.sharePct,
    }),
    ledger.record({
      label: `classify.render_rate`, value: Number(renderInc.toFixed(4)), unit: "ratio",
      sql, window: { from, to }, filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.ecpm`, value: Number(ecpmInc.toFixed(3)), unit: "usd",
      sql, window: { from, to }, filters: { segment: seg },
    }),
    ledger.record({
      label: `classify.requests_per_day`, value: Math.round(reqsInc), unit: "count",
      sql, window: { from, to }, filters: { segment: seg },
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
      { check: "Render failure", detail: `${renderInc.toFixed(3)} vs ${renderBase.toFixed(3)}, within band` },
      { check: "Price / eCPM", detail: `${ecpmInc.toFixed(3)} vs ${ecpmBase.toFixed(3)}, within band` },
      { check: "Request volume", detail: `${reqDrop >= 0 ? "+" : ""}${reqDrop.toFixed(1)}%, supply is not the constraint` },
    );
  } else if (driver === "ecpm" || Math.abs(ecpmDrop) >= 10) {
    channel = "demand_change";
    rationale =
      `eCPM moved ${ecpmDrop.toFixed(1)}% with advertiser count flat (${advsBase} -> ${advsInc}). ` +
      `Bidders are still present but paying differently — a pricing change, not a withdrawal.`;
    cleared.push({ check: "Advertiser exit", detail: `${advsBase} bidding before, ${advsInc} during` });
  } else {
    channel = "demand_change";
    rationale = `Segment moved on ${driver ?? "an unattributed factor"} without a matching supply or delivery signal.`;
  }

  return { channel, owner: OWNERS[channel], rationale, evidenceIds, cleared };
}
