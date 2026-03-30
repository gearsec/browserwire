/**
 * main.js — Electron main process entry for BrowserWire desktop app.
 *
 * Runs the core SessionManager directly (no WS needed), embeds a Chromium
 * browser pane, and wires IPC between the shell UI and the capture pipeline.
 */

import { app, BrowserWindow, BrowserView, ipcMain, session, Menu, safeStorage, dialog } from "electron";
import { createServer } from "node:http";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

import { loadConfig, readConfigFile, writeConfigFile, reloadConfig, getConfig, PROVIDER_DEFAULTS } from "../core/config.js";
import { SessionManager } from "../core/session-manager.js";
import { ManifestStore } from "../core/manifest-store.js";
import { createHttpHandler } from "../core/api/router.js";
import { createSessionBridge } from "./capture/session-bridge.js";
import { executeViaElectron, setCDPPort } from "./capture/execution-bridge.js";
import { initUpdater } from "./updater.js";

const CDP_PORT = 9223;
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Global State ────────────────────────────────────────────────────────────

let mainWindow = null;
let browserView = null;
let overlayWindow = null;
let sessionManager = null;
let sessionBridge = null;
let httpServer = null;
let activePort = 8787;
let portOk = false;

// ─── Layout Constants ─────────────────────────────────────────────────────────

const ACTIVITY_BAR_WIDTH = 48;
const TITLEBAR_HEIGHT = 38;
const TOPBAR_HEIGHT = 48;
const STATUS_BAR_HEIGHT = 24;
const RIGHT_PANEL_WIDTH = 320;

// Dynamic panel state (updated via IPC from renderer)
let rightPanelOpen = true;
let activeMode = "discovery";
let browserViewAttached = true;
let navBarExpanded = false;
const NAV_BAR_EXPANDED_WIDTH = 160;

// ─── App Menu ────────────────────────────────────────────────────────────────

