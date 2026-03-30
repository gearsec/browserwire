/**
 * session-processor.js — Serial session processing orchestrator.
 *
 * Takes a session recording (events + snapshots) and processes each snapshot
 * serially through the state agent. Builds a StateMachineManifest incrementally.
 *
 * The orchestrator handles all manifest mutations deterministically:
 *   - addState / reuse existing state
 *   - mergeActions for new actions on existing states
 *   - setLeadsTo to link the previous state's action to the current state
 *   - Signature derivation from submitted views/actions
 *
 * The agent only produces state step results (via submit tools on ctx).
 * It never touches the manifest directly.
 */

import { SnapshotIndex } from "./snapshot/snapshot-index.js";
import { PlaywrightBrowser } from "./snapshot/playwright-browser.js";
import { StateMachineManifest } from "../manifest/manifest.js";
import { EventType } from "../recording/rrweb-constants.js";
import { runStateAgent } from "./state-agent.js";
import { initTelemetry } from "../telemetry.js";

/**
 * Extract the rrweb FullSnapshot node tree from an event.
 * FullSnapshot events have type=2 and data.node containing the DOM tree.
 *
 * @param {object} event — rrweb event at the snapshot's eventIndex
 * @returns {object} The rrweb snapshot node tree
 */
function extractSnapshotTree(event) {
  if (event.type !== EventType.FullSnapshot) {
    throw new Error(`Expected FullSnapshot (type=${EventType.FullSnapshot}), got type=${event.type}`);
  }
  if (!event.data?.node) {
    throw new Error("FullSnapshot event has no data.node");
  }
  return event.data.node;
}

/**
 * Process a session recording into a StateMachineManifest.
 *
 * @param {object} options
 * @param {object} options.recording — validated session recording
 * @param {function} [options.onProgress] — called with { snapshot, tool } on progress
 * @param {string} [options.sessionId]
 * @returns {Promise<{ manifest: object|null, error?: string, totalToolCalls: number }>}
 */
export async function processRecording({ recording, onProgress, sessionId }) {
  await initTelemetry();

  const { events, snapshots } = recording;
  const manifest = new StateMachineManifest();

  let prevStateId = null;
  let prevActionName = null;
  let totalToolCalls = 0;

  console.log(
    `[browserwire] processing session: ${snapshots.length} snapshots, ${events.length} events`
  );

  for (let i = 0; i < snapshots.length; i++) {
    const snapshot = snapshots[i];
    const snapshotEvent = events[snapshot.eventIndex];

    console.log(
      `[browserwire] ── snapshot ${i + 1}/${snapshots.length}: ${snapshot.url} ──`
    );

    // 1. Extract the FullSnapshot DOM tree
    let rrwebTree;
    try {
      rrwebTree = extractSnapshotTree(snapshotEvent);
    } catch (err) {
      console.warn(`[browserwire]   skipping snapshot ${i + 1}: ${err.message}`);
      continue;
    }

    // 2. Create a fresh Playwright browser + load the snapshot
    const browser = new PlaywrightBrowser();
    try {
      await browser.ensureBrowser();
      await browser.loadSnapshot(rrwebTree, snapshot.url);

      // 3. Build the SnapshotIndex (queryable DOM with CDP enrichment)
      const index = new SnapshotIndex({
        rrwebSnapshot: rrwebTree,
        browser,
        screenshot: snapshot.screenshot || null,
        url: snapshot.url,
        title: snapshot.title,
      });
      await index.enrichWithCDP();

      // 4. Run the state agent
      const agentResult = await runStateAgent({
        index,
        browser,
        manifest,
        events,
        snapshots,
        currentSnapshotIndex: i,
        onProgress: ({ tool }) => {
          if (onProgress) onProgress({ snapshot: i + 1, tool });
        },
        sessionId,
      });

      totalToolCalls += agentResult.toolCallCount || 0;

      if (agentResult.error) {
        console.warn(`[browserwire]   agent error: ${agentResult.error}`);
        continue;
      }

      // 5. ORCHESTRATOR: Wire the manifest deterministically
      let currentStateId;

      if (agentResult.isExistingState && agentResult.currentStateId) {
        // Existing state — reuse
        currentStateId = agentResult.currentStateId;

        // Merge any new actions into the existing state
        if (agentResult.pendingActions.length > 0) {
          manifest.mergeActions(currentStateId, agentResult.pendingActions);
        }

        console.log(`[browserwire]   → existing state ${currentStateId}, ${agentResult.pendingActions.length} new actions`);
      } else if (agentResult.pendingState) {
        // New state — add to manifest
        const { name, description, url_pattern, page_purpose } = agentResult.pendingState;

        // Derive signature from submitted views/actions
        const signature = {
          page_purpose,
          views: agentResult.pendingViews.map((v) => v.name),
          actions: agentResult.pendingActions.map((a) => a.name),
        };

        currentStateId = manifest.addState({
          name,
          description,
          url_pattern,
          signature,
          views: agentResult.pendingViews,
          actions: agentResult.pendingActions,
        });

        // Set domain from first snapshot
        if (agentResult.pendingState.domain && !manifest.domain) {
          manifest.domain = agentResult.pendingState.domain;
          manifest.domainDescription = agentResult.pendingState.domainDescription || null;
        }

        // First state is the initial state
        if (manifest.initial_state === null) {
          manifest.initial_state = currentStateId;
        }

        console.log(
          `[browserwire]   → new state ${currentStateId} "${name}", ` +
          `${agentResult.pendingViews.length} views, ${agentResult.pendingActions.length} actions`
        );
      } else {
        console.warn(`[browserwire]   agent produced no state for snapshot ${i + 1}`);
        continue;
      }

      // Link previous state's action to this state — but only for SPA transitions
      // where the URL didn't change. If the URL changed, the new state is
      // reachable by URL alone and doesn't need an incoming edge.
      if (prevStateId !== null && prevActionName !== null) {
        const prevUrl = new URL(snapshots[i - 1].url);
        const currUrl = new URL(snapshot.url);
        const urlChanged = prevUrl.origin + prevUrl.pathname !== currUrl.origin + currUrl.pathname;

        if (urlChanged) {
          console.log(`[browserwire]   → URL changed, skipping edge (state is URL-navigable)`);
        } else {
          manifest.setLeadsTo(prevStateId, prevActionName, currentStateId);
          console.log(`[browserwire]   → linked ${prevStateId}.${prevActionName} → ${currentStateId}`);
        }
      }

      // Remember for next iteration
      prevStateId = currentStateId;
      // The action that leads to the NEXT state is the first action submitted for this state
      // (there's typically one forward action per snapshot — the one the user performed)
      prevActionName = agentResult.pendingActions.length > 0
        ? agentResult.pendingActions[0].name
        : null;

    } finally {
      await browser.close().catch(() => {});
    }
  }

  const manifestJson = manifest.toJSON();

  console.log(
    `[browserwire] session processing complete: ` +
    `${manifest.getStates().length} states, ${totalToolCalls} total tool calls`
  );

  return { manifest: manifestJson, totalToolCalls };
}
