# Static Discovery

Status: implemented (vision-first pipeline)

This document defines the architecture for **static discovery** — analyzing a live web page to enumerate available entities, actions, and locator strategies, and compiling the results into a draft `BrowserWireManifest`.

Related:

- [Contract DSL](./contract-dsl.md) — manifest schema and validation
- [Glossary](../glossary.md) — terminology

## 1. Why static discovery

The original design (rrweb hybrid compiler) requires human recordings before any manifest can be generated. Static discovery inverts this: **analyze the page as it is right now** without any user interaction.

| Recording-based                    | Static discovery                   |
| ---------------------------------- | ---------------------------------- |
| Captures what happened             | Discovers what's possible          |
| Requires user to perform workflows | Runs automatically on page load    |
| One recording = one workflow path  | One scan = all visible elements    |
| Good for sequencing and intent     | Good for enumeration and structure |

Static discovery produces **draft manifests** — they enumerate entities and actions but don't capture multi-step workflows or sequencing. See [Dynamic Discovery](./dynamic-discovery.md) for interaction-triggered re-scanning and session-based manifest accumulation.

## 2. What it produces

A single scan of a page produces a `PageSnapshot` that can be compiled into a draft `BrowserWireManifest` using the existing contract-dsl types.

Concretely, for a page like a todo app, static discovery should output something like:

```json
{
  "entities": [
    {
      "id": "entity_todo_item",
      "name": "Todo Item",
      "signals": [
        { "kind": "role", "value": "listitem" },
        { "kind": "text", "value": "Buy groceries" }
      ]
    },
    {
      "id": "entity_new_todo_input",
      "name": "New Todo Input",
      "signals": [
        { "kind": "role", "value": "textbox" },
        { "kind": "attribute", "value": "placeholder:What needs to be done?" }
      ]
    }
  ],
  "actions": [
    {
      "id": "action_add_todo",
      "entityId": "entity_new_todo_input",
      "name": "Add Todo",
      "locatorSet": {
        "strategies": [
          { "kind": "role_name", "value": "textbox", "confidence": 0.9 },
          { "kind": "css", "value": "input.new-todo", "confidence": 0.7 }
        ]
      }
    },
    {
      "id": "action_toggle_todo",
      "entityId": "entity_todo_item",
      "name": "Toggle Todo",
      "locatorSet": {
        "strategies": [
          { "kind": "role_name", "value": "checkbox", "confidence": 0.9 }
        ]
      }
    }
  ]
}
```

## 3. Architecture overview

The pipeline uses a **vision-first** design: the LLM sees a screenshot + compact HTML skeleton (~2K tokens total) and picks the meaningful elements *before* locators are computed — keeping the total LLM token budget well under 10K TPM rate limits.

```
Extension content script (runs on page)
  → Stage 1: Skeleton Scan    (landmark containers + interactable elements only)
  → Transport: content-script → background.js (annotates screenshot) → WebSocket → CLI server

CLI server (Node.js backend)
  → Stage 7: Vision LLM Perception   (screenshot + ~2K HTML skeleton → domain, entities, actions)
  → Stage 5: Locator Synthesis       (only for the ~20 focused elements the LLM selected)
  → Stage 6: Manifest Draft          (compile into BrowserWireManifest)
  → Enrichment: mergeEnrichment()    (apply LLM semantic names onto draft)
```

### Where each stage runs

| Stage | Runs in                                  | Why                                                                      |
| ----- | ---------------------------------------- | ------------------------------------------------------------------------ |
| 1     | Content script (page context)            | Needs live DOM; collects skeleton only (~50-200 nodes vs 5000)           |
| bg    | Background service worker                | Captures JPEG screenshot, annotates with OffscreenCanvas, forwards       |
| 7     | CLI server (Node.js + vision LLM)        | Perception first — LLM picks meaningful elements from screenshot+skeleton |
| 5–6   | CLI server (Node.js)                     | Locator synthesis + manifest compilation on focused elements only        |

### Token budget comparison

| | Old pipeline | Vision-first pipeline |
|---|---|---|
| System prompt | ~550 tokens | ~600 tokens |
| User message | ~17K tokens (full JSON: 118 actions + locators) | ~1.5K tokens (HTML skeleton) |
| Image | — | ~85 tokens (JPEG 50%) |
| **Total per call** | **~18K (exceeds 10K TPM)** | **~2.2K** |

