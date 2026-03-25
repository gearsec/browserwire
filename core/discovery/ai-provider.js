/**
 * ai-provider.js — Maps BrowserWire config to a LangChain ChatModel instance.
 *
 * Uses the centralized config singleton to resolve the correct provider + model.
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { getConfig } from "../config.js";

/**
 * Return a LangChain ChatModel instance based on the current BrowserWire config.
 * Returns null if no LLM provider is configured.
 */
export const getModel = () => {
  const cfg = getConfig();
  if (!cfg.llmProvider) return null;

  switch (cfg.llmProvider) {
    case "openai":
      return new ChatOpenAI({
        model: cfg.llmModel,
        apiKey: cfg.llmApiKey,
        temperature: 0.3,
        ...(cfg.llmBaseUrl ? { configuration: { baseURL: cfg.llmBaseUrl } } : {}),
      });

    case "anthropic":
      return new ChatAnthropic({
        model: cfg.llmModel,
        apiKey: cfg.llmApiKey,
        temperature: 0.3,
      });

    case "gemini":
      return new ChatGoogleGenerativeAI({
        model: cfg.llmModel,
        apiKey: cfg.llmApiKey,
        temperature: 0.3,
      });

    case "ollama":
      return new ChatOpenAI({
        model: cfg.llmModel,
        apiKey: "ollama",
        temperature: 0.3,
        configuration: { baseURL: cfg.llmBaseUrl || "http://localhost:11434/v1" },
      });

    default:
      throw new Error(`Unknown LLM provider: ${cfg.llmProvider}`);
  }
};
