/**
 * llm-client.js — Thin LLM provider abstraction.
 *
 * LLM configuration is managed by cli/config.js (centralized config module).
 * This module reads from the config singleton via getConfig().
 */

import { getConfig } from "../config.js";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5000;

/**
 * Read LLM configuration from the centralized config singleton.
 * Returns null if no provider is configured.
 */
export const getLLMConfig = () => {
  const cfg = getConfig();
  if (!cfg.llmProvider) return null;

  return {
    provider: cfg.llmProvider,
    model: cfg.llmModel,
    apiKey: cfg.llmApiKey || "",
    baseUrl: cfg.llmBaseUrl,
    path: cfg.llmPath
  };
};

/**
 * Call the configured LLM with a vision prompt: annotated screenshot + HTML skeleton.
 * Supports OpenAI-compatible (gpt-4o etc.) and Anthropic (claude-*) vision formats.
 * Reuses the same retry/rate-limit logic as callLLM.
 *
 * @param {string} systemPrompt
 * @param {string} screenshotBase64 - base64-encoded JPEG
 * @param {string} textContent - HTML skeleton + page context string
 * @param {object} config - from getLLMConfig()
 * @returns {Promise<string>}
 */
export const callLLMWithVision = async (systemPrompt, screenshotBase64, textContent, config) => {
  if (!config) {
    throw new Error("LLM not configured");
  }

  const approxTokens = Math.round((systemPrompt.length + textContent.length) / 4) + 85;
  console.log(
    `[browserwire-cli] vision LLM call → ${config.provider}/${config.model} ` +
    `(~${approxTokens} tokens total)`
  );

  const url = `${config.baseUrl}${config.path}`;

  if (config.provider === "anthropic") {
    return callAnthropicVision(url, systemPrompt, screenshotBase64, textContent, config);
  }

  return callOpenAIVision(url, systemPrompt, screenshotBase64, textContent, config);
};

/**
 * OpenAI vision call (gpt-4o, etc.).
 */
const callOpenAIVision = async (url, systemPrompt, screenshotBase64, textContent, config) => {
  const headers = { "Content-Type": "application/json" };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` }
          },
          { type: "text", text: textContent }
        ]
      }
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = await getRetryDelay(response, attempt);
      console.log(`[browserwire-cli] rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }
};

/**
 * Anthropic vision call (claude-* with vision support).
 */
const callAnthropicVision = async (url, systemPrompt, screenshotBase64, textContent, config) => {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01"
  };

  const body = {
    model: config.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: screenshotBase64
            }
          },
          { type: "text", text: textContent }
        ]
      }
    ]
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = await getRetryDelay(response, attempt);
      console.log(`[browserwire-cli] rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text || "";
  }
};

/**
 * Call the configured LLM with a system prompt and user message.
 * Returns the raw text response.
 *
 * @param {string} systemPrompt
 * @param {string} userMessage
 * @param {object} config - from getLLMConfig()
 * @returns {Promise<string>}
 */
export const callLLM = async (systemPrompt, userMessage, config) => {
  if (!config) {
    throw new Error("LLM not configured");
  }

  const inputChars = systemPrompt.length + userMessage.length;
  const approxTokens = Math.round(inputChars / 4);
  console.log(
    `[browserwire-cli] LLM call → ${config.provider}/${config.model} ` +
    `(~${approxTokens} tokens, ${Math.round(inputChars / 1024)}KB input)`
  );

  const url = `${config.baseUrl}${config.path}`;

  if (config.provider === "anthropic") {
    return callAnthropic(url, systemPrompt, userMessage, config);
  }

  // OpenAI-compatible (also works for Ollama)
  return callOpenAICompatible(url, systemPrompt, userMessage, config);
};

/**
 * Sleep for the given number of milliseconds.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract retry delay from a 429 response.
 * Checks the Retry-After header first, then tries to parse the error body.
 */
const getRetryDelay = async (response, attempt) => {
  // Check Retry-After header
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Try to parse delay hint from error body (OpenAI includes "Please try again in Xs")
  try {
    const text = await response.clone().text();
    const match = text.match(/try again in ([\d.]+)s/i);
    if (match) {
      return Math.ceil(parseFloat(match[1]) * 1000);
    }
  } catch {}

  // Exponential backoff fallback
  return BASE_RETRY_DELAY_MS * 2 ** attempt;
};

/**
 * OpenAI-compatible API call (also works for Ollama).
 */
const callOpenAICompatible = async (url, systemPrompt, userMessage, config) => {
  const headers = {
    "Content-Type": "application/json"
  };
  if (config.apiKey) {
    headers["Authorization"] = `Bearer ${config.apiKey}`;
  }

  const body = {
    model: config.model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage }
    ],
    temperature: 0.2,
    response_format: { type: "json_object" }
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = await getRetryDelay(response, attempt);
      console.log(`[browserwire-cli] rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`LLM API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "";
  }
};

/**
 * Anthropic Messages API call.
 */
const callAnthropic = async (url, systemPrompt, userMessage, config) => {
  const headers = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "anthropic-version": "2023-06-01"
  };

  const body = {
    model: config.model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [
      { role: "user", content: userMessage }
    ]
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = await getRetryDelay(response, attempt);
      console.log(`[browserwire-cli] rate limited, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "unknown");
      throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const textBlock = data.content?.find((b) => b.type === "text");
    return textBlock?.text || "";
  }
};
