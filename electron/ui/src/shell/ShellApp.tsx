import React, { useCallback, useRef } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import { Titlebar } from "./Titlebar";
import { Topbar } from "./Topbar";
import { ActivityBar } from "./ActivityBar";
import { RightPanel } from "./RightPanel";
import { StatusBar } from "./StatusBar";
import { DashboardPanel } from "./panels/DashboardPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { ExecutionPanel } from "./panels/ExecutionPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { useBrowserWire } from "./hooks/useBrowserWire";
import { useLayout } from "./hooks/useLayout";

export function ShellApp() {
  const bw = useBrowserWire();
  const layout = useLayout();
  const autoSelectRef = useRef<string | null>(null);
  const autoSelectSiteRef = useRef<string | null>(null);

  const isDiscovery = layout.activeMode === "discovery";

  const handleStopExploring = useCallback(async (note?: string) => {
    const result = await bw.stopExploring(note);
    if (result.ok && bw.lastSessionId) {
      autoSelectRef.current = bw.lastSessionId;
      layout.switchMode("history");
    }
    return result;
  }, [bw.stopExploring, bw.lastSessionId, layout.switchMode]);

  return (
    <TooltipProvider>
      <div className="h-screen overflow-hidden flex flex-col bg-background">
        <Titlebar />
        <div className="flex flex-1 min-h-0 relative">
          <ActivityBar
            activeMode={layout.activeMode}
            rightPanelOpen={layout.rightPanelOpen}
            onSwitchMode={layout.switchMode}
          />
          {isDiscovery ? (
            <>
              <div className="flex-1 flex flex-col min-w-0">
                <Topbar
                  url={bw.url}
                  canGoBack={bw.canGoBack}
                  canGoForward={bw.canGoForward}
                  loading={bw.loading}
                />
                {/* BrowserView placeholder — positioned by main.js */}
                <div className="flex-1" />
              </div>
              <RightPanel
                open={layout.rightPanelOpen}
                exploring={bw.exploring}
                llmConfigured={bw.llmConfigured}
                onStartExploring={bw.startExploring}
                onStopExploring={handleStopExploring}
                onGoToSettings={() => layout.switchMode("settings")}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col min-w-0 overflow-auto">
              {layout.activeMode === "dashboard" && (
                <DashboardPanel
                  port={bw.port}
                  onSwitchMode={layout.switchMode}
                  onOpenSite={(slug) => {
                    autoSelectSiteRef.current = slug;
                    layout.switchMode("execution");
                  }}
                  onOpenSession={(sessionId) => {
                    autoSelectRef.current = sessionId;
                    layout.switchMode("history");
                  }}
                />
              )}
              {layout.activeMode === "settings" && <SettingsPanel />}
              {layout.activeMode === "execution" && (
                <ExecutionPanel
                  autoSelectSlug={autoSelectSiteRef.current}
                  onAutoSelectConsumed={() => { autoSelectSiteRef.current = null; }}
                />
              )}
              {layout.activeMode === "history" && (
                <HistoryPanel
                  autoSelectSessionId={autoSelectRef.current}
                  onAutoSelectConsumed={() => { autoSelectRef.current = null; }}
                />
              )}
            </div>
          )}

        </div>
        <StatusBar
          port={bw.port}
          portOk={bw.portOk}
        />
      </div>
    </TooltipProvider>
  );
}
