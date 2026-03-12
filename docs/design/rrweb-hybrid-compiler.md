# rrweb to DSL Hybrid Compiler Design

> **Status: Design Only — Not Implemented**
>
> This document describes a speculative architecture that was explored early in the project.
> The actual implementation uses a vision-first pipeline described in [static-discovery.md](../architecture/static-discovery.md).

This document defines a detailed architecture for compiling live rrweb capture streams into BrowserWire contract DSL artifacts using a hybrid approach:

1. deterministic preprocessing and semantic compression
2. LLM semantic extraction over compact IR
3. deterministic compilation, validation, and compatibility gating

This is intentionally detailed and jargon-heavy so it can act as a systems design reference during implementation.

## 1. Why this architecture exists

Raw rrweb streams are high-cardinality, low-level telemetry:

- they are verbose (full snapshots can be very large)
- they contain interaction noise (mousemove bursts, repeated scroll, transient mutations)
- they are not directly aligned with contract-level concepts like `EntityDef` or `ActionDef`

Directly prompting an LLM with raw rrweb payloads is expensive, unstable, and hard to make deterministic. The hybrid compiler reduces entropy first, then uses the LLM only for semantic inference.

## 2. Current repository baseline (already present)

Capture and transport are already operational:

- content script recording and batching in `extension/content-script.js`
- protocol envelope and message types in `extension/shared/protocol.js`
- websocket backend receive/ack and NDJSON raw logging in `cli/server.js`

Contract layer already exists and is strict:

- manifest and enums in `src/contract-dsl/types.ts`
- validator in `src/contract-dsl/validate.ts`
- semver compatibility policy in `src/contract-dsl/compatibility.ts`
- semver parser/utilities in `src/contract-dsl/semver.ts`
- migration registry in `src/contract-dsl/migration.ts`

This design uses those as hard constraints.

## 3. End-to-end flow

```text
Extension rrweb capture batches
  -> Stage 1 BatchIngest
  -> Stage 2 EventNormalize
  -> Stage 3 DomStateRebuild
  -> Stage 4 InteractionExtract
  -> Stage 5 TargetResolve
  -> Stage 6 LocatorSynthesis
  -> Stage 7 EpisodeChunking
  -> Stage 8 TraceIRBuild
  -> Stage 9 LLMExtract (ManifestPatch only)
  -> Stage 10 DeterministicCompile
  -> Stage 11 ValidateAndRepair
  -> Stage 12 CompatibilityGate
  -> Candidate BrowserWireManifest
```

Note: PII redaction is intentionally excluded in this revision.

## 4. Core design principles

- deterministic layers own invariants, referential integrity, and schema conformance
- LLM layer only owns semantic labeling and high-level mapping
- all stage outputs are explicit, inspectable, and replayable
- failures should be fail-closed at publish boundaries
- manifests should be reproducible from raw trace + deterministic config

## 5. Stage-by-stage specification

## Stage 1 - BatchIngest

### Plain-language purpose

Collect incoming batches and ensure each session timeline is in the correct order.

### Inputs

- websocket `CAPTURE_BATCH` payloads
- fields include `sessionId`, `sequence`, `events[]`, `capturedAt`, `url`, `title`, `reason`

### Outputs

- ordered stream of `OrderedBatch` records per session

### Responsibilities

- sequencing and monotonicity enforcement
- duplicate suppression (idempotency)
- bounded out-of-order buffering (reorder window)
- missing sequence detection and gap annotation
- per-session lifecycle state (`started`, `active`, `stopped`, `expired`)

### Data model

```ts
interface OrderedBatch {
  sessionId: string;
  sequence: number;
  receivedAt: string;
  capturedAt: string | null;
  url: string;
  title: string;
  reason: string;
  events: unknown[];
}

interface SessionIngestState {
  expectedSequence: number;
  highWatermark: number;
  reorderBuffer: Map<number, OrderedBatch>;
  seenSequences: Set<number>;
  lastActivityAt: number;
}
```

### Jargon

- idempotency key
- high-watermark
- reorder window
- at-least-once delivery compensation
- monotonic sequence guarantee

### Failure handling

- stale duplicate sequence: drop silently with metric increment
- sequence gap exceeding timeout: emit gap marker and continue
- malformed payload: quarantine + structured error log

### Observability

- `ingest_batches_total`
- `ingest_duplicates_total`
- `ingest_gaps_total`
- `ingest_reorder_buffer_size`

