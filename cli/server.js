import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { WebSocketServer } from "ws";
import {
  createEnvelope,
  MessageType,
  parseEnvelope,
  PROTOCOL_VERSION
} from "../extension/shared/protocol.js";
import { encode, decode } from "../extension/shared/codec.js";
import { DiscoverySession } from "./discovery/session.js";
import { createBridge } from "./api/bridge.js";
import { createHttpHandler } from "./api/router.js";
import { collectReadViews } from "./api/openapi.js";
import { ManifestStore } from "./manifest-store.js";

const CLIENT_STATUS_INTERVAL_MS = 15000;

/** JSON replacer that converts BigInt values to numbers (or strings if too large). */
const bigIntReplacer = (_key, value) =>
  typeof value === "bigint"
    ? (value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : String(value))
    : value;

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
    listSites: () => [...siteManifests.entries()].map(([origin, m]) => {
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
        readApiCount: collectReadViews(m).length,
        endpointCount,
        workflowCount,
        updatedAt: m.metadata?.updatedAt || m.metadata?.createdAt || null
      };
    }),
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

      if (message.type === MessageType.WORKFLOW_RESULT || message.type === MessageType.READ_RESULT) {
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

        // Derive origin for file output
        let origin = null;
        try { origin = new URL(site).origin; } catch { /* ignore */ }
        session._siteOrigin = origin;

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

          // Process any remaining buffered snapshots sent with the stop payload
          const remainingSnapshots = Array.isArray(payload.pendingSnapshots) ? payload.pendingSnapshots : [];
          if (remainingSnapshots.length > 0) {
            console.log(`[browserwire-cli] processing ${remainingSnapshots.length} remaining buffered snapshots before finalize`);
            for (const snap of remainingSnapshots) {
              await session.addSnapshot(snap);

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
                  console.error(`[browserwire-cli] failed to write snapshot:`, err);
                });
            }
          }

          const result = await session.finalize();
          const { siteSchema } = result;

          if (!siteSchema) {
            console.log(`[browserwire-cli] session ${sessionId} produced no API schema`);
            if (batchId) {
              sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
                { batchId, sessionId, status: "complete" });
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
                    workflowCount: s.apiSchema.workflows.length
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

          console.log(`[browserwire-cli] session ${sessionId} output written to ${sessionDir}`);

          // Save site schema to site-centric store
          if (origin) {
            siteManifests.set(origin, siteSchema);
            await manifestStore.save(origin, siteSchema, sessionId);
            const slug = ManifestStore.originSlug(origin);
            console.log(`[browserwire-cli] site schema ready at http://${host}:${port}/api/sites/${slug}/docs`);
          }

          // Send batch complete
          if (batchId) {
            sender.send(socket, MessageType.BATCH_PROCESSING_STATUS,
              { batchId, sessionId, status: "complete" });
          }

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
