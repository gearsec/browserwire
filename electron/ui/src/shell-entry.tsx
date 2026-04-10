import React from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { ShellApp } from "./shell/ShellApp";

// Initialize PostHog session replay + autocapture in the renderer
const phConfig = window.browserwire?.posthogConfig;
if (phConfig?.apiKey) {
  posthog.init(phConfig.apiKey, {
    api_host: phConfig.host,
    autocapture: true,
    capture_pageview: false,
    persistence: "localStorage",
    disable_session_recording: false,
    session_recording: { recordBody: true },
  });
  if (phConfig.distinctId) {
    posthog.identify(phConfig.distinctId);
  }
  posthog.startSessionRecording();
  posthog.debug(true);
}

const root = createRoot(document.getElementById("root")!);
root.render(<ShellApp />);
