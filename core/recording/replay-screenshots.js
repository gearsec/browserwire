/**
 * replay-screenshots.js — Playwright rrweb replay for screenshot + DOM tree extraction.
 *
 * For each snapshot boundary (from segment.js), replays the rrweb event stream
 * in a Playwright browser using rrweb's Replayer, takes a screenshot, and
 * extracts the serialized DOM tree via rrweb-snapshot.
 *
 * Uses local UMD bundles from node_modules (no CDN dependency).
 */

import { chromium } from "playwright";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventType } from "./rrweb-constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const RRWEB_UMD_PATH = resolve(
  __dirname,
  "../../node_modules/rrweb/dist/rrweb.umd.cjs"
);
const RRWEB_SNAPSHOT_UMD_PATH = resolve(
  __dirname,
  "../../node_modules/rrweb-snapshot/dist/rrweb-snapshot.umd.cjs"
);

let _rrwebScript = null;
let _rrwebSnapshotScript = null;

async function loadScripts() {
  if (!_rrwebScript) {
    _rrwebScript = await readFile(RRWEB_UMD_PATH, "utf-8");
  }
  if (!_rrwebSnapshotScript) {
    _rrwebSnapshotScript = await readFile(RRWEB_SNAPSHOT_UMD_PATH, "utf-8");
  }
  return { rrwebScript: _rrwebScript, rrwebSnapshotScript: _rrwebSnapshotScript };
}

/**
 * Generate screenshots and rrweb DOM trees for each snapshot boundary.
 *
 * @param {object[]} events - Full rrweb event stream
 * @param {{ snapshotId: string, eventIndex: number, trigger: { kind: string } | null }[]} segments
 * @returns {Promise<{ snapshotId: string, eventIndex: number, screenshot: string|null, rrwebTree: object|null, url: string, title: string, trigger: { kind: string }|null }[]>}
 */
export async function generateSnapshots(events, segments) {
  if (segments.length === 0 || events.length === 0) {
    return [];
  }

  const { rrwebScript, rrwebSnapshotScript } = await loadScripts();

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 720 });

    // Set up a page with rrweb Replayer
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 0; }
        iframe { border: none; }
      </style></head><body></body></html>`,
      { waitUntil: "domcontentloaded" }
    );

    // Inject rrweb UMD (exposes global `rrweb` with Replayer)
    await page.addScriptTag({ content: rrwebScript });
    // Inject rrweb-snapshot UMD (exposes global `rrwebSnapshot` with snapshot())
    await page.addScriptTag({ content: rrwebSnapshotScript });

    // Create the Replayer with all events
    const replayerReady = await page.evaluate((eventsJson) => {
      try {
        const events = JSON.parse(eventsJson);
        window.__bw_replayer = new rrweb.Replayer(events, {
          root: document.body,
          skipInactive: true,
          showWarning: false,
          showDebug: false,
          blockClass: "rr-block",
          liveMode: false,
          triggerFocus: false,
          speed: 16,
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }, JSON.stringify(events));

    if (!replayerReady.ok) {
      console.warn(`[replay-screenshots] Replayer creation failed: ${replayerReady.error}`);
      // Fall back to FullSnapshot-based snapshots
      return segments.map((seg) => buildFallbackSnapshot(events, seg));
    }

    const snapshots = [];

    for (const segment of segments) {
      let screenshot = null;
      let rrwebTree = null;
      let url = "";
      let title = "";

      try {
        // Pause the replayer at the target time offset (ms from first event)
        const relativeOffset = events[segment.eventIndex].timestamp - events[0].timestamp;
        await page.evaluate((offset) => {
          window.__bw_replayer.pause(offset);
        }, relativeOffset);

        // Wait for rendering
        await page.waitForTimeout(150);

        // Get the replayer's iframe
        const iframeHandle = await page.$("iframe");

        if (iframeHandle) {
          // Screenshot the iframe element directly (page.screenshot misses it — iframe is below viewport)
          try {
            const screenshotBuf = await iframeHandle.screenshot({
              type: "jpeg",
              quality: 50,
            });
            screenshot = screenshotBuf.toString("base64");
          } catch (err) {
            console.warn(`[replay-screenshots] screenshot failed for ${segment.snapshotId}: ${err.message}`);
          }

          // Extract DOM tree from parent context using rrwebSnapshot on the iframe doc
          try {
            const result = await page.evaluate(() => {
              const doc = window.__bw_replayer.iframe.contentDocument;
              if (!doc) return null;
              const mirror = window.__bw_replayer.getMirror();
              const snapResult = rrwebSnapshot.snapshot(doc, { mirror });
              const tree = Array.isArray(snapResult) ? snapResult[0] : snapResult;
              return {
                tree,
                title: doc.title || "",
              };
            });

            if (result) {
              rrwebTree = result.tree;
              title = result.title;
            }
          } catch (err) {
            console.warn(`[replay-screenshots] DOM extraction failed for ${segment.snapshotId}: ${err.message}`);
          }
        }
      } catch (err) {
        console.warn(`[replay-screenshots] replay failed for ${segment.snapshotId}: ${err.message}`);
      }

      // Fallback: use nearest FullSnapshot tree if replay didn't produce one
      if (!rrwebTree) {
        rrwebTree = findNearestFullSnapshotTree(events, segment.eventIndex);
      }
      // Always get URL from nearest Meta event (replayer iframe location is meaningless)
      const meta = findNearestMeta(events, segment.eventIndex);
      url = meta?.data?.href || "";

      snapshots.push({
        snapshotId: segment.snapshotId,
        eventIndex: segment.eventIndex,
        screenshot,
        rrwebTree,
        url,
        title,
        trigger: segment.trigger,
      });

      console.log(
        `[replay-screenshots] ${segment.snapshotId}: ` +
        `screenshot=${screenshot ? "yes" : "no"}, tree=${rrwebTree ? "yes" : "no"}`
      );
    }

    await page.close();
    return snapshots;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Build a fallback snapshot using the nearest FullSnapshot from the event stream.
 */
function buildFallbackSnapshot(events, segment) {
  const rrwebTree = findNearestFullSnapshotTree(events, segment.eventIndex);
  const meta = findNearestMeta(events, segment.eventIndex);
  return {
    snapshotId: segment.snapshotId,
    eventIndex: segment.eventIndex,
    screenshot: null,
    rrwebTree,
    url: meta?.data?.href || "",
    title: "",
    trigger: segment.trigger,
  };
}

function findNearestFullSnapshotTree(events, fromIndex) {
  for (let i = Math.min(fromIndex, events.length - 1); i >= 0; i--) {
    if (events[i].type === EventType.FullSnapshot && events[i].data?.node) {
      return events[i].data.node;
    }
  }
  return null;
}

function findNearestMeta(events, fromIndex) {
  for (let i = Math.min(fromIndex, events.length - 1); i >= 0; i--) {
    if (events[i].type === EventType.Meta) {
      return events[i];
    }
  }
  return null;
}
