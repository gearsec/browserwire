/**
 * dom-capture.js — Inject discovery scripts and page signal listeners into Electron BrowserView.
 *
 * Injects rrweb-snapshot + discovery.js for DOM capture functions, and a minimal
 * PAGE_SIGNAL_SCRIPT that sends click/input/mutation signals to the main process
 * via console.debug (received by SettleCycleManager via webContents 'console-message').
 *
 * The settle cycle logic lives entirely in the main process (settle-cycle.js).
 */

import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cached script contents
let _rrwebSnapshotScript = null;
let _discoveryScript = null;

/**
 * Read and cache the scripts we inject into web pages.
 */
const loadScripts = async () => {
  if (!_rrwebSnapshotScript) {
    _rrwebSnapshotScript = await readFile(
      resolve(__dirname, "../vendor/rrweb-snapshot.js"),
      "utf-8"
    );
  }
  if (!_discoveryScript) {
    _discoveryScript = await readFile(
      resolve(__dirname, "../vendor/discovery.js"),
      "utf-8"
    );
  }
  return { rrwebSnapshotScript: _rrwebSnapshotScript, discoveryScript: _discoveryScript };
};

/**
 * Minimal page script that signals user interactions and DOM mutations
 * to the main process via console.debug('__bw:...').
 *
 * No settle logic, no queues — just raw signals.
 * The SettleCycleManager in the main process handles everything else.
 */
const PAGE_SIGNAL_SCRIPT = `
(function() {
  if (window.__bw_active) return;
  window.__bw_active = true;

  var signal = function(data) {
    console.debug('__bw:' + JSON.stringify(data));
  };

  var captureTrigger = function(el, kind) {
    var trigger = {
      kind: kind,
      target: null,
      url: location.href,
      title: document.title,
      timestamp: Date.now()
    };
    if (el && el instanceof HTMLElement) {
      trigger.target = {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').trim().slice(0, 100),
        role: el.getAttribute('role') || null,
        name: el.getAttribute('aria-label') || el.getAttribute('title') || null
      };
    }
    return trigger;
  };

  var onClick = function(e) {
    signal({ type: 'interaction', trigger: captureTrigger(e.target, 'click') });
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
      signal({ type: 'interaction', trigger: captureTrigger(null, 'navigation') });
    }
  };
  window.addEventListener('popstate', checkNav);
  window.addEventListener('hashchange', checkNav);

  // Initial signal — tells the settle cycle to take the first snapshot
  signal({ type: 'interaction', trigger: captureTrigger(null, 'initial') });

  window.__bw_cleanup = function() {
    document.removeEventListener('click', onClick, true);
    obs.disconnect();
    window.removeEventListener('popstate', checkNav);
    window.removeEventListener('hashchange', checkNav);
    window.__bw_active = false;
  };
})();
`;

/**
 * Inject discovery scripts and page signal listeners into a webContents.
 *
 * @param {Electron.WebContents} webContents - The BrowserView's webContents
 * @returns {Promise<void>}
 */
export const injectCapture = async (webContents) => {
  const { rrwebSnapshotScript, discoveryScript } = await loadScripts();

  // Inject rrweb-snapshot (provides serializeDom via the global rrwebSnapshot)
  await webContents.executeJavaScript(rrwebSnapshotScript + "\n;void 0;");

  // Inject a wrapper that makes serializeDom available as a global function
  await webContents.executeJavaScript(`
    if (typeof rrwebSnapshot !== 'undefined' && rrwebSnapshot.snapshot) {
      window.serializeDom = function() {
        var result = rrwebSnapshot.snapshot(document);
        return result[0];
      };
    }
    void 0;
  `);

  // Inject discovery.js (provides scanDOM, collectPageText, capturePageState, etc.)
  // discovery.js uses `const` declarations which are scoped to the executeJavaScript
  // eval and not visible in subsequent calls. Hoist the functions onto `window`.
  await webContents.executeJavaScript(discoveryScript + `
    if (typeof collectPageText === 'function') window.collectPageText = collectPageText;
    if (typeof capturePageState === 'function') window.capturePageState = capturePageState;
    if (typeof runSkeletonScan === 'function') window.runSkeletonScan = runSkeletonScan;
    if (typeof serializeDom === 'function' && !window.serializeDom) window.serializeDom = serializeDom;
    void 0;
  `);

  // Inject the page signal script (click/input/mutation signals → console.debug)
  await webContents.executeJavaScript(PAGE_SIGNAL_SCRIPT + "\n;void 0;");
};

/**
 * Remove injected listeners and clean up.
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
