/**
 * schema.js — Zod schemas for the session recording.
 *
 * The session recording is the source of truth for a browsing session.
 * It contains a continuous rrweb event stream and snapshot markers that
 * identify state boundaries within the stream.
 *
 * rrweb event types captured:
 *   - Meta (type=4), FullSnapshot (type=2), DomContentLoaded (type=0), Load (type=1)
 *   - IncrementalSnapshot (type=3) sources:
 *     Mutation(0), MouseInteraction(2), Input(5), StyleSheetRule(8), StyleDeclaration(13)
 *
 * Everything else (MouseMove, Scroll, ViewportResize, etc.) is filtered out
 * during capture. See electron/capture/dom-capture.js for the filter.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// rrweb event schemas
// ---------------------------------------------------------------------------

/**
 * Minimal rrweb event schema.
 *
 * We don't deeply validate the rrweb event internals — rrweb owns that format.
 * We only validate the envelope: type, timestamp, and that data exists.
 */
export const rrwebEventSchema = z.object({
  type: z.number().int().min(0).max(6),
  data: z.unknown(),
  timestamp: z.number(),
});

// ---------------------------------------------------------------------------
// Snapshot marker schema
// ---------------------------------------------------------------------------

/**
 * A snapshot marker identifies a state boundary in the event stream.
 *
 * The settle cycle creates these when the page stabilizes after an interaction.
 * eventIndex points to a FullSnapshot (type=2) event in the events array.
 */
export const snapshotMarkerSchema = z.object({
  snapshotId: z.string(),
  eventIndex: z.number().int().min(0),
  screenshot: z.string().describe("Base64-encoded JPEG screenshot"),
  url: z.string(),
  title: z.string(),
});

// ---------------------------------------------------------------------------
// Session recording schema — the source of truth
// ---------------------------------------------------------------------------

export const sessionRecordingSchema = z.object({
  sessionId: z.string(),
  origin: z.string(),
  startedAt: z.string().datetime(),
  stoppedAt: z.string().datetime(),
  events: z.array(rrwebEventSchema).min(1),
  snapshots: z.array(snapshotMarkerSchema).min(1),
});