Stages 3 (interactable classification) and 4 (entity grouping) are **bypassed** when an LLM is configured — the vision LLM performs these functions directly from the screenshot. When no LLM is configured, Stages 3–4 run as the deterministic fallback. LLM-generated locators are injected with confidence 0.97, above heuristic locators (max 0.95 for `data_testid`).

## 4. Stage-by-stage specification

### Stage 1 — Skeleton Scan (`runSkeletonScan`)

#### Purpose

Walk the live DOM and collect a **focused** skeleton: only landmark containers and interactable elements. This replaces the old full DOM scan (Stages 1+2) with a single lightweight pass that produces ~50–200 nodes instead of up to 5000.

#### Included element types

- **Interactable**: `<button>`, `<a>`, `<input>`, `<select>`, `<textarea>`, `<summary>`
- **Landmark containers**: `<nav>`, `<main>`, `<header>`, `<footer>`, `<form>`, `<dialog>`, `<aside>`, `<section>`, `<article>`
- **Any element with an explicit `role` attribute**

#### What it collects per entry

```ts
interface SkeletonEntry {
  scanId: number;
  tagName: string;
  /** ARIA role (explicit or implicit from tag+type) */
  role: string | null;
  /** Accessible name (aria-label > title > placeholder > alt > text) */
  name: string | null;
  /** Trimmed text content, max 200 chars */
  text: string;
  rect: { x: number; y: number; width: number; height: number };
  /** Stable attributes only: data-testid, id, aria-label, href, type, name, placeholder */
  attributes: Record<string, string>;
  /** Nearest included ancestor scanId (non-included ancestors are skipped) */
  parentScanId: number | null;
  /** Nearest included descendant scanIds (bubbles up through non-included nodes) */
  childScanIds: number[];
  /** True for interactable tags and elements with explicit role */
  interactable: boolean;
}
```

#### Tree structure

`parentScanId`/`childScanIds` form a **logical tree** over included nodes — non-included ancestors are skipped and their included descendants bubble up. This is sufficient for high-confidence locators (attribute, role_name, testid); dom_path/xpath locators will be approximate for deeply nested elements.

#### Payload sent to server

```ts
interface SkeletonPayload {
  snapshotId: string;
  sessionId: string;
  trigger: TriggerContext;
  skeleton: SkeletonEntry[];
  pageText: string;       // first ~2000 chars of visible text
  url: string;
  title: string;
  devicePixelRatio: number;
  capturedAt: string;
  screenshot?: string;    // base64 JPEG, added by background.js
}
```

#### Screenshot annotation (background.js)

The background service worker:
1. Calls `chrome.tabs.captureVisibleTab({ format: 'jpeg', quality: 50 })` immediately after receiving the skeleton payload
2. Uses `OffscreenCanvas` to draw semi-transparent orange boxes + `s{scanId}` labels over each `interactable: true` element (scaling by `devicePixelRatio`)
3. Exports the annotated JPEG as base64, forwards `{ ...payload, screenshot }` to the CLI server

---

### Stage 3 — Interactable Classification

**Runs on: CLI server** (uses serialized `ScannedElement[]` + `A11yInfo[]` from Stages 1–2)

#### Purpose

Determine which elements represent actions a user can perform, and what _kind_ of action.

#### Output

```ts
interface InteractableElement {
  scanId: number;
  /** The kind of interaction this element affords */
  interactionKind: InteractionKind;
  /** Confidence that this is genuinely interactable */
  confidence: number;
  /** Input type details if applicable */
  inputType?: string;
}

type InteractionKind =
  | "click" // buttons, links, checkboxes, radios
  | "type" // text inputs, textareas, contenteditable
  | "select" // dropdowns, listboxes
  | "toggle" // checkboxes, switches, expandable elements
  | "navigate" // links with href
  | "submit" // submit buttons, forms
  | "scroll" // scrollable containers (often implicit)
  | "none"; // not interactable
```

#### Classification rules

