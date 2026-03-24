/**
 * snapshot-index.js — Internal Infrastructure: rrweb Snapshot → Queryable Index
 *
 * Parses an rrweb snapshot JSON tree into a queryable in-memory representation
 * with stable ref IDs and parent/child links. Roles and names come from CDP
 * via enrichWithCDP() — no heuristic role/classification computation.
 *
 * Walks the rrweb JSON tree directly to build the index — no DOM needed.
 * Selector testing is handled by Playwright (see playwright-browser.js).
 *
 * All external access goes through getters and query methods — internal state
 * (maps, arrays) is private.
 *
 * NOT an agent tool — this is the data structure that all tools query against.
 *
 * Inspired by Playwright MCP's accessibility tree snapshots.
 */

import { filterNetworkLogs } from "../filter-network-logs.js";

// ---------------------------------------------------------------------------
// Structural filtering — skip non-visual elements
// ---------------------------------------------------------------------------

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "svg", "template", "path",
  "meta", "link", "br", "hr",
]);

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

// ---------------------------------------------------------------------------
// rrweb node types
// ---------------------------------------------------------------------------

const RRWEB_ELEMENT = 2;
const RRWEB_TEXT = 3;

// ---------------------------------------------------------------------------
// SnapshotIndex class
// ---------------------------------------------------------------------------

export class SnapshotIndex {
  /**
   * @param {object} options
   * @param {object} options.rrwebSnapshot - Parsed rrweb snapshot tree (JSON)
   * @param {import('./playwright-browser.js').PlaywrightBrowser} options.browser - Playwright browser instance (required)
   * @param {string|null} [options.screenshot] - Base64 screenshot
   * @param {object[]} [options.networkLogs] - Raw network logs
   * @param {string} [options.url] - Page URL
   * @param {string} [options.title] - Page title
   */
  constructor({ rrwebSnapshot, browser, screenshot = null, networkLogs = [], url = "", title = "" }) {
    /** @type {import('./playwright-browser.js').PlaywrightBrowser} */
    this._browser = browser;
    /** @type {Map<string, IndexedNode>} ref → node */
    this._byRef = new Map();
    /** @type {Map<string, IndexedNode[]>} tag → nodes */
    this._byTag = new Map();
    /** @type {Map<string, IndexedNode[]>} role → nodes */
    this._byRole = new Map();
    /** @type {IndexedNode[]} Root-level nodes */
    this._roots = [];
    /** @type {string|null} */
    this._screenshot = screenshot;
    /** @type {object[]} Filtered network logs */
    this._networkLogs = networkLogs.length > 0
      ? filterNetworkLogs({ networkLogs })
      : [];
    /** @type {string} */
    this._url = url;
    /** @type {string} */
    this._title = title;

    this._nextRefId = 1;
    this._rrwebIdToRef = new Map();

    /** @type {object} Raw rrweb snapshot JSON for Playwright rebuild */
    this._rawRrwebSnapshot = rrwebSnapshot;

    this._indexRrwebTree(rrwebSnapshot);
  }

  // -------------------------------------------------------------------------
  // CDP Accessibility Enrichment
  // -------------------------------------------------------------------------

  /**
   * Destroy the index, closing the browser instance.
   * @returns {Promise<void>}
   */
  async destroy() {
    await this._browser.close();
  }

