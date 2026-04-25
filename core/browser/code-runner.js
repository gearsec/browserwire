/**
 * code-runner.js — Execute Playwright code against a live page.
 *
 * Adapted from test-code.js::executeCode. Key differences:
 *   - No __rrwebMirror / recording verification
 *   - Configurable timeout (live pages have network latency)
 *   - Returns real results from real pages
 */

/**
 * Execute a code string as a self-contained async function against a Playwright page.
 *
 * @param {import('patchright').Page} page — Playwright Page object
 * @param {string} code — Code string: "async (page, inputs) => { ... }"
 * @param {object} [inputs] — Input values passed to the function
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<{ success: boolean, result?: any, error?: string }>}
 */
export async function executeCode(page, code, inputs, { timeout = 30000 } = {}) {
  try {
    const fn = new Function("page", "inputs", `return (${code})(page, inputs);`);
    const result = await Promise.race([
      fn(page, inputs || {}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Code execution timed out after ${timeout}ms`)), timeout)
      ),
    ]);
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