| Condition                                                                                                         | InteractionKind             |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `<button>`, `<input type="button,submit,reset">`, `[role="button"]`                                               | `click`                     |
| `<a href>`, `[role="link"]`                                                                                       | `navigate`                  |
| `<input type="text,email,password,search,tel,url,number">`, `<textarea>`, `[contenteditable]`, `[role="textbox"]` | `type`                      |
| `<input type="checkbox">`, `<input type="radio">`, `[role="checkbox"]`, `[role="switch"]`, `[role="radio"]`       | `toggle`                    |
| `<select>`, `[role="combobox"]`, `[role="listbox"]`                                                               | `select`                    |
| `<input type="submit">`, `<button type="submit">`                                                                 | `submit`                    |
| Has click event listener (via `getEventListeners` if available, otherwise has `onclick`/`@click` attr)            | `click` (lower confidence)  |
| Element has `cursor: pointer` computed style                                                                      | `click` (lowest confidence) |
| Everything else                                                                                                   | `none`                      |

Elements classified as `none` are filtered out for downstream stages. They may still appear as entity candidates but not as action sources.

---

### Stage 4 — Entity Grouping

**Runs on: CLI server** (uses `ScannedElement[]` parent/child relationships + `A11yInfo[]` roles)

#### Purpose

Cluster related elements into semantic entities. A "todo item" entity might contain a checkbox, a label, and a delete button.

#### Approach: ancestor-based grouping

The core heuristic: elements that share a meaningful common ancestor are likely part of the same entity. "Meaningful" is defined by:

1. **Repeated structure** — if a parent contains multiple children with the same tag/role structure, each child group is likely one entity instance (list items, table rows, card grids)
2. **Landmark roles** — `form`, `dialog`, `navigation`, `region`, `complementary` are natural entity boundaries
3. **Semantic containers** — `<article>`, `<section>`, `<li>`, `<tr>`, `<fieldset>` are natural entity boundaries
4. **`data-testid` boundaries** — if a subtree root has a `data-testid`, treat it as an entity boundary

#### Output

```ts
interface EntityCandidate {
  /** Generated ID like entity_0, entity_1 */
  candidateId: string;
  /** Human-readable name derived from heading/label/aria-label */
  name: string;
  /** How this candidate was detected */
  source:
    | "landmark"
    | "repeated_structure"
    | "semantic_container"
    | "testid"
    | "form";
  /** scanIds of elements in this entity */
  memberScanIds: number[];
  /** Signals for the DSL SignalDef */
  signals: Array<{ kind: string; value: string; weight: number }>;
  /** scanIds of interactable elements within this entity */
  interactableScanIds: number[];
}
```

#### Naming heuristic priority

1. `aria-label` or `aria-labelledby` on the container
2. First `<h1>`–`<h6>` child
3. First `<legend>` (for fieldsets)
4. `data-testid` value (titlecased, hyphens → spaces)
5. Tag name + role fallback (e.g. "Navigation Region")

---

### Stage 5 — Locator Synthesis

**Runs on: CLI server** (uses `ScannedElement[]` attributes, tag names, text content + `A11yInfo[]` roles/names)

#### Purpose

For each interactable element, generate one or more locator strategies (compatible with `LocatorStrategyDef` from contract-dsl) so that the element can be found again at runtime.

#### Strategy generation order (by preference)

| Priority | Strategy kind | How generated                                                          | Typical confidence |
| -------- | ------------- | ---------------------------------------------------------------------- | ------------------ |
| 1        | `data_testid` | `element.getAttribute('data-testid')`                                  | 0.95               |
| 2        | `role_name`   | `role` + accessible name                                               | 0.90               |
| 3        | `attribute`   | Stable attributes: `name`, `type`, `href`, `placeholder`, `aria-label` | 0.80               |
| 4        | `text`        | Visible text content (trimmed, first 100 chars)                        | 0.70               |
| 5        | `css`         | Generated CSS selector (prefer class-based, avoid dynamic classes)     | 0.60               |
| 6        | `dom_path`    | Tag path from body (e.g. `body > main > div:nth-child(2) > button`)    | 0.40               |
| 7        | `xpath`       | Full XPath (last resort)                                               | 0.30               |

#### Uniqueness check

A locator is only emitted if it uniquely identifies the element on the current page. If a `role_name` locator matches 3 elements, it is either:

- Demoted in confidence, or
- Combined with a scoping qualifier (e.g., `within entity_todo_list`)

#### Dynamic class detection

Skip classes that look auto-generated:

- Contain random strings matching pattern `[a-z]{1,3}[A-Z0-9][a-zA-Z0-9]{4,}` (e.g., `css-1a2b3c4`, `sc-bdfBwQ`)
- Start with `_` followed by hash-like characters
- Match known CSS-in-JS prefixes: `css-`, `sc-`, `emotion-`, `styled-`

