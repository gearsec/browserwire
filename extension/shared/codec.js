/**
 * codec.js — Protobuf encode/decode adapter for BrowserWire WebSocket protocol
 *
 * Translates between the app-level { type, payload, requestId } interface
 * and protobuf binary Envelope frames.
 *
 * Usage:
 *   encode("hello", { client: "ext", version: "0.2.0" }, requestId) → Uint8Array
 *   decode(uint8Array) → { type: "hello", payload: { client: "ext", version: "0.2.0" }, requestId }
 */

import {
  create,
  toBinary,
  fromBinary,
  toJson as protoToJson,
  EnvelopeSchema,
  HelloSchema,
  HelloAckSchema,
  PingSchema,
  PongSchema,
  StatusSchema,
  ErrorSchema,
  DiscoverySessionStartSchema,
  DiscoverySessionStopSchema,
  DiscoverySessionStatusSchema,
  BatchProcessingStatusSchema,
  ExecuteWorkflowSchema,
  WorkflowResultSchema,
  ExecuteReadSchema,
  ReadResultSchema,
  BatchStatus,
} from "./proto-bundle.js";

// ─── Type ↔ oneof field name mapping ────────────────────────────────

const TYPE_TO_FIELD = {
  hello: "hello",
  hello_ack: "helloAck",
  ping: "ping",
  pong: "pong",
  status: "status",
  error: "error",
  discovery_session_start: "discoverySessionStart",
  discovery_session_stop: "discoverySessionStop",
  discovery_session_status: "discoverySessionStatus",
  batch_processing_status: "batchProcessingStatus",
  execute_workflow: "executeWorkflow",
  workflow_result: "workflowResult",
  execute_read: "executeRead",
  read_result: "readResult",
};

const FIELD_TO_TYPE = Object.fromEntries(
  Object.entries(TYPE_TO_FIELD).map(([k, v]) => [v, k])
);

const TYPE_TO_SCHEMA = {
  hello: HelloSchema,
  hello_ack: HelloAckSchema,
  ping: PingSchema,
  pong: PongSchema,
  status: StatusSchema,
  error: ErrorSchema,
  discovery_session_start: DiscoverySessionStartSchema,
  discovery_session_stop: DiscoverySessionStopSchema,
  discovery_session_status: DiscoverySessionStatusSchema,
  batch_processing_status: BatchProcessingStatusSchema,
  execute_workflow: ExecuteWorkflowSchema,
  workflow_result: WorkflowResultSchema,
  execute_read: ExecuteReadSchema,
  read_result: ReadResultSchema,
};

// ─── BatchStatus enum mapping ───────────────────────────────────────

const BATCH_STATUS_TO_PROTO = {
  pending: BatchStatus.PENDING,
  processing: BatchStatus.PROCESSING,
  complete: BatchStatus.COMPLETE,
  error: BatchStatus.ERROR,
};

const BATCH_STATUS_FROM_PROTO = Object.fromEntries(
  Object.entries(BATCH_STATUS_TO_PROTO).map(([k, v]) => [v, k])
);

// ─── JSON ↔ Proto conversion helpers ────────────────────────────────

/** Convert a base64 string to Uint8Array, or pass through Uint8Array */
const toBytes = (val) => {
  if (val instanceof Uint8Array) return val;
  if (typeof val === "string") {
    // Detect if it's base64
    if (typeof atob === "function") {
      try {
        const bin = atob(val);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return arr;
      } catch { /* not valid base64, treat as UTF-8 */ }
    }
    return new TextEncoder().encode(val);
  }
  if (val && typeof val === "object") {
    return new TextEncoder().encode(JSON.stringify(val));
  }
  return new Uint8Array(0);
};

/** Convert Uint8Array back to base64 string */
const bytesToBase64 = (bytes) => {
  if (!bytes || bytes.length === 0) return null;
  // Node.js
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  // Browser
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
};

/** Convert Uint8Array bytes field back to JSON object, or null */
const bytesToJson = (bytes) => {
  if (!bytes || bytes.length === 0) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
};

/** Convert JSON object to bytes for a proto bytes field */
const jsonToBytes = (val) => {
  if (val == null) return new Uint8Array(0);
  if (val instanceof Uint8Array) return val;
  return new TextEncoder().encode(JSON.stringify(val));
};

/**
 * Deep-convert a plain JS payload object to proto-compatible shape.
 * Handles: camelCase keys, bytes fields, enum mappings, nested messages.
 */
