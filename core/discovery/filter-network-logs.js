/**
 * filter-network-logs.js — Deterministic Junk Filter
 *
 * Filters raw network logs captured by the extension down to
 * API-relevant JSON entries. No LLM calls — pure heuristics.
 *
 * Input:  raw networkLog[] from all snapshots
 * Output: filtered NetworkLogEntry[]
 */

// ---------------------------------------------------------------------------
// URL patterns to drop (extends extension's SKIP_URL_RE)
// ---------------------------------------------------------------------------

const JUNK_URL_RE = new RegExp([
  // Static assets
  "favicon\\.ico", "manifest\\.json", "robots\\.txt", "sitemap\\.xml",
  // Analytics & tracking (extension already filters some)
  "google-analytics", "segment\\.io", "sentry\\.io", "hotjar", "intercom",
  "doubleclick", "mixpanel", "amplitude", "heap\\.io", "fullstory",
  "logrocket", "mouseflow", "clarity\\.ms", "plausible\\.io", "posthog",
  // HMR / dev tooling
  "__webpack_hmr", "__vite_hmr", "hot-update",
].join("|"), "i");

// ---------------------------------------------------------------------------
// Content-type allowlist
// ---------------------------------------------------------------------------

const DATA_CT_RE = /application\/(?:.*\+)?json|text\/json|application\/graphql-response\+json/i;

// ---------------------------------------------------------------------------
// Status filter
// ---------------------------------------------------------------------------

const isUsableStatus = (status) => {
  if (status === 304) return true;          // Not Modified (cached, may have body)
  if (status >= 300 && status < 400) return false;  // Other redirects
  if (status < 200) return false;           // Informational
  if (status >= 500) return false;          // Server errors
  return true; // 200, 201, 206, 4xx (may carry useful error shapes)
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Filter raw network logs into API-relevant entries.
 *
 * @param {{ networkLogs: object[] }} input
 * @returns {object[]} filtered API log entries
 */
export const filterNetworkLogs = ({ networkLogs }) => {
  const filtered = [];

  for (const entry of networkLogs) {
    // 1. Drop by URL pattern
    if (JUNK_URL_RE.test(entry.url || "")) continue;

    // 2. Drop by content-type (keep only data responses)
    const ct = entry.contentType || "";
    if (ct && !DATA_CT_RE.test(ct)) continue;

    // 3. Drop by status
    if (!isUsableStatus(entry.status)) continue;

    // 4. Drop entries with no response body (nothing to analyze)
    if (entry.responseBody == null && !entry.bodyTruncated) continue;

    filtered.push(entry);
  }

  console.log(
    `[browserwire-cli] network filter: ${networkLogs.length} raw → ${filtered.length} API logs`
  );

  return filtered;
};
