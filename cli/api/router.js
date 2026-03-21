/**
 * router.js — Lightweight HTTP router for the BrowserWire REST API
 *
 * All operational routes live under /api/sites/:slug/...
 * No implicit "active site" concept.
 */

import { MessageType } from "../../extension/shared/protocol.js";
import { generateOpenApiSpec, collectReadViews } from "./openapi.js";
import { swaggerUiHtml } from "./swagger-ui.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(data);
};

const html = (res, status, body) => {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "text/html" });
  res.end(body);
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString();
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

/**
 * Build name->definition lookup maps from a manifest.
 */
const buildLookups = (manifest) => {
  const workflowMap = new Map();
  for (const workflow of manifest.workflowActions || []) {
    const name = sanitize(workflow.name);
    workflowMap.set(name, workflow);
  }

  return { workflowMap };
};

const sanitize = (name) =>
  (name || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

/**
 * Render an HTML landing page listing all known sites with links to their docs.
 */
const landingPageHtml = (sites, host, port) => {
  const rows = sites.map((s) => {
    const docsUrl = `/api/sites/${s.slug}/docs`;
    return `<tr>
      <td><a href="${docsUrl}">${s.slug}</a></td>
      <td>${s.origin}</td>
      <td>${s.entityCount || 0}</td>
      <td>${s.actionCount || 0}</td>
      <td>${s.viewCount || 0}</td>
    </tr>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html><head><title>BrowserWire API</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 0 20px; }
  table { border-collapse: collapse; width: 100%; margin-top: 20px; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
  a { color: #0066cc; }
  .empty { color: #888; margin-top: 20px; }
</style></head>
<body>
  <h1>BrowserWire API</h1>
  ${sites.length > 0 ? `<table>
    <thead><tr><th>Site</th><th>Origin</th><th>Entities</th><th>Actions</th><th>Views</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p class="empty">No sites discovered yet. Run discovery from the browser extension to get started.</p>`}
</body></html>`;
};

/**
 * Create the HTTP request handler.
 *
 * @param {{ getManifestBySlug: (slug: string) => object|null, listSites: () => Array, bridge: object, getSocket: () => WebSocket|null, host: string, port: number }} deps
 * @returns {(req: import("http").IncomingMessage, res: import("http").ServerResponse) => void}
 */
export const createHttpHandler = ({ getManifestBySlug, listSites, bridge, getSocket, host, port }) => {
  return async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    // ── System routes ──

    if (path === "/api/health" && req.method === "GET") {
      const socket = getSocket();
      return json(res, 200, {
        ok: true,
        extensionConnected: socket !== null && socket.readyState === 1
      });
    }

    if (path === "/api/sites" && req.method === "GET") {
      const sites = listSites();
      return json(res, 200, { ok: true, sites });
    }

    // ── Landing page listing all sites ──

    if (path === "/api/docs" && req.method === "GET") {
      const sites = listSites();
      return html(res, 200, landingPageHtml(sites, host, port));
    }

    // ── Site-scoped routes: /api/sites/:slug/... ──

    const siteMatch = path.match(/^\/api\/sites\/([^/]+)(\/.*)?$/);
    if (siteMatch) {
      const slug = siteMatch[1];
      const subPath = siteMatch[2] || "";

      const lookup = getManifestBySlug(slug);
      if (!lookup) {
        return json(res, 404, { ok: false, error: `No manifest found for site '${slug}'` });
      }
      const { manifest, origin } = lookup;

      // GET /api/sites/:slug/manifest
      if (subPath === "/manifest" && req.method === "GET") {
        return json(res, 200, manifest);
      }

      // GET /api/sites/:slug/openapi.json
      if (subPath === "/openapi.json" && req.method === "GET") {
        return json(res, 200, generateOpenApiSpec(manifest, { host, port, pathPrefix: `/api/sites/${slug}` }));
      }

      // GET /api/sites/:slug/docs
      if (subPath === "/docs" && req.method === "GET") {
        return html(res, 200, swaggerUiHtml(`/api/sites/${slug}/openapi.json`));
      }

      // Routes below require an extension connection
      const socket = getSocket();
      if (!socket || socket.readyState !== 1) {
        return json(res, 503, { ok: false, error: "Extension not connected" });
      }

      const lookups = buildLookups(manifest);

      // POST /api/sites/:slug/workflows/:name
      const workflowMatch = subPath.match(/^\/workflows\/([^/]+)$/);
      if (workflowMatch && req.method === "POST") {
        const workflow = lookups.workflowMap.get(workflowMatch[1]);
        if (!workflow) return json(res, 404, { ok: false, error: `Workflow '${workflowMatch[1]}' not found` });

        let body = {};
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: "Invalid JSON body" }); }

        try {
          const result = await bridge.sendAndAwait(socket, MessageType.EXECUTE_WORKFLOW, {
            steps: workflow.steps || [],
            outcomes: workflow.outcomes || {},
            inputs: body,
            origin
          }, 60000);
          return json(res, 200, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      // GET /api/sites/:slug/reads/:name — execute via extension network observation or DOM
      const readMatch = subPath.match(/^\/reads\/([^/]+)$/);
      if (readMatch && req.method === "GET") {
        const readName = readMatch[1];
        const readViews = collectReadViews(manifest);
        const match = readViews.find(({ view }) => sanitize(view.name) === readName);
        if (!match) return json(res, 404, { ok: false, error: `Read API '${readName}' not found in manifest` });

        const page = (manifest.pages || []).find((p) =>
          (p.views || []).some((v) => v.name === match.view.name)
        );
        const pageUrl = page?.routePattern || "/";

        const params = {};
        for (const [key, val] of url.searchParams.entries()) {
          params[key] = val;
        }

        const rc = match.view.readContract;

        if (rc && rc.dataSources?.length > 0) {
          // Network-based read
          const primary = rc.dataSources.find((ds) => ds.role === "primary") || rc.dataSources[0];
          const apiRequest = {
            method: primary.method,
            pathPattern: primary.urlPattern,
            responsePath: primary.responsePath || null,
            ...(primary.operationName || primary.queryParams?.length ? {
              matchOn: {
                ...(primary.operationName ? { operationName: primary.operationName } : {}),
                ...(primary.queryParams?.length ? { queryParams: primary.queryParams.map((q) => q.name) } : {})
              }
            } : {})
          };
          const apiFields = {};
          for (const fm of primary.fieldMappings || []) {
            apiFields[fm.viewField] = fm.jsonPath;
          }
          try {
            const result = await bridge.sendAndAwait(socket, MessageType.EXECUTE_READ, {
              viewName: readName, origin, pageUrl, params, apiRequest, apiFields
            }, 30000);
            return json(res, 200, result);
          } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
          }
        } else if (match.view.viewConfig) {
          // DOM-based read
          try {
            const result = await bridge.sendAndAwait(socket, MessageType.EXECUTE_READ, {
              viewName: readName, origin, pageUrl, params, viewConfig: match.view.viewConfig
            }, 30000);
            return json(res, 200, result);
          } catch (err) {
            return json(res, 500, { ok: false, error: err.message });
          }
        }

        return json(res, 500, { ok: false, error: "View has neither readContract nor viewConfig" });
      }

      // Unknown sub-path under a valid site
      return json(res, 404, { ok: false, error: "Not found" });
    }

    // ── Fallback ──
    json(res, 404, { ok: false, error: "Not found" });
  };
};
