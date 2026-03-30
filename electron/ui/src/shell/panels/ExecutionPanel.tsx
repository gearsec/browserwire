import React, { useState, useEffect } from "react";
import { Loader2, ChevronRight, ArrowLeft, Globe, Eye, Zap } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card, CardContent } from "../../components/ui/card";
import { useExecution } from "../hooks/useExecution";
import type { SiteInfo, StateManifest } from "../hooks/useExecution";

function humanize(name: string): string {
  return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

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

function SiteDetailView({
  site,
  manifest,
  onBack,
  onEnsureManifest,
}: {
  site: SiteInfo;
  manifest: StateManifest | undefined;
  onBack: () => void;
  onEnsureManifest: (slug: string) => void;
}) {
  useEffect(() => {
    onEnsureManifest(site.slug);
  }, [site.slug, onEnsureManifest]);

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

      {!manifest ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading manifest…
        </div>
      ) : manifest.states?.length === 0 ? (
        <Alert>
          <AlertDescription>No states discovered for this site.</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          {manifest.states.map((state) => (
            <Card key={state.id}>
              <CardContent className="p-4 flex flex-col gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{humanize(state.name)}</span>
                    <Badge variant="outline" className="text-[10px]">{state.id}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">{state.url_pattern}</p>
                  {state.description && (
                    <p className="text-xs text-muted-foreground mt-1">{state.description}</p>
                  )}
                </div>

                {state.views.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Views</p>
                    <div className="flex flex-wrap gap-1.5">
                      {state.views.map((view) => (
                        <Badge key={view.name} variant="secondary" className="text-xs gap-1">
                          <Eye className="size-3" />
                          {view.name}
                          {view.isList && <span className="text-muted-foreground">[]</span>}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                {state.actions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">Actions</p>
                    <div className="flex flex-wrap gap-1.5">
                      {state.actions.map((action) => (
                        <Badge key={action.name} variant="outline" className="text-xs gap-1">
                          <Zap className="size-3" />
                          {action.name}
                          {action.leads_to && (
                            <span className="text-muted-foreground">→ {action.leads_to}</span>
                          )}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export function ExecutionPanel() {
  const { sites, manifests, loadingSites, ensureManifest } = useExecution();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  useEffect(() => {
    sites.forEach((s) => ensureManifest(s.slug));
  }, [sites, ensureManifest]);

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
          manifest={manifests.get(selectedSite.slug)}
          onBack={() => setSelectedSlug(null)}
          onEnsureManifest={ensureManifest}
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
