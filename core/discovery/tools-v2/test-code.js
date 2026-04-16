/**
 * test-code.js — Code execution and testing tool.
 *
 * Executes a Playwright code snippet against the replayed DOM.
 * The code is a self-contained async function: async (page) => { ... }
 * For testing actions, the agent writes self-contained test code with
 * hardcoded sample values rather than parameterized inputs.
 *
 * Three modes:
 *   1. Just run: execute code, return result or error
 *   2. Compare output (expected): execute and compare actual vs expected JSON
 *   3. Verify against recording: inject rrweb.record(), execute, compare
 *      generated event target IDs against recorded transition events
 */

import { z } from "zod";
import { EventType, IncrementalSource } from "../../recording/rrweb-constants.js";
import { resolveTransitionRefs } from "./transition.js";

/**
 * Execute a code string as a self-contained async function against a Playwright page.
 * The code receives only the Playwright page — no external inputs.
 */
async function executeCode(page, code, inputs) {
  try {
    const fn = new Function("page", "inputs", `return (${code})(page, inputs);`);
    const result = await fn(page, inputs || {});
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Compare actual result against expected JSON string, producing a structured diff.
 */
function compareResults(actual, expectedJson) {
  let expected;
  try {
    expected = JSON.parse(expectedJson);
  } catch {
    return { matched: false, error: `expected is not valid JSON: ${expectedJson}` };
  }

  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);

  if (actualStr === expectedStr) {
    return { matched: true };
  }

  if (Array.isArray(actual) && Array.isArray(expected)) {
    const mismatches = [];
    const len = Math.max(actual.length, expected.length);
    for (let i = 0; i < len; i++) {
      if (JSON.stringify(actual[i]) !== JSON.stringify(expected[i])) {
        mismatches.push({
          index: i,
          actual: actual[i] ?? "(missing)",
          expected: expected[i] ?? "(missing)",
        });
      }
    }
    return { matched: false, mismatches };
  }

  if (typeof actual === "object" && typeof expected === "object" && actual && expected) {
    const mismatches = [];
    const allKeys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
    for (const key of allKeys) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) {
        mismatches.push({
          key,
          actual: actual[key] ?? "(missing)",
          expected: expected[key] ?? "(missing)",
        });
      }
    }
    return { matched: false, mismatches };
  }

  return { matched: false, actual, expected };
}

/**
 * Get recorded forward transition interaction events for comparison.
 * Uses pre-computed events from segmentation (single source of truth).
 */
function getRecordedTransitionEvents(ctx) {
  if (ctx.transitionData?.interactionEvents) {
    return resolveTransitionRefs(ctx.transitionData.interactionEvents, ctx.index);
  }
  return [];
}

/**
 * Check if generatedId is a descendant of recordedId in the DOM tree.
 * One-way only: the generated event must target the same node or a more
 * specific child of the recorded node. This handles shadow DOM where
 * rrweb records at the shadow host but Playwright targets the inner element.
 */
function isDescendantOf(generatedId, recordedId, index) {
  if (!index?.rrwebIdToRef) return false;
  const ref = index.rrwebIdToRef.get(generatedId);
  if (!ref) return false;

  let current = index.getNode(ref);
  for (let i = 0; i < 10 && current; i++) {
    if (current.rrwebId === recordedId) return true;
    current = current.parentRef ? index.getNode(current.parentRef) : null;
  }
  return false;
}

/**
 * Compare generated events from action code against recorded transition events.
 * Uses ancestor-aware matching: a generated event on a descendant of a recorded
 * node is considered a match (handles shadow DOM / web component boundaries).
 */
function compareEvents(generatedEvents, recordedEvents, index) {
  if (recordedEvents.length === 0) {
    return {
      matched: generatedEvents.length === 0,
      note: generatedEvents.length > 0
        ? "No recorded transition events (terminal state or no forward transition)"
        : undefined,
    };
  }

  const recordedNodeIds = new Set(recordedEvents.map((e) => e.rrweb_node_id));
  const generatedNodeIds = new Set(generatedEvents.map((e) => e.rrweb_node_id));
  const mismatches = [];

  for (const gen of generatedEvents) {
    const exactMatch = recordedNodeIds.has(gen.rrweb_node_id);
    const descendantMatch = !exactMatch && index && recordedEvents.some(
      (rec) => isDescendantOf(gen.rrweb_node_id, rec.rrweb_node_id, index)
    );
    if (!exactMatch && !descendantMatch) {
      mismatches.push({
        issue: "generated_not_in_recorded",
        generated: gen,
        note: `Action targeted node ${gen.rrweb_node_id} but user never interacted with this element`,
      });
    }
  }

  for (const rec of recordedEvents) {
    const exactMatch = generatedNodeIds.has(rec.rrweb_node_id);
    const descendantMatch = !exactMatch && index && generatedEvents.some(
      (gen) => isDescendantOf(gen.rrweb_node_id, rec.rrweb_node_id, index)
    );
    if (!exactMatch && !descendantMatch) {
      mismatches.push({
        issue: "recorded_not_in_generated",
        recorded: rec,
        note: `User interacted with node ${rec.rrweb_node_id} (ref: ${rec.ref}) but action code didn't target it`,
      });
    }
  }

  return {
    matched: mismatches.length === 0,
    generated_count: generatedEvents.length,
    recorded_count: recordedEvents.length,
    mismatches: mismatches.length > 0 ? mismatches : undefined,
  };
}