const payloadToProto = (type, payload) => {
  if (!payload || typeof payload !== "object") return {};

  // Type-specific transformations
  if (type === "batch_processing_status") {
    const result = { ...payload };
    if (typeof result.status === "string") {
      result.status = BATCH_STATUS_TO_PROTO[result.status] || BatchStatus.UNSPECIFIED;
    }
    // camelCase → snake_case field mapping handled by protobuf-es
    if (result.batchId !== undefined) { result.batchId = result.batchId; }
    if (result.sessionId !== undefined) { result.sessionId = result.sessionId; }
    return result;
  }

  if (type === "discovery_session_stop") {
    return convertSnapshotFields(payload, type);
  }

  if (type === "execute_read") {
    const result = { ...payload };
    if (result.apiRequest && typeof result.apiRequest === "object" && !(result.apiRequest instanceof Uint8Array)) {
      result.apiRequest = jsonToBytes(result.apiRequest);
    }
    if (result.apiFields && typeof result.apiFields === "object" && !(result.apiFields instanceof Uint8Array)) {
      result.apiFields = jsonToBytes(result.apiFields);
    }
    if (result.viewConfig && typeof result.viewConfig === "object" && !(result.viewConfig instanceof Uint8Array)) {
      result.viewConfig = jsonToBytes(result.viewConfig);
    }
    return result;
  }

  if (type === "read_result") {
    const result = { ...payload };
    if (result.data && typeof result.data === "object" && !(result.data instanceof Uint8Array)) {
      result.data = jsonToBytes(result.data);
    }
    return result;
  }

  if (type === "execute_workflow") {
    const result = { ...payload };
    if (result.steps && typeof result.steps === "object" && !(result.steps instanceof Uint8Array)) {
      result.steps = jsonToBytes(result.steps);
    }
    if (result.outcomes && typeof result.outcomes === "object" && !(result.outcomes instanceof Uint8Array)) {
      result.outcomes = jsonToBytes(result.outcomes);
    }
    return result;
  }

  if (type === "workflow_result") {
    const result = { ...payload };
    if (result.data && typeof result.data === "object" && !(result.data instanceof Uint8Array)) {
      result.data = jsonToBytes(result.data);
    }
    return result;
  }

  // For most message types, protobuf-es accepts camelCase keys directly
  return payload;
};

/** Convert snapshot-like payload fields for proto encoding */
const convertSnapshotFields = (payload, type) => {
  const result = { ...payload };

  // Convert screenshot from base64 string to bytes
  if (result.screenshot && typeof result.screenshot === "string") {
    result.screenshot = toBytes(result.screenshot);
  }

  // Convert network log entry bodies to bytes
  if (Array.isArray(result.networkLog)) {
    result.networkLog = result.networkLog.map((entry) => ({
      ...entry,
      requestBody: entry.requestBody ? jsonToBytes(entry.requestBody) : undefined,
      responseBody: entry.responseBody ? jsonToBytes(entry.responseBody) : undefined,
      queryParams: entry.queryParams || {},
    }));
  }

  // Convert nested pendingSnapshots recursively
  if (type === "discovery_session_stop" && Array.isArray(result.pendingSnapshots)) {
    result.pendingSnapshots = result.pendingSnapshots.map((snap) =>
      convertSnapshotFields(snap, "snapshot_payload")
    );
  }

  return result;
};

/**
 * Deep-convert a decoded proto message back to the plain JS shape
 * that the rest of the codebase expects.
 */
const protoToPayload = (type, protoMsg) => {
  if (!protoMsg) return {};

  // Convert to plain JS via JSON round-trip (handles BigInt, enums, etc.)
  const schema = TYPE_TO_SCHEMA[type];
  const plain = schema ? protoToJson(schema, protoMsg) : { ...protoMsg };

  if (type === "batch_processing_status") {
    const result = { ...plain };
    // Convert enum back to string
    if (typeof result.status === "number") {
      result.status = BATCH_STATUS_FROM_PROTO[result.status] || "unspecified";
    } else if (typeof result.status === "string") {
      // protobuf-es toJson() gives the enum name like "BATCH_STATUS_PENDING"
      const map = {
        BATCH_STATUS_PENDING: "pending",
        BATCH_STATUS_PROCESSING: "processing",
        BATCH_STATUS_COMPLETE: "complete",
        BATCH_STATUS_ERROR: "error",
      };
      result.status = map[result.status] || result.status;
    }
    return result;
  }

  if (type === "discovery_session_stop") {
    return revertSnapshotFields(plain, type);
  }

  if (type === "execute_read") {
    const result = { ...plain };
    if (result.apiRequest) {
      if (typeof result.apiRequest === "string") {
        try { result.apiRequest = JSON.parse(atob(result.apiRequest)); } catch { /* leave as-is */ }
      } else if (result.apiRequest instanceof Uint8Array) {
        result.apiRequest = bytesToJson(result.apiRequest);
      }
    }
    if (result.apiFields) {
      if (typeof result.apiFields === "string") {
        try { result.apiFields = JSON.parse(atob(result.apiFields)); } catch { /* leave as-is */ }
      } else if (result.apiFields instanceof Uint8Array) {
        result.apiFields = bytesToJson(result.apiFields);
      }
    }
    if (result.viewConfig) {
      if (typeof result.viewConfig === "string") {
        try { result.viewConfig = JSON.parse(atob(result.viewConfig)); } catch { /* leave as-is */ }
      } else if (result.viewConfig instanceof Uint8Array) {
        result.viewConfig = bytesToJson(result.viewConfig);
      }
    }
    return result;
  }

  if (type === "read_result") {
    const result = { ...plain };
    if (result.data) {
      if (typeof result.data === "string") {
        try { result.data = JSON.parse(atob(result.data)); } catch { /* leave as-is */ }
      } else if (result.data instanceof Uint8Array) {
        result.data = bytesToJson(result.data);
      }
    }
    return result;
  }

  if (type === "execute_workflow") {
    const result = { ...plain };
    for (const field of ["steps", "outcomes"]) {
      if (result[field]) {
        if (typeof result[field] === "string") {
          try { result[field] = JSON.parse(atob(result[field])); } catch { /* leave as-is */ }
        } else if (result[field] instanceof Uint8Array) {
          result[field] = bytesToJson(result[field]);
        }
      }
    }
    return result;
  }

  if (type === "workflow_result") {
    const result = { ...plain };
    if (result.data) {
      if (typeof result.data === "string") {
        try { result.data = JSON.parse(atob(result.data)); } catch { /* leave as-is */ }
      } else if (result.data instanceof Uint8Array) {
        result.data = bytesToJson(result.data);
      }
    }
    return result;
  }

  return plain;
};

