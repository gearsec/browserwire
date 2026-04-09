/**
 * dom-capture.js — Inject rrweb recorder into Electron BrowserView.
 *
 * Injects @rrweb/record which records ALL DOM events into window.__bw_events[].
 * No filtering — the backend decides what matters.
 *
 * Also injects a target-stripping script so link clicks navigate in the same
 * frame instead of opening new tabs.
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cached script contents
let _rrwebRecordScript = null;

/**
 * Read and cache the rrweb record UMD bundle.
 */
const loadScripts = async () => {
  if (!_rrwebRecordScript) {
    _rrwebRecordScript = await readFile(
      resolve(__dirname, "../vendor/rrweb-record.js"),
      "utf-8"
    );
  }
  return { rrwebRecordScript: _rrwebRecordScript };
};

/**
 * rrweb recording script — starts recording with NO source filtering.
 * All event types are captured: Meta, FullSnapshot, IncrementalSnapshot
 * (all sources), DomContentLoaded, Load, Custom, Plugin.
 *
 * The backend's segmenter (core/recording/segment.js) analyzes the raw
 * event stream to identify trigger boundaries.
 */
const RRWEB_RECORD_SCRIPT = `
(function() {
  if (window.__bw_recording) return;
  window.__bw_recording = true;
  window.__bw_events = window.__bw_events || [];

  window.__bw_stopRecording = rrweb.record({
    emit: function(event) {
      window.__bw_events.push(event);
    },
    recordCanvas: false,
    collectFonts: false,
  });
})();
`;

/**
 * Script to strip target="_blank" from links so clicks navigate in the
 * same frame. Re-runs on mutations to catch dynamically added links.
 */
const TARGET_STRIP_SCRIPT = `
(function() {
  if (window.__bw_target_strip_active) return;
  window.__bw_target_strip_active = true;

  var stripTargets = function() {
    document.querySelectorAll('a[target="_blank"]').forEach(function(a) {
      a.removeAttribute('target');
    });
  };
  stripTargets();
  window.__bw_targetObs = new MutationObserver(stripTargets);
  window.__bw_targetObs.observe(document.documentElement, { childList: true, subtree: true });
})();
`;

/**
 * Inject rrweb recorder into a webContents.
 *
 * @param {Electron.WebContents} webContents - The BrowserView's webContents
 * @returns {Promise<void>}
 */
export const injectCapture = async (webContents) => {
  const { rrwebRecordScript } = await loadScripts();

  // Inject @rrweb/record UMD bundle (exposes window.rrweb.record)
  await webContents.executeJavaScript(rrwebRecordScript + "\n;void 0;");

  // Start rrweb recording — capture everything
  await webContents.executeJavaScript(RRWEB_RECORD_SCRIPT + "\n;void 0;");

  // Strip target="_blank" from links
  await webContents.executeJavaScript(TARGET_STRIP_SCRIPT + "\n;void 0;");
};

/**
 * Stop recording and remove injected listeners.
 *
 * @param {Electron.WebContents} webContents
 */
export const removeCapture = async (webContents) => {
  try {
    await webContents.executeJavaScript(`
      if (window.__bw_stopRecording) {
        window.__bw_stopRecording();
        window.__bw_stopRecording = null;
      }
      window.__bw_recording = false;

      if (window.__bw_targetObs) {
        window.__bw_targetObs.disconnect();
        window.__bw_targetObs = null;
      }
      window.__bw_target_strip_active = false;
      void 0;
    `);
  } catch {
    // Page may have navigated away
  }
};
