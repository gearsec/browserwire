/**
 * llm-client.js — Thin LLM provider abstraction for Stage 7.
 *
 * Supports OpenAI-compatible, Anthropic, and Ollama endpoints via
 * environment variables:
 *
 *   BROWSERWIRE_LLM_PROVIDER  = openai | anthropic | ollama
 *   BROWSERWIRE_LLM_MODEL     = model name (default varies by provider)
 *   BROWSERWIRE_LLM_API_KEY   = API key (not needed for ollama)
 *   BROWSERWIRE_LLM_BASE_URL  = custom endpoint (default varies by provider)
 */

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5000;

const PROVIDER_DEFAULTS = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    path: "/chat/completions"
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    path: "/chat/completions"
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    path: "/v1/messages"
  },
  ollama: {
    baseUrl: "http://localhost:11434",
    model: "llama3",
    path: "/api/chat"
  }
};

/**
 * Read LLM configuration from environment variables.
 * Returns null if no provider is configured.
 */
export const getLLMConfig = () => {
  const provider = process.env.BROWSERWIRE_LLM_PROVIDER;
  if (!provider) return null;

  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    console.warn(`[browserwire-cli] unknown LLM provider: ${provider}`);
    return null;
  }

  return {
    provider,
    model: process.env.BROWSERWIRE_LLM_MODEL || defaults.model,
    apiKey: process.env.BROWSERWIRE_LLM_API_KEY || "",
    baseUrl: process.env.BROWSERWIRE_LLM_BASE_URL || defaults.baseUrl,
    path: defaults.path
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
