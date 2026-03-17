/**
 * manifest-store.js — File-based store for site-centric manifests.
 *
 * Directory layout:
 *   manifests/
 *     lu_ma/              # slug from hostname (dots → underscores)
 *       manifest.json     # canonical manifest
 *       meta.json         # { origin, createdAt, updatedAt, sessionHistory }
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";

export class ManifestStore {
  constructor(baseDir = resolve(homedir(), ".browserwire", "manifests")) {
    this.baseDir = baseDir;
  }

  /**
   * Convert a URL or origin string to a filesystem-safe slug.
   * "https://lu.ma" → "lu_ma", "localhost:3000" → "localhost_3000"
   */
  static originSlug(urlOrOrigin) {
    try {
      const u = new URL(urlOrOrigin);
      return u.host.replace(/[.:]/g, "_");
    } catch {
      // Already a bare host like "localhost:3000"
      return urlOrOrigin.replace(/[.:]/g, "_");
    }
  }

  /**
   * List all known sites with summary metadata (no full manifest load).
   * @returns {Promise<Array<{ origin: string, slug: string, updatedAt: string|null, entityCount: number, actionCount: number }>>}
   */
  async listSites() {
    let entries;
    try {
      entries = await readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const sites = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const slug = entry.name;
      const metaPath = resolve(this.baseDir, slug, "meta.json");
      try {
        const raw = await readFile(metaPath, "utf8");
        const meta = JSON.parse(raw);
        sites.push({
          origin: meta.origin,
          slug,
          updatedAt: meta.updatedAt || meta.createdAt || null,
          entityCount: meta.entityCount || 0,
          actionCount: meta.actionCount || 0
        });
      } catch {
        // Skip directories without valid meta.json
      }
    }
    return sites;
  }

  /**
   * Load the canonical manifest for a site.
   * @returns {Promise<object|null>}
   */
  async load(urlOrOrigin) {
    const slug = ManifestStore.originSlug(urlOrOrigin);
    const manifestPath = resolve(this.baseDir, slug, "manifest.json");
    try {
      const raw = await readFile(manifestPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Check if a manifest exists for the given site.
   * @returns {Promise<boolean>}
   */
  async has(urlOrOrigin) {
    const slug = ManifestStore.originSlug(urlOrOrigin);
    const manifestPath = resolve(this.baseDir, slug, "manifest.json");
    try {
      await readFile(manifestPath, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save a manifest for a site. Writes manifest.json and updates meta.json atomically.
   */
  async save(urlOrOrigin, manifest, sessionId) {
    let origin;
    try {
      origin = new URL(urlOrOrigin).origin;
    } catch {
      origin = urlOrOrigin;
    }

    const slug = ManifestStore.originSlug(urlOrOrigin);
    const dir = resolve(this.baseDir, slug);
    await mkdir(dir, { recursive: true });

    // Write manifest
    await writeFile(resolve(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

    // Read or create meta
    const metaPath = resolve(dir, "meta.json");
    let meta;
    try {
      const raw = await readFile(metaPath, "utf8");
      meta = JSON.parse(raw);
    } catch {
      meta = {
        origin,
        createdAt: new Date().toISOString(),
        sessionHistory: []
      };
    }

    meta.updatedAt = new Date().toISOString();
    meta.entityCount = manifest.entities?.length || 0;
    meta.actionCount = manifest.actions?.length || 0;
    if (sessionId) {
      meta.sessionHistory.push({ sessionId, timestamp: meta.updatedAt });
    }

    await writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");

    console.log(`[browserwire-cli] manifest saved for ${origin} → ~/.browserwire/manifests/${slug}/`);
  }
}
