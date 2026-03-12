import { compareSemver, detectVersionChange, isBumpAtLeast, isValidSemver } from "./semver";
import {
  type ActionDef,
  type BrowserWireManifest,
  type CompatibilityReport,
  type ManifestDiff,
  type ValidationIssue,
  type VersionBump
} from "./types";

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function asSet(values: string[]): Set<string> {
  return new Set(values);
}

function compareArraySet(previous: string[], next: string[]): {
  removed: string[];
  added: string[];
} {
  const previousSet = asSet(previous);
  const nextSet = asSet(next);

  const removed = [...previousSet].filter((value) => !nextSet.has(value));
  const added = [...nextSet].filter((value) => !previousSet.has(value));
  return { removed, added };
}

function diffActionInputs(
  actionId: string,
  previousAction: ActionDef,
  nextAction: ActionDef,
  diff: ManifestDiff
): void {
  const previousInputs = new Map(previousAction.inputs.map((input) => [input.name, input]));
  const nextInputs = new Map(nextAction.inputs.map((input) => [input.name, input]));

  previousInputs.forEach((previousInput, inputName) => {
    const nextInput = nextInputs.get(inputName);
    if (!nextInput) {
      diff.breakingChanges.push(
        `Action '${actionId}' removed input '${inputName}', which is a breaking change.`
      );
      return;
    }

    if (previousInput.type !== nextInput.type) {
      diff.breakingChanges.push(
        `Action '${actionId}' changed input '${inputName}' type from '${previousInput.type}' to '${nextInput.type}'.`
      );
    }

    if (!previousInput.required && nextInput.required) {
      diff.breakingChanges.push(
        `Action '${actionId}' changed input '${inputName}' from optional to required.`
      );
    }

    if (previousInput.required && !nextInput.required) {
      diff.additiveChanges.push(
        `Action '${actionId}' changed input '${inputName}' from required to optional.`
      );
    }

    if (previousInput.type === "enum" && nextInput.type === "enum") {
      const previousEnum = previousInput.enumValues ?? [];
      const nextEnum = nextInput.enumValues ?? [];
      const enumDiff = compareArraySet(previousEnum, nextEnum);
      enumDiff.removed.forEach((value) => {
        diff.breakingChanges.push(
          `Action '${actionId}' removed enum value '${value}' from input '${inputName}'.`
        );
      });
      enumDiff.added.forEach((value) => {
        diff.additiveChanges.push(
          `Action '${actionId}' added enum value '${value}' to input '${inputName}'.`
        );
      });
    }
  });

  nextInputs.forEach((nextInput, inputName) => {
    if (previousInputs.has(inputName)) {
      return;
    }

    if (nextInput.required) {
      diff.breakingChanges.push(
        `Action '${actionId}' added required input '${inputName}', which is a breaking change.`
      );
    } else {
      diff.additiveChanges.push(`Action '${actionId}' added optional input '${inputName}'.`);
    }
  });
}

