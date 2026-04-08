/**
 * validate.js — Semantic validation for session recordings.
 *
 * Validates beyond what Zod catches:
 *   - The events array starts with a Meta event
 *   - At least one FullSnapshot event exists
 *   - If snapshots are present, validates their eventIndex bounds and ordering
 *
 * Snapshots are optional — new recordings from the simplified capture layer
 * don't include them. The backend segmenter derives them post-hoc.
 */

import { sessionRecordingSchema } from "./schema.js";
import { EventType } from "./rrweb-constants.js";

/**
 * Validate a session recording.
 *
 * @param {object} recording
 * @returns {{ valid: boolean, errors?: string[], recording?: object }}
 */
export function validateRecording(recording) {
  const result = sessionRecordingSchema.safeParse(recording);

  if (!result.success) {
    const errors = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `${path}: ${issue.message}`;
    });
    return { valid: false, errors };
  }

  const data = result.data;
  const errors = [];

  // Events must start with a Meta event
  if (data.events[0]?.type !== EventType.Meta) {
    errors.push(`First event must be Meta (type=${EventType.Meta}), got type=${data.events[0]?.type}`);
  }

  // Must contain at least one FullSnapshot
  const hasFullSnapshot = data.events.some((e) => e.type === EventType.FullSnapshot);
  if (!hasFullSnapshot) {
    errors.push(`Events must contain at least one FullSnapshot (type=${EventType.FullSnapshot})`);
  }

  // Validate snapshot markers if present
  if (data.snapshots && data.snapshots.length > 0) {
    let prevIndex = -1;
    for (const snap of data.snapshots) {
      // eventIndex must be within bounds
      if (snap.eventIndex < 0 || snap.eventIndex >= data.events.length) {
        errors.push(
          `Snapshot "${snap.snapshotId}": eventIndex ${snap.eventIndex} is out of bounds (events length: ${data.events.length})`
        );
        continue;
      }

      // eventIndexes must be in ascending order
      if (snap.eventIndex <= prevIndex) {
        errors.push(
          `Snapshot "${snap.snapshotId}": eventIndex ${snap.eventIndex} is not after previous index ${prevIndex}`
        );
      }
      prevIndex = snap.eventIndex;
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, recording: data };
}
