/**
 * router.js — HTTP router for the BrowserWire REST API.
 *
 * Flat API generated from the state machine manifest:
 *   GET  /api/sites/:slug/views/:name       → navigate path, read view data
 *   POST /api/sites/:slug/actions/:name    → navigate path, execute action
 *   POST /api/sites/:slug/workflows/:name  → replay form actions in order
 *   GET  /api/sites/:slug/manifest         → raw state machine manifest
 *   GET  /api/sites/:slug/openapi.json     → OpenAPI spec
 *   GET  /api/sites/:slug/docs             → Swagger UI
 */

import { generateOpenApiSpec } from "./openapi.js";
import { buildRouteTable } from "./route-builder.js";
import { swaggerUiHtml } from "./swagger-ui.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
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
 * Render an HTML landing page listing all known sites.
 */
const landingPageHtml = (sites) => {
  const rows = sites.map((s) => {
    const docsUrl = `/api/sites/${s.slug}/docs`;
    return `<tr>
      <td><a href="${docsUrl}">${s.slug}</a></td>
      <td>${s.origin}</td>
      <td>${s.stateCount || 0}</td>
      <td>${s.viewCount || 0}</td>
      <td>${s.actionCount || 0}</td>
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
    <thead><tr><th>Site</th><th>Origin</th><th>States</th><th>Views</th><th>Actions</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>` : `<p class="empty">No sites discovered yet. Start exploring to get started.</p>`}
</body></html>`;
};

/**
 * Create the HTTP request handler.
 *
 * @param {{ getManifestBySlug: (slug: string) => object|null, listSites: () => Array, execute: (opts: object) => Promise<object>, host: string, port: number }} deps
 */
export const createHttpHandler = ({ getManifestBySlug, listSites, execute, host, port }) => {
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
      return json(res, 200, { ok: true });
    }

    if (path === "/api/sites" && req.method === "GET") {
      const sites = listSites();
      return json(res, 200, { ok: true, sites });
    }

    if (path === "/api/docs" && req.method === "GET") {
      const sites = listSites();
      return html(res, 200, landingPageHtml(sites));
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
        return json(res, 200, generateOpenApiSpec(manifest, { origin, host, port }));
      }

      // GET /api/sites/:slug/docs
      if (subPath === "/docs" && req.method === "GET") {
        return html(res, 200, swaggerUiHtml(`/api/sites/${slug}/openapi.json`));
      }

      // Build route table for views/actions/workflows
      const { views, actions, workflows } = buildRouteTable(manifest);

      // GET /api/sites/:slug/views/:name
      const viewMatch = subPath.match(/^\/views\/([^/]+)$/);
      if (viewMatch && req.method === "GET") {
        const viewName = viewMatch[1];
        const route = views.find((v) => v.name === viewName);
        if (!route) {
          return json(res, 404, { ok: false, error: `View '${viewName}' not found` });
        }

        // Collect inputs from query params
        const inputs = {};
        for (const [key, val] of url.searchParams.entries()) {
          inputs[key] = val;
        }

        try {
          const result = await execute({ manifest, route, inputs, origin });
          return json(res, result.ok ? 200 : 500, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      // POST /api/sites/:slug/actions/:name
      const actionMatch = subPath.match(/^\/actions\/([^/]+)$/);
      if (actionMatch && req.method === "POST") {
        const actionName = actionMatch[1];
        const route = actions.find((a) => a.name === actionName);
        if (!route) {
          return json(res, 404, { ok: false, error: `Action '${actionName}' not found` });
        }

        let body = {};
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: "Invalid JSON body" }); }

        try {
          const result = await execute({ manifest, route, inputs: body, origin });
          return json(res, result.ok ? 200 : 500, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      // POST /api/sites/:slug/workflows/:name
      const workflowMatch = subPath.match(/^\/workflows\/([^/]+)$/);
      if (workflowMatch && req.method === "POST") {
        const workflowName = workflowMatch[1];
        const route = workflows.find((w) => w.name === workflowName);
        if (!route) {
          return json(res, 404, { ok: false, error: `Workflow '${workflowName}' not found` });
        }

        let body = {};
        try { body = await readBody(req); } catch { return json(res, 400, { ok: false, error: "Invalid JSON body" }); }

        try {
          const result = await execute({ manifest, route, inputs: body, origin });
          return json(res, result.ok ? 200 : 500, result);
        } catch (err) {
          return json(res, 500, { ok: false, error: err.message });
        }
      }

      return json(res, 404, { ok: false, error: "Not found" });
    }

    // ── Fallback ──
    json(res, 404, { ok: false, error: "Not found" });
  };
};
