/**
 * executor.js — Execute a route path against a live site.
 *
 * Given a route from the route table, navigates the state machine path
 * (running action code at each step), then reads the view or executes
 * the action at the target state.
 *
 * Transport-agnostic — receives a Playwright page from the caller.
 *
 * Page settling uses a DOM MutationObserver to detect when the page
 * has finished rendering (DOM stops mutating).
 */

import { parseTemplate } from "url-template";

const ACTION_TIMEOUT_MS = 30_000;
const CODE_TIMEOUT_MS = 3_000; // Short timeout for view/action code — selectors should match fast

/**
 * Wait for the page to settle: DOM stops mutating.
 *
 * Uses a MutationObserver to detect when the DOM stabilizes after a
 * debounce period with no mutations. A max timeout acts as a safety net
 * for pages with constant DOM mutations (animations, live tickers).
 *
 * Does NOT wait for network idle — modern SPAs (Reddit, etc.) maintain
 * persistent connections, analytics pings, and background fetches that
 * prevent network idle from ever being reached.
 *
 * @param {import('playwright').Page} page
 * @param {{ timeout?: number, debounce?: number }} [opts]
 */
async function waitForSettle(page, { timeout = 5_000, debounce = 300 } = {}) {
  try {
    await page.evaluate(({ timeoutMs, debounceMs }) => {
      return new Promise((resolve) => {
        let timer = null;
        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            clearTimeout(maxTimer);
            observer.disconnect();
            resolve();
          }, debounceMs);
        });

        // Safety net: resolve after max timeout even if DOM keeps mutating
        const maxTimer = setTimeout(() => {
          if (timer) clearTimeout(timer);
          observer.disconnect();
          resolve();
        }, timeoutMs);

        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });

        // Start the timer immediately — if no mutations happen, settle quickly
        timer = setTimeout(() => {
          clearTimeout(maxTimer);
          observer.disconnect();
          resolve();
        }, debounceMs);
      });
    }, { timeoutMs: timeout, debounceMs: debounce });
  } catch {
    // Page may have navigated during evaluation
  }
}

/**
 * Execute a code string against a Playwright page.
 */
async function runCode(page, code, inputs) {
  const fn = new Function("page", "inputs", `return (${code})(page, inputs);`);
  return fn(page, inputs || {});
}

function pickInputs(flatInputs, declaredInputs) {
  if (!declaredInputs?.length) return {};
  const picked = {};
  for (const decl of declaredInputs) {
    if (decl.name in flatInputs) {
      picked[decl.name] = flatInputs[decl.name];
    }
  }
  return picked;
}

function getState(manifest, stateId) {
  return manifest.states.find((s) => s.id === stateId) || null;
}

function getAction(state, actionName) {
  return state?.actions?.find((a) => a.name === actionName) || null;
}

function getView(state, viewName) {
  return state?.views?.find((v) => v.name === viewName) || null;
}

/**
 * Execute a route using a pre-created Playwright page.
 *
 * @param {object} options
 * @param {import('playwright').Page} options.page
 * @param {object} options.manifest
 * @param {object} options.route — from buildRouteTable()
 * @param {object} options.inputs — flat inputs from request
 * @param {string} options.origin
 */
