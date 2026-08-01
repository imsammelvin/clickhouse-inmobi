/**
 * The orchestrator. Stages run in a fixed order, always (D-002).
 *
 * No LLM sits in this control flow. Reproducibility on the unseen incident requires that the same
 * input produces the same investigation every time, and a model choosing the next step destroys
 * that property. The LLM's only job is downstream: narrating the struct this returns.
 */
import { Ledger } from "./ledger";
import { ensureDatasetBounds } from "./baseline";
import { ensureRollupReady } from "../clickhouse/rollup";
import { METRICS } from "./metrics";
import { detect } from "./stages/detect";
import { decompose } from "./stages/decompose";
import { localize } from "./stages/localize";
import {
  CAUSE_MIN_PLATFORM_PP,
  platformPointsMoved,
  qualifies,
  residualize,
} from "./stages/residualize";
import { classify } from "./stages/classify";
import { clusterWindows, groupIntoIncidents, scanSegments } from "./segments";
import {
  type Finding,
  type Investigation,
  type Mask,
  NO_MASK,
  type Segment,
  segmentMask,
} from "./types";
import { withSpan } from "../../shared/utils/telemetryUtils";

/**
 * T-046 — materiality floor, applied to every confirmed cause regardless of which path found it.
 *
 * "Confirm" (Stage 3b) already checks a segment is significant against its OWN history, but that
 * catches noisy-for-itself segments, not small-but-real ones. Jun 27 is the exhibit: platform
 * revenue itself clears the anomaly gate directly (+4.4%, >2.5 sigma -- no fallback involved), yet
 * the only thing localization finds is `country|ad_format='IN|banner'` moving +9.7% against its own
 * baseline -- clears "confirm" fine -- on just 2.1% of traffic. The product path still named a
 * channel and an owner as if something broke, on what the eval's own ground truth calls the planted
 * seasonality decoy. Incident D's genuine cause sits at 9.8% share, and incidents A/C sit at
 * 9.6%/7.0-7.2% -- 5% cleanly separates every real training incident from this decoy, where dollars
 * do not ($2.13/day vs D's $1.50/day, same order of magnitude).
 *
 * Deliberately keyed on segment SHARE, not on whether the platform itself moved: incident A's cause
 * is itself only 9.6% of traffic on a platform move that clears gates directly, so "the platform
 * moved" cannot be the discriminator -- only materiality can.
 */
export const MIN_MATERIAL_SHARE_PCT = 5;

export interface InvestigateOptions {
  metric: string;
  from: string;
  to: string;
  ledger?: Ledger;
  /**
   * Scope the whole investigation to one segment.
   *
   * Without this there is no way to hand a scan result to the investigator: `scan` would find
   * `app_category='finance'` and `investigate` had no parameter to receive it, so the two halves
   * could not be wired at all. That is the link the unattended run needs, because nobody hands you
   * the segment on the unseen dataset.
   */
  segment?: Segment;
  /** Set internally when Stage 0 selected the segment itself. Not for callers. */
  autoScoped?: boolean;
}

/** Restrict every stage to one segment. Stages already accept a Mask; this just builds one. */
function maskFor(segment: Segment): Mask {
  return segmentMask(segment.dimension, segment.value);
}

/**
 * Root span for one investigation. Every stage span, and every `ledger.run` underneath them, nests
 * inside this one — so a trace in ClickStack is the investigation, top to bottom, in the fixed
 * order D-002 requires. The headline verdict is stamped on the way out.
 */
export async function investigate(opts: InvestigateOptions): Promise<Investigation> {
  return withSpan(
    "investigation",
    {
      "app.metric": opts.metric,
      "app.window.from": opts.from,
      "app.window.to": opts.to,
      "app.segment": opts.segment ? `${opts.segment.dimension}='${opts.segment.value}'` : "none",
      "app.auto_scoped": opts.autoScoped ?? false,
    },
    async (span) => {
      const inv = await investigateInner(opts);
      // `traceId` must be THIS span's actual OTel trace id, not an unrelated identifier -- it is
      // what a caller (API response, CLI output, LibreChat) pastes into Langfuse/ClickStack to open
      // the trace. A random UUID here would satisfy the type but match nothing when searched.
      inv.traceId = span.spanContext().traceId;
      span.setAttributes({
        "app.trace_id": inv.traceId,
        "app.channel": inv.primaryChannel,
        "app.findings": inv.findings.length,
        "app.ruled_out": inv.ruledOut.length,
        "app.evidence": inv.evidence.length,
      });
      return inv;
    },
  );
}