## Stage 2 - EventNormalize

### Plain-language purpose

Translate rrweb numeric event codes and source enums into readable canonical event objects.

### Inputs

- `OrderedBatch.events[]`
- rrweb enums (`EventType`, `IncrementalSource`)

### rrweb canonical mapping

- `EventType.DomContentLoaded (0)` -> `dom_content_loaded`
- `EventType.Load (1)` -> `load`
- `EventType.FullSnapshot (2)` -> `full_snapshot`
- `EventType.IncrementalSnapshot (3)` -> resolve by incremental source
- `EventType.Meta (4)` -> `meta`
- `EventType.Custom (5)` -> `custom`
- `EventType.Plugin (6)` -> `plugin`

Incremental source examples:

- `Mutation (0)`
- `MouseMove (1)`
- `MouseInteraction (2)`
- `Scroll (3)`
- `ViewportResize (4)`
- `Input (5)`
- `TouchMove (6)`
- `MediaInteraction (7)`
- `StyleSheetRule (8)`
- `CanvasMutation (9)`
- `Font (10)`
- `Log (11)`
- `Drag (12)`
- `StyleDeclaration (13)`
- `Selection (14)`
- `AdoptedStyleSheet (15)`
- `CustomElement (16)`

### Outputs

- `NormalizedEvent[]`

### Data model

```ts
type NormalizedKind =
  | "dom_content_loaded"
  | "load"
  | "meta"
  | "full_snapshot"
  | "mutation"
  | "mouse_move"
  | "mouse_interaction"
  | "scroll"
  | "viewport_resize"
  | "input"
  | "touch_move"
  | "media_interaction"
  | "style_sheet_rule"
  | "canvas_mutation"
  | "font"
  | "log"
  | "drag"
  | "style_declaration"
  | "selection"
  | "adopted_style_sheet"
  | "custom_element"
  | "custom"
  | "plugin"
  | "unknown";

interface NormalizedEvent {
  sessionId: string;
  sequence: number;
  eventIndex: number;
  ts: number;
  url: string;
  title: string;
  kind: NormalizedKind;
  rrwebType: number;
  rrwebSource?: number;
  payload: Record<string, unknown>;
}
```

### Jargon

- canonicalization
- schema-on-read
- event taxonomy
- lossy-vs-lossless normalization (target is lossless in critical fields)

### Failure handling

- unknown event type/source: keep as `unknown` with raw payload
- missing timestamp: synthesize from ingest time and annotate synthetic flag

### Observability

- distribution of kinds
- unknown-kind rate
- malformed-event count

## Stage 3 - DomStateRebuild

### Plain-language purpose

Recreate what the page DOM looked like over time so downstream logic can understand what changed.

### Inputs

- normalized events, especially `full_snapshot` and `mutation`

### Outputs

- temporal DOM mirror snapshots (`DomState` lookup at event boundaries)

### Core mechanics

- initialize mirror from `full_snapshot.data.node`
- apply mutation batches (`adds`, `removes`, `texts`, `attributes`)
- maintain fast index by node id
- maintain parent-child adjacency to preserve topology

### Data model

```ts
interface DomNode {
  id: number;
  parentId: number | null;
  tagName?: string;
  textContent?: string;
  attributes: Record<string, string>;
  childIds: number[];
  alive: boolean;
}

interface DomState {
  version: number;
  ts: number;
  nodeMap: Map<number, DomNode>;
}
```

### Jargon

- event-sourced state machine
- materialized view
- temporal reconstruction
- mutation replay
- topology consistency

### Failure handling

- mutation references unknown node id: record divergence issue
- remove missing node: soft-ignore with anomaly counter
- prolonged divergence: checkpoint reset on next full snapshot

### Observability

- node count over time
- mutation apply failure rate
- full snapshot reset count

## Stage 4 - InteractionExtract

### Plain-language purpose

Convert many low-level events into fewer human-like actions.

### Inputs

- normalized events + dom state context

### Outputs

- `Interaction[]`

### Typical patterns

- click pattern: `mousedown + mouseup + click`
- typing pattern: `focus + input* + blur`
- scroll segment: multiple scroll events merged by temporal proximity
- navigation segment: url/title/meta transitions

### Data model

```ts
type InteractionKind =
  | "click"
  | "type"
  | "scroll"
  | "navigate"
  | "select"
  | "drag"
  | "hover"
  | "unknown";

interface Interaction {
  interactionId: string;
  sessionId: string;
  kind: InteractionKind;
  startTs: number;
  endTs: number;
  eventRefs: Array<{ sequence: number; eventIndex: number }>;
  targetNodeId?: number;
  payload: Record<string, unknown>;
}
```

