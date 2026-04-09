/**
 * schema.js — Zod schemas for the session recording.
 *
 * The session recording is the source of truth for a browsing session.
 * It contains a continuous rrweb event stream (all sources, no filtering)
 * and optionally snapshot markers that identify state boundaries.
 *
 * Capture records ALL rrweb event types with no filtering.
 * Snapshots are derived post-hoc by the backend segmenter
 * (core/recording/segment.js), not during capture.
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
 * The backend segmenter creates these post-hoc from the raw event stream.
 * eventIndex points to the last event before the next trigger (the settled state).
 * rrwebTree carries the serialized DOM at that point (from Playwright replay).
 */
export const snapshotMarkerSchema = z.object({
  snapshotId: z.string(),
  eventIndex: z.number().int().min(0),
  screenshot: z.string().nullable().describe("Base64-encoded JPEG screenshot"),
  url: z.string(),
  title: z.string(),
  trigger: z.object({
    kind: z.string(),
  }).nullable().optional(),
  rrwebTree: z.unknown().optional().describe("rrweb serializedNodeWithId tree from replay"),
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
  snapshots: z.array(snapshotMarkerSchema).optional(),
});
