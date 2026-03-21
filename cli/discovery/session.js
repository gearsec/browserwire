/**
 * session.js — Discovery Session Manager
 *
 * Flow per snapshot:
 *   1. extractApiSchema() — vision LLM sees screenshot + URL/title → semantic API schema
 *   2. filterNetworkLogs + analyzeNetworkLogs → read contracts
 *   3. analyzeSkeletons → DOM groundings
 *
 * finalize(): merge enriched apiSchemas across snapshots.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { extractApiSchema } from "./semantic-analyzer/extract-api-schema.js";
import { filterNetworkLogs } from "./filter-network-logs.js";
import { analyzeNetworkLogs } from "./json-log-analyzer/index.js";
import { analyzeSkeletons } from "./skeleton-analyzer/index.js";

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
// API Schema merging helpers
// ---------------------------------------------------------------------------

const normalizeRoute = (pattern) => {
  const qIndex = pattern.indexOf("?");
  return qIndex >= 0 ? pattern.slice(0, qIndex) : pattern;
};

/**
 * Merge per-snapshot apiSchemas into a site-level schema with multiple pages.
 * Deduplicates pages by normalized routePattern, keeping the richer version.
 */
const mergeApiSchemas = (schemas) => {
  if (schemas.length === 0) return null;

  // Group by normalized route pattern — keep richer version
  const pagesByRoute = new Map();
  for (const schema of schemas) {
    const route = normalizeRoute(schema.page.routePattern);
    const existing = pagesByRoute.get(route);
    const richness = schema.views.length + schema.endpoints.length;
    const existingRichness = existing
      ? existing.views.length + existing.endpoints.length
      : -1;

    if (richness > existingRichness) {
      pagesByRoute.set(route, {
        name: schema.page.name,
        routePattern: route,
        description: schema.page.description,
        views: schema.views,
        endpoints: schema.endpoints,
        workflows: schema.workflows,
      });
    }
  }

  // Domain: use last non-empty
  let domain = null;
  let domainDescription = null;
  for (let i = schemas.length - 1; i >= 0; i--) {
    if (schemas[i].domain) {
      domain = schemas[i].domain;
      domainDescription = schemas[i].domainDescription;
      break;
    }
  }

  return {
    domain,
    domainDescription,
    pages: [...pagesByRoute.values()],
  };
};

/**
 * Attach read contracts to their matching views in the site schema.
 * Mutates siteSchema in-place. Also appends discoveredFields to the view's fields[].
 */
const mergeReadContracts = (siteSchema, contracts) => {
  if (!contracts || contracts.length === 0) return;

  // Build a lookup: viewName → contract
  const contractMap = new Map();
  for (const { viewName, contract } of contracts) {
    contractMap.set(viewName, contract);
  }

  let attached = 0;
  for (const page of siteSchema.pages) {
    for (const view of page.views) {
      const contract = contractMap.get(view.name);
      if (!contract) continue;

      view.readContract = {
        dataSources: contract.dataSources,
        discoveredFields: contract.discoveredFields || [],
        hardenedAt: new Date().toISOString(),
      };

      // Append discovered fields to the view's fields[] with a flag
      if (contract.discoveredFields && contract.discoveredFields.length > 0) {
        const existingNames = new Set(view.fields.map((f) => f.name));
        for (const df of contract.discoveredFields) {
          if (!existingNames.has(df.name)) {
            view.fields.push({
              name: df.name,
              type: df.type,
              discoveredFromNetwork: true,
            });
          }
        }
      }

      attached++;
    }
  }

  if (attached > 0) {
    console.log(`[browserwire-cli] Stage 2: attached read contracts to ${attached} views`);
  }
};

/**
 * Attach skeleton-based DOM groundings to views and endpoints in the site schema.
 * Views get domContract, endpoints get domLocator. Mutates siteSchema in-place.
 */
