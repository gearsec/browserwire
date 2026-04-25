/**
 * classifier-graph.js — LangGraph graph for snapshot state classification.
 *
 * A sequential loop that processes one snapshot per iteration:
 *   classify → [shouldContinue] → classify (loop)
 *                                → __end__ (all done)
 *
 * Each iteration adds the snapshot's screenshot to the conversation history,
 * so the model can visually compare the current snapshot against all prior
 * snapshots — not just a flat text list of state names.
 *
 * No tools needed — single LLM call per snapshot.
 */

import { z } from "zod";
import { StateGraph, Annotation, messagesStateReducer, END } from "@langchain/langgraph";
import { SystemMessage, HumanMessage, AIMessage } from "@langchain/core/messages";

const ClassifyResultSchema = z.object({
  existing_state_id: z.string().optional().describe("ID of existing state if this snapshot matches one"),
  state_id: z.enum(["new"]).optional().describe("Set to 'new' if this is a new state"),
  name: z.string().describe(
    "Descriptive snake_case name reflecting the page's purpose, e.g. 'product_listing', 'user_login', 'order_confirmation'. Never use generic names like 'state_0' or 'page_1'."
  ),
  description: z.string().optional().describe("Human-readable description of what this state represents"),
  url_pattern: z.string().optional().describe("RFC 6570 URI template"),
  page_purpose: z.string().optional().describe("Short verb phrase, e.g. 'browse products', 'complete checkout'"),
  domain: z.string().optional().describe("Site domain category (first snapshot only)"),
  domain_description: z.string().optional().describe("Site description (first snapshot only)"),
});

// ---------------------------------------------------------------------------
// State annotation
// ---------------------------------------------------------------------------

