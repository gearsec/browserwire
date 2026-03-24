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
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

import { loadConfig, readConfigFile, writeConfigFile, reloadConfig, getConfig, PROVIDER_DEFAULTS } from "../core/config.js";
import { SessionManager } from "../core/session-manager.js";
import { ManifestStore } from "../core/manifest-store.js";
import { collectReadViews } from "../core/api/openapi.js";
import { createHttpHandler } from "../core/api/router.js";
import { createSessionBridge } from "./capture/session-bridge.js";
import { createElectronBridge, executeWorkflowSteps } from "./capture/workflow-executor.js";
import { buildLookups, resolveWorkflowSteps, sanitize } from "../core/workflow-resolver.js";
import { initUpdater } from "./updater.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Global State ────────────────────────────────────────────────────────────

let mainWindow = null;
let browserView = null;
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

  // Decrypt API key from safeStorage if available
  const fileConfig = readConfigFile();
  if (fileConfig.llmApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
    try {
      const decrypted = safeStorage.decryptString(
        Buffer.from(fileConfig.llmApiKeyEncrypted, "base64")
      );
      config = reloadConfig({ llmApiKey: decrypted });
    } catch (err) {
      console.warn("[browserwire] Failed to decrypt API key:", err.message);
    }
  }

  const host = config.host || "127.0.0.1";
  const port = config.port || 8787;

  // Build application menu (with Settings shortcut)
  buildAppMenu();

  // Initialize SessionManager (uses ElectronBrowser factory — set by session-bridge)
  sessionManager = new SessionManager(new ManifestStore(), { host, port });
  await sessionManager.loadManifests();

  // Start HTTP server (REST API only, no WS)
  // Use Electron bridge that executes workflows directly via hidden BrowserWindow
  const bridge = createElectronBridge();

  const httpHandler = createHttpHandler({
    getManifestBySlug: (slug) => sessionManager.getManifestBySlug(slug),
    listSites: () => sessionManager.listSites({ collectReadViews }),
    bridge,
    getSocket: () => ({ readyState: 1 }), // Fake socket — Electron bridge doesn't need a real one
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
    };
  });

  ipcMain.handle("browserwire:save-settings", (_event, settings) => {
    try {
      const fileFields = {};

      if (settings.provider !== undefined) fileFields.llmProvider = settings.provider || undefined;
      if (settings.model !== undefined) fileFields.llmModel = settings.model || undefined;
      if (settings.baseUrl !== undefined) fileFields.llmBaseUrl = settings.baseUrl || undefined;
      if (settings.port !== undefined) fileFields.port = settings.port ? Number(settings.port) : undefined;

      // Encrypt and store API key
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

      writeConfigFile(fileFields);

      // Reload config with decrypted key in memory
      const overrides = {};
      if (settings.apiKey) {
        overrides.llmApiKey = settings.apiKey;
      } else {
        // Preserve existing decrypted key
        const existing = readConfigFile();
        if (existing.llmApiKeyEncrypted && safeStorage.isEncryptionAvailable()) {
          try {
            overrides.llmApiKey = safeStorage.decryptString(
              Buffer.from(existing.llmApiKeyEncrypted, "base64")
            );
          } catch { /* ignore */ }
        }
      }

      const newConfig = reloadConfig(overrides);

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

  // Workflow execution (from Execution tab — opens a visible window)
  ipcMain.handle("browserwire:execute-workflow", async (_event, { slug, workflowName, inputs }) => {
    if (!sessionManager) {
      return { ok: false, error: "Not initialized" };
    }

    const lookup = sessionManager.getManifestBySlug(slug);
    if (!lookup) return { ok: false, error: `Site '${slug}' not found` };
    const { manifest, origin } = lookup;

    // Resolve workflow
    const lookups = buildLookups(manifest);
    const workflow = lookups.workflowMap.get(sanitize(workflowName));
    if (!workflow) return { ok: false, error: `Workflow '${workflowName}' not found` };

    const steps = resolveWorkflowSteps(workflow, lookups.viewMap, lookups.endpointMap);
    if (steps.error) return { ok: false, error: steps.error };

    // Notify renderer: execution starting
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("browserwire:execution-state", { running: true });
    }

    // Open a visible window so the user can watch the workflow execute
    const execWin = new BrowserWindow({
      width: 1280,
      height: 800,
      title: `Running: ${workflowName.replace(/_/g, " ")}`,
      parent: mainWindow,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    try {
      const result = await executeWorkflowSteps(execWin.webContents, {
        steps, outcomes: workflow.outcomes || {}, inputs: inputs || {}, origin,
      });
      return result;
    } catch (err) {
      return { ok: false, error: "ERR_WORKFLOW_FAILED", message: err.message };
    } finally {
      execWin.destroy();

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("browserwire:execution-state", { running: false });
      }
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
