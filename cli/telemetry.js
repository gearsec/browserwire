/**
 * telemetry.js — LangSmith tracing via wrapAISDK for agent observability.
 *
 * Wraps Vercel AI SDK functions so every generateText call is automatically
 * traced to LangSmith. No OTel dependencies required.
 *
 * Auto-reads LANGSMITH_API_KEY and LANGSMITH_PROJECT from env.
 * No-op if LANGSMITH_API_KEY is not set.
 */

import * as ai from "ai";

let _generateText = ai.generateText;

export async function initTelemetry() {
  if (!process.env.LANGSMITH_API_KEY) {
    console.warn("[browserwire-cli] telemetry: LANGSMITH_API_KEY not set, skipping");
    return false;
  }
  const { wrapAISDK } = await import("langsmith/experimental/vercel");
  const wrapped = wrapAISDK(ai);
  _generateText = wrapped.generateText;
  return true;
}

export function getGenerateText() {
  return _generateText;
}
