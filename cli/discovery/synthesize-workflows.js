/**
 * synthesize-workflows.js — LLM-driven workflow synthesis
 *
 * Takes a merged BrowserWireManifest and produces WorkflowActionDef[] —
 * complete task blueprints covering navigation, interaction, and data reading.
 *
 * Three workflow kinds:
 *   read  — navigate → read_view → return structured data
 *   write — navigate → fill/select/click → submit → check outcomes
 *   mixed — navigate → interact → read_view → return structured data
 */

import { callLLM, getLLMConfig } from "./llm-client.js";

const SYSTEM_PROMPT = `You are a workflow architect for web automation. Given a site manifest, you synthesize high-level task workflows that developers actually want to call.

You will receive:
- pages[]: { id, routePattern, name, description }
- actions[]: { id, interactionKind, semanticName, name }
- views[]: { id, name, isList }
- compositeActions[]: hints about multi-step operations

## Three workflow kinds

**READ workflows** (kind: "read") — fetch and return structured data:
- Navigate to the listing/detail page
- End with a read_view step referencing a viewId from views[]
- No inputs required unless navigation needs a parameter (e.g., id for detail page)
- No outcomes field needed
- Examples: list_events, get_event_details, list_attendees

**WRITE workflows** (kind: "write") — perform a mutation:
- Navigate to form/action page
- Fill fields (interactionKind=type → fill), select dropdowns (interactionKind=select → select), submit (form-submit click → submit, toggle → click)
- Provide outcomes with success/failure signals
- Examples: create_event, register_for_event, update_profile
- **Single-action writes are valid**: A write workflow can be as simple as navigate → click. Any individually useful action that causes a mutation (delete, approve, reject, archive, toggle publish, mark complete) should be its own workflow.
- Examples of single-action writes: delete_event (navigate → click), approve_request (navigate → click), toggle_published (navigate → click), archive_item (navigate → click)

**MIXED workflows** (kind: "mixed") — interact then read:
- Navigate, interact (search/filter), then read_view for results
- Provide outcomes only if a submission is involved
- Examples: search_events, filter_by_category

## Rules
- First step MUST always be navigate
- Only reference actionIds from actions[] and viewIds from views[]
- read_view MUST be the LAST step for read/mixed workflows
- For write: infer step type from interactionKind: type→fill, select→select, form-submit click→submit, toggle→click
- Map every workflow input to exactly one fill/select step via inputParam, OR to a navigate URL :param — both are valid
- Every :param placeholder in a navigate URL MUST have a corresponding entry in inputs[] (e.g., /events/:id requires an input named "id")
- Include ALL useful workflows — every action that a developer would want to call as an API should become a workflow
- Skip cosmetic/utility actions that are not useful as APIs (e.g., toggle dark mode, expand sidebar, close modal, scroll to top)
- URL: use routePattern from pages[]; replace :param with the input variable name

## Output format (JSON only, no prose)
{
  "workflows": [
    {
      "name": "list_events",
      "kind": "read",
      "description": "Returns all events as a structured list",
      "inputs": [],
      "steps": [
        { "type": "navigate", "url": "/events" },
        { "type": "read_view", "viewId": "view_events_list" }
      ]
    },
    {
      "name": "create_event",
      "kind": "write",
      "description": "Creates a new event by filling the creation form",
      "inputs": [
        { "name": "title", "type": "string", "required": true, "description": "Event title" },
        { "name": "start_date", "type": "string", "required": true, "description": "Start date" }
      ],
      "steps": [
        { "type": "navigate", "url": "/events/new" },
        { "type": "fill", "actionId": "action_type_into_title", "inputParam": "title" },
        { "type": "fill", "actionId": "action_type_into_start_date", "inputParam": "start_date" },
        { "type": "submit", "actionId": "action_click_create_event" }
      ],
      "outcomes": {
        "success": { "kind": "url_change", "value": "/events/[0-9]+" },
        "failure": { "kind": "element_appears", "value": ".error-message, .alert-danger" }
      }
    },
    {
      "name": "delete_event",
      "kind": "write",
      "description": "Deletes an event by clicking its delete button",
      "inputs": [
        { "name": "id", "type": "string", "required": true, "description": "Event ID" }
      ],
      "steps": [
        { "type": "navigate", "url": "/events/:id" },
        { "type": "click", "actionId": "action_click_delete_event" }
      ],
      "outcomes": {
        "success": { "kind": "url_change", "value": "/events" },
        "failure": { "kind": "element_appears", "value": ".error-message, .alert-danger" }
      }
    }
  ]
}`;

/**
 * Validate and clean up a raw workflow object from the LLM response.
 * Returns a WorkflowActionDef or null if invalid.
 */
