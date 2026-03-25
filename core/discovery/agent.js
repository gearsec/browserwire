/**
 * agent.js — Multi-Agent Discovery Orchestrator (LangGraph)
 *
 * A StateGraph that orchestrates a 3-phase pipeline per snapshot:
 *   Phase 1 (PLAN):     Planner subgraph inspects the page and produces a skeleton
 *   Phase 2 (GROUND):   Parallel sub-agents ground each skeleton item with selectors
 *   Phase 3 (ASSEMBLE): Pure code node combines grounded items + skeleton workflows
 *
 * Live objects (index, browser, callbacks) are passed via config.configurable,
 * NOT through state — state is only for serializable data.
 */

import { StateGraph, Annotation, Send, END } from "@langchain/langgraph";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { getModel } from "./ai-provider.js";
import { createIndex } from "./tools/index.js";
import { runPlanner } from "./planner.js";
import { runItemAgent } from "./sub-agents/item-agent.js";
import { runAssembler } from "./assembler.js";

// ---------------------------------------------------------------------------
// State annotation — serializable data only, no live objects
// ---------------------------------------------------------------------------

const DiscoveryAnnotation = Annotation.Root({
  // Phase 1: planner output
  skeleton: Annotation({ reducer: (_, b) => b, default: () => null }),
  plannerToolCalls: Annotation({ reducer: (_, b) => b, default: () => 0 }),

  // Phase 2: fan-out input (set per Send branch)
  currentItem: Annotation({ reducer: (_, b) => b, default: () => null }),

  // Phase 2: collected results (concat reducers for parallel)
  groundedViews: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  groundedEndpoints: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  groundingFailures: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }),
  itemToolCalls: Annotation({ reducer: (a, b) => a + b, default: () => 0 }),

  // Phase 3: output
  manifest: Annotation({ reducer: (_, b) => b, default: () => null }),
  error: Annotation({ reducer: (_, b) => b, default: () => null }),
});

// ---------------------------------------------------------------------------
// Graph nodes — access live objects from config.configurable
// ---------------------------------------------------------------------------

/** Phase 1: Run planner agent */
async function plannerNode(state, config) {
  console.log(`[browserwire-cli] ── Phase 1: PLAN ──`);
  const { index, snapshot, browser, onProgress, sessionId } = config.configurable;

  const result = await runPlanner({ index, snapshot, browser, onProgress, sessionId });

  if (result.error || !result.skeleton) {
    console.error(`[browserwire-cli] planner failed: ${result.error}`);
    return { error: `Planner failed: ${result.error}`, plannerToolCalls: result.toolCallCount };
  }

  const skeleton = result.skeleton;
  console.log(
    `[browserwire-cli]   skeleton: ${skeleton.items.length} items ` +
    `(${skeleton.items.filter(i => i.kind === "view").length} views, ` +
    `${skeleton.items.filter(i => i.kind === "endpoint").length} endpoints, ` +
    `${(skeleton.workflows || []).length} workflows)`
  );

  return { skeleton, plannerToolCalls: result.toolCallCount };
}

/** Phase 2: Ground a single item (runs in parallel via Send) */
async function groundItemNode(state, config) {
  const { index, browser, onProgress, sessionId } = config.configurable;
  const { currentItem } = state;

  const result = await runItemAgent({ item: currentItem, index, browser, onProgress, sessionId });

  if (result.item) {
    console.log(`[browserwire-cli]   ✓ ${currentItem.kind} "${currentItem.name}" grounded`);
    if (result.kind === "view") {
      return { groundedViews: [result.item], itemToolCalls: result.toolCallCount || 0 };
    } else {
      return { groundedEndpoints: [result.item], itemToolCalls: result.toolCallCount || 0 };
    }
  } else {
    console.warn(`[browserwire-cli]   ✗ ${currentItem.kind} "${currentItem.name}" failed: ${result.error}`);
    return {
      groundingFailures: [{ item: currentItem.name, error: result.error }],
      itemToolCalls: result.toolCallCount || 0,
    };
  }
}

/** Phase 3: Assemble final manifest (pure code) */
function assembleNode(state) {
  console.log(`[browserwire-cli] ── Phase 3: ASSEMBLE ──`);
  const { skeleton, groundedViews, groundedEndpoints, groundingFailures } = state;

  if (!skeleton) {
    return { error: state.error || "No skeleton available" };
  }

  console.log(
    `[browserwire-cli]   grounded: ${groundedViews.length} views, ${groundedEndpoints.length} endpoints, ${groundingFailures.length} failures`
  );

  if (groundedViews.length === 0 && groundedEndpoints.length === 0) {
    return { error: `All ${skeleton.items.length} sub-agents failed to ground their items` };
  }

  const result = runAssembler({ skeleton, views: groundedViews, endpoints: groundedEndpoints });

  if (result.error) {
    console.warn(`[browserwire-cli]   assembler warning: ${result.error}`);
  }

  const manifest = result.manifest;
  console.log(`[browserwire-cli] ═══ Multi-Agent Result ════════════════════════`);
  console.log(`[browserwire-cli]   page: "${manifest.page.name}" (${manifest.page.routePattern})`);
  console.log(`[browserwire-cli]   domain: ${manifest.domain}`);
  console.log(`[browserwire-cli]   views: ${manifest.views.length}`);
  console.log(`[browserwire-cli]   endpoints: ${manifest.endpoints.length}`);
  console.log(`[browserwire-cli]   workflows: ${(manifest.workflows || []).length}`);
  console.log(`[browserwire-cli] ═════════════════════════════════════════`);

  return { manifest };
}

