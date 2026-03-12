import { compareSemver, isValidSemver } from "./semver";
import type { BrowserWireManifest, ManifestMigration } from "./types";

function cloneManifest(manifest: BrowserWireManifest): BrowserWireManifest {
  return JSON.parse(JSON.stringify(manifest)) as BrowserWireManifest;
}

function migrationKey(fromVersion: string, toVersion: string): string {
  return `${fromVersion}->${toVersion}`;
}

export class ManifestMigrationRegistry {
  private readonly migrations = new Map<string, ManifestMigration>();

  register(migration: ManifestMigration): void {
    if (!isValidSemver(migration.fromVersion) || !isValidSemver(migration.toVersion)) {
      throw new Error(
        `Migration versions must be valid semver: '${migration.fromVersion}' -> '${migration.toVersion}'.`
      );
    }

    if (compareSemver(migration.fromVersion, migration.toVersion) >= 0) {
      throw new Error(
        `Migration toVersion must be greater than fromVersion: '${migration.fromVersion}' -> '${migration.toVersion}'.`
      );
    }

    const key = migrationKey(migration.fromVersion, migration.toVersion);
    if (this.migrations.has(key)) {
      throw new Error(`Migration '${key}' is already registered.`);
    }

    this.migrations.set(key, migration);
  }

  migrate(manifest: BrowserWireManifest, targetVersion: string): BrowserWireManifest {
    if (!isValidSemver(manifest.manifestVersion)) {
      throw new Error(`Manifest has invalid version '${manifest.manifestVersion}'.`);
    }
    if (!isValidSemver(targetVersion)) {
      throw new Error(`Target version '${targetVersion}' is invalid semver.`);
    }

    if (compareSemver(manifest.manifestVersion, targetVersion) > 0) {
      throw new Error(
        `Cannot migrate manifest backwards from '${manifest.manifestVersion}' to '${targetVersion}'.`
      );
    }

    let current = cloneManifest(manifest);
    const visitedVersions = new Set<string>([current.manifestVersion]);

    while (current.manifestVersion !== targetVersion) {
      const nextMigration = this.getNextMigration(current.manifestVersion, targetVersion);
      if (!nextMigration) {
        throw new Error(
          `ERR_MIGRATION_PATH_NOT_FOUND: no migration path from '${current.manifestVersion}' to '${targetVersion}'.`
        );
      }

      current = nextMigration.migrate(cloneManifest(current));
      if (current.manifestVersion !== nextMigration.toVersion) {
        current.manifestVersion = nextMigration.toVersion;
      }

      if (visitedVersions.has(current.manifestVersion)) {
        throw new Error(
          `Migration loop detected while migrating toward '${targetVersion}'.`
        );
      }
      visitedVersions.add(current.manifestVersion);
    }

    return current;
  }

  private getNextMigration(
    currentVersion: string,
    targetVersion: string
  ): ManifestMigration | null {
    const candidates = [...this.migrations.values()]
      .filter((migration) => {
        if (migration.fromVersion !== currentVersion) {
          return false;
        }
        return compareSemver(migration.toVersion, targetVersion) <= 0;
      })
      .sort((left, right) => compareSemver(left.toVersion, right.toVersion));

    if (candidates.length === 0) {
      return null;
    }

    return candidates[0];
  }
}

export function migrateManifest(
  manifest: BrowserWireManifest,
  targetVersion: string,
  registry: ManifestMigrationRegistry
): BrowserWireManifest {
  return registry.migrate(manifest, targetVersion);
}
