/**
 * replay-screenshots.js — Playwright rrweb replay for screenshot + DOM tree extraction.
 *
 * For each snapshot boundary (from segment.js), replays rrweb events from 0
 * to the boundary in a Playwright browser using rrweb's Replayer, takes a
 * screenshot, and extracts the serialized DOM tree via rrweb-snapshot.
 *
 * Each snapshot gets a fresh Replayer with truncated events to ensure the
 * DOM is exactly the result of replaying events[0..eventIndex].
 *
 * Uses local UMD bundles from node_modules (no CDN dependency).
 */

import { chromium } from "patchright";
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
 * For each segment, creates a fresh Replayer with events[0..eventIndex]
 * and plays to end, ensuring the DOM tree is exactly the state after
 * applying all events up to the boundary.
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

    // Set up a page with rrweb scripts
    await page.setContent(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 0; }
        iframe { border: none; }
      </style></head><body></body></html>`,
      { waitUntil: "domcontentloaded" }
    );

    // Inject rrweb UMD (exposes global `rrweb` with Replayer)
    // Use evaluate instead of addScriptTag so scripts land in patchright's
    // isolated execution context — the same context that later evaluate() calls use.
    await page.evaluate(rrwebScript);
    // Inject rrweb-snapshot UMD (exposes global `rrwebSnapshot` with snapshot())
    await page.evaluate(rrwebSnapshotScript);

    const snapshots = [];

    for (const segment of segments) {
      let screenshot = null;
      let rrwebTree = null;
      let url = "";
      let title = "";

      try {
        // Create a fresh Replayer with events up to this boundary and play to end
        const slicedEvents = events.slice(0, segment.eventIndex + 1);
        const replayResult = await page.evaluate((eventsJson) => {
          try {
            if (window.__bw_replayer) {
              window.__bw_replayer.destroy();
            }
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
            // Play all events to end — +1ms ensures the last event is always
            // applied regardless of rrweb's internal < vs <= comparison.
            const totalTime = events[events.length - 1].timestamp - events[0].timestamp;
            window.__bw_replayer.pause(totalTime + 1);
            return { ok: true };
          } catch (err) {
            return { ok: false, error: err.message };
          }
        }, JSON.stringify(slicedEvents));

        if (!replayResult.ok) {
          console.error(`[replay-screenshots] Replayer failed for ${segment.snapshotId}: ${replayResult.error}`);
          // Continue to next segment — rrwebTree stays null
        } else {
          // Wait for rendering
          await page.waitForTimeout(150);

          // Get the replayer's iframe
          const iframeHandle = await page.$("iframe");

          if (iframeHandle) {
            // Screenshot the iframe element
            try {
              const screenshotBuf = await iframeHandle.screenshot({
                type: "jpeg",
                quality: 50,
              });
              screenshot = screenshotBuf.toString("base64");
            } catch (err) {
              console.warn(`[replay-screenshots] screenshot failed for ${segment.snapshotId}: ${err.message}`);
            }

            // Extract DOM tree from the iframe
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
        }
      } catch (err) {
        console.warn(`[replay-screenshots] replay failed for ${segment.snapshotId}: ${err.message}`);
      }

      if (!rrwebTree) {
        console.error(`[replay-screenshots] ${segment.snapshotId} at eventIndex ${segment.eventIndex}: rrwebTree is null`);
      }

      // Get URL from nearest Meta event (replayer iframe location is meaningless)
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

function findNearestMeta(events, fromIndex) {
  for (let i = Math.min(fromIndex, events.length - 1); i >= 0; i--) {
    if (events[i].type === EventType.Meta) {
      return events[i];
    }
  }
  return null;
}
