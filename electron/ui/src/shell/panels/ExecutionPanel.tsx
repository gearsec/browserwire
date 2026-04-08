import React, { useState, useEffect, useCallback } from "react";
import {
  Loader2,
  ChevronRight,
  ChevronDown,
  ArrowLeft,
  Globe,
  Play,
  Copy,
  Check,
} from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Card, CardContent } from "../../components/ui/card";
import { useExecution } from "../hooks/useExecution";
import type { SiteInfo, Endpoint } from "../hooks/useExecution";

function SiteCard({ site, onClick }: { site: SiteInfo; onClick: () => void }) {
  return (
    <button
      className="w-full text-left rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors flex items-center gap-3 cursor-pointer"
      onClick={onClick}
    >
      <Globe className="size-5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">
          {site.slug.replace(/_/g, ".")}
        </p>
        <p className="text-xs text-muted-foreground">
          {site.stateCount ?? 0} {(site.stateCount ?? 0) === 1 ? "state" : "states"}
          {" · "}
          {site.viewCount ?? 0} {(site.viewCount ?? 0) === 1 ? "view" : "views"}
          {" · "}
          {site.actionCount ?? 0} {(site.actionCount ?? 0) === 1 ? "action" : "actions"}
        </p>
      </div>
      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function EndpointCard({
  endpoint,
  onExecute,
}: {
  endpoint: Endpoint;
  onExecute: (method: string, path: string, params: Record<string, string>) => Promise<any>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    setResponse(null);
    setError(null);
    try {
      const result = await onExecute(endpoint.method, endpoint.path, params);
      setResponse(result);
    } catch (err: any) {
      setError(err.message || "Request failed");
    } finally {
      setRunning(false);
    }
  };

  const handleCopy = () => {
    if (response) {
      navigator.clipboard.writeText(JSON.stringify(response, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const isGet = endpoint.method === "GET";

  // Extract short name from path (last segment)
  const shortName = endpoint.path.split("/").pop() || endpoint.operationId;

  return (
    <Card>
      <button
        className="w-full text-left p-3 flex items-center gap-2 hover:bg-accent/50 transition-colors cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <Badge
          variant="secondary"
          className={`text-[10px] font-mono shrink-0 ${
            isGet ? "bg-success/15 text-success" : "bg-primary/15 text-primary"
          }`}
        >
          {endpoint.method}
        </Badge>
        <span className="text-sm font-medium truncate flex-1">{shortName}</span>
        {endpoint.summary && (
          <span className="text-xs text-muted-foreground truncate max-w-[200px]">
            {endpoint.summary}
          </span>
        )}
        {expanded ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <CardContent className="px-3 pb-3 pt-0 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground font-mono">{endpoint.path}</p>

          {endpoint.parameters.length > 0 && (
            <div className="flex flex-col gap-2">
              {endpoint.parameters.map((p) => (
                <div key={p.name} className="flex flex-col gap-1">
                  <Label className="text-xs">
                    {p.name}
                    {p.required && <span className="text-destructive ml-0.5">*</span>}
                    {p.description && (
                      <span className="text-muted-foreground font-normal ml-1">
                        — {p.description}
                      </span>
                    )}
                  </Label>
                  <Input
                    className="h-7 text-xs font-mono"
                    placeholder={p.type}
                    value={params[p.name] || ""}
                    onChange={(e) =>
                      setParams((prev) => ({ ...prev, [p.name]: e.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          )}

          <Button
            size="sm"
            className="self-start gap-1.5"
            onClick={handleRun}
            disabled={running}
          >
            {running ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Play className="size-3" />
            )}
            {running ? "Running…" : "Run"}
          </Button>

          {error && (
            <Alert variant="destructive" className="py-2">
              <AlertDescription className="text-xs">{error}</AlertDescription>
            </Alert>
          )}

          {response && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Response</span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 text-xs"
                  onClick={handleCopy}
                >
                  {copied ? (
                    <Check className="size-3 text-success" />
                  ) : (
                    <Copy className="size-3" />
                  )}
                  {copied ? "Copied" : "Copy JSON"}
                </Button>
              </div>
              <pre className="text-xs font-mono bg-muted rounded-md p-3 overflow-auto max-h-[400px] whitespace-pre-wrap break-all">
                {JSON.stringify(response, null, 2)}
              </pre>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function SiteDetailView({
  site,
  siteEndpoints,
  onBack,
  onEnsure,
  onExecute,
}: {
  site: SiteInfo;
  siteEndpoints: Endpoint[] | undefined;
  onBack: () => void;
  onEnsure: (slug: string) => void;
  onExecute: (method: string, path: string, params: Record<string, string>) => Promise<any>;
}) {
  useEffect(() => {
    onEnsure(site.slug);
  }, [site.slug, onEnsure]);

  // Group endpoints by tag
  const grouped = new Map<string, Endpoint[]>();
  if (siteEndpoints) {
    for (const ep of siteEndpoints) {
      const tag = ep.tags[0] || "Other";
      if (!grouped.has(tag)) grouped.set(tag, []);
      grouped.get(tag)!.push(ep);
    }
  }

  return (
    <div className="max-w-2xl mx-auto p-6 flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={onBack} className="gap-1 -ml-2">
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <h2 className="text-sm font-semibold">
          {site.slug.replace(/_/g, ".")}
        </h2>
      </div>

      {!siteEndpoints ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading endpoints…
        </div>
      ) : siteEndpoints.length === 0 ? (
        <Alert>
          <AlertDescription>No endpoints discovered for this site.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-5">
          {Array.from(grouped.entries()).map(([tag, eps]) => (
            <div key={tag} className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {tag.replace(/_/g, " ")}
              </h3>
              {eps.map((ep) => (
                <EndpointCard
                  key={`${ep.method}-${ep.path}`}
                  endpoint={ep}
                  onExecute={onExecute}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExecutionPanel() {
  const {
    sites,
    endpoints,
    loadingSites,
    ensureOpenApiSpec,
    executeEndpoint,
  } = useExecution();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  useEffect(() => {
    sites.forEach((s) => ensureOpenApiSpec(s.slug));
  }, [sites, ensureOpenApiSpec]);

  if (loadingSites) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sites.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <Alert className="max-w-sm">
          <AlertTitle>No sites discovered yet</AlertTitle>
          <AlertDescription>Run a discovery session to get started.</AlertDescription>
        </Alert>
      </div>
    );
  }

  const selectedSite = selectedSlug ? sites.find((s) => s.slug === selectedSlug) : null;

  if (selectedSite) {
    return (
      <ScrollArea className="flex-1">
        <SiteDetailView
          site={selectedSite}
          siteEndpoints={endpoints.get(selectedSite.slug)}
          onBack={() => setSelectedSlug(null)}
          onEnsure={ensureOpenApiSpec}
          onExecute={executeEndpoint}
        />
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-2xl mx-auto p-6 flex flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          API Explorer
        </h2>
        {sites.map((site) => (
          <SiteCard key={site.slug} site={site} onClick={() => setSelectedSlug(site.slug)} />
        ))}
      </div>
    </ScrollArea>
  );
}