const mergeSkeletonGroundings = (siteSchema, { viewGroundings, endpointGroundings }) => {
  const viewMap = new Map();
  for (const { viewName, grounding } of viewGroundings) {
    viewMap.set(viewName, grounding);
  }

  const endpointMap = new Map();
  for (const { endpointName, grounding } of endpointGroundings) {
    endpointMap.set(endpointName, grounding);
  }

  let viewsAttached = 0;
  let endpointsAttached = 0;

  for (const page of siteSchema.pages) {
    for (const view of page.views) {
      const grounding = viewMap.get(view.name);
      if (!grounding) continue;

      view.viewConfig = {
        ...grounding,
        groundedAt: new Date().toISOString(),
      };
      viewsAttached++;
    }

    for (const endpoint of page.endpoints) {
      const grounding = endpointMap.get(endpoint.name);
      if (!grounding) continue;

      endpoint.domLocator = {
        trigger: grounding.triggerLocator,
        inputs: grounding.inputLocators || [],
        confidence: grounding.confidence,
        groundedAt: new Date().toISOString(),
      };
      endpointsAttached++;
    }
  }

  if (viewsAttached > 0 || endpointsAttached > 0) {
    console.log(
      `[browserwire-cli] Stage 3: attached ${viewsAttached} viewConfigs + ${endpointsAttached} domLocators`
    );
  }
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
    /** Queue to serialize concurrent addSnapshot calls */
    this._queue = Promise.resolve();
  }

  /**
   * Process an incoming snapshot: extract API schema from screenshot.
   * Serialized via queue to avoid concurrent snapshot counter issues.
   */
  addSnapshot(payload) {
    this._queue = this._queue.then(() => this._processSnapshot(payload));
    return this._queue;
  }

  async _processSnapshot(payload) {
    const snapshotNum = this.snapshots.length + 1;
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

    // Save the screenshot fed to stage 1
    if (payload.screenshot) {
      const snapDir = resolve(homedir(), ".browserwire", `logs/session-${this.sessionId}`);
      mkdir(snapDir, { recursive: true })
        .then(() => writeFile(resolve(snapDir, `${snapshotId}.jpg`), Buffer.from(payload.screenshot, "base64")))
        .catch((err) => console.error(`[browserwire-cli] failed to write screenshot:`, err));
    }

    // Stage 1 — API Schema (vision-only, screenshot + URL/title)
    let apiSchema = null;
    try {
      apiSchema = await extractApiSchema({
        screenshot: payload.screenshot || null,
        url,
        title
      });
    } catch (error) {
      console.warn(`[browserwire-cli]   stage1 failed: ${error.message}`);
    }

    if (apiSchema) {
      console.log(`[browserwire-cli] ═══ STAGE 1: API Schema ═══════════════════`);
      console.log(`[browserwire-cli]   page: "${apiSchema.page.name}" (${apiSchema.page.routePattern})`);
      console.log(`[browserwire-cli]   domain: ${apiSchema.domain}`);
      console.log(`[browserwire-cli]   views: ${apiSchema.views.length} (${apiSchema.views.map(v => v.name).join(", ")})`);
      console.log(`[browserwire-cli]   endpoints: ${apiSchema.endpoints.length} (${apiSchema.endpoints.map(e => e.name).join(", ")})`);
      console.log(`[browserwire-cli]   workflows: ${apiSchema.workflows.length}`);
      console.log(`[browserwire-cli] ════════════════════════════════════════════`);

      // Build a mini siteSchema for per-snapshot enrichment
      const miniSchema = {
        domain: apiSchema.domain,
        domainDescription: apiSchema.domainDescription,
        pages: [{
          name: apiSchema.page.name,
          routePattern: normalizeRoute(apiSchema.page.routePattern),
          description: apiSchema.page.description,
          views: apiSchema.views,
          endpoints: apiSchema.endpoints,
          workflows: apiSchema.workflows,
        }],
      };

      // Stage 2 — Network Log Analysis (per-snapshot)
      try {
        const snapshotLogs = (payload.networkLog || []).map((entry) => ({ ...entry, snapshotUrl: url }));
        const apiLogs = filterNetworkLogs({ networkLogs: snapshotLogs });
        if (apiLogs.length > 0) {
          console.log(`[browserwire-cli] Stage 2 (${snapshotId}): ${snapshotLogs.length} raw → ${apiLogs.length} API logs`);
          const readContracts = await analyzeNetworkLogs({ apiLogs, siteSchema: miniSchema });
          mergeReadContracts(miniSchema, readContracts);
        }
      } catch (error) {
        console.warn(`[browserwire-cli] Stage 2 failed for ${snapshotId} (non-fatal): ${error.message}`);
      }

      // Stage 3 — DOM-Based Grounding (per-snapshot)
      try {
        const snap = { snapshotId, domHtml: payload.domHtml || null, skeleton: payload.skeleton || [] };
        const skeletonResults = await analyzeSkeletons({ siteSchema: miniSchema, snapshots: [snap] });
        mergeSkeletonGroundings(miniSchema, skeletonResults);
      } catch (error) {
        console.warn(`[browserwire-cli] Stage 3 failed for ${snapshotId} (non-fatal): ${error.message}`);
      }
    }

    this.snapshots.push({
      snapshotId,
      trigger,
      url,
      title,
      capturedAt,
      apiSchema,
    });

    return this.getStats();
  }

  /**
   * Finalize the session: merge apiSchemas across snapshots into a site-level schema.
   */
  async finalize() {
    await this._queue;
    this.status = "stopped";

    if (this.snapshots.length === 0) {
      console.log(`[browserwire-cli] session ${this.sessionId} finalized with 0 snapshots`);
      return { siteSchema: null, stats: this.getStats() };
    }

    console.log(`[browserwire-cli] session ${this.sessionId} finalizing ${this.snapshots.length} snapshots`);

    // Merge all already-enriched schemas
    const schemas = this.snapshots.map((s) => s.apiSchema).filter(Boolean);
    const merged = mergeApiSchemas(schemas);

    if (merged) {
      const totals = merged.pages.reduce(
        (acc, p) => ({
          views: acc.views + p.views.length,
          endpoints: acc.endpoints + p.endpoints.length,
          workflows: acc.workflows + p.workflows.length,
        }),
        { views: 0, endpoints: 0, workflows: 0 }
      );
      console.log(
        `[browserwire-cli] merged site schema: domain="${merged.domain}" ` +
        `pages=${merged.pages.length} views=${totals.views} ` +
        `endpoints=${totals.endpoints} workflows=${totals.workflows}`
      );
    }

    return {
      siteSchema: merged,
      stats: this.getStats()
    };
  }

  getStats() {
    // Build a merged site schema to get accurate deduped counts
    const schemas = this.snapshots.map((s) => s.apiSchema).filter(Boolean);
    const merged = mergeApiSchemas(schemas);

    let totalViews = 0;
    let totalEndpoints = 0;
    let totalWorkflows = 0;
    let pageCount = 0;

    if (merged) {
      pageCount = merged.pages.length;
      for (const page of merged.pages) {
        totalViews += page.views.length;
        totalEndpoints += page.endpoints.length;
        totalWorkflows += page.workflows.length;
      }
    }

    return {
      sessionId: this.sessionId,
      snapshotCount: this.snapshots.length,
      pageCount,
      viewCount: totalViews,
      endpointCount: totalEndpoints,
      workflowCount: totalWorkflows,
      status: this.status
    };
  }
}
