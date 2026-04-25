/**
 * healing/index.js — Orchestrator for single-step healing.
 *
 * Given an rrweb snapshot of a page and context about a broken step,
 * runs the appropriate agent (transition or view) to produce fixed code.
 *
 * Reuses the same agents and tools as discovery — the only difference is
 * that optional params (existingCode, errorMessage, etc.) are populated,
 * which enriches the agent's prompt with context about the failure.
 */

import { createModel } from "../discovery/ai-provider.js";
import { PlaywrightBrowser } from "../discovery/snapshot/playwright-browser.js";
import { SnapshotIndex } from "../discovery/snapshot/snapshot-index.js";
import { runAgent, runViewAgent } from "../discovery/state-agent.js";
import { resolveTransitionRefs } from "../discovery/tools-v2/transition.js";
import { convertRrwebToTransitionEvents } from "./convert-events.js";
import { initTelemetryFromConfig } from "../pipeline/telemetry.js";

/**
 * Heal a single broken step by running the appropriate agent against
 * an rrweb snapshot of the page where the step failed.
 *
 * @param {object} options
 * @param {object} options.rrwebSnapshot — full rrweb snapshot JSON (the serialized DOM tree)
 * @param {string} [options.screenshot] — base64 screenshot of the page
 * @param {"action"|"view"} options.stepType — which kind of step failed
 * @param {string} options.existingCode — the code that broke
 * @param {string} options.errorMessage — runtime error message
 * @param {string} [options.userPrompt] — optional user-provided context
 * @param {object} [options.actionMeta] — { name, description, inputs } for action steps
 * @param {object} [options.viewMeta] — { name, description } for view steps
 * @param {object} options.stateInfo — { name, url }
 * @param {Array} [options.rrwebEvents] — raw rrweb events from manual action (converted to transitionEvents internally)
 * @param {Array<{code: string, error: string}>} [options.priorAttempts] — prior fix attempts
 * @param {object} options.llmConfig — { llmProvider, llmModel, llmApiKey, llmBaseUrl? }
 * @param {function} [options.onProgress] — progress callback
 * @returns {Promise<{ ok: boolean, code?: string, inputs?: Array, name?: string, description?: string, toolCallCount?: number, error?: string }>}
 */
export async function healStep({
  rrwebSnapshot,
  screenshot,
  stepType,
  existingCode,
  errorMessage,
  userPrompt,
  actionMeta,
  viewMeta,
  stateInfo,
  rrwebEvents,
  priorAttempts,
  llmConfig,
  onProgress,
}) {
  initTelemetryFromConfig(llmConfig);

  const model = createModel(llmConfig);
  if (!model) {
    return { ok: false, error: "Invalid LLM configuration" };
  }

  const browser = new PlaywrightBrowser();

  try {
    // Build SnapshotIndex from the rrweb snapshot (same as discovery)
    const index = new SnapshotIndex({
      rrwebSnapshot,
      browser,
      screenshot: screenshot || null,
      url: stateInfo?.url || "",
    });

    // Enrich with CDP accessibility data (tree is indexed in constructor)
    await index.enrichWithCDP();

    // Build a minimal snapshot marker for the agent
    const snapshotMarker = { url: stateInfo?.url || "" };

    if (stepType === "action") {
      // Convert raw rrweb events from manual action to the format agents expect
      const rawInteractions = rrwebEvents?.length
        ? convertRrwebToTransitionEvents(rrwebEvents)
        : [];
      const transitionEvents = rawInteractions.length
        ? resolveTransitionRefs(rawInteractions, index)
        : [];

      const result = await runAgent({
        index,
        browser,
        events: [],
        snapshots: [snapshotMarker],
        snapshotIndex: 0,
        transitionEvents,
        adjacentContext: null,
        stateInfo,
        eventRange: null,
        transitionData: rawInteractions.length
          ? { interactionEvents: rawInteractions }
          : null,
        model,
        onProgress,
        existingCode,
        errorMessage,
        userPrompt,
        priorAttempts,
      });

      if (result.error) {
        return { ok: false, error: result.error, toolCallCount: result.toolCallCount };
      }

      return {
        ok: true,
        code: result.code,
        inputs: result.inputs,
        name: result.name || actionMeta?.name,
        description: result.description || actionMeta?.description,
        toolCallCount: result.toolCallCount,
      };
    }

    // View step
    const result = await runViewAgent({
      index,
      browser,
      events: [],
      snapshots: [snapshotMarker],
      snapshotIndex: 0,
      stateSnapshots: [snapshotMarker],
      stateInfo,
      model,
      onProgress,
      existingCode,
      errorMessage,
      userPrompt,
      priorAttempts,
    });

    if (result.error) {
      return { ok: false, error: result.error, toolCallCount: result.toolCallCount };
    }

    // View agent returns pendingViews — take the first (or only) submitted view
    const fixedView = result.pendingViews?.[0];
    return {
      ok: true,
      code: fixedView?.code,
      name: fixedView?.name || viewMeta?.name,
      description: fixedView?.description || viewMeta?.description,
      toolCallCount: result.toolCallCount,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}
