/**
 * tools/index.js — Assemble agent tool sets.
 */

import { observationTools } from "./observation.js";
import { executeJsTool } from "./execute-js.js";
import { manifestTools } from "./manifest.js";
import { doneTool } from "./done.js";

/**
 * Create the full tool set for the agent.
 *
 * Build mode: all 10 tools.
 * Execute mode: observation + execute_js + read_manifest + update tools + done.
 *
 * @param {{ page: import('patchright').Page, manifest: import('../../manifest/manifest.js').StateMachineManifest, mode: "build"|"execute", _done: boolean, _result: any }} ctx
 * @returns {import('@langchain/core/tools').StructuredToolInterface[]}
 */
export function createTools(ctx) {
  const observe = observationTools(ctx);
  const execute = executeJsTool(ctx);
  const manifest = manifestTools(ctx);
  const done = doneTool(ctx);

  return [...observe, execute, ...manifest, done];
}
