/**
 * event-recorder.js — Minimal main-process event buffer for Electron.
 *
 * Replaces SettleCycleManager. No settle logic, no network tracking,
 * no snapshot decisions. Just drains rrweb events from the page into
 * a cumulative main-process buffer that survives navigations.
 *
 * The backend's segmenter (core/recording/segment.js) analyzes the
 * raw event stream post-hoc to identify trigger boundaries.
 */

export class EventRecorder {
  /**
   * @param {{ webContents: Electron.WebContents }} opts
   */
  constructor({ webContents }) {
    this._wc = webContents;

    // Cumulative event buffer (main process — survives navigations)
    this._eventBuffer = [];

    this._started = false;
  }

  /**
   * Get the cumulative event buffer (all events across all page navigations).
   */
  get events() {
    return this._eventBuffer;
  }

  /**
   * Start the recorder.
   */
  start() {
    if (this._started) return;
    this._started = true;
  }

  /**
   * Stop the recorder.
   */
  stop() {
    if (!this._started) return;
    this._started = false;
  }

  /**
   * Drain all rrweb events from the page into the main-process buffer.
   * Clears the page array so events aren't double-counted.
   * Returns the number of events drained.
   */
  async drainEvents() {
    try {
      const eventsJson = await this._wc.executeJavaScript(`
        (function() {
          var events = window.__bw_events || [];
          window.__bw_events = [];
          return JSON.stringify(events);
        })()
      `);
      const events = JSON.parse(eventsJson);
      if (events.length > 0) {
        this._eventBuffer.push(...events);
      }
      return events.length;
    } catch {
      return 0;
    }
  }
}
