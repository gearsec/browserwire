import { useState, useEffect, useCallback, useRef } from "react";

interface SiteInfo {
  slug: string;
  origin: string;
  domain?: string;
  stateCount?: number;
  viewCount?: number;
  actionCount?: number;
  updatedAt?: string;
}

interface StateManifest {
  domain?: string;
  domainDescription?: string;
  initial_state?: string;
  states: {
    id: string;
    name: string;
    description: string;
    url_pattern: string;
    views: { name: string; description: string; isList: boolean; returns: { name: string; type: string }[] }[];
    actions: { name: string; kind: string; description: string; to_state: string; inputs?: { name: string; type: string; required: boolean }[] }[];
  }[];
}

interface OpenApiParam {
  name: string;
  in: "query" | "path";
  required?: boolean;
  description?: string;
  schema?: { type: string };
}

interface OpenApiSpec {
  paths: Record<string, Record<string, {
    operationId: string;
    summary?: string;
    tags?: string[];
    parameters?: OpenApiParam[];
    requestBody?: {
      required?: boolean;
      content?: {
        "application/json"?: {
          schema?: {
            type: string;
            properties?: Record<string, { type: string; description?: string }>;
            required?: string[];
          };
        };
      };
    };
    responses?: Record<string, any>;
  }>>;
  info?: { title?: string; description?: string };
}

export interface Endpoint {
  method: "GET" | "POST";
  path: string;
  operationId: string;
  summary: string;
  tags: string[];
  parameters: { name: string; required: boolean; description: string; type: string }[];
}

const API = window.browserwire.apiBaseUrl;

function parseEndpoints(spec: OpenApiSpec): Endpoint[] {
  const endpoints: Endpoint[] = [];
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const [method, op] of Object.entries(methods)) {
      const m = method.toUpperCase() as "GET" | "POST";
      const params: Endpoint["parameters"] = [];

      if (op.parameters) {
        for (const p of op.parameters) {
          params.push({
            name: p.name,
            required: !!p.required,
            description: p.description || "",
            type: p.schema?.type || "string",
          });
        }
      }

      if (op.requestBody?.content?.["application/json"]?.schema) {
        const schema = op.requestBody.content["application/json"].schema;
        const requiredFields = schema.required || [];
        for (const [name, prop] of Object.entries(schema.properties || {})) {
          params.push({
            name,
            required: requiredFields.includes(name),
            description: prop.description || "",
            type: prop.type || "string",
          });
        }
      }

      endpoints.push({
        method: m,
        path,
        operationId: op.operationId || "",
        summary: op.summary || "",
        tags: op.tags || [],
        parameters: params,
      });
    }
  }
  return endpoints;
}

export function useExecution() {
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [manifests, setManifests] = useState<Map<string, StateManifest>>(new Map());
  const [openApiSpecs, setOpenApiSpecs] = useState<Map<string, OpenApiSpec>>(new Map());
  const [endpoints, setEndpoints] = useState<Map<string, Endpoint[]>>(new Map());
  const [loadingSites, setLoadingSites] = useState(true);
  const fetchedSpecs = useRef<Set<string>>(new Set());

  // Fetch sites on mount
  useEffect(() => {
    fetch(`${API}/api/sites`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok && data.sites) {
          setSites(data.sites);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingSites(false));
  }, []);

  // Fetch manifest for a site
  const ensureManifest = useCallback(
    async (slug: string) => {
      if (manifests.has(slug)) return;
      try {
        const r = await fetch(`${API}/api/sites/${slug}/manifest`);
        const manifest = await r.json();
        setManifests((prev) => {
          const next = new Map(prev);
          next.set(slug, manifest);
          return next;
        });
      } catch {
        // ignore
      }
    },
    [manifests]
  );

  // Fetch OpenAPI spec for a site
  const ensureOpenApiSpec = useCallback(
    async (slug: string) => {
      if (fetchedSpecs.current.has(slug)) return;
      fetchedSpecs.current.add(slug);
      try {
        const r = await fetch(`${API}/api/sites/${slug}/openapi.json`);
        const spec: OpenApiSpec = await r.json();
        setOpenApiSpecs((prev) => {
          const next = new Map(prev);
          next.set(slug, spec);
          return next;
        });
        setEndpoints((prev) => {
          const next = new Map(prev);
          next.set(slug, parseEndpoints(spec));
          return next;
        });
      } catch {
        // ignore
      }
    },
    []
  );

  // Execute an endpoint
  const executeEndpoint = useCallback(
    async (method: string, path: string, params: Record<string, string>): Promise<any> => {
      const url = new URL(`${API}${path}`);
      if (method === "GET") {
        for (const [k, v] of Object.entries(params)) {
          if (v) url.searchParams.set(k, v);
        }
      }
      const resp = await fetch(url.toString(), {
        method,
        ...(method === "POST"
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) }
          : {}),
      });
      return resp.json();
    },
    []
  );

  // Refresh sites list
  const refreshSites = useCallback(async () => {
    try {
      const r = await fetch(`${API}/api/sites`);
      const data = await r.json();
      if (data.ok && data.sites) {
        setSites(data.sites);
      }
    } catch {
      // ignore
    }
  }, []);

  return {
    sites,
    manifests,
    endpoints,
    loadingSites,
    ensureManifest,
    ensureOpenApiSpec,
    executeEndpoint,
    refreshSites,
  };
}

export type { SiteInfo, StateManifest, OpenApiSpec };
