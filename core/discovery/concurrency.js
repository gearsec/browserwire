/**
 * concurrency.js — Browser concurrency limiter.
 *
 * Process-global singleton: one semaphore guards all Chromium instances
 * across concurrent requests on the same container.
 */

import pLimit from "p-limit";

const DEFAULT_MAX_BROWSERS = 4;

let _limiter = null;

export function getBrowserLimiter() {
  if (_limiter) return _limiter;

  const max = parseInt(process.env.BROWSERWIRE_MAX_BROWSERS) || DEFAULT_MAX_BROWSERS;
  // Logged once on first call; no logger param needed for this singleton
  console.log(`[browserwire] browser concurrency: ${max}`);

  _limiter = pLimit(max);
  return _limiter;
}
