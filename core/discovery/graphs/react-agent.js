/**
 * react-agent.js — Shared ReAct agent subgraph factory for LangGraph.
 *
 * Creates a compiled subgraph with the standard ReAct loop:
 *   agent → [shouldContinue] → tools → agent (loop)
 *                             → __end__ (done)
 *
 * Used by planner, item-agent, and merge-agent.
 */

import { StateGraph, Annotation, messagesStateReducer, END } from "@langchain/langgraph";
import { SystemMessage, ToolMessage, HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { trimMessages } from "@langchain/core/messages";

// LangGraph's Send API serializes messages to JSON ({type: "constructor", id: [...], kwargs: {...}}).
// Both trimMessages and LLM invoke expect real BaseMessage instances. This helper converts them back.
const ensureMessageInstances = (messages) =>
  messages.map((m) => {
    if (m instanceof BaseMessage) return m;
    if (m?.type === "constructor" && Array.isArray(m.id)) {
      const type = m.id[m.id.length - 1];
      const kwargs = m.kwargs || {};
      switch (type) {
        case "SystemMessage": return new SystemMessage(kwargs);
        case "HumanMessage": return new HumanMessage(kwargs);
        case "AIMessage": return new AIMessage(kwargs);
        case "ToolMessage": return new ToolMessage(kwargs);
      }
    }
    return m;
  });

// ---------------------------------------------------------------------------
// State annotation for ReAct agent subgraphs
// ---------------------------------------------------------------------------

export const AgentAnnotation = Annotation.Root({
  messages: Annotation({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  done: Annotation({
    reducer: (_, b) => b,
    default: () => false,
  }),
  result: Annotation({
    reducer: (_, b) => b,
    default: () => null,
  }),
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a compiled ReAct agent subgraph.
 *
 * @param {object} options
 * @param {import('@langchain/core/language_models/chat_models').BaseChatModel} options.model
 * @param {import('@langchain/core/tools').StructuredToolInterface[]} options.tools
 * @param {string} options.submitToolName — name of the terminal tool (e.g. "submit_skeleton")
 * @param {string} options.systemPrompt — system message for the agent
 * @param {number} [options.recursionLimit=42] — max node transitions
 * @param {function} [options.onProgress] — called with { tool } on each tool execution
 * @param {string} [options.agentRole="agent"] — role label for progress callbacks
 * @returns {{ graph: CompiledGraph, invoke: (messages: BaseMessage[]) => Promise<{ result: any, done: boolean }> }}
 */
export function createReactAgent({
  model,
  tools,
  submitToolName,
  systemPrompt,
  recursionLimit = 42,
  onProgress,
  agentRole = "agent",
}) {
  const toolsByName = Object.fromEntries(tools.map((t) => [t.name, t]));
  const modelWithTools = model.bindTools(tools);

  // --- Agent node: call LLM with messages ---
  const agentNode = async (state) => {
    // If already done (submit tool returned valid), skip the extra LLM call.
    // The tools→agent edge always fires, but shouldContinue will route to END.
    if (state.done) {
      return { messages: [] };
    }

    let messages = ensureMessageInstances(state.messages);

    // Prune old messages if conversation is getting long
    const toolMsgCount = messages.filter((m) => m._getType?.() === "tool" || m instanceof ToolMessage).length;
    if (toolMsgCount > 6) {
      // Keep system + last ~8000 tokens worth of messages
      messages = await trimMessages(messages, {
        maxTokens: 8000,
        strategy: "last",
        tokenCounter: (msgs) => msgs.reduce((n, m) => {
          const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          return n + Math.ceil(content.length / 4);
        }, 0),
        includeSystem: true,
        startOn: "human",
      });
    }

    const response = await modelWithTools.invoke(messages);
    return { messages: [response] };
  };

  // --- Tools node: execute tool calls, check for submit ---
  const toolsNode = async (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const toolMessages = [];
    let done = false;
    let result = null;

    for (const toolCall of lastMessage.tool_calls || []) {
      const t = toolsByName[toolCall.name];
      if (!t) {
        toolMessages.push(new ToolMessage({
          content: JSON.stringify({ error: `Unknown tool: ${toolCall.name}` }),
          tool_call_id: toolCall.id,
          name: toolCall.name,
        }));
        continue;
      }

      let output;
      try {
        output = await t.invoke(toolCall.args);
      } catch (err) {
        output = JSON.stringify({ error: err.message });
      }

      if (onProgress) {
        onProgress({ tool: `${agentRole}:${toolCall.name}` });
      }

      toolMessages.push(new ToolMessage({
        content: typeof output === "string" ? output : JSON.stringify(output),
        tool_call_id: toolCall.id,
        name: toolCall.name,
      }));

      // Check if this is the submit tool returning valid
      if (toolCall.name === submitToolName) {
        try {
          const parsed = typeof output === "string" ? JSON.parse(output) : output;
          if (parsed.valid === true) {
            done = true;
            result = parsed;
          }
        } catch { /* not valid JSON, ignore */ }
      }
    }

    return { messages: toolMessages, done, ...(result ? { result } : {}) };
  };

  // --- Conditional edge: continue or stop ---
  const shouldContinue = (state) => {
    if (state.done) return END;
    const lastMessage = state.messages[state.messages.length - 1];
    if (lastMessage.tool_calls?.length > 0) return "tools";
    return END;
  };

  // --- Build graph ---
  const graph = new StateGraph(AgentAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue)
    .addEdge("tools", "agent")
    .compile();

  // --- Convenience invoke wrapper ---
  const invoke = async (userMessages) => {
    const messages = [
      new SystemMessage(systemPrompt),
      ...userMessages,
    ];

    const finalState = await graph.invoke(
      { messages },
      { recursionLimit }
    );

    return {
      result: finalState.result,
      done: finalState.done,
      messages: finalState.messages,
    };
  };

  return { graph, invoke };
}
