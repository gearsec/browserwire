/**
 * entities.js — Stage 4: Entity Grouping
 *
 * Runs on the CLI server. Takes ScannedElement[] + A11yInfo[] + InteractableElement[]
 * and clusters related elements into semantic EntityCandidates.
 *
 * Grouping heuristics (in priority order):
 *   1. data-testid boundaries
 *   2. Landmark roles (form, navigation, main, dialog, etc.)
 *   3. Semantic containers (article, section, fieldset, li, tr, etc.)
 *   4. Repeated structure (parent with multiple children of same tag)
 *
 * @typedef {{ candidateId: string, name: string, source: string, rootScanId: number, memberScanIds: number[], signals: Array<{kind: string, value: string, weight: number}>, interactableScanIds: number[] }} EntityCandidate
 */

// Tags that form natural entity boundaries
const SEMANTIC_CONTAINER_TAGS = new Set([
  "article", "section", "fieldset", "li", "tr", "details", "dialog",
  "figure", "blockquote"
]);

// Roles that form natural entity boundaries
const LANDMARK_ROLES = new Set([
  "form", "navigation", "main", "region", "complementary", "dialog",
  "banner", "contentinfo", "search", "alertdialog", "group"
]);

// Tags whose role already qualifies as landmark (avoid double-detection)
const LANDMARK_TAG_ROLES = new Map([
  ["nav", "navigation"],
  ["main", "main"],
  ["form", "form"],
  ["aside", "complementary"],
  ["header", "banner"],
  ["footer", "contentinfo"],
  ["dialog", "dialog"]
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Collect all descendants of a given scanId (inclusive) from the element map.
 */
const collectDescendants = (rootScanId, elementMap) => {
  const result = [];
  const queue = [rootScanId];

  while (queue.length > 0) {
    const id = queue.shift();
    result.push(id);
    const el = elementMap.get(id);
    if (el && el.childScanIds) {
      queue.push(...el.childScanIds);
    }
  }

  return result;
};

/**
 * Derive a human-readable name for an entity rooted at the given element.
 *
 * Priority:
 *   1. aria-label or aria-labelledby on the container
 *   2. First heading child (h1–h6)
 *   3. First <legend> child (for fieldsets)
 *   4. data-testid value (titlecased)
 *   5. Tag + role fallback
 */
const deriveName = (rootElement, rootA11y, memberScanIds, elementMap, a11yMap) => {
  // 1. aria-label
  const ariaLabel = rootElement.attributes["aria-label"];
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim().slice(0, 80);
  }

  // 1b. a11y name from the root
  if (rootA11y && rootA11y.name && rootA11y.name.trim()) {
    // Only use if it's short enough to be a label (not full text content)
    const name = rootA11y.name.trim();
    if (name.length <= 80) {
      return name;
    }
  }

  // 2. First heading child
  for (const sid of memberScanIds) {
    const el = elementMap.get(sid);
    if (el && HEADING_TAGS.has(el.tagName)) {
      const headingA11y = a11yMap.get(sid);
      const text = headingA11y?.name || el.textContent || "";
      if (text.trim()) {
        return text.trim().slice(0, 80);
      }
    }
  }

  // 3. First <legend> child
  for (const sid of memberScanIds) {
    const el = elementMap.get(sid);
    if (el && el.tagName === "legend") {
      const text = el.textContent || "";
      if (text.trim()) {
        return text.trim().slice(0, 80);
      }
    }
  }

  // 4. data-testid
  const testid = rootElement.attributes["data-testid"];
  if (testid) {
    return testid
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
  }

  // 5. Fallback: tag + role
  const role = rootA11y?.role || "";
  const tag = rootElement.tagName;
  if (role && role !== "none") {
    return `${tag} (${role})`;
  }
  return tag;
};

/**
 * Build signals for a DSL-compatible SignalDef from the entity root.
 */
const buildSignals = (rootElement, rootA11y) => {
  const signals = [];

  // Role signal
  if (rootA11y?.role) {
    signals.push({ kind: "role", value: rootA11y.role, weight: 0.8 });
  }

  // Text signal (from a11y name)
  if (rootA11y?.name && rootA11y.name.trim().length <= 100) {
    signals.push({ kind: "text", value: rootA11y.name.trim(), weight: 0.6 });
  }

  // data-testid as attribute signal
  const testid = rootElement.attributes["data-testid"];
  if (testid) {
    signals.push({ kind: "attribute", value: `data-testid:${testid}`, weight: 0.9 });
  }

  // aria-label as attribute signal
  const ariaLabel = rootElement.attributes["aria-label"];
  if (ariaLabel) {
    signals.push({ kind: "attribute", value: `aria-label:${ariaLabel}`, weight: 0.7 });
  }

  return signals;
};

/**
 * Detect repeated structure: a parent that has multiple children with
 * the same tag name, suggesting a list-like pattern.
 */
const findRepeatedStructures = (elements, elementMap, a11yMap, claimed) => {
  const candidates = [];

  for (const el of elements) {
    if (claimed.has(el.scanId)) continue;
    if (el.childScanIds.length < 2) continue;

    // Count children by tag
    const tagCounts = new Map();
    for (const childId of el.childScanIds) {
      const child = elementMap.get(childId);
      if (!child || claimed.has(childId)) continue;
      const count = tagCounts.get(child.tagName) || 0;
      tagCounts.set(child.tagName, count + 1);
    }

    // Find tags that repeat at least 2 times
    for (const [tag, count] of tagCounts) {
      if (count < 2) continue;

      // Skip generic divs/spans with no semantic meaning unless they have roles
      if ((tag === "div" || tag === "span")) {
        // Check if the repeating children have roles
        const childrenWithRoles = el.childScanIds.filter((cid) => {
          const a = a11yMap.get(cid);
          return a && a.role && a.role !== "none";
        });
        if (childrenWithRoles.length < 2) continue;
      }

      // Each repeating child becomes its own entity
      for (const childId of el.childScanIds) {
        const child = elementMap.get(childId);
        if (!child || child.tagName !== tag || claimed.has(childId)) continue;

        const memberIds = collectDescendants(childId, elementMap);
        const childA11y = a11yMap.get(childId) || null;

        candidates.push({
          rootScanId: childId,
          source: "repeated_structure",
          memberScanIds: memberIds,
          name: deriveName(child, childA11y, memberIds, elementMap, a11yMap),
          signals: buildSignals(child, childA11y)
        });

        // Claim all members
        for (const mid of memberIds) {
          claimed.add(mid);
        }
      }
    }
  }

  return candidates;
};

/**
 * Group all elements into entity candidates.
 *
 * @param {Array} elements - ScannedElement[]
 * @param {Array} a11yEntries - A11yInfo[]
 * @param {Array} interactables - InteractableElement[]
 * @returns {{ entities: EntityCandidate[], stats: { total: number, entityCount: number, bySource: Record<string, number> } }}
 */
export const groupEntities = (elements, a11yEntries, interactables) => {
  // Build lookup maps
  const elementMap = new Map();
  for (const el of elements) {
    elementMap.set(el.scanId, el);
  }

  const a11yMap = new Map();
  for (const entry of a11yEntries) {
    a11yMap.set(entry.scanId, entry);
  }

  const interactableSet = new Set();
  for (const item of interactables) {
    interactableSet.add(item.scanId);
  }

  // Track which scanIds have been claimed by an entity
  const claimed = new Set();
  const rawCandidates = [];

  // --- Pass 1: data-testid boundaries (highest priority) ---
  for (const el of elements) {
    if (claimed.has(el.scanId)) continue;
    const testid = el.attributes["data-testid"];
    if (!testid) continue;

    const memberIds = collectDescendants(el.scanId, elementMap);
    const a11y = a11yMap.get(el.scanId) || null;

    rawCandidates.push({
      rootScanId: el.scanId,
      source: "testid",
      memberScanIds: memberIds,
      name: deriveName(el, a11y, memberIds, elementMap, a11yMap),
      signals: buildSignals(el, a11y)
    });

    for (const mid of memberIds) {
      claimed.add(mid);
    }
  }

  // --- Pass 2: Landmark roles ---
  for (const el of elements) {
    if (claimed.has(el.scanId)) continue;

    const a11y = a11yMap.get(el.scanId) || null;
    const role = a11y?.role || "";

    // Check if tag is a landmark tag
    const isLandmarkTag = LANDMARK_TAG_ROLES.has(el.tagName);
    const isLandmarkRole = LANDMARK_ROLES.has(role);

    if (!isLandmarkTag && !isLandmarkRole) continue;

    const memberIds = collectDescendants(el.scanId, elementMap);

    rawCandidates.push({
      rootScanId: el.scanId,
      source: isLandmarkTag ? "landmark" : "landmark",
      memberScanIds: memberIds,
      name: deriveName(el, a11y, memberIds, elementMap, a11yMap),
      signals: buildSignals(el, a11y)
    });

    for (const mid of memberIds) {
      claimed.add(mid);
    }
  }

  // --- Pass 3: Semantic containers ---
  for (const el of elements) {
    if (claimed.has(el.scanId)) continue;
    if (!SEMANTIC_CONTAINER_TAGS.has(el.tagName)) continue;

    const memberIds = collectDescendants(el.scanId, elementMap);
    const a11y = a11yMap.get(el.scanId) || null;

    rawCandidates.push({
      rootScanId: el.scanId,
      source: "semantic_container",
      memberScanIds: memberIds,
      name: deriveName(el, a11y, memberIds, elementMap, a11yMap),
      signals: buildSignals(el, a11y)
    });

    for (const mid of memberIds) {
      claimed.add(mid);
    }
  }

  // --- Pass 4: Repeated structure ---
  const repeatedCandidates = findRepeatedStructures(elements, elementMap, a11yMap, claimed);
  rawCandidates.push(...repeatedCandidates);

  // --- Assign IDs and calculate interactable membership ---
  let entityIndex = 0;
  const entities = [];
  const bySource = {};

  for (const raw of rawCandidates) {
    // Skip entities with no members beyond the root itself
    // (unless the root itself is interactable)
    const memberInteractables = raw.memberScanIds.filter((id) => interactableSet.has(id));

    const entity = {
      candidateId: `entity_${entityIndex++}`,
      name: raw.name,
      source: raw.source,
      rootScanId: raw.rootScanId,
      memberScanIds: raw.memberScanIds,
      signals: raw.signals,
      interactableScanIds: memberInteractables
    };

    entities.push(entity);
    bySource[raw.source] = (bySource[raw.source] || 0) + 1;
  }

  return {
    entities,
    stats: {
      total: elements.length,
      entityCount: entities.length,
      bySource,
      unclaimedElements: elements.length - claimed.size
    }
  };
};
