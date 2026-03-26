/**
 * dom-capture.js — Inject rrweb recorder and page signal listeners into Electron BrowserView.
 *
 * Injects:
 *   1. @rrweb/record — records DOM events (mutations, clicks, inputs, style changes)
 *      into window.__bw_events[], filtered to only the sources needed for replay.
 *   2. PAGE_SIGNAL_SCRIPT — minimal click/mutation/navigation signals to the main process
 *      via console.debug. Drives the SettleCycleManager (settle timing logic).
 *
 * The rrweb event stream is the source of truth for both states (FullSnapshot)
 * and transitions (IncrementalSnapshot). The page signal script only determines
 * WHEN to capture a snapshot marker — it does not contribute to the payload.
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
 * rrweb recording script — starts recording and filters events.
 *
 * Captured IncrementalSnapshot sources (type=3):
 *   0  Mutation         — DOM node adds/removes/attribute/text changes (essential for replay)
 *   2  MouseInteraction — click, focus, blur, dblclick, etc. (essential for action grounding)
 *   5  Input            — form field value/checked changes (essential for action inputs)
 *   8  StyleSheetRule   — CSS rule insertions/deletions (affects element visibility)
 *   13 StyleDeclaration — inline style changes (affects element visibility)
 *
 * Excluded:
 *   1  MouseMove, 3 Scroll, 4 ViewportResize, 6 TouchMove,
 *   7  MediaInteraction, 9 CanvasMutation, 10 Font, 11 Log,
 *   12 Drag, 14 Selection, 15 AdoptedStyleSheet, 16 CustomElement
 *
 * All non-incremental events are captured: Meta(4), FullSnapshot(2),
 * DomContentLoaded(0), Load(1).
 */
const RRWEB_RECORD_SCRIPT = `
(function() {
  if (window.__bw_recording) return;
  window.__bw_recording = true;
  window.__bw_events = window.__bw_events || [];

  var ALLOWED_SOURCES = { 0: true, 2: true, 5: true, 8: true, 13: true };

  window.__bw_stopRecording = rrweb.record({
    emit: function(event) {
      // type 3 = IncrementalSnapshot — filter by source
      if (event.type === 3 && !ALLOWED_SOURCES[event.data.source]) {
        return;
      }
      window.__bw_events.push(event);
    },
    sampling: {
      mousemove: false,
      scroll: 0,
      media: 0,
      canvas: 0,
    },
    recordCanvas: false,
    collectFonts: false,
  });
})();
`;

/**
 * Minimal page script that signals user interactions and DOM mutations
 * to the main process via console.debug('__bw:...').
 *
 * No settle logic, no queues — just raw signals.
 * The SettleCycleManager in the main process handles everything else.
 */
const PAGE_SIGNAL_SCRIPT = `
(function() {
  if (window.__bw_signals_active) return;
  window.__bw_signals_active = true;

  var signal = function(data) {
    console.debug('__bw:' + JSON.stringify(data));
  };

  var onClick = function(e) {
    signal({ type: 'interaction', kind: 'click' });
  };

  document.addEventListener('click', onClick, true);

  var obs = new MutationObserver(function() {
    signal({ type: 'mutation' });
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  var lastUrl = location.href;
  var checkNav = function() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      signal({ type: 'interaction', kind: 'navigation' });
    }
  };
  window.addEventListener('popstate', checkNav);
  window.addEventListener('hashchange', checkNav);

  // Initial signal — tells the settle cycle to take the first snapshot
  signal({ type: 'interaction', kind: 'initial' });

  window.__bw_cleanup = function() {
    document.removeEventListener('click', onClick, true);
    obs.disconnect();
    window.removeEventListener('popstate', checkNav);
    window.removeEventListener('hashchange', checkNav);
    window.__bw_signals_active = false;

    // Stop rrweb recording
    if (window.__bw_stopRecording) {
      window.__bw_stopRecording();
      window.__bw_stopRecording = null;
    }
    window.__bw_recording = false;
  };
})();
`;

/**
 * Inject rrweb recorder and page signal listeners into a webContents.
 *
 * @param {Electron.WebContents} webContents - The BrowserView's webContents
 * @returns {Promise<void>}
 */
export const injectCapture = async (webContents) => {
  const { rrwebRecordScript } = await loadScripts();

  // Inject @rrweb/record UMD bundle (exposes window.rrweb.record)
  await webContents.executeJavaScript(rrwebRecordScript + "\n;void 0;");

  // Start rrweb recording with event filter
  await webContents.executeJavaScript(RRWEB_RECORD_SCRIPT + "\n;void 0;");

  // Inject the page signal script (drives settle cycle timing)
  await webContents.executeJavaScript(PAGE_SIGNAL_SCRIPT + "\n;void 0;");
};

/**
 * Remove injected listeners and stop recording.
 *
 * @param {Electron.WebContents} webContents
 */
export const removeCapture = async (webContents) => {
  try {
    await webContents.executeJavaScript(`
      if (window.__bw_cleanup) {
        window.__bw_cleanup();
      }
      void 0;
    `);
  } catch {
    // Page may have navigated away
  }
};
