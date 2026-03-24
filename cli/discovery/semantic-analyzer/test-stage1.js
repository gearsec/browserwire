#!/usr/bin/env node
/**
 * test-stage1.js — Standalone test harness for Stage 1 API Schema Extraction.
 *
 * Usage:
 *   node cli/discovery/semantic-analyzer/test-stage1.js <screenshot.jpg> <url> <title>
 *
 * Example:
 *   node cli/discovery/semantic-analyzer/test-stage1.js screenshot.jpg "https://example.com/events" "Events Page"
 *
 * Requires LLM to be configured via config file or environment variables.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../../config.js";
import { extractApiSchema } from "./extract-api-schema.js";

const [,, imagePath, url, title] = process.argv;

if (!imagePath || !url) {
  console.error("Usage: node cli/discovery/test-stage1.js <screenshot.jpg> <url> [title]");
  process.exit(1);
}

// Load config (reads ~/.browserwire/config.json + env vars)
loadConfig();

const absPath = resolve(imagePath);
console.log(`[test-stage1] Reading screenshot: ${absPath}`);

let screenshot;
try {
  screenshot = readFileSync(absPath).toString("base64");
} catch (err) {
  console.error(`Failed to read image file: ${err.message}`);
  process.exit(1);
}

console.log(`[test-stage1] Screenshot size: ${Math.round(screenshot.length * 0.75 / 1024)}KB`);
console.log(`[test-stage1] URL: ${url}`);
console.log(`[test-stage1] Title: ${title || "(none)"}`);
console.log();

try {
  const schema = await extractApiSchema({
    screenshot,
    url,
    title: title || ""
  });

  if (!schema) {
    console.error("[test-stage1] Stage 1 returned null (check LLM config)");
    process.exit(1);
  }

  console.log("\n=== Stage 1: API Schema ===\n");
  console.log(JSON.stringify(schema, null, 2));

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Domain: ${schema.domain} — ${schema.domainDescription}`);
  console.log(`Page: "${schema.page.name}" (${schema.page.routePattern})`);
  console.log(`Views: ${schema.views.length} (${schema.views.map(v => v.name).join(", ")})`);
  console.log(`Endpoints: ${schema.endpoints.length} (${schema.endpoints.map(e => e.name).join(", ")})`);
  console.log(`Workflows: ${schema.workflows.length} (${schema.workflows.map(w => w.name).join(", ")})`);
} catch (err) {
  console.error(`[test-stage1] Error: ${err.message}`);
  if (err.cause) console.error(`Cause:`, err.cause);
  process.exit(1);
}
