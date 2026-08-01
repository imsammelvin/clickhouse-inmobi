/**
 * Registers the Langfuse OTel span processor. Import this before anything else runs
 * (per Langfuse's current JS/TS SDK setup) so every observation is exported.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

export const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});

sdk.start();
