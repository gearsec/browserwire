# BrowserWire Core

[![Discord](https://img.shields.io/discord/1482040670632808662?logo=discord&label=Discord&color=5865F2)](https://discord.gg/dnG6KMPzT)

Stateless discovery pipeline for BrowserWire. Takes a recorded browser session (rrweb events) and produces a typed state machine manifest describing every view, action, and workflow on the site.

## What It Does

```
rrweb recording → segmentation → state classification → intent extraction → agent execution → manifest
```

The pipeline runs 5 sequential passes:
1. **Segmentation** — finds user action boundaries in the event stream
2. **Classification** — groups snapshots into semantic states via vision LLM
3. **Intent Extraction** — identifies REST API intents from states
4. **Agent Execution** — ReAct agents write Playwright code for views and actions
5. **Assembly** — builds a StateMachineManifest with states, views, actions, and transitions

## Usage

```javascript
import { runPipeline } from "@browserwire/core";

const result = await runPipeline({
  recording: { events, origin },
  config: {
    llmProvider: "anthropic",
    llmModel: "claude-sonnet-4-20250514",
    llmApiKey: "sk-...",
  },
  onProgress: ({ phase, tool }) => console.log(phase, tool),
  sessionId: "abc-123",
});

// result = { manifest, segmentation, totalToolCalls, error? }
```

## Package Exports

```javascript
import { runPipeline } from "@browserwire/core";           // Pipeline entry point
import { validateRecording } from "@browserwire/core/recording"; // Recording schemas
import { validateManifest } from "@browserwire/core/manifest";   // Manifest schemas
```

## Structure

```
core/
  pipeline/     — runPipeline() entry point + telemetry
  discovery/    — 5-pass orchestrator, state classifier, intent extractor, ReAct agents
  recording/    — rrweb event schemas, validation, segmentation
  manifest/     — StateMachineManifest schema, validation, builder
```

## Requirements

- Node.js 18+
- Playwright (optional, for snapshot replay)
- LLM API key (Anthropic, OpenAI, Gemini, or Ollama)

## Development

```bash
npm install
npm test
```

## License

MIT
