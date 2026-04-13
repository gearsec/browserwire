/**
 * ai-provider.js — Maps BrowserWire config to a LangChain ChatModel instance.
 *
 * Single export:
 *   createModel(config) — pure factory, no singleton dependency
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";

/**
 * Create a LangChain ChatModel instance from an explicit config object.
 * Pure function — no singleton access.
 *
 * @param {{ llmProvider: string, llmModel: string, llmApiKey: string, llmBaseUrl?: string }} config
 * @returns {import("@langchain/core/language_models/chat_models").BaseChatModel | null}
 */
export function createModel(config) {
  if (!config.llmProvider) return null;

  switch (config.llmProvider) {
    case "openai":
      return new ChatOpenAI({
        model: config.llmModel,
        apiKey: config.llmApiKey,
        temperature: 0.3,
        timeout: 120_000,
        ...(config.llmBaseUrl ? { configuration: { baseURL: config.llmBaseUrl } } : {}),
      });

    case "anthropic":
      return new ChatAnthropic({
        model: config.llmModel,
        apiKey: config.llmApiKey,
        temperature: 0.3,
        clientOptions: { timeout: 120_000 },
      });

    case "gemini":
      return new ChatGoogleGenerativeAI({
        model: config.llmModel,
        apiKey: config.llmApiKey,
        temperature: 0.3,
      });

    case "ollama":
      return new ChatOpenAI({
        model: config.llmModel,
        apiKey: "ollama",
        temperature: 0.3,
        timeout: 120_000,
        configuration: { baseURL: config.llmBaseUrl || "http://localhost:11434/v1" },
      });

    default:
      throw new Error(`Unknown LLM provider: ${config.llmProvider}`);
  }
}

