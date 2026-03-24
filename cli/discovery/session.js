/**
 * session.js — Discovery Session Manager
 *
 * Flow per snapshot:
 *   runDiscoveryAgent() — single agent with tools sees screenshot + DOM + network
 *
 * finalize(): merge enriched apiSchemas across snapshots via AI merge agent.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { runDiscoveryAgent } from "./agent.js";
import { runMergeAgent } from "./merge-agent.js";
import { PlaywrightBrowser } from "./snapshot/playwright-browser.js";

// ---------------------------------------------------------------------------
// Trigger description helper (kept for logging)
// ---------------------------------------------------------------------------

const describeTrigger = (trigger) => {
  if (!trigger) return "Unknown interaction";
  if (trigger.kind === "initial") {
    return `Initial page load at ${trigger.url || "unknown URL"}`;
  }
  if (trigger.kind === "navigation") {
    return `Navigated to ${trigger.url || "unknown URL"} (title: "${trigger.title || "unknown"}")`;
  }
  const target = trigger.target;
  if (!target) return `${trigger.kind} interaction`;
  const parts = [`${trigger.kind} on`];
  if (target.role) parts.push(`[role=${target.role}]`);
  parts.push(`<${target.tag}>`);
  if (target.name) parts.push(`"${target.name}"`);
  else if (target.text) parts.push(`"${target.text.slice(0, 60)}"`);
  const ctx = trigger.parentContext;
  if (ctx) {
    if (ctx.nearestLandmark) parts.push(`within ${ctx.nearestLandmark}`);
    if (ctx.nearestHeading) parts.push(`near heading "${ctx.nearestHeading}"`);
  }
  return parts.join(" ");
};

// ---------------------------------------------------------------------------
// DiscoverySession
// ---------------------------------------------------------------------------

export class DiscoverySession {
  constructor(sessionId, site) {
    this.sessionId = sessionId;
    this.site = site;
    this.startedAt = new Date().toISOString();
    this.snapshots = [];
    this.status = "active";
    this.note = null;
    /** Parallel snapshot processing promises */
    this._pendingSnapshots = [];
  }

  /**
   * Process an incoming snapshot in parallel.
   * Each snapshot gets its own PlaywrightBrowser instance.
   */
  addSnapshot(payload) {
    const promise = this._processSnapshot(payload);
    this._pendingSnapshots.push(promise);
    return promise;
  }

  async _processSnapshot(payload) {
    const snapshotNum = this._pendingSnapshots.length + 1;
    const snapshotId = payload.snapshotId || `snap_${snapshotNum}`;
    const trigger = payload.trigger || null;
    const capturedAt = payload.capturedAt || new Date().toISOString();
    const url = payload.url || "unknown";
    const title = payload.title || "unknown";

    console.log(
      `[browserwire-cli] session ${this.sessionId} snapshot #${snapshotNum}: ` +
      `trigger=${trigger?.kind || "unknown"}`
    );
    if (trigger) {
      console.log(`[browserwire-cli]   trigger: ${describeTrigger(trigger)}`);
    }

    // Save the screenshot to disk
    if (payload.screenshot) {
      const snapDir = resolve(homedir(), ".browserwire", `logs/session-${this.sessionId}`);
      mkdir(snapDir, { recursive: true })
        .then(() => writeFile(resolve(snapDir, `${snapshotId}.jpg`), Buffer.from(payload.screenshot, "base64")))
        .catch((err) => console.error(`[browserwire-cli] failed to write screenshot:`, err));
    }

    // Each snapshot gets its own browser instance for parallel processing
    const browser = new PlaywrightBrowser();
    await browser.ensureBrowser();

    // Run the agentic discovery pipeline
    let apiSchema = null;
    try {
      const { manifest, toolCallCount, error } = await runDiscoveryAgent({
        snapshot: payload,
        browser,
        onProgress: ({ tool }) => console.log(`[browserwire-cli]   agent: ${tool}`),
        sessionId: this.sessionId,
      });

      if (error) {
        console.warn(`[browserwire-cli]   agent error: ${error}`);
      }

      apiSchema = manifest;

      if (apiSchema) {
        console.log(`[browserwire-cli] ═══ Agent Result ═══════════════════════════`);
        console.log(`[browserwire-cli]   page: "${apiSchema.page.name}" (${apiSchema.page.routePattern})`);
        console.log(`[browserwire-cli]   domain: ${apiSchema.domain}`);
        console.log(`[browserwire-cli]   views: ${apiSchema.views.length} (${apiSchema.views.map(v => v.name).join(", ")})`);
        console.log(`[browserwire-cli]   endpoints: ${apiSchema.endpoints.length} (${apiSchema.endpoints.map(e => e.name).join(", ")})`);
        console.log(`[browserwire-cli]   workflows: ${(apiSchema.workflows || []).length}`);
        console.log(`[browserwire-cli]   tool calls: ${toolCallCount}`);
        console.log(`[browserwire-cli] ════════════════════════════════════════════`);
      }
    } catch (error) {
      console.warn(`[browserwire-cli]   agent failed: ${error.message}`);
    } finally {
      await browser.close().catch(() => {});
    }

    this.snapshots.push({
      snapshotId,
      trigger,
      url,
      title,
      capturedAt,
      apiSchema,
    });
  }

  /**
   * Finalize the session: wait for all snapshots, then merge via AI merge agent.
   */
  async finalize() {
    await Promise.allSettled(this._pendingSnapshots);
    this.status = "stopped";

    if (this.snapshots.length === 0) {
      console.log(`[browserwire-cli] session ${this.sessionId} finalized with 0 snapshots`);
      return { siteSchema: null };
    }

    console.log(`[browserwire-cli] session ${this.sessionId} finalizing ${this.snapshots.length} snapshots`);

    const withManifests = this.snapshots.filter((s) => s.apiSchema);

    if (withManifests.length === 0) {
      return { siteSchema: null };
    }

    // Single snapshot — wrap directly, no merge agent needed
    if (withManifests.length === 1) {
      const s = withManifests[0].apiSchema;
      const siteSchema = {
        domain: s.domain,
        domainDescription: s.domainDescription,
        pages: [{
          name: s.page.name,
          routePattern: s.page.routePattern,
          description: s.page.description,
          views: s.views,
          endpoints: s.endpoints,
          workflows: s.workflows || [],
        }],
      };

      console.log(
        `[browserwire-cli] single snapshot — wrapped directly: domain="${siteSchema.domain}" pages=1`
      );
      return { siteSchema };
    }

    // Multiple snapshots — run AI merge agent
    const { siteManifest, error } = await runMergeAgent({
      snapshots: this.snapshots,
      sessionId: this.sessionId,
    });

    if (error) {
      console.warn(`[browserwire-cli] merge agent error: ${error}`);
    }

    if (siteManifest) {
      const totals = siteManifest.pages.reduce(
        (acc, p) => ({
          views: acc.views + p.views.length,
          endpoints: acc.endpoints + p.endpoints.length,
          workflows: acc.workflows + (p.workflows || []).length,
        }),
        { views: 0, endpoints: 0, workflows: 0 }
      );
      console.log(
        `[browserwire-cli] merged site schema: domain="${siteManifest.domain}" ` +
        `pages=${siteManifest.pages.length} views=${totals.views} ` +
        `endpoints=${totals.endpoints} workflows=${totals.workflows}`
      );
    }

    return { siteSchema: siteManifest || null };
  }
}
