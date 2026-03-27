/**
 * test-code.js — Code execution and testing tool.
 *
 * Executes a Playwright code snippet against the replayed DOM.
 * Three modes:
 *   1. Just run: execute code, return result or error
 *   2. Compare output: execute code, compare actual vs expected
 *   3. Verify against recording: inject rrweb.record(), execute code,
 *      capture generated events, compare target node IDs against
 *      the recorded forward transition events.
 *
 * The code is an async function body: async (page, inputs) => { ... }
 * It receives the real Playwright Page object and can use any Playwright API.
 */

import { z } from "zod";
import { EventType, IncrementalSource } from "../../recording/rrweb-constants.js";

/**
 * Execute a code string as an async function against a Playwright page.
 *
 * The code string is expected to be a full async function expression:
 *   "async (page, inputs) => { ... }"
 *
 * We eval it to get the function reference, then invoke it with the
 * real Playwright page object and inputs.
 */
async function executeCode(page, code, inputs) {
  try {
    const fn = new Function("page", "inputs", `
      return (${code})(page, inputs);
    `);
    const result = await fn(page, inputs || {});
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Compare actual result against expected, producing a structured diff.
 */
function compareResults(actual, expected) {
  if (expected === undefined || expected === null) {
    return { matched: true };
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
 * These are the events the user actually performed to leave this state.
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
 * Matches by rrweb node ID — the action must target the same elements
 * the user actually interacted with.
 */
function compareEvents(generatedEvents, recordedEvents) {
  if (recordedEvents.length === 0) {
    return {
      matched: generatedEvents.length === 0,
      note: generatedEvents.length > 0
        ? "No recorded transition events to compare against (terminal state or no forward transition)"
        : undefined,
    };
  }

  // Build a set of recorded target node IDs for quick lookup
  const recordedNodeIds = new Set(recordedEvents.map((e) => e.rrweb_node_id));
  const generatedNodeIds = new Set(generatedEvents.map((e) => e.rrweb_node_id));

  const mismatches = [];

  // Check each generated event has a matching recorded target
  for (const gen of generatedEvents) {
    if (!recordedNodeIds.has(gen.rrweb_node_id)) {
      mismatches.push({
        issue: "generated_not_in_recorded",
        generated: gen,
        note: `Action targeted node ${gen.rrweb_node_id} but user never interacted with this element`,
      });
    }
  }

  // Check each recorded event was targeted by the generated code
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
    "Execute a Playwright code snippet against the replayed DOM at this snapshot. " +
    "The code must be an async function: async (page, inputs) => { ... }. " +
    "Use 'expected' to compare the output against expected values (returns actual vs expected diff). " +
    "Use 'verify_against_recording' to check that the code targets the same elements " +
    "the user actually interacted with in the recorded session — the tool injects rrweb " +
    "recording, runs the code, captures the generated events, and compares target node IDs " +
    "against the recorded forward transition events.",
  parameters: z.object({
    code: z.string().describe("Playwright async function: async (page, inputs) => { ... }"),
    inputs: z.record(z.any()).optional().describe("Input values passed to the function"),
    expected: z.any().optional().describe("Expected return value. When provided, compares actual vs expected."),
    verify_against_recording: z.boolean().optional().describe(
      "When true, injects rrweb recording, executes code, captures generated interaction events, " +
      "and compares target element IDs against the recorded forward transition events."
    ),
  }),
  execute: async (ctx, params) => {
    const { code, inputs, expected, verify_against_recording } = params;
    const { browser } = ctx;

    if (!browser?.page) {
      return { success: false, error: "No Playwright page available" };
    }

    // If verifying against recording, start rrweb recording before executing code
    if (verify_against_recording) {
      try {
        await browser.startRecording();
      } catch (err) {
        return { success: false, error: `Failed to start rrweb recording: ${err.message}` };
      }
    }

    // Execute the code
    const execResult = await executeCode(browser.page, code, inputs);

    const response = { success: execResult.success };

    if (execResult.success) {
      response.result = execResult.result;
    } else {
      response.error = execResult.error;
    }

    // Compare against expected if provided
    if (expected !== undefined && execResult.success) {
      response.comparison = compareResults(execResult.result, expected);
    }

    // Verify against recorded events if requested
    if (verify_against_recording) {
      try {
        const generatedEvents = await browser.collectRecordedEvents();
        const recordedEvents = getRecordedTransitionEvents(ctx);
        response.event_verification = compareEvents(generatedEvents, recordedEvents);
      } catch (err) {
        response.event_verification = { error: `Failed to collect/compare events: ${err.message}` };
      }
    }

    return response;
  },
};
