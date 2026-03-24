/**
 * enrich.js — Stage 7: LLM Semantic Enrichment
 *
 * Runs on the CLI server. Takes a compiled draft manifest from Stage 6
 * and uses an LLM to enrich it with domain-level semantic names and
 * composite actions.
 *
 * If the LLM is unavailable or returns invalid output, falls back to
 * the deterministic draft.
 */

import { getLLMConfig, callLLM } from "./llm-client.js";

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a web application analyst. You are given a structural manifest of a web page — entities (UI regions) and actions (interactive elements) — discovered by automated DOM analysis.

Your job: understand what this page DOES and assign **domain-specific, developer-friendly names** to every entity and action, as if you were designing an API for this website.

## Naming Rules

- Use snake_case for all names
- Entity names should be nouns describing WHAT the region is: "event_feed", "login_form", "message_list", "user_profile_card" — NOT "generic_button" or "div_container"
- Action names should be verbs describing WHAT the action does: "create_event", "filter_by_upcoming", "open_event_details", "submit_login" — NOT "click_button" or "navigate_to_a"
- NEVER use "generic", "orphan", "unknown", or scan IDs in semantic names
- EVERY entity and action MUST get a meaningful domain name — no exceptions
- Use the textContent, CSS classes, href values, and locator details to understand what each element actually does
- If two actions do the same thing (e.g. same href), note it in the description but still give each a unique semantic name indicating context (e.g., "navigate_to_home_navbar" vs "navigate_to_home_footer")

## Composite Actions

Group related actions that form a logical user operation:
- A card click + link click → "open_event(event_id)"
- Type email + type password + click submit → "login(email, password)"
- Type in search + click search → "search(query)"
You MUST create at least one composite action if there are related sequential actions on the page.

## Output Format

Respond with ONLY valid JSON (no markdown fences, no explanation) matching this schema:
{
  "domain": "string (e.g. event_management, messaging, email_client)",
  "domainDescription": "string (1-2 sentence description of what this site/page does)",
  "entities": [
    { "originalId": "string", "semanticName": "string", "description": "string" }
  ],
  "actions": [
    { "originalId": "string", "semanticName": "string", "description": "string", "inputs": [{ "name": "string", "description": "string" }] }
  ],
  "compositeActions": [
    { "name": "string", "description": "string", "stepActionIds": ["string (existing action IDs)"], "inputs": [{ "name": "string", "type": "string", "description": "string" }] }
  ]
}

CRITICAL: You MUST only reference entity/action IDs that exist in the input. Do NOT invent new actions.`;

/**
 * Build the user message for the LLM from the draft manifest.
 * Sends rich context: all locators, textContent, interactionKind, entity groupings.
 */
const buildUserMessage = (manifest, pageText) => {
  const parts = [
    `## Page`,
    `URL: ${manifest.metadata.site}`,
    ""
  ];

  if (pageText) {
    parts.push(`## Visible Page Text (first ~2000 chars)`, pageText.slice(0, 2000), "");
  }

  // Build entity → action mapping for context
  const entityActions = new Map();
  for (const action of manifest.actions) {
    if (!entityActions.has(action.entityId)) {
      entityActions.set(action.entityId, []);
    }
    entityActions.get(action.entityId).push(action.id);
  }

  // Entities with their signals and child actions
  const entitySummary = manifest.entities.map((e) => {
    const entry = {
      id: e.id,
      name: e.name,
      signals: e.signals.map((s) => `${s.kind}:${s.value}`),
      actions: entityActions.get(e.id) || []
    };
    return entry;
  });

  parts.push(
    `## Entities (${entitySummary.length})`,
    JSON.stringify(entitySummary, null, 2),
    ""
  );

  // Actions with FULL context: all locators, textContent, interactionKind
  const actionSummary = manifest.actions.map((a) => {
    const entry = {
      id: a.id,
      name: a.name,
      entityId: a.entityId,
      interactionKind: a.interactionKind || "unknown",
      textContent: a.textContent || null,
      inputs: a.inputs.map((i) => i.name),
      locators: a.locatorSet.strategies.map((s) =>
        `${s.kind}: ${s.value}`
      )
    };
    return entry;
  });

  parts.push(
    `## Actions (${actionSummary.length})`,
    JSON.stringify(actionSummary, null, 2)
  );

  return parts.join("\n");
};


