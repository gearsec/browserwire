import { describe, expect, it } from "vitest";

import { ManifestMigrationRegistry, migrateManifest } from "../../src/contract-dsl";
import { createValidManifest } from "./fixtures";

describe("M0 manifest migration utilities", () => {
  it("applies migration chains to a target version", () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      migrate: (manifest) => {
        manifest.metadata.updatedAt = "2026-02-25T00:10:00.000Z";
        manifest.manifestVersion = "1.1.0";
        return manifest;
      }
    });
    registry.register({
      fromVersion: "1.1.0",
      toVersion: "2.0.0",
      migrate: (manifest) => {
        manifest.actions[0].name = "Open Ticket V2";
        manifest.manifestVersion = "2.0.0";
        return manifest;
      }
    });

    const manifest = createValidManifest();
    const migrated = migrateManifest(manifest, "2.0.0", registry);

    expect(migrated.manifestVersion).toBe("2.0.0");
    expect(migrated.metadata.updatedAt).toBe("2026-02-25T00:10:00.000Z");
    expect(migrated.actions[0].name).toBe("Open Ticket V2");
  });

  it("fails when no migration path exists", () => {
    const registry = new ManifestMigrationRegistry();
    registry.register({
      fromVersion: "1.0.0",
      toVersion: "1.0.1",
      migrate: (manifest) => ({
        ...manifest,
        manifestVersion: "1.0.1"
      })
    });

    const manifest = createValidManifest();

    expect(() => migrateManifest(manifest, "1.2.0", registry)).toThrow(
      "ERR_MIGRATION_PATH_NOT_FOUND"
    );
  });

  it("fails when registering invalid migration ranges", () => {
    const registry = new ManifestMigrationRegistry();

    expect(() =>
      registry.register({
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
        migrate: (manifest) => manifest
      })
    ).toThrow("toVersion must be greater");
  });
});
