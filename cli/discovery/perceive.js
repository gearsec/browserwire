/**
 * perceive.js — Vision LLM Perception Module
 *
 * Takes a page skeleton + annotated screenshot and uses a vision LLM to
 * identify the 15-25 most meaningful elements and their semantic roles.
 *
 * Input:  { skeleton[], screenshot (base64 JPEG), pageText, url, title }
 * Output: { domain, domainDescription, entities[], actions[], compositeActions[] }
 *
 * All scanIds in the output are validated against the input skeleton.
 */

import { getLLMConfig, callLLM, callLLMWithVision } from "./llm-client.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web application analyst with computer vision capabilities. You are given:
1. An annotated screenshot of a web page where interactable elements are highlighted with orange boxes labeled with their s-ID (e.g., "s11" = scanId 11)
2. A compact HTML skeleton listing all labeled elements (some elements have state-* attributes showing live runtime state)

Your task: understand what this page does and identify the 15-25 most meaningful interactive elements, semantic regions, views (readable data), and the page/route context.

## Views (Read Operations)

Think of this page as a REST API endpoint. What data does it DISPLAY?

Identify views — structured data visible on the page:
- Lists (e.g., event list, message inbox, search results)
- Detail views (e.g., event details, user profile)
- Status displays (e.g., notification count, account balance)

For each view, provide CSS selectors for data extraction:
- containerSelector: CSS selector for the data region
- itemSelector: for lists, CSS selector for each repeating item (relative to container)
- fields: for each data field, a CSS selector relative to the item/container

## Network API Context

You may receive a summary of API requests/responses the web app made during this interaction, including request bodies and query parameters.

Use this to:
- Identify which API call populates each view — include as "apiRequest" on the view
- Discover entity IDs not visible in the DOM (guild_id, channel_id, user_id, etc.)
- Find fields in API responses that aren't rendered in the UI

For each view, if you can determine the backing API call, include an "apiRequest" object:

For REST endpoints:
  "apiRequest": { "method": "GET", "pathPattern": "/api/v9/guilds/:id/channels" }

For REST with important query params:
  "apiRequest": { "method": "GET", "pathPattern": "/api/search", "matchOn": { "queryParams": ["type", "category"] } }

For GraphQL (CRITICAL — same /graphql endpoint, different operations):
  "apiRequest": { "method": "POST", "pathPattern": "/graphql", "matchOn": { "operationName": "GetChannels" } }

When a view has an apiRequest, also include "apiFields" — a mapping from your view field names to the JSON path in the API response:

  "apiFields": {
    "username": "username",
    "status": "activities[0].state",
    "avatar_url": "avatar"
  }

Rules for apiFields:
- Keys must match field names in the view's "fields" array
- Values are dot-notation JSON paths into the API response body
- For arrays, use [0] to indicate the first element shape
- Only include fields you can confirm exist in the API response shape shown

Rules:
- Replace specific IDs in paths with :id placeholders
- For GraphQL endpoints, you MUST include matchOn.operationName — path alone is not sufficient
- For REST endpoints where query params determine the response shape, include matchOn.queryParams

## Pages (Routes)

What page/route is this? Identify:
- Route pattern (generalize IDs: "/events/:id" not "/events/123")
- Which views are visible
- Which actions are available

## Output Format

