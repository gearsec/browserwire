/**
 * session-processor.js — 5-pass session processing orchestrator.
 *
 * Takes a session recording and processes it through a pipeline:
 *   Pass 0: Segment events + generate snapshots (if not provided)
 *   Pass 1: Classify snapshots into states (state-classifier)
 *   Pass 2: Extract API intents from states (intent-extractor)
 *   Pass 3: Run parallel react agents — one per intent
 *   Pass 4: Assemble manifest from all agent results
 *
 * The orchestrator handles all manifest mutations deterministically.
 * Agents produce views/actions independently; the assembler merges them.
 */

import { SnapshotIndex } from "./snapshot/snapshot-index.js";
import { PlaywrightBrowser } from "./snapshot/playwright-browser.js";
import { StateMachineManifest } from "../manifest/manifest.js";
import { EventType } from "../recording/rrweb-constants.js";
import { runStateAgent } from "./state-agent.js";
import { initTelemetry } from "../telemetry.js";
import { classifyAndConsolidate } from "./state-classifier.js";
import { extractIntents } from "./intent-extractor.js";
import { segmentEvents } from "../recording/segment.js";
import { generateSnapshots } from "../recording/replay-screenshots.js";

/**
 * Process a session recording into a StateMachineManifest.
 *
 * @param {object} options
 * @param {object} options.recording — validated session recording
 * @param {function} [options.onProgress] — called with { phase, detail } on progress
 * @param {string} [options.sessionId]
 * @returns {Promise<{ manifest: object|null, error?: string, totalToolCalls: number }>}
 */
export async function processRecording({ recording, onProgress, sessionId }) {
  await initTelemetry();

  const { events } = recording;
  let { snapshots } = recording;

  // ── Pass 0: Segment events + generate snapshots (if not provided) ──
  if (!snapshots || snapshots.length === 0) {
    console.log(`[browserwire] ── Pass 0: Segmentation + Snapshot Generation ──`);

    const { triggers, snapshots: segments } = segmentEvents(events);
    console.log(`[browserwire]   ${triggers.length} triggers detected, ${segments.length} snapshot boundaries`);

    if (onProgress) onProgress({ phase: "segmentation", tool: `Segmented: ${triggers.length} triggers → ${segments.length} snapshots` });

    snapshots = await generateSnapshots(events, segments);
    console.log(`[browserwire]   ${snapshots.length} snapshots generated via replay`);

    if (onProgress) onProgress({ phase: "segmentation", tool: `Generated ${snapshots.length} snapshots` });
  }

  if (!snapshots || snapshots.length === 0) {
    console.warn("[browserwire] no snapshots available, cannot process");
    return { manifest: null, error: "No snapshots", totalToolCalls: 0 };
  }

  console.log(
    `[browserwire] processing session: ${snapshots.length} snapshots, ${events.length} events`
  );

  // ── Pass 1: Classify snapshots into states ──
  console.log(`[browserwire] ── Pass 1: Classification ──`);
  const { groups } = await classifyAndConsolidate({ snapshots, events });
  const consolidatedSnapshots = groups.map((g) => g.representative);

  // ── Pass 2: Extract API intents ──
  console.log(`[browserwire] ── Pass 2: Intent Extraction ──`);
  const { intents } = await extractIntents({ groups, events, snapshots: consolidatedSnapshots });

  if (intents.length === 0) {
    console.warn("[browserwire] no intents extracted, auto-generating one view intent per unique state");
    const seenLabels = new Set();
    for (const group of groups) {
      if (seenLabels.has(group.stateLabel)) continue;
      seenLabels.add(group.stateLabel);
      intents.push({
        id: `intent_auto_${intents.length}`,
        type: "view",
        name: group.stateIdentity?.name || `state_${group.stateLabel}`,
        description: `Extract all business data from the ${group.stateIdentity?.name || group.stateLabel} page`,
      });
    }
  }

  console.log(`[browserwire] ── Pass 3: Parallel Agent Execution (${intents.length} intents) ──`);

  // ── Pass 3: Run parallel react agents — one per intent ──
  let totalToolCalls = 0;

  const agentResults = await Promise.all(
    intents.map(async (intent, intentIdx) => {
      console.log(`[browserwire]   launching agent for intent: ${intent.name} (${intent.type})`);

      try {
        const result = await runIntentAgent({
          intent,
          groups,
          events,
          consolidatedSnapshots,
          onProgress: ({ tool }) => {
            if (onProgress) onProgress({ phase: "extraction", intent: intent.name, tool });
          },
          sessionId,
        });

        console.log(
          `[browserwire]   intent "${intent.name}" done: ` +
          `${result.pendingViews?.length || 0} views, ${result.pendingActions?.length || 0} actions`
        );

        return { intent, ...result };
      } catch (err) {
        console.warn(`[browserwire]   intent "${intent.name}" error: ${err.message}`);
        return { intent, error: err.message, pendingViews: [], pendingActions: [], toolCallCount: 0 };
      }
    })
  );

  for (const r of agentResults) {
    totalToolCalls += r.toolCallCount || 0;
  }

  // ── Pass 4: Assemble manifest ──
  console.log(`[browserwire] ── Pass 4: Assembly ──`);
  const manifest = assembleManifest({ groups, agentResults });
  const manifestJson = manifest.toJSON();

  console.log(
    `[browserwire] session processing complete: ` +
    `${manifest.getStates().length} states, ${totalToolCalls} total tool calls`
  );

  return { manifest: manifestJson, totalToolCalls };
}

// ---------------------------------------------------------------------------
// Pass 3: Run a react agent for a single intent
// ---------------------------------------------------------------------------

/**
 * Run a react agent scoped to a single API intent.
 * The agent gets ALL snapshots and processes the full recording end-to-end.
 */
