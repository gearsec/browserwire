/**
 * navigate.js — Snapshot navigation tool for intent-driven agents.
 *
 * Allows the agent to switch between snapshots in the recording,
 * reloading the browser DOM and rebuilding the SnapshotIndex.
 * This enables intent-driven agents to process multiple snapshots
 * end-to-end for a single API intent.
 */

import { z } from "zod";
import { SnapshotIndex } from "../snapshot/snapshot-index.js";

export const navigate_to_snapshot = {
  name: "navigate_to_snapshot",
  description:
    "Load a different snapshot into the browser. All subsequent tool calls " +
    "(view_screenshot, get_accessibility_tree, inspect_element, get_transition_events, test_code) " +
    "will operate on the new snapshot. Use this to navigate through the recording " +
    "to find pages relevant to your intent.",
  parameters: z.object({
    snapshot_index: z
      .number()
      .describe("1-based snapshot number to navigate to (e.g., 1 for the first snapshot)"),
  }),
  execute: async (ctx, { snapshot_index }) => {
    const idx = snapshot_index - 1; // convert to 0-based

    if (idx < 0 || idx >= ctx.snapshots.length) {
      return {
        error: `Invalid snapshot index: ${snapshot_index}. Valid range: 1-${ctx.snapshots.length}`,
      };
    }

    if (idx === ctx.currentSnapshotIndex) {
      const snapshot = ctx.snapshots[idx];
      return {
        note: `Already on snapshot #${snapshot_index}`,
        url: snapshot.url,
        title: snapshot.title,
      };
    }

    const snapshot = ctx.snapshots[idx];

    if (!snapshot.rrwebTree) {
      return { error: `Snapshot #${snapshot_index} has no rrwebTree` };
    }

    // Reload the browser with the new snapshot's DOM
    try {
      await ctx.browser.loadSnapshot(snapshot.rrwebTree, snapshot.url);
    } catch (err) {
      return { error: `Failed to load snapshot #${snapshot_index}: ${err.message}` };
    }

    // Rebuild the SnapshotIndex
    const newIndex = new SnapshotIndex({
      rrwebSnapshot: snapshot.rrwebTree,
      browser: ctx.browser,
      screenshot: snapshot.screenshot || null,
      url: snapshot.url,
      title: snapshot.title,
    });

    try {
      await newIndex.enrichWithCDP();
    } catch (err) {
      return { error: `Failed to enrich snapshot #${snapshot_index}: ${err.message}` };
    }

    // Mutate context — all tools will now operate on the new snapshot
    ctx.index = newIndex;
    ctx.currentSnapshotIndex = idx;

    const isTerminal = idx >= ctx.snapshots.length - 1;

    return {
      navigated: true,
      snapshot_index: snapshot_index,
      url: snapshot.url,
      title: snapshot.title,
      is_terminal: isTerminal,
    };
  },
};