Respond with ONLY valid JSON (no markdown fences, no explanation):
{
  "domain": "string (e.g. event_management, messaging, email_client)",
  "domainDescription": "string (1-2 sentences describing what this page/site does)",
  "pageState": {
    "name": "string (human name for this page)",
    "routePattern": "string (e.g. /events, /events/:id, /login)",
    "description": "string (1 sentence describing this page)",
    "stateSignals": [
      { "kind": "selector_exists|text_match|url_pattern", "value": "string", "selector": "string (only for text_match: element whose text to test)", "weight": 0.8 }
    ]
  },
  "entities": [
    {
      "name": "snake_case_entity_name (noun describing the region)",
      "scanIds": [/* numbers: the s-IDs of elements belonging to this region */],
      "description": "string"
    }
  ],
  "views": [
    {
      "name": "snake_case_view_name (e.g. event_list, user_profile)",
      "description": "string",
      "isList": true,
      "isDynamic": false,
      "containerSelector": "CSS selector for the data region",
      "itemSelector": "CSS selector for each repeating item (relative to container, omit if isList=false)",
      "fields": [
        { "name": "field_name", "type": "string|number|boolean|date", "selector": "CSS selector relative to item/container" }
      ],
      "apiRequest": { "method": "string", "pathPattern": "string", "matchOn": { "operationName?": "string", "queryParams?": ["string"] } },
      "apiFields": { "field_name": "json.path.in.response", "...": "..." },
      "entityScanIds": [/* numbers: s-IDs of elements within this view's data region */]
    }
  ],
  "actions": [
    {
      "scanId": /* number: the s-ID from the screenshot/skeleton */,
      "semanticName": "snake_case_verb_noun (e.g. create_event, submit_login, search_events)",
      "interactionKind": "click|type|select|navigate",
      "description": "string",
      "preconditions": [
        { "description": "string", "stateField": "optional field name that must be non-empty" }
      ],
      "locator": {
        "kind": "xpath" | "css",
        "value": "semantic selector referencing surrounding labels/context",
        "reasoning": "brief explanation of why this selector was chosen"
      }
    }
  ],
  "compositeActions": [
    {
      "name": "snake_case_workflow_name",
      "description": "string",
      "stepScanIds": [/* ordered scanIds of the steps */],
      "inputs": [{ "name": "string", "type": "string", "description": "string" }]
    }
  ]
}