// ---------------------------------------------------------------------------
// Validation of LLM output
// ---------------------------------------------------------------------------

/**
 * Parse and validate the LLM response against the draft manifest.
 * Returns validated enrichment data or null if invalid.
 */
const validateEnrichment = (rawResponse, manifest) => {
  let parsed;
  try {
    // Try to extract JSON from the response (handle markdown code fences)
    let jsonStr = rawResponse.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    console.warn("[browserwire-cli] LLM returned unparseable JSON:", error.message);
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    console.warn("[browserwire-cli] LLM response is not an object");
    return null;
  }

  // Build ID lookup sets
  const entityIds = new Set(manifest.entities.map((e) => e.id));
  const actionIds = new Set(manifest.actions.map((a) => a.id));

  // Validate domain
  const domain = typeof parsed.domain === "string" ? parsed.domain : null;
  const domainDescription = typeof parsed.domainDescription === "string" ? parsed.domainDescription : null;

  // Validate entity enrichments
  const entities = [];
  if (Array.isArray(parsed.entities)) {
    for (const e of parsed.entities) {
      if (!e || typeof e.originalId !== "string" || typeof e.semanticName !== "string") continue;
      if (!entityIds.has(e.originalId)) {
        console.warn(`[browserwire-cli] LLM referenced unknown entity: ${e.originalId}`);
        continue;
      }
      entities.push({
        originalId: e.originalId,
        semanticName: e.semanticName,
        description: typeof e.description === "string" ? e.description : ""
      });
    }
  }

  // Validate action enrichments
  const actions = [];
  if (Array.isArray(parsed.actions)) {
    for (const a of parsed.actions) {
      if (!a || typeof a.originalId !== "string" || typeof a.semanticName !== "string") continue;
      if (!actionIds.has(a.originalId)) {
        console.warn(`[browserwire-cli] LLM referenced unknown action: ${a.originalId}`);
        continue;
      }
      const inputs = Array.isArray(a.inputs)
        ? a.inputs.filter((i) => i && typeof i.name === "string")
        : [];
      actions.push({
        originalId: a.originalId,
        semanticName: a.semanticName,
        description: typeof a.description === "string" ? a.description : "",
        inputs
      });
    }
  }

  // Validate composite actions
  const compositeActions = [];
  if (Array.isArray(parsed.compositeActions)) {
    for (const ca of parsed.compositeActions) {
      if (!ca || typeof ca.name !== "string" || !Array.isArray(ca.stepActionIds)) continue;
      // Must have at least 2 steps
      if (ca.stepActionIds.length < 2) {
        console.warn(`[browserwire-cli] composite action "${ca.name}" has < 2 steps, skipping`);
        continue;
      }
      // All step IDs must reference existing actions
      const invalidSteps = ca.stepActionIds.filter((id) => !actionIds.has(id));
      if (invalidSteps.length > 0) {
        console.warn(`[browserwire-cli] composite action "${ca.name}" references unknown actions: ${invalidSteps.join(", ")}`);
        continue;
      }
      const inputs = Array.isArray(ca.inputs)
        ? ca.inputs.filter((i) => i && typeof i.name === "string" && typeof i.type === "string")
        : [];
      compositeActions.push({
        name: ca.name,
        description: typeof ca.description === "string" ? ca.description : "",
        stepActionIds: ca.stepActionIds,
        inputs
      });
    }
  }

  return { domain, domainDescription, entities, actions, compositeActions };
};

// ---------------------------------------------------------------------------
// Merge enrichment into manifest
// ---------------------------------------------------------------------------

/**
 * Merge validated enrichment data into a copy of the draft manifest.
 * Exported for direct use by the vision pipeline in session.js.
 */