export async function executeRoute({ page, manifest, route, inputs, origin }) {
  const executedSteps = [];

  try {
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    const entryState = getState(manifest, route.entryPointStateId || manifest.initial_state);
    if (!entryState) {
      return { ok: false, error: "Entry point state not found in manifest" };
    }

    // Expand RFC 6570 URI template with input values
    const template = parseTemplate(entryState.url_pattern || "/");
    const urlPath = template.expand(inputs);
    const startUrl = origin + urlPath;

    console.log(`[browserwire-exec] navigating to ${startUrl}`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT_MS });

    await waitForSettle(page);
    executedSteps.push(`navigate:${startUrl}`);

    // Execute each action along the path
    for (const step of route.path) {
      const state = getState(manifest, step.stateId);
      const action = getAction(state, step.actionName);

      if (!action?.code) {
        return {
          ok: false,
          error: `Action "${step.actionName}" on state "${state?.name}" has no code`,
          steps: executedSteps,
        };
      }

      const actionInputs = pickInputs(inputs, action.inputs);
      console.log(`[browserwire-exec] action: ${step.actionName} on ${state.name}`);

      try {
        page.setDefaultTimeout(CODE_TIMEOUT_MS);
        await runCode(page, action.code, actionInputs);
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
      } catch (err) {
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        return {
          ok: false,
          error: `Action "${step.actionName}" failed: ${err.message}`,
          steps: executedSteps,
        };
      }

      await waitForSettle(page, { timeout: 3_000, debounce: 200 });
      executedSteps.push(`action:${step.actionName}`);
    }

    // At the target state — execute view, action, or workflow
    const targetState = getState(manifest, route.stateId);

    if (route.type === "workflow") {
      // Replay each form action in sequence_order
      for (const step of route.actions) {
        const action = getAction(targetState, step.actionName);
        if (!action?.code) {
          return {
            ok: false,
            error: `Workflow action "${step.actionName}" on state "${targetState?.name}" has no code`,
            steps: executedSteps,
          };
        }

        const actionInputs = pickInputs(inputs, action.inputs);
        console.log(`[browserwire-exec] workflow step: ${step.actionName} on ${targetState.name}`);

        try {
          page.setDefaultTimeout(CODE_TIMEOUT_MS);
          await runCode(page, action.code, actionInputs);
          page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        } catch (err) {
          page.setDefaultTimeout(ACTION_TIMEOUT_MS);
          return {
            ok: false,
            error: `Workflow action "${step.actionName}" failed: ${err.message}`,
            steps: executedSteps,
          };
        }

        await waitForSettle(page, { timeout: 3_000, debounce: 200 });
        executedSteps.push(`action:${step.actionName}`);
      }

      return { ok: true, state: targetState.name, steps: executedSteps };
    }

    if (route.type === "view") {
      const view = getView(targetState, route.originalName || route.name);
      if (!view?.code) {
        return { ok: false, error: `View "${route.name}" has no code`, steps: executedSteps };
      }

      console.log(`[browserwire-exec] reading view: ${route.name} on ${targetState.name}`);
      try {
        page.setDefaultTimeout(CODE_TIMEOUT_MS);
        const data = await runCode(page, view.code);
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        console.log(`[browserwire-exec] view result: type=${typeof data}, isArray=${Array.isArray(data)}, length=${Array.isArray(data) ? data.length : 'n/a'}`);
        executedSteps.push(`view:${route.name}`);
        return { ok: true, data, state: targetState.name, steps: executedSteps };
      } catch (err) {
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        console.error(`[browserwire-exec] view error:`, err);
        return { ok: false, error: `View "${route.name}" failed: ${err.message}`, steps: executedSteps };
      }
    } else {
      const action = getAction(targetState, route.originalName || route.name);
      if (!action?.code) {
        return { ok: false, error: `Action "${route.name}" has no code`, steps: executedSteps };
      }

      const actionInputs = pickInputs(inputs, action.inputs);
      console.log(`[browserwire-exec] executing action: ${route.name} on ${targetState.name}`);
      try {
        page.setDefaultTimeout(CODE_TIMEOUT_MS);
        await runCode(page, action.code, actionInputs);
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        executedSteps.push(`action:${route.name}`);
        return { ok: true, state: targetState.name, steps: executedSteps };
      } catch (err) {
        page.setDefaultTimeout(ACTION_TIMEOUT_MS);
        return { ok: false, error: `Action "${route.name}" failed: ${err.message}`, steps: executedSteps };
      }
    }
  } catch (err) {
    return { ok: false, error: err.message, steps: executedSteps };
  }
}
