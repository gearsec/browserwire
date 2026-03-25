/**
 * config.js — Single source of truth for all BrowserWire configuration.
 *
 * Merge precedence (highest wins):
 *   1. CLI flags
 *   2. Environment variables (BROWSERWIRE_*)
 *   3. Config file (~/.browserwire/config.json)
 *   4. Hardcoded defaults
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const PROVIDER_DEFAULTS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    path: "/chat/completions"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    path: "/chat/completions"
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    path: "/v1/messages"
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    model: "llama3",
    path: "/api/chat"
  }
};

const DEFAULTS = {
  host: "127.0.0.1",
  port: 8787,
  debug: false,
  telemetryEnabled: false,
};

const CONFIG_FILE_PATH = join(homedir(), ".browserwire", "config.json");

let _config = null;

/**
 * Read ~/.browserwire/config.json if it exists.
 * Returns {} on missing file or parse error.
 */
const readConfigFile = () => {
  try {
    const raw = readFileSync(CONFIG_FILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn(`[browserwire] Warning: ${CONFIG_FILE_PATH} is not a JSON object, ignoring`);
      return {};
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return {};
    if (err instanceof SyntaxError) {
      console.warn(`[browserwire] Warning: ${CONFIG_FILE_PATH} contains invalid JSON, ignoring`);
      return {};
    }
    return {};
  }
};

/**
 * Read BROWSERWIRE_* environment variables into a config-shaped object.
 * Only includes keys that are actually set.
 */
const readEnvVars = () => {
  const env = {};
  if (process.env.BROWSERWIRE_HOST) env.host = process.env.BROWSERWIRE_HOST;
  if (process.env.BROWSERWIRE_PORT) env.port = Number(process.env.BROWSERWIRE_PORT);
  if (process.env.BROWSERWIRE_LLM_PROVIDER) env.llmProvider = process.env.BROWSERWIRE_LLM_PROVIDER;
  if (process.env.BROWSERWIRE_LLM_API_KEY) env.llmApiKey = process.env.BROWSERWIRE_LLM_API_KEY;
  if (process.env.BROWSERWIRE_LLM_MODEL) env.llmModel = process.env.BROWSERWIRE_LLM_MODEL;
  if (process.env.BROWSERWIRE_LLM_BASE_URL) env.llmBaseUrl = process.env.BROWSERWIRE_LLM_BASE_URL;
  if (process.env.BROWSERWIRE_TELEMETRY) env.telemetryEnabled = process.env.BROWSERWIRE_TELEMETRY === "true";
  if (process.env.LANGSMITH_API_KEY) env.langsmithApiKey = process.env.LANGSMITH_API_KEY;
  if (process.env.LANGSMITH_PROJECT) env.langsmithProject = process.env.LANGSMITH_PROJECT;
  return env;
};

/**
 * Validate transport config (host/port) — required at startup.
 */
const validateTransport = (cfg) => {
  const errors = [];
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push(`Invalid port "${cfg.port}" (must be integer 1-65535)`);
  }
  if (typeof cfg.host !== "string" || cfg.host.length === 0) {
    errors.push("Host must be a non-empty string");
  }
  return errors;
};

/**
 * Validate LLM config — only needed when discovery runs.
 */
const validateLLM = (cfg) => {
  const errors = [];
  const validProviders = Object.keys(PROVIDER_DEFAULTS);

  if (!cfg.llmProvider) {
    errors.push(`BROWSERWIRE_LLM_PROVIDER is required (supported: ${validProviders.join(", ")})`);
  } else if (!validProviders.includes(cfg.llmProvider)) {
    errors.push(`Invalid LLM provider "${cfg.llmProvider}" (supported: ${validProviders.join(", ")})`);
  }

  if (cfg.llmProvider && cfg.llmProvider !== "ollama" && !cfg.llmApiKey) {
    errors.push("BROWSERWIRE_LLM_API_KEY is required (unless provider is ollama)");
  }

  return errors;
};

/**
 * Load and merge configuration from all sources.
 *
 * @param {object} cliOverrides - Values from parsed CLI flags (undefined keys are ignored)
 * @param {{ strict?: boolean }} opts - If strict (default true), exit on LLM config errors.
 *   Set strict=false for Electron where LLM config is only needed at discovery time.
 * @returns {Readonly<object>} Frozen config object
 */
export const loadConfig = (cliOverrides = {}, { strict = true } = {}) => {
  // 1. Start with defaults
  const merged = { ...DEFAULTS };

  // 2. Overlay config file
  const fileConfig = readConfigFile();
  for (const [key, value] of Object.entries(fileConfig)) {
    if (value !== undefined && value !== null) {
      merged[key] = value;
    }
  }

  // 3. Overlay env vars
  const envConfig = readEnvVars();
  for (const [key, value] of Object.entries(envConfig)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // 4. Overlay CLI flags (skip undefined)
  for (const [key, value] of Object.entries(cliOverrides)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }

  // 5. Resolve provider-specific defaults for unset LLM fields
  if (merged.llmProvider && PROVIDER_DEFAULTS[merged.llmProvider]) {
    const providerDefaults = PROVIDER_DEFAULTS[merged.llmProvider];
    if (!merged.llmModel) merged.llmModel = providerDefaults.model;
    if (!merged.llmBaseUrl) merged.llmBaseUrl = providerDefaults.baseUrl;
    if (!merged.llmPath) merged.llmPath = providerDefaults.path;
  }

  // 6. Validate transport config (always required)
  const transportErrors = validateTransport(merged);
  if (transportErrors.length > 0) {
    console.error("[browserwire] Configuration errors:");
    for (const err of transportErrors) {
      console.error(`  - ${err}`);
    }
    if (strict) {
      console.error("\nRun 'browserwire --help' for usage information.");
      process.exit(1);
    }
  }

  // 7. Validate LLM config (only fatal in strict/CLI mode)
  const llmErrors = validateLLM(merged);
  if (llmErrors.length > 0) {
    if (strict) {
      console.error("[browserwire] Configuration errors:");
      for (const err of llmErrors) {
        console.error(`  - ${err}`);
      }
      console.error("\nRun 'browserwire --help' for usage information.");
      process.exit(1);
    } else {
      // Non-strict: warn but continue — LLM config only needed at discovery time
      merged._llmConfigured = false;
      console.warn("[browserwire] LLM not configured — discovery will fail until configured.");
      for (const err of llmErrors) {
        console.warn(`  - ${err}`);
      }
    }
  } else {
    merged._llmConfigured = true;
  }

  // 8. Store singleton
  _config = merged;
  return _config;
};

/**
 * Get the loaded config singleton.
 * Must be called after loadConfig().
 */
export const getConfig = () => {
  if (!_config) {
    throw new Error("Config not loaded — call loadConfig() first");
  }
  return _config;
};

/**
 * Export readConfigFile so Electron can check for encrypted keys.
 */
export { readConfigFile };

/**
 * Write non-secret fields to ~/.browserwire/config.json.
 * Merges with existing config, removing undefined values.
 */
export const writeConfigFile = (fields) => {
  const existing = readConfigFile();
  const clean = {};
  for (const [k, v] of Object.entries({ ...existing, ...fields })) {
    if (v !== undefined) clean[k] = v;
  }
  mkdirSync(dirname(CONFIG_FILE_PATH), { recursive: true });
  writeFileSync(CONFIG_FILE_PATH, JSON.stringify(clean, null, 2), "utf8");
};

/**
 * Reload config singleton. Used by Electron after settings save.
 */
export const reloadConfig = (overrides = {}) => {
  _config = null;
  return loadConfig(overrides, { strict: false });
};
