/**
 * page-executor.js — Self-contained page functions for workflow execution.
 *
 * PAGE_READ_VIEW and PAGE_EVALUATE_OUTCOME run inside page context via
 * Playwright's page.evaluate(). Actions (click, fill, select) are handled
 * by Playwright's native locator APIs in workflow-executor.js.
 */

const PAGE_READ_VIEW = (payload) => {
  const { containerLocator, itemContainer, fields, isList } = payload;

  // ── Locator helpers (used for container/field resolution in page context) ──

  const isVisible = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const tryCSS = (v) => { const m = document.querySelectorAll(v); if (m.length === 1) return m[0]; for (const el of m) { if (isVisible(el)) return el; } return null; };

  const tryXPath = (v) => {
    const x = v.startsWith("/body") ? `/html${v}` : v;
    const r = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (r.snapshotLength === 1) return r.snapshotItem(0);
    for (let i = 0; i < r.snapshotLength; i++) { const el = r.snapshotItem(i); if (isVisible(el)) return el; }
    return null;
  };

  const tryAttr = (v) => {
    const ci = v.indexOf(":");
    if (ci === -1) return null;
    const a = v.slice(0, ci), av = v.slice(ci + 1);
    try {
      const m = document.querySelectorAll(`[${a}="${CSS.escape(av)}"]`);
      if (m.length === 1) return m[0];
      for (const el of m) { if (isVisible(el)) return el; }
    } catch { /* invalid selector */ }
    return null;
  };

  const tryRoleName = (v) => {
    const match = v.match(/^(\w+)\s+"(.+)"$/);
    if (!match) return null;
    const [, role, name] = match;
    const IMPLICIT = { button:"button",a:"link",nav:"navigation",footer:"contentinfo",header:"banner",main:"main",select:"combobox",textarea:"textbox" };
    let found = null, count = 0;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getAttribute("role") || IMPLICIT[el.tagName.toLowerCase()] || (el.tagName.toLowerCase() === "input" ? "textbox" : null);
      if (r !== role) continue;
      const n = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || el.textContent?.trim().slice(0,100) || "";
      if (n === name) { found = el; count++; if (count > 1) return null; }
    }
    return found;
  };

  const tryText = (v) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode(n) { return (n.textContent||"").trim() === v ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; } });
    const t = w.nextNode(); if (!t) return null; if (w.nextNode()) return null;
    return t.parentElement;
  };

  const tryLocate = (strategies) => {
    if (!strategies || strategies.length === 0) return null;
    const sorted = [...strategies].sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    for (const s of sorted) {
      let el = null;
      try {
        if (s.kind === "css" || s.kind === "dom_path") el = tryCSS(s.value);
        else if (s.kind === "xpath") el = tryXPath(s.value);
        else if (s.kind === "attribute") el = tryAttr(s.value);
        else if (s.kind === "role_name") el = tryRoleName(s.value);
        else if (s.kind === "text") el = tryText(s.value);
      } catch { /* skip */ }
      if (el) return el;
    }
    return null;
  };

  // ── Container fallback chain ──

  const CONTAINER_FALLBACKS = [
    "main", "[role='main']", "#main-content", "#content", ".content",
    "#app", "#root", "article", "[role='feed']"
  ];

  let container = tryLocate(containerLocator);
  let containerFallback = null;
  if (!container) {
    for (const sel of CONTAINER_FALLBACKS) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el)) { container = el; containerFallback = sel; break; }
      } catch { /* skip */ }
    }
    if (!container) {
      container = document.body;
      containerFallback = "document.body";
    }
    console.warn(`[browserwire] read_view container fallback used: ${containerFallback}`);
  }

  // ── Field extraction with text fallback ──

  const coerceValue = (raw, type) => {
    if (!raw) return null;
    if (type === "number") return Number(raw) || null;
    if (type === "boolean") return raw === "true" || raw === "yes";
    return raw || null;
  };

  // Shadow-DOM-aware query helpers
  const qsDeep = (root, sel) => {
    try { return root.querySelector(sel) || root.shadowRoot?.querySelector(sel) || null; }
    catch { return null; }
  };

  const qsaDeep = (root, sel) => {
    try {
      const light = root.querySelectorAll(sel);
      if (light.length > 0) return light;
      return root.shadowRoot?.querySelectorAll(sel) || [];
    } catch { return []; }
  };

  const extractField = (root, field) => {
    if (!field || !field.locator) return null;
    const selector = field.locator.value;

    // 0. Attribute extraction (when field specifies an attribute to extract)
    if (field.locator.attribute) {
      let el = qsDeep(root, selector);
      // Self-match: if root IS the target (e.g., item=shreddit-post, selector=shreddit-post)
      if (!el) try { if (root.matches?.(selector)) el = root; } catch {}
      if (el) {
        const val = el.getAttribute(field.locator.attribute);
        if (val != null) return coerceValue(val.trim(), field.type);
      }
      return null;  // Don't fall through — attribute fields never use textContent
    }

    // 1. Direct CSS selector
    try {
      const el = qsDeep(root, selector);
      if (el) return coerceValue((el.textContent || "").trim(), field.type);
    } catch { /* invalid selector */ }

    // 2. Self-referencing rewrite: if selector starts with a class the root has,
    //    rewrite to :scope > rest  (e.g. ".card > .title" when root IS .card)
    try {
      const leadClassMatch = selector.match(/^(\.[a-zA-Z0-9_-]+)\s*>\s*(.+)$/);
      if (leadClassMatch) {
        const [, leadClass, rest] = leadClassMatch;
        if (root.matches && root.matches(leadClass)) {
          // Try :scope > rest
          const scopeEl = qsDeep(root, `:scope > ${rest}`);
          if (scopeEl) return coerceValue((scopeEl.textContent || "").trim(), field.type);
          // Try just the structural part
          const restEl = qsDeep(root, rest);
          if (restEl) return coerceValue((restEl.textContent || "").trim(), field.type);
        }
      }
    } catch { /* skip */ }

    // 3. aria-label extraction for title/name fields
    //    Last-resort: only for fields whose name suggests a title/name
    try {
      if (/title|name/i.test(field.name)) {
        for (const tag of ["a", "button"]) {
          const els = qsaDeep(root, `${tag}[aria-label]`);
          for (const el of els) {
            const label = (el.getAttribute("aria-label") || "").trim();
            if (label.length > 3) return coerceValue(label, field.type);
          }
        }
      }
    } catch { /* skip */ }

    // 4. Semantic class matching: fuzzy last-resort — match field name parts
    //    against class names of *direct children only* to limit false positives
    try {
      const nameParts = field.name.split("_").filter(p => p.length > 2);
      for (const part of nameParts) {
        const matches = qsaDeep(root, `:scope > [class*="${part}"], :scope > * > [class*="${part}"]`);
        for (const el of matches) {
          if (el !== root) {
            const raw = (el.textContent || "").trim();
            if (raw.length > 1) return coerceValue(raw, field.type);
          }
        }
      }
    } catch { /* skip */ }

    return null;
  };

  /**
   * Text-block fallback: extract the N most distinct text blocks from an element,
   * mapping them positionally to the N field names.
   * Filters out zero-width chars and single-char noise.
   */
  const ZERO_WIDTH_RE = /[\u200B\u00A0\uFEFF]/g;
  const extractFieldsByTextBlocks = (root, fieldDefs) => {
    if (!fieldDefs || fieldDefs.length === 0) return {};
    const blocks = [];
    const walkRoot = (r) => {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const t = (n.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
          return t.length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        }
      });
      let node;
      while ((node = walker.nextNode()) && blocks.length < fieldDefs.length + 10) {
        const text = (node.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
        if (text.length > 1 && !blocks.includes(text)) blocks.push(text);
      }
    };
    walkRoot(root);
    // Pierce shadow DOM if light DOM yielded nothing
    if (blocks.length === 0 && root.shadowRoot) walkRoot(root.shadowRoot);
    const row = {};
    for (let i = 0; i < fieldDefs.length; i++) {
      row[fieldDefs[i].name] = i < blocks.length ? blocks[i] : null;
    }
    return row;
  };

  if (isList) {
    // List view: find all items, extract fields per item
    let items;

    // Try itemContainer if provided
    if (itemContainer) {
      try {
        const selector = itemContainer.value || itemContainer;
        items = container.querySelectorAll(typeof selector === "string" ? selector : selector.value);
      } catch { /* invalid selector — fall through to fallbacks */ }

      // Try container's shadow root
      if ((!items || items.length === 0) && container.shadowRoot) {
        try {
          const sel = itemContainer.value || itemContainer;
          items = container.shadowRoot.querySelectorAll(typeof sel === "string" ? sel : sel.value);
        } catch {}
      }

      // If no items found with the item selector, try document-wide before generic fallbacks
      if (!items || items.length === 0) {
        try {
          const selector = itemContainer.value || itemContainer;
          const sel = typeof selector === "string" ? selector : selector.value;
          const docItems = document.querySelectorAll(sel);
          if (docItems.length > 0) {
            items = docItems;
            console.warn(`[browserwire] read_view items found document-wide: ${sel} (${docItems.length} items)`);
          }
        } catch { /* skip */ }
      }
    }

    // If still no items, try common list patterns within container
    if (!items || items.length === 0) {
      const LIST_ITEM_FALLBACKS = ["li", "[role='listitem']", "[role='row']", "tr", "article", ":scope > div"];
      for (const sel of LIST_ITEM_FALLBACKS) {
        try {
          const candidates = container.querySelectorAll(sel);
          if (candidates.length > 0) { items = candidates; console.warn(`[browserwire] read_view item fallback used: ${sel}`); break; }
        } catch { /* skip */ }
      }
    }

    if (!items || items.length === 0) {
      return { ok: true, result: [], count: 0, _note: "no items found" };
    }

    const fieldDefs = fields || [];
    const result = [];
    let allNull = true;
    const seenAncestors = new Set();

    for (const item of items) {
      const row = {};
      let extractionRoot = item;
      for (const field of fieldDefs) {
        row[field.name] = extractField(item, field);
      }

      // If all fields null, item may be an overlay/link — escalate to card-like ancestor
      if (!Object.values(row).some(v => v !== null)) {
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const ancestor = (item.closest && item.closest(CARD_ANCESTORS)) || item.parentElement;
        if (ancestor && ancestor !== item && ancestor !== document.body) {
          // Deduplicate: skip if we already extracted from this ancestor
          if (seenAncestors.has(ancestor)) continue;
          seenAncestors.add(ancestor);
          extractionRoot = ancestor;
          for (const field of fieldDefs) {
            row[field.name] = extractField(ancestor, field);
          }
          console.warn(`[browserwire] read_view: escalated item to ancestor <${ancestor.tagName.toLowerCase()}>`);
        }
      }

      // Check if any field was extracted
      const hasValue = Object.values(row).some(v => v !== null);
      if (!hasValue) {
        // Text-block fallback using best extraction root
        const textRow = extractFieldsByTextBlocks(extractionRoot, fieldDefs);
        for (const key of Object.keys(textRow)) row[key] = textRow[key];
      }
      if (Object.values(row).some(v => v !== null)) allNull = false;
      result.push(row);
    }

    // Last resort: if ALL rows are still entirely null, add _raw_text per item
    if (allNull && result.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const root = items[i];
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const best = (root.closest && root.closest(CARD_ANCESTORS)) || root;
        result[i]._raw_text = (best.textContent || "").trim().slice(0, 500);
      }
      console.warn("[browserwire] read_view: all fields null, falling back to _raw_text");
    }

    return { ok: true, result, count: result.length, ...(containerFallback ? { containerFallback } : {}) };
  } else {
    // Single/detail view: extract fields from container directly
    const fieldDefs = fields || [];
    const row = {};
    for (const field of fieldDefs) {
      row[field.name] = extractField(container, field);
    }
    // Text-block fallback if all fields are null
    if (Object.values(row).every(v => v === null) && fieldDefs.length > 0) {
      const textRow = extractFieldsByTextBlocks(container, fieldDefs);
      for (const key of Object.keys(textRow)) row[key] = textRow[key];
    }
    return { ok: true, result: row, ...(containerFallback ? { containerFallback } : {}) };
  }
};

const PAGE_EVALUATE_OUTCOME = (payload) => {
  const { outcomes } = payload;
  if (!outcomes) return { outcome: "unknown" };

  const check = (signal) => {
    if (!signal || !signal.kind || !signal.value) return false;
    try {
      if (signal.kind === "url_change") {
        return new RegExp(signal.value).test(window.location.pathname + window.location.search);
      }
      if (signal.kind === "element_appears") {
        return document.querySelector(signal.value) !== null;
      }
      if (signal.kind === "element_disappears") {
        return document.querySelector(signal.value) === null;
      }
      if (signal.kind === "text_contains") {
        const el = signal.selector ? document.querySelector(signal.selector) : document.body;
        if (!el) return false;
        return new RegExp(signal.value, "i").test(el.textContent || "");
      }
    } catch { /* invalid regex or selector */ }
    return false;
  };

  if (outcomes.success && check(outcomes.success)) return { outcome: "success" };
  if (outcomes.failure && check(outcomes.failure)) return { outcome: "failure" };
  return { outcome: "unknown" };
};