export const mergeEnrichment = (manifest, enrichment, capturedAt) => {
  const enriched = JSON.parse(JSON.stringify(manifest));

  // Domain metadata
  if (enrichment.domain) {
    enriched.domain = enrichment.domain;
  }
  if (enrichment.domainDescription) {
    enriched.domainDescription = enrichment.domainDescription;
  }

  // Entity semantic names
  const entityEnrichMap = new Map();
  for (const e of enrichment.entities) {
    entityEnrichMap.set(e.originalId, e);
  }
  for (const entity of enriched.entities) {
    const enrich = entityEnrichMap.get(entity.id);
    if (enrich) {
      entity.semanticName = enrich.semanticName;
      if (enrich.description) {
        entity.description = enrich.description;
      }
    }
  }

  // Action semantic names
  const actionEnrichMap = new Map();
  for (const a of enrichment.actions) {
    actionEnrichMap.set(a.originalId, a);
  }
  for (const action of enriched.actions) {
    const enrich = actionEnrichMap.get(action.id);
    if (enrich) {
      action.semanticName = enrich.semanticName;
      if (enrich.description) {
        action.description = enrich.description;
      }
      // Refine input names/descriptions if provided
      if (enrich.inputs && enrich.inputs.length > 0 && action.inputs.length > 0) {
        for (let i = 0; i < Math.min(enrich.inputs.length, action.inputs.length); i++) {
          if (enrich.inputs[i].name) action.inputs[i].name = enrich.inputs[i].name;
          if (enrich.inputs[i].description) action.inputs[i].description = enrich.inputs[i].description;
        }
      }
    }
  }

  // Composite actions
  if (enrichment.compositeActions.length > 0) {
    const provenance = {
      source: "agent",
      sessionId: enriched.metadata.id,
      traceIds: [],
      annotationIds: [],
      capturedAt: capturedAt || new Date().toISOString()
    };

    enriched.compositeActions = enrichment.compositeActions.map((ca, index) => ({
      id: `composite_${ca.name}`,
      name: ca.name,
      description: ca.description,
      stepActionIds: ca.stepActionIds,
      inputs: ca.inputs.map((inp) => ({
        name: inp.name,
        type: inp.type || "string",
        required: true,
        description: inp.description || ""
      })),
      provenance
    }));
  }

  return enriched;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if LLM enrichment is available.
 */
export const isEnrichmentAvailable = () => {
  return getLLMConfig() !== null;
};

/**
 * Enrich a draft manifest with LLM semantic analysis.
 *
 * @param {object} manifest - Draft BrowserWireManifest from Stage 6
 * @param {string} [pageText] - Visible page text for context
 * @param {string} [capturedAt] - ISO timestamp
 * @returns {Promise<{ enriched: object, stats: object } | null>} enriched manifest or null on failure
 */
export const enrichManifest = async (manifest, pageText, capturedAt) => {
  const config = getLLMConfig();
  if (!config) {
    console.log("[browserwire-cli] LLM not configured, skipping enrichment");
    return null;
  }

  console.log(`[browserwire-cli] enriching manifest with ${config.provider}/${config.model}`);

  const userMessage = buildUserMessage(manifest, pageText);

  let rawResponse;
  try {
    rawResponse = await callLLM(SYSTEM_PROMPT, userMessage, config);
  } catch (error) {
    console.warn(`[browserwire-cli] LLM call failed: ${error.message}`);
    return null;
  }

  if (!rawResponse || rawResponse.trim().length === 0) {
    console.warn("[browserwire-cli] LLM returned empty response");
    return null;
  }

  const enrichment = validateEnrichment(rawResponse, manifest);
  if (!enrichment) {
    return null;
  }

  const enriched = mergeEnrichment(manifest, enrichment, capturedAt);

  const stats = {
    domain: enrichment.domain || "unknown",
    entitiesEnriched: enrichment.entities.length,
    actionsEnriched: enrichment.actions.length,
    compositeActions: enrichment.compositeActions.length
  };

  console.log(
    `[browserwire-cli] enrichment complete: domain="${stats.domain}" entities=${stats.entitiesEnriched} actions=${stats.actionsEnriched} composites=${stats.compositeActions}`
  );

  return { enriched, stats };
};
