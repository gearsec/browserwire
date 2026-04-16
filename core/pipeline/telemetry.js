/**
 * telemetry.js — Config-based LangSmith telemetry initialization.
 *
 * Sets process.env vars from an explicit config object instead of
 * reading from the config singleton. Safe for per-worker initialization
 * in k8s — each process gets its own env.
 *
 * Idempotent: calling multiple times with the same config is a no-op.
 */

let _initialized = false;

/**
 * Initialize LangSmith telemetry from an explicit config object.
 *
 * @param {{ langsmithApiKey?: string, langsmithProject?: string }} config
 * @returns {boolean} true if telemetry was enabled
 */
export function initTelemetryFromConfig(config, log) {
  if (_initialized) return _initialized === "ok";

  const apiKey = config.langsmithApiKey || process.env.LANGCHAIN_API_KEY || process.env.LANGSMITH_API_KEY;
  const project = config.langsmithProject || process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT;

  if (!apiKey) {
    _initialized = "skipped";
    return false;
  }

  process.env.LANGCHAIN_TRACING_V2 = "true";
  process.env.LANGCHAIN_API_KEY = apiKey;
  if (project) process.env.LANGCHAIN_PROJECT = project;

  _initialized = "ok";
  if (log) log.info(`pipeline telemetry: LangSmith enabled (project: ${project || "default"})`);
  else console.log(`[browserwire] pipeline telemetry: LangSmith enabled (project: ${project || "default"})`);
  return true;
}
