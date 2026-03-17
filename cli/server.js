import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import {
  createEnvelope,
  MessageType,
  parseEnvelope,
  PROTOCOL_VERSION
} from "../extension/shared/protocol.js";
import { encode, decode } from "../extension/shared/codec.js";
import { classifyInteractables } from "./discovery/classify.js";
import { groupEntities } from "./discovery/entities.js";
import { synthesizeAllLocators } from "./discovery/locators.js";
import { compileManifest } from "./discovery/compile.js";
import { enrichManifest } from "./discovery/enrich.js";
import { DiscoverySession } from "./discovery/session.js";
import { createBridge } from "./api/bridge.js";
import { createHttpHandler } from "./api/router.js";
import { ManifestStore } from "./manifest-store.js";

const CLIENT_STATUS_INTERVAL_MS = 15000;

/** Active discovery sessions keyed by sessionId */
const activeSessions = new Map();

/** Per-origin finalization queue to serialize manifest writes */
const originQueues = new Map();

/** Module-level state shared between HTTP and WS */
const manifestStore = new ManifestStore();
const siteManifests = new Map();   // origin → manifest (in-memory cache)
let extensionSocket = null;
const bridge = createBridge();

/**
 * Create a send helper for a socket that tracks whether the client
 * speaks binary (protobuf) or JSON.  The first message from the client
 * determines the mode.
 */
const createSocketSender = () => {
  let useBinary = false;

  return {
    /** Mark this socket as binary-capable (called when we receive a binary frame) */
    setBinary() { useBinary = true; },
    isBinary() { return useBinary; },

    /** Send a message, encoding as protobuf (binary) or JSON depending on client mode */
    send(socket, type, payload = {}, requestId) {
      if (socket.readyState !== 1) return;
      if (useBinary) {
        socket.send(encode(type, payload, requestId));
      } else {
        socket.send(JSON.stringify(createEnvelope(type, payload, requestId)));
      }
    }
  };
};

/**
 * Decode an incoming message — supports both binary (protobuf) and JSON.
 * Returns { message, isBinary } or { message: null }.
 */
const decodeMessage = (data, isBinary) => {
  if (isBinary) {
    const bytes = data instanceof Buffer ? new Uint8Array(data) : data;
    const message = decode(bytes);
    return { message, isBinary: true };
  }
  // JSON fallback
  const message = parseEnvelope(data.toString());
  return { message, isBinary: false };
};

