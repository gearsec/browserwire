/**
 * openapi.js — Generate OpenAPI 3.0 spec from the flat route table.
 *
 * Takes a manifest, builds the route table, and produces a complete
 * OpenAPI spec with paths for each view (GET) and action (POST).
 */

import { buildRouteTable } from "./route-builder.js";

/**
 * Map manifest field types to OpenAPI types.
 */
function toOpenApiType(type) {
  switch (type) {
    case "number": return { type: "number" };
    case "boolean": return { type: "boolean" };
    case "date": return { type: "string", format: "date-time" };
    default: return { type: "string" };
  }
}

/**
 * Build an OpenAPI request body schema from route inputs.
 */
function buildInputSchema(inputs) {
  if (!inputs || inputs.length === 0) return null;

  const properties = {};
  const required = [];

  for (const input of inputs) {
    const prop = {
      ...toOpenApiType(input.type),
      description: input.description || `From ${input.from}`,
    };

    // Enrich from widget metadata
    if (input.options && input.options.length > 0) {
      prop.enum = input.options;
    }
    if (input.widget) {
      const formatMap = { email: "email", date: "date", time: "time", url: "uri", tel: "phone" };
      if (formatMap[input.widget]) prop.format = formatMap[input.widget];
    }
    if (input.format) {
      prop.format = input.format;
    }
    if (input.placeholder) {
      prop.example = input.placeholder;
    }
    if (input.default_value !== undefined) {
      prop.default = input.default_value;
    }

    properties[input.name] = prop;
    if (input.required) {
      required.push(input.name);
    }
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Build an OpenAPI response schema from view returns.
 */
function buildResponseSchema(route) {
  if (!route.returns || route.returns.length === 0) {
    return { type: "object" };
  }

  const itemProperties = {};
  for (const field of route.returns) {
    itemProperties[field.name] = {
      ...toOpenApiType(field.type),
      ...(field.description ? { description: field.description } : {}),
    };
  }

  const itemSchema = { type: "object", properties: itemProperties };

  if (route.isList) {
    return { type: "array", items: itemSchema };
  }
  return itemSchema;
}

/**
 * Generate an OpenAPI 3.0.3 spec from a state machine manifest.
 *
 * @param {object} manifest — state machine manifest
 * @param {{ origin?: string, host?: string, port?: number }} [opts]
 * @returns {object} OpenAPI spec
 */
export function generateOpenApiSpec(manifest, opts = {}) {
  const { origin, host = "127.0.0.1", port = 8787 } = opts;
  const { views, actions, workflows } = buildRouteTable(manifest);

  const slug = origin
    ? origin.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]/g, "_")
    : "site";

  const paths = {};

  // View endpoints (GET)
  for (const route of views) {
    const path = `/api/sites/${slug}/views/${route.name}`;

    paths[path] = {
      get: {
        operationId: `read_${route.name}`,
        summary: route.description,
        tags: [route.stateName],
        ...(route.inputs.length > 0 ? {
          parameters: route.inputs.map((input) => ({
            name: input.name,
            in: "query",
            required: input.required,
            description: input.description || `From ${input.from}`,
            schema: toOpenApiType(input.type),
          })),
        } : {}),
        responses: {
          200: {
            description: "Success",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: buildResponseSchema(route),
                    state: { type: "string", description: "Current state after navigation" },
                  },
                },
              },
            },
          },
          500: { description: "Execution error" },
        },
      },
    };
  }

  // Action endpoints (POST)
  for (const route of actions) {
    const path = `/api/sites/${slug}/actions/${route.name}`;
    const inputSchema = buildInputSchema(route.inputs);

    paths[path] = {
      post: {
        operationId: `execute_${route.name}`,
        summary: route.description,
        tags: [route.stateName],
        ...(inputSchema ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: inputSchema,
              },
            },
          },
        } : {}),
        responses: {
          200: {
            description: "Action executed",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    state: { type: "string", description: "State after action execution" },
                  },
                },
              },
            },
          },
          500: { description: "Execution error" },
        },
      },
    };
  }

  // Workflow endpoints (POST) — single endpoint for form filling
  for (const route of workflows) {
    const path = `/api/sites/${slug}/workflows/${route.name}`;
    const inputSchema = buildInputSchema(route.inputs);

    paths[path] = {
      post: {
        operationId: `workflow_${route.name}`,
        summary: route.description,
        tags: [route.stateName],
        ...(inputSchema ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: inputSchema,
              },
            },
          },
        } : {}),
        responses: {
          200: {
            description: "Workflow executed — all form actions replayed in order",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean" },
                    state: { type: "string", description: "State after workflow execution" },
                    steps: { type: "array", items: { type: "string" }, description: "Executed steps in order" },
                  },
                },
              },
            },
          },
          500: { description: "Execution error" },
        },
      },
    };
  }

  return {
    openapi: "3.0.3",
    info: {
      title: `${manifest.domain || "Site"} API`,
      description: manifest.domainDescription || `Auto-generated API for ${origin || "site"}`,
      version: "1.0.0",
    },
    servers: [{ url: `http://${host}:${port}` }],
    paths,
  };
}

/**
 * Collect all views from the manifest route table.
 */
export function collectReadViews(manifest) {
  const { views } = buildRouteTable(manifest);
  return views;
}
