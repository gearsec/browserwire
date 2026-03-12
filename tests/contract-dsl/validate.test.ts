import { describe, expect, it } from "vitest";

import { validateManifest } from "../../src/contract-dsl";
import { createValidManifest } from "./fixtures";

function issueCodes(result: ReturnType<typeof validateManifest>): string[] {
  return result.issues.map((issue) => issue.code);
}

describe("M0 validateManifest", () => {
  it("accepts a fully valid manifest", () => {
    const manifest = createValidManifest();
    const result = validateManifest(manifest);

    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("rejects invalid semver values", () => {
    const manifest = createValidManifest();
    manifest.manifestVersion = "1.0";

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_INVALID_SEMVER");
  });

  it("rejects action references to unknown entities", () => {
    const manifest = createValidManifest();
    manifest.actions[0].entityId = "missing_entity";

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_ENTITY_NOT_FOUND");
  });

  it("rejects action references to unknown error codes", () => {
    const manifest = createValidManifest();
    manifest.actions[0].errors.push("ERR_NEVER_DEFINED");

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_ERROR_CODE_NOT_FOUND");
  });

  it("rejects missing preconditions for deterministic behavior", () => {
    const manifest = createValidManifest();
    manifest.actions[0].preconditions = [];

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_MISSING_CONDITIONS");
  });

  it("rejects invalid recipeRef format", () => {
    const manifest = createValidManifest();
    manifest.actions[0].recipeRef = "recipe-open-ticket-v1";

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_INVALID_RECIPE_REF");
  });

  it("rejects requiredInputRefs that do not map to action inputs", () => {
    const manifest = createValidManifest();
    manifest.actions[0].requiredInputRefs = ["does_not_exist"];

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_INPUT_REF_NOT_FOUND");
  });

  it("rejects out-of-range signal and locator confidence values", () => {
    const manifest = createValidManifest();
    manifest.entities[0].signals[0].weight = 1.5;
    manifest.actions[0].locatorSet.strategies[0].confidence = -0.1;

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_SIGNAL_WEIGHT_RANGE");
    expect(issueCodes(result)).toContain("ERR_LOCATOR_CONFIDENCE_RANGE");
  });

  it("rejects enum inputs with missing enum values", () => {
    const manifest = createValidManifest();
    manifest.actions[0].inputs.push({
      name: "sortOrder",
      type: "enum",
      required: false,
      enumValues: []
    });

    const result = validateManifest(manifest);

    expect(result.valid).toBe(false);
    expect(issueCodes(result)).toContain("ERR_ENUM_VALUES_REQUIRED");
  });
});