export const startServer = async ({
  host = "127.0.0.1",
  port = 8787,
  debug = false
} = {}) => {
  // Load persisted site manifests on startup
  const sites = await manifestStore.listSites();
  for (const site of sites) {
    const m = await manifestStore.load(site.origin);
    if (m) {
      siteManifests.set(site.origin, m);
      const slug = ManifestStore.originSlug(site.origin);
      console.log(`[browserwire-cli] loaded manifest for ${site.origin} → http://${host}:${port}/api/sites/${slug}/docs`);
    }
  }
  if (sites.length > 0) {
    console.log(`[browserwire-cli] loaded ${sites.length} site manifest(s)`);
  }

  const httpHandler = createHttpHandler({
    getManifestBySlug: (slug) => {
      for (const [origin, m] of siteManifests) {
        if (ManifestStore.originSlug(origin) === slug) return { manifest: m, origin };
      }
      return null;
    },
    listSites: () => [...siteManifests.entries()].map(([origin, m]) => ({
      origin,
      slug: ManifestStore.originSlug(origin),
      domain: m.domain || null,
      entityCount: m.entities?.length || 0,
      actionCount: m.actions?.length || 0,
      viewCount: m.views?.length || 0,
      updatedAt: m.metadata?.updatedAt || m.metadata?.createdAt || null
    })),
    bridge,
    getSocket: () => extensionSocket,
    host,
    port
  });

  const httpServer = createServer(httpHandler);
  const wss = new WebSocketServer({ server: httpServer });

  httpServer.listen(port, host, () => {
    console.log(`[browserwire-cli] listening on http://${host}:${port}`);
    console.log(`[browserwire-cli] site index at http://${host}:${port}/api/docs`);
  });

  wss.on("connection", (socket, req) => {
    const clientId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const source = req.socket.remoteAddress || "unknown";
    const sender = createSocketSender();

    console.log(`[browserwire-cli] client connected ${clientId} from ${source}`);

    const statusTimer = setInterval(() => {
      sender.send(socket, MessageType.STATUS, {
        state: "connected",
        serverTime: new Date().toISOString()
      });
    }, CLIENT_STATUS_INTERVAL_MS);

    socket.on("message", async (data, isBinary) => {
      const { message, isBinary: clientIsBinary } = decodeMessage(data, isBinary);

      if (clientIsBinary) {
        sender.setBinary();
      }

      if (!message) {
        sender.send(socket, MessageType.ERROR, {
          code: "invalid_message",
          message: "Could not decode message (expected protobuf binary or JSON)."
        });
        return;
      }

      if (message.type === MessageType.HELLO) {
        // Track as extension socket
        extensionSocket = socket;
        // Stash the sender on the socket for the bridge to use
        socket._bwSender = sender;

        sender.send(socket, MessageType.HELLO_ACK, {
          accepted: true,
          server: "browserwire-cli",
          protocolVersion: PROTOCOL_VERSION
        }, message.requestId);
        return;
      }

      if (message.type === MessageType.PING) {
        sender.send(socket, MessageType.PONG, {
          serverTime: new Date().toISOString()
        }, message.requestId);
        return;
      }

      // ─── Bridge result messages (from extension executing REST API commands) ──

      if (message.type === MessageType.WORKFLOW_RESULT) {
        if (bridge.handleWsResult(message)) return;
        // Not matched — fall through to log
      }

      // ─── Discovery Session Messages ─────────────────────────

      if (message.type === MessageType.DISCOVERY_SESSION_START) {
        const payload = message.payload || {};
        const sessionId = payload.sessionId || crypto.randomUUID();
        const site = payload.url || "unknown";

        const session = new DiscoverySession(sessionId, site);
        activeSessions.set(sessionId, session);

        // Derive origin and seed with prior manifest if available
        let origin = null;
        try { origin = new URL(site).origin; } catch { /* ignore */ }
        session._siteOrigin = origin;

        if (origin) {
          const prior = siteManifests.get(origin) || await manifestStore.load(origin);
          if (prior) {
            session.seedWithManifest(prior);
            console.log(`[browserwire-cli] session seeded with prior manifest for ${origin}`);
          }
        }

        console.log(
          `[browserwire-cli] session started: ${sessionId} site=${site}`
        );

        sender.send(socket, MessageType.DISCOVERY_SESSION_STATUS,
          session.getStats(), message.requestId);
        return;
      }

      if (message.type === MessageType.DISCOVERY_SESSION_STOP) {
        const payload = message.payload || {};
        const sessionId = payload.sessionId;
        const batchId = payload.batchId || null;
        const note = payload.note || null;
        const session = activeSessions.get(sessionId);

        if (!session) {
          console.warn(`[browserwire-cli] session stop for unknown session: ${sessionId}`);
          sender.send(socket, MessageType.ERROR,
            { code: "unknown_session", message: `Session ${sessionId} not found` },
            message.requestId);
          return;
        }

        if (note) session.note = note;

        console.log(`[browserwire-cli] session stopping: ${sessionId}${batchId ? ` batchId=${batchId}` : ""}`);

        const origin = session._siteOrigin;

        // Helper: the actual finalization work for this session
        const doFinalize = async () => {
          // Notify extension that processing is now active
          if (batchId) {
            sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
              { batchId, sessionId, status: "processing" });
          }

          // Re-seed with the latest manifest so merges are cumulative
          if (origin) {
            const freshPrior = siteManifests.get(origin);
            if (freshPrior) session.seedWithManifest(freshPrior);
          }

          // Process any remaining buffered snapshots sent with the stop payload
          const remainingSnapshots = Array.isArray(payload.pendingSnapshots) ? payload.pendingSnapshots : [];
          if (remainingSnapshots.length > 0) {
            console.log(`[browserwire-cli] processing ${remainingSnapshots.length} remaining buffered snapshots before finalize`);
            for (const snap of remainingSnapshots) {
              await session.addSnapshot(snap);
            }
          }

          const result = await session.finalize();
          const { manifest, draftManifest, enrichedManifest } = result;

          if (!manifest) {
            console.log(`[browserwire-cli] session ${sessionId} produced no manifest`);
            if (batchId) {
              sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
                { batchId, sessionId, status: "complete", manifest: null });
            }
            return;
          }

          // Write output files
          const sessionDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
          await mkdir(sessionDir, { recursive: true });
          await Promise.all([
            writeFile(
              resolve(sessionDir, "manifest-draft.json"),
              JSON.stringify(draftManifest || manifest, null, 2),
              "utf8"
            ),
            writeFile(
              resolve(sessionDir, "manifest.json"),
              JSON.stringify(manifest, null, 2),
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
                  stats: s.stats,
                  skeletonCount: s.skeleton?.length ?? 0,
                  networkLog: s.networkLog || [],
                  viewCount: s.views?.length ?? 0,
                  views: (s.views || []).map(v => ({
                    id: v.id,
                    name: v.name,
                    apiRequest: v.apiRequest || null,
                    apiFields: v.apiFields || null,
                    fieldCount: v.fields?.length ?? 0
                  }))
                }))
              }, null, 2),
              "utf8"
            )
          ]);

          console.log(`[browserwire-cli] session ${sessionId} output written to ${sessionDir}`);

          // Save to site-centric manifest store
          if (origin) {
            siteManifests.set(origin, enrichedManifest);
            await manifestStore.save(origin, enrichedManifest, sessionId);
            const slug = ManifestStore.originSlug(origin);
            console.log(`[browserwire-cli] REST API ready at http://${host}:${port}/api/sites/${slug}/docs`);
          }

          // Send batch complete + manifest ready
          if (batchId) {
            sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
              { batchId, sessionId, status: "complete", manifest: enrichedManifest });
          }
          sender.send(socket, MessageType.MANIFEST_READY,
            { sessionId, manifest: enrichedManifest });

          sender.send(socket, MessageType.DISCOVERY_SESSION_STATUS,
            { ...session.getStats(), finalized: true }, message.requestId);
        };

        // For sessions with a known origin, serialize finalization through a per-origin queue.
        // Sessions with no origin (unknown URL) run immediately without queuing.
        if (origin) {
          // Immediately notify extension that this batch is queued
          if (batchId) {
            sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
              { batchId, sessionId, status: "pending" });
          }

          const prev = originQueues.get(origin) || Promise.resolve();
          const work = prev.then(() => doFinalize().catch((error) => {
            console.error(`[browserwire-cli] session finalization failed:`, error);
            if (batchId) {
              sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
                { batchId, sessionId, status: "error", error: error.message });
            }
          }).finally(() => {
            activeSessions.delete(sessionId);
          }));
          originQueues.set(origin, work.catch(() => {}));
        } else {
          // No origin — run immediately (no queuing)
          if (batchId) {
            sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
              { batchId, sessionId, status: "processing" });
          }
          doFinalize().catch((error) => {
            console.error(`[browserwire-cli] session finalization failed:`, error);
            if (batchId) {
              sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
                { batchId, sessionId, status: "error", error: error.message });
            }
          }).finally(() => {
            activeSessions.delete(sessionId);
          });
        }

        return;
      }

      if (message.type === MessageType.DISCOVERY_INCREMENTAL) {
        const payload = message.payload || {};
        const sessionId = payload.sessionId;
        const session = activeSessions.get(sessionId);

        if (!session) {
          console.warn(`[browserwire-cli] incremental snapshot for unknown session: ${sessionId}`);
          return;
        }

        const skeletonCount = Array.isArray(payload.skeleton) ? payload.skeleton.length : 0;
        const screenshotKB = payload.screenshot ? Math.round(payload.screenshot.length * 0.75 / 1024) : 0;
        console.log(
          `[browserwire-cli] incremental snapshot: sessionId=${sessionId} skeleton=${skeletonCount} trigger=${payload.trigger?.kind || "unknown"} screenshot=${payload.screenshot ? screenshotKB + "KB" : "null"}`
        );

        session.addSnapshot(payload)
          .then((stats) => {
            // Broadcast updated stats back to extension
            sender.send(socket, MessageType.DISCOVERY_SESSION_STATUS, stats);

            // Write screenshot as JPEG (always) + full snapshot JSON (debug only)
            const snapName = payload.snapshotId || `snap_${stats.snapshotCount}`;
            const snapDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);

            if (payload.screenshot) {
              mkdir(snapDir, { recursive: true })
                .then(() => writeFile(
                  resolve(snapDir, `${snapName}.jpg`),
                  Buffer.from(payload.screenshot, "base64")
                ))
                .catch((err) => {
                  console.error(`[browserwire-cli] failed to write screenshot:`, err);
                });
            }

            mkdir(snapDir, { recursive: true })
              .then(() => writeFile(
                resolve(snapDir, `${snapName}.json`),
                JSON.stringify({ ...payload, screenshot: payload.screenshot ? "<base64>" : null }, null, 2),
                "utf8"
              ))
              .catch((err) => {
                console.error(`[browserwire-cli] failed to write snapshot:`, err);
              });
          })
          .catch((error) => {
            console.error(`[browserwire-cli] snapshot processing failed:`, error);
          });

        return;
      }

      // ─── Legacy One-Shot Discovery (kept for backward compat) ──

      if (message.type === MessageType.DISCOVERY_SNAPSHOT) {
        const payload = message.payload || {};
        const elements = Array.isArray(payload.elements) ? payload.elements : [];
        const a11y = Array.isArray(payload.a11y) ? payload.a11y : [];
        const url = payload.url || "unknown";
        const title = payload.title || "unknown";
        const pageText = typeof payload.pageText === "string" ? payload.pageText : "";

        console.log(
          `[browserwire-cli] discovery snapshot url=${url} title="${title}" elements=${elements.length} a11y=${a11y.length}`
        );

        const { interactables, stats } = classifyInteractables(elements, a11y);
        const { entities, stats: entityStats } = groupEntities(elements, a11y, interactables);
        const { locators, stats: locatorStats } = synthesizeAllLocators(elements, a11y, interactables);
        const { manifest, stats: manifestStats } = compileManifest({
          url, title,
          capturedAt: payload.capturedAt,
          elements, a11y, interactables, entities, locators
        });

        console.log(
          `[browserwire-cli] manifest compiled: ${manifestStats.entityCount} entities, ${manifestStats.actionCount} actions`
        );

        const manifestLogPath = resolve(homedir(), ".browserwire", "logs/discovery-manifest.json");
        mkdir(dirname(manifestLogPath), { recursive: true })
          .then(() => enrichManifest(manifest, pageText, payload.capturedAt))
          .then((result) => {
            const finalManifest = result ? result.enriched : manifest;
            return writeFile(manifestLogPath, JSON.stringify(finalManifest, null, 2), "utf8");
          })
          .then(() => {
            console.log(`[browserwire-cli] manifest written to ${manifestLogPath}`);
          })
          .catch((error) => {
            console.error(`[browserwire-cli] manifest write failed:`, error);
            return writeFile(manifestLogPath, JSON.stringify(manifest, null, 2), "utf8").catch(() => {});
          });

        sender.send(socket, MessageType.DISCOVERY_ACK, {
          elementCount: elements.length,
          a11yCount: a11y.length,
          interactableCount: interactables.length,
          entityCount: manifestStats.entityCount,
          actionCount: manifestStats.actionCount,
          url,
          ackedAt: new Date().toISOString()
        }, message.requestId);
        return;
      }

      // ─── Unsupported ──────────────────────────────────────────

      sender.send(socket, MessageType.ERROR, {
        code: "unsupported_type",
        message: `Unsupported message type '${message.type}'.`
      }, message.requestId);
    });

    socket.on("close", () => {
      clearInterval(statusTimer);
      console.log(`[browserwire-cli] client disconnected ${clientId}`);

      // If this was the extension socket, reject all pending bridge requests
      if (socket === extensionSocket) {
        extensionSocket = null;
        bridge.rejectAll("Extension disconnected");
      }
    });

    socket.on("error", (error) => {
      clearInterval(statusTimer);
      console.error(`[browserwire-cli] socket error ${clientId}`, error);
    });
  });

  wss.on("close", () => {
    console.log("[browserwire-cli] server stopped");
  });

  return httpServer;
};
