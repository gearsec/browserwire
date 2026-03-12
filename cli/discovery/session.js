/**
 * session.js — Discovery Session Manager (Vision-First Pipeline)
 *
 * Flow per snapshot:
 *   1. perceiveSnapshot() — vision LLM sees screenshot + HTML skeleton (~2K tokens)
 *   2. focusAndInspect()  — build elements/locators only for focused ~20 elements
 *   3. compileManifest()  — unchanged
 *   4. mergeEnrichment()  — apply LLM semantic names from perception result
 *
 * finalize(): merge across snapshots → compile — no LLM Pass 2.
 */

import { synthesizeAllLocators } from "./locators.js";
import { compileManifest } from "./compile.js";
import { mergeEnrichment } from "./enrich.js";
import { perceiveSnapshot } from "./perceive.js";
import { synthesizeWorkflows } from "./synthesize-workflows.js";

// ---------------------------------------------------------------------------
// Helpers — mirror compile.js logic to build scanId → actionId mapping
// ---------------------------------------------------------------------------

/** Mirrors compile.js slugify exactly. */
const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "unnamed";

/** Mirrors compile.js interactionVerb exactly. */
const interactionVerb = (kind) =>
  ({ click: "Click", type: "Type into", select: "Select from", toggle: "Toggle", navigate: "Navigate to", submit: "Submit", scroll: "Scroll" })[kind] || "Interact with";

/**
 * Derive a reasonable interactionKind from a skeleton entry
 * (used as fallback when perception is unavailable).
 */
const deriveInteractionKind = (entry) => {
  const tag = entry.tagName;
  const type = entry.attributes?.type || "";
  if (tag === "input") {
    if (type === "checkbox" || type === "radio") return "toggle";
    if (type === "submit") return "click";
    return "type";
  }
  if (tag === "select") return "select";
  if (tag === "textarea") return "type";
  if (tag === "a") return "navigate";
  return "click";
};

/**
 * Build scanId → compiled actionId mapping by mirroring compile.js's ID
 * generation logic. Must be called with the same interactables/elements/a11y
 * arrays that will be passed to compileManifest.
 */
const buildScanToActionIdMap = (interactables, elements, a11y, locatorMap) => {
  const elementMap = new Map(elements.map((e) => [e.scanId, e]));
  const a11yMap = new Map(a11y.map((e) => [e.scanId, e]));
  const usedIds = new Set();
  const scanToActionId = new Map();

  for (const interactable of interactables) {
    if (interactable.interactionKind === "none") continue;
    const el = elementMap.get(interactable.scanId);
    const a11yEntry = a11yMap.get(interactable.scanId);
    const locatorCandidate = locatorMap.get(interactable.scanId);
    if (!el || !locatorCandidate || locatorCandidate.strategies.length === 0) continue;

    const targetName =
      a11yEntry?.name?.trim().slice(0, 50) ||
      el.textContent?.trim().slice(0, 50) ||
      el.tagName;
    const verb = interactionVerb(interactable.interactionKind);
    const actionName = `${verb} ${targetName}`;
    let actionId = `action_${slugify(actionName)}`;
    if (usedIds.has(actionId)) {
      actionId = `${actionId}_${interactable.scanId}`;
    }
    usedIds.add(actionId);
    scanToActionId.set(interactable.scanId, actionId);
  }

  return scanToActionId;
};

/**
 * Build entity name → compiled entityId mapping by mirroring compile.js's
 * ID generation logic.
 */
const buildEntityNameToIdMap = (entities) => {
  const usedIds = new Set();
  const nameToId = new Map();

  for (const candidate of entities) {
    let entityId = `entity_${slugify(candidate.name)}`;
    if (usedIds.has(entityId)) {
      entityId = `${entityId}_${candidate.rootScanId}`;
    }
    usedIds.add(entityId);
    nameToId.set(candidate.name, entityId);
  }

  return nameToId;
};

/**
 * Translate a perception result into the enrichment format expected by
 * mergeEnrichment(). Filters out any references to unknown action/entity IDs.
 */
