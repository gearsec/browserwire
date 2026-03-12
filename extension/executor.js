/**
 * executor.js — Action executor for the SDK
 *
 * Resolves locator strategies against the live DOM and executes actions
 * (click, type, select) or reads element state.
 *
 * Injected as a content script alongside discovery.js.
 */

// ---------------------------------------------------------------------------
// Locator resolution
// ---------------------------------------------------------------------------

/**
 * Try each locator strategy in order, return the first that uniquely matches.
 * @param {Array<{kind: string, value: string, confidence: number}>} strategies
 * @returns {{ element: Element, usedStrategy: { kind: string, value: string } } | null}
 */
const resolveLocator = (strategies) => {
  // Sort by confidence descending
  const sorted = [...strategies].sort((a, b) => b.confidence - a.confidence);

  for (const strategy of sorted) {
    const result = tryStrategy(strategy);
    if (result) {
      return { element: result, usedStrategy: { kind: strategy.kind, value: strategy.value } };
    }
  }

  return null;
};

/**
 * Try a single locator strategy. Returns the element if exactly one matches.
 */
const tryStrategy = (strategy) => {
  try {
    switch (strategy.kind) {
      case "css":
      case "dom_path":
        return tryCSS(strategy.value);

      case "xpath":
        return tryXPath(strategy.value);

      case "role_name":
        return tryRoleName(strategy.value);

      case "attribute":
        return tryAttribute(strategy.value);

      case "text":
        return tryText(strategy.value);

      default:
        return null;
    }
  } catch {
    return null;
  }
};

const tryCSS = (selector) => {
  const matches = document.querySelectorAll(selector);
  if (matches.length === 1) return matches[0];
  // For dom_path-style selectors, accept first visible match
  if (matches.length > 1) {
    for (const el of matches) {
      if (isElementVisible(el)) return el;
    }
  }
  return null;
};

const tryXPath = (xpath) => {
  // Prefix with /html if it starts with /body
  const fullXpath = xpath.startsWith("/body") ? `/html${xpath}` : xpath;
  const result = document.evaluate(
    fullXpath, document, null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
  );
  if (result.snapshotLength === 1) return result.snapshotItem(0);
  if (result.snapshotLength > 1) {
    for (let i = 0; i < result.snapshotLength; i++) {
      const el = result.snapshotItem(i);
      if (isElementVisible(el)) return el;
    }
  }
  return null;
};

const tryRoleName = (value) => {
  // Parse "role \"accessible name\""
  const match = value.match(/^(\w+)\s+"(.+)"$/);
  if (!match) return null;
  const [, role, name] = match;

  // Walk the DOM looking for matching role + name
  const candidates = document.querySelectorAll("*");
  let found = null;
  let count = 0;

  for (const el of candidates) {
    const elRole = el.getAttribute("role") || getImplicitRole(el);
    if (elRole !== role) continue;

    const elName = getAccessibleName(el);
    if (elName === name) {
      found = el;
      count++;
      if (count > 1) return null; // Ambiguous
    }
  }

  return found;
};

const tryAttribute = (value) => {
  const colonIdx = value.indexOf(":");
  if (colonIdx === -1) return null;
  const attr = value.slice(0, colonIdx);
  const attrVal = value.slice(colonIdx + 1);

  const matches = document.querySelectorAll(`[${attr}="${CSS.escape(attrVal)}"]`);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    for (const el of matches) {
      if (isElementVisible(el)) return el;
    }
  }
  return null;
};

const tryText = (value) => {
  const walker = document.createTreeWalker(
    document.body, NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const text = (node.textContent || "").trim();
        if (text === value) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_REJECT;
      }
    }
  );

  const textNode = walker.nextNode();
  if (!textNode) return null;
  // Check no second match
  if (walker.nextNode()) return null;
  return textNode.parentElement;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IMPLICIT_ROLES = {
  button: "button", a: "link", textarea: "textbox",
  nav: "navigation", main: "main", form: "form",
  table: "table", ul: "list", ol: "list", li: "listitem",
  dialog: "dialog", article: "article", section: "region",
  aside: "complementary", header: "banner", footer: "contentinfo",
  select: "combobox", details: "group", summary: "button"
};

const INPUT_ROLES = {
  text: "textbox", search: "searchbox", email: "textbox",
  tel: "textbox", url: "textbox", password: "textbox",
  number: "spinbutton", range: "slider",
  checkbox: "checkbox", radio: "radio",
  button: "button", submit: "button", reset: "button"
};

