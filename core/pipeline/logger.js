/**
 * logger.js — Logging adapter for @browserwire/core.
 *
 * Accepts an optional Pino-compatible logger from the caller (e.g., Fastify's
 * request.log). If none is provided, falls back to console with [browserwire]
 * prefix — backward compatible for CLI and standalone usage.
 *
 * @param {{ logger?: object, sessionId?: string }} [options]
 * @returns {{ info: Function, warn: Function, error: Function }}
 */
export function createCoreLogger(options = {}) {
  const { logger, sessionId } = options;

  if (logger) {
    const child = logger.child({ component: "browserwire", ...(sessionId ? { sessionId } : {}) });
    return {
      info: (msgOrObj, ...rest) => child.info(msgOrObj, ...rest),
      warn: (msgOrObj, ...rest) => child.warn(msgOrObj, ...rest),
      error: (msgOrObj, ...rest) => child.error(msgOrObj, ...rest),
    };
  }

  // Fallback: console with [browserwire] prefix (preserves existing CLI behavior)
  const prefix = sessionId ? `[browserwire:${sessionId}]` : "[browserwire]";
  return {
    info: (...args) => console.log(prefix, ...args),
    warn: (...args) => console.warn(prefix, ...args),
    error: (...args) => console.error(prefix, ...args),
  };
}