#### Output

Array of `LocatorCandidate` per interactable element (minimum 1, maximum 5 strategies).

```ts
interface LocatorCandidate {
  scanId: number;
  strategies: Array<{
    kind:
      | "role_name"
      | "css"
      | "xpath"
      | "text"
      | "data_testid"
      | "attribute"
      | "dom_path";
    value: string;
    confidence: number;
  }>;
}
```

---

### Stage 6 — Manifest Draft Compilation

**Runs on: CLI server** (uses outputs of Stages 3–5)

#### Purpose

Assemble the outputs of Stages 3–5 into a draft `BrowserWireManifest` that conforms to the contract-dsl schema.

#### `RawPageSnapshot` transport shape

The content script sends a `RawPageSnapshot` containing only raw collected data to the CLI server over the existing WebSocket transport. The server runs Stages 3–6 on this data.

```ts
interface RawPageSnapshot {
  url: string;
  title: string;
  capturedAt: string;
  /** Raw DOM data from Stage 1 */
  elements: ScannedElement[];
  /** Accessibility data from Stage 2 */
  a11y: A11yInfo[];
  /** Visible page text for LLM context (first ~2000 chars) — used by Stage 7 */
  pageText?: string;
}
```

#### Compilation rules

1. **Metadata**: derive `site` from URL origin, `id` from `site + hash(url_path)`, timestamps from `capturedAt`
2. **Entities → `EntityDef[]`**: map each `EntityCandidate` to an `EntityDef`, synthesizing stable IDs (`entity_<slugified_name>`)
3. **Actions → `ActionDef[]`**: map each interactable with `interactionKind != "none"` to an `ActionDef`:
   - `entityId` = the entity that contains this interactable
   - `name` = derived from interaction kind + target accessible name (e.g., "Click Submit Button")
   - `inputs` = generated for `type` and `select` interactions (input field → `ActionInputDef`)
   - `preconditions` = `[{ id: "pre_visible", description: "Target element is visible" }]` (default)
   - `postconditions` = `[{ id: "post_exists", description: "Action completed without error" }]` (default)
   - `recipeRef` = `recipe://static-discovery/v1`
   - `locatorSet` = from Stage 5 output
   - `errors` = default set: `["ERR_TARGET_NOT_FOUND"]`
4. **Errors → `ErrorDef[]`**: emit a standard set:
   - `ERR_TARGET_NOT_FOUND` (recoverable) — locator matched no elements
   - `ERR_TARGET_AMBIGUOUS` (recoverable) — locator matched multiple elements
   - `ERR_TARGET_DISABLED` (recoverable) — element exists but is disabled
   - `ERR_ACTION_TIMEOUT` (fatal) — action did not complete in time
5. **Provenance**: `source: "agent"`, `sessionId` from scan session
6. **Versions**: `contractVersion: "1.0.0"`, `manifestVersion: "0.1.0"` (draft)

#### Validation