const getImplicitRole = (el) => {
  const tag = el.tagName.toLowerCase();
  if (tag === "input") {
    return INPUT_ROLES[(el.type || "text").toLowerCase()] || null;
  }
  if (tag.match(/^h[1-6]$/)) return "heading";
  return IMPLICIT_ROLES[tag] || null;
};

const getAccessibleName = (el) => {
  return (
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    el.getAttribute("placeholder") ||
    el.textContent?.trim().slice(0, 100) ||
    ""
  );
};

const isElementVisible = (el) => {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

// ---------------------------------------------------------------------------
// Action execution
// ---------------------------------------------------------------------------

/**
 * Execute an action on a resolved element.
 */
const executeAction = (element, interactionKind, inputs = {}) => {
  const kind = (interactionKind || "click").toLowerCase();

  switch (kind) {
    case "click":
    case "navigate":
      element.click();
      return { ok: true, action: "clicked" };

    case "type": {
      const text = inputs.text || inputs.value || Object.values(inputs)[0] || "";
      element.focus();
      // Clear existing value
      if ("value" in element) {
        element.value = "";
      }
      // Dispatch input events character by character for framework compatibility
      for (const char of text) {
        element.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
        if ("value" in element) {
          element.value += char;
        }
        element.dispatchEvent(new InputEvent("input", { data: char, inputType: "insertText", bubbles: true }));
        element.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
      }
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, action: "typed", length: text.length };
    }

    case "select": {
      const value = inputs.value || inputs.selected_option || Object.values(inputs)[0] || "";
      if ("value" in element) {
        element.value = value;
        element.dispatchEvent(new Event("change", { bubbles: true }));
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      return { ok: true, action: "selected", value };
    }

    default:
      // Fallback to click
      element.click();
      return { ok: true, action: "clicked" };
  }
};

// ---------------------------------------------------------------------------
// State reading
// ---------------------------------------------------------------------------

/**
 * Read the state of a resolved element.
 */
const readElementState = (element) => {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  const tag = element.tagName.toLowerCase();

  return {
    visible: isElementVisible(element),
    tag,
    text: (element.textContent || "").trim().slice(0, 500),
    value: "value" in element ? element.value : undefined,
    checked: "checked" in element ? element.checked : undefined,
    disabled: element.disabled || element.getAttribute("aria-disabled") === "true",
    attributes: Object.fromEntries(
      Array.from(element.attributes).map((a) => [a.name, a.value])
    ),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    },
    role: element.getAttribute("role") || getImplicitRole(element),
    name: getAccessibleName(element)
  };
};

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.source !== "background") return false;

  if (message.command === "execute_action") {
    try {
      const { strategies, interactionKind, inputs } = message.payload;
      const resolved = resolveLocator(strategies || []);

      if (!resolved) {
        sendResponse({
          ok: false,
          error: "ERR_TARGET_NOT_FOUND",
          message: "No locator strategy matched a unique element"
        });
        return false;
      }

      const result = executeAction(resolved.element, interactionKind, inputs);
      sendResponse({
        ok: true,
        result,
        usedStrategy: resolved.usedStrategy
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: "ERR_EXECUTION_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
    return false;
  }

  if (message.command === "evaluate_state_signals") {
    try {
      const { signals } = message.payload;
      const results = {};
      for (const signal of (signals || [])) {
        const key = `${signal.kind}:${signal.value}`;
        try {
          if (signal.kind === "selector_exists") {
            results[key] = document.querySelector(signal.value) !== null;
          } else if (signal.kind === "text_match") {
            const el = signal.selector ? document.querySelector(signal.selector) : document.body;
            if (el) {
              results[key] = new RegExp(signal.value).test((el.textContent || "").trim());
            } else {
              results[key] = false;
            }
          } else if (signal.kind === "url_pattern") {
            results[key] = new RegExp(signal.value).test(window.location.pathname);
          } else {
            results[key] = false;
          }
        } catch {
          results[key] = false;
        }
      }
      sendResponse({ ok: true, results });
    } catch (error) {
      sendResponse({
        ok: false,
        error: "ERR_SIGNAL_EVAL_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
    return false;
  }

  if (message.command === "read_entity") {
    try {
      const { strategies } = message.payload;
      const resolved = resolveLocator(strategies || []);

      if (!resolved) {
        sendResponse({
          ok: false,
          error: "ERR_TARGET_NOT_FOUND",
          message: "No locator strategy matched a unique element"
        });
        return false;
      }

      const state = readElementState(resolved.element);
      sendResponse({
        ok: true,
        state,
        usedStrategy: resolved.usedStrategy
      });
    } catch (error) {
      sendResponse({
        ok: false,
        error: "ERR_READ_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
    return false;
  }

  return false;
});