### Jargon

- temporal clustering
- debounce
- burst suppression
- action abstraction

### Failure handling

- cannot resolve pattern: fallback to `unknown` interaction
- conflicting targets: choose primary by last decisive event and annotate conflict

### Observability

- interaction compression ratio
- average events per interaction
- unknown interaction percentage

## Stage 5 - TargetResolve

### Plain-language purpose

For each interaction, determine which on-page element was targeted and derive semantic identifiers.

### Inputs

- interactions + dom state at interaction boundary

### Outputs

- target descriptors + signal candidates compatible with DSL `SignalKind`

### Signal extraction aligned with DSL

Allowed signal kinds (from contract layer):

- `role`
- `text`
- `url_pattern`
- `state`
- `attribute`

### Data model

```ts
interface ResolvedTarget {
  interactionId: string;
  nodeId: number | null;
  role?: string;
  text?: string;
  attributes: Record<string, string>;
  urlPattern?: string;
  preState: string[];
  postState: string[];
  signals: Array<{ kind: string; value: string; weight: number }>;
}
```

### Jargon

- grounding
- target attribution
- state delta inference
- semantic feature synthesis

### Failure handling

- target node missing (removed before resolve): use nearest ancestor context if possible
- ambiguous text-only target: down-weight confidence and require locator fallback diversity

### Observability

- target resolution success rate
- ambiguous target count
- average extracted signals per interaction

## Stage 6 - LocatorSynthesis

### Plain-language purpose

Generate robust ways to find the same element again at runtime.

### Inputs

- resolved targets + dom snapshots

### Outputs

- `LocatorSetDef`-compatible strategy lists

### Allowed locator kinds (DSL)

- `role_name`
- `css`
- `xpath`
- `text`
- `data_testid`
- `attribute`
- `dom_path`

### Ranking heuristics

- uniqueness (selector cardinality)
- stability (dynamic class/id volatility)
- semantic quality (accessibility role/name > brittle structural selectors)
- replay prior (if available)

### Suggested preference order

1. `data_testid`
2. `role_name`
3. `text`
4. `attribute`
5. `dom_path`
6. `css`
7. `xpath`

### Data model

```ts
interface LocatorCandidate {
  kind: "role_name" | "css" | "xpath" | "text" | "data_testid" | "attribute" | "dom_path";
  value: string;
  confidence: number;
  diagnostics?: string[];
}
```

### Jargon

- selector robustness
- cardinality check
- fallback chain
- selector entropy

### Failure handling

- no strong locator found: still emit non-empty set (validator requirement), but confidence low

### Observability

- mean top locator confidence
- locator strategy distribution
- replay failure (future online metric)

## Stage 7 - EpisodeChunking

### Plain-language purpose

Break long sessions into smaller coherent units so LLM input stays focused.

### Inputs

- interaction timeline + navigation boundaries + state deltas

### Outputs

- episode windows with local objective hints

### Boundary triggers

- hard navigation
- inactivity timeout
- major DOM context reset
- intent shift (target class change)

### Data model

```ts
interface Episode {
  episodeId: string;
  sessionId: string;
  startTs: number;
  endTs: number;
  intentHint: string;
  interactionIds: string[];
}
```

### Jargon

- semantic segmentation
- context budget control
- long-horizon decomposition

### Failure handling

- uncertain boundaries: permit overlapping soft boundaries with confidence penalties

### Observability

- episodes per session
- avg interactions per episode
- oversized episode count

## Stage 8 - TraceIRBuild

### Plain-language purpose

Compile all deterministic preprocessing outputs into a compact JSON representation for LLM consumption.

### Inputs

- episodes, interactions, targets, locators, evidence refs

### Outputs

- `TraceIR`

### Design requirements

- stable IDs and canonical ordering
- explicit provenance refs to source events
- confidence propagation
- no irrelevant noise fields

### Data model

```ts
interface TraceIR {
  traceId: string;
  sessionId: string;
  site: string;
  generatedAt: string;
  episodes: EpisodeIR[];
  globalContext: {
    initialUrl: string;
    finalUrl: string;
    titleHistory: string[];
  };
}

interface EpisodeIR {
  episodeId: string;
  intentHint: string;
  interactions: InteractionIR[];
  inferredEntityCandidates: EntityCandidateIR[];
  inferredActionCandidates: ActionCandidateIR[];
  evidenceRefs: Array<{ sequence: number; eventIndex: number }>;
}
```