  /**
   * Enrich the index with Chrome's real accessibility tree via CDP.
   * Loads the rrweb snapshot into the browser, fetches the full AX tree,
   * and overrides heuristic role/name with CDP-accurate values.
   *
   * @returns {Promise<void>}
   */
  async enrichWithCDP() {
    const browser = this._browser;

    // Load snapshot into Playwright
    const page = await browser.loadSnapshot(this._rawRrwebSnapshot, this._url);

    // Get CDP accessibility tree
    const cdpNodes = await browser.getAccessibilityTree(page);

    // Map CDP nodes → rrweb IDs
    const cdpToRrweb = await browser.mapCDPNodesToRrwebIds(page, cdpNodes);

    // Build reverse lookup: rrwebId → CDP node
    const rrwebToCdp = new Map();
    for (const node of cdpNodes) {
      const rrwebId = cdpToRrweb.get(node.nodeId);
      if (rrwebId) {
        rrwebToCdp.set(rrwebId, node);
      }
    }

    // Enrich indexed nodes with CDP data
    for (const [ref, indexed] of this._byRef) {
      if (!indexed.rrwebId) continue;
      const cdpNode = rrwebToCdp.get(indexed.rrwebId);
      if (!cdpNode) continue;

      // Store every CDP role on the node; only index semantic roles in _byRole
      const cdpRole = cdpNode.role?.value;
      if (cdpRole) {
        const isSemantic = cdpRole !== "none" && cdpRole !== "generic";
        // Update role index: remove from old bucket
        if (indexed.role && indexed.role !== cdpRole) {
          const oldList = this._byRole.get(indexed.role);
          if (oldList) {
            const idx = oldList.indexOf(indexed);
            if (idx >= 0) oldList.splice(idx, 1);
            if (oldList.length === 0) this._byRole.delete(indexed.role);
          }
        }
        indexed.role = cdpRole;
        if (isSemantic) {
          if (!this._byRole.has(cdpRole)) this._byRole.set(cdpRole, []);
          if (!this._byRole.get(cdpRole).includes(indexed)) {
            this._byRole.get(cdpRole).push(indexed);
          }
        }
      }

      // Override name if CDP provides one
      const cdpName = cdpNode.name?.value;
      if (cdpName) {
        indexed.name = cdpName;
      }

      // Extract accessibility states from CDP properties
      const states = {};
      if (cdpNode.properties) {
        for (const prop of cdpNode.properties) {
          switch (prop.name) {
            case "checked":
              states.checked = prop.value?.value;
              break;
            case "expanded":
              states.expanded = prop.value?.value;
              break;
            case "selected":
              states.selected = prop.value?.value;
              break;
            case "disabled":
              states.disabled = prop.value?.value;
              break;
            case "required":
              states.required = prop.value?.value;
              break;
            case "level":
              states.level = prop.value?.value;
              break;
          }
        }
      }
      if (Object.keys(states).length > 0) {
        indexed.states = states;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Getters — public read-only access to snapshot metadata
  // -------------------------------------------------------------------------

  /** @returns {string|null} Base64 screenshot */
  get screenshot() { return this._screenshot; }

  /** @returns {object[]} Filtered network logs */
  get networkLogs() { return this._networkLogs; }

  /** @returns {string} Page URL */
  get url() { return this._url; }

  /** @returns {string} Page title */
  get title() { return this._title; }

  /** @returns {number} Total number of indexed nodes */
  get size() { return this._byRef.size; }

  /** @returns {Map<number, string>} rrweb ID → ref ID mapping (read-only) */
  get rrwebIdToRef() { return this._rrwebIdToRef; }

  /** @returns {object} Raw rrweb snapshot JSON */
  get rawRrwebSnapshot() { return this._rawRrwebSnapshot; }

  // -------------------------------------------------------------------------
  // Indexing (private)
  // -------------------------------------------------------------------------

  _allocRef() {
    return `e${this._nextRefId++}`;
  }

  /**
   * Find the body element node in an rrweb snapshot tree.
   * rrweb snapshots are: Document → [doctype, html → [head, body]]
   */
  _findBodyNode(rrwebRoot) {
    if (!rrwebRoot) return null;

    // If it IS the body node
    if (rrwebRoot.type === RRWEB_ELEMENT && (rrwebRoot.tagName || "").toLowerCase() === "body") {
      return rrwebRoot;
    }

    // Search children
    for (const child of rrwebRoot.childNodes || []) {
      const found = this._findBodyNode(child);
      if (found) return found;
    }
    return null;
  }

  /**
   * Walk the rrweb JSON tree directly to build the index.
   * No DOM reconstruction needed — attributes, text, and structure
   * are all available in the rrweb JSON format.
   */
  _indexRrwebTree(rrwebRoot) {
    if (!rrwebRoot) return;

    const bodyNode = this._findBodyNode(rrwebRoot);
    if (!bodyNode) return;

    this._walkRrwebNode(bodyNode, null);
  }

  /**
   * Walk a single rrweb JSON node and its children, building indexed nodes.
   *
   * rrweb element nodes (type 2) have:
   *   { type: 2, tagName, attributes: {}, childNodes: [], id }
   * rrweb text nodes (type 3) have:
   *   { type: 3, textContent, id }
   */
  _walkRrwebNode(rrwebNode, parentRef) {
    if (rrwebNode.type !== RRWEB_ELEMENT) return null;

    const tag = (rrwebNode.tagName || "").toLowerCase();
    if (!tag || SKIP_TAGS.has(tag)) return null;

    const attributes = rrwebNode.attributes || {};
    const ref = this._allocRef();

    // Get direct text parts (text node children only)
    const textParts = [];
    for (const child of rrwebNode.childNodes || []) {
      if (child.type === RRWEB_TEXT) {
        const text = (child.textContent || "").trim();
        if (text) textParts.push(text);
      }
    }

    const rrwebId = rrwebNode.id;

    const indexed = {
      ref,
      rrwebId: rrwebId > 0 ? rrwebId : null,
      tag,
      role: null,   // CDP fills this via enrichWithCDP()
      name: null,   // CDP fills this via enrichWithCDP()
      attributes,
      textParts,
      parentRef,
      childRefs: [],
      inShadow: false,
    };

    // Register in indexes
    this._byRef.set(ref, indexed);

    if (rrwebId > 0) {
      this._rrwebIdToRef.set(rrwebId, ref);
    }

    if (!this._byTag.has(tag)) this._byTag.set(tag, []);
    this._byTag.get(tag).push(indexed);

    // _byRole populated during enrichWithCDP() — role starts null

    // Link to parent
    if (parentRef) {
      const parent = this._byRef.get(parentRef);
      if (parent) {
        parent.childRefs.push(ref);
      }
    } else {
      this._roots.push(indexed);
    }

    // Process element children
    for (const child of rrwebNode.childNodes || []) {
      this._walkRrwebNode(child, ref);
    }

    return indexed;
  }

  // -------------------------------------------------------------------------
  // Text content
  // -------------------------------------------------------------------------

  /**
   * Get direct text content of a node (not including children).
   */
  getDirectText(ref) {
    const node = this._byRef.get(ref);
    return node ? node.textParts.join(" ").trim() : "";
  }

  /**
   * Get full text content (including descendants) by walking the index tree.
   */
  getFullText(ref) {
    const node = this._byRef.get(ref);
    if (!node) return "";
    return this._getFullTextFromIndex(node);
  }

  /**
   * Recursively collect text from an indexed node and its descendants.
   */
  _getFullTextFromIndex(node) {
    const parts = [...node.textParts];
    for (const childRef of node.childRefs) {
      const child = this._byRef.get(childRef);
      if (child) {
        const childText = this._getFullTextFromIndex(child);
        if (childText) parts.push(childText);
      }
    }
    return parts.join(" ").trim();
  }

  // -------------------------------------------------------------------------
  // Accessibility tree serialization (Playwright MCP format)
  // -------------------------------------------------------------------------

  /**
   * Serialize the accessibility tree as YAML-style text.
   *
   * @param {object} [options]
   * @param {string} [options.rootRef] - Scope to a subtree
   * @returns {string} YAML-style accessibility tree
   */
  toAccessibilityTree(options = {}) {
    const { rootRef } = options;
    const lines = [];

    if (rootRef) {
      const root = this._byRef.get(rootRef);
      if (!root) return `[unknown ref: ${rootRef}]`;
      this._serializeNode(root, 0, lines);
    } else {
      for (const root of this._roots) {
        this._serializeNode(root, 0, lines);
      }
    }

    return lines.join("\n");
  }

  /**
   * Serialize a single node and its children.
   */
  _serializeNode(node, depth, lines) {
    const indent = "  ".repeat(depth);
    const label = this._formatNodeLabel(node);

    if (label) {
      lines.push(`${indent}- ${label}`);
    }

    // Recurse into children
    const nextDepth = label ? depth + 1 : depth;
    for (const childRef of node.childRefs) {
      const child = this._byRef.get(childRef);
      if (child) {
        this._serializeNode(child, nextDepth, lines);
      }
    }
  }

  /**
   * Format a node label for the accessibility tree.
   * Returns null if the node should be skipped (generic with no semantic value).
   */
  _formatNodeLabel(node) {
    const { tag, role, name, ref, attributes } = node;
    const isSemantic = role && role !== "none" && role !== "generic";

    // Skip empty wrappers — no semantic role AND no text content
    if (!isSemantic && (!node.textParts || node.textParts.length === 0)) {
      return null;
    }

    // Label: semantic role, or "text" for generic nodes with content
    const label = isSemantic ? (role !== tag ? role : tag) : "text";

    // Name: CDP name, or joined textParts for generic text nodes
    const displayName = name || (isSemantic ? null : node.textParts.join(" "));
    const nameStr = displayName ? ` "${displayName.slice(0, 80)}"` : "";

    // State annotations — prefer CDP states, fall back to ARIA attributes
    const states = node.states || {};
    const annotations = [];

    const stateMap = [
      ["level",    states.level ?? (HEADING_TAGS.has(tag) ? tag[1] : null)],
      ["type",     tag === "input" ? attributes.type : null],
      ["expanded", states.expanded ?? attributes["aria-expanded"] ?? null],
      ["checked",  states.checked ?? attributes["aria-checked"] ?? null],
    ];
    for (const [key, val] of stateMap) {
      if (val != null) annotations.push(`${key}=${val}`);
    }

    // Boolean states (only show when true)
    const boolStates = [
      ["selected", states.selected ?? (attributes["aria-selected"] === "true")],
      ["disabled", states.disabled ?? (attributes["aria-disabled"] === "true") ?? (attributes.disabled !== undefined)],
      ["required", states.required ?? (attributes.required !== undefined) ?? (attributes["aria-required"] === "true")],
    ];
    for (const [key, val] of boolStates) {
      if (val) annotations.push(key);
    }

    const stateStr = annotations.length ? " " + annotations.join(" ") : "";
    const shadowStr = node.inShadow ? " [shadow]" : "";

    return `${label}${nameStr}${stateStr} [ref=${ref}]${shadowStr}`;
  }

  // -------------------------------------------------------------------------
  // Query helpers
  // -------------------------------------------------------------------------

  /**
   * Get a node by ref.
   * @param {string} ref
   * @returns {IndexedNode|undefined}
   */
  getNode(ref) {
    return this._byRef.get(ref);
  }

  /**
   * Get all indexed nodes.
   * @returns {IndexedNode[]}
   */
  getAllNodes() {
    return [...this._byRef.values()];
  }

  /**
   * Get all nodes with a given role.
   * @param {string} role
   * @returns {IndexedNode[]}
   */
  getByRole(role) {
    return this._byRole.get(role) || [];
  }

  /**
   * Get all nodes with a given tag.
   * @param {string} tag
   * @returns {IndexedNode[]}
   */
  getByTag(tag) {
    return this._byTag.get(tag) || [];
  }

  /**
   * Get all descendants of a node (including the node itself).
   * @param {string} ref
   * @returns {IndexedNode[]}
   */
  getSubtree(ref) {
    const result = [];
    const node = this._byRef.get(ref);
    if (!node) return result;

    const walk = (n) => {
      result.push(n);
      for (const childRef of n.childRefs) {
        const child = this._byRef.get(childRef);
        if (child) walk(child);
      }
    };
    walk(node);
    return result;
  }

  /**
   * Find the nearest ancestor matching a predicate.
   * @param {string} ref
   * @param {(node: IndexedNode) => boolean} predicate
   * @returns {IndexedNode|null}
   */
  findAncestor(ref, predicate) {
    let current = this._byRef.get(ref);
    while (current && current.parentRef) {
      current = this._byRef.get(current.parentRef);
      if (current && predicate(current)) return current;
    }
    return null;
  }

  /**
   * Get all children of a node.
   * @param {string} ref
   * @returns {IndexedNode[]}
   */
  getChildren(ref) {
    const node = this._byRef.get(ref);
    if (!node) return [];
    return node.childRefs
      .map((r) => this._byRef.get(r))
      .filter(Boolean);
  }

  /**
   * Build a CSS selector for a node using its attributes.
   * Reuses logic from locators.js.
   */
  buildCssSelector(ref) {
    const node = this._byRef.get(ref);
    if (!node) return null;

    const { tag, attributes } = node;

    // data-testid
    if (attributes["data-testid"]) {
      return `[data-testid="${attributes["data-testid"]}"]`;
    }

    // id (non-dynamic)
    if (attributes.id && !/^[a-f0-9]{8,}$/i.test(attributes.id) && attributes.id.length < 60) {
      return `#${cssEscape(attributes.id)}`;
    }

    // Stable classes
    if (attributes.class) {
      const classes = attributes.class.split(/\s+/).filter((c) => c && !isDynamicClass(c));
      if (classes.length > 0) {
        return `${tag}.${classes.slice(0, 2).map(cssEscape).join(".")}`;
      }
    }

    // ARIA label
    if (attributes["aria-label"]) {
      return `${tag}[aria-label="${attributes["aria-label"]}"]`;
    }

    // type for inputs
    if (tag === "input" && attributes.type) {
      return `input[type="${attributes.type}"]`;
    }

    // Name attribute
    if (attributes.name) {
      return `${tag}[name="${attributes.name}"]`;
    }

    // Placeholder
    if (attributes.placeholder) {
      return `${tag}[placeholder="${attributes.placeholder}"]`;
    }

    return tag;
  }

  /**
   * Build a CSS selector for a target node relative to an ancestor node.
   * Produces selectors like `a h3`, `.event-title`, `div[data-field="price"]`
   * instead of brittle `div:nth-child(2) > div:nth-child(1)`.
   *
   * Strategy at each level:
   *   1. tag.stable-class
   *   2. tag[data-*] or tag[aria-label]
   *   3. tag:nth-of-type(N) (not nth-child)
   *   4. Collapse intermediate generic divs when unambiguous
   *
   * @param {string} ancestorRef - Ref of the ancestor (e.g., a list item)
   * @param {string} targetRef - Ref of the target descendant
   * @returns {string|null} Relative CSS selector, or null if path not found
   */
  buildRelativeCssSelector(ancestorRef, targetRef) {
    const ancestor = this._byRef.get(ancestorRef);
    const target = this._byRef.get(targetRef);
    if (!ancestor || !target) return null;
    if (ancestorRef === targetRef) return null;

    // Walk from target up to ancestor, collecting the path
    const path = [];
    let current = target;
    while (current && current.ref !== ancestorRef) {
      path.unshift(current);
      current = current.parentRef ? this._byRef.get(current.parentRef) : null;
    }
    if (!current) return null; // target is not a descendant of ancestor

    // Build a selector segment for each node in the path
    const segments = [];
    for (const node of path) {
      const seg = this._buildSelectorSegment(node);
      segments.push(seg);
    }

    // Collapse: try the target segment alone first, then progressively add ancestors
    // Check if target segment alone is unambiguous within the ancestor subtree
    const targetSeg = segments[segments.length - 1];
    if (this._isSelectorUnambiguous(ancestorRef, targetSeg, targetRef)) {
      return targetSeg;
    }

    // Try combining last two segments with descendant combinator
    if (segments.length >= 2) {
      const twoSeg = segments[segments.length - 2] + " " + targetSeg;
      if (this._isSelectorUnambiguous(ancestorRef, twoSeg, targetRef)) {
        return twoSeg;
      }
    }

    // Fall back to full path with ` > ` combinator
    return segments.join(" > ");
  }

  /**
   * Build a single CSS selector segment for a node.
   * Prefers semantic selectors over positional ones.
   */
  _buildSelectorSegment(node) {
    const { tag, attributes } = node;

    // 1. data-testid
    if (attributes["data-testid"]) {
      return `[data-testid="${attributes["data-testid"]}"]`;
    }

    // 2. Stable classes
    if (attributes.class) {
      const classes = attributes.class.split(/\s+/).filter((c) => c && !isDynamicClass(c));
      if (classes.length > 0) {
        return `${tag}.${classes.slice(0, 2).map(cssEscape).join(".")}`;
      }
    }

    // 3. data-* attributes (not data-testid, already handled)
    for (const [attr, val] of Object.entries(attributes)) {
      if (attr.startsWith("data-") && attr !== "data-testid" && val && typeof val === "string" && val.length < 60) {
        return `${tag}[${attr}="${val}"]`;
      }
    }

    // 4. aria-label
    if (attributes["aria-label"]) {
      return `${tag}[aria-label="${attributes["aria-label"]}"]`;
    }

    // 5. Semantic tag alone (if tag is meaningful)
    const SEMANTIC_TAGS = new Set(["h1","h2","h3","h4","h5","h6","p","a","img","time","span","label"]);
    if (SEMANTIC_TAGS.has(tag)) {
      // Check if this tag is unique among siblings
      if (node.parentRef) {
        const parent = this._byRef.get(node.parentRef);
        if (parent) {
          const sameTagSiblings = parent.childRefs
            .map((r) => this._byRef.get(r))
            .filter((n) => n && n.tag === tag);
          if (sameTagSiblings.length === 1) {
            return tag;
          }
        }
      }
    }

    // 6. nth-of-type (better than nth-child)
    if (node.parentRef) {
      const parent = this._byRef.get(node.parentRef);
      if (parent) {
        const sameTagSiblings = parent.childRefs
          .map((r) => this._byRef.get(r))
          .filter((n) => n && n.tag === tag);
        if (sameTagSiblings.length > 1) {
          const idx = sameTagSiblings.indexOf(node) + 1;
          return `${tag}:nth-of-type(${idx})`;
        }
      }
    }

    return tag;
  }

  /**
   * Check if a CSS selector uniquely matches one target within an ancestor's subtree.
   * Uses simple heuristic: count nodes in subtree that would match the selector pattern.
   */
  _isSelectorUnambiguous(ancestorRef, selectorStr, targetRef) {
    // Parse the selector to extract the final segment's tag and class/attr constraints
    const subtree = this.getSubtree(ancestorRef);
    let matchCount = 0;

    for (const node of subtree) {
      if (node.ref === ancestorRef) continue;
      if (this._nodeMatchesSelector(node, selectorStr)) {
        matchCount++;
        if (matchCount > 1) return false;
      }
    }
    return matchCount === 1;
  }

  /**
   * Simple heuristic check if a node matches a CSS selector string.
   * Handles: tag, .class, [attr], tag.class, tag[attr="val"]
   */
  _nodeMatchesSelector(node, selector) {
    // Handle descendant/child combinators — only match against the last segment
    const parts = selector.split(/\s*>\s*|\s+/);
    const lastPart = parts[parts.length - 1];

    return this._nodeMatchesSimpleSelector(node, lastPart);
  }

  _nodeMatchesSimpleSelector(node, sel) {
    // [data-testid="foo"]
    const attrMatch = sel.match(/^\[([^\]=]+)="([^"]+)"\]$/);
    if (attrMatch) {
      return node.attributes[attrMatch[1]] === attrMatch[2];
    }

    // tag.class1.class2
    const tagClassMatch = sel.match(/^(\w+)((?:\.[a-zA-Z_\\][\w\\-]*)+)$/);
    if (tagClassMatch) {
      if (node.tag !== tagClassMatch[1]) return false;
      const requiredClasses = tagClassMatch[2].split(".").filter(Boolean).map((c) => c.replace(/\\(.)/g, "$1"));
      const nodeClasses = (node.attributes.class || "").split(/\s+/);
      return requiredClasses.every((rc) => nodeClasses.includes(rc));
    }

    // tag[attr="val"]
    const tagAttrMatch = sel.match(/^(\w+)\[([^\]=]+)="([^"]+)"\]$/);
    if (tagAttrMatch) {
      return node.tag === tagAttrMatch[1] && node.attributes[tagAttrMatch[2]] === tagAttrMatch[3];
    }

    // tag:nth-of-type(N) — don't try to match, not unique
    if (sel.includes(":nth-of-type")) return false;

    // bare tag
    if (/^\w+$/.test(sel)) {
      return node.tag === sel;
    }

    return false;
  }

  /**
   * Build an XPath for a node using its ancestry.
   */
  buildXPath(ref) {
    const parts = [];
    let current = this._byRef.get(ref);
    while (current) {
      let segment = current.tag;

      // Compute position among same-tag siblings
      if (current.parentRef) {
        const parent = this._byRef.get(current.parentRef);
        if (parent) {
          const sameTagSiblings = parent.childRefs
            .map((r) => this._byRef.get(r))
            .filter((n) => n && n.tag === current.tag);
          if (sameTagSiblings.length > 1) {
            const idx = sameTagSiblings.indexOf(current) + 1;
            segment += `[${idx}]`;
          }
        }
      }

      parts.unshift(segment);
      current = current.parentRef ? this._byRef.get(current.parentRef) : null;
    }

    return "/" + parts.join("/");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DYNAMIC_CLASS_PATTERNS = [
  /^css-/, /^sc-/, /^emotion-/, /^styled-/,
  /^_[a-zA-Z0-9]{5,}/,
  /^[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}$/,
  /^[a-zA-Z]+-[a-f0-9]{4,}$/,
];

const isDynamicClass = (cls) =>
  DYNAMIC_CLASS_PATTERNS.some((p) => p.test(cls));

const cssEscape = (str) =>
  str.replace(/([^\w-])/g, "\\$1");
