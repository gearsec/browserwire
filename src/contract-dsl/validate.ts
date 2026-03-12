import {
  ACTION_INPUT_TYPES,
  CONFIDENCE_LEVELS,
  ERROR_CLASSIFICATIONS,
  LOCATOR_KINDS,
  PROVENANCE_SOURCES,
  SIGNAL_KINDS,
  VIEW_FIELD_TYPES,
  type BrowserWireManifest,
  type ValidationIssue,
  type ValidationIssueCode,
  type ValidationResult
} from "./types";
import { isValidSemver } from "./semver";

const RECIPE_REF_PATTERN = /^recipe:\/\/[a-zA-Z0-9._/-]+\/v\d+$/;
const ERROR_CODE_PATTERN = /^ERR_[A-Z0-9_]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoDateString(value: string): boolean {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return false;
  }

  return new Date(timestamp).toISOString() === value;
}

function addIssue(
  issues: ValidationIssue[],
  code: ValidationIssueCode,
  path: string,
  message: string,
  details?: Record<string, unknown>
): void {
  issues.push({ code, path, message, details });
}

function requireString(
  issues: ValidationIssue[],
  parentPath: string,
  property: string,
  value: unknown
): void {
  const path = `${parentPath}.${property}`;
  if (value === undefined || value === null) {
    addIssue(issues, "ERR_SCHEMA_REQUIRED", path, "Required string field is missing.");
    return;
  }

  if (!isNonEmptyString(value)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected a non-empty string.");
  }
}

function requireBoolean(
  issues: ValidationIssue[],
  parentPath: string,
  property: string,
  value: unknown
): void {
  const path = `${parentPath}.${property}`;
  if (value === undefined || value === null) {
    addIssue(issues, "ERR_SCHEMA_REQUIRED", path, "Required boolean field is missing.");
    return;
  }

  if (typeof value !== "boolean") {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected a boolean.");
  }
}

function requireStringArray(
  issues: ValidationIssue[],
  parentPath: string,
  property: string,
  value: unknown,
  options: { allowEmpty?: boolean } = {}
): string[] {
  const path = `${parentPath}.${property}`;
  if (!Array.isArray(value)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected an array of strings.");
    return [];
  }

  if (!options.allowEmpty && value.length === 0) {
    addIssue(issues, "ERR_SCHEMA_REQUIRED", path, "Expected at least one value.");
  }

  return value
    .map((item, index) => {
      if (!isNonEmptyString(item)) {
        addIssue(
          issues,
          "ERR_SCHEMA_TYPE",
          `${path}[${index}]`,
          "Expected a non-empty string entry."
        );
        return null;
      }
      return item;
    })
    .filter((item): item is string => item !== null);
}

function validateConfidence(
  issues: ValidationIssue[],
  path: string,
  confidence: unknown
): void {
  if (confidence === undefined) {
    return;
  }

  if (!isRecord(confidence)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected confidence object.");
    return;
  }

  const scorePath = `${path}.score`;
  const levelPath = `${path}.level`;
  const score = confidence.score;
  const level = confidence.level;

  if (typeof score !== "number" || Number.isNaN(score) || score < 0 || score > 1) {
    addIssue(
      issues,
      "ERR_CONFIDENCE_SCORE_RANGE",
      scorePath,
      "Confidence score must be between 0 and 1 inclusive."
    );
  }

  if (!CONFIDENCE_LEVELS.includes(level as (typeof CONFIDENCE_LEVELS)[number])) {
    addIssue(
      issues,
      "ERR_ENUM_INVALID",
      levelPath,
      `Confidence level must be one of: ${CONFIDENCE_LEVELS.join(", ")}.`
    );
    return;
  }

  if (typeof score === "number" && score >= 0 && score <= 1) {
    const expectedLevel = score <= 0.33 ? "low" : score <= 0.66 ? "medium" : "high";
    if (level !== expectedLevel) {
      addIssue(
        issues,
        "ERR_CONFIDENCE_LEVEL_MISMATCH",
        levelPath,
        `Confidence level '${String(level)}' does not match score ${score}. Expected '${expectedLevel}'.`
      );
    }
  }
}

