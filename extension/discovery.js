/**
 * discovery.js — Stage 1 (DOM Scan) + Stage 2 (A11y Extraction)
 *
 * Collects raw DOM structure and accessibility data from the live page.
 * All processing happens on the backend — this is a dumb data collector.
 */

const SCAN_ELEMENT_CAP = 5000;

const SKIP_TAGS = new Set([
  "script", "style", "noscript", "template", "svg", "path"
]);

const IMPLICIT_ROLES = {
  button: "button",
  a: "link",
  textarea: "textbox",
  nav: "navigation",
  main: "main",
  form: "form",
  table: "table",
  ul: "list",
  ol: "list",
  li: "listitem",
  dialog: "dialog",
  article: "article",
  section: "region",
  aside: "complementary",
  header: "banner",
  footer: "contentinfo",
  fieldset: "group",
  details: "group",
  summary: "button",
  output: "status",
  progress: "progressbar",
  meter: "meter"
};

const INPUT_ROLE_MAP = {
  text: "textbox",
  search: "searchbox",
  email: "textbox",
  tel: "textbox",
  url: "textbox",
  password: "textbox",
  number: "spinbutton",
  range: "slider",
  checkbox: "checkbox",
  radio: "radio",
  button: "button",
  submit: "button",
  reset: "button",
  image: "button"
};

const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Stage 1 — DOM Scan
 * Walk the live DOM and collect structural data about every visible element.
 */
const scanDOM = () => {
  const elements = [];
  let nextScanId = 0;
  const nodeToScanId = new Map();


  const getDirectText = (el) => {
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += child.textContent;
      }
    }
    return text.trim().slice(0, 200);
  };

  const getAttributes = (el) => {
    const attrs = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
    return attrs;
  };

  const walk = (el, parentScanId) => {
    if (nextScanId >= SCAN_ELEMENT_CAP) return;

    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;



    const scanId = nextScanId++;
    nodeToScanId.set(el, scanId);

    const rect = el.getBoundingClientRect();
    const element = {
      scanId,
      parentScanId,
      tagName: tag,
      attributes: getAttributes(el),
      textContent: getDirectText(el),
      boundingRect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      isVisible: true,
      childScanIds: []
    };

    elements.push(element);

    // Walk children (including open shadow roots with slot expansion)
    const shadowRoot = el.shadowRoot && el.shadowRoot.mode === "open"
      ? el.shadowRoot
      : null;

    const walkChild = (child) => {
      if (child instanceof HTMLElement) {
        walk(child, scanId);
        const childScanId = nodeToScanId.get(child);
        if (childScanId !== undefined) {
          element.childScanIds.push(childScanId);
        }
      }
    };

    if (shadowRoot) {
      for (const child of shadowRoot.children) {
        if (child.tagName === "SLOT") {
          const assigned = child.assignedNodes({ flatten: true });
          if (assigned.length > 0) {
            for (const n of assigned) walkChild(n);
          } else {
            for (const fb of child.children) walkChild(fb);
          }
        } else {
          walkChild(child);
        }
      }
    } else {
      for (const child of el.children) {
        walkChild(child);
      }
    }
  };

  if (document.body) {
    walk(document.body, null);
  }

  return elements;
};

/**
 * Stage 2 — Accessibility Extraction
 * Overlay accessibility information onto scanned elements.
 */
const extractA11y = (elements) => {
  const a11yData = [];

  // We need to find the live DOM elements again by matching scanId.
  // Since scanDOM walked in order, we can re-walk to build the map,
  // but it's simpler to store element refs during scan.
  // Instead, let's derive a11y purely from the scanned data (attributes + tag).

  for (const el of elements) {
    const tag = el.tagName;
    const attrs = el.attributes;

    // Compute role
    let role = attrs.role || null;
    if (!role) {
      if (tag === "input") {
        const inputType = (attrs.type || "text").toLowerCase();
        role = INPUT_ROLE_MAP[inputType] || null;
      } else if (tag === "select") {
        const multiple = "multiple" in attrs;
        role = multiple ? "listbox" : "combobox";
      } else if (tag === "img" && ("alt" in attrs)) {
        role = "img";
      } else if (HEADING_TAGS.has(tag)) {
        role = "heading";
      } else {
        role = IMPLICIT_ROLES[tag] || null;
      }
    }

    // Compute accessible name
    let name = attrs["aria-label"] || null;
    if (!name && attrs.title) {
      name = attrs.title;
    }
    if (!name && attrs.placeholder) {
      name = attrs.placeholder;
    }
    if (!name && attrs.alt) {
      name = attrs.alt;
    }
    if (!name && el.textContent) {
      name = el.textContent.slice(0, 100);
    }

    // Description
    const description = attrs["aria-description"] || null;

    // States
    const isDisabled = "disabled" in attrs ||
      attrs["aria-disabled"] === "true";

    const isRequired = "required" in attrs ||
      attrs["aria-required"] === "true";

    const expandedState = attrs["aria-expanded"] || null;

    let checkedState = attrs["aria-checked"] || null;
    if (!checkedState && tag === "input" && (attrs.type === "checkbox" || attrs.type === "radio")) {
      checkedState = "checked" in attrs ? "true" : "false";
    }

    const selectedState = attrs["aria-selected"] || null;

    a11yData.push({
      scanId: el.scanId,
      role,
      name,
      description,
      isDisabled,
      isRequired,
      expandedState,
      checkedState,
      selectedState
    });
  }

  return a11yData;
};

