/**
 * posthog.js — PostHog analytics client singleton.
 *
 * Reads API key from process.env.POSTHOG_API_KEY (baked in at build time
 * for distribution, or loaded from .env for local dev).
 *
 * No-ops silently when no key is set — never blocks the app.
 */

import { PostHog } from "posthog-node";

let client = null;
let _distinctId = null;

/**
 * Initialize the PostHog client.
 *
 * @param {string} distinctId — anonymous UUID for event correlation
 */
export function initPostHog(distinctId) {
  const apiKey = process.env.POSTHOG_API_KEY;
  if (!apiKey || client) return;

  _distinctId = distinctId;
  client = new PostHog(apiKey, {
    host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
  });
}

/**
 * Track an event. No-ops if PostHog is not initialized.
 *
 * @param {string} event — event name
 * @param {object} [properties] — event properties
 */
export function trackEvent(event, properties = {}) {
  if (!client || !_distinctId) return;
  client.capture({ distinctId: _distinctId, event, properties });
}

/**
 * Flush pending events and shut down. Call on app quit.
 */
export function shutdownPostHog() {
  return client?.shutdown();
}
