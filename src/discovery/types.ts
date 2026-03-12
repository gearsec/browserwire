/**
 * Discovery types — shared interfaces for static discovery pipeline.
 *
 * These types define the data shapes flowing through Stages 1–6.
 * Stage 1–2 run in the content script; Stages 3–6 run on the CLI server.
 */

// ---------------------------------------------------------------------------
// Stage 1 — DOM Scan output
// ---------------------------------------------------------------------------

export interface ScannedElement {
  /** Temporary ID for this scan, not stable across scans */
  scanId: number;
  /** Parent scanId, null for root */
  parentScanId: number | null;
  tagName: string;
  attributes: Record<string, string>;
  /** Visible text content (direct, not inherited), trimmed */
  textContent: string;
  /** Bounding rect — used for visibility filtering */
  boundingRect: { x: number; y: number; width: number; height: number } | null;
  /** Is the element visible */
  isVisible: boolean;
  /** Child scanIds */
  childScanIds: number[];
}

// ---------------------------------------------------------------------------
// Stage 2 — Accessibility Extraction output
// ---------------------------------------------------------------------------

export interface A11yInfo {
  scanId: number;
  role: string | null;
  name: string | null;
  description: string | null;
  isDisabled: boolean;
  isRequired: boolean;
  expandedState: "true" | "false" | null;
  checkedState: "true" | "false" | "mixed" | null;
  selectedState: "true" | "false" | null;
}

// ---------------------------------------------------------------------------
// Transport — content script → backend
// ---------------------------------------------------------------------------

export interface RawPageSnapshot {
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

// ---------------------------------------------------------------------------
// Stage 3 — Interactable Classification output
// ---------------------------------------------------------------------------

export type InteractionKind =
  | "click"
  | "type"
  | "select"
  | "toggle"
  | "navigate"
  | "submit"
  | "scroll"
  | "none";

export interface InteractableElement {
  scanId: number;
  /** The kind of interaction this element affords */
  interactionKind: InteractionKind;
  /** Confidence that this is genuinely interactable (0–1) */
  confidence: number;
  /** Input type details if applicable (e.g. "email", "password") */
  inputType?: string;
}

// ---------------------------------------------------------------------------
// Stage 4 — Entity Grouping output
// ---------------------------------------------------------------------------

export type EntitySource =
  | "landmark"
  | "repeated_structure"
  | "semantic_container"
  | "testid"
  | "form";

export interface EntityCandidate {
  /** Generated ID like entity_0, entity_1 */
  candidateId: string;
  /** Human-readable name derived from heading/label/aria-label */
  name: string;
  /** How this candidate was detected */
  source: EntitySource;
  /** scanId of the root element for this entity */
  rootScanId: number;
  /** scanIds of all elements in this entity */
  memberScanIds: number[];
  /** Signals for the DSL SignalDef */
  signals: Array<{ kind: string; value: string; weight: number }>;
  /** scanIds of interactable elements within this entity */
  interactableScanIds: number[];
}

// ---------------------------------------------------------------------------
// Stage 5 — Locator Synthesis output
// ---------------------------------------------------------------------------

export type LocatorKindValue =
  | "role_name"
  | "css"
  | "xpath"
  | "text"
  | "data_testid"
  | "attribute"
  | "dom_path";

export interface LocatorStrategy {
  kind: LocatorKindValue;
  value: string;
  confidence: number;
}

export interface LocatorCandidate {
  scanId: number;
  strategies: LocatorStrategy[];
}