/**
 * Collect visible page text (first ~2000 chars) for LLM context.
 */
const collectPageText = () => {
  const SKIP_TEXT = new Set(["script", "style", "noscript"]);
  const parts = [];

  const walkNode = (node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent || "").trim();
      if (text.length > 0) parts.push(text);
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const tag = node.tagName.toLowerCase();
    if (SKIP_TEXT.has(tag)) return;

    // Pierce shadow DOM with slot expansion (avoid double-counting)
    const sr = node.shadowRoot;
    if (sr) {
      for (const child of sr.childNodes) {
        if (child.nodeType === Node.ELEMENT_NODE && child.tagName === "SLOT") {
          const assigned = child.assignedNodes({ flatten: true });
          if (assigned.length > 0) {
            for (const n of assigned) walkNode(n);
          } else {
            for (const fb of child.childNodes) walkNode(fb);
          }
        } else {
          walkNode(child);
        }
      }
    } else {
      for (const child of node.childNodes) {
        walkNode(child);
      }
    }
  };

  if (document.body) walkNode(document.body);

  return parts.join(" ").slice(0, 2000);
};

/**
 * Run a full discovery scan and return a RawPageSnapshot.
 */
const runDiscoveryScan = () => {
  const elements = scanDOM();
  const a11y = extractA11y(elements);
  const pageText = collectPageText();

  return {
    url: window.location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    elements,
    a11y,
    pageText
  };
};

// ─── DOM Serialization (rrweb-snapshot) ─────────────────────────────

/**
 * Serialize the live DOM using rrweb-snapshot.
 * Handles shadow DOM correctly out of the box.
 * Returns raw JSON string of the rrweb snapshot tree.
 */
const serializeDom = () => {
  if (typeof rrwebSnapshot === "undefined" || !rrwebSnapshot.snapshot) return "";
  const tree = rrwebSnapshot.snapshot(document, {
    slimDOM: "all",
    inlineStylesheet: false,
    inlineImages: false,
    maskAllInputs: false,
  });
  if (!tree) return "";
  return JSON.stringify(tree);
};

// ─── Element State Capture ───────────────────────────────────────────

/**
 * Capture live DOM state (runtime properties, not HTML attributes).
 * Returns null when all defaults — keeps token count low.
 */
const captureElementState = (el) => {
  const tag = el.tagName.toLowerCase();
  const state = {};

  // Form field values (live .value, not attribute)
  if ((tag === 'input' || tag === 'textarea' || tag === 'select') && 'value' in el) {
    state.value = el.value || null;
  }
  if (tag === 'input' && (el.type === 'checkbox' || el.type === 'radio')) {
    state.checked = el.checked;
  }
  if (tag === 'select' && el.selectedIndex >= 0 && el.options[el.selectedIndex]) {
    state.selectedOption = el.options[el.selectedIndex].text || null;
  }
  if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') {
    state.disabled = true;
  }
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) state.expanded = expanded === 'true';
  const selected = el.getAttribute('aria-selected');
  if (selected !== null) state.selected = selected === 'true';

  return Object.keys(state).length > 0 ? state : null;
};

/**
 * Capture page-level state context.
 */
const capturePageState = () => ({
  pathname: window.location.pathname,
  hash: window.location.hash,
  search: window.location.search,
  dialogOpen: document.querySelector('dialog[open]') !== null,
  scrollY: Math.round(window.scrollY)
});

// ─── Skeleton Scan (Vision-First Pipeline) ──────────────────────────

