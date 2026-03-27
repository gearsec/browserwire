# State Machine Architecture for BrowserWire

## Context

BrowserWire currently processes snapshots independently in parallel. Each snapshot gets its own planner + grounding agents, producing a per-page manifest. A merge agent then combines these into a site-level manifest organized by pages. This loses critical information:

- **No relationships** between snapshots (what caused the transition?)
- **URL-based page identity** fails for SPAs where the same URL can show very different content after navigation
- **All interactive elements** are discovered, even those the user never interacted with

The new architecture treats snapshots as **states** in a state machine, with **actions as edges**. Processing is serial so each step has full context of the graph built so far. Only trigger-relevant actions are captured. The LLM deduces semantic states, enabling cycles (two snapshots mapping to the same state).

## Design Decisions

- **Workflows removed entirely** — traversing the state machine graph replaces explicit workflow definitions
- **Views belong to states** — a state describes what you can see/read at that point
- **Actions only from triggers** — no speculative discovery; actions are only generated when they appear as actual triggers in the captured session
- **No separate transitions** — actions on a state have a `leads_to` field referencing the destination state; the state machine graph is states + actions with `leads_to`
- **Raw trigger data is internal** — the extension's trigger data is used by the agent to find the element, but not stored in the manifest

---

## New Manifest Schema

Views and actions carry **executable Playwright code** alongside structured signatures (`returns`/`inputs`) that define their API. The signature is the contract; the code is the implementation.

```json
{
  "domain": "ecommerce",
  "domainDescription": "Online store",
  "initial_state": "s0",
  "states": [{
    "id": "s0",
    "name": "product_list",
    "description": "Main product listing page",
    "url_pattern": "/products",
    "signature": {
      "page_purpose": "browse products",
      "views": ["product_grid"],
      "actions": ["view_details", "search_products"]
    },
    "views": [{
      "name": "product_grid",
      "description": "Grid of product cards",
      "isList": true,
      "returns": [
        { "name": "title", "type": "string" },
        { "name": "price", "type": "number" },
        { "name": "in_stock", "type": "boolean" }
      ],
      "code": "async (page) => {\n  const items = await page.locator('.product-card').all();\n  return Promise.all(items.map(async (el) => ({\n    title: await el.locator('.title').textContent(),\n    price: parseFloat(await el.locator('.price').textContent()),\n    in_stock: (await el.locator('.stock-badge').textContent()).includes('In Stock'),\n  })));\n}"
    }],
    "actions": [
      {
        "name": "view_details",
        "kind": "click",
        "description": "Click a product card to view its details",
        "inputs": [{ "name": "product_title", "type": "string", "required": true }],
        "leads_to": "s1",
        "code": "async (page, { product_title }) => {\n  await page.locator('.product-card', { hasText: product_title }).click();\n}"
      },
      {
        "name": "search_products",
        "kind": "form_submit",
        "description": "Search for products by keyword",
        "inputs": [{ "name": "query", "type": "string", "required": true }],
        "leads_to": "s0",
        "code": "async (page, { query }) => {\n  await page.locator('input[name=\"search\"]').fill(query);\n  await page.locator('button[type=\"submit\"]').click();\n}"
      }
    ]
  }]
}
```

- **Views**: signature = `returns` (typed fields), implementation = `code: async (page) => { ... }`
- **Actions**: signature = `inputs` (typed params), implementation = `code: async (page, inputs) => { ... }`
- **`leads_to`** on an action references the destination state id. Set when the action is observed as a trigger.
- The manifest is **directly executable** — no interpreter/resolver layer needed. The code IS the Playwright calls.
- To traverse: start at `initial_state`, pick an action, follow `leads_to` to the next state.

### State Signature (Deduplication)

A state is defined by what you can **see** (views) and what you can **do** (actions). The `signature` references the actual view and action names defined on the state:

```json
{
  "page_purpose": "browse products",
  "views": ["product_grid", "search_results_count"],
  "actions": ["add_to_cart", "search_products", "view_details"]
}
```

