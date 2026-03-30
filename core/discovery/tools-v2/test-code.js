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

/**
 * Execute a code string as a self-contained async function against a Playwright page.
 * The code receives only the Playwright page — no external inputs.
 */
async function executeCode(page, code) {
  try {
    const fn = new Function("page", `return (${code})(page);`);
    const result = await fn(page);
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
 */
function getRecordedTransitionEvents(ctx) {
  const { events, currentSnapshotIndex, snapshots, index } = ctx;

  if (currentSnapshotIndex >= snapshots.length - 1) {
    return [];
  }

  const currentSnapshot = snapshots[currentSnapshotIndex];
  const nextSnapshot = snapshots[currentSnapshotIndex + 1];
  const startIdx = currentSnapshot.eventIndex + 1;
  const endIdx = nextSnapshot.eventIndex;
  const slice = events.slice(startIdx, endIdx);

  const interactions = [];
  for (const event of slice) {
    if (event.type !== EventType.IncrementalSnapshot) continue;
    if (event.data?.source === IncrementalSource.MouseInteraction) {
      interactions.push({
        type: "mouse_interaction",
        interaction_type: event.data.type,
        rrweb_node_id: event.data.id,
        ref: index.rrwebIdToRef?.get(event.data.id) || null,
      });
    } else if (event.data?.source === IncrementalSource.Input) {
      interactions.push({
        type: "input",
        rrweb_node_id: event.data.id,
        ref: index.rrwebIdToRef?.get(event.data.id) || null,
      });
    }
  }
  return interactions;
}

/**
 * Compare generated events from action code against recorded transition events.
 */
function compareEvents(generatedEvents, recordedEvents) {
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
    if (!recordedNodeIds.has(gen.rrweb_node_id)) {
      mismatches.push({
        issue: "generated_not_in_recorded",
        generated: gen,
        note: `Action targeted node ${gen.rrweb_node_id} but user never interacted with this element`,
      });
    }
  }

  for (const rec of recordedEvents) {
    if (!generatedNodeIds.has(rec.rrweb_node_id)) {
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
      "Self-contained Playwright async function: async (page) => { ... }. " +
      "Hardcode any test values directly — e.g. async (page) => { await page.locator('input').fill('test query'); }"
    ),
    expected: z.string().optional().describe(
      "Expected return value as a JSON string. When provided, compares actual vs expected."
    ),
    verify_against_recording: z.boolean().optional().describe(
      "When true, injects rrweb recording, executes code, and compares generated interaction events " +
      "against the recorded forward transition events to verify correct element targeting."
    ),
  }),
  execute: async (ctx, params) => {
    const { code, expected, verify_against_recording } = params;
    const { browser } = ctx;

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

    const execResult = await executeCode(browser.page, code);

    const response = { success: execResult.success };
    if (execResult.success) {
      response.result = execResult.result;
    } else {
      response.error = execResult.error;
    }

    if (expected !== undefined && execResult.success) {
      response.comparison = compareResults(execResult.result, expected);
    }

    if (verify_against_recording) {
      try {
        const generatedEvents = await browser.collectRecordedEvents();
        const recordedEvents = getRecordedTransitionEvents(ctx);
        response.event_verification = compareEvents(generatedEvents, recordedEvents);
      } catch (err) {
        response.event_verification = { error: `Failed to compare events: ${err.message}` };
      }
    }

    return response;
  },
};