/** Convert decoded proto snapshot fields back to the app-level shape */
const revertSnapshotFields = (plain, type) => {
  const result = { ...plain };

  // Convert screenshot bytes back to base64 string
  if (result.screenshot) {
    if (typeof result.screenshot === "string") {
      // Already base64 from toJson()
    } else if (result.screenshot instanceof Uint8Array) {
      result.screenshot = bytesToBase64(result.screenshot);
    }
  }

  // Convert network log entry bodies back to JSON
  if (Array.isArray(result.networkLog)) {
    result.networkLog = result.networkLog.map((entry) => {
      const e = { ...entry };
      if (e.requestBody) {
        if (typeof e.requestBody === "string") {
          try { e.requestBody = JSON.parse(atob(e.requestBody)); } catch { e.requestBody = null; }
        } else if (e.requestBody instanceof Uint8Array) {
          e.requestBody = bytesToJson(e.requestBody);
        }
      }
      if (e.responseBody) {
        if (typeof e.responseBody === "string") {
          try { e.responseBody = JSON.parse(atob(e.responseBody)); } catch { e.responseBody = null; }
        } else if (e.responseBody instanceof Uint8Array) {
          e.responseBody = bytesToJson(e.responseBody);
        }
      }
      return e;
    });
  }

  // Recurse into pendingSnapshots
  if (type === "discovery_session_stop" && Array.isArray(result.pendingSnapshots)) {
    result.pendingSnapshots = result.pendingSnapshots.map((snap) =>
      revertSnapshotFields(snap, "snapshot_payload")
    );
  }

  return result;
};

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Encode a message to a protobuf binary Uint8Array.
 *
 * @param {string} type - MessageType string (e.g. "hello", "discovery_session_stop")
 * @param {object} payload - The payload object
 * @param {string} [requestId] - Optional request ID for request/response correlation
 * @returns {Uint8Array} Binary protobuf frame
 */
export const encode = (type, payload = {}, requestId) => {
  const field = TYPE_TO_FIELD[type];
  if (!field) {
    throw new Error(`Unknown message type: ${type}`);
  }

  const schema = TYPE_TO_SCHEMA[type];
  const converted = payloadToProto(type, payload);
  const innerMsg = create(schema, converted);

  const envelope = create(EnvelopeSchema, {
    requestId: requestId || "",
    payload: { case: field, value: innerMsg },
  });

  return toBinary(EnvelopeSchema, envelope);
};

/**
 * Decode a protobuf binary frame back to the app-level message shape.
 *
 * @param {Uint8Array|ArrayBuffer} buffer - Binary protobuf frame
 * @returns {{ type: string, payload: object, requestId: string }|null}
 */
export const decode = (buffer) => {
  try {
    const bytes =
      buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer);

    const envelope = fromBinary(EnvelopeSchema, bytes);

    if (!envelope.payload || !envelope.payload.case) {
      return null;
    }

    const field = envelope.payload.case;
    const type = FIELD_TO_TYPE[field];

    if (!type) return null;

    const payload = protoToPayload(type, envelope.payload.value);

    return {
      type,
      payload,
      requestId: envelope.requestId || undefined,
    };
  } catch (err) {
    console.error("[codec] decode failed:", err);
    return null;
  }
};
