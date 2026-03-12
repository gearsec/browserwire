#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

const args = process.argv.slice(2);
const debug = args.includes("--debug");

// --- Server mode: run discovery pipeline + REST API ---
const host = process.env.BROWSERWIRE_HOST || "127.0.0.1";
const port = Number(process.env.BROWSERWIRE_PORT || 8787);

if (!process.env.BROWSERWIRE_LLM_PROVIDER) {
  console.error("[browserwire-cli] BROWSERWIRE_LLM_PROVIDER is required (set in .env or environment)");
  console.error("[browserwire-cli] Supported: openai, anthropic, ollama");
  process.exit(1);
}

const { startServer } = await import("./server.js");
const server = await startServer({ host, port, debug });

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
