# BrowserWire

[![Discord](https://img.shields.io/discord/1482040670632808662?logo=discord&label=Discord&color=5865F2)](https://discord.gg/dnG6KMPzT)

A contract layer between AI agents and websites. BrowserWire discovers typed APIs from live web pages so your agents can call operations like `submit_login(email, password)` instead of scraping the DOM. Point it at any site, explore, and get a versioned manifest of everything the page can do — served as a REST API your agent already knows how to call.

```
You browse a site → BrowserWire watches → You get a typed API
```

The discovery pipeline uses a vision LLM to perceive what's on the page, synthesizes reliable locators, and compiles a manifest with entities, actions, and input schemas. The result is served as an OpenAPI-compatible REST API with Swagger docs.

## Getting Started

### 1. Install the CLI

```bash
npm install -g browserwire
```

Or run directly without installing:

```bash
npx browserwire
```

### 2. Install the Chrome Extension

> **Note:** The Chrome Web Store release is in progress. For now, the extension must be loaded as an unpacked extension in developer mode.

```bash
# Print the path to the bundled extension directory
npx browserwire --extension-path
```

Then in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the path printed above

### 3. Configure an LLM Provider

BrowserWire needs a vision-capable LLM to perceive page content. Set your provider via environment variables, a `.env` file, or `~/.browserwire/config.json`.

```bash
export BROWSERWIRE_LLM_PROVIDER=openai   # openai | anthropic | gemini | ollama
export BROWSERWIRE_LLM_API_KEY=sk-...
```

Supported providers and their defaults:

| Provider | Default Model | Requires API Key |
|----------|--------------|-----------------|
| `openai` | `gpt-4o` | Yes |
| `anthropic` | `claude-sonnet-4-20250514` | Yes |
| `gemini` | `gemini-2.5-flash` | Yes |
| `ollama` | `llama3` | No |

### 4. Start the Server

```bash
browserwire
```

The server starts on `http://127.0.0.1:8787` by default. The API docs landing page is at `http://127.0.0.1:8787/api/docs`.

## Usage

### Discovering a Site

1. Start the BrowserWire server (`browserwire`)
2. Open any website in Chrome
3. Open the BrowserWire sidepanel (click the extension icon)
4. Click **Start Exploring** and navigate around the site
5. Click **Stop Exploring** when done — the CLI builds a manifest in the background

### Querying Discovered APIs

```bash
# List all discovered sites
curl http://localhost:8787/api/sites

# View the manifest for a site
curl http://localhost:8787/api/sites/example-com/manifest

# OpenAPI spec (feed this to your agent)
curl http://localhost:8787/api/sites/example-com/openapi.json

# Interactive Swagger docs
open http://localhost:8787/api/sites/example-com/docs
```

### Executing Actions

Once a site is discovered, your agent can execute actions through the REST API:

```bash
curl -X POST http://localhost:8787/api/sites/example-com/workflows/submit_login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret"}'
```

The server routes the action through the Chrome extension, which executes it on the live page using the discovered locators.

### Feeding to an AI Agent

The OpenAPI spec at `/api/sites/:slug/openapi.json` is designed to be consumed directly by tool-using LLMs. Point your agent at the spec and it can discover and call available actions without any manual wiring.

## Configuration

BrowserWire loads config from multiple sources. Precedence (highest wins): **CLI flags > environment variables / `.env` > config file > defaults**.

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `BROWSERWIRE_LLM_PROVIDER` | LLM provider (`openai`, `anthropic`, `gemini`, `ollama`) | Yes |
| `BROWSERWIRE_LLM_API_KEY` | API key for the provider | Yes (except `ollama`) |
| `BROWSERWIRE_LLM_MODEL` | Override default model | No |
| `BROWSERWIRE_LLM_BASE_URL` | Custom endpoint (for ollama or proxies) | No |
| `BROWSERWIRE_HOST` | Listen address (default: `127.0.0.1`) | No |
| `BROWSERWIRE_PORT` | Listen port (default: `8787`) | No |

### Config File

Optionally create `~/.browserwire/config.json`:

```json
{
  "llmProvider": "openai",
  "llmApiKey": "sk-...",
  "llmModel": "gpt-4o"
}
```

### CLI Flags

```bash
browserwire --host 0.0.0.0 --port 3000 --debug
browserwire --llm-provider anthropic --llm-api-key sk-ant-...
browserwire --help
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/sites` | List all discovered sites |
| `GET` | `/api/docs` | Landing page with site index |
| `GET` | `/api/sites/:slug/manifest` | Raw manifest JSON |
| `GET` | `/api/sites/:slug/openapi.json` | OpenAPI 3.0 spec |
| `GET` | `/api/sites/:slug/docs` | Swagger UI for the site |
| `POST` | `/api/sites/:slug/workflows/:name` | Execute a workflow |

## Development

```bash
git clone https://github.com/gearsec/browserwire.git
cd browserwire
npm install
npm run cli:dev
```

```bash
npm test              # Run tests
npm run typecheck     # Type check
npm run build         # Build TypeScript
```

### Project Structure

```
cli/                  # Node.js server — WebSocket, discovery pipeline, REST API
cli/discovery/        # Pipeline stages: perception, locators, compilation
cli/api/              # REST API router, OpenAPI generation, Swagger UI
extension/            # Chrome extension — content script, sidepanel, executor
src/contract-dsl/     # TypeScript manifest types, validation, versioning
tests/                # Test suite (vitest)
docs/                 # Architecture and design docs
```

## Extension Permissions

BrowserWire requires the `<all_urls>` permission to inspect whatever site you navigate to during discovery. The extension only activates when you explicitly start an exploration session — it does not run in the background or send data anywhere except the local CLI server.

## Contributing

PRs welcome. Please run tests before submitting:

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