const buildAppMenu = () => {
  const template = [
    {
      label: app.name,
      submenu: [
        { label: "About BrowserWire", role: "about" },
        { type: "separator" },
        {
          label: "Settings\u2026",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            // Switch to settings mode in the renderer
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("browserwire:switch-mode", "settings");
            }
          },
        },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

// ─── Config & Startup ────────────────────────────────────────────────────────

const startApp = async () => {
  // Ensure data directory
  mkdirSync(resolve(homedir(), ".browserwire"), { recursive: true });

  // Load config — non-strict so app boots even without LLM config.
  // LLM config is only needed when discovery actually runs.
  let config = loadConfig({}, { strict: false });

  // Decrypt API keys from safeStorage if available
  const fileConfig = readConfigFile();
  const overrides = {};

  if (fileConfig.llmApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      overrides.llmApiKey = safeStorage.decryptString(
        Buffer.from(fileConfig.llmApiKeyEncrypted, "base64")
      );
    } catch (err) {
      console.warn("[browserwire] Failed to decrypt LLM API key:", err.message);
    }
  }

  if (fileConfig.langsmithApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      overrides.langsmithApiKey = safeStorage.decryptString(
        Buffer.from(fileConfig.langsmithApiKeyEncrypted, "base64")
      );
    } catch (err) {
      console.warn("[browserwire] Failed to decrypt LangSmith API key:", err.message);
    }
  }

  if (Object.keys(overrides).length > 0) {
    config = reloadConfig(overrides);
  }

  // Initialize telemetry (no-op if no LangSmith key configured)
  const { initTelemetry } = await import("../core/telemetry.js");
  await initTelemetry();

  const host = config.host || "127.0.0.1";
  const port = config.port || 8787;

  // Build application menu (with Settings shortcut)
  buildAppMenu();

  // Initialize SessionManager (uses ElectronBrowser factory — set by session-bridge)
  sessionManager = new SessionManager(new ManifestStore(), { host, port });
  await sessionManager.loadManifests();

  // Configure CDP port for execution bridge
  setCDPPort(CDP_PORT);

  // Start HTTP server (REST API)
  const httpHandler = createHttpHandler({
    getManifestBySlug: (slug) => sessionManager.getManifestBySlug(slug),
    listSites: () => sessionManager.listSites(),
    execute: (opts) => executeViaElectron({ ...opts, parentWindow: mainWindow }),
    host,
    port,
  });

  httpServer = createServer(httpHandler);
  await new Promise((resolve) => {
    httpServer.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        portOk = false;
        activePort = port;
        console.error(`[browserwire-electron] Port ${port} is already in use`);
        dialog.showErrorBox(
          "Port In Use",
          `Port ${port} is already in use by another application.\n\nPlease change the server port in Settings (⌘,) and restart BrowserWire.`
        );
        resolve();
      } else {
        throw err;
      }
    });
    httpServer.listen(port, host, () => {
      portOk = true;
      activePort = port;
      console.log(`[browserwire-electron] REST API at http://${host}:${port}`);
      console.log(`[browserwire-electron] site index at http://${host}:${port}/api/docs`);
      resolve();
    });
  });

  // Create main window
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "BrowserWire",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      preload: resolve(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--browserwire-port=${port}`],
    },
  });

  // Create BrowserView for the embedded browser pane
  browserView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setBrowserView(browserView);

  // Load shell UI
  mainWindow.loadFile(resolve(__dirname, "ui/shell.html"));

  // Position browser view once shell loads
  mainWindow.webContents.on("did-finish-load", () => {
    layoutBrowserView();
  });

  mainWindow.on("resize", () => {
    layoutBrowserView();
  });

  // Wire browser view navigation events
  const bvWebContents = browserView.webContents;

  bvWebContents.on("did-navigate", () => {
    sendNavigationUpdate();
  });

  bvWebContents.on("did-navigate-in-page", () => {
    sendNavigationUpdate();
  });

  bvWebContents.on("did-start-loading", () => {
    mainWindow.webContents.send("browserwire:loading-changed", true);
  });

  bvWebContents.on("did-stop-loading", () => {
    mainWindow.webContents.send("browserwire:loading-changed", false);
  });

  bvWebContents.on("page-title-updated", () => {
    sendNavigationUpdate();
  });

  // Initialize session bridge (capture pipeline)
  sessionBridge = createSessionBridge({
    sessionManager,
    getBrowserView: () => browserView,
    sendToUI: (channel, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
      }
    },
    showOverlay: showSnapshotOverlay,
    hideOverlay: hideSnapshotOverlay,
  });

  // Wire IPC handlers
  wireIPC();

  // Auto-updater
  initUpdater();

  // Navigate to a default page
  bvWebContents.loadURL("https://www.google.com");
};

// ─── Layout ──────────────────────────────────────────────────────────────────

const layoutBrowserView = () => {
  if (!mainWindow || !browserView) return;

  // Only show BrowserView in discovery mode
  if (activeMode !== "discovery") {
    if (browserViewAttached) {
      mainWindow.removeBrowserView(browserView);
      browserViewAttached = false;
    }
    return;
  }

  // Attach BrowserView if not already attached
  if (!browserViewAttached) {
    mainWindow.setBrowserView(browserView);
    browserViewAttached = true;
  }

  const [winWidth, winHeight] = mainWindow.getContentSize();
  const barWidth = navBarExpanded ? NAV_BAR_EXPANDED_WIDTH : ACTIVITY_BAR_WIDTH;
  const x = barWidth;
  const y = TITLEBAR_HEIGHT + TOPBAR_HEIGHT;
  const width = winWidth - barWidth - (rightPanelOpen ? RIGHT_PANEL_WIDTH : 0);
  const height = winHeight - y - STATUS_BAR_HEIGHT;

  if (width > 0 && height > 0) {
    browserView.setBounds({ x, y, width, height });
    browserView.setAutoResize({ width: true, height: true });
  }
};

// ─── Snapshot Overlay ─────────────────────────────────────────────────────────

const OVERLAY_HTML = `data:text/html;charset=utf-8,${encodeURIComponent(`<!DOCTYPE html>
<html><head><style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: transparent; }
  body { display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.3); }
  .label { background: rgba(0,0,0,0.7); color: white; padding: 12px 24px; border-radius: 8px; font: 500 14px system-ui, sans-serif; }
</style></head><body><div class="label">Taking snapshot\u2026</div></body></html>`)}`;

const showSnapshotOverlay = () => {
  if (overlayWindow || !mainWindow || !browserView) return;

  const bounds = browserView.getBounds();
  const winBounds = mainWindow.getBounds();
  const contentBounds = mainWindow.getContentBounds();
  // Offset from window frame to content area
  const frameOffsetX = contentBounds.x - winBounds.x;
  const frameOffsetY = contentBounds.y - winBounds.y;

  overlayWindow = new BrowserWindow({
    parent: mainWindow,
    x: winBounds.x + frameOffsetX + bounds.x,
    y: winBounds.y + frameOffsetY + bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  overlayWindow.loadURL(OVERLAY_HTML);
  overlayWindow.once("ready-to-show", () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive();
    }
  });
};

const hideSnapshotOverlay = () => {
  if (!overlayWindow) return;
  try {
    if (!overlayWindow.isDestroyed()) overlayWindow.destroy();
  } catch { /* ignore */ }
  overlayWindow = null;
};

// ─── Navigation Helpers ──────────────────────────────────────────────────────

const sendNavigationUpdate = () => {
  if (!browserView || !mainWindow) return;
  const wc = browserView.webContents;
  const url = wc.getURL();
  const title = wc.getTitle();
  const canGoBack = wc.canGoBack();
  const canGoForward = wc.canGoForward();

  mainWindow.webContents.send("browserwire:url-changed", url);
  mainWindow.webContents.send("browserwire:navigation-state", {
    url,
    title,
    canGoBack,
    canGoForward,
  });
};

// ─── IPC Wiring ──────────────────────────────────────────────────────────────

const wireIPC = () => {
  // Navigation
  ipcMain.on("browserwire:navigate", (_event, url) => {
    if (!browserView) return;
    // Add protocol if missing
    let normalizedUrl = url;
    if (!/^https?:\/\//i.test(url)) {
      normalizedUrl = "https://" + url;
    }
    browserView.webContents.loadURL(normalizedUrl);
  });

  ipcMain.on("browserwire:go-back", () => {
    if (browserView?.webContents.canGoBack()) {
      browserView.webContents.goBack();
    }
  });

  ipcMain.on("browserwire:go-forward", () => {
    if (browserView?.webContents.canGoForward()) {
      browserView.webContents.goForward();
    }
  });

  ipcMain.on("browserwire:reload", () => {
    browserView?.webContents.reload();
  });

  // Layout reporting from renderer
  ipcMain.on("browserwire:layout-changed", (_event, state) => {
    rightPanelOpen = state.rightPanelOpen;
    activeMode = state.activeMode || "discovery";
    layoutBrowserView();
  });

  ipcMain.on("browserwire:navbar-hover", (_event, expanded) => {
    navBarExpanded = !!expanded;
    layoutBrowserView();
  });

  // Discovery session
  ipcMain.handle("browserwire:start-exploring", async () => {
    if (!sessionBridge) return { ok: false, error: "Not initialized" };
    try {
      const result = await sessionBridge.startExploring();
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("browserwire:stop-exploring", async (_event, note) => {
    if (!sessionBridge) return { ok: false, error: "Not initialized" };
    try {
      await sessionBridge.stopExploring(note);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Session history
  ipcMain.handle("browserwire:list-sessions", () => {
    const logsDir = resolve(homedir(), ".browserwire", "logs");
    if (!existsSync(logsDir)) return [];

    const sessions = [];
    for (const entry of readdirSync(logsDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
      const sessionDir = resolve(logsDir, entry.name);
      const metaPath = resolve(sessionDir, "session-recording.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8"));
        sessions.push(meta);
      } catch { /* skip corrupt files */ }
    }
    // Sort by startedAt descending (most recent first)
    sessions.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    return sessions;
  });

  ipcMain.handle("browserwire:load-session-events", async (_event, sessionId) => {
    const eventsPath = resolve(homedir(), ".browserwire", "logs", `session-${sessionId}`, "events.json");
    if (!existsSync(eventsPath)) return { ok: false, error: "Events file not found" };
    try {
      const events = JSON.parse(readFileSync(eventsPath, "utf8"));
      return { ok: true, events };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("browserwire:load-session-screenshot", async (_event, sessionId, snapshotId) => {
    const screenshotPath = resolve(homedir(), ".browserwire", "logs", `session-${sessionId}`, `${snapshotId}.jpg`);
    if (!existsSync(screenshotPath)) return { ok: false, error: "Screenshot not found" };
    try {
      const data = readFileSync(screenshotPath);
      return { ok: true, screenshot: data.toString("base64") };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("browserwire:retrain-session", async (_event, sessionId) => {
    const send = (channel, data) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
      }
    };
    try {
      await sessionManager.reprocessSession(sessionId, {
        onStatus: (status) => {
          send("browserwire:session-status", { sessionId, ...status });
          if (status.tool) {
            send("browserwire:log", `${status.tool}`);
          }
          if (status.status === "complete") {
            send("browserwire:session-status", { sessionId, status: "finalized" });
            send("browserwire:log",
              `Retrain ${sessionId}: complete (${status.totalToolCalls || 0} tool calls)`
            );
          }
          if (status.status === "error") {
            send("browserwire:log", `Retrain error: ${status.error}`);
          }
        },
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Settings
  ipcMain.handle("browserwire:get-settings", () => {
    const cfg = getConfig();
    const file = readConfigFile();
    return {
      provider: cfg.llmProvider || "",
      model: file.llmModel || "",
      baseUrl: file.llmBaseUrl || "",
      hasApiKey: !!(cfg.llmApiKey || file.llmApiKeyEncrypted),
      llmConfigured: !!cfg._llmConfigured,
      providerDefaults: PROVIDER_DEFAULTS,
      port: activePort,
      portOk,
      hasLangsmithKey: !!(cfg.langsmithApiKey || file.langsmithApiKeyEncrypted),
      langsmithProject: file.langsmithProject || "",
    };
  });

  ipcMain.handle("browserwire:save-settings", async (_event, settings) => {
    try {
      const fileFields = {};

      if (settings.provider !== undefined) fileFields.llmProvider = settings.provider || undefined;
      if (settings.model !== undefined) fileFields.llmModel = settings.model || undefined;
      if (settings.baseUrl !== undefined) fileFields.llmBaseUrl = settings.baseUrl || undefined;
      if (settings.port !== undefined) fileFields.port = settings.port ? Number(settings.port) : undefined;

      // Encrypt and store LLM API key
      if (settings.apiKey) {
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(settings.apiKey);
          fileFields.llmApiKeyEncrypted = encrypted.toString("base64");
          // Remove any plaintext key
          fileFields.llmApiKey = undefined;
        } else {
          console.warn("[browserwire] safeStorage not available — storing API key as plaintext");
          fileFields.llmApiKey = settings.apiKey;
        }
      }

      // Encrypt and store LangSmith API key
      if (settings.langsmithApiKey) {
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(settings.langsmithApiKey);
          fileFields.langsmithApiKeyEncrypted = encrypted.toString("base64");
          fileFields.langsmithApiKey = undefined;
        } else {
          fileFields.langsmithApiKey = settings.langsmithApiKey;
        }
      }
      if (settings.langsmithProject !== undefined) {
        fileFields.langsmithProject = settings.langsmithProject || undefined;
      }

      writeConfigFile(fileFields);

      // Reload config with decrypted keys in memory
      const overrides = {};
      if (settings.apiKey) {
        overrides.llmApiKey = settings.apiKey;
      } else {
        // Preserve existing decrypted LLM key
        const existing = readConfigFile();
        if (existing.llmApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
          try {
            overrides.llmApiKey = safeStorage.decryptString(
              Buffer.from(existing.llmApiKeyEncrypted, "base64")
            );
          } catch { /* ignore */ }
        }
      }

      // Decrypt LangSmith key for in-memory config
      if (settings.langsmithApiKey) {
        overrides.langsmithApiKey = settings.langsmithApiKey;
      } else {
        const existing = readConfigFile();
        if (existing.langsmithApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
          try {
            overrides.langsmithApiKey = safeStorage.decryptString(
              Buffer.from(existing.langsmithApiKeyEncrypted, "base64")
            );
          } catch { /* ignore */ }
        }
      }

      const newConfig = reloadConfig(overrides);

      // Re-initialize telemetry so new LangSmith key takes effect immediately
      if (overrides.langsmithApiKey) {
        const { initTelemetry } = await import("../core/telemetry.js");
        await initTelemetry();
      }

      // Notify main window of config change
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browserwire:config-changed", {
          llmConfigured: !!newConfig._llmConfigured,
          provider: newConfig.llmProvider || "",
          port: activePort,
          portOk,
        });
      }

      return { ok: true, llmConfigured: !!newConfig._llmConfigured };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
};

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(startApp);

app.on("window-all-closed", () => {
  if (httpServer) httpServer.close();
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    startApp();
  }
});
