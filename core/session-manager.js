/**
 * session-manager.js — Transport-agnostic session lifecycle manager.
 *
 * Extracted from server.js to allow both CLI (WS) and Electron (IPC) consumers
 * to share the same session logic.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { DiscoverySession } from "./discovery/session.js";
import { ManifestStore } from "./manifest-store.js";

/** JSON replacer that converts BigInt values to numbers (or strings if too large). */
const bigIntReplacer = (_key, value) =>
  typeof value === "bigint"
    ? (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : String(value))
    : value;

export class SessionManager {
  /**
   * @param {ManifestStore} [manifestStore]
   * @param {{ host?: string, port?: number, browserFactory?: () => object }} [opts]
   */
  constructor(manifestStore, opts = {}) {
    this.manifestStore = manifestStore || new ManifestStore();
    this.host = opts.host || "127.0.0.1";
    this.port = opts.port || 8787;
    this.browserFactory = opts.browserFactory || null;

    /** Active discovery sessions keyed by sessionId */
    this.activeSessions = new Map();

    /** Per-origin finalization queue to serialize manifest writes */
    this.originQueues = new Map();

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
   * Start a new discovery session.
   * @returns {{ sessionId: string, session: DiscoverySession }}
   */
  startSession(sessionId, url, opts = {}) {
    const session = new DiscoverySession(sessionId, url, {
      browserFactory: this.browserFactory,
    });
    this.activeSessions.set(sessionId, session);

    // Derive origin for file output
    let origin = null;
    try { origin = new URL(url).origin; } catch { /* ignore */ }
    session._siteOrigin = origin;

    console.log(`[browserwire] session started: ${sessionId} site=${url}`);
    return { sessionId, session };
  }

  /**
   * Stop a discovery session and run finalization.
   *
   * @param {string} sessionId
   * @param {{ pendingSnapshots?: Array, note?: string, batchId?: string, onStatus?: (status: object) => void }} opts
   * @returns {Promise<void>}
   */
  async stopSession(sessionId, opts = {}) {
    const { pendingSnapshots = [], note = null, batchId = null, onStatus = () => {} } = opts;
    const session = this.activeSessions.get(sessionId);

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (note) session.note = note;

    console.log(`[browserwire] session stopping: ${sessionId}${batchId ? ` batchId=${batchId}` : ""}`);

    const origin = session._siteOrigin;

    const doFinalize = async () => {
      // Notify that processing is now active
      if (batchId) {
        onStatus({ batchId, sessionId, status: "processing" });
      }

      // Process any remaining buffered snapshots sent with the stop payload
      if (pendingSnapshots.length > 0) {
        console.log(`[browserwire] processing ${pendingSnapshots.length} remaining buffered snapshots before finalize`);
        for (const snap of pendingSnapshots) {
          session.addSnapshot(snap);

          // Write debug snapshot JSON
          const snapName = snap.snapshotId || `snap_${session.snapshots.length}`;
          const snapDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
          mkdir(snapDir, { recursive: true })
            .then(() => writeFile(
              resolve(snapDir, `${snapName}.json`),
              JSON.stringify({ ...snap, screenshot: snap.screenshot ? "<base64>" : null }, bigIntReplacer, 2),
              "utf8"
            ))
            .catch((err) => {
              console.error(`[browserwire] failed to write snapshot:`, err);
            });
        }
      }

      const result = await session.finalize();
      const { siteSchema } = result;

      if (!siteSchema) {
        console.log(`[browserwire] session ${sessionId} produced no API schema`);
        if (batchId) {
          onStatus({ batchId, sessionId, status: "complete" });
        }
        return;
      }

      // Write output files
      const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
      await mkdir(sessionDir, { recursive: true });
      await Promise.all([
        writeFile(
          resolve(sessionDir, "site-schema.json"),
          JSON.stringify(siteSchema, bigIntReplacer, 2),
          "utf8"
        ),
        writeFile(
          resolve(sessionDir, "session.json"),
          JSON.stringify({
            sessionId: session.sessionId,
            site: session.site,
            startedAt: session.startedAt,
            stoppedAt: new Date().toISOString(),
            note: session.note || null,
            snapshotCount: session.snapshots.length,
            snapshots: session.snapshots.map((s) => ({
              snapshotId: s.snapshotId,
              trigger: s.trigger,
              url: s.url,
              title: s.title,
              capturedAt: s.capturedAt,
              apiSchema: s.apiSchema ? {
                domain: s.apiSchema.domain,
                page: s.apiSchema.page.name,
                viewCount: s.apiSchema.views.length,
                endpointCount: s.apiSchema.endpoints.length,
                workflowCount: (s.apiSchema.workflows || []).length
              } : null
            }))
          }, bigIntReplacer, 2),
          "utf8"
        ),
        // Write per-snapshot api-schema JSON files
        ...session.snapshots.map((s, i) =>
          s.apiSchema
            ? writeFile(
                resolve(sessionDir, `snap-${i + 1}-api-schema.json`),
                JSON.stringify(s.apiSchema, bigIntReplacer, 2),
                "utf8"
              )
            : Promise.resolve()
        )
      ]);

      console.log(`[browserwire] session ${sessionId} output written to ${sessionDir}`);

      // Save site schema to site-centric store
      if (origin) {
        this.siteManifests.set(origin, siteSchema);
        await this.manifestStore.save(origin, siteSchema, sessionId);
        const slug = ManifestStore.originSlug(origin);
        console.log(`[browserwire] site schema ready at http://${this.host}:${this.port}/api/sites/${slug}/docs`);
      }

      // Send batch complete
      if (batchId) {
        onStatus({ batchId, sessionId, status: "complete" });
      }

      onStatus({ sessionId, status: "finalized" });
    };

    // For sessions with a known origin, serialize finalization through a per-origin queue.
    if (origin) {
      if (batchId) {
        onStatus({ batchId, sessionId, status: "pending" });
      }

      const prev = this.originQueues.get(origin) || Promise.resolve();
      const work = prev.then(() => doFinalize().catch((error) => {
        console.error(`[browserwire] session finalization failed:`, error);
        if (batchId) {
          onStatus({ batchId, sessionId, status: "error", error: error.message });
        }
      }).finally(() => {
        this.activeSessions.delete(sessionId);
      }));
      this.originQueues.set(origin, work.catch(() => {}));
    } else {
      // No origin — run immediately (no queuing)
      if (batchId) {
        onStatus({ batchId, sessionId, status: "processing" });
      }
      doFinalize().catch((error) => {
        console.error(`[browserwire] session finalization failed:`, error);
        if (batchId) {
          onStatus({ batchId, sessionId, status: "error", error: error.message });
        }
      }).finally(() => {
        this.activeSessions.delete(sessionId);
      });
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
   * @param {{ collectReadViews?: (manifest: object) => Array }} [helpers]
   */
  listSites(helpers = {}) {
    return [...this.siteManifests.entries()].map(([origin, m]) => {
      const pages = m.pages || [];
      let viewCount = 0, endpointCount = 0, workflowCount = 0;
      for (const p of pages) {
        viewCount += p.views?.length || 0;
        endpointCount += p.endpoints?.length || 0;
        workflowCount += p.workflows?.length || 0;
      }
      return {
        origin,
        slug: ManifestStore.originSlug(origin),
        domain: m.domain || null,
        pageCount: pages.length,
        viewCount,
        readApiCount: helpers.collectReadViews ? helpers.collectReadViews(m).length : 0,
        endpointCount,
        workflowCount,
        updatedAt: m.metadata?.updatedAt || m.metadata?.createdAt || null
      };
    });
  }
}
