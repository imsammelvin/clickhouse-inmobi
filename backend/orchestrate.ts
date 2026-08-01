/**
 * The orchestrator. Stages run in a fixed order, always (D-002).
 *
 * No LLM sits in this control flow. Reproducibility on the unseen incident requires that the same
 * input produces the same investigation every time, and a model choosing the next step destroys
 * that property. The LLM's only job is downstream: narrating the struct this returns.
 */
import { randomUUID } from "node:crypto";
import { Ledger } from "./ledger";
import { METRICS } from "./metrics";
import { detect } from "./stages/detect";
import { decompose } from "./stages/decompose";
import { localize } from "./stages/localize";
import { residualize } from "./stages/residualize";
import { classify } from "./stages/classify";
import type { Finding, Investigation } from "./types";

export interface InvestigateOptions {
  metric: string;
  from: string;
  to: string;
  ledger?: Ledger;
}

export async function investigate(opts: InvestigateOptions): Promise<Investigation> {
  const { metric, from, to } = opts;
  const ledger = opts.ledger ?? new Ledger();
  const traceId = randomUUID();
  const findings: Finding[] = [];
  const ruledOut: Finding[] = [];

  // ---- Stage 0: detect -----------------------------------------------------------------
  ledger.beginStage("detect");
  const det = await detect(ledger, metric, from, to);
  ledger.endStage(det.reason);

  if (!det.anomalous) {
    ledger.endStage(det.reason);
    return {
      request: { metric, from, to },
      primaryChannel: det.baselineDays < 3 ? "no_anomaly" : "no_anomaly",
      headline:
        det.baselineDays < 3
          ? `Cannot call this. ${det.reason}`
          : `No anomaly. ${metric} was ${fmt(det.incidentValue)} against a same-weekday baseline of ` +
            `${fmt(det.baselineMean)} (${det.sigma.toFixed(1)} sigma).`,
      findings: [],
      ruledOut: [
        {
          channel: "seasonality",
          segment: null,
          metric,
          deltaAbs: det.deltaAbs,
          deltaPct: det.deltaPct,
          deltaPp: det.deltaPp,
          revenueImpactUsd: null,
          significanceSigma: det.sigma,
          status: det.baselineDays < 3 ? "cleared_insufficient_data" : "cleared_as_normal",
          evidenceIds: det.evidenceIds,
          note: det.reason,
        },
      ],
      evidence: ledger.all(),
      planSteps: ledger.plan(),
      traceId,
    };
  }

  // ---- Stage 1: decompose --------------------------------------------------------------
  ledger.beginStage("decompose");
  const dec = await decompose(ledger, from, to);
  ledger.endStage(
    dec.driver
      ? `${dec.driver.name} carries ${fmtUsd(dec.driver.revenueEffect)}/day of ${fmtUsd(dec.revenueDelta)}/day.`
      : "no dominant factor",
  );

  // Sweep the driving factor, not the headline metric — that is the point of decomposing first.
  const sweepMetric = det.anomalous && dec.driver && METRICS[dec.driver.name] ? dec.driver.name : metric;

  // ---- Stage 2: localize ---------------------------------------------------------------
  ledger.beginStage("localize");
  const candidates = await localize(ledger, sweepMetric, from, to);
  const raw = candidates.filter((c) =>
    c.deltaPp !== null ? Math.abs(c.deltaPp) >= 1 : Math.abs(c.deltaPct) >= 3,
  );
  ledger.endStage(`${raw.length} segment(s) outside band on a raw ranked sweep.`);

  // ---- Stage 3: residualize ------------------------------------------------------------
  ledger.beginStage("residualize");
  const res = await residualize(ledger, sweepMetric, from, to, candidates);
  ledger.endStage(
    res.uniform
      ? "uniform across all dimensions — no localizable cause"
      : `${raw.length} raw candidate(s) reduced to ${res.causes.length} cause(s); ` +
        `${res.contamination.length} cleared as contamination.`,
  );

  // ---- Stage 4: classify ---------------------------------------------------------------
  ledger.beginStage("classify");
  const cls = await classify(ledger, from, to, res.causes[0] ?? null, dec, res.uniform);
  ledger.endStage(`${cls.channel} — owner: ${cls.owner}`);

  // ---- Stage 5: price ------------------------------------------------------------------
  ledger.beginStage("price");
  const dayCount = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const revPerDay = dec.revenueDelta;
  ledger.record({
    label: "price.revenue_impact_per_day",
    value: Number(revPerDay.toFixed(2)),
    unit: "usd",
    sql: "derived from decompose stage funnel queries",
    window: { from, to },
    filters: {},
  });
  ledger.endStage(`${fmtUsd(revPerDay)}/day over ${dayCount} day(s).`);

  for (const c of res.causes) {
    const causeSqlRef = c.sql;
    ledger.record({
      label: `cause.${c.dimension}.${c.value}.delta`,
      value: Number((c.deltaPp ?? c.deltaPct).toFixed(4)),
      unit: c.deltaPp !== null ? "pp" : "pct",
      sql: causeSqlRef, window: { from, to }, filters: { segment: `${c.dimension}='${c.value}'` },
      segmentSharePct: Number(c.sharePct.toFixed(4)),
    });
    ledger.record({
      label: `cause.${c.dimension}.${c.value}.share_pct`,
      value: Number(c.sharePct.toFixed(4)), unit: "pct",
      sql: causeSqlRef, window: { from, to }, filters: { segment: `${c.dimension}='${c.value}'` },
    });
    findings.push({
      channel: cls.channel,
      segment: { dimension: c.dimension, value: c.value },
      metric: sweepMetric,
      deltaAbs: c.deltaAbs,
      deltaPct: c.deltaPct,
      deltaPp: c.deltaPp,
      revenueImpactUsd: revPerDay,
      significanceSigma: det.sigma,
      status: "found",
      segmentSharePct: c.sharePct,
      evidenceIds: [...det.evidenceIds, ...cls.evidenceIds],
      note: cls.rationale,
    });
  }

  if (res.uniform) {
    findings.push({
      channel: "not_localizable",
      segment: null,
      metric: sweepMetric,
      deltaAbs: det.deltaAbs,
      deltaPct: det.deltaPct,
      deltaPp: det.deltaPp,
      revenueImpactUsd: revPerDay,
      significanceSigma: det.sigma,
      status: "found",
      evidenceIds: det.evidenceIds,
      note: res.uniformNote,
    });
  }

  for (const c of res.contamination) {
    // Both sides of "was X, now Y once the cause is excluded" are claims about the data.
    ledger.record({
      label: `cleared.${c.dimension}.${c.value}.raw`,
      value: Number((c.deltaPp ?? c.deltaPct).toFixed(4)),
      unit: c.deltaPp !== null ? "pp" : "pct",
      sql: c.sql, window: { from, to }, filters: { segment: `${c.dimension}='${c.value}'` },
    });
    ledger.record({
      label: `cleared.${c.dimension}.${c.value}.residual`,
      value: Number((c.residualPp ?? c.residualDelta).toFixed(4)),
      unit: c.residualPp !== null ? "pp" : "pct",
      sql: c.sql, window: { from, to }, filters: { segment: `${c.dimension}='${c.value}'` },
    });
    ruledOut.push({
      channel: cls.channel,
      segment: { dimension: c.dimension, value: c.value },
      metric: sweepMetric,
      deltaAbs: c.deltaAbs,
      deltaPct: c.deltaPct,
      deltaPp: c.deltaPp,
      revenueImpactUsd: null,
      significanceSigma: null,
      status: "cleared_as_contamination",
      residualPp: c.residualPp,
      segmentSharePct: c.sharePct,
      evidenceIds: [],
      note:
        `${fmtDelta(c.deltaPp, c.deltaPct)} on the raw sweep, ` +
        `${fmtDelta(c.residualPp, c.residualDelta)} once ${res.causes[0]?.dimension} = ` +
        `'${res.causes[0]?.value}' is excluded — dilution, not a cause.`,
    });
  }

  if (res.contamination.length) {
    // The renderer prints "N segment(s) cleared as contamination" and "... and M more"; both are
    // claims about how much was checked, which is exactly what criterion 2 asks us to substantiate.
    const SHOWN = 6;
    ledger.record({
      label: "cleared_as_contamination.count",
      value: res.contamination.length, unit: "count",
      sql: res.contamination[0]?.sql ?? "", window: { from, to }, filters: {},
    });
    if (res.contamination.length > SHOWN) {
      ledger.record({
        label: "cleared_as_contamination.not_shown",
        value: res.contamination.length - SHOWN, unit: "count",
        sql: res.contamination[0]?.sql ?? "", window: { from, to }, filters: {},
      });
    }
  }

  for (const chk of cls.cleared) {
    ruledOut.push({
      channel: cls.channel, segment: null, metric: sweepMetric,
      deltaAbs: null, deltaPct: null, deltaPp: null, revenueImpactUsd: null,
      significanceSigma: null, status: "cleared_as_normal", evidenceIds: [],
      note: `${chk.check}: ${chk.detail}`,
    });
  }

  for (const f of dec.factors.filter((f) => !f.isDriver)) {
    ruledOut.push({
      channel: cls.channel, segment: null, metric: f.name,
      deltaAbs: f.incValue - f.baseValue, deltaPct: f.deltaPct, deltaPp: null,
      revenueImpactUsd: f.revenueEffect, significanceSigma: null,
      status: "cleared_as_normal", evidenceIds: [f.evidenceId],
      note: `${f.name} moved ${f.deltaPct.toFixed(1)}%, worth ${fmtUsd(f.revenueEffect)}/day — not the driver.`,
    });
  }

  const cause = res.causes[0];
  const headline = res.uniform
    ? `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to} [${det.evidenceIds[0]}], ` +
      `uniformly across every dimension — no segment is responsible.`
    : cause
      ? `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to}, driven by ` +
        `${cause.dimension} = '${cause.value}' (${fmtDelta(cause.deltaPp, cause.deltaPct)} on ` +
        `${cause.sharePct.toFixed(1)}% of traffic). Worth ${fmtUsd(revPerDay)}/day.`
      : `${metric} moved ${det.deltaPct.toFixed(1)}% but no segment cleared the significance gates.`;

  return {
    request: { metric, from, to },
    primaryChannel: cls.channel,
    headline,
    findings,
    ruledOut,
    evidence: ledger.all(),
    planSteps: ledger.plan(),
    traceId,
  };
}

const fmt = (n: number): string => (Math.abs(n) < 1 ? n.toFixed(4) : n.toFixed(2));
const fmtUsd = (n: number): string => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const fmtDelta = (pp: number | null, pct: number): string =>
  pp !== null ? `${pp >= 0 ? "+" : ""}${pp.toFixed(2)}pp` : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