## Rules
- Only reference scanIds that appear in the HTML skeleton (id="s{scanId}")
- Use snake_case for all names. Semantic names must be developer-friendly verbs/nouns
- NEVER use "generic", "unknown", "element", or raw numbers in names
- Focus on the 15-25 most meaningful elements — skip decorative/redundant ones
- Group related elements into entities (UI regions: forms, nav bars, cards, dialogs)
- Create composite actions for multi-step workflows (search box + button, login form, filters)
- All interactable elements with orange boxes in the screenshot should appear in "actions"
- For views: use specific CSS selectors that would work for runtime extraction without LLM
- Generalize route patterns: use :id for numeric/UUID path segments (e.g., /events/:id not /events/123)
- NEVER use skeleton scan IDs (like #s10, #s12, div#s5) as CSS selectors for views — these are temporary labels that do NOT exist in the real DOM. Use semantic selectors instead: class names, data-* attributes, ARIA roles, tag+attribute combos
- Field selectors MUST be specific enough to distinguish different fields within an item — never use just "div" or the same selector for multiple fields
- If you cannot determine a specific selector for a view field, omit that field entirely

## Dynamic Content Rules

Mark views as \`isDynamic: true\` when their content is server-driven and changes over time:
- Lists fed from a database (event lists, message inboxes, search results, activity feeds) → \`isDynamic: true\`
- Detail views that show different records per URL parameter → \`isDynamic: true\`
- Status counters, notification badges, live metrics → \`isDynamic: true\`
- Static nav/chrome/fixed labels/headings → \`isDynamic: false\`

For dynamic views, NEVER hardcode specific values (names, dates, IDs, usernames) in CSS selectors or field selectors.
Use structural selectors: class names, data-* attributes, tag+attribute combos, ARIA roles.
A selector like \`.event-title\` is correct. A selector like \`[data-id="123"]\` is wrong.

## Page State Signal Rules

For each pageState, provide 2–4 \`stateSignals\` to identify this specific UI state, especially for SPAs where URLs don't change:
- \`selector_exists\`: A CSS selector that is present ONLY on this page state (not shared across all pages). Example: \`[data-page="event-detail"]\`, \`.event-form\`, \`#login-panel\`. Weight: 0.8–0.9
- \`text_match\`: A regex pattern matched against the text content of a specific element. Use \`selector\` to specify which element (e.g., \`h1\`, \`.breadcrumb\`, \`[role="tab"][aria-selected="true"]\`). Example: \`value: "^Event Details$"\`, \`selector: "h1"\`. Weight: 0.7–0.8
- \`url_pattern\`: A regex matched against the pathname. Only use as a tiebreaker (weight 0.5–0.6), not as the primary signal.

Rules:
- Provide the most specific signals you can observe from the screenshot/DOM
- NEVER use dynamic values (usernames, dates, IDs) in signal values
- Prefer heading text, breadcrumb text, or active tab labels for text_match signals
- Prefer data-page, data-view, or section-specific class selectors for selector_exists

## Locator Rules (for each action)

For each action, provide a "locator" field with a semantic selector:
- Prefer XPath when you need ancestor/sibling context (e.g. label associations)
- Prefer CSS when stable attributes (data-testid, name, aria-label) are available
- NEVER use absolute paths like /html/body/div[3]/... or positional indexes like //div[5]
- Reference nearby labels, headings, or ARIA relationships for ambiguous elements
- A checkbox near "Remember me" → //label[contains(.,'Remember me')]/following-sibling::input[@type='checkbox']
- An input with placeholder "Search..." → input[placeholder='Search...'] or //input[@placeholder='Search...']
- A button labeled "Submit" → //button[normalize-space()='Submit'] or button[type='submit']
- Use name, aria-label, data-testid, placeholder, or visible text before resorting to structural selectors
- If no reliable semantic locator can be determined, omit the locator field entirely`;

// ---------------------------------------------------------------------------
// Network context builder
// ---------------------------------------------------------------------------

const describeShape = (obj, maxDepth, depth = 0) => {
  if (obj === null) return "null";
  if (Array.isArray(obj)) return obj.length ? `[${describeShape(obj[0], maxDepth, depth)}]` : "[]";
  if (typeof obj !== "object") return typeof obj;
  if (depth >= maxDepth) return "{...}";
  const keys = Object.keys(obj).slice(0, 12);
  const parts = keys.map(k => `${k}: ${describeShape(obj[k], maxDepth, depth + 1)}`);
  return `{ ${parts.join(", ")}${Object.keys(obj).length > 12 ? ", ..." : ""} }`;
};

const buildNetworkContext = (networkLog) => {
  if (!networkLog?.length) return "";

  const grouped = new Map();
  for (const entry of networkLog) {
    try {
      const path = new URL(entry.url).pathname
        .replace(/\/[0-9a-f]{8,}(?:-[0-9a-f]{4,}){0,4}/gi, '/:id')
        .replace(/\/\d+/g, '/:id');
      const opName = entry.requestBody?.operationName;
      const key = opName ? `${entry.method} ${path} [${opName}]` : `${entry.method} ${path}`;
      if (!grouped.has(key)) grouped.set(key, entry);
    } catch {}
  }

  const lines = ["API requests observed during this interaction (fetch/XHR only):"];
  let budget = 2300;
  for (const [pattern, sample] of grouped) {
    let line = `- ${pattern} → ${sample.status}`;

    if (sample.queryParams && Object.keys(sample.queryParams).length > 0) {
      const params = Object.keys(sample.queryParams).slice(0, 8).join(", ");
      line += `\n  Query params: ${params}`;
    }

    if (sample.requestBody != null) {
      line += `\n  Request body: ${describeShape(sample.requestBody, 2)}`;
    }

    if (sample.responseBody != null) {
      line += `\n  Response shape: ${describeShape(sample.responseBody, 2)}`;
      if (Array.isArray(sample.responseBody))
        line += ` (${sample.responseBody.length} items)`;
    }

    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// HTML skeleton builder
// ---------------------------------------------------------------------------

/**
 * Build a compact HTML skeleton string from skeleton entries.
 * Uses id="s{scanId}" as the element marker for LLM reference.
 */
const buildHtmlSkeleton = (skeleton) => {
  const lines = [];

  for (const entry of skeleton) {
    const attrs = [`id="s${entry.scanId}"`];

    if (entry.role) attrs.push(`role="${entry.role}"`);
    if (entry.attributes?.href) {
      attrs.push(`href="${entry.attributes.href.slice(0, 80)}"`);
    }
    if (entry.attributes?.type) {
      attrs.push(`type="${entry.attributes.type}"`);
    }
    if (entry.attributes?.placeholder) {
      attrs.push(`placeholder="${entry.attributes.placeholder.slice(0, 60)}"`);
    }
    if (entry.attributes?.["aria-label"]) {
      attrs.push(`aria-label="${entry.attributes["aria-label"].slice(0, 60)}"`);
    }
    if (entry.attributes?.name) {
      attrs.push(`name="${entry.attributes.name.slice(0, 40)}"`);
    }
    if (entry.attributes?.["data-testid"]) {
      attrs.push(`data-testid="${entry.attributes["data-testid"].slice(0, 40)}"`);
    }
    if (entry.attributes?.class) {
      attrs.push(`class="${entry.attributes.class}"`);
    }

    // Include element state as state-* attributes for LLM context
    if (entry.state) {
      if (entry.state.value != null) attrs.push(`state-value="${String(entry.state.value).slice(0, 60)}"`);
      if (entry.state.checked != null) attrs.push(`state-checked="${entry.state.checked}"`);
      if (entry.state.selectedOption != null) attrs.push(`state-selectedOption="${entry.state.selectedOption.slice(0, 40)}"`);
      if (entry.state.disabled) attrs.push(`state-disabled="true"`);
      if (entry.state.expanded != null) attrs.push(`state-expanded="${entry.state.expanded}"`);
      if (entry.state.selected != null) attrs.push(`state-selected="${entry.state.selected}"`);
    }

    const attrsStr = attrs.join(" ");
    const text = entry.text ? entry.text.slice(0, 60) : "";

    // Self-closing for void / replaced elements
    if (entry.tagName === "input" || entry.tagName === "select") {
      lines.push(`<${entry.tagName} ${attrsStr} />`);
    } else if (text) {
      lines.push(`<${entry.tagName} ${attrsStr}>${text}</${entry.tagName}>`);
    } else {
      lines.push(`<${entry.tagName} ${attrsStr}></${entry.tagName}>`);
    }
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const isSkeletonSelector = (sel) => /(?:^|[\s,])#s\d+|div#s\d+|id="s\d+"/.test(sel);
const isTooGeneric = (sel) => /^(div|span|p|a|li|ul|section|article)$/.test(sel.trim());

/**
 * Parse and validate the LLM perception output.
 * Rejects any scanIds not present in the skeleton.
 * Returns validated perception or null on failure.
 */
const validatePerception = (rawResponse, validScanIds) => {
  let parsed;
  try {
    let jsonStr = rawResponse.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) jsonStr = fenceMatch[1].trim();
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    console.warn("[browserwire-cli] vision LLM returned unparseable JSON:", error.message);
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const domain = typeof parsed.domain === "string" ? parsed.domain : "unknown";
  const domainDescription = typeof parsed.domainDescription === "string" ? parsed.domainDescription : "";

  // Validate entities
  const entities = [];
  if (Array.isArray(parsed.entities)) {
    for (const e of parsed.entities) {
      if (!e || typeof e.name !== "string" || !Array.isArray(e.scanIds)) continue;
      const validatedScanIds = e.scanIds.filter(
        (id) => typeof id === "number" && validScanIds.has(id)
      );
      if (validatedScanIds.length === 0) continue;
      entities.push({
        name: e.name,
        scanIds: validatedScanIds,
        description: typeof e.description === "string" ? e.description : ""
      });
    }
  }

  // Validate pageState
  let pageState = null;
  if (parsed.pageState && typeof parsed.pageState === "object") {
    const ps = parsed.pageState;
    if (typeof ps.name === "string" && typeof ps.routePattern === "string") {
      const validSignalKinds = ["selector_exists", "text_match", "url_pattern"];
      const stateSignals = Array.isArray(ps.stateSignals)
        ? ps.stateSignals.filter((s) =>
            s && validSignalKinds.includes(s.kind) &&
            typeof s.value === "string" && s.value.trim().length > 0 &&
            typeof s.weight === "number" && s.weight > 0 && s.weight <= 1
          ).map((s) => ({
            kind: s.kind,
            value: s.value.trim(),
            ...(s.kind === "text_match" && typeof s.selector === "string" && s.selector.trim()
              ? { selector: s.selector.trim() }
              : {}),
            weight: s.weight
          }))
        : [];
      pageState = {
        name: ps.name,
        routePattern: ps.routePattern,
        description: typeof ps.description === "string" ? ps.description : "",
        stateSignals
      };
    }
  }

  // Validate views
  const views = [];
  if (Array.isArray(parsed.views)) {
    for (const v of parsed.views) {
      if (!v || typeof v.name !== "string" || typeof v.containerSelector !== "string") continue;
      if (isSkeletonSelector(v.containerSelector)) continue;
      if (!Array.isArray(v.fields) || v.fields.length === 0) continue;

      const validFields = v.fields.filter(
        (f) => f && typeof f.name === "string" && typeof f.selector === "string"
          && f.selector.trim() !== ""
          && !isSkeletonSelector(f.selector)
          && !isTooGeneric(f.selector)
      ).map((f) => ({
        name: f.name,
        type: ["string", "number", "boolean", "date"].includes(f.type) ? f.type : "string",
        selector: f.selector
      }));

      if (validFields.length === 0) continue;

      const entityScanIds = Array.isArray(v.entityScanIds)
        ? v.entityScanIds.filter((id) => typeof id === "number" && validScanIds.has(id))
        : [];

      // Parse optional apiRequest
      let apiRequest = null;
      if (v.apiRequest && typeof v.apiRequest === "object") {
        const ar = v.apiRequest;
        if (typeof ar.method === "string" && typeof ar.pathPattern === "string") {
          apiRequest = { method: ar.method, pathPattern: ar.pathPattern };
          if (ar.matchOn && typeof ar.matchOn === "object") {
            const matchOn = {};
            if (typeof ar.matchOn.operationName === "string") matchOn.operationName = ar.matchOn.operationName;
            if (Array.isArray(ar.matchOn.queryParams)) matchOn.queryParams = ar.matchOn.queryParams.filter(p => typeof p === "string");
            if (Object.keys(matchOn).length > 0) apiRequest.matchOn = matchOn;
          }
        }
      }

      // Parse optional apiFields (mapping from view field names to JSON paths in API response)
      let apiFields = null;
      if (apiRequest && v.apiFields && typeof v.apiFields === "object" && !Array.isArray(v.apiFields)) {
        apiFields = {};
        for (const [fieldName, jsonPath] of Object.entries(v.apiFields)) {
          if (typeof fieldName === "string" && typeof jsonPath === "string") {
            apiFields[fieldName] = jsonPath;
          }
        }
        if (Object.keys(apiFields).length === 0) apiFields = null;
      }

      views.push({
        name: v.name,
        description: typeof v.description === "string" ? v.description : "",
        isList: v.isList === true,
        isDynamic: v.isDynamic === true,
        containerSelector: v.containerSelector,
        itemSelector: typeof v.itemSelector === "string" ? v.itemSelector : null,
        fields: validFields,
        ...(apiRequest ? { apiRequest } : {}),
        ...(apiFields ? { apiFields } : {}),
        entityScanIds
      });
    }
  }

  // Validate actions
  const actions = [];
  if (Array.isArray(parsed.actions)) {
    for (const a of parsed.actions) {
      if (!a || typeof a.scanId !== "number" || typeof a.semanticName !== "string") continue;
      if (!validScanIds.has(a.scanId)) {
        console.warn(`[browserwire-cli] vision LLM referenced unknown scanId: ${a.scanId}`);
        continue;
      }
      const kind = a.interactionKind;
      const preconditions = Array.isArray(a.preconditions)
        ? a.preconditions.filter(
            (p) => p && typeof p.description === "string"
          ).map((p) => ({
            description: p.description,
            stateField: typeof p.stateField === "string" ? p.stateField : null
          }))
        : [];

      // Parse optional LLM-generated semantic locator
      let locator = null;
      if (a.locator && typeof a.locator === "object") {
        const locKind = a.locator.kind;
        const locValue = a.locator.value;
        if (["xpath", "css"].includes(locKind) && typeof locValue === "string" && locValue.trim().length > 0) {
          locator = {
            kind: locKind,
            value: locValue.trim(),
            reasoning: typeof a.locator.reasoning === "string" ? a.locator.reasoning : ""
          };
        }
      }

      const actionEntry = {
        scanId: a.scanId,
        semanticName: a.semanticName,
        interactionKind: ["click", "type", "select", "navigate"].includes(kind) ? kind : "click",
        description: typeof a.description === "string" ? a.description : "",
        preconditions
      };
      if (locator) actionEntry.locator = locator;
      actions.push(actionEntry);
    }
  }

  // Validate composite actions (must have ≥ 2 valid steps)
  const compositeActions = [];
  if (Array.isArray(parsed.compositeActions)) {
    for (const ca of parsed.compositeActions) {
      if (!ca || typeof ca.name !== "string" || !Array.isArray(ca.stepScanIds)) continue;
      const validSteps = ca.stepScanIds.filter(
        (id) => typeof id === "number" && validScanIds.has(id)
      );
      if (validSteps.length < 2) continue;
      const inputs = Array.isArray(ca.inputs)
        ? ca.inputs.filter((i) => i && typeof i.name === "string")
        : [];
      compositeActions.push({
        name: ca.name,
        description: typeof ca.description === "string" ? ca.description : "",
        stepScanIds: validSteps,
        inputs
      });
    }
  }

  return { domain, domainDescription, pageState, views, entities, actions, compositeActions };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Perceive a page snapshot using the vision LLM.
 *
 * @param {{ skeleton: object[], screenshot: string|null, pageText: string, url: string, title: string }} payload
 * @returns {Promise<object|null>} perception result or null on failure/no-LLM
 */
export const perceiveSnapshot = async (payload) => {
  const config = getLLMConfig();
  if (!config) {
    console.log("[browserwire-cli] LLM not configured, skipping perception");
    return null;
  }

  const { skeleton = [], screenshot, pageText, url, title, networkLog } = payload;

  if (skeleton.length === 0) {
    console.warn("[browserwire-cli] empty skeleton, skipping perception");
    return null;
  }

  const htmlSkeleton = buildHtmlSkeleton(skeleton);
  const validScanIds = new Set(skeleton.map((e) => e.scanId));

  const networkContext = buildNetworkContext(networkLog);

  const skeletonKB = Math.round(htmlSkeleton.length / 1024 * 10) / 10;
  console.log(
    `[browserwire-cli] perceiving: ${skeleton.length} skeleton elements (${skeletonKB}KB html), ` +
    `screenshot=${screenshot ? "yes" : "no"}` +
    (networkLog?.length ? `, networkLog=${networkLog.length}` : "")
  );

  const context = [
    `URL: ${url}`,
    title ? `Title: ${title}` : "",
    pageText ? `\nPage text (excerpt): ${pageText.slice(0, 500)}` : ""
  ].filter(Boolean).join("\n");

  const userContent = [
    context,
    `\nHTML Skeleton:\n${htmlSkeleton}`,
    networkContext ? `\n${networkContext}` : ""
  ].filter(Boolean).join("\n");

  let rawResponse;
  try {
    if (screenshot) {
      rawResponse = await callLLMWithVision(SYSTEM_PROMPT, screenshot, userContent, config);
    } else {
      // Text-only fallback when no screenshot is available
      rawResponse = await callLLM(SYSTEM_PROMPT, userContent, config);
    }
  } catch (error) {
    console.warn(`[browserwire-cli] vision LLM call failed: ${error.message}`);
    return null;
  }

  if (!rawResponse || rawResponse.trim().length === 0) {
    console.warn("[browserwire-cli] vision LLM returned empty response");
    return null;
  }

  const perception = validatePerception(rawResponse, validScanIds);
  if (!perception) {
    console.warn("[browserwire-cli] vision LLM output failed validation");
    return null;
  }

  console.log(
    `[browserwire-cli] perception complete: domain="${perception.domain}" ` +
    `entities=${perception.entities.length} actions=${perception.actions.length} ` +
    `views=${perception.views.length} composites=${perception.compositeActions.length}`
  );

  return perception;
};