async function runIntentAgent({ intent, groups, events, consolidatedSnapshots, onProgress, sessionId }) {
  // Find the best snapshot to start with — use the first group's snapshot
  // (the agent will navigate through all of them)
  const firstGroup = groups[0];
  const snapshot = firstGroup.representative;

  const rrwebTree = snapshot.rrwebTree;
  if (!rrwebTree) {
    return { error: "Snapshot has no rrwebTree", pendingViews: [], pendingActions: [], toolCallCount: 0 };
  }

  const browser = new PlaywrightBrowser();
  try {
    await browser.ensureBrowser();
    await browser.loadSnapshot(rrwebTree, snapshot.url);

    const index = new SnapshotIndex({
      rrwebSnapshot: rrwebTree,
      browser,
      screenshot: snapshot.screenshot || null,
      url: snapshot.url,
      title: snapshot.title,
    });
    await index.enrichWithCDP();

    const agentResult = await runStateAgent({
      index,
      browser,
      manifest: new StateMachineManifest(), // fresh — agents don't share manifest
      events,
      snapshots: consolidatedSnapshots,
      currentSnapshotIndex: 0,
      isExistingState: false,
      stateInfo: firstGroup.stateIdentity,
      intent,
      groups,
      onProgress,
      sessionId,
    });

    return agentResult;
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pass 4: Assemble manifest from parallel agent results
// ---------------------------------------------------------------------------

/**
 * Assemble a manifest from classifier groups + parallel agent results.
 *
 * Creates states from classifier identity, then merges each agent's
 * views and actions into the appropriate states. Deduplicates actions
 * by name within each state.
 */
function assembleManifest({ groups, agentResults }) {
  const manifest = new StateMachineManifest();
  const labelToManifestId = new Map();

  // 1. Create states from classifier groups (first occurrences only)
  let prevStateId = null;
  for (const group of groups) {
    if (!group.isFirstOccurrence || !group.stateIdentity) continue;

    const { name, description, url_pattern, page_purpose, domain, domainDescription } = group.stateIdentity;

    if (domain && !manifest.domain) {
      manifest.domain = domain;
      manifest.domainDescription = domainDescription || null;
    }

    const stateId = manifest.addState({
      name,
      description,
      url_pattern,
      signature: { page_purpose, views: [], actions: [] },
      views: [],
      actions: [],
    });

    labelToManifestId.set(group.stateLabel, stateId);

    if (manifest.initial_state === null) {
      manifest.initial_state = stateId;
    }
  }

  // 2. Merge agent results into states
  for (const result of agentResults) {
    if (result.error && !result.pendingViews?.length && !result.pendingActions?.length) continue;

    const intentName = result.intent?.name;

    // Merge views — try to find the best matching state
    for (const view of result.pendingViews || []) {
      const targetStateId = findBestState(view, groups, labelToManifestId, manifest, intentName);
      if (targetStateId) {
        const state = manifest.getStates().find((s) => s.id === targetStateId);
        if (state && !state.views.some((v) => v.name === view.name)) {
          state.views.push(view);
          state.signature.views.push(view.name);
        }
      }
    }

    // Merge actions
    for (const action of result.pendingActions || []) {
      const targetStateId = findBestState(action, groups, labelToManifestId, manifest, intentName);
      if (targetStateId) {
        manifest.mergeActions(targetStateId, [action]);
        const state = manifest.getStates().find((s) => s.id === targetStateId);
        if (state && !state.signature.actions.includes(action.name)) {
          state.signature.actions.push(action.name);
        }
      }
    }
  }

  // 3. Wire leads_to edges from action sequence (based on group ordering)
  wireEdgesFromGroups(manifest, groups, labelToManifestId);

  return manifest;
}

/**
 * Find the best manifest state for a view or action.
 * Uses the _snapshotIndex tag to resolve which classifier group (and thus
 * which manifest state) the item was extracted from. Falls back to matching
 * the intent name against state names.
 */
function findBestState(item, groups, labelToManifestId, manifest, intentName) {
  // 1. Resolve from snapshot index → classifier group → manifest state
  if (item._snapshotIndex !== undefined && item._snapshotIndex < groups.length) {
    const stateLabel = groups[item._snapshotIndex].stateLabel;
    if (labelToManifestId.has(stateLabel)) {
      return labelToManifestId.get(stateLabel);
    }
  }

  // 2. Fallback: match intent name against state names
  if (intentName) {
    const states = manifest.getStates();
    const match = states.find((s) => s.name === intentName);
    if (match) return match.id;
  }

  // 3. Last resort: first state
  const states = manifest.getStates();
  return states.length > 0 ? states[0].id : null;
}

/**
 * Wire leads_to edges based on the order groups appear in the recording.
 * For consecutive groups with different states, if the source state has
 * an action that could transition, link it.
 */
function wireEdgesFromGroups(manifest, groups, labelToManifestId) {
  for (let i = 0; i < groups.length - 1; i++) {
    const fromLabel = groups[i].stateLabel;
    const toLabel = groups[i + 1].stateLabel;
    if (fromLabel === toLabel) continue;

    const fromStateId = labelToManifestId.get(fromLabel);
    const toStateId = labelToManifestId.get(toLabel);
    if (!fromStateId || !toStateId) continue;

    const fromState = manifest.getStates().find((s) => s.id === fromStateId);
    if (!fromState) continue;

    // Find the first action without a leads_to on the source state and wire it
    for (const action of fromState.actions || []) {
      if (!action.leads_to) {
        manifest.setLeadsTo(fromStateId, action.name, toStateId);
        console.log(`[browserwire]   → linked ${fromStateId}.${action.name} → ${toStateId}`);
        break;
      }
    }
  }
}