const SKELETON_INTERACTABLE_TAGS = new Set([
  "button", "a", "input", "select", "textarea", "summary"
]);

const SKELETON_LANDMARK_TAGS = new Set([
  "nav", "main", "header", "footer", "form", "dialog", "aside", "section", "article"
]);

const SKELETON_ATTRS = ["data-testid", "id", "aria-label", "href", "type", "name", "placeholder", "class"];

/**
 * Run a focused skeleton scan for the vision-first discovery pipeline.
 * Collects only landmark containers and interactable elements (~50-200 nodes).
 *
 * Each entry: { scanId, tagName, role, name, text, rect, attributes,
 *               parentScanId, childScanIds, interactable }
 *
 * parentScanId/childScanIds form a logical tree over the included nodes
 * (non-included ancestors are skipped). This is sufficient for attribute-based
 * locators; dom_path/xpath locators will be approximate.
 */
const runSkeletonScan = () => {
  const skeleton = [];
  let nextScanId = 0;
  const nodeToScanId = new Map();


  const computeRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLE_MAP[t] || "textbox";
    }
    if (tag === "select") return el.hasAttribute("multiple") ? "listbox" : "combobox";
    return IMPLICIT_ROLES[tag] || null;
  };

  const computeName = (el) => {
    return (
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      (el.textContent || "").trim().slice(0, 100) ||
      null
    );
  };

  const getSkeletonAttrs = (el) => {
    const attrs = {};
    for (const name of SKELETON_ATTRS) {
      const val = el.getAttribute(name);
      if (val != null) attrs[name] = val;
    }
    return attrs;
  };

  const shouldInclude = () => true;

  /**
   * Walk the DOM. Returns the list of nearest included descendant scanIds
   * that should be added to the parent's childScanIds (bubbles up through
   * non-included nodes so logical parent-child relationships are preserved).
   */
  const walk = (el, nearestAncestorScanId, depth) => {
    if (!(el instanceof HTMLElement)) return [];
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return [];


    const include = shouldInclude(el);
    let myScanId = null;

    if (include) {
      myScanId = nextScanId++;
      nodeToScanId.set(el, myScanId);
    }

    const skShadowRoot = el.shadowRoot && el.shadowRoot.mode === "open" ? el.shadowRoot : null;
    const nearestDescendants = [];
    const nextAncestor = myScanId !== null ? myScanId : nearestAncestorScanId;

    const visitChild = (child) => {
      if (!(child instanceof HTMLElement)) return;
      const childDescendants = walk(child, nextAncestor, depth + 1);
      const childScanId = nodeToScanId.get(child);
      if (childScanId !== undefined) {
        nearestDescendants.push(childScanId);
      } else {
        nearestDescendants.push(...childDescendants);
      }
    };

    if (skShadowRoot) {
      for (const child of skShadowRoot.children) {
        if (child.tagName === "SLOT") {
          const assigned = child.assignedNodes({ flatten: true });
          if (assigned.length > 0) {
            for (const n of assigned) visitChild(n);
          } else {
            for (const fb of child.children) visitChild(fb);
          }
        } else {
          visitChild(child);
        }
      }
    } else {
      for (const child of el.children) {
        visitChild(child);
      }
    }

    if (include) {
      const rect = el.getBoundingClientRect();
      skeleton.push({
        scanId: myScanId,
        tag: tag,
        role: computeRole(el),
        name: computeName(el),
        text: (el.textContent || "").trim().slice(0, 200),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        },
        attributes: getSkeletonAttrs(el),
        parentScanId: nearestAncestorScanId,
        childScanIds: nearestDescendants,
        interactable: SKELETON_INTERACTABLE_TAGS.has(tag) || el.hasAttribute("role"),
        state: captureElementState(el),
        visible: true,
        depth: depth,
        focusable: el.tabIndex >= 0
      });
      return [myScanId];
    }

    return nearestDescendants;
  };

  if (document.body) {
    walk(document.body, null, 0);
  }

  return {
    url: window.location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    devicePixelRatio: window.devicePixelRatio || 1,
    skeleton,
    pageText: collectPageText(),
    pageState: capturePageState()
  };
};

/**
 * Message listener — responds to scan commands from background.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "background") {
    return false;
  }

  if (message.command === "discovery_scan") {
    try {
      const snapshot = runDiscoveryScan();
      sendResponse({
        ok: true,
        snapshot
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : "discovery_scan_failed"
      });
    }
    return false;
  }

  return false;
});
