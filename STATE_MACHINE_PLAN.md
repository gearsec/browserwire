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

### Phase 3: Serial Session Processing

**File**: `core/discovery/session.js`

- Remove `_pendingSnapshots` (parallel Promise array)
- Add `_snapshotQueue` (plain array of payloads — `addSnapshot()` just pushes)
- Use `StateMachineManifest` from `core/manifest/`:
  ```js
  this._manifest = new StateMachineManifest();
  this._previousStateId = null;
  ```
- Rewrite `finalize()` — serial for-loop:
  ```
  for each snapshot in _snapshotQueue:
    1. Create browser instance
    2. Call runDiscoveryAgent() with manifest.toSummary() as context
    3. Call _integrateStepResult() to update manifest
    4. Close browser
  return { siteSchema: _manifest.toJSON() }
  ```
- Add `_integrateStepResult(result, isFirst)`:
  - `is_existing: true` → reuse existing state id
  - `is_existing: false` → `manifest.addState()` with grounded views
  - `manifest.mergeActions()` to add the grounded trigger action to the previous state
  - If first snapshot → set `manifest.initial_state`
  - If not first → `manifest.setLeadsTo()` on the previous state's action
  - Update `_previousStateId`
- Remove merge agent call entirely

**Checkpoint**: Session processes snapshots serially using StateMachineManifest. Agent interface changes are needed next.

---

### Phase 4: State-Machine-Aware Agent Graph

**File**: `core/discovery/agent.js`

- Update `DiscoveryAnnotation`:
  - Replace `skeleton` → `stateStep` (planner output per snapshot)
  - Add `stateMachineContext` (the accumulated state machine, read-only context)
  - Add `trigger` (the trigger that caused this snapshot)
  - Add `isFirstSnapshot` flag
  - Replace `manifest` → `stateStepResult` (output: semantic state + grounded views + grounded actions)
- Update `plannerNode`: pass `stateMachineContext` and `trigger` through `config.configurable` (trigger is used internally by the planner to identify which action caused the transition — not stored in manifest)
- Update `dispatchToWorkers`:
  - Fan out `stateStep.views` as view items to ground
  - Fan out `stateStep.transition_actions` as action items to ground
  - For first snapshot: `transition_actions` is empty → only view grounding happens
- Update `assembleNode`: produce `stateStepResult` instead of per-page manifest
- Update `runDiscoveryAgent` signature:
  ```js
  runDiscoveryAgent({
    snapshot, browser,
    stateMachine,       // accumulated state machine for context
    isFirstSnapshot,    // boolean
    trigger,            // the trigger that caused this snapshot (internal use only)
    onProgress, sessionId
  })
  ```

**Checkpoint**: Agent graph accepts state machine context and returns step results. Planner prompt changes next.

---

### Phase 5: New Planner Prompt

**File**: `core/discovery/planner.js`

Rewrite `SYSTEM_PROMPT` entirely. New workflow:

1. **ORIENT** — same as before (screenshot, page regions, domain)
2. **DETERMINE STATE** (new step):
   - Examine page content semantically (not just URL)
   - Review accumulated state machine context (provided in HumanMessage)
   - Decide: is this a state we've already seen, or a new one?
   - If existing → set `is_existing: true`, reference by `existing_state_id`
   - If new → set `is_existing: false`, assign semantic `name` + `description`
3. **IDENTIFY VIEWS** — same as before but scoped to this state's visible data only
4. **IDENTIFY TRIGGER ACTIONS** (replaces "identify all endpoints"):
   - First snapshot (`trigger.kind === 'initial'`): NO actions — no incoming transition
   - Subsequent snapshots: receive trigger data in the HumanMessage. Find ONLY the DOM elements that correspond to the trigger interaction
   - Example: trigger says "click on `<button>` 'Add to Cart'" → find that button, that's the only action
   - Example: trigger says "click on `<button>` 'Submit'" near a form → find the form fields + submit button
   - Use `find_interactive` and `get_element_details` to match trigger to actual elements
5. **SUBMIT** — call `submit_state_step` (not `submit_skeleton`)

Update `runPlanner`:
- Accept `stateMachine` and `trigger` parameters
- Build HumanMessage with:
  - Compact state machine summary (state names + ids, signatures)
  - Raw trigger details (kind, target, url)
  - URL and title of current snapshot

**Checkpoint**: Planner produces state steps with semantic state deduction and trigger-scoped actions.

---

### Phase 6: Assembler Rework

**File**: `core/discovery/assembler.js`

- Input: `{ stateStep, views, actions }` — stateStep from planner, views/actions grounded by sub-agents
- Output: `{ stateStepResult }`:
  ```js
  {
    semanticState: stateStep.semantic_state,  // { name, description, signature, is_existing, existing_state_id }
    groundedViews: [...],                      // grounded view objects
    groundedActions: [...]                     // grounded action objects (trigger-relevant only)
  }
  ```
- Remove all workflow assembly logic
- Validation: validate grounded items match what planner requested (views by name, actions by name)

