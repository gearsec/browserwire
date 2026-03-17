#!/usr/bin/env node

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

// Load .env file (if present) without overriding existing env vars
const loadEnv = (filePath) => {
  try {
    const content = readFileSync(filePath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't override existing env vars
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env file is optional — silently skip if missing
  }
};

loadEnv(resolve(process.cwd(), ".env"));

// --- Parse CLI arguments ---
const HELP_TEXT = `Usage: browserwire [options]

Start the BrowserWire discovery server.

Options:
  -h, --help                   Show this help message
  -v, --version                Show version number
      --debug                  Enable debug logging
      --extension-path         Print Chrome extension path and exit
      --host <addr>            Server listen address (default: 127.0.0.1)
      --port <number>          Server listen port (default: 8787)
      --llm-provider <name>    LLM provider: openai, anthropic, gemini, ollama
      --llm-api-key <key>      API key for the LLM provider
      --llm-model <name>       Model name (default varies by provider)
      --llm-base-url <url>     Custom API endpoint (default varies by provider)

Environment variables:
  BROWSERWIRE_HOST             Server listen address
  BROWSERWIRE_PORT             Server listen port
  BROWSERWIRE_LLM_PROVIDER    LLM provider
  BROWSERWIRE_LLM_API_KEY     API key for the LLM provider
  BROWSERWIRE_LLM_MODEL       Model name
  BROWSERWIRE_LLM_BASE_URL    Custom API endpoint

Config file:
  ~/.browserwire/config.json   Optional JSON config (see docs for schema)

Precedence: CLI flags > env vars > config file > defaults`;

let parsed;
try {
  parsed = parseArgs({
    strict: true,
    options: {
      help:             { type: "boolean", short: "h" },
      version:          { type: "boolean", short: "v" },
      debug:            { type: "boolean" },
      "extension-path": { type: "boolean" },
      host:             { type: "string" },
      port:             { type: "string" },
      "llm-provider":   { type: "string" },
      "llm-api-key":    { type: "string" },
      "llm-model":      { type: "string" },
      "llm-base-url":   { type: "string" }
    }
  });
} catch (err) {
  console.error(`browserwire: ${err.message}`);
  console.error("Run 'browserwire --help' for usage information.");
  process.exit(1);
}

const flags = parsed.values;

if (flags.help) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (flags.version) {
  const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
  console.log(pkg.version);
  process.exit(0);
}

if (flags["extension-path"]) {
  const extPath = resolve(import.meta.dirname, "../extension");
  console.log(extPath);
  process.exit(0);
}

// --- Ensure data directory exists ---
mkdirSync(join(homedir(), ".browserwire"), { recursive: true });

// --- Server mode: load config and start ---
const { loadConfig } = await import("./config.js");

const cliOverrides = {};
if (flags.debug) cliOverrides.debug = true;
if (flags.host !== undefined) cliOverrides.host = flags.host;
if (flags.port !== undefined) cliOverrides.port = Number(flags.port);
if (flags["llm-provider"] !== undefined) cliOverrides.llmProvider = flags["llm-provider"];
if (flags["llm-api-key"] !== undefined) cliOverrides.llmApiKey = flags["llm-api-key"];
if (flags["llm-model"] !== undefined) cliOverrides.llmModel = flags["llm-model"];
if (flags["llm-base-url"] !== undefined) cliOverrides.llmBaseUrl = flags["llm-base-url"];

const config = loadConfig(cliOverrides);

const { startServer } = await import("./server.js");
const server = await startServer({ host: config.host, port: config.port, debug: config.debug });

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
