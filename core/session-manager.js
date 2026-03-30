/**
 * session-manager.js — Session lifecycle manager.
 *
 * Receives session recordings from the capture pipeline, validates and
 * persists them, then processes them through the discovery agent pipeline
 * to produce a StateMachineManifest.
 *
 * Session recording (source of truth):
 * {
 *   sessionId, origin, startedAt, stoppedAt,
 *   events: rrwebEvent[],   // continuous rrweb event stream
 *   snapshots: [            // state boundary markers
 *     { snapshotId, eventIndex, screenshot, url, title }
 *   ]
 * }
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { ManifestStore } from "./manifest-store.js";
import { validateRecording } from "./recording/index.js";
import { processRecording } from "./discovery/session-processor.js";

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
   * Save a session recording to disk, then process it through the
   * discovery agent pipeline to produce a StateMachineManifest.
   *
   * @param {object} recording
   * @param {{ onStatus?: (status: object) => void }} [opts]
   * @returns {Promise<string>} Path to the session directory
   */
  async saveRecording(recording, opts = {}) {
    const { onStatus = () => {} } = opts;

    // Validate
    const validation = validateRecording(recording);
    if (!validation.valid) {
      console.warn(`[browserwire] recording validation failed:`, validation.errors);
      throw new Error(`Invalid recording: ${validation.errors.join("; ")}`);
    }

    const { sessionId, origin, events, snapshots } = recording;
    const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
    await mkdir(sessionDir, { recursive: true });

    // Save screenshots as separate files
    const snapshotsForJson = [];
    for (const snap of snapshots) {
      if (snap.screenshot) {
        await writeFile(
          resolve(sessionDir, `${snap.snapshotId}.jpg`),
          Buffer.from(snap.screenshot, "base64")
        );
      }
      snapshotsForJson.push({
        snapshotId: snap.snapshotId,
        eventIndex: snap.eventIndex,
        screenshotFile: `${snap.snapshotId}.jpg`,
        url: snap.url,
        title: snap.title,
      });
    }

    // Save recording metadata
    await writeFile(
      resolve(sessionDir, "session-recording.json"),
      JSON.stringify({
        sessionId,
        origin,
        startedAt: recording.startedAt,
        stoppedAt: recording.stoppedAt,
        eventCount: events.length,
        snapshotCount: snapshots.length,
        snapshots: snapshotsForJson,
      }, null, 2),
      "utf8"
    );

    // Save events separately
    await writeFile(
      resolve(sessionDir, "events.json"),
      JSON.stringify(events),
      "utf8"
    );

    console.log(
      `[browserwire] session recording saved: ${sessionDir} ` +
      `(${events.length} events, ${snapshots.length} snapshots)`
    );

    // Process the recording through the discovery pipeline
    onStatus({ sessionId, status: "processing" });

    try {
      const { manifest, totalToolCalls } = await processRecording({
        recording,
        sessionId,
        onProgress: ({ snapshot, tool }) => {
          onStatus({ sessionId, status: "processing", snapshot, tool });
        },
      });

      if (manifest) {
        // Save manifest to session log
        await writeFile(
          resolve(sessionDir, "manifest.json"),
          JSON.stringify(manifest, null, 2),
          "utf8"
        );

        // Save to site-centric manifest store
        if (origin) {
          this.siteManifests.set(origin, manifest);
          await this.manifestStore.save(origin, manifest, sessionId);
          const slug = ManifestStore.originSlug(origin);
          console.log(`[browserwire] manifest ready: http://${this.host}:${this.port}/api/sites/${slug}/docs`);
        }
      }

      onStatus({ sessionId, status: "complete", totalToolCalls });
    } catch (err) {
      console.error(`[browserwire] processing failed:`, err.message);
      onStatus({ sessionId, status: "error", error: err.message });
    }

    return sessionDir;
  }

  /**
   * Re-run the discovery pipeline on an existing session recording.
   * Reads the persisted recording from disk and processes it again,
   * overwriting the manifest without creating a new session.
   *
   * @param {string} sessionId
   * @param {{ onStatus?: (status: object) => void }} [opts]
   */
  async reprocessSession(sessionId, opts = {}) {
    const { onStatus = () => {} } = opts;

    const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);

    // Read persisted recording
    const meta = JSON.parse(await readFile(resolve(sessionDir, "session-recording.json"), "utf8"));
    const events = JSON.parse(await readFile(resolve(sessionDir, "events.json"), "utf8"));

    // Reconstruct snapshot objects with screenshots loaded from disk
    const snapshots = [];
    for (const snap of meta.snapshots) {
      let screenshot = null;
      if (snap.screenshotFile) {
        try {
          const buf = await readFile(resolve(sessionDir, snap.screenshotFile));
          screenshot = buf.toString("base64");
        } catch { /* screenshot may not exist */ }
      }
      snapshots.push({
        snapshotId: snap.snapshotId,
        eventIndex: snap.eventIndex,
        screenshot,
        url: snap.url,
        title: snap.title,
      });
    }

    const recording = {
      sessionId,
      origin: meta.origin,
      startedAt: meta.startedAt,
      stoppedAt: meta.stoppedAt,
      events,
      snapshots,
    };

    const origin = meta.origin;

    console.log(`[browserwire] reprocessing session ${sessionId} (${snapshots.length} snapshots)`);
    onStatus({ sessionId, status: "processing" });

    try {
      const { manifest, totalToolCalls } = await processRecording({
        recording,
        sessionId,
        onProgress: ({ snapshot, tool }) => {
          onStatus({ sessionId, status: "processing", snapshot, tool });
        },
      });

      if (manifest) {
        await writeFile(
          resolve(sessionDir, "manifest.json"),
          JSON.stringify(manifest, null, 2),
          "utf8"
        );

        if (origin) {
          this.siteManifests.set(origin, manifest);
          await this.manifestStore.save(origin, manifest, sessionId);
          const slug = ManifestStore.originSlug(origin);
          console.log(`[browserwire] manifest ready: http://${this.host}:${this.port}/api/sites/${slug}/docs`);
        }
      }

      onStatus({ sessionId, status: "complete", totalToolCalls });
    } catch (err) {
      console.error(`[browserwire] reprocessing failed:`, err.message);
      onStatus({ sessionId, status: "error", error: err.message });
    }
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