function validateProvenance(
  issues: ValidationIssue[],
  path: string,
  provenance: unknown
): void {
  if (!isRecord(provenance)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected provenance object.");
    return;
  }

  const sourcePath = `${path}.source`;
  if (!PROVENANCE_SOURCES.includes(provenance.source as (typeof PROVENANCE_SOURCES)[number])) {
    addIssue(
      issues,
      "ERR_ENUM_INVALID",
      sourcePath,
      `Provenance source must be one of: ${PROVENANCE_SOURCES.join(", ")}.`
    );
  }

  requireString(issues, path, "sessionId", provenance.sessionId);
  requireStringArray(issues, path, "traceIds", provenance.traceIds, { allowEmpty: true });
  requireStringArray(issues, path, "annotationIds", provenance.annotationIds, { allowEmpty: true });
  requireString(issues, path, "capturedAt", provenance.capturedAt);

  if (isNonEmptyString(provenance.capturedAt) && !isIsoDateString(provenance.capturedAt)) {
    addIssue(
      issues,
      "ERR_INVALID_ISO_DATE",
      `${path}.capturedAt`,
      "Expected an ISO-8601 date-time string (UTC)."
    );
  }
}

function validateEntity(issues: ValidationIssue[], path: string, entity: unknown): void {
  if (!isRecord(entity)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected entity object.");
    return;
  }

  requireString(issues, path, "id", entity.id);
  requireString(issues, path, "name", entity.name);
  requireString(issues, path, "description", entity.description);

  const signalsPath = `${path}.signals`;
  if (!Array.isArray(entity.signals)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", signalsPath, "Expected signals array.");
  } else {
    if (entity.signals.length === 0) {
      addIssue(issues, "ERR_SCHEMA_REQUIRED", signalsPath, "At least one signal is required.");
    }

    entity.signals.forEach((signal, index) => {
      const signalPath = `${signalsPath}[${index}]`;
      if (!isRecord(signal)) {
        addIssue(issues, "ERR_SCHEMA_TYPE", signalPath, "Expected signal object.");
        return;
      }

      if (!SIGNAL_KINDS.includes(signal.kind as (typeof SIGNAL_KINDS)[number])) {
        addIssue(
          issues,
          "ERR_ENUM_INVALID",
          `${signalPath}.kind`,
          `Signal kind must be one of: ${SIGNAL_KINDS.join(", ")}.`
        );
      }
      requireString(issues, signalPath, "value", signal.value);

      if (
        typeof signal.weight !== "number" ||
        Number.isNaN(signal.weight) ||
        signal.weight < 0 ||
        signal.weight > 1
      ) {
        addIssue(
          issues,
          "ERR_SIGNAL_WEIGHT_RANGE",
          `${signalPath}.weight`,
          "Signal weight must be between 0 and 1 inclusive."
        );
      }
    });
  }

  validateConfidence(issues, `${path}.confidence`, entity.confidence);
  validateProvenance(issues, `${path}.provenance`, entity.provenance);
}

function validateActionInput(issues: ValidationIssue[], path: string, input: unknown): string | null {
  if (!isRecord(input)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected action input object.");
    return null;
  }

  requireString(issues, path, "name", input.name);
  requireBoolean(issues, path, "required", input.required);

  if (!ACTION_INPUT_TYPES.includes(input.type as (typeof ACTION_INPUT_TYPES)[number])) {
    addIssue(
      issues,
      "ERR_ENUM_INVALID",
      `${path}.type`,
      `Input type must be one of: ${ACTION_INPUT_TYPES.join(", ")}.`
    );
  }

  if (input.type === "enum") {
    const enumValues = requireStringArray(issues, path, "enumValues", input.enumValues);
    if (enumValues.length === 0) {
      addIssue(
        issues,
        "ERR_ENUM_VALUES_REQUIRED",
        `${path}.enumValues`,
        "Enum input type requires at least one enum value."
      );
    }
  }

  return isNonEmptyString(input.name) ? input.name : null;
}

function validateConditions(
  issues: ValidationIssue[],
  path: string,
  value: unknown,
  kind: "preconditions" | "postconditions"
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected condition array.");
    return;
  }

  if (value.length === 0) {
    addIssue(
      issues,
      "ERR_MISSING_CONDITIONS",
      path,
      `Action must include at least one ${kind}.`
    );
  }

  value.forEach((condition, index) => {
    const conditionPath = `${path}[${index}]`;
    if (!isRecord(condition)) {
      addIssue(issues, "ERR_SCHEMA_TYPE", conditionPath, "Expected condition object.");
      return;
    }

    requireString(issues, conditionPath, "id", condition.id);
    requireString(issues, conditionPath, "description", condition.description);
    if (condition.inputRefs !== undefined) {
      requireStringArray(issues, conditionPath, "inputRefs", condition.inputRefs, { allowEmpty: true });
    }
  });
}