export const test_code = {
  name: "test_code",
  description:
    "Execute a self-contained Playwright code snippet against the replayed DOM. " +
    "The code must be: async (page) => { ... } — it receives only the Playwright page. " +
    "For testing actions with inputs, hardcode sample values directly in the code. " +
    "Use 'expected' (JSON string) to verify structure — e.g. check field names exist and are non-empty. Do NOT use expected to match specific dynamic content (post titles, IDs, timestamps) as these change. " +
    "Use 'verify_against_recording' to verify the code targets the same elements the user interacted with.",
  parameters: z.object({
    code: z.string().describe(
      "Playwright async function. For transitions, use the FINAL parameterized version: " +
      "async (page, inputs) => { await page.locator('input').fill(inputs.city); } " +
      "and pass sample values via the inputs parameter."
    ),
    inputs: z.string().optional().describe(
      "Sample input values as a JSON string, e.g. {\"city\": \"test\"}. Parsed and passed to code as (code)(page, inputs)."
    ),
    expected: z.string().optional().describe(
      "Expected return value as a JSON string. When provided, compares actual vs expected."
    ),
    verify_against_recording: z.boolean().optional().describe(
      "When true, injects rrweb recording, executes code, and compares generated interaction events " +
      "against the recorded forward transition events to verify correct element targeting."
    ),
    target_refs: z.array(z.string()).optional().describe(
      "When provided with verify_against_recording, filters recorded events to only those matching these element refs. " +
      "Use this for per-field form actions so each action is verified against its specific rrweb event(s), " +
      "not all transition events. Get refs from get_transition_events output."
    ),
  }),
  execute: async (ctx, params) => {
    const { code, inputs: sampleInputsRaw, expected, verify_against_recording, target_refs } = params;
    let sampleInputs;
    try { sampleInputs = sampleInputsRaw ? JSON.parse(sampleInputsRaw) : {}; } catch { sampleInputs = {}; }
    const { browser } = ctx;

    // Reject [href="..."] selectors — they pass on replayed DOM (absolute URLs)
    // but fail on live sites (relative paths)
    const HREF_SELECTOR_RE = /\[href[\s]*[~|^$*]?=/i;
    if (HREF_SELECTOR_RE.test(code)) {
      return {
        success: false,
        error: 'Code contains [href="..."] CSS selector which fails at runtime (replayed DOM resolves absolute URLs, live sites use relative paths). Use role/text selectors instead: page.getByRole(\'link\', { name: \'...\' }) or page.locator(\'a\', { hasText: \'...\' })',
      };
    }

    if (!browser?.page) {
      return { success: false, error: "No Playwright page available" };
    }

    // Short timeout — the DOM is static, missing elements should fail fast
    browser.page.setDefaultTimeout(500);

    if (verify_against_recording) {
      try {
        await browser.startRecording();
      } catch (err) {
        return { success: false, error: `Failed to start rrweb recording: ${err.message}` };
      }
    }

    const execResult = await executeCode(browser.page, code, sampleInputs);

    const response = { success: execResult.success };
    if (execResult.success) {
      response.result = execResult.result;
    } else {
      response.error = execResult.error;
    }

    // Store last successfully tested code for done() to use
    if (execResult.success) {
      ctx._lastTestedCode = code;
    }

    if (expected !== undefined && execResult.success) {
      response.comparison = compareResults(execResult.result, expected);
    }

    if (verify_against_recording) {
      try {
        const generatedEvents = await browser.collectRecordedEvents();
        let recordedEvents = getRecordedTransitionEvents(ctx);
        // When target_refs is provided, filter recorded events to only those
        // matching the specified refs — enables per-field form action verification
        if (target_refs?.length > 0) {
          const refSet = new Set(target_refs);
          recordedEvents = recordedEvents.filter((e) => refSet.has(e.ref));
        }
        response.event_verification = compareEvents(generatedEvents, recordedEvents, ctx.index);
      } catch (err) {
        response.event_verification = { error: `Failed to compare events: ${err.message}` };
      }
    }

    return response;
  },
};
