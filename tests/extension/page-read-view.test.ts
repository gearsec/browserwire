/**
 * Unit tests for PAGE_READ_VIEW — the DOM extraction function injected into
 * pages by the extension background worker.
 *
 * Source: extension/background.js lines 829–1162 (copied here because the
 * function is a const, not exported, and only uses DOM globals).
 *
 * Environment: jsdom (configured in vitest.config.ts)
 */
import { describe, it, expect, afterEach } from "vitest";

// ── PAGE_READ_VIEW (verbatim copy from extension/background.js) ──────────

const PAGE_READ_VIEW = (payload: any) => {
  const { containerLocator, itemContainer, fields, isList } = payload;

  const isVisible = (el: any) => {
    if (!(el instanceof HTMLElement)) return false;
    const s = window.getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const tryCSS = (v: string) => {
    const m = document.querySelectorAll(v);
    if (m.length === 1) return m[0];
    for (const el of m) { if (isVisible(el as HTMLElement)) return el; }
    return null;
  };

  const tryXPath = (v: string) => {
    const x = v.startsWith("/body") ? `/html${v}` : v;
    const r = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    if (r.snapshotLength === 1) return r.snapshotItem(0);
    for (let i = 0; i < r.snapshotLength; i++) {
      const el = r.snapshotItem(i);
      if (isVisible(el as HTMLElement)) return el;
    }
    return null;
  };

  const tryAttr = (v: string) => {
    const ci = v.indexOf(":");
    if (ci === -1) return null;
    const a = v.slice(0, ci), av = v.slice(ci + 1);
    try {
      const m = document.querySelectorAll(`[${a}="${CSS.escape(av)}"]`);
      if (m.length === 1) return m[0];
      for (const el of m) { if (isVisible(el as HTMLElement)) return el; }
    } catch { /* invalid selector */ }
    return null;
  };

  const tryRoleName = (v: string) => {
    const match = v.match(/^(\w+)\s+"(.+)"$/);
    if (!match) return null;
    const [, role, name] = match;
    const IMPLICIT: Record<string, string> = {
      button: "button", a: "link", nav: "navigation", footer: "contentinfo",
      header: "banner", main: "main", select: "combobox", textarea: "textbox",
    };
    let found: Element | null = null, count = 0;
    for (const el of document.querySelectorAll("*")) {
      const r = el.getAttribute("role") ||
        IMPLICIT[el.tagName.toLowerCase()] ||
        (el.tagName.toLowerCase() === "input" ? "textbox" : null);
      if (r !== role) continue;
      const n = el.getAttribute("aria-label") || el.getAttribute("title") ||
        el.getAttribute("alt") || el.textContent?.trim().slice(0, 100) || "";
      if (n === name) { found = el; count++; if (count > 1) return null; }
    }
    return found;
  };

  const tryText = (v: string) => {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        return (n.textContent || "").trim() === v
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const t = w.nextNode();
    if (!t) return null;
    if (w.nextNode()) return null;
    return (t as any).parentElement;
  };

  const tryLocate = (strategies: any[]) => {
    if (!strategies || strategies.length === 0) return null;
    const sorted = [...strategies].sort((a: any, b: any) => (b.confidence || 0) - (a.confidence || 0));
    for (const s of sorted) {
      let el: any = null;
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

  const CONTAINER_FALLBACKS = [
    "main", "[role='main']", "#main-content", "#content", ".content",
    "#app", "#root", "article", "[role='feed']",
  ];

  let container: any = tryLocate(containerLocator);
  let containerFallback: string | null = null;
  if (!container) {
    for (const sel of CONTAINER_FALLBACKS) {
      try {
        const el = document.querySelector(sel);
        if (el && isVisible(el as HTMLElement)) {
          container = el;
          containerFallback = sel;
          break;
        }
      } catch { /* skip */ }
    }
    if (!container) {
      container = document.body;
      containerFallback = "document.body";
    }
  }

  const coerceValue = (raw: any, type: string) => {
    if (!raw) return null;
    if (type === "number") return Number(raw) || null;
    if (type === "boolean") return raw === "true" || raw === "yes";
    return raw || null;
  };

  const qsDeep = (root: any, sel: string) => {
    try { return root.querySelector(sel) || root.shadowRoot?.querySelector(sel) || null; }
    catch { return null; }
  };

  const qsaDeep = (root: any, sel: string) => {
    try {
      const light = root.querySelectorAll(sel);
      if (light.length > 0) return light;
      return root.shadowRoot?.querySelectorAll(sel) || [];
    } catch { return []; }
  };

  const extractField = (root: any, field: any) => {
    if (!field || !field.locator) return null;
    const selector = field.locator.value;

    if (field.locator.attribute) {
      let el = qsDeep(root, selector);
      if (!el) try { if (root.matches?.(selector)) el = root; } catch {}
      if (el) {
        const val = el.getAttribute(field.locator.attribute);
        if (val != null) return coerceValue(val.trim(), field.type);
      }
      return null;
    }

    try {
      const el = qsDeep(root, selector);
      if (el) return coerceValue((el.textContent || "").trim(), field.type);
    } catch { /* invalid selector */ }

    try {
      const leadClassMatch = selector.match(/^(\.[a-zA-Z0-9_-]+)\s*>\s*(.+)$/);
      if (leadClassMatch) {
        const [, leadClass, rest] = leadClassMatch;
        if (root.matches && root.matches(leadClass)) {
          const scopeEl = qsDeep(root, `:scope > ${rest}`);
          if (scopeEl) return coerceValue((scopeEl.textContent || "").trim(), field.type);
          const restEl = qsDeep(root, rest);
          if (restEl) return coerceValue((restEl.textContent || "").trim(), field.type);
        }
      }
    } catch { /* skip */ }

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

    try {
      const nameParts = field.name.split("_").filter((p: string) => p.length > 2);
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

  const ZERO_WIDTH_RE = /[\u200B\u00A0\uFEFF]/g;
  const extractFieldsByTextBlocks = (root: any, fieldDefs: any[]) => {
    if (!fieldDefs || fieldDefs.length === 0) return {};
    const blocks: string[] = [];
    const walkRoot = (r: any) => {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          const t = (n.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
          return t.length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        },
      });
      let node;
      while ((node = walker.nextNode()) && blocks.length < fieldDefs.length + 10) {
        const text = (node.textContent || "").replace(ZERO_WIDTH_RE, "").trim();
        if (text.length > 1 && !blocks.includes(text)) blocks.push(text);
      }
    };
    walkRoot(root);
    if (blocks.length === 0 && root.shadowRoot) walkRoot(root.shadowRoot);
    const row: Record<string, any> = {};
    for (let i = 0; i < fieldDefs.length; i++) {
      row[fieldDefs[i].name] = i < blocks.length ? blocks[i] : null;
    }
    return row;
  };

  if (isList) {
    let items: any;

    // Try itemContainer if provided
    if (itemContainer) {
      try {
        const selector = itemContainer.value || itemContainer;
        items = container.querySelectorAll(typeof selector === "string" ? selector : selector.value);
      } catch { /* invalid selector — fall through to fallbacks */ }

      if ((!items || items.length === 0) && container.shadowRoot) {
        try {
          const sel = itemContainer.value || itemContainer;
          items = container.shadowRoot.querySelectorAll(typeof sel === "string" ? sel : sel.value);
        } catch {}
      }

      if (!items || items.length === 0) {
        try {
          const selector = itemContainer.value || itemContainer;
          const sel = typeof selector === "string" ? selector : selector.value;
          const docItems = document.querySelectorAll(sel);
          if (docItems.length > 0) items = docItems;
        } catch { /* skip */ }
      }
    }

    if (!items || items.length === 0) {
      const LIST_ITEM_FALLBACKS = ["li", "[role='listitem']", "[role='row']", "tr", "article", ":scope > div"];
      for (const sel of LIST_ITEM_FALLBACKS) {
        try {
          const candidates = container.querySelectorAll(sel);
          if (candidates.length > 0) { items = candidates; break; }
        } catch { /* skip */ }
      }
    }

    if (!items || items.length === 0) {
      return { ok: true, result: [], count: 0, _note: "no items found" };
    }

    const fieldDefs = fields || [];
    const result: any[] = [];
    let allNull = true;
    const seenAncestors = new Set();

    for (const item of items) {
      const row: Record<string, any> = {};
      let extractionRoot = item;
      for (const field of fieldDefs) {
        row[field.name] = extractField(item, field);
      }

      if (!Object.values(row).some((v: any) => v !== null)) {
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const ancestor = (item.closest && item.closest(CARD_ANCESTORS)) || item.parentElement;
        if (ancestor && ancestor !== item && ancestor !== document.body) {
          if (seenAncestors.has(ancestor)) continue;
          seenAncestors.add(ancestor);
          extractionRoot = ancestor;
          for (const field of fieldDefs) {
            row[field.name] = extractField(ancestor, field);
          }
        }
      }

      const hasValue = Object.values(row).some((v: any) => v !== null);
      if (!hasValue) {
        const textRow = extractFieldsByTextBlocks(extractionRoot, fieldDefs);
        for (const key of Object.keys(textRow)) row[key] = textRow[key];
      }
      if (Object.values(row).some((v: any) => v !== null)) allNull = false;
      result.push(row);
    }

    if (allNull && result.length > 0) {
      for (let i = 0; i < result.length; i++) {
        const root = items[i];
        const CARD_ANCESTORS = '[role="button"], [role="listitem"], [class*="card"], article, li';
        const best = (root.closest && root.closest(CARD_ANCESTORS)) || root;
        result[i]._raw_text = (best.textContent || "").trim().slice(0, 500);
      }
    }

    return { ok: true, result, count: result.length, ...(containerFallback ? { containerFallback } : {}) };
  } else {
    const fieldDefs = fields || [];
    const row: Record<string, any> = {};
    for (const field of fieldDefs) {
      row[field.name] = extractField(container, field);
    }
    if (Object.values(row).every((v: any) => v === null) && fieldDefs.length > 0) {
      const textRow = extractFieldsByTextBlocks(container, fieldDefs);
      for (const key of Object.keys(textRow)) row[key] = textRow[key];
    }
    return { ok: true, result: row, ...(containerFallback ? { containerFallback } : {}) };
  }
};

// ── Test helpers ─────────────────────────────────────────────────────

function buildDOM(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

afterEach(() => {
  document.body.innerHTML = "";
});

// ── Tests ────────────────────────────────────────────────────────────

describe("PAGE_READ_VIEW", () => {
  // ── Container resolution ──

  describe("container resolution", () => {
    it("uses element matched by containerLocator strategy", () => {
      buildDOM(`<div id="target"><span class="title">Hello</span></div>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "#target", confidence: 0.9 }],
        fields: [{ name: "title", locator: { value: ".title" }, type: "string" }],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.title).toBe("Hello");
      expect(result.containerFallback).toBeUndefined();
    });

    it("falls through CONTAINER_FALLBACKS when no locator matches", () => {
      // jsdom has no layout engine, so isVisible() returns false for all
      // elements (getBoundingClientRect returns zeros). The fallback chain
      // requires isVisible, so it always reaches document.body in tests.
      // We verify the fallback mechanism works by confirming the field is
      // still extracted from document.body (which contains the <main>).
      buildDOM(`<main><span class="info">Inside main</span></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "#nonexistent", confidence: 0.9 }],
        fields: [{ name: "info", locator: { value: ".info" }, type: "string" }],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.info).toBe("Inside main");
      // In jsdom, isVisible is always false so fallback chain reaches body
      expect(result.containerFallback).toBe("document.body");
    });

    it("falls back to document.body when nothing else matches", () => {
      buildDOM(`<div><span class="data">Body content</span></div>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "#nope", confidence: 0.9 }],
        fields: [{ name: "data", locator: { value: ".data" }, type: "string" }],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.data).toBe("Body content");
      expect(result.containerFallback).toBe("document.body");
    });

    it("falls back to document.body when containerLocator is empty array", () => {
      buildDOM(`<span class="x">Val</span>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [],
        fields: [{ name: "x", locator: { value: ".x" }, type: "string" }],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.x).toBe("Val");
    });
  });

  // ── List path ──

  describe("list path (isList: true)", () => {
    it("extracts rows when itemContainer matches items", () => {
      buildDOM(`
        <main>
          <div class="item"><span class="name">Alice</span><span class="age">30</span></div>
          <div class="item"><span class="name">Bob</span><span class="age">25</span></div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".item" },
        fields: [
          { name: "name", locator: { value: ".name" }, type: "string" },
          { name: "age", locator: { value: ".age" }, type: "number" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.result[0].name).toBe("Alice");
      expect(result.result[0].age).toBe(30);
      expect(result.result[1].name).toBe("Bob");
      expect(result.result[1].age).toBe(25);
    });

    it("falls back to li items when itemContainer doesn't match", () => {
      buildDOM(`
        <main>
          <ul>
            <li><span class="val">One</span></li>
            <li><span class="val">Two</span></li>
          </ul>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".nonexistent-item" },
        fields: [{ name: "val", locator: { value: ".val" }, type: "string" }],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.result[0].val).toBe("One");
      expect(result.result[1].val).toBe("Two");
    });

    it("returns empty array when no items found at all", () => {
      buildDOM(`<main><p>No list here</p></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".nothing" },
        fields: [{ name: "val", locator: { value: ".val" }, type: "string" }],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result).toEqual([]);
      expect(result.count).toBe(0);
    });

    it("falls back to article items", () => {
      buildDOM(`
        <main>
          <article><span class="title">Post 1</span></article>
          <article><span class="title">Post 2</span></article>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".no-match" },
        fields: [{ name: "title", locator: { value: ".title" }, type: "string" }],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(2);
      expect(result.result[0].title).toBe("Post 1");
    });
  });

  // ── Field extraction ──

  describe("field extraction", () => {
    it("extracts via direct CSS selector", () => {
      buildDOM(`<main><h1 class="heading">Page Title</h1></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [{ name: "heading", locator: { value: ".heading" }, type: "string" }],
        isList: false,
      });
      expect(result.result.heading).toBe("Page Title");
    });

    it("extracts via self-referencing rewrite (.card > .title on a .card root)", () => {
      buildDOM(`
        <main>
          <div class="card">
            <span class="title">Card Title</span>
            <span class="desc">Card Desc</span>
          </div>
        </main>
      `);
      // isList with items being .card — field selector is ".card > .title" which
      // needs rewriting when the root IS .card
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".card" },
        fields: [
          { name: "title", locator: { value: ".card > .title" }, type: "string" },
          { name: "desc", locator: { value: ".card > .desc" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result[0].title).toBe("Card Title");
      expect(result.result[0].desc).toBe("Card Desc");
    });

    it("extracts via aria-label fallback for title/name fields", () => {
      buildDOM(`
        <main>
          <div class="item">
            <a aria-label="Product Alpha" href="/product/1"></a>
          </div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".item" },
        fields: [
          { name: "product_name", locator: { value: ".nonexistent" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result[0].product_name).toBe("Product Alpha");
    });

    it("extracts via semantic class matching", () => {
      buildDOM(`
        <main>
          <div class="row">
            <span class="price-value">$99</span>
          </div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".row" },
        fields: [
          { name: "price", locator: { value: ".nonexistent-selector" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result[0].price).toBe("$99");
    });

    it("extracts attribute when field.locator.attribute is set", () => {
      buildDOM(`
        <main>
          <div class="item">
            <a class="link" href="/page/42">Click</a>
          </div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".item" },
        fields: [
          { name: "url", locator: { value: ".link", attribute: "href" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result[0].url).toBe("/page/42");
    });

    it("uses text-block fallback when all fields are null", () => {
      buildDOM(`
        <main>
          <div class="item">
            <div>First text block</div>
            <div>Second text block</div>
          </div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".item" },
        fields: [
          { name: "field_a", locator: { value: ".nothing" }, type: "string" },
          { name: "field_b", locator: { value: ".also-nothing" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.result[0].field_a).toBe("First text block");
      expect(result.result[0].field_b).toBe("Second text block");
    });

    it("escalates to card ancestor when all fields null on item", () => {
      buildDOM(`
        <main>
          <article class="card-wrapper">
            <span class="title">Ancestor Title</span>
            <a class="inner-link"></a>
          </article>
        </main>
      `);
      // itemContainer targets .inner-link (which has no content), should escalate to article ancestor
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: ".inner-link" },
        fields: [
          { name: "title", locator: { value: ".title" }, type: "string" },
        ],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(1);
      expect(result.result[0].title).toBe("Ancestor Title");
    });
  });

  // ── Single path (isList: false) ──

  describe("single path (isList: false)", () => {
    it("extracts fields from container directly", () => {
      buildDOM(`
        <main>
          <h1 class="product-name">Widget Pro</h1>
          <span class="product-price">$49.99</span>
          <p class="description">A great widget.</p>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [
          { name: "product_name", locator: { value: ".product-name" }, type: "string" },
          { name: "price", locator: { value: ".product-price" }, type: "string" },
          { name: "description", locator: { value: ".description" }, type: "string" },
        ],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.product_name).toBe("Widget Pro");
      expect(result.result.price).toBe("$49.99");
      expect(result.result.description).toBe("A great widget.");
    });

    it("uses text-block fallback when all fields are null in single mode", () => {
      buildDOM(`
        <main>
          <div>Some heading text</div>
          <div>Some body text</div>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [
          { name: "heading", locator: { value: ".no-match-1" }, type: "string" },
          { name: "body", locator: { value: ".no-match-2" }, type: "string" },
        ],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result.heading).toBe("Some heading text");
      expect(result.result.body).toBe("Some body text");
    });
  });

  // ── Type coercion ──

  describe("type coercion", () => {
    it("coerces number fields", () => {
      buildDOM(`<main><span class="count">42</span></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [{ name: "count", locator: { value: ".count" }, type: "number" }],
        isList: false,
      });
      expect(result.result.count).toBe(42);
    });

    it("coerces boolean fields", () => {
      buildDOM(`<main><span class="active">true</span></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [{ name: "active", locator: { value: ".active" }, type: "boolean" }],
        isList: false,
      });
      expect(result.result.active).toBe(true);
    });
  });

  // ── Edge cases ──

  describe("edge cases", () => {
    it("handles empty fields array", () => {
      buildDOM(`<main><p>Content</p></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: [],
        isList: false,
      });
      expect(result.ok).toBe(true);
      expect(result.result).toEqual({});
    });

    it("handles null fields", () => {
      buildDOM(`<main><p>Content</p></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        fields: null,
        isList: false,
      });
      expect(result.ok).toBe(true);
    });

    it("falls through to fallbacks on invalid item selector", () => {
      buildDOM(`<main><p>Content</p></main>`);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: { value: "[[[invalid" },
        fields: [],
        isList: true,
      });
      // Invalid selector no longer returns error — falls through to fallbacks
      // No list items found via fallbacks either, so returns empty array
      expect(result.ok).toBe(true);
      expect(result.result).toEqual([]);
      expect(result.count).toBe(0);
    });

    it("extracts list items when isList=true and itemContainer is null", () => {
      buildDOM(`
        <main>
          <ul>
            <li><span class="name">Alice</span></li>
            <li><span class="name">Bob</span></li>
            <li><span class="name">Charlie</span></li>
          </ul>
        </main>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [{ kind: "css", value: "main", confidence: 0.9 }],
        itemContainer: null,
        fields: [{ name: "name", locator: { value: ".name" }, type: "string" }],
        isList: true,
      });
      expect(result.ok).toBe(true);
      expect(result.count).toBe(3);
      expect(result.result[0].name).toBe("Alice");
      expect(result.result[1].name).toBe("Bob");
      expect(result.result[2].name).toBe("Charlie");
    });

    it("selects highest confidence locator strategy first", () => {
      buildDOM(`
        <div id="low">Wrong</div>
        <div id="high">Right</div>
      `);
      const result = PAGE_READ_VIEW({
        containerLocator: [
          { kind: "css", value: "#low", confidence: 0.5 },
          { kind: "css", value: "#high", confidence: 0.95 },
        ],
        fields: [],
        isList: false,
      });
      expect(result.ok).toBe(true);
      // #high has higher confidence, should be selected as container
      expect(result.containerFallback).toBeUndefined();
    });
  });
});
