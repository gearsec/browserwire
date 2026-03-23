/**
 * openapi.js — OpenAPI 3.0.3 spec generator from BrowserWire manifests
 */

const sanitizeName = (name) =>
  (name || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

const inputsToSchema = (inputs) => {
  if (!inputs || inputs.length === 0) return null;
  const properties = {};
  for (const input of inputs) {
    properties[input.name] = {
      type: input.type || "string",
      description: input.description || ""
    };
  }
  return { type: "object", properties };
};

/**
 * Build an OpenAPI response schema from a readContract's field mappings.
 * List views get wrapped in { type: "array", items: ... }.
 */
const fieldMappingsToSchema = (fieldMappings, isList) => {
  const properties = {};
  for (const fm of fieldMappings) {
    properties[fm.viewField] = {
      type: fm.type || "string",
      ...(fm.nullable ? { nullable: true } : {})
    };
  }
  const itemSchema = { type: "object", properties };
  return isList ? { type: "array", items: itemSchema } : itemSchema;
};

/**
 * Collect views with readContracts from manifest pages.
 */
export const collectReadViews = (manifest) => {
  const views = [];
  for (const page of manifest.pages || []) {
    for (const view of page.views || []) {
      if ((view.readContract && view.readContract.dataSources?.length > 0)
          || view.container_selector
          || view.fields?.some(f => f.selector)) {
        views.push({ view, pageName: page.name || page.routePattern, routePattern: page.routePattern });
      }
    }
  }
  return views;
};

export const generateOpenApiSpec = (manifest, { host = "127.0.0.1", port = 8787, pathPrefix = "" } = {}) => {
  const workflows = [];
  for (const page of manifest.pages || []) {
    for (const wf of page.workflows || []) {
      workflows.push(wf);
    }
  }

  const paths = {};

  // Manifest endpoint
  paths[`${pathPrefix}/manifest`] = {
    get: {
      summary: "Raw manifest JSON",
      operationId: "getManifest",
      tags: ["System"],
      responses: {
        200: { description: "Full manifest", content: { "application/json": { schema: { type: "object" } } } }
      }
    }
  };

  // Workflows
  for (const workflow of workflows) {
    const name = sanitizeName(workflow.name);
    const path = `${pathPrefix}/workflows/${name}`;
    const bodySchema = inputsToSchema(workflow.inputs);

    paths[path] = {
      post: {
        summary: workflow.description || workflow.name,
        operationId: `workflow_${name}`,
        tags: ["Workflows"],
        ...(bodySchema ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: bodySchema } }
          }
        } : {}),
        responses: {
          200: {
            description: "Workflow result",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                data: { type: "object" },
                outcome: { type: "string" },
                error: { type: "string" }
              }
            }}}
          }
        }
      }
    };
  }

  // Read APIs — from views with readContracts
  const readViews = collectReadViews(manifest);
  const usedReadNames = new Set();

  for (const { view, routePattern } of readViews) {
    let name = sanitizeName(view.name);
    // Deduplicate if multiple views have the same sanitized name
    if (usedReadNames.has(name)) {
      let i = 2;
      while (usedReadNames.has(`${name}_${i}`)) i++;
      name = `${name}_${i}`;
    }
    usedReadNames.add(name);

    const path = `${pathPrefix}/reads/${name}`;
    const rc = view.readContract;

    if (rc && rc.dataSources?.length > 0) {
      // ── Network-based read (existing logic) ──
      const primary = rc.dataSources.find((ds) => ds.role === "primary") || rc.dataSources[0];

      // Build query parameters from primary data source
      const parameters = [];

      // Extract :param placeholders from urlPattern as query parameters
      const pathParams = (primary.urlPattern || "").match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      for (const param of pathParams) {
        const paramName = param.slice(1); // strip leading ':'
        parameters.push({
          name: paramName,
          in: "query",
          required: true,
          description: `Path parameter from upstream URL pattern (${primary.urlPattern})`,
          schema: { type: "string" }
        });
      }

      // Extract :param placeholders from page routePattern as query parameters
      const pageRouteParams = (routePattern || "").match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      for (const param of pageRouteParams) {
        const paramName = param.slice(1);
        if (!parameters.some(p => p.name === paramName)) {
          parameters.push({
            name: paramName,
            in: "query",
            required: true,
            description: `Page route parameter (${routePattern})`,
            schema: { type: "string" }
          });
        }
      }

      if (primary.queryParams) {
        for (const qp of primary.queryParams) {
          parameters.push({
            name: qp.name,
            in: "query",
            required: qp.required,
            description: qp.description || "",
            schema: { type: "string" },
            ...(qp.exampleValue ? { example: qp.exampleValue } : {})
          });
        }
      }

      // Add pagination parameters if present
      if (primary.pagination && primary.pagination.style !== "none") {
        const pag = primary.pagination;
        if (pag.pageParam && !parameters.some((p) => p.name === pag.pageParam)) {
          parameters.push({ name: pag.pageParam, in: "query", required: false, description: "Page parameter", schema: { type: "string" } });
        }
        if (pag.limitParam && !parameters.some((p) => p.name === pag.limitParam)) {
          parameters.push({ name: pag.limitParam, in: "query", required: false, description: "Limit / page size", schema: { type: "string" } });
        }
        if (pag.cursorParam && !parameters.some((p) => p.name === pag.cursorParam)) {
          parameters.push({ name: pag.cursorParam, in: "query", required: false, description: "Cursor for pagination", schema: { type: "string" } });
        }
      }

      // Build response schema from field mappings
      const responseSchema = primary.fieldMappings?.length > 0
        ? fieldMappingsToSchema(primary.fieldMappings, !!view.isList)
        : { type: "object" };

      const description = view.description || "Read API discovered from browser network traffic";

      paths[path] = {
        get: {
          summary: view.description || view.name,
          operationId: `read_${name}`,
          tags: ["Read APIs"],
          description,
          ...(parameters.length > 0 ? { parameters } : {}),
          responses: {
            200: {
              description: "Read response",
              content: { "application/json": { schema: responseSchema } }
            }
          },
          "x-browserwire-source": {
            urlPattern: primary.urlPattern,
            kind: primary.kind,
            method: primary.method
          }
        }
      };
    } else if (view.container_selector || view.fields?.some(f => f.selector)) {
      // ── DOM-based read (raw selectors from agent) ──
      const fields = (view.fields || []).filter(f => f.selector);
      const isList = view.isList || false;

      // Only route :params from the page routePattern
      const parameters = [];
      const pageRouteParams = (routePattern || "").match(/:[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      for (const param of pageRouteParams) {
        const paramName = param.slice(1);
        parameters.push({
          name: paramName,
          in: "query",
          required: true,
          description: `Page route parameter (${routePattern})`,
          schema: { type: "string" }
        });
      }

      // Build response schema from raw fields
      const properties = {};
      for (const f of fields) {
        properties[f.name] = { type: "string" };
      }
      const itemSchema = { type: "object", properties };
      const responseSchema = isList ? { type: "array", items: itemSchema } : itemSchema;

      const description = view.description || "Read API discovered from DOM structure";

      paths[path] = {
        get: {
          summary: view.description || view.name,
          operationId: `read_${name}`,
          tags: ["Read APIs"],
          description,
          ...(parameters.length > 0 ? { parameters } : {}),
          responses: {
            200: {
              description: "Read response",
              content: { "application/json": { schema: responseSchema } }
            }
          },
          "x-browserwire-source": {
            kind: "dom"
          }
        }
      };
    }
  }

  return {
    openapi: "3.0.3",
    info: {
      title: `BrowserWire API — ${manifest.domain || "Unknown"}`,
      description: manifest.domainDescription || "Auto-discovered browser API",
      version: manifest.manifestVersion || "1.0.0"
    },
    servers: [{ url: `http://${host}:${port}` }],
    paths
  };
};
