/**
 * Standalone proof-of-concept: exercises the full trace shape (Stage 0-6, root span + child
 * observations + a narration generation) against mock investigation data, with no ClickHouse
 * engine behind it yet. Once the real orchestrator exists, swap MOCK_* for its actual stage
 * outputs -- the Langfuse calls themselves don't change.
 *
 * Run: bun run langfuse:trace
 */
import { assertLangfuseEnv, NarrationEnvVar } from "./env";
assertLangfuseEnv();

import { sdk } from "./instrumentation";
import { startObservation } from "@langfuse/tracing";
import Anthropic from "@anthropic-ai/sdk";

const MOCK_DETECTION = {
  metric: "revenue",
  time_window: "2026-06-18 14:00-15:00",
  baseline_avg: 48200,
  current: 42400,
  delta_pct: -12.0,
  flagged: true,
};

const MOCK_BASELINE = {
  expected: 48200,
  actual: 42400,
  deviation_pct: -12.0,
  seasonality_checked: true,
  seasonality_explains_it: false,
};

const MOCK_ATTRIBUTION = {
  requests: { baseline: 210000, current: 208500, verdict: "normal" },
  fill_rate: { baseline: 0.62, current: 0.51, verdict: "degraded" },
  ecpm: { baseline: 3.7, current: 3.7, verdict: "normal" },
};

const MOCK_DIMENSION_EXPLORER = {
  checked: [
    { dimension: "region", segment: "APAC", delta_pct: -1.1, anomalous: false },
    { dimension: "device_model", segment: "Pixel 7", delta_pct: -1.4, anomalous: false },
    { dimension: "os_version", segment: "Android 14", delta_pct: -22.3, anomalous: true },
  ],
};

const MOCK_SIGNIFICANCE_GATE = {
  passed: [{ segment: "Android 14", requests: 18400, required_n: 385 }],
  ruled_out: [{ segment: "Android 12 / IN", reason: "insufficient volume", requests: 62 }],
};

const MOCK_RANKING = {
  root_cause: { dimension: "os_version", segment: "Android 14" },
  contribution_pct: 82,
  confidence_pct: 96,
  ruled_out: ["seasonality", "requests", "eCPM", "region", "device_model"],
};

const NARRATION_MODEL = "claude-haiku-4-5-20251001";

async function narrate(
  input: object,
): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env[NarrationEnvVar.DeepseekApiKey];
  if (!apiKey) {
    const text =
      "[stub narration -- set DEEPSEEK_API_KEY to generate this for real] " +
      "Revenue fell 12% in the 14:00-15:00 window, driven almost entirely by a fill-rate drop " +
      "concentrated in Android 14 devices, contributing 82% of the decline. Requests, eCPM, " +
      "region, and device model were checked and ruled out.";
    return { text, inputTokens: 0, outputTokens: 0 };
  }
  const anthropic = new Anthropic({ apiKey });
  const message = await anthropic.messages.create({
    model: NARRATION_MODEL,
    max_tokens: 300,
    system:
      "You narrate ad-metrics incident investigations. You may only state numbers that appear " +
      "verbatim in the input JSON. If a number is not in the input, do not mention it.",
    messages: [{ role: "user", content: JSON.stringify(input) }],
  });
  const block = message.content[0];
  return {
    text: block?.type === "text" ? block.text : "",
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
}

async function main() {
  const investigation = startObservation(
    "investigation",
    {
      input: { trigger: "self-detected", metric: MOCK_DETECTION.metric },
      metadata: { mock: true, note: "no engine wired yet -- data is fabricated" },
    },
    { asType: "span" },
  );

  investigation
    .startObservation(
      "detection-sweep",
      { input: {}, output: MOCK_DETECTION },
      { asType: "retriever" },
    )
    .end();

  investigation
    .startObservation(
      "baseline-analyzer",
      { input: MOCK_DETECTION, output: MOCK_BASELINE },
      { asType: "tool" },
    )
    .end();

  investigation
    .startObservation(
      "metric-attribution",
      { input: MOCK_BASELINE, output: MOCK_ATTRIBUTION },
      { asType: "retriever" },
    )
    .end();

  investigation
    .startObservation(
      "dimension-explorer",
      { input: MOCK_ATTRIBUTION, output: MOCK_DIMENSION_EXPLORER },
      { asType: "retriever" },
    )
    .end();

  investigation
    .startObservation(
      "significance-gate",
      { input: MOCK_DIMENSION_EXPLORER, output: MOCK_SIGNIFICANCE_GATE },
      { asType: "tool" },
    )
    .end();

  investigation
    .startObservation(
      "contribution-ranking",
      { input: MOCK_SIGNIFICANCE_GATE, output: MOCK_RANKING },
      { asType: "tool" },
    )
    .end();

  const hasRealNarration = Boolean(process.env[NarrationEnvVar.DeepseekApiKey]);
  const generation = investigation.startObservation(
    "narration",
    { input: MOCK_RANKING, model: hasRealNarration ? NARRATION_MODEL : "stub" },
    { asType: "generation" },
  );
  const { text, inputTokens, outputTokens } = await narrate(MOCK_RANKING);
  generation
    .update({ output: text, usageDetails: { input: inputTokens, output: outputTokens } })
    .end();

  investigation.update({ output: text }).end();

  await sdk.shutdown();
  console.log("Trace sent. Open your Langfuse project dashboard to view it.");
  console.log("\nNarration:\n" + text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