// ---------------------------------------------------------------------------
// Conditional edges
// ---------------------------------------------------------------------------

/** After planner: fan-out all items (views + endpoints) to ground_item, or go to assemble on error */
function dispatchToWorkers(state) {
  if (!state.skeleton || state.error) {
    return "assemble";
  }

  console.log(`[browserwire-cli] ── Phase 2: GROUND (${state.skeleton.items.length} sub-agents) ──`);

  return state.skeleton.items.map(
    (item) => new Send("ground_item", { currentItem: item })
  );
}

// ---------------------------------------------------------------------------
// Build and compile graph
// ---------------------------------------------------------------------------

const buildDiscoveryGraph = () => {
  const graph = new StateGraph(DiscoveryAnnotation)
    .addNode("planner", plannerNode)
    .addNode("ground_item", groundItemNode)
    .addNode("assemble", assembleNode)
    .addEdge("__start__", "planner")
    .addConditionalEdges("planner", dispatchToWorkers)
    .addEdge("ground_item", "assemble")
    .addEdge("assemble", END);

  return graph.compile();
};

let _compiledGraph = null;
const getGraph = () => {
  if (!_compiledGraph) _compiledGraph = buildDiscoveryGraph();
  return _compiledGraph;
};

// ---------------------------------------------------------------------------
// Index + Playwright setup (runs before graph invocation)
// ---------------------------------------------------------------------------

async function _buildIndex({ snapshot, browser, sessionId }) {
  const rrwebSnapshot = typeof snapshot.domHtml === "string"
    ? JSON.parse(snapshot.domHtml)
    : snapshot.domHtml;

  const index = createIndex({
    rrwebSnapshot,
    browser,
    screenshot: snapshot.screenshot || null,
    networkLogs: snapshot.networkLog || [],
    url: snapshot.url || "",
    title: snapshot.title || "",
  });

  await index.enrichWithCDP();

  // Write logs (fire-and-forget)
  const snapLogDir = resolve(homedir(), ".browserwire", `logs/session-${sessionId}`);
  const snapName = snapshot.snapshotId || "snap";
  mkdir(snapLogDir, { recursive: true })
    .then(() => Promise.all([
      writeFile(resolve(snapLogDir, `${snapName}-accessibility-tree.txt`), index.toAccessibilityTree(), "utf8"),
      writeFile(resolve(snapLogDir, `${snapName}-rrweb-snapshot.json`), JSON.stringify(rrwebSnapshot, null, 2), "utf8"),
    ]))
    .catch((err) => console.error(`[browserwire-cli] failed to write snapshot logs:`, err));

  // Load into Playwright
  const rrwebSnapshotForPage = typeof snapshot.domHtml === "string"
    ? JSON.parse(snapshot.domHtml) : snapshot.domHtml;
  await browser.loadSnapshot(rrwebSnapshotForPage, snapshot.url);

  return index;
}

// ---------------------------------------------------------------------------
// Main entry point (same interface as before)
// ---------------------------------------------------------------------------

/**
 * Run the multi-agent discovery pipeline on a single snapshot.
 *
 * @param {object} options
 * @param {object} options.snapshot - Raw snapshot payload from the extension
 * @param {import('./snapshot/playwright-browser.js').PlaywrightBrowser} options.browser
 * @param {function} [options.onProgress] - Called with { step, tool } on each agent step
 * @param {string} [options.sessionId]
 * @returns {Promise<{ manifest: object|null, toolCallCount: number, error?: string }>}
 */
export async function runDiscoveryAgent({ snapshot, browser, onProgress, sessionId }) {
  const model = getModel();
  if (!model) {
    return { manifest: null, toolCallCount: 0, error: "No LLM provider configured" };
  }

  // Build index BEFORE graph — live objects go via config, not state
  let index;
  try {
    index = await _buildIndex({ snapshot, browser, sessionId });
  } catch (err) {
    return { manifest: null, toolCallCount: 0, error: `Failed to build snapshot index: ${err.message}` };
  }

  const graph = getGraph();

  // Invoke graph — live objects passed via config.configurable
  const finalState = await graph.invoke(
    {},  // empty initial state — all data flows through the graph
    { configurable: { snapshot, browser, index, onProgress, sessionId } }
  );

  const totalToolCalls = (finalState.plannerToolCalls || 0) +
    (finalState.itemToolCalls || 0);

  if (finalState.error && !finalState.manifest) {
    return { manifest: null, toolCallCount: totalToolCalls, error: finalState.error };
  }

  console.log(`[browserwire-cli]   total tool calls: ${totalToolCalls}`);
  return { manifest: finalState.manifest, toolCallCount: totalToolCalls };
}