Run `validateManifest()` on the compiled draft. Log issues but emit the draft regardless (it's a draft, not a published contract).

---

### Stage 7 — Vision LLM Perception (`perceive.js`)

**Runs on: CLI server** — invoked *before* locator synthesis, not after.

This stage is **optional** — controlled by `BROWSERWIRE_LLM_PROVIDER` env var. If no LLM is configured, the pipeline falls back to a deterministic structural manifest (all skeleton interactables, no semantic names).

#### Purpose

Use a vision-capable LLM to identify the **15–25 most meaningful elements** from the page screenshot + HTML skeleton, infer the application domain, and assign developer-friendly semantic names — all in a single ~2.2K-token call.

The LLM sees the page *as a user would* (screenshot) plus a compact element index (HTML skeleton). It picks which elements matter and what they mean. Locators are then synthesized only for those focused elements.

#### Input to LLM

1. **Annotated screenshot** — JPEG with orange boxes + `s{scanId}` labels over interactable elements (~85 tokens)
2. **HTML skeleton** — compact representation of all skeleton entries (~1.5K tokens):

```html
<nav id="s3" role="navigation">Luma Home</nav>
<a id="s5" role="link" href="/home/calendars">Events</a>
<button id="s11" role="button">Create Event</button>
<input id="s15" role="textbox" placeholder="Search events" />
```

3. **Page context** — URL, title, first 500 chars of visible text

#### Expected LLM output

```ts
interface PerceptionResult {
  domain: string;           // e.g. "event_management"
  domainDescription: string;

  entities: Array<{
    name: string;           // snake_case noun, e.g. "navigation_bar"
    scanIds: number[];      // s-IDs of elements belonging to this region
    description: string;
  }>;

  actions: Array<{
    scanId: number;         // s-ID from the screenshot/skeleton
    semanticName: string;   // snake_case verb+noun, e.g. "create_event"
    interactionKind: "click" | "type" | "select" | "navigate";
    description: string;
  }>;

  compositeActions: Array<{
    name: string;           // e.g. "search_events"
    stepScanIds: number[];  // ordered scanIds of the steps
    inputs: Array<{ name: string; type: string; description: string }>;
    description: string;
  }>;
}
```

#### Validation

All `scanId` values in the output are validated against the input skeleton. Any reference to an unknown scanId is dropped. On total failure, `perceiveSnapshot()` returns `null` and the pipeline falls back to a structural manifest of all interactable elements.

#### Post-perception: focusAndInspect

After perception, `session.js` runs `focusAndInspect()`:

1. Filter skeleton to focused scanIds (LLM actions + entity members)
2. Map skeleton entries → `elements[]` and `a11y[]` (locators.js-compatible)
3. Build `interactables[]` from LLM actions, `entities[]` from LLM entities
4. `synthesizeAllLocators(elements, a11y, interactables)` — unchanged
5. `compileManifest(...)` → draft manifest — unchanged
6. `mergeEnrichment(draft, perception→enrichmentFormat)` — apply semantic names

#### LLM provider configuration

```
BROWSERWIRE_LLM_PROVIDER=openai|anthropic|gemini|ollama    # required for Stage 7
BROWSERWIRE_LLM_MODEL=gpt-4o|claude-sonnet-4-20250514|llama3
BROWSERWIRE_LLM_API_KEY=sk-...
BROWSERWIRE_LLM_BASE_URL=http://localhost:11434      # custom endpoint
```

Vision support: `openai` provider requires a vision-capable model (gpt-4o). `anthropic` works with claude-3+ models. `gemini` works with gemini-2.5-flash+. `ollama` depends on the local model.

#### Fallback behavior

- No LLM configured → structural manifest, no semantic names, no composites
- LLM call fails or returns invalid JSON → same fallback
- No screenshot available → text-only fallback (skeleton + page text only, no image)
- Individual scanId references invalid → that item silently dropped, rest applied

#### Output files (per session)

```
logs/session-{id}/manifest.json        ← final merged manifest (structural)
logs/session-{id}/manifest-draft.json  ← same (no separate draft in vision pipeline)
logs/session-{id}/session.json         ← session metadata + per-snapshot stats
logs/session-{id}/{snapshotId}.json    ← individual snapshot payloads (debug mode only)
```

Per-snapshot enriched manifests (with semantic names) are stored in memory on the session object; the final on-disk manifest is a structural merge across all snapshots.

## 5. Transport and message protocol

Reuse the existing WebSocket transport (content-script → background.js → CLI server). Add new message types to `extension/shared/protocol.js`:

```js
// New message types for static discovery
DISCOVERY_SCAN; // content → background: trigger a scan
DISCOVERY_SNAPSHOT; // content → background → server: PageSnapshot payload
DISCOVERY_RESULT; // server → background → content: compiled manifest or errors
```

#### Trigger modes

- **Exploration session**: user clicks "Start Exploring" in the sidepanel → immediate initial scan + auto-re-scan on interactions. See [dynamic-discovery.md](./dynamic-discovery.md).
- **Auto**: scan on page load (configurable, off by default)

## 6. What this does NOT cover

- **Multi-step workflows** — static discovery sees one page state. Composite actions (Stage 7) group visible actions but don't capture multi-page flows. Addressed in [Dynamic Discovery](./dynamic-discovery.md).
- **Dynamic state** — elements that appear only after interaction (modals, dropdowns) aren't scanned unless already visible. Addressed in [Dynamic Discovery](./dynamic-discovery.md) via interaction-triggered re-scanning.
- **Runtime execution** — this generates manifests, not an execution engine.
- **SDK/API generation** — the enriched manifest is the input for API generation, which is a separate pipeline.
- **Cross-page discovery** — each scan is one page. Site-wide manifests are future scope.
- **LLM-generated locators** — locators are always deterministic (Stages 1–5). The LLM only enriches names and creates composite groupings.

## 7. Implementation modules

```
extension/
  discovery.js              // runSkeletonScan() — Stage 1 skeleton walk
                            // runDiscoveryScan() — kept for legacy compat
  background.js             // annotateScreenshot() — OffscreenCanvas annotation
                            // handleDiscoveryIncremental() — async: capture → annotate → forward
  content-script.js         // triggerScan() — calls runSkeletonScan(), sends skeleton payload

cli/discovery/
  perceive.js               // Stage 7 — vision LLM perception (NEW)
  session.js                // focusAndInspect() — skeleton → elements → locators → manifest
                            // DiscoverySession.addSnapshot() — perceive → focusAndInspect
                            // DiscoverySession.finalize()    — merge → compile (no LLM Pass 2)
  locators.js               // Stage 5 — locator synthesis (unchanged)
  compile.js                // Stage 6 — manifest compilation (unchanged)
  enrich.js                 // mergeEnrichment() — exported for session.js use
                            // enrichManifest()  — still used by legacy one-shot path
  llm-client.js             // callLLM(), callLLMWithVision() — provider abstraction
  classify.js               // Stage 3 — still used by legacy one-shot path in server.js
  entities.js               // Stage 4 — still used by legacy one-shot path in server.js

cli/
  server.js                 // DISCOVERY_INCREMENTAL handler → session.addSnapshot()
                            // DISCOVERY_SNAPSHOT handler — legacy one-shot path (unchanged)
```

## 8. Acceptance criteria

### Stages 1–6 (deterministic)

- Scan a page and receive a `PageSnapshot` with `entities`, `interactions`, `locators`
- Compile a valid draft `BrowserWireManifest` from the snapshot
- `validateManifest()` reports only expected draft-level issues (placeholder conditions), not structural errors
- Locator strategies: at least 1 per action, with confidence values
- Entity grouping: forms, lists, and landmark regions are detected as entity boundaries
- Performance: scan completes in < 2 seconds on a page with 2000 DOM elements
- Transport: snapshot delivered via existing WebSocket pipeline

### Stage 7 (LLM enrichment)

- When LLM is configured, the enriched manifest contains `semanticName` on entities and actions
- Entity/action `semanticName` values reflect domain vocabulary (not DOM vocabulary)
- Composite actions reference valid existing action IDs only
- When LLM is not configured, the pipeline emits the deterministic draft without error
- When LLM returns invalid output, the pipeline falls back to the deterministic draft
- All original manifest data (locators, signals, IDs) is preserved after enrichment

## 9. Example: scanning a login page

Page structure:

```html
<main>
  <form data-testid="login-form">
    <h2>Sign In</h2>
    <label for="email">Email</label>
    <input id="email" type="email" placeholder="you@example.com" />
    <label for="password">Password</label>
    <input id="password" type="password" />
    <button type="submit">Sign In</button>
    <a href="/forgot-password">Forgot password?</a>
  </form>
</main>
```

Expected Stage 6 draft output:

- **1 entity**: "Sign In" (form, testid: `login-form`)
- **4 actions**:
  - `type` on email input — locators: `role_name: textbox "Email"`, `attribute: placeholder "you@example.com"`, `data_testid: login-form > input[type=email]`
  - `type` on password input — locators: `role_name: textbox "Password"`
  - `submit` on button — locators: `role_name: button "Sign In"`, `text: Sign In`
  - `navigate` on "Forgot password?" link — locators: `role_name: link "Forgot password?"`, `text: Forgot password?`
- **Standard error set**: `ERR_TARGET_NOT_FOUND`, `ERR_TARGET_AMBIGUOUS`, `ERR_TARGET_DISABLED`, `ERR_ACTION_TIMEOUT`

Expected Stage 7 enriched output:

- **Domain**: `authentication`
- **1 entity**: `login_form` (semanticName), originally "Sign In"
- **4 actions** with semantic names:
  - `enter_email` — "Type into Email"
  - `enter_password` — "Type into Password"
  - `submit_login` — "Submit Sign In"
  - `go_to_password_recovery` — "Navigate to Forgot password?"
- **1 composite action**: `login(email, password)` — steps: `enter_email` → `enter_password` → `submit_login`
