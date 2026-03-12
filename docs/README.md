# Documentation

See the [project README](../README.md) for quick start and configuration.

## Glossary

- [glossary.md](./glossary.md) — terminology and definitions

## Architecture

| Subsystem | Doc | Description |
|-----------|-----|-------------|
| Contract DSL | [contract-dsl.md](./architecture/contract-dsl.md) | Typed manifest schema, validation, compatibility, migration |
| Static Discovery | [static-discovery.md](./architecture/static-discovery.md) | Vision-first pipeline: skeleton scan → LLM perception → locators → manifest |
| Dynamic Discovery | [dynamic-discovery.md](./architecture/dynamic-discovery.md) | Interaction-triggered re-scanning, session management, checkpoints |

## Design Documents

These are explorative designs that are **not implemented**:

- [rrweb-hybrid-compiler.md](./design/rrweb-hybrid-compiler.md) — rrweb-to-DSL hybrid compiler (superseded by vision-first pipeline)
