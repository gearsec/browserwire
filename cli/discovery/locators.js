/**
 * locators.js — Stage 5: Locator Synthesis
 *
 * Runs on the CLI server. For each interactable element, generates one or more
 * locator strategies compatible with LocatorStrategyDef from contract-dsl.
 *
 * Strategy priority: data_testid > role_name > attribute > text > css > dom_path > xpath
 *
 * @typedef {{ scanId: number, strategies: Array<{ kind: string, value: string, confidence: number }> }} LocatorCandidate
 */

const MAX_STRATEGIES_PER_ELEMENT = 5;

// Patterns for detecting auto-generated CSS classes
const DYNAMIC_CLASS_PATTERNS = [
  /^css-/,        // CSS modules, emotion
  /^sc-/,         // styled-components
  /^emotion-/,    // emotion
  /^styled-/,     // styled-components
  /^_[a-zA-Z0-9]{5,}/, // underscore + hash
  /^[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}$/, // camelCase hash (e.g., bdfBwQ)
  /^[a-zA-Z]+-[a-f0-9]{4,}$/,  // prefix-hash (e.g., module-3a2b1c)
];

// Attributes considered stable for locator generation
const STABLE_ATTRIBUTES = ["name", "type", "href", "placeholder", "aria-label", "for", "id", "action", "method"];

/**
 * Check if a CSS class looks auto-generated.
 */
const isDynamicClass = (cls) => {
  return DYNAMIC_CLASS_PATTERNS.some((pattern) => pattern.test(cls));
};

/**
 * Build parent chain from an element up to the root.
 * Returns array of scanIds from root to element (inclusive).
 */
const buildParentChain = (scanId, elementMap) => {
  const chain = [];
  let current = scanId;

  while (current !== null && current !== undefined) {
    chain.unshift(current);
    const el = elementMap.get(current);
    current = el?.parentScanId ?? null;
  }

  return chain;
};

/**
 * Compute the nth-child index of an element among its parent's children.
 */
const getNthChildIndex = (el, elementMap) => {
  if (el.parentScanId === null) return 1;

  const parent = elementMap.get(el.parentScanId);
  if (!parent) return 1;

  const sameTagSiblings = parent.childScanIds.filter((cid) => {
    const sibling = elementMap.get(cid);
    return sibling && sibling.tagName === el.tagName;
  });

  if (sameTagSiblings.length <= 1) return 0; // No need for nth-child

  return sameTagSiblings.indexOf(el.scanId) + 1;
};

/**
 * Generate a dom_path locator: tag path from body with nth-child qualifiers.
 * e.g., "body > main > div:nth-child(2) > button"
 */
const generateDomPath = (scanId, elementMap) => {
  const chain = buildParentChain(scanId, elementMap);
  const parts = [];

  for (const sid of chain) {
    const el = elementMap.get(sid);
    if (!el) continue;

    let segment = el.tagName;
    const nth = getNthChildIndex(el, elementMap);
    if (nth > 0) {
      segment += `:nth-child(${nth})`;
    }

    parts.push(segment);
  }

  return parts.join(" > ");
};

/**
 * Generate an XPath locator.
 * e.g., "/html/body/main/div[2]/button[1]"
 */
const generateXPath = (scanId, elementMap) => {
  const chain = buildParentChain(scanId, elementMap);
  const parts = [];

  for (const sid of chain) {
    const el = elementMap.get(sid);
    if (!el) continue;

    let segment = el.tagName;
    const nth = getNthChildIndex(el, elementMap);
    if (nth > 0) {
      segment += `[${nth}]`;
    }

    parts.push(segment);
  }

  return "/" + parts.join("/");
};

/**
 * Generate a CSS selector from stable attributes.
 * Avoids dynamic classes.
 */
const generateCssSelector = (el) => {
  const parts = [el.tagName];

  // Try ID first (most specific)
  const id = el.attributes.id;
  if (id && !isDynamicClass(id)) {
    return `#${CSS_escape(id)}`;
  }

  // Try stable classes
  const classAttr = el.attributes.class;
  if (classAttr) {
    const classes = classAttr.split(/\s+/).filter((c) => c && !isDynamicClass(c));
    if (classes.length > 0) {
      // Use up to 2 stable classes
      const usable = classes.slice(0, 2);
      parts.push(...usable.map((c) => `.${CSS_escape(c)}`));
      return parts.join("");
    }
  }

  // Try type attribute for inputs
  if (el.tagName === "input" && el.attributes.type) {
    return `input[type="${el.attributes.type}"]`;
  }

  // Bare tag name (low uniqueness)
  return el.tagName;
};

/**
 * Escape a string for use in CSS selectors.
 */
const CSS_escape = (str) => {
  return str.replace(/([^\w-])/g, "\\$1");
};

/**
 * Build a uniqueness index: for each potential locator value, how many
 * elements match it.
 */
