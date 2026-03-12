/**
 * classify.js — Stage 3: Interactable Classification
 *
 * Runs on the CLI server. Takes raw ScannedElement[] + A11yInfo[] from
 * Stages 1–2 and classifies which elements are interactable and what
 * kind of interaction they afford.
 *
 * @typedef {{ scanId: number, interactionKind: string, confidence: number, inputType?: string }} InteractableElement
 */

// Input types that afford "type" interaction
const TYPEABLE_INPUT_TYPES = new Set([
  "text", "email", "password", "search", "tel", "url", "number", "date",
  "datetime-local", "month", "time", "week", "color"
]);

// Input types that afford "toggle" interaction
const TOGGLE_INPUT_TYPES = new Set(["checkbox", "radio"]);

// Input types that afford "click" (button-like) interaction
const BUTTON_INPUT_TYPES = new Set(["button", "reset", "image"]);

// Roles that map to "click"
const CLICK_ROLES = new Set(["button", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "treeitem"]);

// Roles that map to "navigate"
const NAVIGATE_ROLES = new Set(["link"]);

// Roles that map to "type"
const TYPE_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

// Roles that map to "toggle"
const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch"]);

// Roles that map to "select"
const SELECT_ROLES = new Set(["combobox", "listbox"]);

/**
 * Classify a single element as interactable or not.
 *
 * @param {{ tagName: string, attributes: Record<string, string>, textContent: string }} element
 * @param {{ role: string | null, name: string | null, isDisabled: boolean }} a11y
 * @returns {InteractableElement | null} classification result, or null if not interactable
 */
const classifyElement = (element, a11y) => {
  const tag = element.tagName;
  const attrs = element.attributes;
  const role = a11y?.role || null;
  const isDisabled = a11y?.isDisabled || false;

  // Disabled elements are still classified but with reduced confidence
  const disabledPenalty = isDisabled ? 0.3 : 0;

  // --- Tag-based classification (highest confidence) ---

  // <button> or <summary> → click (unless type="submit")
  if (tag === "button") {
    const buttonType = (attrs.type || "").toLowerCase();
    if (buttonType === "submit") {
      return {
        scanId: element.scanId,
        interactionKind: "submit",
        confidence: 0.95 - disabledPenalty
      };
    }
    return {
      scanId: element.scanId,
      interactionKind: "click",
      confidence: 0.95 - disabledPenalty
    };
  }

  // <a> with href → navigate
  if (tag === "a" && "href" in attrs) {
    return {
      scanId: element.scanId,
      interactionKind: "navigate",
      confidence: 0.95 - disabledPenalty
    };
  }

  // <input> → depends on type
  if (tag === "input") {
    const inputType = (attrs.type || "text").toLowerCase();

    if (inputType === "submit") {
      return {
        scanId: element.scanId,
        interactionKind: "submit",
        confidence: 0.95 - disabledPenalty,
        inputType
      };
    }

    if (TYPEABLE_INPUT_TYPES.has(inputType)) {
      return {
        scanId: element.scanId,
        interactionKind: "type",
        confidence: 0.95 - disabledPenalty,
        inputType
      };
    }

    if (TOGGLE_INPUT_TYPES.has(inputType)) {
      return {
        scanId: element.scanId,
        interactionKind: "toggle",
        confidence: 0.95 - disabledPenalty,
        inputType
      };
    }

    if (BUTTON_INPUT_TYPES.has(inputType)) {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.90 - disabledPenalty,
        inputType
      };
    }

    // Hidden, file, range — not standard interactables for our purposes
    if (inputType === "hidden") {
      return null;
    }

    if (inputType === "file") {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.70 - disabledPenalty,
        inputType
      };
    }

    if (inputType === "range") {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.70 - disabledPenalty,
        inputType: "range"
      };
    }

    // Fallback for unknown input types
    return {
      scanId: element.scanId,
      interactionKind: "type",
      confidence: 0.50 - disabledPenalty,
      inputType
    };
  }

  // <textarea> → type
  if (tag === "textarea") {
    return {
      scanId: element.scanId,
      interactionKind: "type",
      confidence: 0.95 - disabledPenalty
    };
  }

  // <select> → select
  if (tag === "select") {
    return {
      scanId: element.scanId,
      interactionKind: "select",
      confidence: 0.95 - disabledPenalty
    };
  }

  // <details> / <summary> → toggle
  if (tag === "details" || tag === "summary") {
    return {
      scanId: element.scanId,
      interactionKind: "toggle",
      confidence: 0.85 - disabledPenalty
    };
  }

  // --- Role-based classification (slightly lower confidence than tag-based) ---

  if (role) {
    if (role === "button" && tag !== "button") {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.85 - disabledPenalty
      };
    }

    if (NAVIGATE_ROLES.has(role) && tag !== "a") {
      return {
        scanId: element.scanId,
        interactionKind: "navigate",
        confidence: 0.80 - disabledPenalty
      };
    }

    if (TYPE_ROLES.has(role) && tag !== "input" && tag !== "textarea") {
      return {
        scanId: element.scanId,
        interactionKind: "type",
        confidence: 0.80 - disabledPenalty
      };
    }

    if (TOGGLE_ROLES.has(role) && tag !== "input") {
      return {
        scanId: element.scanId,
        interactionKind: "toggle",
        confidence: 0.80 - disabledPenalty
      };
    }

    if (SELECT_ROLES.has(role) && tag !== "select") {
      return {
        scanId: element.scanId,
        interactionKind: "select",
        confidence: 0.75 - disabledPenalty
      };
    }

    if (CLICK_ROLES.has(role)) {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.80 - disabledPenalty
      };
    }
  }

  // --- Attribute-based classification (lower confidence) ---

  // contenteditable → type
  if (attrs.contenteditable === "true" || attrs.contenteditable === "") {
    return {
      scanId: element.scanId,
      interactionKind: "type",
      confidence: 0.75 - disabledPenalty
    };
  }

  // onclick attribute → click
  if ("onclick" in attrs) {
    return {
      scanId: element.scanId,
      interactionKind: "click",
      confidence: 0.60 - disabledPenalty
    };
  }

  // tabindex (non-negative) on a non-interactive element suggests interactability
  if ("tabindex" in attrs && tag !== "div" && tag !== "span") {
    const tabindex = parseInt(attrs.tabindex, 10);
    if (!isNaN(tabindex) && tabindex >= 0) {
      return {
        scanId: element.scanId,
        interactionKind: "click",
        confidence: 0.40 - disabledPenalty
      };
    }
  }

  // Not interactable
  return null;
};

/**
 * Classify all elements in a snapshot.
 *
 * @param {Array} elements - ScannedElement[] from Stage 1
 * @param {Array} a11yEntries - A11yInfo[] from Stage 2
 * @returns {{ interactables: InteractableElement[], stats: { total: number, interactable: number, byKind: Record<string, number> } }}
 */
export const classifyInteractables = (elements, a11yEntries) => {
  // Build a11y lookup by scanId
  const a11yMap = new Map();
  for (const entry of a11yEntries) {
    a11yMap.set(entry.scanId, entry);
  }

  const interactables = [];
  const byKind = {};

  for (const element of elements) {
    const a11y = a11yMap.get(element.scanId) || null;
    const result = classifyElement(element, a11y);

    if (result && result.confidence > 0) {
      interactables.push(result);
      byKind[result.interactionKind] = (byKind[result.interactionKind] || 0) + 1;
    }
  }

  return {
    interactables,
    stats: {
      total: elements.length,
      interactable: interactables.length,
      byKind
    }
  };
};
