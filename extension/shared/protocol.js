export const PROTOCOL_VERSION = "0.2.0";

export const MessageType = Object.freeze({
  HELLO: "hello",
  HELLO_ACK: "hello_ack",
  PING: "ping",
  PONG: "pong",
  STATUS: "status",
  ERROR: "error",
  DISCOVERY_SCAN: "discovery_scan",
  DISCOVERY_SESSION_START: "discovery_session_start",
  DISCOVERY_SESSION_STOP: "discovery_session_stop",
  DISCOVERY_SESSION_STATUS: "discovery_session_status",
  BATCH_PROCESSING_STATUS: "batch_processing_status",
  EXECUTE_WORKFLOW: "execute_workflow",
  WORKFLOW_RESULT: "workflow_result",
  EXECUTE_READ: "execute_read",
  READ_RESULT: "read_result"
});

export const createEnvelope = (type, payload = {}, requestId) => ({
  type,
  payload,
  requestId
});

export const parseEnvelope = (raw) => {
  if (typeof raw !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed.type !== "string") {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};