function validateLocatorSet(issues: ValidationIssue[], path: string, locatorSet: unknown): void {
  if (!isRecord(locatorSet)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected locator set object.");
    return;
  }

  requireString(issues, path, "id", locatorSet.id);
  const strategiesPath = `${path}.strategies`;
  if (!Array.isArray(locatorSet.strategies)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", strategiesPath, "Expected strategies array.");
    return;
  }

  if (locatorSet.strategies.length === 0) {
    addIssue(
      issues,
      "ERR_LOCATORSET_EMPTY",
      strategiesPath,
      "Locator set must include at least one locator strategy."
    );
  }

  locatorSet.strategies.forEach((strategy, index) => {
    const strategyPath = `${strategiesPath}[${index}]`;
    if (!isRecord(strategy)) {
      addIssue(issues, "ERR_SCHEMA_TYPE", strategyPath, "Expected locator strategy object.");
      return;
    }

    if (!LOCATOR_KINDS.includes(strategy.kind as (typeof LOCATOR_KINDS)[number])) {
      addIssue(
        issues,
        "ERR_ENUM_INVALID",
        `${strategyPath}.kind`,
        `Locator kind must be one of: ${LOCATOR_KINDS.join(", ")}.`
      );
    }
    requireString(issues, strategyPath, "value", strategy.value);
    if (
      typeof strategy.confidence !== "number" ||
      Number.isNaN(strategy.confidence) ||
      strategy.confidence < 0 ||
      strategy.confidence > 1
    ) {
      addIssue(
        issues,
        "ERR_LOCATOR_CONFIDENCE_RANGE",
        `${strategyPath}.confidence`,
        "Locator confidence must be between 0 and 1 inclusive."
      );
    }
  });
}

function validateAction(issues: ValidationIssue[], path: string, action: unknown): void {
  if (!isRecord(action)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected action object.");
    return;
  }

  requireString(issues, path, "id", action.id);
  requireString(issues, path, "entityId", action.entityId);
  requireString(issues, path, "name", action.name);

  if (!Array.isArray(action.inputs)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", `${path}.inputs`, "Expected action inputs array.");
  } else {
    const seenInputNames = new Set<string>();
    action.inputs.forEach((input, index) => {
      const inputPath = `${path}.inputs[${index}]`;
      const inputName = validateActionInput(issues, inputPath, input);
      if (!inputName) {
        return;
      }

      if (seenInputNames.has(inputName)) {
        addIssue(
          issues,
          "ERR_DUPLICATE_ID",
          `${inputPath}.name`,
          `Duplicate input name '${inputName}' in action '${String(action.id)}'.`
        );
      }
      seenInputNames.add(inputName);
    });

    if (action.requiredInputRefs !== undefined) {
      const requiredRefs = requireStringArray(
        issues,
        path,
        "requiredInputRefs",
        action.requiredInputRefs,
        { allowEmpty: true }
      );

      requiredRefs.forEach((ref, index) => {
        if (!seenInputNames.has(ref)) {
          addIssue(
            issues,
            "ERR_INPUT_REF_NOT_FOUND",
            `${path}.requiredInputRefs[${index}]`,
            `Referenced input '${ref}' does not exist on action '${String(action.id)}'.`
          );
        }
      });
    }
  }

  validateConditions(issues, `${path}.preconditions`, action.preconditions, "preconditions");
  validateConditions(issues, `${path}.postconditions`, action.postconditions, "postconditions");
  validateLocatorSet(issues, `${path}.locatorSet`, action.locatorSet);

  if (!isNonEmptyString(action.recipeRef) || !RECIPE_REF_PATTERN.test(action.recipeRef)) {
    addIssue(
      issues,
      "ERR_INVALID_RECIPE_REF",
      `${path}.recipeRef`,
      "Recipe reference must match pattern recipe://<path>/v<number>."
    );
  }

  const errors = requireStringArray(issues, path, "errors", action.errors);
  if (errors.length === 0) {
    addIssue(
      issues,
      "ERR_SCHEMA_REQUIRED",
      `${path}.errors`,
      "Action must define at least one typed error reference."
    );
  }

  validateConfidence(issues, `${path}.confidence`, action.confidence);
  validateProvenance(issues, `${path}.provenance`, action.provenance);
}