const buildEnrichmentFromPerception = (perception, scanToActionId, entityNameToId, manifest) => {
  const manifestEntityIds = new Set(manifest.entities.map((e) => e.id));
  const manifestActionIds = new Set(manifest.actions.map((a) => a.id));

  const entities = perception.entities
    .map((e) => ({
      originalId: entityNameToId.get(e.name),
      semanticName: e.name,
      description: e.description || ""
    }))
    .filter((e) => e.originalId && manifestEntityIds.has(e.originalId));

  const actions = perception.actions
    .map((a) => {
      const actionId = scanToActionId.get(a.scanId);
      if (!actionId || !manifestActionIds.has(actionId)) return null;
      return {
        originalId: actionId,
        semanticName: a.semanticName,
        description: a.description || "",
        inputs: []
      };
    })
    .filter(Boolean);

  const compositeActions = (perception.compositeActions || [])
    .map((ca) => {
      const stepActionIds = ca.stepScanIds
        .map((sid) => scanToActionId.get(sid))
        .filter((id) => id && manifestActionIds.has(id));
      if (stepActionIds.length < 2) return null;
      return {
        name: ca.name,
        description: ca.description || "",
        stepActionIds,
        inputs: (ca.inputs || []).map((i) => ({
          name: i.name,
          type: i.type || "string",
          description: i.description || ""
        }))
      };
    })
    .filter(Boolean);

  return { domain: perception.domain, domainDescription: perception.domainDescription, entities, actions, compositeActions };
};

// ---------------------------------------------------------------------------
// focusAndInspect — core per-snapshot pipeline
// ---------------------------------------------------------------------------

/**
 * Build ViewDef objects from perception views.
 */
