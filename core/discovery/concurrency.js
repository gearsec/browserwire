/**
 * concurrency.js — Agent concurrency limiter for Pass 3.
 *
 * Process-global singleton: one semaphore guards all parallel agent
 * executions across concurrent requests on the same container.
 */

import pLimit from "p-limit";

const DEFAULT_MAX_AGENTS = 2;

let _limiter = null;

export function getAgentLimiter() {
  if (_limiter) return _limiter;

  const max = parseInt(process.env.BROWSERWIRE_MAX_AGENTS) || DEFAULT_MAX_AGENTS;
  console.log(`[browserwire] agent concurrency: ${max}`);

  _limiter = pLimit(max);
  return _limiter;
}
