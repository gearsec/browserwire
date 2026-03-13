# BrowserWire

A contract layer between AI agents and websites. BrowserWire auto-discovers typed browser APIs from live pages so agents never touch the DOM directly — they call versioned, validated, scoped operations like `open_ticket(id: "1234")` through a manifest that defines what exists, what's callable, and how to find targets.

## How it works

```
Chrome Extension (discovers)     CLI Backend (builds manifest)     REST API (serves)
┌─────────────────────────┐     ┌──────────────────────────┐     ┌──────────────────┐
│ Content script scans    │────▶│ Vision LLM perceives     │────▶│ GET /api/sites   │
│ page skeleton +         │ WS  │ entities & actions        │     │ GET /api/sites/  │
│ screenshot annotation   │     │ Locator synthesis         │     │   :slug/docs     │
│                         │◀────│ Manifest compilation      │     │ POST execute     │
│ Sidepanel UI shows      │     │ Checkpoint merging        │     │                  │
│ discovered API          │     │                           │     │                  │
└─────────────────────────┘     └──────────────────────────┘     └──────────────────┘
```

1. **Extension** runs a skeleton scan on each page, captures an annotated screenshot, and sends both to the CLI backend over WebSocket
2. **CLI** uses a vision LLM to perceive entities and actions from the screenshot + skeleton, synthesizes locators, and compiles a typed `BrowserWireManifest`
3. **REST API** serves the discovered manifests so agents can query available actions and execute them

## Quick start

```bash
# Install BrowserWire
npm install -g browserwire

# Load the Chrome extension
# 1. Get the extension path
npx browserwire --extension-path
# 2. Open chrome://extensions
# 3. Enable "Developer mode"
# 4. Click "Load unpacked" → select the path printed above

# Configure your LLM provider (set in your shell or a .env file in the current directory)
export BROWSERWIRE_LLM_PROVIDER=openai   # or anthropic, gemini, ollama
export BROWSERWIRE_LLM_API_KEY=sk-...

# Start the server
browserwire

# See all options
browserwire --help

# Browse to any site, click "Start Exploring" in the BrowserWire sidepanel
# The CLI will discover and build a manifest for the site

# View discovered APIs
open http://localhost:8787/api/sites
```

You can also run without installing globally:

```bash
npx browserwire
```

## Extension permissions

BrowserWire requires the `<all_urls>` permission because it needs to inspect whatever site the user navigates to during discovery. The extension only activates when you explicitly start an exploration session — it does not run in the background or send data anywhere except the local CLI server.

## Project structure

| Directory | Description |
|-----------|-------------|
| `cli/` | Node.js CLI server — WebSocket handler, discovery pipeline, REST API |
| `cli/discovery/` | Discovery stages: perception, locator synthesis, compilation, enrichment |
| `cli/api/` | REST API router and bridge to discovery sessions |
| `extension/` | Chrome extension — content script, background worker, sidepanel UI |
| `extension/shared/` | Shared protocol definitions (message types, envelopes) |
| `src/contract-dsl/` | TypeScript contract DSL — manifest types, validation, compatibility, migration |
| `tests/` | Test suite (vitest) |
| `docs/` | Documentation — architecture (implemented subsystems) and design (speculative) |

## Configuration

BrowserWire loads configuration from multiple sources. **Precedence** (highest wins): CLI flags > environment variables / `.env` > config file > defaults.

### Environment variables

Copy `.env.example` to `.env` and configure, or set these in your shell:

| Variable | Description | Required |
|----------|-------------|----------|
| `BROWSERWIRE_LLM_PROVIDER` | LLM provider: `openai`, `anthropic`, `gemini`, `ollama` | Yes |
| `BROWSERWIRE_LLM_API_KEY` | API key for the provider | Yes (except ollama) |
| `BROWSERWIRE_LLM_MODEL` | Model name (default varies by provider) | No |
| `BROWSERWIRE_LLM_BASE_URL` | Custom endpoint URL (for ollama or proxies) | No |
| `BROWSERWIRE_HOST` | Server listen address (default: `127.0.0.1`) | No |
| `BROWSERWIRE_PORT` | Server listen port (default: `8787`) | No |

### Config file

You can optionally create `~/.browserwire/config.json` for persistent settings:

```json
{
  "llmProvider": "openai",
  "llmApiKey": "sk-...",
  "llmModel": "gpt-4o",
  "llmBaseUrl": "https://api.openai.com/v1",
  "host": "127.0.0.1",
  "port": 8787
}
```

All keys are optional. The file itself is optional. Environment variables and CLI flags always override config file values.

### CLI flags

```
browserwire --host 0.0.0.0 --port 3000 --debug
browserwire --llm-provider openai --llm-api-key sk-... --llm-model gpt-4o
```

Run `browserwire --help` to see all options. Use `--version` to print the version number.

### Provider defaults

| Provider | Default model | Default endpoint |
|----------|--------------|-----------------|
| `openai` | `gpt-4o` | `https://api.openai.com/v1` |
| `anthropic` | `claude-sonnet-4-20250514` | `https://api.anthropic.com` |
| `gemini` | `gemini-2.5-flash` | `https://generativelanguage.googleapis.com/v1beta/openai` |
| `ollama` | `llama3` | `http://localhost:11434` |

## API usage

Once the CLI server is running and you've explored a site:

```bash
# List all discovered sites
curl http://localhost:8787/api/sites

# Get the manifest/docs for a specific site
curl http://localhost:8787/api/sites/example-com/docs

# Execute an action (via the extension bridge)
curl -X POST http://localhost:8787/api/sites/example-com/execute \
  -H "Content-Type: application/json" \
  -d '{"actionId": "action_submit_login", "inputs": {"email": "user@example.com"}}'
```

## Development

To work on BrowserWire from source:

```bash
git clone https://github.com/gearsec/browserwire.git
cd browserwire
npm install
npm run cli:dev
```

## Contributing

PRs welcome! Please run tests before submitting:

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
