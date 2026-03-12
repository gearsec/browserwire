#!/usr/bin/env node

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import archiver from "archiver";
import { createWriteStream } from "node:fs";

const version = process.argv[2];
if (!version) {
  console.error("Usage: package-extension.js <version>");
  process.exit(1);
}

const root = resolve(import.meta.dirname, "..");
const distDir = join(root, "dist");
const stagingDir = join(distDir, "staging");
const extDir = join(root, "extension");
const outZip = join(distDir, `browserwire-extension-${version}.zip`);

// Clean dist/
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

// Copy extension/ → dist/staging/
cpSync(extDir, stagingDir, { recursive: true });

// Patch version in manifest.json
const manifestPath = join(stagingDir, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// Zip staging contents (files at zip root, not nested under staging/)
const output = createWriteStream(outZip);
const archive = archiver("zip", { zlib: { level: 9 } });

archive.on("error", (err) => {
  console.error("Archive error:", err);
  process.exit(1);
});

output.on("close", () => {
  // Clean staging
  rmSync(stagingDir, { recursive: true, force: true });
  console.log(`Created ${outZip} (${archive.pointer()} bytes)`);
});

archive.pipe(output);
archive.directory(stagingDir, false);
await archive.finalize();