const validateWorkflow = (raw, actionIds, viewIds, capturedAt) => {
  if (!raw || typeof raw !== "object") return null;
  if (!raw.name || typeof raw.name !== "string") return null;
  if (!["read", "write", "mixed"].includes(raw.kind)) return null;
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) return null;

  // First step must be navigate
  if (raw.steps[0]?.type !== "navigate") return null;

  const steps = [];
  for (const step of raw.steps) {
    if (!step || typeof step.type !== "string") return null;

    if (step.type === "navigate") {
      if (!step.url || typeof step.url !== "string") return null;
      steps.push({ type: "navigate", url: step.url });
      continue;
    }

    if (step.type === "read_view") {
      if (!step.viewId || !viewIds.has(step.viewId)) {
        // skip invalid read_view references silently
        continue;
      }
      steps.push({ type: "read_view", viewId: step.viewId });
      continue;
    }

    if (["fill", "select", "click", "submit"].includes(step.type)) {
      if (!step.actionId || !actionIds.has(step.actionId)) {
        // skip unknown action references
        continue;
      }
      const s = { type: step.type, actionId: step.actionId };
      if (step.inputParam && typeof step.inputParam === "string") {
        s.inputParam = step.inputParam;
      }
      steps.push(s);
      continue;
    }

    // Unknown step type — skip
  }

  if (steps.length === 0) return null;
  if (steps[0].type !== "navigate") return null;

  // For read/mixed: require at least one read_view step
  if (raw.kind === "read" || raw.kind === "mixed") {
    if (!steps.some((s) => s.type === "read_view")) return null;
    // read_view must be last
    const lastIdx = steps.length - 1;
    if (steps[lastIdx].type !== "read_view") {
      // Move it to the end
      const readViewSteps = steps.filter((s) => s.type === "read_view");
      const nonReadView = steps.filter((s) => s.type !== "read_view");
      steps.length = 0;
      steps.push(...nonReadView, ...readViewSteps);
    }
  }

  // For write: require at least one interaction step
  if (raw.kind === "write") {
    const hasInteraction = steps.some((s) =>
      ["fill", "select", "click", "submit"].includes(s.type)
    );
    if (!hasInteraction) return null;
  }

  // Validate inputs — keep inputs referenced by step inputParam OR navigate URL :params
  const referencedParams = new Set(
    steps.filter((s) => s.inputParam).map((s) => s.inputParam)
  );
  for (const step of steps) {
    if (step.type === "navigate" && step.url) {
      for (const match of step.url.matchAll(/:([a-zA-Z_][a-zA-Z0-9_]*)/g)) {
        referencedParams.add(match[1]);
      }
    }
  }

  const inputs = (Array.isArray(raw.inputs) ? raw.inputs : [])
    .filter((i) => i && typeof i.name === "string" && referencedParams.has(i.name))
    .map((i) => ({
      name: i.name,
      type: ["string", "number", "boolean", "enum"].includes(i.type) ? i.type : "string",
      required: i.required === true,
      description: typeof i.description === "string" ? i.description : undefined
    }));

  const workflowId = `workflow_${raw.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

  const result = {
    id: workflowId,
    name: raw.name,
    description: typeof raw.description === "string" ? raw.description : raw.name,
    kind: raw.kind,
    inputs,
    steps,
    provenance: {
      source: "agent",
      sessionId: "workflow-synthesis",
      traceIds: [],
      annotationIds: [],
      capturedAt: capturedAt || new Date().toISOString()
    }
  };

  // Add outcomes for write/mixed
  if (raw.outcomes && typeof raw.outcomes === "object" && raw.kind !== "read") {
    const outcomes = {};
    for (const [key, signal] of Object.entries(raw.outcomes)) {
      if (!signal || typeof signal !== "object") continue;
      if (!["url_change", "element_appears", "text_contains", "element_disappears"].includes(signal.kind)) continue;
      if (typeof signal.value !== "string") continue;
      outcomes[key] = { kind: signal.kind, value: signal.value };
      if (signal.selector && typeof signal.selector === "string") {
        outcomes[key].selector = signal.selector;
      }
    }
    if (Object.keys(outcomes).length > 0) {
      result.outcomes = outcomes;
    }
  }

  return result;
};

/**
 * Synthesize WorkflowActionDef[] from a merged manifest using the LLM.
 *
 * @param {object} manifest - BrowserWireManifest
 * @returns {Promise<WorkflowActionDef[]>}
 */
export const synthesizeWorkflows = async (manifest) => {
  const config = getLLMConfig();
  if (!config) {
    console.log("[browserwire-cli] workflow synthesis skipped: LLM not configured");
    return [];
  }

  const actions = manifest.actions || [];
  const views = manifest.views || [];
  const pages = manifest.pages || [];
  const compositeActions = manifest.compositeActions || [];

  if (actions.length === 0 && views.length === 0) {
    console.log("[browserwire-cli] workflow synthesis skipped: no actions or views");
    return [];
  }

  const actionIds = new Set(actions.map((a) => a.id));
  const viewIds = new Set(views.map((v) => v.id));

  // Build compact manifest summary for the LLM
  const userMessage = JSON.stringify({
    pages: pages.map((p) => ({
      id: p.id,
      routePattern: p.routePattern,
      name: p.name,
      description: p.description || ""
    })),
    actions: actions.map((a) => ({
      id: a.id,
      interactionKind: a.interactionKind || "click",
      semanticName: a.semanticName || a.name,
      name: a.name
    })),
    views: views.map((v) => ({
      id: v.id,
      name: v.semanticName || v.name,
      isList: v.isList || false
    })),
    compositeActions: compositeActions.map((ca) => ({
      name: ca.name,
      description: ca.description || "",
      stepCount: (ca.stepActionIds || []).length
    }))
  }, null, 2);

  let rawText;
  try {
    rawText = await callLLM(SYSTEM_PROMPT, userMessage, config);
  } catch (error) {
    console.warn(`[browserwire-cli] workflow synthesis LLM call failed: ${error.message}`);
    return [];
  }

  // Parse JSON from response
  let parsed;
  try {
    // Strip markdown code fences if present
    const cleaned = rawText
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch (error) {
    console.warn(`[browserwire-cli] workflow synthesis: failed to parse LLM response: ${error.message}`);
    return [];
  }

  const rawWorkflows = Array.isArray(parsed.workflows) ? parsed.workflows : [];
  const capturedAt = new Date().toISOString();

  const workflows = rawWorkflows
    .map((raw) => validateWorkflow(raw, actionIds, viewIds, capturedAt))
    .filter(Boolean);

  console.log(`[browserwire-cli] workflow synthesis: ${workflows.length} workflows synthesized (${rawWorkflows.length} raw)`);
  return workflows;
};
