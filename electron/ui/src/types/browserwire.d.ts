interface NavigationState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface SessionStatus {
  snapshotCount?: number;
  status?: string;
}

interface BatchStatus {
  batchId: string;
  status: "pending" | "processing" | "complete" | "error";
  error?: string;
}

interface Settings {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  llmConfigured: boolean;
  providerDefaults: Record<string, { model: string; baseUrl: string }>;
}

interface SaveSettingsPayload {
  provider?: string;
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

interface ConfigChanged {
  llmConfigured: boolean;
  provider: string;
}

interface LayoutState {
  activeMode: "discovery" | "execution" | "history" | "settings";
  rightPanelOpen: boolean;
}

interface SessionRecordingMeta {
  sessionId: string;
  origin: string;
  startedAt: string;
  stoppedAt: string;
  eventCount: number;
  snapshotCount: number;
  snapshots: {
    snapshotId: string;
    eventIndex: number;
    screenshotFile: string;
    url: string;
    title: string;
  }[];
}

interface StartResult {
  ok: boolean;
  sessionId?: string;
  url?: string;
  error?: string;
}

interface ExecutionState {
  running: boolean;
}

interface ExecuteWorkflowPayload {
  slug: string;
  workflowName: string;
  inputs: Record<string, any>;
}

interface BrowserWireAPI {
  apiBaseUrl: string;
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  executeWorkflow: (payload: ExecuteWorkflowPayload) => Promise<any>;
  onExecutionState: (callback: (state: ExecutionState) => void) => () => void;
  startExploring: () => Promise<StartResult>;
  stopExploring: (note?: string) => Promise<{ ok: boolean; error?: string }>;
  listSessions: () => Promise<SessionRecordingMeta[]>;
  loadSessionEvents: (sessionId: string) => Promise<{ ok: boolean; events?: any[]; error?: string }>;
  loadSessionScreenshot: (sessionId: string, snapshotId: string) => Promise<{ ok: boolean; screenshot?: string; error?: string }>;
  getSettings: () => Promise<Settings>;
  saveSettings: (settings: SaveSettingsPayload) => Promise<{ ok: boolean; llmConfigured?: boolean; error?: string }>;
  reportLayout: (state: LayoutState) => void;
  reportNavbarHover: (expanded: boolean) => void;
  onUrlChanged: (callback: (url: string) => void) => () => void;
  onSessionStatus: (callback: (status: SessionStatus) => void) => () => void;
  onBatchStatus: (callback: (status: BatchStatus) => void) => () => void;
  onLoadingChanged: (callback: (loading: boolean) => void) => () => void;
  onNavigationState: (callback: (state: NavigationState) => void) => () => void;
  onConfigChanged: (callback: (data: ConfigChanged) => void) => () => void;
  onSwitchMode: (callback: (mode: string) => void) => () => void;
}

declare global {
  interface Window {
    browserwire: BrowserWireAPI;
  }
}

export {};
