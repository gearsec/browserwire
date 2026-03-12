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

export const generateOpenApiSpec = (manifest, { host = "127.0.0.1", port = 8787, pathPrefix = "" } = {}) => {
  const actions = manifest.actions || [];
  const views = manifest.views || [];
  const workflows = manifest.workflowActions || [];
  const entities = manifest.entities || [];

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

  // Actions
  for (const action of actions) {
    const name = sanitizeName(action.semanticName || action.name);
    const path = `${pathPrefix}/actions/${name}`;
    const bodySchema = inputsToSchema(action.inputs);

    paths[path] = {
      post: {
        summary: action.description || action.name,
        operationId: `action_${name}`,
        tags: ["Actions"],
        ...(bodySchema ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: bodySchema } }
          }
        } : {}),
        responses: {
          200: {
            description: "Action result",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                result: { type: "object" },
                error: { type: "string" }
              }
            }}}
          }
        }
      }
    };
  }

  // Views
  for (const view of views) {
    const name = sanitizeName(view.semanticName || view.name);
    const path = `${pathPrefix}/views/${name}`;

    paths[path] = {
      get: {
        summary: view.description || view.name,
        operationId: `view_${name}`,
        tags: ["Views"],
        responses: {
          200: {
            description: "View data",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                data: view.isList ? { type: "array", items: { type: "object" } } : { type: "object" },
                count: { type: "integer" }
              }
            }}}
          }
        }
      }
    };
  }

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

  // Entities
  for (const entity of entities) {
    const name = sanitizeName(entity.semanticName || entity.name);
    const path = `${pathPrefix}/entities/${name}`;

    paths[path] = {
      get: {
        summary: `Read state of ${entity.semanticName || entity.name}`,
        operationId: `entity_${name}`,
        tags: ["Entities"],
        responses: {
          200: {
            description: "Entity state",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" },
                state: { type: "object" }
              }
            }}}
          }
        }
      }
    };
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