export function diffManifests(
  previousManifest: BrowserWireManifest,
  nextManifest: BrowserWireManifest
): ManifestDiff {
  const diff: ManifestDiff = {
    requiredBump: "none",
    breakingChanges: [],
    additiveChanges: [],
    patchChanges: []
  };

  const previousEntities = byId(previousManifest.entities);
  const nextEntities = byId(nextManifest.entities);

  previousEntities.forEach((_, entityId) => {
    if (!nextEntities.has(entityId)) {
      diff.breakingChanges.push(`Entity '${entityId}' was removed.`);
    }
  });
  nextEntities.forEach((entity, entityId) => {
    if (!previousEntities.has(entityId)) {
      diff.additiveChanges.push(`Entity '${entityId}' was added.`);
      return;
    }

    const previousEntity = previousEntities.get(entityId);
    if (!previousEntity) {
      return;
    }

    if (previousEntity.name !== entity.name || previousEntity.description !== entity.description) {
      diff.patchChanges.push(`Entity '${entityId}' metadata was updated.`);
    }

    if (JSON.stringify(previousEntity.signals) !== JSON.stringify(entity.signals)) {
      diff.patchChanges.push(`Entity '${entityId}' signals were updated.`);
    }
  });

  const previousActions = byId(previousManifest.actions);
  const nextActions = byId(nextManifest.actions);

  previousActions.forEach((_, actionId) => {
    if (!nextActions.has(actionId)) {
      diff.breakingChanges.push(`Action '${actionId}' was removed.`);
    }
  });
  nextActions.forEach((action, actionId) => {
    if (!previousActions.has(actionId)) {
      diff.additiveChanges.push(`Action '${actionId}' was added.`);
      return;
    }

    const previousAction = previousActions.get(actionId);
    if (!previousAction) {
      return;
    }

    if (previousAction.entityId !== action.entityId) {
      diff.breakingChanges.push(
        `Action '${actionId}' changed linked entity from '${previousAction.entityId}' to '${action.entityId}'.`
      );
    }

    if (previousAction.name !== action.name || previousAction.description !== action.description) {
      diff.patchChanges.push(`Action '${actionId}' metadata was updated.`);
    }

    diffActionInputs(actionId, previousAction, action, diff);

    if (JSON.stringify(previousAction.preconditions) !== JSON.stringify(action.preconditions)) {
      diff.patchChanges.push(`Action '${actionId}' preconditions were updated.`);
    }
    if (JSON.stringify(previousAction.postconditions) !== JSON.stringify(action.postconditions)) {
      diff.patchChanges.push(`Action '${actionId}' postconditions were updated.`);
    }
    if (previousAction.recipeRef !== action.recipeRef) {
      diff.patchChanges.push(`Action '${actionId}' recipe reference was updated.`);
    }

    const errorDiff = compareArraySet(previousAction.errors, action.errors);
    errorDiff.removed.forEach((errorCode) => {
      diff.patchChanges.push(`Action '${actionId}' removed possible error '${errorCode}'.`);
    });
    errorDiff.added.forEach((errorCode) => {
      diff.additiveChanges.push(`Action '${actionId}' added possible error '${errorCode}'.`);
    });

    if (JSON.stringify(previousAction.locatorSet) !== JSON.stringify(action.locatorSet)) {
      diff.patchChanges.push(`Action '${actionId}' locator set was updated.`);
    }
  });

  const previousErrors = new Map(previousManifest.errors.map((errorDef) => [errorDef.code, errorDef]));
  const nextErrors = new Map(nextManifest.errors.map((errorDef) => [errorDef.code, errorDef]));

  previousErrors.forEach((errorDef, code) => {
    const nextError = nextErrors.get(code);
    if (!nextError) {
      diff.breakingChanges.push(`Error definition '${code}' was removed.`);
      return;
    }

    if (
      errorDef.messageTemplate !== nextError.messageTemplate ||
      errorDef.classification !== nextError.classification
    ) {
      diff.patchChanges.push(`Error definition '${code}' metadata was updated.`);
    }
  });
  nextErrors.forEach((_, code) => {
    if (!previousErrors.has(code)) {
      diff.additiveChanges.push(`Error definition '${code}' was added.`);
    }
  });

  if (diff.breakingChanges.length > 0) {
    diff.requiredBump = "major";
  } else if (diff.additiveChanges.length > 0) {
    diff.requiredBump = "minor";
  } else if (diff.patchChanges.length > 0) {
    diff.requiredBump = "patch";
  }

  return diff;
}

export function checkManifestCompatibility(
  previousManifest: BrowserWireManifest,
  nextManifest: BrowserWireManifest
): CompatibilityReport {
  const issues: ValidationIssue[] = [];
  const diff = diffManifests(previousManifest, nextManifest);

  if (!isValidSemver(previousManifest.manifestVersion)) {
    issues.push({
      code: "ERR_INVALID_SEMVER",
      path: "previousManifest.manifestVersion",
      message: `Invalid previous manifest version '${previousManifest.manifestVersion}'.`
    });
  }
  if (!isValidSemver(nextManifest.manifestVersion)) {
    issues.push({
      code: "ERR_INVALID_SEMVER",
      path: "nextManifest.manifestVersion",
      message: `Invalid next manifest version '${nextManifest.manifestVersion}'.`
    });
  }

  let actualBump: VersionBump | "downgrade" = "none";
  if (issues.length === 0) {
    actualBump = detectVersionChange(
      previousManifest.manifestVersion,
      nextManifest.manifestVersion
    );

    if (actualBump === "downgrade") {
      issues.push({
        code: "ERR_COMPATIBILITY_VERSION",
        path: "nextManifest.manifestVersion",
        message: "Manifest version cannot decrease."
      });
    }

    if (diff.requiredBump !== "none" && actualBump === "none") {
      issues.push({
        code: "ERR_COMPATIBILITY_VERSION",
        path: "nextManifest.manifestVersion",
        message: `Manifest changed but version did not bump. Required at least '${diff.requiredBump}'.`
      });
    }

    if (!isBumpAtLeast(actualBump, diff.requiredBump)) {
      issues.push({
        code: "ERR_COMPATIBILITY_BREAKING",
        path: "nextManifest.manifestVersion",
        message: `Version bump '${actualBump}' is insufficient. Required '${diff.requiredBump}'.`,
        details: {
          requiredBump: diff.requiredBump,
          actualBump
        }
      });
    }

    if (diff.requiredBump === "none") {
      const compareResult = compareSemver(
        previousManifest.manifestVersion,
        nextManifest.manifestVersion
      );
      if (compareResult > 0) {
        issues.push({
          code: "ERR_COMPATIBILITY_VERSION",
          path: "nextManifest.manifestVersion",
          message: "Manifest version cannot decrease."
        });
      }
    }
  }

  return {
    ...diff,
    compatible: issues.length === 0,
    actualBump,
    issues
  };
}
