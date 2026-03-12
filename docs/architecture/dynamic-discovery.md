# Dynamic Discovery

Status: implemented

This document defines the architecture for **dynamic discovery** — extending static page scanning with interaction-triggered re-scanning to capture UI elements that are only revealed through user interaction (modals, tabs, dropdowns, SPA navigation).

Related:

- [Static Discovery](./static-discovery.md) — single-page scanning
- [Contract DSL](./contract-dsl.md) — manifest schema

## 1. Why dynamic discovery

Static discovery sees only what's visible at scan time. Real websites hide most of their UI behind interactions — tabbed panels, modals, accordions, dropdown menus, SPA route changes. Dynamic discovery captures these by re-scanning after each user interaction.

| Static discovery                  | Dynamic discovery                    |
| --------------------------------- | ------------------------------------ |
| One scan = one page state         | Many scans = accumulated UI states   |
| Misses hidden content             | Captures interaction-revealed UI     |
| No user behavior context          | Rich trigger context per snapshot    |
| Single manifest from one snapshot | Unified manifest from many snapshots |

## 2. Core design

### Interaction-triggered re-scanning

The extension runs rrweb recording and filters the event stream to detect user interactions. After each interaction, it waits for DOM mutations to settle and triggers a skeleton scan:

```
User clicks/types/navigates
  → rrweb emits MouseInteraction or Input event
  → DOM settle detection (300ms mutation silence or 3s hard timeout)
  → runSkeletonScan() from discovery.js (landmarks + interactables only, ~50-200 nodes)
  → background.js: captureVisibleTab → annotate screenshot with OffscreenCanvas
  → Tagged { skeleton, screenshot, trigger } sent to server
  → Server: perceiveSnapshot() (vision LLM, ~2.2K tokens) → focusAndInspect() → locators → manifest
  → Snapshot accumulated in session
```

### Vision-first single-pass LLM enrichment

The old dual-pass LLM design (Pass 1 per-snapshot + Pass 2 at session-end) is replaced with a **single vision LLM call per snapshot**:

- **Vision perception (per-snapshot)**: The LLM sees the annotated screenshot + compact HTML skeleton (~2.2K tokens). It identifies the domain, selects the 15–25 meaningful elements, assigns semantic names, and creates composite actions — all in one call.
- **No session-end LLM pass**: `finalize()` merges raw data across snapshots and re-compiles. Semantic names come from per-snapshot vision enrichment; the final merged manifest is structural.

This replaces ~18K tokens/call (exceeding 10K TPM rate limits) with ~2.2K tokens/call.

### Static scan subsumed

The old "Scan Page" feature is replaced — "Start Exploring" does an immediate initial scan (trigger kind: `"initial"`), then continues auto-scanning on interactions.

## 3. rrweb event detection

| rrweb Source           | Events                      | Role                |
| ---------------------- | --------------------------- | ------------------- |
| `MouseInteraction (2)` | Click, Focus, Blur, Touch\* | Interaction trigger |
| `Mutation (0)`         | DOM adds/removes/changes    | DOM settle signal   |
| `Input (5)`            | Text, checkbox, select      | Input trigger       |

SPA navigation detected via rrweb Meta events (type=4) + `hashchange`/`popstate` fallback.

## 4. Rich trigger context

Each snapshot carries behavioral context about the user's interaction:

```ts
interface InteractionTrigger {
  kind: "initial" | "click" | "input" | "navigation";
  target: {
    tag: string;
    text: string;
    role: string | null;
    name: string | null;
    attributes: Record<string, string>;
  } | null;
  parentContext: {
    nearestLandmark: string | null;
    nearestHeading: string | null;
  } | null;
  url: string;
  title: string;
  timestamp: number;
}
```

## 5. Architecture

```
Extension (content-script.js)
  rrweb.record() emit → discovery observer
    ├─ On session start → immediate initial scan
    ├─ On interaction → capture trigger context
    ├─ On mutation silence → runSkeletonScan() (~50-200 nodes)
    └─ Send { skeleton, trigger, ... } to background.js

Extension (background.js)
    ├─ captureVisibleTab → JPEG screenshot
    ├─ annotateScreenshot() — OffscreenCanvas: draw boxes + s-IDs
    └─ Send { skeleton, screenshot, trigger } to CLI server

CLI Server
  DiscoverySession
    ├─ Per-snapshot: perceiveSnapshot() (vision LLM, ~2.2K tokens)
    │               focusAndInspect() → locators → compileManifest → mergeEnrichment
    ├─ Accumulate enriched per-snapshot manifests
    ├─ On session stop: merge raw data → compileManifest (no LLM Pass 2)
    └─ Output: manifest.json (structural), per-snapshot manifests have semantic names
```

## 6. Protocol messages

| Message                    | Direction          | Purpose                                     |
| -------------------------- | ------------------ | ------------------------------------------- |
| `DISCOVERY_SESSION_START`  | extension → server | Begin exploration session                   |
| `DISCOVERY_SESSION_STOP`   | extension → server | End session, finalize manifest              |
| `DISCOVERY_INCREMENTAL`    | extension → server | Tagged snapshot with trigger                |
| `DISCOVERY_SESSION_STATUS` | server → extension | Live stats                                  |
| `CHECKPOINT`               | extension → server | Flush buffered snapshots, compile checkpoint |
| `CHECKPOINT_COMPLETE`      | server → extension | Checkpoint done, updated manifest attached  |

### 6.1. Checkpoint protocol

Checkpoints allow users to save intermediate progress during an exploration session without stopping.

#### Flow

1. **Extension buffers snapshots locally** in `pendingSnapshots[]` — no backend calls during normal exploration
2. **User clicks "Checkpoint"** → extension sends all buffered snapshots to the server, followed by a `CHECKPOINT` message (with optional note)
3. **Server processes snapshots** then calls `session.compileCheckpoint(note)` → writes `checkpoint-N.json` to the session log directory
4. **Server replies `CHECKPOINT_COMPLETE`** with the updated manifest attached
5. **Extension clears buffer**, removes the checkpoint overlay, and renders the updated API in the sidepanel

#### Stop behavior

"Stop Exploring" flushes any remaining `pendingSnapshots` in the stop payload, ensuring no buffered snapshots are lost.

## 7. Output files

```
logs/session-{sessionId}/
  ├─ manifest.json          ← enriched unified manifest
  ├─ manifest-draft.json    ← deterministic draft
  └─ session.json           ← session metadata + trigger journey
```

## 8. Implementation modules

```
extension/
  content-script.js         // Discovery observer (rrweb filter + DOM settle + trigger context)
  discovery.js              // runSkeletonScan() — Stage 1 skeleton walk (used by dynamic discovery)
                            // runDiscoveryScan() — legacy full-DOM scan

cli/discovery/
  session.js                // DiscoverySession + SnapshotMerger + single-pass vision orchestration + checkpoint support
  classify.js               // Stage 3 (unchanged)
  entities.js               // Stage 4 (unchanged)
  locators.js               // Stage 5 (unchanged)
  compile.js                // Stage 6 (unchanged)
  enrich.js                 // Stage 7 LLM enrichment (unchanged)

extension/shared/
  protocol.js               // DISCOVERY_SESSION_* message types
```
