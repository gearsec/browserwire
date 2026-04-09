/**
 * core/recording — Session recording module.
 *
 * The session recording is the source of truth for a browsing session.
 * It contains a continuous rrweb event stream and snapshot markers.
 *
 * Re-exports all public APIs.
 */

export { validateRecording } from "./validate.js";
export {
  rrwebEventSchema,
  snapshotMarkerSchema,
  sessionRecordingSchema,
} from "./schema.js";
export { EventType, IncrementalSource, MouseInteraction } from "./rrweb-constants.js";
export { segmentEvents } from "./segment.js";
