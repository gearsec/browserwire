/**
 * navigate.js — Snapshot navigation tool for view agents.
 *
 * Allows view agents to switch between snapshots within the same state,
 * so they can inspect different pages/views and ensure extraction code
 * works across all of them.
 */

import { z } from "zod";
import { SnapshotIndex } from "../snapshot/snapshot-index.js";

export const load_snapshot = {
  name: "load_snapshot",
  description:
    "Switch to a different snapshot of the current state. " +
    "Use this to inspect different pages within the same state and verify your extraction code works across them.",
  parameters: z.object({
    snapshot_index: z
      .number()
      .describe("The snapshot index to load (0-based within the current state's snapshots)"),
  }),
  execute: async (ctx, { snapshot_index }) => {
    const snapshots = ctx._stateSnapshots || [];
    if (snapshot_index < 0 || snapshot_index >= snapshots.length) {
      return {
        error: `Invalid snapshot index ${snapshot_index}. Available: 0-${snapshots.length - 1}`,
      };
    }

    const snap = snapshots[snapshot_index];
    if (!snap.rrwebTree) {
      return { error: `Snapshot ${snapshot_index} has no rrweb tree` };
    }

    await ctx.browser.loadSnapshot(snap.rrwebTree, snap.url);

    ctx.index = new SnapshotIndex({
      rrwebSnapshot: snap.rrwebTree,
      browser: ctx.browser,
      screenshot: snap.screenshot || null,
      url: snap.url,
      title: snap.title,
    });
    await ctx.index.enrichWithCDP();

    return { loaded: true, url: snap.url, title: snap.title, index: snapshot_index };
  },
};
