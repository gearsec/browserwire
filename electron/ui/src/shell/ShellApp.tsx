import React, { useCallback, useRef } from "react";
import { TooltipProvider } from "../components/ui/tooltip";
import { TourCard } from "../components/TourTooltip";
import { Titlebar } from "./Titlebar";
import { Topbar } from "./Topbar";
import { ActivityBar } from "./ActivityBar";
import { RightPanel } from "./RightPanel";
import { StatusBar } from "./StatusBar";
import { SettingsPanel } from "./panels/SettingsPanel";
import { ExecutionPanel } from "./panels/ExecutionPanel";
import { HistoryPanel } from "./panels/HistoryPanel";
import { useBrowserWire } from "./hooks/useBrowserWire";
import { useLayout } from "./hooks/useLayout";
import { useTour } from "./hooks/useTour";

export function ShellApp() {
  const bw = useBrowserWire();
  const layout = useLayout();
  const tour = useTour();
  const autoSelectRef = useRef<string | null>(null);

  const isDiscovery = layout.activeMode === "discovery";

  const handleStopExploring = useCallback(async (note?: string) => {
    return await bw.stopExploring(note);
  }, [bw.stopExploring]);

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
                sessionStatus={bw.sessionStatus}
                batches={bw.batches}
                llmConfigured={bw.llmConfigured}
                onStartExploring={bw.startExploring}
                onStopExploring={handleStopExploring}
                onGoToSettings={() => layout.switchMode("settings")}
              />
            </>
          ) : (
            <div className="flex-1 flex flex-col min-w-0 overflow-auto">
              {layout.activeMode === "settings" && <SettingsPanel />}
              {layout.activeMode === "execution" && <ExecutionPanel />}
              {layout.activeMode === "history" && (
                <HistoryPanel
                  autoSelectSessionId={autoSelectRef.current}
                  onAutoSelectConsumed={() => { autoSelectRef.current = null; }}
                />
              )}
            </div>
          )}

          {/* Product tour card — positioned in the right panel area */}
          {tour.currentStep && (
            <TourCard
              title={tour.currentStep.title}
              content={tour.currentStep.content}
              stepIndex={tour.stepIndex}
              totalSteps={tour.totalSteps}
              isFirst={tour.isFirst}
              isLast={tour.isLast}
              onNext={tour.next}
              onBack={tour.back}
              onSkip={tour.skip}
            />
          )}
        </div>
        <StatusBar
          port={bw.port}
          portOk={bw.portOk}
          onStartTour={tour.startTour}
        />
      </div>
    </TooltipProvider>
  );
}
