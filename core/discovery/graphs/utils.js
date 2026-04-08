/**
 * utils.js — Shared utilities for LangGraph graphs.
 */

import { ToolMessage } from "@langchain/core/messages";

// ---------------------------------------------------------------------------
// Message compaction — truncate old large tool results to save tokens
// ---------------------------------------------------------------------------

const COMPACT_THRESHOLD = 5000; // chars

const compactMessages = (messages) => {
  // Find indices of all tool messages
  const toolIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] instanceof ToolMessage || messages[i]._getType?.() === "tool") {
      toolIndices.push(i);
    }
  }
  // Keep the last 2 tool results intact; truncate older large ones
  const cutoff = toolIndices.length > 2 ? toolIndices[toolIndices.length - 2] : messages.length;

  return messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (!(m instanceof ToolMessage || m._getType?.() === "tool")) return m;
    // Multimodal content (images) is always large — compact it
    if (Array.isArray(m.content)) {
      return new ToolMessage({
        content: "[Truncated: multimodal content. Re-call tool if needed.]",
        tool_call_id: m.tool_call_id,
        name: m.name,
      });
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (content.length <= COMPACT_THRESHOLD) return m;
    return new ToolMessage({
      content: `[Truncated: ${content.length} chars. Re-call tool if needed.]`,
      tool_call_id: m.tool_call_id,
      name: m.name,
    });
  });
};

/**
 * preModelHook for the prebuilt createReactAgent.
 * Compacts old large tool messages to save tokens before each LLM call.
 */
export const compactMessagesHook = (state) => {
  return { llmInputMessages: compactMessages(state.messages) };
};
