/**
 * ai-provider.js — Maps BrowserWire config to a Vercel AI SDK model instance.
 *
 * Uses the centralized config singleton (cli/config.js) to resolve the
 * correct provider + model for use with `generateText()`.
 */

import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { getConfig } from "../config.js";

/**
 * Return a Vercel AI SDK model instance based on the current BrowserWire config.
 * Returns null if no LLM provider is configured.
 */
export const getModel = () => {
  const cfg = getConfig();
  if (!cfg.llmProvider) return null;

  switch (cfg.llmProvider) {
    case "openai":
      return createOpenAI({
        apiKey: cfg.llmApiKey,
        ...(cfg.llmBaseUrl ? { baseURL: cfg.llmBaseUrl } : {})
      })(cfg.llmModel);

    case "anthropic":
      return createAnthropic({
        apiKey: cfg.llmApiKey
      })(cfg.llmModel);

    case "gemini":
      return createGoogleGenerativeAI({
        apiKey: cfg.llmApiKey
      })(cfg.llmModel);

    case "ollama":
      return createOpenAI({
        baseURL: cfg.llmBaseUrl || "http://localhost:11434/v1",
        apiKey: "ollama"
      })(cfg.llmModel);

    default:
      throw new Error(`Unknown LLM provider: ${cfg.llmProvider}`);
  }
};
