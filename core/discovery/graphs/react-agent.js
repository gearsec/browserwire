/**
 * react-agent.js — ReAct agent factory using LangGraph prebuilt.
 *
 * Wraps @langchain/langgraph/prebuilt's createReactAgent with:
 *   - compactMessages preModelHook (truncates old large tool results)
 *   - Tools with returnDirect support (done tool exits immediately)
 *
 * Used by state-agent.
 */

export { createReactAgent } from "@langchain/langgraph/prebuilt";
export { compactMessagesHook } from "./utils.js";