async function investigateInner(opts: InvestigateOptions): Promise<Investigation> {
  const { metric, from, to } = opts;
  const ledger = opts.ledger ?? new Ledger();
  // Overwritten by investigate() above with the real OTel trace id once the root span exists --
  // this function has no span of its own to read it from.
  const traceId = "";
  // Same reason as scanAll: bounds feed WHERE clauses downstream.
  await ensureDatasetBounds((sql) => ledger.run(sql));

  /**
   * Resolve rollup readiness here, for exactly the reason the bounds check is here.
   *
   * `planRollup` refuses to serve anything until the rollup has been proven to account for every
   * event in `ad_events` — an unchecked rollup is treated as an absent one. That check lived only in
   * `Session.ready()` on the MCP path, so `investigate()` reached directly — `bun run explain`,
   * `criteria`, `parity`, any test — left it unresolved and **every stage silently fell back to the
   * raw scan.** Not a wrong answer, but the whole point of T-050 was missing on half the entry
   * points, and it was invisible because the numbers are identical either way.
   *
   * Found by sam's `bun run parity`, which reported `[raw]` while the MCP path was demonstrably
   * rollup-served. That gate exists to catch a rollup that changes a number; it caught a rollup that
   * was not being read at all, which is the failure one layer up.
   */
  await ensureRollupReady((sql) => ledger.run(sql));
  const findings: Finding[] = [];
  const ruledOut: Finding[] = [];

  const scope: Mask = opts.segment ? maskFor(opts.segment) : NO_MASK;

  // ---- Stage 0: detect -----------------------------------------------------------------
  ledger.beginStage("detect");
  let det = await detect(ledger, metric, from, to, scope);
  let scopedTo: Segment | undefined = opts.segment;
  let fallbackNote = "";
  /** Set when the platform metric was normal and only a segment moved. */
  let platformInBand: { pct: number; sigma: number } | undefined;

  // Fall back to the segment sweep when the platform series looks fine.
  //
  // This is the gap between what our own gate measured and what a judge runs. `scan` found
  // incidents C and D at segment level and reported recall 4/4, but `investigate` tested only the
  // blended series and answered "No anomaly. No action." for both. Finance eCPM fell 33% on 7.2%
  // of traffic, which moves the platform number -2.64% against a 3% gate: invisible at the front
  // door however violent underneath. Anything confined to a slice smaller than roughly a third of
  // traffic had the same problem.
  const platformDet = det;
  if (!det.anomalous && !opts.segment && det.baselineDays >= 2) {
    const windows = clusterWindows(
      groupIntoIncidents(await scanSegments(ledger, metric, 0, { from, to })),
    );
    const lead = windows[0]?.lead;
    if (lead) {
      scopedTo = { dimension: lead.dimension, value: lead.value };
      const rescoped = await detect(ledger, metric, from, to, maskFor(scopedTo));
      if (rescoped.anomalous) {
        det = rescoped;
        platformInBand = { pct: platformDet.deltaPct, sigma: platformDet.sigma };
        fallbackNote =
          `platform series in band; segment sweep found ${lead.dimension}='${lead.value}' ` +
          `at ${lead.worstPct.toFixed(1)}% — investigating that. `;
      } else {
        scopedTo = opts.segment;
      }
    }
  }

  // Exactly once, on every path. Ending it both before and inside the early return made `detect`
  // appear twice in every no-anomaly trace - and the seasonality decoy IS a no-anomaly trace, so
  // that duplicate was on screen during the demo beat. Traceability is scored.
  ledger.endStage(fallbackNote + det.reason);

  if (!det.anomalous) {
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
  // The scope is a DETECTION aid only. Localization runs platform-wide.
  //
  // Scoping the sweep too meant a refinement could never lose to its parent. For incident C the
  // segment sweep scopes to `finance|interstitial`, and localize then swept inside that scope where
  // `app_category='finance'` is constant and invisible as a candidate — so `ad_format='interstitial'`
  // became the headline. Measured: finance moves -34.5% on 7.19% of traffic and stays at -33.7%
  // with interstitial removed, while interstitial moves -7.1% and falls to -4.7% with finance
  // removed. Finance is the cause; interstitial is largely its shadow, and we named the shadow.
  //
  // Sweeping platform-wide puts parent and refinement in the same candidate list, ranked on the
  // same platform-relative contribution, so the deflation loop resolves which is which — exactly
  // as it already does for incidents A and B. Pricing follows the same rule: a scoped decompose
  // priced C at the intersection only, understating it roughly fourfold.
  const dec = await decompose(ledger, from, to);
  ledger.endStage(
    dec.driver
      ? `${dec.driver.name} carries ${fmtUsd(dec.driver.revenueEffect)}/day of ${fmtUsd(dec.revenueDelta)}/day.`
      : "no dominant factor",
  );

  // Sweep the driving factor ONLY when the question was about revenue.
  //
  // Decomposing the revenue identity to find which factor moved is exactly right for revenue. It is
  // wrong for every other metric: asked about CTR, this previously swept fill_rate instead and
  // answered "ctr moved -8.7%, driven by os_version='Android 15' (-35.12pp)" — where -35.12pp is a
  // FILL RATE delta. Every number was real and the sentence was still misleading, because it
  // answered a question nobody asked. CTR is not even a factor of the revenue identity; the
  // glossary is explicit that it is a sibling quality signal, not a revenue driver.
  const sweepMetric =
    metric === "revenue" && det.anomalous && dec.driver && METRICS[dec.driver.name]
      ? dec.driver.name
      : metric;

  // ---- Stage 2: localize ---------------------------------------------------------------
  ledger.beginStage("localize");
  const candidates = await localize(ledger, sweepMetric, from, to);
  // Count only candidates that clear the same gate residualize uses. Counting everything past a
  // 1pp wobble inflated this to 818 once app_id was swept, most of them small-sample noise no
  // serious tool would surface — quoting that as "what a naive tool reports" would overstate our
  // own result.
  const platformDelta = platformDet.deltaPp ?? platformDet.deltaPct;
  const raw = candidates.filter((c) => qualifies(c, platformDelta));
  ledger.endStage(`${raw.length} segment(s) outside band on a raw ranked sweep.`);

  // ---- Stage 3: residualize ------------------------------------------------------------
  ledger.beginStage("residualize");
  const res = await residualize(ledger, sweepMetric, from, to, candidates, 4, platformDelta);
  ledger.endStage(
    res.uniform
      ? "uniform across all dimensions — no localizable cause"
      : `${raw.length} raw candidate(s) reduced to ${res.causes.length} cause(s); ` +
          `${res.contamination.length} cleared as contamination.`,
  );

  // ---- Stage 3b: confirm ---------------------------------------------------------------
  //
  // A segment must clear the SAME two gates the platform is held to, against its OWN history.
  //
  // Everything upstream ranks a candidate on the size of its move and its share of traffic. Neither
  // asks the question detection asks of the platform: is this move large relative to what this
  // particular segment normally does? Small segments are naturally noisier, so an absolute
  // threshold quietly holds them to a laxer standard than the platform.
  //
  // That is what kept the seasonality decoy alive. Measured, each against its own same-weekday
  // history:
  //
  //     decoy  region|os_version='EU|iOS 17.5'  requests   +13.0%     1.4 sigma   <- normal
  //     D      os_version='iOS 18.1'            fill_rate  -11.6%   -18.1 sigma
  //     C      app_category='finance'           ecpm       -35.0%   -70.1 sigma
  //     A      os_version='Android 15'          fill_rate  -44.8%   -89.5 sigma
  //
  // A 13x gap between the decoy and the weakest real incident, using MIN_SIGMA = 2.5 -- the gate
  // already in use for platform detection. Nothing here is tuned to make these two land on
  // opposite sides; the decoy fails because +13% on a segment that routinely swings that much is
  // not news. Dollars could never have separated them: the decoy prices at $1.24/day and incident
  // D at $1.50/day, so any dollar floor that silences one silences the other.
  //
  // Cleared segments are reported, not dropped -- "checked and found within its own range" is the
  // ruled-out evidence the rubric asks for.
  ledger.beginStage("confirm");
  const confirmed: typeof res.causes = [];
  const insignificant: Array<{ cause: (typeof res.causes)[number]; sigma: number; pct: number }> =
    [];

  for (const c of res.causes) {
    const segDet = await detect(ledger, sweepMetric, from, to, segmentMask(c.dimension, c.value));
    if (segDet.anomalous) confirmed.push(c);
    else insignificant.push({ cause: c, sigma: segDet.sigma, pct: segDet.deltaPct });
  }

  ledger.endStage(
    `${confirmed.length} of ${res.causes.length} cause(s) significant against their own history; ` +
      `${insignificant.length} within their own normal range.`,
  );

  for (const { cause: c, sigma, pct } of insignificant) {
    ruledOut.push({
      channel: "no_anomaly",
      segment: { dimension: c.dimension, value: c.value },
      metric: sweepMetric,
      deltaAbs: c.deltaAbs,
      deltaPct: c.deltaPct,
      deltaPp: c.deltaPp,
      revenueImpactUsd: null,
      significanceSigma: sigma,
      status: "cleared_as_normal",
      segmentSharePct: c.sharePct,
      evidenceIds: [],
      note:
        `moved ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% but only ${sigma.toFixed(1)} sigma against ` +
        `its own same-weekday history — within this segment's normal range.`,
    });
  }

  /**
   * The segment the deflation loop actually excluded, captured BEFORE the list is rewritten below.
   *
   * `res.contamination` is defined relative to it — "was -6.4pp, is +0.2pp once X is removed" — and
   * every one of those notes read `once undefined = 'undefined' is excluded` the moment confirm
   * cleared the whole cause list, which the materiality gate made an ordinary outcome rather than an
   * impossible one. The residuals were still measured against a real exclusion; only the name was
   * lost, so the fix is to keep the name rather than to suppress the rows.
   */
  const deflatedAgainst = res.causes[0];

  // Replace the cause list with the confirmed one for every downstream stage.
  res.causes.length = 0;
  res.causes.push(...confirmed);

  // T-046 materiality floor (see MIN_MATERIAL_SHARE_PCT doc comment). Applies to every confirmed
  // cause, on every path -- a segment can be statistically real against its own history and still
  // be too small a slice of traffic to call an incident. Filtered causes move to `ruledOut`, each
  // with its numbers recorded as evidence first (the same pattern used for `res.contamination`
  // below) -- printing a number in a note without recording it is exactly the "grounding" failure
  // this codebase is built to prevent.
  //
  // Two ways to be material, and a cause needs only ONE of them. T-046's share floor is the first:
  // a slice under 5% of traffic is not an incident however loudly it moves. The second is the
  // platform points it accounts for, |deltaPct| x share — see CAUSE_MIN_PLATFORM_PP.
  //
  // OR, not AND, and the distinction decides Day-2 misses. Both tests reject the decoy
  // (`country|ad_format='IN|banner'`, 2.1% share, 0.22pp) and both accept all four training
  // incidents, so on everything measured they agree and the choice looks free. It is not: ANDing
  // them takes the stricter of the two everywhere, which throws away the case the second test
  // exists for — a narrow, violent segment. A 3%-share slice collapsing 50% moves 1.5pp of the
  // platform, more than incident D's real cause does, and a bare share floor would file it as
  // noise. The unseen slice is a fresh draw from the same universe; nothing promises its planted
  // anomalies sit on the same 7-10% slices ours happened to.
  const isMaterial = (c: (typeof res.causes)[number]): boolean =>
    c.sharePct >= MIN_MATERIAL_SHARE_PCT || platformPointsMoved(c) >= CAUSE_MIN_PLATFORM_PP;
  const material = res.causes.filter(isMaterial);
  const immaterial = res.causes.filter((c) => !isMaterial(c));
  for (const c of immaterial) {
    ledger.record({
      label: `immaterial.${c.dimension}.${c.value}.delta`,
      value: Number((c.deltaPp ?? c.deltaPct).toFixed(4)),
      unit: c.deltaPp !== null ? "pp" : "pct",
      sql: c.sql,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
    });
    ledger.record({
      label: `immaterial.${c.dimension}.${c.value}.share_pct`,
      value: Number(c.sharePct.toFixed(4)),
      unit: "pct",
      sql: c.sql,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
    });
    // The second test's figure. A cause is dropped only when BOTH fail, so a note quoting the share
    // alone states half the reason -- and the half it omits is the one that answers "so what".
    ledger.record({
      label: `immaterial.${c.dimension}.${c.value}.platform_pp`,
      value: Number(platformPointsMoved(c).toFixed(4)),
      unit: "pp",
      sql: c.sql,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
    });
    ruledOut.push({
      channel: "no_anomaly",
      segment: { dimension: c.dimension, value: c.value },
      metric: sweepMetric,
      deltaAbs: c.deltaAbs,
      deltaPct: c.deltaPct,
      deltaPp: c.deltaPp,
      revenueImpactUsd: null,
      significanceSigma: null,
      status: "cleared_as_normal",
      segmentSharePct: c.sharePct,
      evidenceIds: [],
      note:
        `moved ${fmtDelta(c.deltaPp, c.deltaPct)} against its own history, but on only ` +
        `${c.sharePct.toFixed(2)}% of traffic, accounting for ` +
        `${platformPointsMoved(c).toFixed(2)}pp of the platform metric — too small a slice to call ` +
        `an incident (floor: ${MIN_MATERIAL_SHARE_PCT}% of traffic or ` +
        `${CAUSE_MIN_PLATFORM_PP.toFixed(2)}pp of the metric).`,
    });
  }
  // Distinct from `noCause` below: this is specifically "found something, but it doesn't matter",
  // never "found nothing" -- so it must not borrow platformInBand's meaning, only its outcome.
  const filteredForMateriality = immaterial.length > 0;
  if (filteredForMateriality) {
    // The floor itself is printed (ruledOut note, and the headline below) -- configuration, not
    // measurement, but printed numerals must resolve regardless, same as detect.ts's own gates.
    ledger.record({
      label: "gate.min_material_share_pct",
      value: MIN_MATERIAL_SHARE_PCT,
      unit: "pct",
      sql: "configuration: backend/orchestrate.ts MIN_MATERIAL_SHARE_PCT",
      window: { from, to },
      filters: {},
    });
    ledger.record({
      label: "gate.cause_min_platform_pp",
      value: CAUSE_MIN_PLATFORM_PP,
      unit: "pp",
      sql: "configuration: backend/stages/residualize.ts CAUSE_MIN_PLATFORM_PP",
      window: { from, to },
      filters: {},
    });
  }
  res.causes.length = 0;
  res.causes.push(...material);

  // ---- Stage 4: classify + price -------------------------------------------------------
  //
  // Both run off the SAME decomposition, scoped to the cause.
  //
  // Pricing the cause was already right: the platform-wide delta charged incident C -$49.47/day
  // because its window (Jun 19-22) contains Jun 21, the global volume collapse — finance was being
  // billed for an unrelated incident.
  //
  // Classification had the mirror-image bug and it survived that fix, because `classify` was still
  // handed the PLATFORM decomposition. Incident D is a 10pp fill collapse on iOS 18.1, but
  // platform requests grew +5.3% over its window (the dataset's own growth trend), so the
  // platform driver is `requests` and a technical break was labelled `supply_change` and routed to
  // Publisher ops. A segment-level finding has to be classified on the segment's own funnel, not
  // on what the rest of the platform was doing around it.
  const causeSegment = res.causes[0];
  const causeMask = causeSegment ? segmentMask(causeSegment.dimension, causeSegment.value) : null;
  const scoped = causeMask ? await decompose(ledger, from, to, causeMask) : dec;

  ledger.beginStage("classify");
  const cls = await classify(ledger, from, to, causeSegment ?? null, scoped, res.uniform);
  ledger.endStage(`${cls.channel} — owner: ${cls.owner}`);

  ledger.beginStage("price");
  const dayCount = Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1);
  const priced = scoped;
  const revPerDay = priced.revenueDelta;
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
      sql: causeSqlRef,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
      segmentSharePct: Number(c.sharePct.toFixed(4)),
    });
    ledger.record({
      label: `cause.${c.dimension}.${c.value}.share_pct`,
      value: Number(c.sharePct.toFixed(4)),
      unit: "pct",
      sql: causeSqlRef,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
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
      sql: c.sql,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
    });
    ledger.record({
      label: `cleared.${c.dimension}.${c.value}.residual`,
      value: Number((c.residualPp ?? c.residualDelta).toFixed(4)),
      unit: c.residualPp !== null ? "pp" : "pct",
      sql: c.sql,
      window: { from, to },
      filters: { segment: `${c.dimension}='${c.value}'` },
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
        `${fmtDelta(c.residualPp, c.residualDelta)} once ${deflatedAgainst?.dimension} = ` +
        `'${deflatedAgainst?.value}' is excluded — dilution, not a cause.`,
    });
  }

  if (res.contamination.length) {
    // The renderer prints "N segment(s) cleared as contamination" and "... and M more"; both are
    // claims about how much was checked, which is exactly what criterion 2 asks us to substantiate.
    const SHOWN = 6;
    ledger.record({
      label: "cleared_as_contamination.count",
      value: res.contamination.length,
      unit: "count",
      sql: res.contamination[0]?.sql ?? "",
      window: { from, to },
      filters: {},
    });
    if (res.contamination.length > SHOWN) {
      ledger.record({
        label: "cleared_as_contamination.not_shown",
        value: res.contamination.length - SHOWN,
        unit: "count",
        sql: res.contamination[0]?.sql ?? "",
        window: { from, to },
        filters: {},
      });
    }
  }

  for (const chk of cls.cleared) {
    ruledOut.push({
      channel: cls.channel,
      segment: null,
      metric: sweepMetric,
      deltaAbs: null,
      deltaPct: null,
      deltaPp: null,
      revenueImpactUsd: null,
      significanceSigma: null,
      status: "cleared_as_normal",
      evidenceIds: [],
      note: `${chk.check}: ${chk.detail}`,
    });
  }

  for (const f of dec.factors.filter((f) => !f.isDriver)) {
    ruledOut.push({
      channel: cls.channel,
      segment: null,
      metric: f.name,
      deltaAbs: f.incValue - f.baseValue,
      deltaPct: f.deltaPct,
      deltaPp: null,
      revenueImpactUsd: f.revenueEffect,
      significanceSigma: null,
      status: "cleared_as_normal",
      evidenceIds: [f.evidenceId],
      note: `${f.name} moved ${f.deltaPct.toFixed(1)}%, worth ${fmtUsd(f.revenueEffect)}/day — not the driver.`,
    });
  }

  const cause = res.causes[0];
  const scopeNote = platformInBand
    ? `Platform ${metric} was normal (${platformInBand.pct >= 0 ? "+" : ""}${platformInBand.pct.toFixed(1)}%, ` +
      `${platformInBand.sigma.toFixed(1)} sigma, within band). Below it, `
    : "";

  /**
   * A segment-level headline quotes the SEGMENT's numbers, never the scope's.
   *
   * `det.deltaPct` is the move of whatever narrow scope the segment sweep fired on, while `cause`
   * is found platform-wide -- since localization was correctly unscoped, those are two different
   * populations. Joining them with "driven by" produced sentences like:
   *
   *     "fill_rate moved -49.5% ... driven by os_version = 'iOS 18.1' (-9.99pp on 9.8%)"
   *
   * -9.99pp on a 0.785 base is -12.6%, not -49.5%. Every figure resolves to evidence and the
   * sentence is still false, because the two halves describe different segments. That is the same
   * failure as answering a CTR question with a fill-rate delta: grounding checks arithmetic, not
   * relevance, so only the sentence construction can prevent it.
   */
  const headline = res.uniform
    ? `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to} [${det.evidenceIds[0]}], ` +
      `uniformly across every dimension — no segment is responsible.`
    : cause
      ? platformInBand
        ? `${cause.dimension} = '${cause.value}' moved ` +
          `${fmtDelta(cause.deltaPp, cause.deltaPct)} on ${cause.sharePct.toFixed(1)}% of traffic ` +
          `over ${from}..${to}. Worth ${fmtUsd(revPerDay)}/day.`
        : `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to}, driven by ` +
          `${cause.dimension} = '${cause.value}' (${fmtDelta(cause.deltaPp, cause.deltaPct)} on ` +
          `${cause.sharePct.toFixed(1)}% of traffic). Worth ${fmtUsd(revPerDay)}/day.`
      : platformInBand
        ? `no segment moved beyond its own normal range.`
        : // Two different reasons for "nothing to report", and they are not interchangeable.
          // Materiality is checked first because it is the more specific statement: we found a
          // segment, measured it, and it was too small to matter. Flooring is the weaker claim —
          // the platform move itself was never established. Saying the second when the first is
          // true would drop the fact that something was actually found and dismissed.
          filteredForMateriality
          ? `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to}, but the only segment ` +
            `that cleared significance was too small a slice of traffic to call an incident ` +
            `(floor: ${MIN_MATERIAL_SHARE_PCT}%).`
          : platformDet.spreadFloored
            ? `${metric} moved ${det.deltaPct.toFixed(1)}% over ${from}..${to}, but its baseline is ` +
              `too stable to measure a spread against, so that move is not established as abnormal ` +
              `— and no segment moved enough of the platform to explain it.`
            : `${metric} moved ${det.deltaPct.toFixed(1)}% but no segment cleared the significance gates.`;

  // Nothing survived Stage 3b, so there is no cause to own. What that MEANS depends entirely on
  // whether the platform itself moved.
  //
  //   platform inside its own band -> nothing happened. "No action." This is the decoy's path.
  //   platform genuinely moved      -> something happened and we could not attribute it. That is
  //                                    `not_localizable`, and it is owned by platform/on-call.
  //
  // Collapsing both into `no_anomaly` reported ctr on 2026-06-23 -- a real -8.8% platform move --
  // as "No action.", which is a miss dressed as an all-clear. Failing to localize is not the same
  // as finding nothing, and only one of the two is safe to stay quiet about.
  const noCause = !res.uniform && res.causes.length === 0;
  /**
   * A third route to "no action", alongside `platformInBand` and T-046's materiality filter.
   *
   * `not_localizable` is a real verdict with a real owner (platform / on-call), and it is correct
   * when the platform demonstrably moved — ctr on 2026-06-23 fell 8.8% at 7.1 sigma against a
   * MEASURED spread, and staying quiet about that would be a miss dressed as an all-clear.
   *
   * But when the spread was floored, sigma restated the size gate instead of corroborating it (see
   * detect.ts `spreadFloored`), so "the platform moved abnormally" was never actually established —
   * one gate passed twice. The only thing that could still make it real is a segment big enough to
   * have caused it, and `noCause` says there is none. Escalating on that pair is how 2026-06-27,
   * a normal Saturday at +4.4%, became a paged supply_change owned by Publisher ops.
   *
   * This and `filteredForMateriality` catch that Saturday by different routes and neither subsumes
   * the other: materiality fires when a segment was found and dismissed, this fires when the
   * platform move was never credible to begin with — including when localization returns nothing at
   * all and there is no segment to dismiss.
   *
   * Deliberately narrow: it needs BOTH a floored spread AND nothing material underneath. A floored
   * detection with a real cause (incident A is floored at the platform level) still reports its
   * cause, and an unfloored move with no cause is still `not_localizable`.
   */
  const unestablished = noCause && platformDet.spreadFloored;
  const channel = noCause
    ? platformInBand || filteredForMateriality || unestablished
      ? "no_anomaly"
      : "not_localizable"
    : cls.channel;

  if (platformInBand) {
    // The platform verdict is itself a finding, and it is the one that keeps the seasonality decoy
    // honest: reporting a segment move as though the platform had moved is how a "no action" day
    // turns into a false alarm.
    ruledOut.unshift({
      channel: "no_anomaly",
      segment: null,
      metric,
      deltaAbs: null,
      deltaPct: platformInBand.pct,
      deltaPp: null,
      revenueImpactUsd: null,
      significanceSigma: platformInBand.sigma,
      status: "cleared_as_normal",
      evidenceIds: [],
      note:
        `Platform ${metric}: ${platformInBand.pct >= 0 ? "+" : ""}${platformInBand.pct.toFixed(1)}% ` +
        `at ${platformInBand.sigma.toFixed(1)} sigma — within band. This is a segment-level finding only.`,
    });
  }

  return {
    request: { metric, from, to },
    primaryChannel: channel,
    headline: scopeNote + headline,
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
  pp !== null
    ? `${pp >= 0 ? "+" : ""}${pp.toFixed(2)}pp`
    : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