**Checkpoint**: Assembler produces state step results. All core discovery pipeline updated.

---

### Phase 7: Delete Merge Agent

**File**: `core/discovery/merge-agent.js` — **DELETE entirely**

- Remove import in `session.js` (already done in Phase 2)
- Remove `getMergeTools` export from `tools/index.js` (already done in Phase 1)
- Remove `siteManifestSchema`, `sitePageSchema` from `tools/index.js`

**Checkpoint**: No merge agent. State machine is built incrementally.

---

### Phase 8: Session Manager Updates

**File**: `core/session-manager.js`

- `stopSession()`: manifest shape changes from `{ pages[] }` to `{ states[] }` — update all logging
- Update `session.json` output: per-snapshot summaries now show which state was deduced and which action got its `leads_to` set
- Update `listSites()`:
  ```js
  // Old: pageCount, viewCount, endpointCount, workflowCount
  // New: stateCount, viewCount, actionCount
  stateCount: m.states?.length || 0,
  viewCount: m.states?.reduce((n, s) => n + (s.views?.length || 0), 0) || 0,
  actionCount: m.states?.reduce((n, s) => n + (s.actions?.length || 0), 0) || 0,
  ```

**Checkpoint**: Session manager works with new manifest shape.

---

### Phase 9: API & Manifest Store Updates

**`core/manifest-store.js`**:
- Update `meta.json` fields: `stateCount`, `actionCount` (replace `entityCount`, `actionCount`)

**`core/api/openapi.js`**:
- Rewrite `generateOpenApiSpec`: iterate `manifest.states[].views` for read APIs
- Actions with `leads_to` are executable — generate action APIs from `manifest.states[].actions`
- Rewrite `collectReadViews` to navigate states instead of pages

**`core/workflow-resolver.js`**:
- Rewrite for action-based resolution
- An action = navigate to `state.url_pattern` → execute `state.actions[name]` → arrive at `action.leads_to` state

**`core/api/router.js`**:
- Update routes: actions on states replace workflows
- Update landing page HTML: show state/action counts
- Update read API routes to work with states

**Checkpoint**: Full end-to-end working. API docs render state machine. All old page-centric code removed.

---

## Files Summary

| File | Action |
|------|--------|
| `core/manifest/` | ✅ New module: schemas, validation, builder class |
| `electron/capture/dom-capture.js` | Inject rrweb recorder, filter to interaction events |
| `electron/capture/settle-cycle.js` | Drain rrweb events on capture, attach to snapshot payload |
| `core/discovery/tools/testing.js` | Remove workflow schema, update to use `core/manifest` |
| `core/discovery/tools/index.js` | Add state step tools, remove merge tools |
| `core/discovery/session.js` | Serial processing, state machine accumulation |
| `core/discovery/agent.js` | State-machine-aware graph, new annotations |
| `core/discovery/planner.js` | New system prompt, semantic state deduction |
| `core/discovery/assembler.js` | State step assembly (no workflows) |
| `core/discovery/merge-agent.js` | **DELETE** |
| `core/session-manager.js` | New manifest shape, updated logging |
| `core/manifest-store.js` | Updated meta fields |
| `core/api/openapi.js` | State-machine-based API generation |
| `core/workflow-resolver.js` | Action-based resolution |
| `core/api/router.js` | Updated routes and counts |

## Unchanged Files

| File | Reason |
|------|--------|
| `electron/capture/session-bridge.js` | Orchestration unchanged — just passes snapshot payloads |
| `electron/capture/screenshot.js` | Screenshot annotation unchanged |
| `core/discovery/sub-agents/item-agent.js` | Agnostic to source — still grounds individual items |
| `core/discovery/graphs/react-agent.js` | Generic ReAct framework |
| `core/discovery/snapshot/*` | Index/browser unchanged |

---

## Verification (per phase)

1. **Phase 1**: ✅ Manifest module: schemas, validation, builder — all tested
2. **Phase 2**: Single session payload with continuous rrweb event stream + snapshot markers. Events include FullSnapshot + Mutation(0) + MouseInteraction(2) + Input(5) + StyleSheetRule(8) + StyleDeclaration(13). Old per-snapshot fields (domHtml, trigger, pageText, etc.) removed. Replay to any state via `replayer.pause(snapshot.timestamp)`. Action testing via rrweb record-in-replay comparison.
3. **Phase 3**: Snapshots process serially, StateMachineManifest accumulates correctly
4. **Phase 4**: Agent graph passes state machine context through, returns step results
5. **Phase 5**: Planner deduces semantic states, only extracts trigger-relevant actions
6. **Phase 6**: Assembler produces valid state step results
7. **Phase 7**: No merge agent references remain
8. **Phase 8**: Session logs show states/actions instead of pages
9. **Phase 9**: `http://127.0.0.1:8787/api/docs` renders state machine manifest

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
- **Serial latency**: Accepted tradeoff. Grounding sub-agents within each step still run in parallel via LangGraph Send
- **Context growth**: Mitigated by compact summaries (state names + signatures only)