function validateErrorDef(issues: ValidationIssue[], path: string, errorDef: unknown): string | null {
  if (!isRecord(errorDef)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected error definition object.");
    return null;
  }

  requireString(issues, path, "code", errorDef.code);
  requireString(issues, path, "messageTemplate", errorDef.messageTemplate);
  if (!ERROR_CLASSIFICATIONS.includes(errorDef.classification as (typeof ERROR_CLASSIFICATIONS)[number])) {
    addIssue(
      issues,
      "ERR_ENUM_INVALID",
      `${path}.classification`,
      `Error classification must be one of: ${ERROR_CLASSIFICATIONS.join(", ")}.`
    );
  }

  if (isNonEmptyString(errorDef.code) && !ERROR_CODE_PATTERN.test(errorDef.code)) {
    addIssue(
      issues,
      "ERR_SCHEMA_TYPE",
      `${path}.code`,
      "Error code must match pattern ERR_<UPPER_SNAKE_CASE>."
    );
  }

  return isNonEmptyString(errorDef.code) ? errorDef.code : null;
}

function validateMetadata(issues: ValidationIssue[], metadata: unknown): void {
  const path = "metadata";
  if (!isRecord(metadata)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected metadata object.");
    return;
  }

  requireString(issues, path, "id", metadata.id);
  requireString(issues, path, "site", metadata.site);
  requireString(issues, path, "createdAt", metadata.createdAt);
  if (metadata.updatedAt !== undefined) {
    requireString(issues, path, "updatedAt", metadata.updatedAt);
  }

  if (isNonEmptyString(metadata.createdAt) && !isIsoDateString(metadata.createdAt)) {
    addIssue(
      issues,
      "ERR_INVALID_ISO_DATE",
      `${path}.createdAt`,
      "Expected an ISO-8601 date-time string (UTC)."
    );
  }
  if (isNonEmptyString(metadata.updatedAt) && !isIsoDateString(metadata.updatedAt)) {
    addIssue(
      issues,
      "ERR_INVALID_ISO_DATE",
      `${path}.updatedAt`,
      "Expected an ISO-8601 date-time string (UTC)."
    );
  }
}

function validateViewField(issues: ValidationIssue[], path: string, field: unknown): void {
  if (!isRecord(field)) {
    addIssue(issues, "ERR_VIEW_FIELD_INVALID", path, "Expected view field object.");
    return;
  }

  requireString(issues, path, "name", field.name);

  if (!VIEW_FIELD_TYPES.includes(field.type as (typeof VIEW_FIELD_TYPES)[number])) {
    addIssue(
      issues,
      "ERR_VIEW_FIELD_INVALID",
      `${path}.type`,
      `View field type must be one of: ${VIEW_FIELD_TYPES.join(", ")}.`
    );
  }

  // Validate field locator
  const locatorPath = `${path}.locator`;
  if (!isRecord(field.locator)) {
    addIssue(issues, "ERR_VIEW_FIELD_INVALID", locatorPath, "View field must have a locator.");
    return;
  }
  if (!LOCATOR_KINDS.includes(field.locator.kind as (typeof LOCATOR_KINDS)[number])) {
    addIssue(
      issues,
      "ERR_ENUM_INVALID",
      `${locatorPath}.kind`,
      `Locator kind must be one of: ${LOCATOR_KINDS.join(", ")}.`
    );
  }
  requireString(issues, locatorPath, "value", field.locator.value);
}