### Jargon

- intermediate representation (IR)
- canonical serializer
- evidence lineage
- deterministic hashing

### Failure handling

- partial episode due to ingest gaps: include `partial=true` metadata

### Observability

- trace size bytes
- avg episodes per trace
- evidence density per action candidate

## Stage 9 - LLMExtract (ManifestPatch only)

### Plain-language purpose

Use the LLM to infer semantic entities/actions/errors from `TraceIR`, but only as a patch output.

### Inputs

- `TraceIR`
- output schema for `ManifestPatch`

### Outputs

- `ManifestPatch`

### Why patch-only

Patch-only generation reduces blast radius and keeps deterministic code in charge of schema-critical fields.

### Prompting contract

- temperature low (determinism bias)
- strict structured output mode
- require evidence references in generated candidates
- disallow unsupported enum values

### Jargon

- constrained decoding
- schema-locked generation
- hallucination containment
- semantic projection

### Failure handling

- schema invalid: one repair turn with validator-like issue hints
- empty patch on non-empty trace: treat as extraction failure and report

### Observability

- LLM latency
- token usage
- schema failure rate
- repair loop invocation count

## Stage 10 - DeterministicCompile

### Plain-language purpose

Merge patch into complete `BrowserWireManifest` with deterministic defaults and normalization.

### Inputs

- current baseline manifest (optional)
- `ManifestPatch`
- compile policy config

### Outputs

- full candidate `BrowserWireManifest`

### Responsibilities

- stable id generation rules (`entity_*`, `action_*`, `locset_*`)
- canonical ordering (entities/actions/errors sorted by id)
- required field completion (`metadata`, `recipeRef`, `provenance`)
- confidence bucket normalization aligned with validator thresholds

### Jargon

- materialization
- canonicalization pass
- deterministic merge semantics

### Failure handling

- conflicting ids between patch and baseline: deterministic namespacing strategy

### Observability

- compile conflicts
- auto-filled field counts

## Stage 11 - ValidateAndRepair

### Plain-language purpose

Run strict contract validation; if needed, do a bounded repair attempt.

### Inputs

- compiled `BrowserWireManifest`
- `validateManifest` from `src/contract-dsl/validate.ts`

### Outputs

- valid manifest or failure report with typed issues

### Existing validator invariants (selected)

- non-empty required strings
- valid semver in `contractVersion`/`manifestVersion`
- valid ISO timestamps
- enum constraints for signal/locator/error/provenance kinds
- `recipeRef` pattern `recipe://<path>/v<number>`
- action -> entity reference integrity
- action errors -> error definitions integrity
- non-empty pre/postconditions
- non-empty locator strategy set

### Repair policy

- at most one repair cycle by default
- repair prompt contains exact issue list
- if still invalid, fail closed

### Jargon

- fail-closed boundary
- invariant enforcement
- bounded self-healing

### Observability

- first-pass validation success rate
- repair success rate
- top issue codes by frequency

## Stage 12 - CompatibilityGate

### Plain-language purpose

Ensure manifest version bump matches the kind of changes introduced.

### Inputs

- previous manifest
- candidate manifest
- `checkManifestCompatibility` from `src/contract-dsl/compatibility.ts`

### Outputs

- compatibility report with required bump and issues

### Policy semantics

- breaking change -> `major`
- additive compatible change -> `minor`
- metadata/patch-only change -> `patch`
- downgrade or insufficient bump -> reject

### Jargon

- semantic version gate
- change classification
- backward compatibility contract

### Observability

- compatibility reject rate
- required-vs-actual bump mismatch counts

## 6. Example walkthrough

Scenario:

1. user opens issue list page
2. user types ticket id in search field
3. user clicks row
4. details panel appears

Pipeline behavior:

- Stage 4 emits interactions `type(search_input)`, `click(ticket_row)`
- Stage 5 resolves signals:
  - `role=textbox`, `attribute=placeholder:Search`
  - `role=row`, `text=Ticket #1234`
- Stage 6 synthesizes locators:
  - `data_testid=ticket-row` confidence `0.92`
  - `text=Ticket #1234` confidence `0.64`
- Stage 8 creates episode with intent hint `open_ticket`
- Stage 9 proposes patch for:
  - entity `ticket`
  - action `open_ticket`
  - errors `ERR_TARGET_NOT_FOUND`, `ERR_POSTCONDITION_FAILED`