const ClassifierAnnotation = Annotation.Root({
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  snapshotIndex: Annotation({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  // Accumulated results — append-style reducers
  knownStates: Annotation({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  assignments: Annotation({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a compiled classifier graph.
 *
 * @param {object} options
 * @param {import('@langchain/core/language_models/chat_models').BaseChatModel} options.model
 * @param {Array} options.snapshots — snapshot markers with screenshot, url, title
 * @param {string} options.systemPrompt
 * @param {function} [options.onProgress] — called with { snapshot } per iteration
 * @param {Array} [options.existingStates] — states from a prior manifest to pre-seed the classifier
 * @returns {{ graph, invoke: () => Promise<{ assignments, knownStates }> }}
 */
export function createClassifierGraph({
  model,
  snapshots,
  systemPrompt,
  onProgress,
  log,
  existingStates,
}) {
  const _log = log || { info: (...a) => console.log("[browserwire]", ...a), warn: (...a) => console.warn("[browserwire]", ...a) };
  let nextStateNum = 0;

  // Pre-seed known states from existing manifest for incremental updates
  const seedStates = [];
  if (existingStates?.length) {
    for (const state of existingStates) {
      seedStates.push({
        id: state.id,
        name: state.name,
        description: state.description,
        url_pattern: state.url_pattern,
        page_purpose: state.signature?.page_purpose || "",
        url: state.url_pattern || "",
      });
      // Keep nextStateNum ahead of existing IDs to avoid collisions
      const num = parseInt(state.id.replace(/^s/, ""), 10);
      if (!isNaN(num) && num >= nextStateNum) nextStateNum = num + 1;
    }
    _log.info(`classifier: seeded ${seedStates.length} existing states, nextStateNum=${nextStateNum}`);
  }

  // --- Classify node: process one snapshot per invocation ---
  const classifyNode = async (state) => {
    const i = state.snapshotIndex;
    if (i >= snapshots.length) return {};

    const snapshot = snapshots[i];

    // Build known-states summary from accumulated results
    const statesSoFar = [...(state.knownStates || [])];
    const stateListText = statesSoFar.length === 0
      ? "No states discovered yet. This is the first snapshot."
      : statesSoFar.map((s) =>
          `- ${s.id}: "${s.name}" — ${s.description} (purpose: ${s.page_purpose}, url: ${s.url || "unknown"})`
        ).join("\n");

    // Build multimodal human message
    const content = [];
    if (snapshot.screenshot) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${snapshot.screenshot}` },
      });
    }
    content.push({
      type: "text",
      text: [
        `Snapshot #${i + 1} of ${snapshots.length}`,
        `URL: ${snapshot.url}`,
        `Title: ${snapshot.title}`,
        ``,
        `Known states:`,
        stateListText,
        ``,
        `Classify this snapshot. Return JSON only.`,
      ].join("\n"),
    });

    const humanMsg = new HumanMessage({ content });

    // Compact: strip images from older messages, keep only the current screenshot
    const compactedMessages = state.messages.map((msg) => {
      if (msg._getType?.() !== "human") return msg;
      if (!Array.isArray(msg.content)) return msg;
      const hasImage = msg.content.some((c) => c.type === "image_url");
      if (!hasImage) return msg;
      return new HumanMessage({
        content: msg.content.map((c) =>
          c.type === "image_url" ? { type: "text", text: "[screenshot — see classification above]" } : c
        ),
      });
    });

    // Invoke model with structured output + raw response for conversation history
    let json;
    let response;
    const modelWithOutput = model.withStructuredOutput(ClassifyResultSchema, { includeRaw: true });

    _log.info(`classifier: classifying snapshot ${i + 1}/${snapshots.length}...`);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await modelWithOutput.invoke([...compactedMessages, humanMsg], {
          signal: AbortSignal.timeout(180_000),
        });
        json = result.parsed;
        response = result.raw;
        break;
      } catch (err) {
        if (attempt === 0) {
          _log.warn(`classifier graph: LLM error on snapshot ${i + 1}, retrying: ${err.message}`);
          continue;
        }
        _log.warn(`classifier graph: LLM error on snapshot ${i + 1} after retry: ${err.message}`);
        json = null;
        response = new AIMessage(JSON.stringify({
          state_id: "new",
          name: `state_s${nextStateNum}`,
          description: `State at ${snapshot.url}`,
          url_pattern: safePathname(snapshot.url),
          page_purpose: snapshot.title || "unknown",
        }));
      }
    }

    // Build assignment from structured result
    let assignment;
    const newStates = [];

    if (!json || json instanceof Error) {
      // Fallback for parse failure
      const stateId = `s${nextStateNum++}`;
      const identity = {
        name: `state_${stateId}`,
        description: `State at ${snapshot.url}`,
        url_pattern: safePathname(snapshot.url),
        page_purpose: snapshot.title || "unknown",
      };
      newStates.push({ id: stateId, ...identity, url: snapshot.url });
      assignment = { stateLabel: stateId, stateIdentity: identity, isNew: true };
    } else if (json.existing_state_id) {
      assignment = {
        stateLabel: json.existing_state_id,
        stateIdentity: null,
        isNew: false,
      };
    } else {
      const stateId = `s${nextStateNum++}`;
      const identity = {
        name: json.name || `state_${stateId}`,
        description: json.description || "",
        url_pattern: json.url_pattern || snapshot.url,
        page_purpose: json.page_purpose || "",
        ...(json.domain ? { domain: json.domain, domainDescription: json.domain_description || "" } : {}),
      };
      newStates.push({ id: stateId, ...identity, url: snapshot.url });
      assignment = { stateLabel: stateId, stateIdentity: identity, isNew: true };
    }

    if (onProgress) onProgress({ snapshot: i + 1 });

    _log.info(
      `classifier: snapshot ${i + 1}/${snapshots.length} → ` +
      (assignment.isNew
        ? `new state "${assignment.stateIdentity?.name}"`
        : `existing ${assignment.stateLabel}`)
    );

    // Use a clean AIMessage for history — the raw response from withStructuredOutput
    // contains tool_use blocks that would cause errors in subsequent iterations.
    const cleanResponse = new AIMessage(JSON.stringify(json || {}));

    return {
      messages: [humanMsg, cleanResponse],
      snapshotIndex: i + 1,
      knownStates: newStates,
      assignments: [assignment],
    };
  };

  // --- Conditional edge: loop or finish ---
  const shouldContinue = (state) => {
    return state.snapshotIndex >= snapshots.length ? END : "classify";
  };

  // --- Build graph ---
  const graph = new StateGraph(ClassifierAnnotation)
    .addNode("classify", classifyNode)
    .addEdge("__start__", "classify")
    .addConditionalEdges("classify", shouldContinue)
    .compile();

  // --- Convenience invoke ---
  const invoke = async () => {
    const initialState = { messages: [new SystemMessage(systemPrompt)] };
    if (seedStates.length > 0) {
      initialState.knownStates = seedStates;
    }
    const finalState = await graph.invoke(
      initialState,
      {
        recursionLimit: snapshots.length * 2 + 5,
        runName: "browserwire:classifier",
        tags: ["pass:1", "classifier"],
        metadata: { snapshotCount: snapshots.length },
      },
    );

    return {
      assignments: finalState.assignments,
      knownStates: finalState.knownStates,
    };
  };

  return { graph, invoke };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safePathname(url) {
  try { return new URL(url).pathname; }
  catch { return url; }
}