function validateView(issues: ValidationIssue[], path: string, view: unknown): void {
  if (!isRecord(view)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected view object.");
    return;
  }

  requireString(issues, path, "id", view.id);
  requireString(issues, path, "name", view.name);
  requireString(issues, path, "description", view.description);
  requireBoolean(issues, path, "isList", view.isList);

  // Validate containerLocator
  validateLocatorSet(issues, `${path}.containerLocator`, view.containerLocator);

  // Validate fields
  const fieldsPath = `${path}.fields`;
  if (!Array.isArray(view.fields)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", fieldsPath, "Expected fields array.");
  } else {
    if (view.fields.length === 0) {
      addIssue(issues, "ERR_VIEW_FIELD_INVALID", fieldsPath, "View must have at least one field.");
    }
    view.fields.forEach((field, index) => {
      validateViewField(issues, `${fieldsPath}[${index}]`, field);
    });
  }

  // Optional itemLocator (for lists)
  if (view.itemLocator !== undefined && view.itemLocator !== null) {
    const itemPath = `${path}.itemLocator`;
    if (!isRecord(view.itemLocator)) {
      addIssue(issues, "ERR_SCHEMA_TYPE", itemPath, "Expected locator strategy object.");
    } else {
      if (!LOCATOR_KINDS.includes(view.itemLocator.kind as (typeof LOCATOR_KINDS)[number])) {
        addIssue(
          issues,
          "ERR_ENUM_INVALID",
          `${itemPath}.kind`,
          `Locator kind must be one of: ${LOCATOR_KINDS.join(", ")}.`
        );
      }
      requireString(issues, itemPath, "value", view.itemLocator.value);
    }
  }

  validateConfidence(issues, `${path}.confidence`, view.confidence);
  validateProvenance(issues, `${path}.provenance`, view.provenance);
}

function validatePage(
  issues: ValidationIssue[],
  path: string,
  page: unknown,
  knownViewIds: Set<string>,
  knownActionIds: Set<string>
): void {
  if (!isRecord(page)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", path, "Expected page object.");
    return;
  }

  requireString(issues, path, "id", page.id);
  requireString(issues, path, "routePattern", page.routePattern);
  requireString(issues, path, "name", page.name);
  requireString(issues, path, "description", page.description);

  // Validate viewIds reference existing views
  if (Array.isArray(page.viewIds)) {
    page.viewIds.forEach((viewId, index) => {
      if (typeof viewId === "string" && !knownViewIds.has(viewId)) {
        addIssue(
          issues,
          "ERR_PAGE_REF_NOT_FOUND",
          `${path}.viewIds[${index}]`,
          `Page references unknown view id '${viewId}'.`
        );
      }
    });
  }

  // Validate actionIds reference existing actions
  if (Array.isArray(page.actionIds)) {
    page.actionIds.forEach((actionId, index) => {
      if (typeof actionId === "string" && !knownActionIds.has(actionId)) {
        addIssue(
          issues,
          "ERR_PAGE_REF_NOT_FOUND",
          `${path}.actionIds[${index}]`,
          `Page references unknown action id '${actionId}'.`
        );
      }
    });
  }
}

