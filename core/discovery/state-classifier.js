/**
 * state-classifier.js — State classification and snapshot consolidation.
 *
 * Uses a LangGraph classifier graph to process all snapshots sequentially,
 * determining which semantic state each belongs to. The graph maintains
 * conversation history so the model can visually compare screenshots across
 * the entire session — not just match against a flat text list.
 *
 * Each snapshot becomes its own group with isFirstOccurrence tracking.
 * The state agent runs per-snapshot to preserve transition event boundaries.
 *
 * Future: augment with Judge-style DOM fingerprinting as a fast pre-filter.
 */

import { getModel } from "./ai-provider.js";
import { createClassifierGraph } from "./graphs/classifier-graph.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const CLASSIFIER_PROMPT = `You classify browser snapshots into semantic states for a state machine.

A "state" is a distinct page or view — identified by its layout and purpose.
- NOT identified by URL alone (SPAs reuse URLs across different views).
- NOT by transient input values (form field contents, search queries, checkboxes).
- Two snapshots of the SAME form page are the SAME state even if the user typed into fields, toggled checkboxes, or opened/closed dropdowns between them.
- A page with a modal overlay or dropdown popup is the SAME state as without it.
- A fundamentally different page layout (list → detail, form → confirmation) is a DIFFERENT state.

You will see a screenshot, URL, and title. You will also see previously discovered states.

Respond with ONLY a JSON object (no markdown, no explanation):
- If it matches an existing state: { "existing_state_id": "s0" }
- If it's a new state: { "state_id": "new", "name": "snake_case_name", "description": "What this state represents", "url_pattern": "/path/{param}", "page_purpose": "short purpose" }

For the FIRST snapshot only, also include: "domain": "category", "domain_description": "1-2 sentence site description"

Field rules:
- name: snake_case semantic name (e.g. "product_list", "checkout_form")
- url_pattern: RFC 6570 URI template. Use {param} for path params, {?param} for query params.
- page_purpose: short phrase for deduplication (e.g. "browse products")`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify snapshots into states and consolidate consecutive duplicates.
 *
 * @param {object} options
 * @param {Array} options.snapshots — snapshot markers from recording
 * @param {Array} options.events — full rrweb event stream
 * @returns {Promise<{ groups: ConsolidatedGroup[], stateCount: number }>}
 */
export async function classifyAndConsolidate({ snapshots, events, onProgress }) {
  let model;
  try {
    model = getModel();
  } catch {
    model = null;
  }
  if (!model) {
    console.warn("[browserwire] classifier: no LLM configured, using passthrough");
    return passthroughClassify(snapshots, events);
  }

  // Run the classifier graph
  const { invoke } = createClassifierGraph({
    model,
    snapshots,
    systemPrompt: CLASSIFIER_PROMPT,
    onProgress,
  });

  const { assignments, knownStates } = await invoke();

  // Build consolidated groups from assignments
  return buildGroups(assignments, knownStates, snapshots, events);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function buildGroups(assignments, knownStates, snapshots, events) {
  const groups = [];
  const firstOccurrences = new Set();

  // Map stateLabel → stateIdentity
  const identityByLabel = new Map();
  for (const s of knownStates) {
    identityByLabel.set(s.id, {
      name: s.name,
      description: s.description,
      url_pattern: s.url_pattern,
      page_purpose: s.page_purpose,
      ...(s.domain ? { domain: s.domain, domainDescription: s.domainDescription } : {}),
    });
  }

  for (let i = 0; i < assignments.length; i++) {
    const { stateLabel } = assignments[i];
    const isFirst = !firstOccurrences.has(stateLabel);
    if (isFirst) firstOccurrences.add(stateLabel);

    groups.push({
      stateLabel,
      stateIdentity: identityByLabel.get(stateLabel) || assignments[i].stateIdentity,
      representative: snapshots[i],
      snapshotIndices: [i],
      eventRange: {
        start: snapshots[i].eventIndex,
        end: i + 1 < snapshots.length ? snapshots[i + 1].eventIndex : events.length,
      },
      isFirstOccurrence: isFirst,
    });
  }

  console.log(
    `[browserwire] classifier: ${snapshots.length} snapshots → ` +
    `${groups.length} groups, ${firstOccurrences.size} unique states`
  );

  return { groups, stateCount: firstOccurrences.size };
}

// ---------------------------------------------------------------------------
// Passthrough fallback
// ---------------------------------------------------------------------------

function passthroughClassify(snapshots, events) {
  const groups = snapshots.map((snapshot, i) => ({
    stateLabel: `s${i}`,
    stateIdentity: {
      name: `state_s${i}`,
      description: `State at ${snapshot.url}`,
      url_pattern: safePathname(snapshot.url),
      page_purpose: snapshot.title || "unknown",
    },
    representative: snapshot,
    snapshotIndices: [i],
    eventRange: {
      start: snapshot.eventIndex,
      end: i + 1 < snapshots.length ? snapshots[i + 1].eventIndex : events.length,
    },
    isFirstOccurrence: true,
  }));

  return { groups, stateCount: groups.length };
}

function safePathname(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}
