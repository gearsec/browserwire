/**
 * compile.js — Stage 6: Manifest Draft Compilation
 *
 * Runs on the CLI server. Assembles outputs of Stages 3–5 into a draft
 * BrowserWireManifest conforming to the M0 contract-dsl schema.
 *
 * @typedef {import('../../src/contract-dsl/types').BrowserWireManifest} BrowserWireManifest
 */

import { createHash } from "node:crypto";

const CONTRACT_VERSION = "1.0.0";
const MANIFEST_VERSION = "0.1.0";
const RECIPE_REF = "recipe://static-discovery/v1";

// ---------------------------------------------------------------------------
// Standard error definitions
// ---------------------------------------------------------------------------

const STANDARD_ERRORS = [
  {
    code: "ERR_TARGET_NOT_FOUND",
    messageTemplate: "Locator matched no elements on the page",
    classification: "recoverable"
  },
  {
    code: "ERR_TARGET_AMBIGUOUS",
    messageTemplate: "Locator matched multiple elements (expected exactly one)",
    classification: "recoverable"
  },
  {
    code: "ERR_TARGET_DISABLED",
    messageTemplate: "Target element exists but is currently disabled",
    classification: "recoverable"
  },
  {
    code: "ERR_ACTION_TIMEOUT",
    messageTemplate: "Action did not complete within the allowed time",
    classification: "fatal"
  },
  {
    code: "ERR_PRECONDITION_FAILED",
    messageTemplate: "Action precondition not met",
    classification: "recoverable"
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a stable manifest ID from url.
 */
const deriveManifestId = (url) => {
  try {
    const parsed = new URL(url);
    const pathHash = createHash("sha256")
      .update(parsed.pathname + parsed.search)
      .digest("hex")
      .slice(0, 8);
    return `manifest_${parsed.hostname.replace(/\./g, "_")}_${pathHash}`;
  } catch {
    return `manifest_${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
  }
};

/**
 * Derive site from URL origin.
 */
const deriveSite = (url) => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};

/**
 * Slugify a name for use as an ID segment.
 */
const slugify = (name) => {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40) || "unnamed";
};

/**
 * Map InteractionKind to a human-readable action name prefix.
 */
const interactionVerb = (kind) => {
  const verbs = {
    click: "Click",
    type: "Type into",
    select: "Select from",
    toggle: "Toggle",
    navigate: "Navigate to",
    submit: "Submit",
    scroll: "Scroll"
  };
  return verbs[kind] || "Interact with";
};

/**
 * Map InteractionKind to confidence level string.
 */
const confidenceLevel = (score) => {
  if (score >= 0.8) return "high";
  if (score >= 0.5) return "medium";
  return "low";
};

/**
 * Build a LocatorSetDef from a LocatorCandidate's strategies.
 */
const buildLocatorSet = (locatorCandidate, actionId) => {
  return {
    id: `loc_${actionId}`,
    strategies: locatorCandidate.strategies.map((s) => ({
      kind: s.kind,
      value: s.value,
      confidence: s.confidence
    }))
  };
};

/**
 * Generate action inputs for "type" and "select" interactions.
 */
const generateInputs = (interactable, element, a11yEntry) => {
  const inputs = [];

  if (interactable.interactionKind === "type") {
    const inputType = interactable.inputType || "text";
    const label = a11yEntry?.name || element?.attributes?.placeholder || "field";

    let type = "string";
    if (inputType === "number" || inputType === "range") {
      type = "number";
    }

    inputs.push({
      name: "text",
      type,
      required: a11yEntry?.isRequired || false,
      description: `Value to type into ${label}`
    });
  }

  if (interactable.interactionKind === "select") {
    inputs.push({
      name: "value",
      type: "string",
      required: true,
      description: "Option to select"
    });
  }

  return inputs;
};

/**
 * Build provenance for a discovered item.
 */
const buildProvenance = (capturedAt, sessionId) => ({
  source: "agent",
  sessionId: sessionId || "static-discovery",
  traceIds: [],
  annotationIds: [],
  capturedAt: capturedAt || new Date().toISOString()
});

// ---------------------------------------------------------------------------
// Main compiler
// ---------------------------------------------------------------------------

/**
 * Compile stages 3–5 output into a draft BrowserWireManifest.
 *
 * @param {object} params
 * @param {string} params.url - Page URL
 * @param {string} params.title - Page title
 * @param {string} params.capturedAt - ISO timestamp when the page was scanned
 * @param {Array} params.elements - ScannedElement[]
 * @param {Array} params.a11y - A11yInfo[]
 * @param {Array} params.interactables - InteractableElement[]
 * @param {Array} params.entities - EntityCandidate[]
 * @param {Array} params.locators - LocatorCandidate[]
 * @param {Array} [params.views] - ViewDef[] (pre-built from perception)
 * @param {Array} [params.pages] - PageDef[] (pre-built from perception)
 * @returns {{ manifest: BrowserWireManifest, stats: { entityCount: number, actionCount: number, errorCount: number, locatorSetCount: number } }}
 */
export const compileManifest = ({
  url,
  title,
  capturedAt,
  elements,
  a11y,
  interactables,
  entities,
  locators,
  views,
  pages
}) => {
  const sessionId = `discovery_${Date.now()}`;

  // Build lookup maps
  const elementMap = new Map();
  for (const el of elements) {
    elementMap.set(el.scanId, el);
  }

  const a11yMap = new Map();
  for (const entry of a11y) {
    a11yMap.set(entry.scanId, entry);
  }

  const locatorMap = new Map();
  for (const loc of locators) {
    locatorMap.set(loc.scanId, loc);
  }

  const interactableMap = new Map();
  for (const item of interactables) {
    interactableMap.set(item.scanId, item);
  }

  const provenance = buildProvenance(capturedAt, sessionId);

  // --- Metadata ---
  const metadata = {
    id: deriveManifestId(url),
    site: deriveSite(url),
    createdAt: capturedAt || new Date().toISOString()
  };

  // --- Entities → EntityDef[] ---
  const usedEntityIds = new Set();
  const entityDefs = entities.map((candidate) => {
    let entityId = `entity_${slugify(candidate.name)}`;
    // Ensure uniqueness
    if (usedEntityIds.has(entityId)) {
      entityId = `${entityId}_${candidate.rootScanId}`;
    }
    usedEntityIds.add(entityId);

    // Map signals to contract-dsl SignalDef format
    const signals = candidate.signals.map((s) => ({
      kind: s.kind,
      value: s.value,
      weight: Math.max(0, Math.min(1, s.weight))
    }));

    return {
      id: entityId,
      name: candidate.name,
      description: `${candidate.source} entity discovered on ${title || url}`,
      signals,
      provenance,
      // Store candidateId for action mapping
      _candidateId: candidate.candidateId,
      _memberScanIds: candidate.memberScanIds,
      _interactableScanIds: candidate.interactableScanIds
    };
  });

  // Build scanId → entityId reverse lookup
  const scanIdToEntityId = new Map();
  for (const entityDef of entityDefs) {
    for (const sid of entityDef._interactableScanIds) {
      // First entity wins (entities are priority-ordered)
      if (!scanIdToEntityId.has(sid)) {
        scanIdToEntityId.set(sid, entityDef.id);
      }
    }
  }

  // --- Actions → ActionDef[] ---
  const usedActionIds = new Set();
  const actionDefs = [];

  for (const interactable of interactables) {
    if (interactable.interactionKind === "none") continue;

    const el = elementMap.get(interactable.scanId);
    const a11yEntry = a11yMap.get(interactable.scanId);
    const locatorCandidate = locatorMap.get(interactable.scanId);

    if (!el || !locatorCandidate || locatorCandidate.strategies.length === 0) continue;

    // Find entity this belongs to
    const entityId = scanIdToEntityId.get(interactable.scanId) || null;

    // Derive action name
    const targetName = a11yEntry?.name?.trim().slice(0, 50) || el.textContent?.trim().slice(0, 50) || el.tagName;
    const verb = interactionVerb(interactable.interactionKind);
    const actionName = `${verb} ${targetName}`;

    let actionId = `action_${slugify(actionName)}`;
    if (usedActionIds.has(actionId)) {
      actionId = `${actionId}_${interactable.scanId}`;
    }
    usedActionIds.add(actionId);

    const inputs = generateInputs(interactable, el, a11yEntry);
    const locatorSet = buildLocatorSet(locatorCandidate, actionId);

    // Collect text content for LLM context
    const textContent = (
      a11yEntry?.name?.trim() ||
      el.textContent?.trim() ||
      ""
    ).slice(0, 200);

    // Only include if we have an entity to attach to
    // If no entity found, create an orphan entity
    let resolvedEntityId = entityId;
    if (!resolvedEntityId) {
      const orphanId = `entity_orphan_${interactable.scanId}`;
      entityDefs.push({
        id: orphanId,
        name: targetName,
        description: `Unscoped element discovered on ${title || url}`,
        signals: [],
        provenance,
        _candidateId: null,
        _memberScanIds: [interactable.scanId],
        _interactableScanIds: [interactable.scanId]
      });
      usedEntityIds.add(orphanId);
      resolvedEntityId = orphanId;
    }

    actionDefs.push({
      id: actionId,
      entityId: resolvedEntityId,
      name: actionName,
      interactionKind: interactable.interactionKind,
      textContent: textContent || undefined,
      inputs,
      preconditions: [
        { id: "pre_visible", description: "Target element is visible on the page" }
      ],
      postconditions: [
        { id: "post_exists", description: "Action completed without error" }
      ],
      recipeRef: RECIPE_REF,
      locatorSet,
      errors: ["ERR_TARGET_NOT_FOUND", "ERR_TARGET_AMBIGUOUS"],
      confidence: {
        score: interactable.confidence,
        level: confidenceLevel(interactable.confidence)
      },
      provenance
    });
  }

  // Clean internal fields from entity defs
  const cleanEntityDefs = entityDefs.map(({ _candidateId, _memberScanIds, _interactableScanIds, ...rest }) => rest);

  // --- Assemble manifest ---
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    manifestVersion: MANIFEST_VERSION,
    metadata,
    entities: cleanEntityDefs,
    actions: actionDefs,
    errors: STANDARD_ERRORS
  };

  // Attach views and pages if provided
  if (views && views.length > 0) {
    manifest.views = views;
  }
  if (pages && pages.length > 0) {
    manifest.pages = pages;
  }

  return {
    manifest,
    stats: {
      entityCount: cleanEntityDefs.length,
      actionCount: actionDefs.length,
      errorCount: STANDARD_ERRORS.length,
      locatorSetCount: actionDefs.length,
      viewCount: views?.length || 0,
      pageCount: pages?.length || 0
    }
  };
};
