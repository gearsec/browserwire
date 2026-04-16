/**
 * intent-extractor.js — API intent extraction from classified states.
 *
 * Takes classified state groups, loads each snapshot to get screenshots
 * and accessibility trees, then uses the intent graph to decide what
 * REST APIs (views + workflows) the site should expose.
 *
 * This is Pass 2 of the pipeline:
 *   Pass 1: Classifier (state identity)
 *   Pass 2: Intent Extractor (what APIs to build)  ← this
 *   Pass 3: Parallel ReactAgents (build each API)
 *   Pass 4: Assembler (merge into manifest)
 */

import { z } from "zod";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { SnapshotIndex } from "./snapshot/snapshot-index.js";
import { PlaywrightBrowser } from "./snapshot/playwright-browser.js";

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const INTENT_PROMPT = `You are an API product manager. You see screenshots and accessibility trees from pages on a website that a user browsed through.

Decide what REST APIs this site should expose. Two types:

1. **view** (GET): For pages with business data (product lists, details, search results, dashboards, order summaries). Describe precisely what fields to extract.

2. **workflow** (POST): For pages with forms or multi-step interactions (registration, checkout, search + filter, login). Describe the end-to-end flow including what fields the user fills and what they submit.

Rules:
- Each API should be a complete, useful endpoint — not a partial step
- Workflows can span multiple pages (e.g., navigate to form → fill fields → submit)
- Use snake_case for names
- Be precise in descriptions — the implementation agent will use them as specifications
- Don't create APIs for empty/loading states or navigation chrome

Return a JSON array:
[
  { "type": "view", "name": "product_list", "description": "Extract product name, price, rating, image URL, and availability from each product card on the product listing page" },
  { "type": "workflow", "name": "user_registration", "description": "Fill the registration form with name, email, password fields and submit. The form is on the registration page." }
]`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract API intents from classified state groups.
 *
 * @param {object} options
 * @param {Array} options.groups — classified state groups from Pass 1
 * @param {Array} options.events — full rrweb event stream
 * @param {Array} options.snapshots — snapshot markers
 * @returns {Promise<{ intents: Array<{ id: string, type: string, name: string, description: string }> }>}
 */
export async function extractIntents({ groups, events, snapshots, model, log }) {
  const _log = log || { info: (...a) => console.log("[browserwire]", ...a), warn: (...a) => console.warn("[browserwire]", ...a) };

  if (!model) {
    _log.warn("intent extractor: no LLM configured, skipping");
    return { intents: [] };
  }

  _log.info(`intent extractor: building state inputs from ${groups.length} groups`);

  // Build state inputs: load each unique state's snapshot to get screenshot + AX tree
  const seenStates = new Set();
  const stateInputs = [];

  for (const group of groups) {
    // Only process first occurrence of each state
    if (seenStates.has(group.stateLabel)) continue;
    seenStates.add(group.stateLabel);

    const snapshot = group.representative;

    if (!snapshot.rrwebTree) {
      continue;
    }

    // Load snapshot in Playwright to get AX tree
    const browser = new PlaywrightBrowser();
    try {
      await browser.ensureBrowser();
      await browser.loadSnapshot(snapshot.rrwebTree, snapshot.url);

      const index = new SnapshotIndex({
        rrwebSnapshot: snapshot.rrwebTree,
        browser,
        screenshot: snapshot.screenshot || null,
        url: snapshot.url,
        title: snapshot.title,
      });
      await index.enrichWithCDP();

      stateInputs.push({
        label: group.stateLabel,
        name: group.stateIdentity?.name || `state_${group.stateLabel}`,
        description: group.stateIdentity?.description || "",
        screenshot: index.screenshot,
        axTree: index.toAccessibilityTree(),
      });
    } catch (err) {
      _log.warn(`intent extractor: failed to load state ${group.stateLabel}: ${err.message}`);
      // Still include with metadata only
      stateInputs.push({
        label: group.stateLabel,
        name: group.stateIdentity?.name || `state_${group.stateLabel}`,
        description: group.stateIdentity?.description || "",
        screenshot: snapshot.screenshot || null,
        axTree: null,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  }

  _log.info(`intent extractor: ${stateInputs.length} unique states prepared`);

  // Build multimodal message with all states
  const content = [];
  for (const si of stateInputs) {
    if (si.screenshot) {
      content.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${si.screenshot}` },
      });
    }
    content.push({
      type: "text",
      text: [
        `── State: ${si.label} "${si.name}" ──`,
        `Description: ${si.description}`,
        ``,
        `Accessibility tree:`,
        si.axTree || "(not available)",
        ``,
      ].join("\n"),
    });
  }
  content.push({
    type: "text",
    text: "Based on these states, decide what REST APIs to expose. You MUST return at least one API intent per state that contains business data (products, articles, prices, reviews, orders, user info, etc.).",
  });

  const IntentSchema = z.object({
    intents: z.array(z.object({
      type: z.enum(["view", "workflow"]),
      name: z.string(),
      description: z.string(),
    })),
  });

  let intents;
  try {
    const modelWithOutput = model.withStructuredOutput(IntentSchema);
    const result = await modelWithOutput.invoke([
      new SystemMessage(INTENT_PROMPT),
      new HumanMessage({ content }),
    ]);
    intents = Array.isArray(result.intents) ? result.intents : [];
  } catch (err) {
    _log.warn(`intent extractor: LLM error: ${err.message}`);
    intents = [];
  }

  // Normalize and assign IDs
  intents = intents.map((intent, idx) => ({
    id: `intent_${idx}`,
    type: intent.type || "view",
    name: intent.name || `api_${idx}`,
    description: intent.description || "",
  }));

  _log.info(
    `intent extractor: ${intents.length} API intents ` +
    `(${intents.filter((i) => i.type === "view").length} views, ` +
    `${intents.filter((i) => i.type === "workflow").length} workflows)`
  );

  return { intents };
}
