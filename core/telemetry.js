/**
 * telemetry.js — LangSmith tracing for LangGraph agent observability.
 *
 * LangGraph traces natively to LangSmith when LANGCHAIN_TRACING_V2=true
 * and LANGCHAIN_API_KEY are set. This module reads config and sets env vars.
 *
 * No-op if no API key is configured.
 */

let _initialized = false;

/**
 * Initialize LangSmith telemetry by setting env vars.
 * LangGraph auto-traces all graph executions when these are set.
 *
 * Safe to call multiple times — only sets env vars once.
 */
export async function initTelemetry() {
  if (_initialized === "ok") return true;
  _initialized = "pending";

  let apiKey = process.env.LANGCHAIN_API_KEY || process.env.LANGSMITH_API_KEY;
  let project = process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT;

  try {
    const { getConfig } = await import("./config.js");
    const cfg = getConfig();
    if (cfg.langsmithApiKey) apiKey = cfg.langsmithApiKey;
    if (cfg.langsmithProject) project = cfg.langsmithProject;
  } catch { /* config not loaded yet — use env vars */ }

  if (!apiKey) {
    console.warn("[browserwire] telemetry: no LangSmith API key configured, skipping");
    _initialized = "skipped";
    return false;
  }

  process.env.LANGCHAIN_TRACING_V2 = "true";
  process.env.LANGCHAIN_API_KEY = apiKey;
  if (project) process.env.LANGCHAIN_PROJECT = project;

  _initialized = "ok";
  console.log(`[browserwire] telemetry: LangSmith enabled (project: ${project || "default"})`);
  return true;
}