- The signature's `views` and `actions` are references to the state's own `views[].name` and `actions[].name`
- All views and actions on a state are discovered by the planner during ORIENT (via `get_page_regions` and `find_interactive`)
- The raw trigger data is only used internally by the agent to find the element — not stored in the manifest

**Dedup rules**:
- Same views + same actions + same page purpose → same state (even if URL or data content differs)
- Same URL but different views or actions → different state (e.g., modal open vs closed, logged in vs out)
- Same views but different actions → different state (e.g., admin vs regular user)

The LLM compares the new signature against existing states' signatures to decide if this is a revisit.

---

## Implementation Phases

### Phase 1: Manifest Module ✅ DONE

**Files**: `core/manifest/schema.js`, `core/manifest/validate.js`, `core/manifest/manifest.js`, `core/manifest/index.js`

Implemented as a standalone module in `core/manifest/`:

- **`schema.js`** — Zod schemas:
  - `viewSchema` — name, description, isList, `returns` (typed fields), `code` (Playwright function)
  - `actionSchema` — name, kind, description, `inputs` (typed params), `leads_to`, `code` (Playwright function)
  - `stateSignatureSchema` — page_purpose, views[], actions[] (references to actual names)
  - `stateSchema` — id, name, description, url_pattern, signature, views[], actions[]
  - `stateMachineManifestSchema` — domain, domainDescription, initial_state, states[]
- **`validate.js`** — `validateManifest()`: Zod + semantic validation (duplicate ids, referential integrity, signature consistency, leads_to validity, non-empty code)
- **`manifest.js`** — `StateMachineManifest` class: mutable builder with `addState()`, `setLeadsTo()`, `findMatchingState()`, `mergeViews()`, `mergeActions()`, `toJSON()`/`fromJSON()`, `toSummary()` (compact LLM context, omits code), `validate()`
- **`index.js`** — re-exports all public APIs

**Still TODO for later phases** (`core/discovery/tools/index.js`):
- Add `stateStepSchema` — what the planner outputs per snapshot:
  ```
  {
    semantic_state: {
      name: string,
      description: string,
      signature: {
        page_purpose: string,
        views: [string],
        actions: [string]
      },
      is_existing: boolean,
      existing_state_id?: string
    },
    views: [skeletonViewItem],
    transition_actions: [skeletonActionItem]   // only for non-first snapshots
  }
  ```
- Add `submit_state_step` tool (replaces `submit_skeleton`)
- Remove `getMergeTools`, `get_snapshot_manifest`, `submit_site_manifest`, `siteManifestSchema`, `sitePageSchema`

**Checkpoint**: Manifest module is complete and tested. Agent-facing tools to be updated in later phases.

---

### Phase 2: Data — rrweb Event Stream + Screenshot

Replace the current multi-field snapshot capture with a single rrweb event stream. The event stream is the unified source of truth for both states and transitions.

#### How rrweb works

rrweb records a flat sequence of events. A `FullSnapshot` (type=2) captures the complete DOM tree. `IncrementalSnapshot` (type=3) events record changes: DOM mutations, clicks, input changes, etc. The Replayer rebuilds the DOM from a FullSnapshot, then applies incremental events in order. Crucially, **a click replay does NOT trigger the page's JS** — the DOM mutations that resulted from the click were independently recorded by a MutationObserver and are replayed separately. This means the full event stream between two FullSnapshots is sufficient to reconstruct any intermediate DOM state.

#### Exact events to capture

