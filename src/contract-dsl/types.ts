export const SIGNAL_KINDS = [
  "role",
  "text",
  "url_pattern",
  "state",
  "attribute"
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const LOCATOR_KINDS = [
  "role_name",
  "css",
  "xpath",
  "text",
  "data_testid",
  "attribute",
  "dom_path"
] as const;

export type LocatorKind = (typeof LOCATOR_KINDS)[number];

export const ERROR_CLASSIFICATIONS = ["recoverable", "fatal", "security"] as const;

export type ErrorClassification = (typeof ERROR_CLASSIFICATIONS)[number];

export const ACTION_INPUT_TYPES = ["string", "number", "boolean", "enum"] as const;

export type ActionInputType = (typeof ACTION_INPUT_TYPES)[number];

export const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const PROVENANCE_SOURCES = ["human", "agent", "hybrid"] as const;

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export interface ConfidenceDef {
  score: number;
  level: ConfidenceLevel;
  rationale?: string;
}

export interface SignalDef {
  kind: SignalKind;
  value: string;
  weight: number;
}

export interface ProvenanceDef {
  source: ProvenanceSource;
  sessionId: string;
  traceIds: string[];
  annotationIds: string[];
  capturedAt: string;
}

export interface EntityDef {
  id: string;
  name: string;
  description: string;
  /** LLM-assigned domain-level name (Stage 7) */
  semanticName?: string;
  signals: SignalDef[];
  confidence?: ConfidenceDef;
  provenance: ProvenanceDef;
}

export interface ActionInputDef {
  name: string;
  type: ActionInputType;
  required: boolean;
  description?: string;
  enumValues?: string[];
}

export interface GuardConditionDef {
  id: string;
  description: string;
  inputRefs?: string[];
  stateRef?: string;
  expectedValue?: string;
  pageId?: string;
}

export interface LocatorStrategyDef {
  kind: LocatorKind;
  value: string;
  confidence: number;
}

export interface LocatorSetDef {
  id: string;
  strategies: LocatorStrategyDef[];
}

export interface ErrorDef {
  code: string;
  messageTemplate: string;
  classification: ErrorClassification;
}

export interface ActionDef {
  id: string;
  entityId: string;
  name: string;
  description?: string;
  /** LLM-assigned domain-level name (Stage 7) */
  semanticName?: string;
  /** Original interaction kind from Stage 3 (click, type, select, etc.) */
  interactionKind?: string;
  /** Visible text content of the target element */
  textContent?: string;
  inputs: ActionInputDef[];
  requiredInputRefs?: string[];
  preconditions: GuardConditionDef[];
  postconditions: GuardConditionDef[];
  recipeRef: string;
  locatorSet: LocatorSetDef;
  errors: string[];
  confidence?: ConfidenceDef;
  provenance: ProvenanceDef;
}

export const VIEW_FIELD_TYPES = ["string", "number", "boolean", "date"] as const;

export type ViewFieldType = (typeof VIEW_FIELD_TYPES)[number];

export interface ViewFieldDef {
  name: string;
  type: ViewFieldType;
  description?: string;
  locator: LocatorStrategyDef;
}

export interface ViewDef {
  id: string;
  name: string;
  semanticName?: string;
  description: string;
  entityId?: string;
  isList: boolean;
  isDynamic?: boolean;
  containerLocator: LocatorSetDef;
  itemContainer?: LocatorStrategyDef;
  fields: ViewFieldDef[];
  confidence?: ConfidenceDef;
  provenance: ProvenanceDef;
}

export const STATE_SIGNAL_KINDS = [
  "selector_exists",
  "text_match",
  "url_pattern"
] as const;

export type StateSignalKind = (typeof STATE_SIGNAL_KINDS)[number];

export interface StateSignal {
  kind: StateSignalKind;
  value: string;
  selector?: string;
  weight: number;
}

export interface PageDef {
  id: string;
  routePattern: string;
  name: string;
  description: string;
  viewIds: string[];
  actionIds: string[];
  stateSignals?: StateSignal[];
}

export interface ManifestMetadata {
  id: string;
  site: string;
  createdAt: string;
  updatedAt?: string;
}

export interface CompositeActionDef {
  id: string;
  name: string;
  description: string;
  /** Ordered references to existing ActionDef IDs */
  stepActionIds: string[];
  inputs: ActionInputDef[];
  provenance: ProvenanceDef;
}

export interface WorkflowStep {
  type: "navigate" | "fill" | "select" | "click" | "submit" | "read_view";
  url?: string;           // only for "navigate": relative or absolute URL
  actionId?: string;      // reference to manifest.actions[].id (fill/select/click/submit)
  viewId?: string;        // reference to manifest.views[].id (read_view only)
  inputParam?: string;    // which workflow input to pass as value (fill/select only)
}

export interface OutcomeSignal {
  kind: "url_change" | "element_appears" | "text_contains" | "element_disappears";
  value: string;
  selector?: string;      // for text_contains: element whose text to check
}

export interface WorkflowActionDef {
  id: string;             // "workflow_list_events"
  name: string;           // "list_events" (snake_case verb_noun)
  description: string;
  kind: "read" | "write" | "mixed";
  inputs: ActionInputDef[];
  steps: WorkflowStep[];
  outcomes?: { success?: OutcomeSignal; failure?: OutcomeSignal }; // write/mixed only
  provenance: ProvenanceDef;
}

export interface BrowserWireManifest {
  contractVersion: string;
  manifestVersion: string;
  metadata: ManifestMetadata;
  /** Identified application domain (Stage 7) */
  domain?: string;
  /** Human description of the site/page (Stage 7) */
  domainDescription?: string;
  entities: EntityDef[];
  actions: ActionDef[];
  /** Multi-step operations composed from existing actions (Stage 7) */
  compositeActions?: CompositeActionDef[];
  /** Read operations — structured data extraction from the page */
  views?: ViewDef[];
  /** Route-organized page groupings */
  pages?: PageDef[];
  /** Task-level workflow APIs synthesized from manifest (Stage 8) */
  workflowActions?: WorkflowActionDef[];
  errors: ErrorDef[];
}

export const VALIDATION_ISSUE_CODES = [
  "ERR_SCHEMA_REQUIRED",
  "ERR_SCHEMA_TYPE",
  "ERR_ENUM_INVALID",
  "ERR_DUPLICATE_ID",
  "ERR_INVALID_SEMVER",
  "ERR_INVALID_ISO_DATE",
  "ERR_INVALID_RECIPE_REF",
  "ERR_ENTITY_NOT_FOUND",
  "ERR_ERROR_CODE_NOT_FOUND",
  "ERR_INPUT_REF_NOT_FOUND",
  "ERR_MISSING_CONDITIONS",
  "ERR_LOCATORSET_EMPTY",
  "ERR_SIGNAL_WEIGHT_RANGE",
  "ERR_LOCATOR_CONFIDENCE_RANGE",
  "ERR_ENUM_VALUES_REQUIRED",
  "ERR_CONFIDENCE_SCORE_RANGE",
  "ERR_CONFIDENCE_LEVEL_MISMATCH",
  "ERR_COMPATIBILITY_VERSION",
  "ERR_COMPATIBILITY_BREAKING",
  "ERR_MIGRATION_PATH_NOT_FOUND",
  "ERR_VIEW_FIELD_INVALID",
  "ERR_PAGE_REF_NOT_FOUND"
] as const;

export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  code: ValidationIssueCode;
  path: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export type VersionBump = "none" | "patch" | "minor" | "major";

export interface ManifestDiff {
  requiredBump: VersionBump;
  breakingChanges: string[];
  additiveChanges: string[];
  patchChanges: string[];
}

export interface CompatibilityReport extends ManifestDiff {
  compatible: boolean;
  actualBump: VersionBump | "downgrade";
  issues: ValidationIssue[];
}

export interface ManifestMigration {
  fromVersion: string;
  toVersion: string;
  migrate: (manifest: BrowserWireManifest) => BrowserWireManifest;
}
