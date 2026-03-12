#!/usr/bin/env node

import { createReadStream, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import chromeWebstoreUpload from "chrome-webstore-upload";

const required = [
  "CHROME_EXTENSION_ID",
  "CHROME_CLIENT_ID",
  "CHROME_CLIENT_SECRET",
  "CHROME_REFRESH_TOKEN",
];

const missing = required.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const store = chromeWebstoreUpload({
  extensionId: process.env.CHROME_EXTENSION_ID,
  clientId: process.env.CHROME_CLIENT_ID,
  clientSecret: process.env.CHROME_CLIENT_SECRET,
  refreshToken: process.env.CHROME_REFRESH_TOKEN,
});

// Find the zip in dist/
const distDir = resolve(import.meta.dirname, "..", "dist");
const zips = readdirSync(distDir).filter((f) => f.endsWith(".zip"));
if (zips.length === 0) {
  console.error("No .zip found in dist/ — run ext:package first");
  process.exit(1);
}

const zipPath = join(distDir, zips[0]);
console.log(`Uploading ${zipPath}...`);

const token = await store.fetchToken();

const uploadRes = await store.uploadExisting(createReadStream(zipPath), token);
if (uploadRes.uploadState === "FAILURE") {
  console.error("Upload failed:", JSON.stringify(uploadRes, null, 2));
  process.exit(1);
}
console.log("Upload succeeded:", uploadRes.uploadState);

const publishRes = await store.publish("default", token);
if (publishRes.status?.includes("OK")) {
  console.log("Published successfully — submitted for review");
} else {
  console.error("Publish response:", JSON.stringify(publishRes, null, 2));
  process.exit(1);
}