export function validateManifest(manifest: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isRecord(manifest)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", "$", "Manifest must be an object.");
    return { valid: false, issues };
  }

  requireString(issues, "$", "contractVersion", manifest.contractVersion);
  requireString(issues, "$", "manifestVersion", manifest.manifestVersion);
  if (isNonEmptyString(manifest.contractVersion) && !isValidSemver(manifest.contractVersion)) {
    addIssue(
      issues,
      "ERR_INVALID_SEMVER",
      "$.contractVersion",
      `Invalid semver '${manifest.contractVersion}'. Expected format major.minor.patch.`
    );
  }
  if (isNonEmptyString(manifest.manifestVersion) && !isValidSemver(manifest.manifestVersion)) {
    addIssue(
      issues,
      "ERR_INVALID_SEMVER",
      "$.manifestVersion",
      `Invalid semver '${manifest.manifestVersion}'. Expected format major.minor.patch.`
    );
  }

  validateMetadata(issues, manifest.metadata);

  if (!Array.isArray(manifest.entities)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", "$.entities", "Expected entities array.");
  } else {
    const seenEntityIds = new Set<string>();
    manifest.entities.forEach((entity, index) => {
      const path = `$.entities[${index}]`;
      validateEntity(issues, path, entity);
      if (isRecord(entity) && isNonEmptyString(entity.id)) {
        if (seenEntityIds.has(entity.id)) {
          addIssue(
            issues,
            "ERR_DUPLICATE_ID",
            `${path}.id`,
            `Duplicate entity id '${entity.id}'.`
          );
        }
        seenEntityIds.add(entity.id);
      }
    });
  }

  let knownErrorCodes = new Set<string>();
  if (!Array.isArray(manifest.errors)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", "$.errors", "Expected errors array.");
  } else {
    knownErrorCodes = new Set<string>();
    manifest.errors.forEach((errorDef, index) => {
      const path = `$.errors[${index}]`;
      const code = validateErrorDef(issues, path, errorDef);
      if (!code) {
        return;
      }

      if (knownErrorCodes.has(code)) {
        addIssue(issues, "ERR_DUPLICATE_ID", `${path}.code`, `Duplicate error code '${code}'.`);
      }
      knownErrorCodes.add(code);
    });
  }

  if (!Array.isArray(manifest.actions)) {
    addIssue(issues, "ERR_SCHEMA_TYPE", "$.actions", "Expected actions array.");
  } else {
    const seenActionIds = new Set<string>();
    const knownEntityIds = new Set(
      Array.isArray(manifest.entities)
        ? manifest.entities
            .filter((entity): entity is Record<string, unknown> => isRecord(entity))
            .map((entity) => entity.id)
            .filter(isNonEmptyString)
        : []
    );

    manifest.actions.forEach((action, index) => {
      const path = `$.actions[${index}]`;
      validateAction(issues, path, action);

      if (!isRecord(action)) {
        return;
      }

      if (isNonEmptyString(action.id)) {
        if (seenActionIds.has(action.id)) {
          addIssue(
            issues,
            "ERR_DUPLICATE_ID",
            `${path}.id`,
            `Duplicate action id '${action.id}'.`
          );
        }
        seenActionIds.add(action.id);
      }

      if (isNonEmptyString(action.entityId) && !knownEntityIds.has(action.entityId)) {
        addIssue(
          issues,
          "ERR_ENTITY_NOT_FOUND",
          `${path}.entityId`,
          `Action references unknown entity id '${action.entityId}'.`
        );
      }

      if (Array.isArray(action.errors)) {
        action.errors.forEach((errorCode, errorIndex) => {
          if (typeof errorCode === "string" && !knownErrorCodes.has(errorCode)) {
            addIssue(
              issues,
              "ERR_ERROR_CODE_NOT_FOUND",
              `${path}.errors[${errorIndex}]`,
              `Action references unknown error code '${errorCode}'.`
            );
          }
        });
      }
    });
  }

  // --- Validate views (optional) ---
  const knownViewIds = new Set<string>();
  if (manifest.views !== undefined) {
    if (!Array.isArray(manifest.views)) {
      addIssue(issues, "ERR_SCHEMA_TYPE", "$.views", "Expected views array.");
    } else {
      manifest.views.forEach((view, index) => {
        const path = `$.views[${index}]`;
        validateView(issues, path, view);
        if (isRecord(view) && isNonEmptyString(view.id)) {
          if (knownViewIds.has(view.id)) {
            addIssue(
              issues,
              "ERR_DUPLICATE_ID",
              `${path}.id`,
              `Duplicate view id '${view.id}'.`
            );
          }
          knownViewIds.add(view.id);
        }
      });
    }
  }

  // --- Validate pages (optional) ---
  if (manifest.pages !== undefined) {
    if (!Array.isArray(manifest.pages)) {
      addIssue(issues, "ERR_SCHEMA_TYPE", "$.pages", "Expected pages array.");
    } else {
      const knownActionIds = new Set(
        Array.isArray(manifest.actions)
          ? manifest.actions
              .filter((action): action is Record<string, unknown> => isRecord(action))
              .map((action) => action.id)
              .filter(isNonEmptyString)
          : []
      );
      const seenPageIds = new Set<string>();

      manifest.pages.forEach((page, index) => {
        const path = `$.pages[${index}]`;
        validatePage(issues, path, page, knownViewIds, knownActionIds);
        if (isRecord(page) && isNonEmptyString(page.id)) {
          if (seenPageIds.has(page.id)) {
            addIssue(
              issues,
              "ERR_DUPLICATE_ID",
              `${path}.id`,
              `Duplicate page id '${page.id}'.`
            );
          }
          seenPageIds.add(page.id);
        }
      });
    }
  }

  return {
    valid: issues.length === 0,
    issues
  };
}

export function assertManifest(manifest: unknown): BrowserWireManifest {
  const result = validateManifest(manifest);
  if (!result.valid) {
    const issueSummary = result.issues
      .map((issue) => `${issue.code} at ${issue.path}: ${issue.message}`)
      .join("\n");
    throw new Error(`Manifest validation failed:\n${issueSummary}`);
  }

  return manifest as BrowserWireManifest;
}
