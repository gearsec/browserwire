/**
 * pipeline/index.js — Stateless training pipeline entry point.
 *
 * Runs the full 5-pass discovery pipeline without any singleton dependencies.
 * All configuration is passed explicitly. No file I/O — the caller decides
 * what to persist and where.
 *
 * Designed for horizontal scaling: each invocation is fully independent.
 *
 * @example
 * import { runPipeline } from "./core/pipeline/index.js";
 *
 * const result = await runPipeline({
 *   recording: { events, snapshots, origin, sessionId },
 *   config: { llmProvider: "openai", llmModel: "gpt-4o", llmApiKey: "sk-..." },
 *   onProgress: ({ phase, tool }) => console.log(phase, tool),
 *   sessionId: "abc-123",
 * });
 * // result = { manifest, segmentation, totalToolCalls, error? }
 */

import { createModel } from "../discovery/ai-provider.js";
import { processRecording } from "../discovery/session-processor.js";
import { initTelemetryFromConfig } from "./telemetry.js";
import { createCoreLogger } from "./logger.js";

/**
 * Run the full discovery pipeline.
 *
 * @param {object} options
 * @param {object} options.recording — session recording (events, snapshots, origin, etc.)
 * @param {object} options.config — LLM + telemetry config
 * @param {string} options.config.llmProvider — "openai" | "anthropic" | "gemini" | "ollama"
 * @param {string} options.config.llmModel — model name
 * @param {string} options.config.llmApiKey — API key
 * @param {string} [options.config.llmBaseUrl] — custom base URL
 * @param {string} [options.config.langsmithApiKey] — LangSmith API key
 * @param {string} [options.config.langsmithProject] — LangSmith project name
 * @param {function} [options.onProgress] — progress callback ({ phase, tool, segmentation })
 * @param {string} [options.sessionId] — session identifier for tracing
 * @returns {Promise<{ manifest: object|null, segmentation: object|null, totalToolCalls: number, error?: string }>}
 */
export async function runPipeline({ recording, config, onProgress, sessionId, logger }) {
  const model = createModel(config);
  const log = createCoreLogger({ logger, sessionId });

  initTelemetryFromConfig(config, log);

  return processRecording({ recording, model, onProgress, sessionId, log });
}