- Stage 10 compiles full manifest structure
- Stage 11 validates against all DSL rules
- Stage 12 confirms required semver bump before publishing

## 7. Browser agent processing research synthesis

This section summarizes how modern browser agents observe and act on pages, and why that matters for this compiler design.

### 7.1 Observation modalities

Common observation channels:

- DOM tree or pruned HTML
- accessibility tree (AXTree)
- screenshot/video frame
- action history and error feedback
- URL/title/tab metadata

Modern systems are typically multimodal and do not rely on a single channel.

### 7.2 Agent control loop

Typical agent loop:

1. observe page state
2. reason or plan next step
3. execute action/tool call
4. verify state transition
5. iterate until goal completion

This closely matches ReAct-style observe-reason-act patterns, with additional grounding logic for UI targets.

### 7.3 Dominant architecture patterns

- DOM-first agents: strong structural grounding, weaker visual grounding
- vision-first agents: broad UI coverage, can be coordinate brittle
- hybrid agents: combine structure + vision + history (most robust in practice)

### 7.4 Why preprocessing is critical

Research and benchmark practice consistently show raw web traces are noisy. Distillation and denoising are needed to improve:

- token efficiency
- action grounding precision
- long-horizon stability
- reproducibility of decisions

This directly motivates Stage 1-8 deterministic preprocessing before any LLM extraction.

### 7.5 Grounding as primary bottleneck

Across WebArena-style and open-web tasks, failure modes often come from bad element grounding rather than pure reasoning deficits. Locator synthesis and target resolution are therefore first-class compiler stages, not optional post-processing.

### 7.6 Mapping agent lessons to BrowserWire

- use structure-first signals (`role`, `attribute`, `testid`) where possible
- preserve episode-level context for long-horizon tasks
- keep deterministic fallbacks for low-confidence LLM outputs
- treat validation and compatibility as hard publish gates

## 8. Technical risk matrix

| Risk | Root Cause | Impact | Mitigation |
| --- | --- | --- | --- |
| Out-of-order batch storms | network jitter/reconnect | corrupted timeline | reorder window + high-watermark logic |
| DOM divergence | missing snapshot or bad mutation replay | wrong target mapping | checkpoint resets + divergence counters |
| Locator brittleness | dynamic classes/unstable DOM | runtime replay failures | multi-strategy locator set + confidence ranking |
| LLM schema drift | unconstrained generation | invalid manifests | strict structured output + validator |
| Semver drift | wrong bump policy | breaking downstream clients | compatibility gate hard reject |

## 9. Suggested implementation modules (future)

This section suggests module boundaries only; it does not imply immediate implementation.

```text
src/trace-compiler/
  ingest.ts            // Stage 1
  normalize.ts         // Stage 2
  dom-rebuild.ts       // Stage 3
  interactions.ts      // Stage 4
  targets.ts           // Stage 5
  locators.ts          // Stage 6
  episodes.ts          // Stage 7
  trace-ir.ts          // Stage 8
  llm-extract.ts       // Stage 9
  compile.ts           // Stage 10
  validate-repair.ts   // Stage 11
  compatibility-gate.ts// Stage 12
```

## 10. Suggested acceptance criteria

- deterministic replay: identical input trace yields identical `TraceIR`
- validator pass rate above target threshold after repair loop
- compatibility gate blocks all known insufficient bump scenarios
- locator synthesis emits at least one strategy per action
- observability dashboards show per-stage throughput and failure metrics

## 11. Glossary

- event sourcing: derive state by replaying append-only event log
- materialized view: query-optimized state derived from event stream
- canonicalization: normalize heterogenous payloads into one schema
- grounding: map intent to concrete target element/action
- semantic compression: transform low-level telemetry into higher-level interaction abstractions
- constrained decoding: force LLM outputs into strict machine-readable structure
- fail closed: reject candidate output unless all hard checks pass
- compatibility gate: policy check enforcing semver correctness against semantic diff

## 12. Final summary

The hybrid compiler design separates concerns cleanly:

- deterministic preprocessing handles noise, ordering, and state reconstruction
- LLM layer handles semantic mapping from compact `TraceIR` to `ManifestPatch`
- deterministic compile + validate + compatibility gates enforce contract quality

This architecture is optimized for reliability, auditability, and long-term maintainability in BrowserWire contract generation pipelines.
