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
  const workflows = manifest.workflowActions || [];

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
