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

import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { readdirSync, existsSync } from "node:fs";
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

  // ── Training status persistence ──

  async _writeTrainingStatus(sessionDir, data) {
    await writeFile(resolve(sessionDir, "training-status.json"), JSON.stringify(data, null, 2), "utf8");
  }

  async _deleteTrainingStatus(sessionDir) {
    try { await unlink(resolve(sessionDir, "training-status.json")); } catch {}
  }

  async _readTrainingStatus(sessionDir) {
    try { return JSON.parse(await readFile(resolve(sessionDir, "training-status.json"), "utf8")); }
    catch { return null; }
  }

  /**
   * Get training status for all sessions that have a training-status.json.
   * @returns {Promise<Record<string, object>>} sessionId → status object
   */
  async getTrainingStatus() {
    const logsDir = resolve(homedir(), ".browserwire", "logs");
    const result = {};
    if (!existsSync(logsDir)) return result;
    for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
      const status = await this._readTrainingStatus(resolve(logsDir, entry.name));
      if (status) result[entry.name.replace("session-", "")] = status;
    }
    return result;
  }

  /**
   * Get session IDs where training was interrupted (status === "training" on disk but no active process).
   * @returns {Promise<string[]>}
   */
  async getInterruptedSessions() {
    const all = await this.getTrainingStatus();
    return Object.entries(all)
      .filter(([, s]) => s.status === "training")
      .map(([id]) => id);
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
   * Save a session recording to disk (screenshots, metadata, events).
   * Does NOT run the discovery pipeline — call processSessionRecording() for that.
   *
   * @param {object} recording
   * @returns {Promise<string>} Path to the session directory
   */
  async saveRecordingToDisk(recording) {
    // Validate
    const validation = validateRecording(recording);
    if (!validation.valid) {
      console.warn(`[browserwire] recording validation failed:`, validation.errors);
      throw new Error(`Invalid recording: ${validation.errors.join("; ")}`);
    }

    const { sessionId, origin, events, snapshots } = recording;
    const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
    await mkdir(sessionDir, { recursive: true });

    // Save screenshots as separate files (if snapshots exist)
    const snapshotsForJson = [];
    if (snapshots) {
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
          screenshotFile: snap.screenshot ? `${snap.snapshotId}.jpg` : null,
          url: snap.url,
          title: snap.title,
          ...(snap.trigger && { trigger: snap.trigger }),
        });
      }
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
        snapshotCount: snapshotsForJson.length,
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
      `(${events.length} events, ${snapshotsForJson.length} snapshots)`
    );

    return sessionDir;
  }

  /**
   * Run the discovery agent pipeline on a recording to produce a manifest.
   *
   * @param {object} recording
   * @param {{ onStatus?: (status: object) => void }} [opts]
   */
  async processSessionRecording(recording, opts = {}) {
    const { onStatus = () => {} } = opts;
    const { sessionId, origin } = recording;
    const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
    const snapshotCount = recording.snapshots?.length || 0;

    await this._writeTrainingStatus(sessionDir, { status: "training", startedAt: new Date().toISOString(), snapshot: 0, snapshotCount });
    onStatus({ sessionId, status: "processing", snapshotCount });

    try {
      const { manifest, totalToolCalls } = await processRecording({
        recording,
        sessionId,
        onProgress: async ({ phase, snapshot, tool, segmentation: segData }) => {
          if (segData) {
            await writeFile(resolve(sessionDir, "segmentation.json"), JSON.stringify(segData, null, 2), "utf8");
            onStatus({ sessionId, status: "processing", segmentation: segData, snapshotCount });
          }
          await this._writeTrainingStatus(sessionDir, { status: "training", snapshot, snapshotCount, tool });
          onStatus({ sessionId, status: "processing", snapshot, tool, snapshotCount });
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

      await this._deleteTrainingStatus(sessionDir);
      onStatus({ sessionId, status: "complete", totalToolCalls, snapshotCount });
    } catch (err) {
      console.error(`[browserwire] processing failed:`, err.message);
      await this._writeTrainingStatus(sessionDir, { status: "error", error: err.message });
      onStatus({ sessionId, status: "error", error: err.message, snapshotCount });
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
    const sessionDir = await this.saveRecordingToDisk(recording);
    await this.processSessionRecording(recording, opts);
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
      // Don't pass snapshots — force Pass 0 to re-segment from raw events
      // so segmentation.json is freshly computed on retrain
    };

    const origin = meta.origin;

    const snapshotCount = snapshots.length;
    console.log(`[browserwire] reprocessing session ${sessionId} (${snapshotCount} snapshots)`);
    await this._writeTrainingStatus(sessionDir, { status: "training", startedAt: new Date().toISOString(), snapshot: 0, snapshotCount });
    onStatus({ sessionId, status: "processing", snapshotCount });

    try {
      const { manifest, totalToolCalls } = await processRecording({
        recording,
        sessionId,
        onProgress: async ({ phase, snapshot, tool, segmentation: segData }) => {
          if (segData) {
            await writeFile(resolve(sessionDir, "segmentation.json"), JSON.stringify(segData, null, 2), "utf8");
            onStatus({ sessionId, status: "processing", segmentation: segData, snapshotCount });
          }
          await this._writeTrainingStatus(sessionDir, { status: "training", snapshot, snapshotCount, tool });
          onStatus({ sessionId, status: "processing", snapshot, tool, snapshotCount });
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

      await this._deleteTrainingStatus(sessionDir);
      onStatus({ sessionId, status: "complete", totalToolCalls, snapshotCount });
    } catch (err) {
      console.error(`[browserwire] reprocessing failed:`, err.message);
      await this._writeTrainingStatus(sessionDir, { status: "error", error: err.message });
      onStatus({ sessionId, status: "error", error: err.message, snapshotCount });
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