The rrweb event stream replaces `domHtml`, `trigger`, `pageText`, `pageState`, and `skeleton`. Only the screenshot remains separate (rrweb doesn't capture visual rendering).

**Top-level event types:**

| EventType | ID | Record? | Purpose |
|-----------|----|---------|---------|
| DomContentLoaded | 0 | **Yes** | Required by Replayer for timeline |
| Load | 1 | **Yes** | Required by Replayer for timeline |
| FullSnapshot | 2 | **Yes** | Complete DOM tree — this IS the state. Required for replay. |
| IncrementalSnapshot | 3 | **Filtered** | See source filter below |
| Meta | 4 | **Yes** | Page URL, viewport dimensions. Required by Replayer. |
| Custom | 5 | No | Not used |
| Plugin | 6 | No | Not used |

**IncrementalSnapshot source filter (type=3 events):**

| Source | ID | Record? | Why |
|--------|----|---------|-----|
| Mutation | 0 | **Yes** | DOM node adds, removes, attribute changes, text changes. **Essential** — this is what transforms the DOM between states. Without this, replay cannot reconstruct state B from state A. |
| MouseMove | 1 | **No** | Cursor positions between clicks. Doesn't modify the DOM. |
| MouseInteraction | 2 | **Yes** | Click (2), MouseDown (1), MouseUp (0), Focus (5), Blur (6), DblClick (4), ContextMenu (3), TouchStart (7), TouchEnd (9). Identifies which element was interacted with. **Essential** for action grounding and testing. |
| Scroll | 3 | **No** | Viewport/element scroll position. Doesn't modify the DOM. Scroll-triggered lazy loading produces Mutation events which are captured independently. |
| ViewportResize | 4 | **No** | Window size changes. Doesn't modify the DOM. |
| Input | 5 | **Yes** | Form field value/checked state changes from user input. **Essential** for action inputs and testing. Contains `{ id, text, isChecked }`. |
| TouchMove | 6 | **No** | Touch positions. Doesn't modify the DOM. |
| MediaInteraction | 7 | **No** | Play/pause/volume on media elements. Doesn't modify the DOM structure. |
| StyleSheetRule | 8 | **Yes** | CSS rule insertions/deletions (e.g., `.modal { display: block }`). **Required** — affects element visibility which can define different states (modal open vs closed). |
| CanvasMutation | 9 | **No** | Canvas 2D/WebGL draw commands. Not queryable DOM. |
| Font | 10 | **No** | Font face loading. Doesn't modify the DOM. |
| Log | 11 | **No** | Console logs. Not relevant. |
| Drag | 12 | **No** | Drag positions. Doesn't modify the DOM. |
| StyleDeclaration | 13 | **Yes** | Inline style changes (`el.style.display = 'none'`). **Required** — same reason as StyleSheetRule. |
| Selection | 14 | **No** | Text selection ranges. Doesn't modify the DOM. |
| AdoptedStyleSheet | 15 | **No** | Rare. Shadow DOM adopted stylesheets. |
| CustomElement | 16 | **No** | Custom element registrations. Rare. |

**Summary — recorded sources:** `Mutation(0)`, `MouseInteraction(2)`, `Input(5)`, `StyleSheetRule(8)`, `StyleDeclaration(13)` + all non-incremental required events (`Meta`, `FullSnapshot`, `DomContentLoaded`, `Load`).

**Principle:** if it modifies the queryable DOM or identifies a user interaction, capture it. Everything else is noise.

#### Session recording — the source of truth

A single data structure emitted when the user stops recording. This is the source of truth — everything else (manifest, tests, API) derives from it. It must be self-contained: you can reconstruct every state, replay every transition, and test every manifest entry from this data alone.

```js
{
  sessionId: string,
  origin: string,              // site origin (e.g., "https://example.com")
  startedAt: string,           // ISO timestamp
  stoppedAt: string,           // ISO timestamp
  events: rrwebEvent[],        // continuous rrweb event stream for the entire session
  snapshots: [                 // state boundary markers (where settle cycle captured)
    {
      snapshotId: string,
      eventIndex: number,      // index into events[] pointing to the FullSnapshot event
      screenshot: string,      // base64 JPEG at this state
      url: string,             // page URL at capture time
      title: string,           // page title at capture time
    },
  ]
}
```

- `events` is one continuous ordered array — the full session recording
- `snapshots` are markers into the event stream by index. Each points to a FullSnapshot event in `events[]`
- `events[snapshots[N].eventIndex]` IS the DOM state at snapshot N (a FullSnapshot event)
- Transition events from snapshot N-1 to N = `events[snapshots[N-1].eventIndex + 1 .. snapshots[N].eventIndex - 1]`
- `snapshots[0]` is the initial page load (first FullSnapshot)

**The goal of Phase 2 is to build this data structure.**

#### Why this enables offline testing

With the full event stream stored alongside the manifest, we can replay to any state without the live site:

1. **Test a view**: Load events into rrweb Replayer in headless Playwright → `replayer.pause(stateTimestamp)` → DOM is reconstructed → run view `code` against `replayer.iframe.contentDocument` → verify output
2. **Test an action's locator**: Replay to source state → run action's selector against the DOM → verify element exists and matches the rrweb MouseInteraction event's target node ID
3. **Test a transition**: Replay from state A through events to state B → verify DOM matches state B's FullSnapshot

#### Implementation

**`electron/capture/dom-capture.js`**:
- Replace `serializeDom()` / `collectPageText()` / `capturePageState()` / `runSkeletonScan()` injection with `@rrweb/record` injection
- Start recording on page load with source filter: only `Mutation(0)`, `MouseInteraction(2)`, `Input(5)`, `StyleSheetRule(8)`, `StyleDeclaration(13)`
- Buffer all events in `window.__bw_events = []`
- The existing page signal script (`PAGE_SIGNAL_SCRIPT`) stays — it drives the settle cycle. But the coarse `trigger` object it produces is no longer stored in the payload (the rrweb events are richer)

**`electron/capture/settle-cycle.js`**:
- On snapshot capture: take a screenshot and record a snapshot marker `{ snapshotId, timestamp, screenshot, url, title }`
- Do NOT drain events per snapshot — events accumulate for the entire session
- Remove the `domHtml`, `pageText`, `pageState`, `skeleton` capture (replaced by event stream)
- The settle cycle logic (debounce, network idle) stays unchanged — it still determines WHEN to capture

**`electron/capture/session-bridge.js`** (or wherever "Stop Exploring" is handled):
- On stop: drain all events from `window.__bw_events`, combine with accumulated snapshot markers
- Send the single session payload: `{ sessionId, events, snapshots }`

**`electron/vendor/`**:
- Bundle `@rrweb/record` for injection into the page context (similar to how `rrweb-snapshot.js` is bundled today)

**Files to modify:**
- `electron/capture/dom-capture.js` — replace DOM capture with rrweb recording + source filter
- `electron/capture/settle-cycle.js` — capture screenshot + snapshot marker only (no DOM/trigger)
- `electron/capture/session-bridge.js` — assemble single session payload on stop
- `electron/vendor/` — bundle `@rrweb/record`

**Checkpoint**: Session payload contains continuous rrweb event stream + snapshot markers with screenshots. Events are the single source of truth for both DOM state (via FullSnapshot) and transitions (via IncrementalSnapshot). Offline replay is possible via rrweb Replayer in headless Playwright.

#### Offline Testing Protocol

The rrweb event stream stored alongside the manifest enables testing views and actions without the live site. The test environment is a headless Playwright instance running rrweb Replayer + rrweb Recorder.

**Setup**: Load the recorded event stream into rrweb Replayer in a headless Playwright page. The Replayer rebuilds real DOM in its iframe. Inject `rrweb.record()` into the Replayer's iframe to capture events generated by test execution.

**Testing a view**:
1. `replayer.pause(stateTimestamp)` → DOM is reconstructed at that state
2. Run the view's `code` function against `replayer.iframe.contentDocument`
3. Verify output matches the `returns` schema (correct field names, types)
4. Verify output is non-empty (the selectors actually found data)

**Testing an action**:
1. `replayer.pause(sourceStateTimestamp)` → DOM is at the action's source state
2. `rrweb.record()` is active inside the iframe, capturing new events
3. Execute the action's `code` function via Playwright against the iframe
4. Collect the generated rrweb events (click, input, etc.)
5. Compare generated event target IDs against the recorded events in the original stream:
   ```
   Recorded:  { type: 3, data: { source: 2, type: 2, id: 87 } }  // click on node 87
   Generated: { type: 3, data: { source: 2, type: 2, id: 87 } }  // action code clicked node 87
   → Same target element ✅
   ```
6. For Input events, compare the target element ID (values will differ since inputs are parameterized, but the element must match):
   ```
   Recorded:  { type: 3, data: { source: 5, id: 42, text: "original query" } }
   Generated: { type: 3, data: { source: 5, id: 42, text: "test value" } }
   → Same element (id: 42) ✅
   ```

Node IDs are stable because the test replays from the same recording — the rrweb mirror (id→node mapping) is consistent. The click won't trigger real JS handlers (the replayed DOM has no scripts), but that doesn't matter — we're testing that the action code targets the correct element, not the site's behavior.

**Testing a transition (end-to-end)**:
1. Replay to source state A
2. Execute action code → verify it targets the correct element (as above)
3. Continue replaying through the recorded events to destination state B
4. Run destination state's view code → verify it extracts data correctly
5. This validates the full path: state A → action → state B → view

---

### Phase 3: Session History UI + Replay

Add a "History" mode to the ActivityBar. Lists all session recordings from `~/.browserwire/logs/`. Selecting a session opens an rrweb-player replay of the recording with snapshot markers annotated on the timeline.

**Dependencies**: Install `rrweb-player` npm package.

**Backend (IPC)**:
- `browserwire:list-sessions` — scan `~/.browserwire/logs/session-*/` for `session-recording.json` files, return summary list
- `browserwire:load-session` — load a session's `events.json` + `session-recording.json`, return to renderer

**UI**:
- Add "History" mode to `ActivityBar.tsx` (4th mode alongside Discovery, Execution, Settings)
- `HistoryPanel.tsx` — lists sessions with origin, date, snapshot count, event count
- `ReplayPanel.tsx` — embeds `rrweb-player` component with the session's events
  - Snapshot markers shown on the timeline (annotated with snapshotId + URL)
  - Clicking a snapshot marker seeks the player to that point
  - Screenshots shown alongside the replay for comparison

**Checkpoint**: Can browse session history, replay any session, and visually verify what was recorded. Snapshot boundaries are visible on the timeline.

---

### Phase 4: Agent Tools

The agent system is redesigned around three shifts:
- **Code generation** — agent writes Playwright functions, not CSS selectors
- **rrweb replay** — tools query against a DOM reconstructed from the recording, not a live page
- **State machine awareness** — agent sees accumulated context and transition events

#### Tool inventory

**Page Understanding** (query the replayed DOM at the current snapshot)

| Tool | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `view_screenshot` | View the screenshot captured at this snapshot | — | base64 JPEG |
| `get_accessibility_tree` | YAML-style accessibility tree with stable ref IDs (role, name, value, state, children). Optionally scoped to a subtree. | `root_ref?` | YAML string |
| `get_page_regions` | High-level page sections: landmark roles, headings, child counts, data list presence | — | regions array |
| `find_interactive` | Find buttons, links, inputs, forms by role. Filterable by kind, text, subtree. | `near_ref?`, `kind?`, `text?` | elements array |
| `inspect_element` | Magnifying lens: element details + ancestor chain UP (containment) + descendant tree DOWN (structure) + form context if inside a `<form>`. | `ref`, `ancestor_depth?`, `descendant_depth?` | element + ancestors + descendants + form_context |

The first 4 are carried over from the old system. `inspect_element` is new — merges the old `get_element_details` (element info + form context) and `inspect_item_fields` (ancestor/descendant structure) into one tool. Drops CSS selectors and locator strategies (agent writes Playwright code directly). They already work against a SnapshotIndex built from an rrweb snapshot — no changes needed. The rrweb replay reconstructs the DOM, we build the index from it.

**Transition Understanding** (understand what the user did after this state)

| Tool | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `get_transition_events` | Get the rrweb interaction events between this snapshot and the NEXT snapshot. Shows MouseInteraction (clicks) and Input (form fills) events with their target node IDs. These are the actions the user performed to leave this state. | — | filtered events array with element refs |

This is new. Returns the interaction events (clicks, inputs) from this snapshot forward to the next one — mapped to ref IDs via the rrweb mirror so the agent can identify which elements on the current page were interacted with. For the last snapshot (terminal state), returns empty — no actions to generate.

**State Machine Context** (understand what's been built so far)

| Tool | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `get_state_machine` | Get the accumulated state machine summary: states with signatures, actions with leads_to. Omits code. | — | StateMachineManifest.toSummary() |

This is new. Gives the agent the full picture of what states and transitions have been discovered so far, so it can decide if the current snapshot is a new state or a revisit.

**Code Generation & Testing** (write and test Playwright code against the replayed DOM)

| Tool | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `test_code` | Execute a Playwright code snippet against the replayed DOM. Optionally verify output against expected values or compare generated rrweb events against the recorded transition. | `code`, `inputs?`, `expected?`, `verify_against_recording?` | `{ success, result?, error?, comparison?: { expected, actual, matched } }` |

Parameters:
- `code` (required) — Playwright async function body: `async (page, inputs) => { ... }`
- `inputs` (optional) — input values to pass to the function
- `expected` (optional) — expected return value. When provided, the tool compares actual vs expected and returns the diff.
- `verify_against_recording` (optional, boolean) — when true, enables rrweb recording inside the replayed iframe, executes the code, then compares generated events (clicks, inputs) against the recorded forward transition events. Returns whether the action targets the same elements.

Usage patterns:
- **Test a view**: `test_code({ code: "async (page) => { ... }", expected: [{ title: "Product A", price: 29.99 }] })` — runs extraction code, compares output against expected
- **Test an action**: `test_code({ code: "async (page, { query }) => { ... }", inputs: { query: "test" }, verify_against_recording: true })` — runs action code, verifies it targets the same elements the user actually clicked/filled

Replaces the old `test_selector`, `test_view_extraction`, and `test_endpoint_grounding` tools.

**Submission** (incremental — submit state, views, actions individually)

The agent submits each piece as it discovers it, keeping context lightweight.

| Tool | Description | Parameters | Returns |
|------|-------------|------------|---------|
| `submit_state` | Register the state for this snapshot. For an existing state, pass `existing_state_id`. For a new state, pass the full identity. | See below | `{ submitted: true }` |
| `submit_view` | Submit a single view with Playwright extraction code. Only for new states. | `view: viewSchema` | `{ valid, view_count }` |
| `submit_action` | Submit a single action with Playwright interaction code. | `action: actionSchema` | `{ valid, action_count }` |

`submit_state` parameters — two cases:

**Existing state** (agent recognized it from `get_state_machine`):
```
submit_state({ existing_state_id: "s2" })
```

**New state**:
```
submit_state({
  name: "product_list",
  description: "Product listing page",
  url_pattern: "/products",
  page_purpose: "browse products",
  domain: "ecommerce",
  domainDescription: "Online store"
})
```

- The agent decides new vs existing based on what it saw in `get_state_machine`.
- No signature with view/action names — the signature is derived automatically by the orchestrator from the views and actions submitted via `submit_view` / `submit_action`.
- For existing states: agent skips view discovery (views already in manifest). Only submits new actions if any.
- For new states: agent proceeds to `submit_view` for each view, then `submit_action` for each action.
- All views and actions attach to the current state (the one registered via `submit_state`).
- The orchestrator handles all manifest mutations after the agent finishes.

Replaces `submit_skeleton` + `submit_item` + `submit_manifest` + `submit_state_step`.

#### What's removed

| Old Tool | Why removed |
|----------|-------------|
| `test_selector` | Replaced by `test_code` — agent writes full Playwright functions |
| `test_view_extraction` | Replaced by `test_code` with `expected` — agent writes extraction code, compares output |
| `test_endpoint_grounding` | Replaced by `test_code` with `verify_against_recording` — verifies against recorded events |
| `get_element_details` | Merged into `inspect_element` — form context preserved, CSS selectors/locator strategies dropped |
| `inspect_item_fields` | Merged into `inspect_element` — general magnifying lens (ancestors + descendants), not limited to list items |
| `submit_skeleton` | Replaced by `submit_state` + `submit_view` + `submit_action` |
| `submit_item` | Replaced by `submit_view` + `submit_action` |
| `submit_manifest` | Removed — manifest built by orchestrator |
| `get_snapshot_manifest` | Removed — no merge agent |
| `submit_site_manifest` | Removed — no merge agent |

#### Agent architecture

The old 3-phase pipeline (planner → parallel sub-agents → assembler) is replaced by a **single ReAct agent per snapshot** with incremental submission:

1. **Orient** — `view_screenshot`, `get_page_regions`, `get_accessibility_tree`
2. **Determine state** — `get_state_machine` to review existing states, then `submit_state` with the signature
   - If **existing state**: tool returns existing views/actions. Skip to step 5.
   - If **new state**: proceed to step 3.
3. **Identify + write views** (new states only) — for each data region:
   - `get_accessibility_tree` scoped to region, `inspect_element` for structure
   - Write Playwright extraction code, `test_code` with `expected` to verify
   - `submit_view` — submit and forget, move to next view
4. **Identify + write actions** (if not last snapshot) — `get_transition_events` to see forward events:
   - For each interaction: `inspect_element` to understand the target element
   - Write Playwright interaction code, `test_code` with `verify_against_recording` to verify
   - `submit_action` — submit and forget, move to next action
5. **Done** — agent stops. Orchestrator wires the manifest.

Key properties:
- **Last snapshot** = terminal state. No forward events, no actions.
- **Existing state** = skip view discovery entirely. Only submit new actions if any.
- **Context stays light** — each view/action is submitted individually and can be forgotten.
- **Orchestrator handles manifest** — `addState`, `mergeActions`, `setLeadsTo` are all deterministic, outside the agent.

**Checkpoint**: All tools defined. Ready to implement.

---

### Phase 5: Implement Tools + Agent

Implement the tools from Phase 4 and the single ReAct agent per snapshot.

**New files:**
- `core/discovery/tools/` — rewrite with new tool implementations
- `core/discovery/agent.js` — single ReAct agent per snapshot (replaces planner + sub-agents + assembler)

**Delete:**
- `core/discovery/planner.js` — subsumed by single agent
- `core/discovery/sub-agents/item-agent.js` — subsumed by single agent
- `core/discovery/assembler.js` — subsumed by submit_state_step validation
- `core/discovery/merge-agent.js` — no merge step

**Checkpoint**: Agent processes a single snapshot and produces a state step result (semantic state + views with code + actions with code).

---

### Phase 6: Serial Session Processing

**File**: `core/discovery/session.js`

Takes a session recording (`events` + `snapshots`) and processes each snapshot serially. The agent does LLM work (state determination, view/action code generation). The orchestrator does deterministic manifest wiring.

```
prev_state_id = null
prev_action_name = null

for each snapshot[i] in recording.snapshots:

  1. REPLAY: Load events into rrweb Replayer, seek to snapshot[i]
     → DOM reconstructed in headless Playwright

  2. AGENT (LLM): Receives replayed DOM + screenshot + state machine summary
     + forward transition events (events from snapshot[i] to snapshot[i+1])
     → Produces: semantic_state + views (with code) + actions (with code)

  3. ORCHESTRATOR (deterministic):
     a. Add or reuse state:
        - is_existing → current_state_id = existing_state_id
        - new state → current_state_id = manifest.addState(views, actions)
     b. Link previous action to this state:
        - if prev_state_id != null:
          manifest.setLeadsTo(prev_state_id, prev_action_name, current_state_id)
     c. Remember for next iteration:
        - prev_state_id = current_state_id
        - prev_action_name = action name from this step (if actions exist)

return manifest.toJSON()
```

The agent never touches the manifest directly. It only produces state step results. All manifest mutations are deterministic.

**Checkpoint**: Full pipeline: recording → serial agent runs → state machine manifest.

---

### Phase 7: API & Manifest Store Updates

**`core/manifest-store.js`**:
- Update meta fields for state machine shape

**`core/api/openapi.js`**:
- Generate API spec from `manifest.states[].views` (read) and `manifest.states[].actions` (execute)

**`core/api/router.js`**:
- Update routes and counts for state machine manifest

**`core/workflow-resolver.js`**:
- Rewrite for action-based resolution: navigate to state URL → execute action code → arrive at leads_to state

**Checkpoint**: Full end-to-end working. API docs render state machine.

---

## Files Summary

| File | Action |
|------|--------|
| `core/manifest/` | ✅ New module: schemas, validation, builder class |
| `core/recording/` | ✅ New module: session recording schemas, validation |
| `electron/capture/dom-capture.js` | ✅ rrweb recorder with source filter |
| `electron/capture/settle-cycle.js` | ✅ Screenshot + snapshot marker only |
| `electron/capture/session-bridge.js` | ✅ Assembles session recording on stop |
| `core/session-manager.js` | ✅ saveRecording() with validation |
| `electron/ui/src/shell/panels/HistoryPanel.tsx` | ✅ Session history + rrweb replay |
| `core/discovery/tools/` | Rewrite with new tools (Phase 5) |
| `core/discovery/agent.js` | Single ReAct agent per snapshot (Phase 5) |
| `core/discovery/session.js` | Serial processing with rrweb replay (Phase 6) |
| `core/discovery/planner.js` | **DELETE** (Phase 5) |
| `core/discovery/sub-agents/` | **DELETE** (Phase 5) |
| `core/discovery/assembler.js` | **DELETE** (Phase 5) |
| `core/discovery/merge-agent.js` | **DELETE** (Phase 5) |
| `core/api/openapi.js` | State-machine-based API generation (Phase 7) |
| `core/workflow-resolver.js` | Action-based resolution (Phase 7) |
| `core/api/router.js` | Updated routes and counts (Phase 7) |
| `core/manifest-store.js` | Updated meta fields (Phase 7) |

---

## Verification (per phase)

1. **Phase 1**: ✅ Manifest module: schemas, validation, builder — all tested
2. **Phase 2**: ✅ Session recording: rrweb event stream + snapshot markers, typed with Zod, validated, saved via core/session-manager
3. **Phase 3**: ✅ History UI: session list, rrweb-player replays with snapshot seeking
4. **Phase 4**: Tool inventory defined (above)
5. **Phase 5**: Agent processes a single snapshot, produces state step with views/actions containing Playwright code
6. **Phase 6**: Serial processing: recording → agent per snapshot → StateMachineManifest
7. **Phase 7**: API docs render state machine, action execution works

## End-to-End Test
1. Run Electron app, navigate to a site
2. Click through several pages (creating snapshots with triggers)
3. Navigate back to a previously visited page (test state deduplication)
4. Stop exploring
5. Verify manifest has correct states with `leads_to` links, no duplicate states for revisited pages
6. Verify API docs render correctly

---

## Risks

- **LLM state deduction quality**: Mitigated by providing compact state machine summary with signatures as context
- **Serial latency**: Accepted tradeoff per requirements
- **Context growth**: Mitigated by compact summaries (state names + signatures only)
- **Code generation quality**: Mitigated by test_code and test_action_against_recording tools — agent iterates until code passes
