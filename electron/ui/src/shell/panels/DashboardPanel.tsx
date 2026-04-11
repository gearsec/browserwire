import React, { useEffect } from "react";
import {
  Globe,
  Clock,
  Layers,
  Radio,
  ArrowRight,
  Compass,
  Check,
  Loader2,
  AlertCircle,
  ExternalLink,
} from "lucide-react";
import { Button } from "../../components/ui/button";
import { Card, CardContent } from "../../components/ui/card";
import { Badge } from "../../components/ui/badge";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Separator } from "../../components/ui/separator";
import { useExecution } from "../hooks/useExecution";
import { useHistory } from "../hooks/useHistory";
import type { SiteInfo } from "../hooks/useExecution";
import type { SessionSummary } from "../hooks/useHistory";
import type { Mode } from "../hooks/useLayout";

function formatRelativeTime(iso: string): string {
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  } catch {
    return iso;
  }
}

function SiteCard({
  site,
  port,
  onClick,
}: {
  site: SiteInfo;
  port: number;
  onClick: () => void;
}) {
  const domain = site.slug.replace(/_/g, ".");

  return (
    <Card
      className="cursor-pointer hover:bg-accent/50 transition-colors"
      onClick={onClick}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Globe className="size-4 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{domain}</span>
          </div>
          <a
            href={`http://127.0.0.1:${port}/api/sites/${site.slug}/docs`}
            target="_blank"
            rel="noopener"
            onClick={(e) => e.stopPropagation()}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            <ExternalLink className="size-3.5" />
          </a>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Badge variant="secondary" className="text-xs">
            <Layers className="size-3 mr-1" />
            {site.stateCount ?? 0} states
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {site.viewCount ?? 0} views
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {site.actionCount ?? 0} actions
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionRow({
  session,
  onClick,
}: {
  session: SessionSummary;
  onClick: () => void;
}) {
  return (
    <button
      className="w-full text-left flex items-center gap-3 p-2.5 rounded-md hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={onClick}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium truncate">{session.origin}</div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className="size-3" />
          <span>{formatRelativeTime(session.startedAt)}</span>
          <span className="flex items-center gap-1">
            <Layers className="size-3" />
            {session.snapshotCount}
          </span>
          <span className="flex items-center gap-1">
            <Radio className="size-3" />
            {session.eventCount}
          </span>
        </div>
      </div>
      {session.trainingStatus === "training" ? (
        <Loader2 className="size-4 animate-spin text-primary shrink-0" />
      ) : session.trainingStatus === "error" ? (
        <AlertCircle className="size-4 text-destructive shrink-0" />
      ) : (
        <Check className="size-4 text-green-500 shrink-0" />
      )}
    </button>
  );
}

interface DashboardPanelProps {
  port: number;
  onSwitchMode: (mode: Mode) => void;
  onOpenSite: (slug: string) => void;
  onOpenSession: (sessionId: string) => void;
}

export function DashboardPanel({ port, onSwitchMode, onOpenSite, onOpenSession }: DashboardPanelProps) {
  const { sites, loadingSites } = useExecution();
  const history = useHistory();

  useEffect(() => {
    history.loadSessions();
  }, []);

  const recentSessions = history.sessions.slice(0, 5);
  const hasSites = sites.length > 0;
  const hasSessions = recentSessions.length > 0;
  const isEmpty = !hasSites && !hasSessions && !loadingSites && !history.loading;

  return (
    <ScrollArea className="flex-1">
      <div className="max-w-5xl mx-auto p-6">
        {/* Two-column layout */}
        <div className="flex gap-6">
          {/* Left column — CTA + Sites */}
          <div className="flex-1 min-w-0 flex flex-col gap-6">
            {/* Quick Start CTA */}
            <div className="rounded-lg border border-border bg-card p-6">
              <h1 className="text-xl font-semibold mb-1">
                Browse any website. Get a typed API.
              </h1>
              <p className="text-sm text-muted-foreground mb-4">
                Navigate a site, record your interactions, and BrowserWire generates a REST API automatically.
              </p>
              <Button onClick={() => onSwitchMode("discovery")} className="gap-2">
                <Compass className="size-4" />
                Start New Discovery
              </Button>

              {/* First-time empty state: show how it works */}
              {isEmpty && (
                <div className="mt-6 pt-4 border-t border-border">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">
                    How it works
                  </p>
                  <div className="flex gap-4">
                    <div className="flex-1 text-center">
                      <div className="text-2xl mb-1">1</div>
                      <p className="text-xs text-muted-foreground">Navigate a website</p>
                    </div>
                    <div className="flex-1 text-center">
                      <div className="text-2xl mb-1">2</div>
                      <p className="text-xs text-muted-foreground">We record your interactions</p>
                    </div>
                    <div className="flex-1 text-center">
                      <div className="text-2xl mb-1">3</div>
                      <p className="text-xs text-muted-foreground">Get a REST API</p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Discovered Sites Grid */}
            {loadingSites ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading sites...
              </div>
            ) : hasSites ? (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                    Discovered Sites
                  </h2>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={() => onSwitchMode("execution")}
                  >
                    View All
                    <ArrowRight className="size-3" />
                  </Button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {sites.map((site) => (
                    <SiteCard
                      key={site.slug}
                      site={site}
                      port={port}
                      onClick={() => onOpenSite(site.slug)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          {/* Right column — Recent Sessions */}
          <div className="w-72 shrink-0">
            <div className="sticky top-0">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent Sessions
                </h2>
                {hasSessions && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs gap-1"
                    onClick={() => onSwitchMode("history")}
                  >
                    View All
                    <ArrowRight className="size-3" />
                  </Button>
                )}
              </div>

              {history.loading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
                  <Loader2 className="size-4 animate-spin" />
                  Loading...
                </div>
              ) : hasSessions ? (
                <div className="flex flex-col gap-1 rounded-lg border border-border bg-card p-2">
                  {recentSessions.map((session) => (
                    <SessionRow
                      key={session.sessionId}
                      session={session}
                      onClick={() => onOpenSession(session.sessionId)}
                    />
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <Layers className="size-8 mx-auto mb-2 text-muted-foreground/50" />
                  <p className="text-sm text-muted-foreground">No sessions yet</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Start exploring a site to create a recording
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
