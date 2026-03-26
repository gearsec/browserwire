/**
 * session-manager.js — Session lifecycle manager.
 *
 * Receives session recordings from the capture pipeline and persists them.
 * A session recording is the source of truth:
 * {
 *   sessionId, origin, startedAt, stoppedAt,
 *   events: rrwebEvent[],   // continuous rrweb event stream
 *   snapshots: [            // state boundary markers
 *     { snapshotId, eventIndex, screenshot, url, title }
 *   ]
 * }
 *
 * For now, the manager saves the recording to disk. Future phases will
 * process recordings through the discovery agent pipeline.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ManifestStore } from "./manifest-store.js";
import { validateRecording } from "./recording/index.js";

export class SessionManager {
  /**
   * @param {ManifestStore} [manifestStore]
   * @param {{ host?: string, port?: number }} [opts]
   */
  constructor(manifestStore, opts = {}) {
    this.manifestStore = manifestStore || new ManifestStore();
    this.host = opts.host || "127.0.0.1";
    this.port = opts.port || 8787;

    /** origin → manifest (in-memory cache) */
    this.siteManifests = new Map();
  }

  /**
   * Load persisted site manifests on startup.
   */
  async loadManifests() {
    const sites = await this.manifestStore.listSites();
    for (const site of sites) {
      const m = await this.manifestStore.load(site.origin);
      if (m) {
        this.siteManifests.set(site.origin, m);
        const slug = ManifestStore.originSlug(site.origin);
        console.log(`[browserwire] loaded manifest for ${site.origin} → http://${this.host}:${this.port}/api/sites/${slug}/docs`);
      }
    }
    if (sites.length > 0) {
      console.log(`[browserwire] loaded ${sites.length} site manifest(s)`);
    }
  }

  /**
   * Save a session recording to disk.
   *
   * The recording is the source of truth for the entire session.
   * Screenshots are saved as separate JPEG files alongside the recording JSON.
   *
   * @param {object} recording - The session recording
   * @param {string} recording.sessionId
   * @param {string} recording.origin
   * @param {string} recording.startedAt
   * @param {string} recording.stoppedAt
   * @param {Array} recording.events - rrweb event stream
   * @param {Array} recording.snapshots - State boundary markers
   * @returns {Promise<string>} Path to the session directory
   */
  async saveRecording(recording) {
    // Validate the recording structure before saving
    const validation = validateRecording(recording);
    if (!validation.valid) {
      console.warn(`[browserwire] recording validation failed:`, validation.errors);
      throw new Error(`Invalid recording: ${validation.errors.join("; ")}`);
    }

    const { sessionId, origin, startedAt, stoppedAt, events, snapshots } = recording;

    const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
    await mkdir(sessionDir, { recursive: true });

    // Save screenshots as separate files and strip from recording JSON
    const snapshotsWithoutScreenshots = [];
    for (const snap of snapshots) {
      if (snap.screenshot) {
        await writeFile(
          resolve(sessionDir, `${snap.snapshotId}.jpg`),
          Buffer.from(snap.screenshot, "base64")
        );
      }
      snapshotsWithoutScreenshots.push({
        snapshotId: snap.snapshotId,
        eventIndex: snap.eventIndex,
        screenshotFile: `${snap.snapshotId}.jpg`,
        url: snap.url,
        title: snap.title,
      });
    }

    // Save the recording JSON (events + snapshot markers, no inline screenshots)
    const recordingJson = {
      sessionId,
      origin,
      startedAt,
      stoppedAt,
      eventCount: events.length,
      snapshotCount: snapshots.length,
      snapshots: snapshotsWithoutScreenshots,
    };

    await writeFile(
      resolve(sessionDir, "session-recording.json"),
      JSON.stringify(recordingJson, null, 2),
      "utf8"
    );

    // Save events separately (can be large)
    await writeFile(
      resolve(sessionDir, "events.json"),
      JSON.stringify(events),
      "utf8"
    );

    console.log(
      `[browserwire] session recording saved: ${sessionDir} ` +
      `(${events.length} events, ${snapshots.length} snapshots)`
    );

    return sessionDir;
  }

  /**
   * Get manifest for an origin.
   */
  getManifest(origin) {
    return this.siteManifests.get(origin) || null;
  }

  /**
   * Get all manifests.
   */
  getAllManifests() {
    return this.siteManifests;
  }

  /**
   * Get manifest by slug (for HTTP routing).
   */
  getManifestBySlug(slug) {
    for (const [origin, m] of this.siteManifests) {
      if (ManifestStore.originSlug(origin) === slug) return { manifest: m, origin };
    }
    return null;
  }

  /**
   * List all sites with summary info (for HTTP routing).
   */
  listSites() {
    return [...this.siteManifests.entries()].map(([origin, m]) => {
      const states = m.states || [];
      let viewCount = 0, actionCount = 0;
      for (const s of states) {
        viewCount += s.views?.length || 0;
        actionCount += s.actions?.length || 0;
      }
      return {
        origin,
        slug: ManifestStore.originSlug(origin),
        domain: m.domain || null,
        stateCount: states.length,
        viewCount,
        actionCount,
        updatedAt: m.metadata?.updatedAt || m.metadata?.createdAt || null,
      };
    });
  }
}