const buildViewDefs = (perceptionViews, entityNameToId, capturedAt) => {
  if (!perceptionViews || perceptionViews.length === 0) return [];

  const provenance = {
    source: "agent",
    sessionId: "vision-discovery",
    traceIds: [],
    annotationIds: [],
    capturedAt: capturedAt || new Date().toISOString()
  };

  return perceptionViews.map((v) => {
    const viewId = `view_${slugify(v.name)}`;
    const strategies = [{ kind: "css", value: v.containerSelector, confidence: 0.8 }];

    // If the LLM selector contains [role='X'], also add the tag equivalent
    const roleMatch = v.containerSelector.match(/\[role=['"](\w+)['"]\]/);
    if (roleMatch) {
      strategies.push({ kind: "css", value: roleMatch[1], confidence: 0.6 });
    }

    // Absolute last resort: body
    strategies.push({ kind: "css", value: "body", confidence: 0.2 });

    const containerLocator = {
      id: `loc_${viewId}`,
      strategies
    };
    const itemLocator = v.itemSelector
      ? { kind: "css", value: v.itemSelector, confidence: 0.8 }
      : undefined;
    const fields = v.fields.map((f) => ({
      name: f.name,
      type: f.type || "string",
      locator: { kind: "css", value: f.selector, confidence: 0.8 }
    }));

    return {
      id: viewId,
      name: v.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      semanticName: v.name,
      description: v.description || "",
      isList: v.isList || false,
      isDynamic: v.isDynamic || false,
      containerLocator,
      itemLocator,
      fields,
      provenance
    };
  });
};

/**
 * Build a PageDef from perception pageState.
 */
const buildPageDef = (pageState, viewIds, actionIds) => {
  if (!pageState) return null;
  const pageDef = {
    id: `page_${slugify(pageState.name)}`,
    routePattern: pageState.routePattern,
    name: pageState.name,
    description: pageState.description || "",
    viewIds: viewIds || [],
    actionIds: actionIds || []
  };
  if (pageState.stateSignals && pageState.stateSignals.length > 0) {
    pageDef.stateSignals = pageState.stateSignals;
  }
  return pageDef;
};

/**
 * Build a manifest from a skeleton + perception result.
 *
 * Steps:
 *   1. Filter skeleton to focused scanIds (LLM actions + entity members)
 *   2. Map skeleton entries → elements[] and a11y[] (locators.js-compatible)
 *   3. Build interactables[] and entities[] from perception (or fallback)
 *   4. synthesizeAllLocators → locators[]
 *   5. compileManifest → draft manifest
 *   6. mergeEnrichment → apply LLM semantic names
 *
 * Returns { manifest, elements, a11y, interactables, entities, locators, views, page, stats }
 */
const focusAndInspect = ({ skeleton, perception, url, title, capturedAt, pageState }) => {
  const skeletonByScanId = new Map(skeleton.map((e) => [e.scanId, e]));

  // --- Determine focused set ---
  let interactableData;
  let entityData;
  let focusedScanIds;

  if (perception && perception.actions.length > 0) {
    const actionScanIds = new Set(perception.actions.map((a) => a.scanId));
    const entityScanIds = new Set(perception.entities.flatMap((e) => e.scanIds));
    focusedScanIds = new Set([...actionScanIds, ...entityScanIds]);
    interactableData = perception.actions;
    entityData = perception.entities;
  } else {
    // Fallback: use all interactable skeleton entries
    focusedScanIds = new Set(skeleton.filter((e) => e.interactable).map((e) => e.scanId));
    interactableData = [];
    entityData = [];
  }

  const focusedSkeleton = skeleton.filter((e) => focusedScanIds.has(e.scanId));

  // --- Build elements (locators.js-compatible format) ---
  const elements = focusedSkeleton.map((entry) => ({
    scanId: entry.scanId,
    tagName: entry.tagName,
    attributes: entry.attributes || {},
    textContent: entry.text || "",
    parentScanId: entry.parentScanId,
    childScanIds: entry.childScanIds || [],
    boundingRect: entry.rect || { x: 0, y: 0, width: 0, height: 0 },
    isVisible: true
  }));

  // --- Build a11y ---
  const a11y = focusedSkeleton.map((entry) => ({
    scanId: entry.scanId,
    role: entry.role || null,
    name: entry.name || null,
    description: null,
    isDisabled:
      entry.attributes?.disabled != null ||
      entry.attributes?.["aria-disabled"] === "true",
    isRequired:
      entry.attributes?.required != null ||
      entry.attributes?.["aria-required"] === "true",
    expandedState: entry.attributes?.["aria-expanded"] || null,
    checkedState: entry.attributes?.["aria-checked"] || null,
    selectedState: entry.attributes?.["aria-selected"] || null
  }));

  // --- Build interactables ---
  const interactables = interactableData.length > 0
    ? interactableData.map((a) => ({
        scanId: a.scanId,
        interactionKind: a.interactionKind || "click",
        confidence: 0.9,
        inputType: skeletonByScanId.get(a.scanId)?.attributes?.type || null
      }))
    : focusedSkeleton
        .filter((e) => e.interactable)
        .map((e) => ({
          scanId: e.scanId,
          interactionKind: deriveInteractionKind(e),
          confidence: 0.7,
          inputType: e.attributes?.type || null
        }));

  // --- Build entity candidates ---
  const actionScanIdSet = new Set(interactables.map((i) => i.scanId));
  const entities = entityData.map((e, i) => ({
    candidateId: `vision_entity_${i}`,
    name: e.name,
    source: "vision_llm",
    rootScanId: e.scanIds[0] || 0,
    memberScanIds: e.scanIds,
    interactableScanIds: e.scanIds.filter((sid) => actionScanIdSet.has(sid)),
    signals: []
  }));

  // --- Synthesize locators ---
  const { locators, stats: locatorStats } = synthesizeAllLocators(elements, a11y, interactables);

  // --- Inject LLM-generated semantic locators from perception ---
  // LLM locators are placed at the front (highest confidence: 0.97) because
  // they encode surrounding context (labels, ARIA) that heuristics cannot.
  if (perception) {
    let injectedCount = 0;
    const locatorMapTemp = new Map(locators.map((l) => [l.scanId, l]));
    for (const action of perception.actions) {
      if (!action.locator) continue;
      const { kind, value } = action.locator;
      if (!kind || !value) continue;

      let candidate = locatorMapTemp.get(action.scanId);
      if (!candidate) {
        candidate = { scanId: action.scanId, strategies: [] };
        locators.push(candidate);
        locatorMapTemp.set(action.scanId, candidate);
      }
      candidate.strategies.unshift({ kind, value, confidence: 0.97 });
      injectedCount++;
    }
    if (injectedCount > 0) {
      console.log(`[browserwire-cli]   LLM locators injected: ${injectedCount}`);
    }
  }

  // --- Build ID mappings (must mirror compile.js logic exactly) ---
  const locatorMap = new Map(locators.map((l) => [l.scanId, l]));
  const scanToActionId = buildScanToActionIdMap(interactables, elements, a11y, locatorMap);
  const entityNameToId = buildEntityNameToIdMap(entities);

  // --- Compile draft manifest ---
  const { manifest, stats: manifestStats } = compileManifest({
    url, title, capturedAt,
    elements, a11y, interactables, entities, locators
  });

  // --- Apply LLM semantic names via enrichment ---
  let finalManifest = manifest;
  if (perception) {
    const enrichment = buildEnrichmentFromPerception(
      perception, scanToActionId, entityNameToId, manifest
    );
    finalManifest = mergeEnrichment(manifest, enrichment, capturedAt);
    console.log(
      `[browserwire-cli]   enrichment applied: domain="${enrichment.domain}" ` +
      `entities=${enrichment.entities.length} actions=${enrichment.actions.length} ` +
      `composites=${enrichment.compositeActions.length}`
    );
  }

  // --- Build views and page from perception ---
  const views = perception
    ? buildViewDefs(perception.views, entityNameToId, capturedAt)
    : [];

  // Collect action IDs for the page
  const allActionIds = [...scanToActionId.values()];
  const viewIds = views.map((v) => v.id);

  const perceptionPageState = perception?.pageState || pageState || null;
  const page = buildPageDef(perceptionPageState, viewIds, allActionIds);

  if (views.length > 0) {
    finalManifest.views = views;
  }
  if (page) {
    finalManifest.pages = [page];
  }

  return {
    manifest: finalManifest,
    elements,
    a11y,
    interactables,
    entities,
    locators,
    views,
    page,
    stats: { locator: locatorStats, manifest: manifestStats }
  };
};

// ---------------------------------------------------------------------------
// Snapshot merging (unchanged from original)
// ---------------------------------------------------------------------------

const mergeEntities = (allSnapshotEntities) => {
  const merged = new Map();
  for (const entities of allSnapshotEntities) {
    for (const entity of entities) {
      const key = `${entity.name}|${entity.source}`;
      const existing = merged.get(key);
      if (existing) {
        const memberSet = new Set([...existing.memberScanIds, ...entity.memberScanIds]);
        existing.memberScanIds = [...memberSet];
        const interactSet = new Set([...existing.interactableScanIds, ...entity.interactableScanIds]);
        existing.interactableScanIds = [...interactSet];
        const signalMap = new Map();
        for (const sig of existing.signals) {
          signalMap.set(`${sig.kind}:${sig.value}`, sig);
        }
        for (const sig of entity.signals) {
          const sigKey = `${sig.kind}:${sig.value}`;
          if (!signalMap.has(sigKey) || signalMap.get(sigKey).weight < sig.weight) {
            signalMap.set(sigKey, sig);
          }
        }
        existing.signals = [...signalMap.values()];
      } else {
        merged.set(key, { ...entity });
      }
    }
  }
  return [...merged.values()];
};

const mergeElements = (allSnapshotElements) => {
  const merged = new Map();
  for (const elements of allSnapshotElements) {
    for (const el of elements) {
      merged.set(el.scanId, el);
    }
  }
  return [...merged.values()];
};

const mergeA11y = (allSnapshotA11y) => {
  const merged = new Map();
  for (const entries of allSnapshotA11y) {
    for (const entry of entries) {
      merged.set(entry.scanId, entry);
    }
  }
  return [...merged.values()];
};

const mergeInteractables = (allSnapshotInteractables) => {
  const all = [];
  for (const interactables of allSnapshotInteractables) {
    all.push(...interactables);
  }
  return all;
};

const mergeLocators = (allSnapshotLocators) => {
  const all = [];
  for (const locators of allSnapshotLocators) {
    all.push(...locators);
  }
  return all;
};

/**
 * Normalize a view name for dedup: strip trailing _view/_list/_detail suffixes
 * and common prefixes so "event_list" and "event_list_view" merge together.
 */
const normalizeViewName = (name) => {
  return name
    .replace(/_view$/, "")
    .replace(/_list$/, "")
    .replace(/_detail$/, "");
};

/**
 * Merge views across snapshots. Union by normalized semanticName.
 * If same view seen in multiple snapshots, keep the one with more valid fields.
 */
const mergeViews = (allSnapshotViews) => {
  const merged = new Map();
  for (const views of allSnapshotViews) {
    for (const view of views) {
      const rawKey = view.semanticName || view.name;
      const key = normalizeViewName(rawKey);
      const existing = merged.get(key);
      if (!existing || view.fields.length > existing.fields.length) {
        merged.set(key, { ...view });
      }
    }
  }
  return [...merged.values()];
};

/**
 * Normalize a route pattern by stripping query params.
 * "/home?period=past" → "/home", "/home?period=:period" → "/home"
 */
const normalizeRoutePattern = (pattern) => {
  const qIndex = pattern.indexOf("?");
  return qIndex >= 0 ? pattern.slice(0, qIndex) : pattern;
};

/**
 * Merge stateSignals arrays — union by "kind:value" key.
 */
const mergeStateSignals = (existing, incoming) => {
  const signalMap = new Map();
  for (const s of (existing || [])) {
    signalMap.set(`${s.kind}:${s.value}`, s);
  }
  for (const s of (incoming || [])) {
    const key = `${s.kind}:${s.value}`;
    if (!signalMap.has(key)) {
      signalMap.set(key, s);
    }
  }
  return [...signalMap.values()];
};

/**
 * Merge pages across snapshots. Union by normalized routePattern (ignoring query params).
 * Merge viewIds, actionIds, and stateSignals.
 */
const mergePages = (allSnapshotPages) => {
  const merged = new Map();
  for (const page of allSnapshotPages) {
    if (!page) continue;
    const key = normalizeRoutePattern(page.routePattern);
    const existing = merged.get(key);
    if (existing) {
      const viewSet = new Set([...existing.viewIds, ...page.viewIds]);
      existing.viewIds = [...viewSet];
      const actionSet = new Set([...existing.actionIds, ...page.actionIds]);
      existing.actionIds = [...actionSet];
      existing.stateSignals = mergeStateSignals(existing.stateSignals, page.stateSignals);
    } else {
      merged.set(key, {
        ...page,
        routePattern: key,
        viewIds: [...page.viewIds],
        actionIds: [...page.actionIds],
        stateSignals: [...(page.stateSignals || [])]
      });
    }
  }
  return [...merged.values()];
};

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
    this.lastEnrichedManifest = null;
    this.checkpointCount = 0;
    this.checkpointNotes = [];
    this.priorManifest = null;
    /** Queue to serialize concurrent addSnapshot calls */
    this._queue = Promise.resolve();
  }

  /**
   * Seed this session with a prior manifest so _buildMergedManifest()
   * merges new knowledge into existing.
   */
  seedWithManifest(manifest) {
    this.priorManifest = manifest;
  }

  /**
   * Process an incoming skeleton snapshot: perceive → focusAndInspect.
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
    const pageText = payload.pageText || "";
    const capturedAt = payload.capturedAt || new Date().toISOString();
    const url = payload.url || "unknown";
    const title = payload.title || "unknown";
    const skeleton = Array.isArray(payload.skeleton) ? payload.skeleton : [];
    const pageState = payload.pageState || null;

    console.log(
      `[browserwire-cli] session ${this.sessionId} snapshot #${snapshotNum}: ` +
      `trigger=${trigger?.kind || "unknown"} skeleton=${skeleton.length}`
    );
    if (trigger) {
      console.log(`[browserwire-cli]   trigger: ${describeTrigger(trigger)}`);
    }

    // Step 1 — Vision LLM perception
    let perception = null;
    try {
      perception = await perceiveSnapshot({
        skeleton,
        screenshot: payload.screenshot || null,
        pageText,
        url,
        title
      });
    } catch (error) {
      console.warn(`[browserwire-cli]   perception failed: ${error.message}`);
    }

    // Step 2 — Build locators + manifest from focused skeleton
    let result = null;
    try {
      result = focusAndInspect({ skeleton, perception, url, title, capturedAt, pageState });
      console.log(
        `[browserwire-cli]   manifest: ${result.stats.manifest?.entityCount ?? 0} entities, ` +
        `${result.stats.manifest?.actionCount ?? 0} actions, ` +
        `${result.stats.locator?.total ?? 0} locators` +
        (result.views?.length ? `, ${result.views.length} views` : "")
      );
    } catch (error) {
      console.warn(`[browserwire-cli]   focusAndInspect failed: ${error.message}`);
    }

    if (result?.manifest?.domain) {
      this.lastEnrichedManifest = result.manifest;
    }

    this.snapshots.push({
      snapshotId,
      trigger,
      url,
      title,
      capturedAt,
      elements: result?.elements || [],
      a11y: result?.a11y || [],
      interactables: result?.interactables || [],
      entities: result?.entities || [],
      locators: result?.locators || [],
      views: result?.views || [],
      page: result?.page || null,
      manifest: result?.manifest || null,
      stats: result?.stats || {}
    });

    return this.getStats();
  }

  /**
   * Internal merge logic shared by finalize() and compileCheckpoint().
   * Merges all current per-snapshot enriched manifests into one unified manifest.
   */
  async _buildMergedManifest() {
    let snapshotManifests = this.snapshots.map((s) => s.manifest).filter(Boolean);
    if (this.priorManifest) {
      snapshotManifests = [this.priorManifest, ...snapshotManifests];
    }
    if (snapshotManifests.length === 0) return null;

    // --- Merge entities: by name slug, prefer non-orphan ---
    const entitiesBySlug = new Map();
    for (const m of snapshotManifests) {
      for (const entity of (m.entities || [])) {
        const nameSlug = slugify(entity.name);
        const existing = entitiesBySlug.get(nameSlug);
        if (!existing) {
          entitiesBySlug.set(nameSlug, entity);
        } else if (!entity.id.startsWith("entity_orphan_") && existing.id.startsWith("entity_orphan_")) {
          entitiesBySlug.set(nameSlug, entity);
        }
      }
    }
    const mergedEntities = [...entitiesBySlug.values()];
    const entityIdSet = new Set(mergedEntities.map((e) => e.id));

    // --- Merge actions: by name, keep highest confidence ---
    const actionsByName = new Map();
    for (const m of snapshotManifests) {
      for (const action of (m.actions || [])) {
        const existing = actionsByName.get(action.name);
        if (!existing || (action.confidence?.score || 0) > (existing.confidence?.score || 0)) {
          actionsByName.set(action.name, { ...action });
        }
      }
    }

    // Fix entity references — remap to surviving entities
    const mergedActions = [...actionsByName.values()].map((action) => {
      if (action.entityId && !entityIdSet.has(action.entityId)) {
        const stripped = action.entityId.replace(/^entity_/, "").replace(/_\d+$/, "");
        const match = mergedEntities.find((e) => slugify(e.name) === stripped);
        if (match) action.entityId = match.id;
      }
      return action;
    });

    // --- Merge views + pages (include prior manifest data) ---
    const priorViews = this.priorManifest?.views || [];
    const priorPages = this.priorManifest?.pages || [];
    const mergedViewDefs = mergeViews([priorViews, ...this.snapshots.map((s) => s.views || [])]);
    const mergedPageDefs = mergePages([...priorPages, ...this.snapshots.map((s) => s.page).filter(Boolean)]);

    // Deduplicate actionIds in pages to only reference surviving actions
    const actionIdToName = new Map();
    for (const m of snapshotManifests) {
      for (const a of (m.actions || [])) {
        actionIdToName.set(a.id, a.name);
      }
    }

    for (const page of mergedPageDefs) {
      const seenNames = new Set();
      page.actionIds = page.actionIds.filter((aid) => {
        const name = actionIdToName.get(aid);
        if (!name || seenNames.has(name)) return false;
        seenNames.add(name);
        const surviving = mergedActions.find((a) => a.name === name);
        return !!surviving;
      }).map((aid) => {
        const name = actionIdToName.get(aid);
        const surviving = mergedActions.find((a) => a.name === name);
        return surviving ? surviving.id : aid;
      });
    }

    // Assemble final manifest (preserve original metadata from prior if available)
    const base = this.priorManifest || snapshotManifests[0];
    const manifest = {
      contractVersion: base.contractVersion || "1.0.0",
      manifestVersion: base.manifestVersion || "0.1.0",
      metadata: { ...base.metadata, updatedAt: new Date().toISOString() },
      entities: mergedEntities,
      actions: mergedActions,
      errors: base.errors || []
    };

    if (mergedViewDefs.length > 0) manifest.views = mergedViewDefs;
    if (mergedPageDefs.length > 0) manifest.pages = mergedPageDefs;

    if (this.lastEnrichedManifest) {
      if (this.lastEnrichedManifest.domain) manifest.domain = this.lastEnrichedManifest.domain;
      if (this.lastEnrichedManifest.domainDescription) manifest.domainDescription = this.lastEnrichedManifest.domainDescription;
    }
    // Carry forward domain info from prior manifest if not set by current session
    if (!manifest.domain && this.priorManifest?.domain) manifest.domain = this.priorManifest.domain;
    if (!manifest.domainDescription && this.priorManifest?.domainDescription) manifest.domainDescription = this.priorManifest.domainDescription;

    // Synthesize task-level workflow APIs from the merged manifest
    const workflowDefs = await synthesizeWorkflows(manifest);

    // Resolve workflow step references (actionId/viewId) to inline execution data
    const actionMap = new Map(mergedActions.map(a => [a.id, a]));
    const viewMap = new Map((manifest.views || []).map(v => [v.id, v]));

    for (const wf of workflowDefs) {
      for (const step of wf.steps) {
        if (step.actionId) {
          const action = actionMap.get(step.actionId);
          if (action?.locatorSet?.strategies) {
            step.strategies = action.locatorSet.strategies;
          }
        }
        if (step.viewId) {
          const view = viewMap.get(step.viewId);
          if (view) {
            step.viewConfig = {
              containerLocator: view.containerLocator?.strategies || [],
              itemLocator: view.itemLocator || null,
              fields: view.fields || [],
              isList: view.isList || false
            };
          }
        }
      }
    }

    if (workflowDefs.length > 0) manifest.workflowActions = workflowDefs;

    console.log(
      `[browserwire-cli] merged manifest: ${mergedEntities.length} entities, ` +
      `${mergedActions.length} actions` +
      (mergedViewDefs.length ? `, ${mergedViewDefs.length} views` : "") +
      (mergedPageDefs.length ? `, ${mergedPageDefs.length} pages` : "") +
      (workflowDefs.length ? `, ${workflowDefs.length} workflows` : "")
    );

    return manifest;
  }

  /**
   * Finalize the session: merge per-snapshot enriched manifests with deduplication.
   * Merges at the manifest level (not raw data) to preserve LLM semantic names
   * and avoid the massive duplication from naive interactable concatenation.
   */
  async finalize() {
    await this._queue;
    this.status = "stopped";

    if (this.snapshots.length === 0) {
      console.log(`[browserwire-cli] session ${this.sessionId} finalized with 0 snapshots`);
      return { manifest: null, stats: this.getStats() };
    }

    console.log(`[browserwire-cli] session ${this.sessionId} finalizing ${this.snapshots.length} snapshots`);

    const manifest = await this._buildMergedManifest();
    if (!manifest) {
      return { manifest: null, stats: this.getStats() };
    }

    return {
      manifest,
      draftManifest: manifest,
      enrichedManifest: manifest,
      stats: this.getStats()
    };
  }

  /**
   * Compile a checkpoint manifest from current snapshots without stopping the session.
   * Increments checkpointCount and records the note. Does NOT set status = "stopped".
   *
   * @param {string} [note] - Optional annotation about what was just explored
   * @returns {{ manifest, draftManifest, enrichedManifest, checkpointIndex, stats }}
   */
  async compileCheckpoint(note) {
    await this._queue;

    const checkpointIndex = this.checkpointCount;
    this.checkpointCount += 1;
    if (note) this.checkpointNotes.push(note);

    if (this.snapshots.length === 0) {
      console.log(`[browserwire-cli] session ${this.sessionId} checkpoint-${checkpointIndex}: no snapshots`);
      return { manifest: null, draftManifest: null, enrichedManifest: null, checkpointIndex, stats: this.getStats() };
    }

    console.log(
      `[browserwire-cli] session ${this.sessionId} checkpoint-${checkpointIndex}: ` +
      `${this.snapshots.length} snapshots${note ? ` ("${note}")` : ""}`
    );

    const manifest = await this._buildMergedManifest();

    return {
      manifest,
      draftManifest: manifest,
      enrichedManifest: manifest,
      checkpointIndex,
      stats: this.getStats()
    };
  }

  getStats() {
    let totalEntities = 0;
    let totalActions = 0;
    let totalViews = 0;
    for (const snap of this.snapshots) {
      if (snap.manifest) {
        totalEntities = Math.max(totalEntities, snap.manifest.entities?.length || 0);
        totalActions = Math.max(totalActions, snap.manifest.actions?.length || 0);
        totalViews = Math.max(totalViews, snap.manifest.views?.length || 0);
      } else {
        totalEntities = Math.max(totalEntities, snap.entities?.length || 0);
      }
      totalViews = Math.max(totalViews, snap.views?.length || 0);
    }
    return {
      sessionId: this.sessionId,
      snapshotCount: this.snapshots.length,
      entityCount: totalEntities,
      actionCount: totalActions,
      viewCount: totalViews,
      checkpointCount: this.checkpointCount,
      status: this.status
    };
  }
}
