import { useState, useEffect, useCallback } from "react";

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
    actions: { name: string; kind: string; description: string; leads_to: string | null; inputs?: { name: string; type: string; required: boolean }[] }[];
  }[];
}

const API = window.browserwire.apiBaseUrl;

export function useExecution() {
  const [sites, setSites] = useState<SiteInfo[]>([]);
  const [manifests, setManifests] = useState<Map<string, StateManifest>>(new Map());
  const [loadingSites, setLoadingSites] = useState(true);

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
    loadingSites,
    ensureManifest,
    refreshSites,
  };
}

export type { SiteInfo, StateManifest };
