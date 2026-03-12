# Contract DSL Technical Design

For terminology, start with [glossary.md](../glossary.md).

Related design docs:

- [rrweb-hybrid-compiler.md](../design/rrweb-hybrid-compiler.md) (rrweb-to-DSL hybrid compiler architecture)
- [static-discovery.md](./static-discovery.md) (vision-first static discovery pipeline)

## Concepts

- `BrowserWireManifest`: versioned contract artifact.
- `DSL`: strict schema representation for entities, actions, and typed errors.
- `Validation`: structural and semantic checks for publishability.
- `Compatibility`: semver-aware contract evolution checks.
- `Migration`: deterministic forward-only transformation between manifest versions.

## HLD (High-Level Design)

### Objective

Provide a deterministic contract layer that defines browser API shape and evolution policy.

### Components

- Type definitions for manifest structures and issue models.
- Validation engine for required fields, enum/type checks, and references.
- Compatibility checker for version bump enforcement.
- Migration registry for explicit forward version paths.

### External Interfaces

- `validateManifest(manifest: unknown): ValidationResult`
- `assertManifest(manifest: unknown): BrowserWireManifest`
- `checkManifestCompatibility(previous, next): CompatibilityResult`
- `migrateManifest(manifest, targetVersion, registry): BrowserWireManifest`

## LLD (Low-Level Design)

### Source Layout

- `src/contract-dsl/types.ts`
- `src/contract-dsl/semver.ts`
- `src/contract-dsl/validate.ts`
- `src/contract-dsl/compatibility.ts`
- `src/contract-dsl/migration.ts`
- `src/contract-dsl/index.ts`

### Validation Rules

- Required field and type validation across metadata, entities, actions, and errors.
- Semver validation for `contractVersion` and `manifestVersion`.
- Referential integrity checks:
  - `ActionDef.entityId` must reference an existing entity.
  - `ActionDef.errors[]` must reference declared `ErrorDef.code` values.
  - `requiredInputRefs[]` must reference declared action inputs.
- Determinism checks:
  - actions require non-empty `preconditions[]` and `postconditions[]`.
  - actions require typed error references.
  - actions require non-empty locator strategy sets.
- `recipeRef` format validation: `recipe://<path>/v<number>`.

### Compatibility Policy

- Major bump: breaking contract changes (for example removal/type change of required surface).
- Minor bump: additive compatible changes.
- Patch bump: non-structural updates.
- Checker reports typed issues for insufficient or regressive version bumps.

### Migration Behavior

- Forward-only migrations.
- Each migration step must increase version.
- Migration chain selected deterministically.
- Missing chain throws `ERR_MIGRATION_PATH_NOT_FOUND`.

### Test Coverage

- `tests/contract-dsl/validate.test.ts`
- `tests/contract-dsl/compatibility.test.ts`
- `tests/contract-dsl/migration.test.ts`
- `tests/contract-dsl/fixtures.ts`
