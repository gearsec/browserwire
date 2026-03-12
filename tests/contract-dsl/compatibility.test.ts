import { describe, expect, it } from "vitest";

import { checkManifestCompatibility } from "../../src/contract-dsl";
import { createValidManifest } from "./fixtures";

describe("M0 manifest compatibility", () => {
  it("accepts additive changes when version bump is minor", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    nextManifest.manifestVersion = "1.1.0";
    nextManifest.actions.push({
      id: "open_latest_ticket",
      entityId: "ticket",
      name: "Open Latest Ticket",
      inputs: [],
      preconditions: [
        {
          id: "ticket_list_visible",
          description: "Ticket list is visible in viewport."
        }
      ],
      postconditions: [
        {
          id: "ticket_detail_open",
          description: "A ticket detail panel is visible."
        }
      ],
      recipeRef: "recipe://ticket/open_latest_ticket/v1",
      locatorSet: {
        id: "ticket_list_locator",
        strategies: [
          {
            kind: "data_testid",
            value: "ticket-list",
            confidence: 0.9
          }
        ]
      },
      errors: ["ERR_TARGET_NOT_FOUND"],
      provenance: {
        source: "human",
        sessionId: "session-3",
        traceIds: [],
        annotationIds: [],
        capturedAt: "2026-02-25T00:03:00.000Z"
      }
    });

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(true);
    expect(report.requiredBump).toBe("minor");
    expect(report.actualBump).toBe("minor");
  });

  it("rejects additive changes when version bump is only patch", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    nextManifest.manifestVersion = "1.0.1";
    nextManifest.actions[0].inputs.push({
      name: "includeClosed",
      type: "boolean",
      required: false
    });

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(false);
    expect(report.requiredBump).toBe("minor");
    expect(report.actualBump).toBe("patch");
    expect(report.issues.some((issue) => issue.code === "ERR_COMPATIBILITY_BREAKING")).toBe(true);
  });

  it("rejects breaking changes when version bump is not major", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    nextManifest.manifestVersion = "1.1.0";
    nextManifest.actions = [];

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(false);
    expect(report.requiredBump).toBe("major");
    expect(report.actualBump).toBe("minor");
  });

  it("accepts breaking changes when version bump is major", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    nextManifest.manifestVersion = "2.0.0";
    nextManifest.actions[0].inputs[0].required = false;
    nextManifest.actions[0].inputs.push({
      name: "ticketCategory",
      type: "string",
      required: true
    });

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(true);
    expect(report.requiredBump).toBe("major");
    expect(report.actualBump).toBe("major");
  });

  it("rejects changed manifests that keep the same version", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    nextManifest.actions[0].description = "Updated description";

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(false);
    expect(report.actualBump).toBe("none");
    expect(report.issues.some((issue) => issue.code === "ERR_COMPATIBILITY_VERSION")).toBe(true);
  });

  it("accepts unchanged manifests with the same version", () => {
    const previousManifest = createValidManifest();
    const nextManifest = createValidManifest();

    const report = checkManifestCompatibility(previousManifest, nextManifest);

    expect(report.compatible).toBe(true);
    expect(report.requiredBump).toBe("none");
    expect(report.actualBump).toBe("none");
  });
});
