/**
 * validate.js — Semantic validation for session recordings.
 *
 * Validates beyond what Zod catches:
 *   - Every snapshot's eventIndex is within bounds of the events array
 *   - Every snapshot's eventIndex points to a FullSnapshot event (type=2)
 *   - Snapshot eventIndexes are in ascending order
 *   - The events array starts with a Meta event (type=4)
 *   - At least one FullSnapshot event exists
 */

import { sessionRecordingSchema } from "./schema.js";

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

  // Events must start with a Meta event (type=4)
  if (data.events[0]?.type !== 4) {
    errors.push(`First event must be Meta (type=4), got type=${data.events[0]?.type}`);
  }

  // Must contain at least one FullSnapshot (type=2)
  const hasFullSnapshot = data.events.some((e) => e.type === 2);
  if (!hasFullSnapshot) {
    errors.push("Events must contain at least one FullSnapshot (type=2)");
  }

  // Validate each snapshot marker
  let prevIndex = -1;
  for (const snap of data.snapshots) {
    // eventIndex must be within bounds
    if (snap.eventIndex < 0 || snap.eventIndex >= data.events.length) {
      errors.push(
        `Snapshot "${snap.snapshotId}": eventIndex ${snap.eventIndex} is out of bounds (events length: ${data.events.length})`
      );
      continue;
    }

    // eventIndex must point to a FullSnapshot (type=2)
    const event = data.events[snap.eventIndex];
    if (event.type !== 2) {
      errors.push(
        `Snapshot "${snap.snapshotId}": eventIndex ${snap.eventIndex} points to event type=${event.type}, expected FullSnapshot (type=2)`
      );
    }

    // eventIndexes must be in ascending order
    if (snap.eventIndex <= prevIndex) {
      errors.push(
        `Snapshot "${snap.snapshotId}": eventIndex ${snap.eventIndex} is not after previous index ${prevIndex}`
      );
    }
    prevIndex = snap.eventIndex;
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, recording: data };
}