const buildUniquenessIndex = (elements, a11yMap) => {
  const counts = {
    testid: new Map(),
    roleName: new Map(),
    text: new Map(),
    id: new Map()
  };

  for (const el of elements) {
    const testid = el.attributes["data-testid"];
    if (testid) {
      counts.testid.set(testid, (counts.testid.get(testid) || 0) + 1);
    }

    const a11y = a11yMap.get(el.scanId);
    if (a11y?.role && a11y?.name) {
      const key = `${a11y.role}:${a11y.name}`;
      counts.roleName.set(key, (counts.roleName.get(key) || 0) + 1);
    }

    if (el.textContent) {
      const text = el.textContent.trim().slice(0, 100);
      if (text) {
        counts.text.set(text, (counts.text.get(text) || 0) + 1);
      }
    }

    const id = el.attributes.id;
    if (id) {
      counts.id.set(id, (counts.id.get(id) || 0) + 1);
    }
  }

  return counts;
};

/**
 * Synthesize locator strategies for a single interactable element.
 */
const synthesizeLocators = (el, a11y, elementMap, uniqueness) => {
  const strategies = [];

  // 1. data_testid (confidence: 0.95)
  const testid = el.attributes["data-testid"];
  if (testid) {
    const count = uniqueness.testid.get(testid) || 1;
    const conf = count === 1 ? 0.95 : 0.95 / count;
    strategies.push({ kind: "data_testid", value: testid, confidence: conf });
  }

  // 2. role_name (confidence: 0.90)
  if (a11y?.role && a11y?.name && a11y.name.trim()) {
    const key = `${a11y.role}:${a11y.name}`;
    const count = uniqueness.roleName.get(key) || 1;
    const value = `${a11y.role} "${a11y.name.trim()}"`;
    const conf = count === 1 ? 0.90 : 0.90 / count;
    strategies.push({ kind: "role_name", value, confidence: conf });
  }

  // 3. attribute — stable attributes (confidence: 0.80)
  for (const attr of STABLE_ATTRIBUTES) {
    const val = el.attributes[attr];
    if (!val) continue;
    // Skip if we already used this attr in another strategy
    if (attr === "aria-label" && a11y?.name) continue;
    if (attr === "id") {
      const count = uniqueness.id.get(val) || 1;
      const conf = count === 1 ? 0.85 : 0.85 / count;
      strategies.push({ kind: "attribute", value: `id:${val}`, confidence: conf });
      continue;
    }
    strategies.push({ kind: "attribute", value: `${attr}:${val}`, confidence: 0.80 });
  }

  // 4. text (confidence: 0.70)
  if (el.textContent) {
    const text = el.textContent.trim().slice(0, 100);
    if (text) {
      const count = uniqueness.text.get(text) || 1;
      const conf = count === 1 ? 0.70 : 0.70 / count;
      strategies.push({ kind: "text", value: text, confidence: conf });
    }
  }

  // 5. css (confidence: 0.60)
  const css = generateCssSelector(el);
  if (css !== el.tagName) { // Only emit if more specific than bare tag
    strategies.push({ kind: "css", value: css, confidence: 0.60 });
  }

  // 6. dom_path (confidence: 0.40)
  const domPath = generateDomPath(el.scanId, elementMap);
  if (domPath) {
    strategies.push({ kind: "dom_path", value: domPath, confidence: 0.40 });
  }

  // 7. xpath (confidence: 0.30)
  const xpath = generateXPath(el.scanId, elementMap);
  if (xpath) {
    strategies.push({ kind: "xpath", value: xpath, confidence: 0.30 });
  }

  // Sort by confidence desc, take top N
  strategies.sort((a, b) => b.confidence - a.confidence);
  return strategies.slice(0, MAX_STRATEGIES_PER_ELEMENT);
};

/**
 * Synthesize locators for all interactable elements.
 *
 * @param {Array} elements - ScannedElement[]
 * @param {Array} a11yEntries - A11yInfo[]
 * @param {Array} interactables - InteractableElement[]
 * @returns {{ locators: LocatorCandidate[], stats: { total: number, avgStrategies: number, byKind: Record<string, number> } }}
 */
export const synthesizeAllLocators = (elements, a11yEntries, interactables) => {
  const elementMap = new Map();
  for (const el of elements) {
    elementMap.set(el.scanId, el);
  }

  const a11yMap = new Map();
  for (const entry of a11yEntries) {
    a11yMap.set(entry.scanId, entry);
  }

  const uniqueness = buildUniquenessIndex(elements, a11yMap);

  const interactableSet = new Set(interactables.map((i) => i.scanId));

  const locators = [];
  const byKind = {};
  let totalStrategies = 0;

  for (const item of interactables) {
    const el = elementMap.get(item.scanId);
    if (!el) continue;

    const a11y = a11yMap.get(item.scanId) || null;
    const strategies = synthesizeLocators(el, a11y, elementMap, uniqueness);

    if (strategies.length > 0) {
      locators.push({
        scanId: item.scanId,
        strategies
      });

      totalStrategies += strategies.length;
      for (const s of strategies) {
        byKind[s.kind] = (byKind[s.kind] || 0) + 1;
      }
    }
  }

  return {
    locators,
    stats: {
      total: locators.length,
      avgStrategies: locators.length > 0 ? +(totalStrategies / locators.length).toFixed(1) : 0,
      byKind
    }
  };
};
