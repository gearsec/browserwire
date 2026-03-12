/**
 * bridge.js — HTTP-to-WebSocket request/response bridge
 *
 * Mirrors the request-response pattern from the old SDK runtime.
 * Each HTTP request gets a unique requestId, sends a WS message,
 * and awaits a matching response.
 */

import { createEnvelope } from "../../extension/shared/protocol.js";

const DEFAULT_TIMEOUT_MS = 30000;

export const createBridge = () => {
  /** @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>} */
  const pending = new Map();

  /**
   * Send a WS message and await a matching response by requestId.
   */
  const sendAndAwait = (socket, type, payload, timeoutMs = DEFAULT_TIMEOUT_MS) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== 1) {
        reject(new Error("Extension not connected"));
        return;
      }

      const requestId = crypto.randomUUID();

      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Request ${type} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify(createEnvelope(type, payload, requestId)));
    });

  /**
   * Check if an incoming WS message matches a pending request.
   * Returns true if it was consumed.
   */
  const handleWsResult = (message) => {
    if (!message.requestId || !pending.has(message.requestId)) return false;

    const req = pending.get(message.requestId);
    pending.delete(message.requestId);
    clearTimeout(req.timer);
    req.resolve(message.payload);
    return true;
  };

  /**
   * Reject all pending requests (e.g. on disconnect).
   */
  const rejectAll = (reason) => {
    for (const [, req] of pending) {
      clearTimeout(req.timer);
      req.reject(new Error(reason));
    }
    pending.clear();
  };

  return { sendAndAwait, handleWsResult, rejectAll };
};
