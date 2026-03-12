# Glossary

Use this page as a quick reference for `contract-dsl` terminology.

## One-minute model

- `BrowserWireManifest` is the full versioned contract document.
- `EntityDef` describes what object exists.
- `ActionDef` describes what operation is callable.
- `LocatorSet` describes how targets are found deterministically.
- `ErrorDef` describes stable typed failures.
- `Provenance` describes where learned definitions came from.

## Glossary

### `BrowserWireManifest`

Top-level contract artifact validated by `validateManifest`.

- Core sections: metadata, entities, actions, and error definitions.
- Versioning fields: `contractVersion` and `manifestVersion` (semver).

### `EntityDef`

Defines a domain object in the contract.

- Typical fields: `id`, `name`, `description`, `signals[]`, optional `confidence`, required `provenance`.

### `ActionDef`

Defines a callable action bound to an entity.

- Typical fields: `id`, `entityId`, `inputs[]`, optional `requiredInputRefs[]`, `preconditions[]`, `postconditions[]`, `recipeRef`, `locatorSet`, `errors[]`, optional `confidence`, required `provenance`.

### `LocatorSet`

Prioritized targeting strategies used by runtime execution.

- Each strategy carries `kind`, `value`, and confidence weight.
- Validation requires at least one locator strategy.

### `ErrorDef`

Typed failure contract with stable code.

- Classification values: `recoverable`, `fatal`, `security`.

### `Provenance`

Audit metadata for learned artifacts.

- Typical fields: `source`, `sessionId`, `traceIds[]`, `annotationIds[]`, `capturedAt`.

### `signals`

Observable evidence used to identify entities and state.

### `recipeRef`

Reference to the compiled recipe artifact version.

- Expected format: `recipe://<path>/v<number>`.
