import { useState, useEffect, useCallback } from "react";

interface SiteInfo {
  slug: string;
  origin: string;
  domain?: string;
  pageCount?: number;
  workflowCount?: number;
  updatedAt?: string;
}

interface WorkflowInput {
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

interface WorkflowStep {
  type: string;
  url?: string;
  endpoint_name?: string;
  input_param?: string;
  view_name?: string;
}

interface Workflow {
  name: string;
  kind: string;
  description: string;
  inputs: WorkflowInput[];
  steps: WorkflowStep[];
  outcomes?: object;
}

interface Page {
  name: string;
  routePattern: string;
  description?: string;
  workflows?: Workflow[];
  views?: object[];
  endpoints?: object[];
}

interface Manifest {
  domain?: string;
  domainDescription?: string;
  pages: Page[];
}

interface WorkflowResult {
  loading: boolean;
  ok?: boolean;
  data?: any;
  outcome?: string;
  error?: string;
  message?: string;
}

const API = window.browserwire.apiBaseUrl;

export function useExecution() {
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [manifests, setManifests] = useState<Map<string, Manifest>>(new Map());
  const [results, setResults] = useState<Map<string, WorkflowResult>>(new Map());
  const [loadingSites, setLoadingSites] = useState(true);
  const [executing, setExecuting] = useState(false);

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

  // Listen for execution state changes from main process
  useEffect(() => {
    const cleanup = window.browserwire.onExecutionState((state) => {
      setExecuting(state.running);
    });
    return cleanup;
  }, []);

  // Fetch manifest for a site (idempotent)
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

  // Execute a workflow via IPC (uses main BrowserView)
  const executeWorkflow = useCallback(
    async (slug: string, workflowName: string, inputs: Record<string, any>) => {
      const key = `${slug}/${workflowName}`;
      setResults((prev) => {
        const next = new Map(prev);
        next.set(key, { loading: true });
        return next;
      });

      try {
        const result = await window.browserwire.executeWorkflow({
          slug,
          workflowName,
          inputs,
        });
        setResults((prev) => {
          const next = new Map(prev);
          next.set(key, { loading: false, ...result });
          return next;
        });
      } catch (err: any) {
        setResults((prev) => {
          const next = new Map(prev);
          next.set(key, { loading: false, ok: false, error: err.message });
          return next;
        });
      }
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
    results,
    loadingSites,
    executing,
    ensureManifest,
    executeWorkflow,
    refreshSites,
  };
}

export type { SiteInfo, Manifest, Page, Workflow, WorkflowInput, WorkflowResult };
