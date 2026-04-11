/**
 * preload.js — Secure IPC bridge for the BrowserWire Electron shell.
 *
 * Exposes a minimal API to the renderer (shell UI) via contextBridge.
 * All communication between renderer and main process goes through these channels.
 */

const { contextBridge, ipcRenderer } = require("electron");

// Extract port from additionalArguments passed by main process
const portArg = process.argv.find((a) => a.startsWith("--browserwire-port="));
const port = portArg ? portArg.split("=")[1] : "8787";

contextBridge.exposeInMainWorld("browserwire", {
  // API base URL for REST calls from the renderer
  apiBaseUrl: `http://127.0.0.1:${port}`,

  // Navigation
  navigate: (url) => ipcRenderer.send("browserwire:navigate", url),
  goBack: () => ipcRenderer.send("browserwire:go-back"),
  goForward: () => ipcRenderer.send("browserwire:go-forward"),
  reload: () => ipcRenderer.send("browserwire:reload"),
  openDocs: () => ipcRenderer.send("browserwire:open-docs"),

  // Discovery session
  startExploring: () => ipcRenderer.invoke("browserwire:start-exploring"),
  stopExploring: (note) => ipcRenderer.invoke("browserwire:stop-exploring", note),


  // Session history
  listSessions: () => ipcRenderer.invoke("browserwire:list-sessions"),
  getTrainingStatus: () => ipcRenderer.invoke("browserwire:get-training-status"),
  loadSessionEvents: (sessionId) => ipcRenderer.invoke("browserwire:load-session-events", sessionId),
  loadSessionScreenshot: (sessionId, snapshotId) => ipcRenderer.invoke("browserwire:load-session-screenshot", sessionId, snapshotId),
  loadSessionSegmentation: (sessionId) => ipcRenderer.invoke("browserwire:load-session-segmentation", sessionId),
  retrainSession: (sessionId) => ipcRenderer.invoke("browserwire:retrain-session", sessionId),

  // Settings
  getSettings: () => ipcRenderer.invoke("browserwire:get-settings"),
  saveSettings: (settings) => ipcRenderer.invoke("browserwire:save-settings", settings),

  // Layout reporting
  reportLayout: (state) => ipcRenderer.send("browserwire:layout-changed", state),
  reportNavbarHover: (expanded) => ipcRenderer.send("browserwire:navbar-hover", expanded),

  // Analytics
  trackEvent: (event, properties) => ipcRenderer.send("browserwire:track-event", event, properties),
  posthogConfig: ipcRenderer.sendSync("browserwire:get-posthog-config"),

  // Listeners
  onUrlChanged: (callback) => {
    const handler = (_event, url) => callback(url);
    ipcRenderer.on("browserwire:url-changed", handler);
    return () => ipcRenderer.removeListener("browserwire:url-changed", handler);
  },

  onSessionStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("browserwire:session-status", handler);
    return () => ipcRenderer.removeListener("browserwire:session-status", handler);
  },

  onBatchStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on("browserwire:batch-status", handler);
    return () => ipcRenderer.removeListener("browserwire:batch-status", handler);
  },

  onLoadingChanged: (callback) => {
    const handler = (_event, loading) => callback(loading);
    ipcRenderer.on("browserwire:loading-changed", handler);
    return () => ipcRenderer.removeListener("browserwire:loading-changed", handler);
  },

  onNavigationState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("browserwire:navigation-state", handler);
    return () => ipcRenderer.removeListener("browserwire:navigation-state", handler);
  },

  onConfigChanged: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("browserwire:config-changed", handler);
    return () => ipcRenderer.removeListener("browserwire:config-changed", handler);
  },

  onSwitchMode: (callback) => {
    const handler = (_event, mode) => callback(mode);
    ipcRenderer.on("browserwire:switch-mode", handler);
    return () => ipcRenderer.removeListener("browserwire:switch-mode", handler);
  },
});
