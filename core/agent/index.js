/**
 * agent/index.js — Unified agent entry point.
 *
 * LangGraph StateGraph with two nodes:
 *   try_manifest  — run manifest code directly (no LLM). The cache layer.
 *   llm_agent     — agent that fixes/adds to the manifest.
 *
 * Loop: try_manifest → (fail) → llm_agent → try_manifest → ...
 * Exit: try_manifest succeeds, or agent calls done(), or budget exhausted.
 */

import { StateGraph, Annotation, END, START } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { HumanMessage } from "@langchain/core/messages";
import { BrowserClient } from "../browser/browser-client.js";
import { executeCode } from "../browser/code-runner.js";
import { createModel } from "../discovery/ai-provider.js";
import { createTools } from "./tools/index.js";
import { SYSTEM_PROMPT, buildInitialMessage } from "./prompts.js";

// ---------------------------------------------------------------------------
// Graph state
// ---------------------------------------------------------------------------

const GraphState = Annotation.Root({
  cacheHit: Annotation({ reducer: (_, b) => b, default: () => false }),
  cacheResult: Annotation({ reducer: (_, b) => b, default: () => null }),
  cacheError: Annotation({ reducer: (_, b) => b, default: () => null }),
  agentDone: Annotation({ reducer: (_, b) => b, default: () => false }),
  iterations: Annotation({ reducer: (_, b) => b, default: () => 0 }),
  currentStep: Annotation({ reducer: (_, b) => b, default: () => 0 })
});

// ---------------------------------------------------------------------------
// runAgent
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.url — Starting URL
 * @param {import('../manifest/manifest.js').StateMachineManifest} options.manifest
 * @param {string} options.cdpEndpoint — ws://... CDP WebSocket
 * @param {object} options.config — { llmProvider, llmModel, llmApiKey }
 * @param {string} [options.apiSpec] — Free text description of what to build
 * @param {string} [options.workflow] — Workflow name to execute from the manifest
 * @param {object} [options.inputs] — Input values for the workflow's actions
 * @param {function} [options.onProgress]
 * @param {number} [options.maxRetries=10] — Max try_manifest→llm_agent cycles
 * @param {number} [options.maxIterations=30] — Agent recursion limit per cycle
 * @returns {Promise<{ manifest: object, result?: any, error?: string }>}
 */
export async function runAgent({
  url,
  manifest,
  cdpEndpoint,
  config,
  apiSpec,
  workflow,
  inputs,
  onProgress,
  maxRetries = 10,
  maxIterations = 30,
}) {
  // --- Setup ---
  const client = new BrowserClient({ cdpEndpoint });
  await client.connect();
  await client.navigate(url);
  await client.waitForLoad();

  const page = client.page;
  const model = createModel(config);
  if (!model) {
    await client.disconnect();
    return { manifest: manifest.toJSON(), error: "No LLM provider configured" };
  }

  // Shared mutable context for tools
  // currentStep is updated by tryManifest before each llm_agent invocation
  const ctx = { page, manifest, currentStep: 0, _done: false, _result: null };
  const tools = createTools(ctx);

  // --- Node: try_manifest ---
  async function tryManifest(state) {
    // No workflow to try — skip to LLM
    if (!workflow) {
      return { cacheHit: false, cacheResult: null, cacheError: null };
    }

    const wf = manifest.getWorkflow(workflow);
    if (!wf) {
      return { cacheHit: false, cacheError: `Workflow '${workflow}' not found in manifest` };
    }

    // Resume from currentStep (0 on first run, or where we left off after a fix)
    let lastResult = null;
    for (let i = state.currentStep; i < wf.steps.length; i++) {
      ctx.currentStep = i;
      const step = wf.steps[i];
      const targetState = manifest.getState(step.state);
      if (!targetState) {
        return { cacheHit: false, cacheError: `State '${step.state}' not found in manifest`, currentStep: i };
      }

      // Navigate to the state's URL
      try {
        const stateUrl = targetState.url_pattern.replace(/\{[^}]+\}/g, "");
        if (!page.url().includes(stateUrl)) {
          await page.goto(url.replace(/\/$/, "") + stateUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
        }
      } catch (err) {
        return { cacheHit: false, cacheError: `Navigation to '${step.state}' failed: ${err.message}`, currentStep: i };
      }

      // Execute the step's action or view
      if (step.action) {
        const action = targetState.actions.find((a) => a.name === step.action);
        if (!action) {
          return { cacheHit: false, cacheError: `Action '${step.action}' not found in state '${step.state}'`, currentStep: i };
        }
        const { success, result, error } = await executeCode(page, action.code, inputs);
        if (!success) {
          return { cacheHit: false, cacheError: `Step ${i}: action '${step.action}' failed: ${error}`, currentStep: i };
        }
        lastResult = result;
      }

      if (step.view) {
        const view = targetState.views.find((v) => v.name === step.view);
        if (!view) {
          return { cacheHit: false, cacheError: `View '${step.view}' not found in state '${step.state}'`, currentStep: i };
        }
        const { success, result, error } = await executeCode(page, view.code);
        if (!success) {
          return { cacheHit: false, cacheError: `Step ${i}: view '${step.view}' failed: ${error}`, currentStep: i };
        }
        lastResult = result;
      }
    }

    return { cacheHit: true, cacheResult: lastResult, cacheError: null };
  }

  // --- Node: llm_agent ---
  async function llmAgent(state) {
    const initialMessage = buildInitialMessage({
      apiSpec,
      workflow,
      inputs,
      cacheError: state.cacheError,
      currentStep: state.currentStep,
    });

    const agent = createAgent({
      model,
      tools,
      systemPrompt: SYSTEM_PROMPT,
    });

    try {
      await agent.invoke(
        { messages: [new HumanMessage(initialMessage)] },
        { recursionLimit: maxIterations }
      );
    } catch (err) {
      return {
        agentDone: ctx._done,
        iterations: state.iterations + 1,
        cacheError: `Agent error: ${err.message}`,
      };
    }

    return {
      agentDone: ctx._done,
      iterations: state.iterations + 1,
    };
  }

  // --- Routing ---
  function afterTryManifest(state) {
    if (state.cacheHit) return END;
    if (state.iterations >= maxRetries) return END;
    return "llm_agent";
  }

  function afterLlmAgent(state) {
    if (state.agentDone) return END;
    if (state.iterations >= maxRetries) return END;
    return "try_manifest";
  }

  // --- Build and run graph ---
  const graph = new StateGraph(GraphState)
    .addNode("try_manifest", tryManifest)
    .addNode("llm_agent", llmAgent)
    .addEdge(START, "try_manifest")
    .addConditionalEdges("try_manifest", afterTryManifest, [END, "llm_agent"])
    .addConditionalEdges("llm_agent", afterLlmAgent, [END, "try_manifest"])
    .compile();

  let finalState;
  try {
    finalState = await graph.invoke({});
  } finally {
    await client.disconnect();
  }

  return {
    manifest: manifest.toJSON(),
    result: finalState.cacheHit ? finalState.cacheResult : ctx._result,
  };
}
