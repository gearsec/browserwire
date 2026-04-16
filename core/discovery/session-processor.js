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
import { runAgent, runViewAgent } from "./state-agent.js";
import { resolveTransitionRefs } from "./tools-v2/transition.js";
import { classifyAndConsolidate } from "./state-classifier.js";
import { extractIntents } from "./intent-extractor.js";
import { segmentEvents } from "../recording/segment.js";
import { generateSnapshots } from "../recording/replay-screenshots.js";
import { z } from "zod";
import { getBrowserLimiter } from "./concurrency.js";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
/**
 * Process a session recording into a StateMachineManifest.
 *
 * @param {object} options
 * @param {object} options.recording — validated session recording
 * @param {object} options.model — LangChain ChatModel instance
 * @param {function} [options.onProgress] — called with { phase, detail } on progress
 * @param {string} [options.sessionId]
 * @returns {Promise<{ manifest: object|null, error?: string, totalToolCalls: number }>}
 */
export async function processRecording({ recording, model, onProgress, sessionId, log }) {
  // Fallback logger for standalone/CLI usage
  if (!log) {
    log = { info: (...a) => console.log("[browserwire]", ...a), warn: (...a) => console.warn("[browserwire]", ...a), error: (...a) => console.error("[browserwire]", ...a) };
  }

  const { events } = recording;
  let { snapshots } = recording;
  let precomputedTransitions = null;

  // ── Pass 0: Segment events + generate snapshots (if not provided) ──
  if (!snapshots || snapshots.length === 0) {
    log.info("── Pass 0: Segmentation + Snapshot Generation ──");

    const { triggers, snapshots: segments, transitions } = segmentEvents(events);
    precomputedTransitions = transitions;
    log.info(`${triggers.length} triggers detected, ${segments.length} snapshot boundaries, ${transitions.length} transitions`);

    if (onProgress) onProgress({ phase: "segmentation", tool: `Segmented: ${triggers.length} triggers → ${segments.length} snapshots` });

    snapshots = await generateSnapshots(events, segments);
    log.info(`${snapshots.length} snapshots generated via replay`);

    if (onProgress) onProgress({ phase: "segmentation", tool: `Generated ${snapshots.length} snapshots` });

    // Emit segmentation data so the UI can show it during training
    if (onProgress) await onProgress({ phase: "segmentation-complete", segmentation: { snapshots: segments, transitions: precomputedTransitions } });
  }

  if (!snapshots || snapshots.length === 0) {
    log.warn("no snapshots available, cannot process");
    return { manifest: null, error: "No snapshots", totalToolCalls: 0, segmentation: null };
  }

  log.info(`processing session: ${snapshots.length} snapshots, ${events.length} events`);

  // ── Pass 1: Classify snapshots into states ──
  log.info("── Pass 1: Classification ──");
  const { groups } = await classifyAndConsolidate({
    snapshots,
    events,
    model,
    log,
    onProgress: onProgress ? ({ snapshot }) => onProgress({ phase: "classification", tool: `Classifying snapshot ${snapshot}/${snapshots.length}` }) : undefined,
  });
  const consolidatedSnapshots = groups.map((g) => g.representative);

  // Emit segmentation with state labels as soon as classifier is done
  if (onProgress && precomputedTransitions) {
    await onProgress({ phase: "segmentation-complete", segmentation: {
      snapshotCount: consolidatedSnapshots.length,
      snapshots: consolidatedSnapshots.map((s, idx) => ({
        snapshotId: s.snapshotId,
        eventIndex: s.eventIndex,
        trigger: s.trigger || null,
        stateLabel: idx < groups.length ? groups[idx].stateLabel : null,
        stateName: idx < groups.length ? (groups[idx].stateIdentity?.name || null) : null,
      })),
      transitions: precomputedTransitions,
    }});
  }

  // ── Pass 2: Extract API intents ──
  log.info("── Pass 2: Intent Extraction ──");
  const { intents } = await extractIntents({ groups, events, snapshots: consolidatedSnapshots, model, log });

  if (intents.length === 0) {
    log.warn("no intents extracted, auto-generating one view intent per unique state");
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

  // Split intents by type
  const viewIntents = intents.filter((i) => i.type === "view");
  const workflowIntents = intents.filter((i) => i.type === "workflow");

  // ── Pass 2.5: Detect transitions ──
  const transitionSpecs = detectTransitions(consolidatedSnapshots, groups, precomputedTransitions);
  log.info(`── Pass 2.5: Transition Detection (${transitionSpecs.length} actionable transitions) ──`);

  log.info(`── Pass 3: Agent Execution (${viewIntents.length} views, ${transitionSpecs.length} transitions) ──`);

  let totalToolCalls = 0;
  const limit = getBrowserLimiter();

  // ── Pass 3: Parallel view + transition agents ──
  const [viewResults, transitionResults] = await Promise.all([
    // View agents — one per view intent
    Promise.all(
      viewIntents.map((intent) => limit(async () => {
        log.info(`launching view agent: ${intent.name}`);
        try {
          const targetGroup = groups.find((g) => g.isFirstOccurrence && g.stateIdentity?.name === intent.name)
            || groups.find((g) => g.isFirstOccurrence)
            || groups[0];
          const snapshot = targetGroup.representative;
          const snapshotIdx = groups.indexOf(targetGroup);

          if (!snapshot?.rrwebTree) {
            return { intent, error: "No rrwebTree", pendingViews: [], pendingActions: [], toolCallCount: 0 };
          }

          const browser = new PlaywrightBrowser();
          try {
            await browser.ensureBrowser();

            const index = new SnapshotIndex({
              rrwebSnapshot: snapshot.rrwebTree,
              browser,
              screenshot: snapshot.screenshot || null,
              url: snapshot.url,
              title: snapshot.title,
            });
            await index.enrichWithCDP();

            const result = await runViewAgent({
              index,
              browser,
              events,
              snapshots: consolidatedSnapshots,
              snapshotIndex: snapshotIdx,
              stateInfo: targetGroup.stateIdentity,
              intent,
              model,
              onProgress: ({ tool }) => {
                if (onProgress) onProgress({ phase: "extraction", intent: intent.name, tool });
              },
              sessionId,
            });

            for (const view of result.pendingViews || []) {
              view._snapshotIndex = snapshotIdx;
            }

            log.info(`view "${intent.name}" done: ${result.pendingViews?.length || 0} views`);
            return { intent, pendingViews: result.pendingViews, pendingActions: [], toolCallCount: result.toolCallCount };
          } finally {
            await browser.close().catch(() => {});
          }
        } catch (err) {
          log.warn(`view "${intent.name}" error: ${err.message}`);
          return { intent, error: err.message, pendingViews: [], pendingActions: [], toolCallCount: 0 };
        }
      }))
    ),
    // Transition agents — one per detected transition, concurrency-limited
    Promise.all(
      transitionSpecs.map((spec) => limit(async () => {
        log.info(`launching transition agent: #${spec.index + 1}→#${spec.index + 2}`);
        return runSingleTransition({
          spec,
          events,
          snapshots: consolidatedSnapshots,
          model,
          onProgress: ({ tool }) => {
            if (onProgress) onProgress({ phase: "extraction", intent: `transition_${spec.index + 1}`, tool });
          },
          sessionId,
        });
      }))
    ),
  ]);

  // Collect atomic actions in snapshot order (Promise.all preserves input order)
  const allActions = transitionResults.map((r) => r.action);
  const transitionToolCalls = transitionResults.reduce((s, r) => s + (r.toolCallCount || 0), 0);

  const agentResults = [...viewResults];

  // ── Pass 3.5: Workflow assembly — one LLM agent per workflow intent ──
  if (workflowIntents.length > 0 && allActions.length > 0) {
    log.info(`── Pass 3.5: Workflow Assembly (${workflowIntents.length} workflows, ${allActions.length} actions) ──`);

    const workflowAssignments = await Promise.all(
      workflowIntents.map((intent) => runWorkflowAssemblyAgent({ actions: allActions, intent, model }))
    );

    const claimedIndices = new Set();

    for (let w = 0; w < workflowIntents.length; w++) {
      const assignment = workflowAssignments[w];
      const workflowActions = assignment.selected_actions
        .filter((idx) => idx >= 0 && idx < allActions.length)
        .map((idx) => {
          claimedIndices.add(idx);
          return { ...allActions[idx] };
        });

      // Sort by snapshot order — deterministic regardless of LLM return order
      workflowActions.sort((a, b) => a._snapshotIndex - b._snapshotIndex);

      if (workflowActions.length > 0) {
        const workflowName = assignment.workflow_name || workflowIntents[w].name;
        const formGroupName = workflowName.replace(/\s+/g, "_").toLowerCase();
        for (let j = 0; j < workflowActions.length; j++) {
          workflowActions[j].form_group = formGroupName;
          workflowActions[j].sequence_order = j;
        }
        // Detect form pattern: inputs + final click = form_submit
        const hasInputs = workflowActions.some((a) => a.kind === "input");
        const lastAction = workflowActions[workflowActions.length - 1];
        if (hasInputs && lastAction.kind === "click") {
          lastAction.kind = "form_submit";
        }
      }

      log.info(`workflow "${assignment.workflow_name}": ${workflowActions.length} actions`);
      agentResults.push({
        intent: workflowIntents[w],
        pendingViews: [],
        pendingActions: workflowActions,
        toolCallCount: 0,
      });
    }

    // Unclaimed actions kept as standalone
    const unclaimedActions = allActions.filter((_, idx) => !claimedIndices.has(idx));
    if (unclaimedActions.length > 0) {
      assignFormGroups(unclaimedActions, groups);
      agentResults.push({
        intent: { name: "standalone_actions", type: "workflow" },
        pendingViews: [],
        pendingActions: unclaimedActions,
        toolCallCount: 0,
      });
      log.info(`standalone actions: ${unclaimedActions.length}`);
    }
  } else if (allActions.length > 0) {
    // No workflow intents — all actions are standalone
    assignFormGroups(allActions, groups);
    agentResults.push({
      intent: { name: "standalone_actions", type: "workflow" },
      pendingViews: [],
      pendingActions: allActions,
      toolCallCount: 0,
    });
  }

  for (const r of agentResults) {
    totalToolCalls += r.toolCallCount || 0;
  }
  totalToolCalls += transitionToolCalls;

  // ── Pass 4: Assemble manifest ──
  log.info("── Pass 4: Assembly ──");
  const manifest = assembleManifest({ groups, agentResults });
  const manifestJson = manifest.toJSON();

  log.info(`session processing complete: ${manifest.getStates().length} states, ${totalToolCalls} total tool calls`);

  // Build segmentation data for persistence
  const segmentation = precomputedTransitions ? {
    snapshotCount: consolidatedSnapshots.length,
    snapshots: consolidatedSnapshots.map((s, idx) => ({
      snapshotId: s.snapshotId,
      eventIndex: s.eventIndex,
      trigger: s.trigger || null,
      stateLabel: idx < groups.length ? groups[idx].stateLabel : null,
      stateName: idx < groups.length ? (groups[idx].stateIdentity?.name || null) : null,
    })),
    transitions: precomputedTransitions,
  } : null;

  // Emit final segmentation (with stateLabel/stateName from classifier)
  if (onProgress && segmentation) {
    await onProgress({ phase: "segmentation-complete", segmentation });
  }

  return { manifest: manifestJson, totalToolCalls, segmentation };
}

// ---------------------------------------------------------------------------
// Pass 2.5: Transition detection (pure, no I/O)
// ---------------------------------------------------------------------------

/** Trigger kinds that correspond to API-relevant actions */
const ACTION_TRIGGERS = new Set(["click", "dblclick", "touch", "type", "navigation"]);

/**
 * Scan snapshot pairs and return specs for actionable transitions.
 * Pure function — no browser, no LLM, no I/O.
 *
 * @param {Array} snapshots
 * @param {Array} groups — classifier groups
 * @returns {Array<{ index: number, triggerKind: string, stateInfo: object|null }>}
 */
export function detectTransitions(snapshots, groups, precomputedTransitions) {
  const specs = [];
  for (let i = 0; i < snapshots.length - 1; i++) {
    const nextSnapshot = snapshots[i + 1];
    const triggerKind = nextSnapshot.trigger?.kind;
    if (!triggerKind || !ACTION_TRIGGERS.has(triggerKind)) continue;
    const group = i < groups.length ? groups[i] : null;

    // Attach pre-computed transition data (interaction events + event range)
    const transitionData = precomputedTransitions?.[i] || null;

    specs.push({
      index: i,
      triggerKind,
      stateInfo: group?.stateIdentity || null,
      eventRange: transitionData?.eventRange || {
        start: snapshots[i].eventIndex + 1,
        end: snapshots[i + 1].eventIndex,
      },
      transitionData,
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Pass 3b: Single transition agent (self-contained, parallel-safe)
// ---------------------------------------------------------------------------

/**
 * Build a failed action marker when the transition agent can't produce code.
 * Ensures every segmentation transition is represented in the manifest.
 */
function buildFailedAction(spec, reason) {
  const { index: i, triggerKind } = spec;
  console.warn(`[browserwire] transition #${i + 1} failed: ${reason}`);
  return {
    name: `${triggerKind}_transition_${i + 1}`,
    kind: triggerKind === "type" ? "input" : "click",
    description: `Transition #${i + 1} (${triggerKind})`,
    inputs: [],
    code: null,
    _snapshotIndex: i,
    _triggerKind: triggerKind,
    _stateInfo: spec.stateInfo,
    _failed: true,
    _failReason: reason,
  };
}

/**
 * Run one transition agent for a single snapshot transition.
 * Owns its own browser lifecycle — safe for parallel execution.
 *
 * @param {object} options
 * @param {object} options.spec — { index, triggerKind, stateInfo }
 * @param {Array} options.events — full rrweb event stream
 * @param {Array} options.snapshots — snapshot markers
 * @param {function} [options.onProgress]
 * @param {string} [options.sessionId]
 * @returns {Promise<{ action: object, toolCallCount: number }>}
 */
async function runSingleTransition({ spec, events, snapshots, model, onProgress, sessionId }) {
  const { index: i, triggerKind } = spec;
  const snapshot = snapshots[i];
  const nextSnapshot = snapshots[i + 1];

  if (!snapshot.rrwebTree) {
    return { action: buildFailedAction(spec, "no_rrweb_tree"), toolCallCount: 0 };
  }

  const browser = new PlaywrightBrowser();
  try {
    await browser.ensureBrowser();

    const index = new SnapshotIndex({
      rrwebSnapshot: snapshot.rrwebTree,
      browser,
      screenshot: snapshot.screenshot || null,
      url: snapshot.url,
      title: snapshot.title,
    });
    await index.enrichWithCDP();

    // Resolve refs on pre-computed interaction events
    const rawEvents = spec.transitionData?.interactionEvents || [];
    const transitionEvents = resolveTransitionRefs(rawEvents, index);

    if (transitionEvents.length === 0) {
      return { action: buildFailedAction(spec, "no_resolved_events"), toolCallCount: 0 };
    }

    console.log(`[browserwire] transition #${i + 1}→#${i + 2} (${triggerKind}): ${transitionEvents.length} events`);

    const result = await runAgent({
      index,
      browser,
      events,
      snapshots,
      snapshotIndex: i,
      transitionEvents,
      stateInfo: spec.stateInfo,
      eventRange: spec.eventRange,
      transitionData: spec.transitionData,
      model,
      onProgress,
      sessionId,
    });

    if (!result.code) {
      return { action: buildFailedAction(spec, "agent_no_code"), toolCallCount: result.toolCallCount };
    }

    return {
      action: {
        name: result.name || `action_${i + 1}_${triggerKind}`,
        kind: triggerKind === "type" ? "input" : "click",
        description: result.description || `Transition #${i + 1}→#${i + 2} (${triggerKind})`,
        inputs: result.inputs || [],
        code: result.code,
        _snapshotIndex: i,
        _triggerKind: triggerKind,
        _stateInfo: spec.stateInfo,
      },
      toolCallCount: result.toolCallCount,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Pass 3.5: Workflow assembly agent (LLM classifier, no browser)
// ---------------------------------------------------------------------------

const WORKFLOW_ASSEMBLY_PROMPT = `You are an API workflow assembler. Given a list of atomic user actions extracted from a browser recording and a workflow intent, select which actions belong to this workflow.

Each action has:
- index: position in the list
- name: auto-generated name
- kind: "click" or "input"
- inputs: parameter definitions (name, type)
- state: which page/state the action occurs on
- trigger: what user interaction caused it

The workflow intent describes what the workflow should accomplish (e.g., "user registration", "product search").

Select the actions that are part of this workflow. Actions should form a logical sequence that accomplishes the workflow's goal.

Return a JSON object with:
- selected_actions: array of action indices (0-based) from the provided list
- workflow_name: a clean snake_case name for this workflow`;

/**
 * LLM classifier that selects which atomic actions belong to a workflow intent.
 * No browser, no tools — structured output only.
 *
 * @param {object} options
 * @param {Array} options.actions — all atomic actions from transition agents
 * @param {object} options.intent — { name, description }
 * @returns {Promise<{ selected_actions: number[], workflow_name: string }>}
 */
async function runWorkflowAssemblyAgent({ actions, intent, model }) {
  if (!model) return { selected_actions: [], workflow_name: intent.name };

  const actionSummaries = actions.map((action, idx) => ({
    index: idx,
    name: action.name,
    kind: action.kind,
    inputs: action.inputs,
    state: action._stateInfo?.name || "unknown",
    trigger: action._triggerKind,
  }));

  const WorkflowAssemblySchema = z.object({
    selected_actions: z.array(z.number()),
    workflow_name: z.string(),
  });

  try {
    const modelWithOutput = model.withStructuredOutput(WorkflowAssemblySchema);
    const result = await modelWithOutput.invoke([
      new SystemMessage(WORKFLOW_ASSEMBLY_PROMPT),
      new HumanMessage({
        content: `## Workflow Intent\nName: ${intent.name}\nDescription: ${intent.description}\n\n## Available Actions\n${JSON.stringify(actionSummaries, null, 2)}\n\nSelect the actions that belong to this workflow.`,
      }),
    ]);
    return result;
  } catch (err) {
    console.warn(`[browserwire] workflow assembly error for "${intent.name}": ${err.message}`);
    return { selected_actions: [], workflow_name: intent.name };
  }
}

/**
 * Deterministically assign form_group, sequence_order, and to_state
 * to a sequence of per-transition actions.
 *
 * Groups consecutive actions on the same state. If a group has input
 * actions followed by a click/submit, they form a workflow group.
 */
export function assignFormGroups(actions, groups) {
  if (actions.length === 0) return;

  // Group consecutive actions by state label
  let currentGroup = [];
  let currentLabel = null;

  const flushGroup = () => {
    if (currentGroup.length === 0) return;

    // Check if this is a form pattern: input actions + final click
    const hasInputs = currentGroup.some((a) => a.kind === "input");
    const lastAction = currentGroup[currentGroup.length - 1];
    const endsWithClick = lastAction.kind === "click";

    if (hasInputs && endsWithClick) {
      // This is a form workflow
      const stateName = getStateName(currentGroup[0], groups);
      const formGroupName = `${stateName}_form`.replace(/\s+/g, "_").toLowerCase();

      for (let j = 0; j < currentGroup.length; j++) {
        currentGroup[j].form_group = formGroupName;
        currentGroup[j].sequence_order = j;
      }
      // Mark the last action as form_submit
      lastAction.kind = "form_submit";
    }

    currentGroup = [];
  };

  for (const action of actions) {
    const snapshotIdx = action._snapshotIndex;
    const label = snapshotIdx < groups.length ? groups[snapshotIdx].stateLabel : null;

    if (label !== currentLabel) {
      flushGroup();
      currentLabel = label;
    }
    currentGroup.push(action);
  }
  flushGroup();
}

function getStateName(action, groups) {
  const idx = action._snapshotIndex;
  if (idx !== undefined && idx < groups.length) {
    return groups[idx].stateIdentity?.name || `state_${groups[idx].stateLabel}`;
  }
  return "unknown";
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

    // Merge actions — set to_state from snapshot-state mapping
    for (const action of result.pendingActions || []) {
      const targetStateId = findBestState(action, groups, labelToManifestId, manifest, intentName);
      if (targetStateId) {
        // Determine to_state from the next snapshot's state
        const i = action._snapshotIndex;
        if (i !== undefined && (i + 1) < groups.length) {
          const destLabel = groups[i + 1].stateLabel;
          action.to_state = labelToManifestId.get(destLabel) || targetStateId;
        } else {
          action.to_state = targetStateId;
        }

        manifest.mergeActions(targetStateId, [action]);
        const state = manifest.getStates().find((s) => s.id === targetStateId);
        if (state && !state.signature.actions.includes(action.name)) {
          state.signature.actions.push(action.name);
        }
      }
    }
  }

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


