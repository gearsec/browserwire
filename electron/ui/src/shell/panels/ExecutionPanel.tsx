import React, { useState, useEffect } from "react";
import { Loader2, Monitor, ChevronRight, ArrowLeft, Globe } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { Button } from "../../components/ui/button";
import { WorkflowCard } from "../execution/WorkflowCard";
import { useExecution } from "../hooks/useExecution";
import type { SiteInfo, Manifest, Page, WorkflowResult } from "../hooks/useExecution";

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
          {site.pageCount ?? 0} {(site.pageCount ?? 0) === 1 ? "page" : "pages"}
          {" · "}
          {site.workflowCount ?? 0} {(site.workflowCount ?? 0) === 1 ? "workflow" : "workflows"}
        </p>
      </div>
      <ChevronRight className="size-4 text-muted-foreground shrink-0" />
    </button>
  );
}

function PageSection({ page, children }: { page: Page; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium">{humanize(page.name)}</h3>
        <span className="text-xs text-muted-foreground">{page.routePattern}</span>
      </div>
      {children}
    </div>
  );
}

function SiteDetailView({
  site,
  manifest,
  results,
  onBack,
  onEnsureManifest,
  onExecuteWorkflow,
}: {
  site: SiteInfo;
  manifest: Manifest | undefined;
  results: Map<string, WorkflowResult>;
  onBack: () => void;
  onEnsureManifest: (slug: string) => void;
  onExecuteWorkflow: (slug: string, name: string, inputs: Record<string, any>) => void;
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
      ) : (
        (() => {
          const pagesWithWorkflows = (manifest.pages || []).filter(
            (p) => p.workflows && p.workflows.length > 0
          );

          if (pagesWithWorkflows.length === 0) {
            return (
              <Alert>
                <AlertDescription>No workflows discovered for this site.</AlertDescription>
              </Alert>
            );
          }

          return (
            <div className="flex flex-col gap-4">
              {pagesWithWorkflows.map((page) => (
                <PageSection key={page.name} page={page}>
                  {page.workflows!.map((wf) => (
                    <WorkflowCard
                      key={wf.name}
                      workflow={wf}
                      result={results.get(`${site.slug}/${wf.name}`)}
                      onExecute={(inputs) => onExecuteWorkflow(site.slug, wf.name, inputs)}
                    />
                  ))}
                </PageSection>
              ))}
            </div>
          );
        })()
      )}
    </div>
  );
}

export function ExecutionPanel() {
  const { sites, manifests, results, loadingSites, executing, ensureManifest, executeWorkflow } =
    useExecution();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // Eagerly load manifests for all sites (for workflow counts in list view)
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

  if (executing) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <Alert className="max-w-sm">
          <Monitor className="size-4" />
          <AlertTitle>Workflow running…</AlertTitle>
          <AlertDescription>Watch the browser window to see the workflow execute.</AlertDescription>
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
          results={results}
          onBack={() => setSelectedSlug(null)}
          onEnsureManifest={ensureManifest}
          onExecuteWorkflow={executeWorkflow}
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
