# Implementation Log

## 2026-11-22T15:45:00 - factory CLI

**Status**: Completed

**Summary**: Added the `factory` CLI (`daemon`, `status`, `show`, `add`, `import`, `start`, `approve`/`reject`) over the daemon HTTP API, with a fetch client that maps errors to exit codes 1, 2, and 64. Also added the `bin` entry.

**Changes Made**:
- `factory/src/cli/main.ts` - Created: parseArgs per command, command handlers, usage text, executable with a shebang
- `factory/src/cli/client.ts` - Created: `createClient`, `ApiError`, `DaemonUnreachableError`
- `factory/src/cli/main.test.ts` - Created: in-process daemon tests for every command plus the usage and unreachable cases
- `factory/package.json` - Modified: `bin.factory`

**Notes**: I checked `npm link` with `NPM_CONFIG_PREFIX=<tmpdir>` and removed the dir afterwards. `factory --help` worked from `/tmp` and exited 0, so type stripping applies through the bin symlink. `start` checks every target before it patches any of them. A leaf that isn't `ready` fails with conflict and nothing is queued.

---

## 2026-11-22T12:00:00 - PRD importer

**Status**: Completed

**Summary**: Added `buildImportBatch(prdDir, root)` that flattens ordinary and umbrella YAML PRDs (recursing children, draft stub leaves for children without tasks.yaml) into an ordered `BatchItem[]` with parent refs and sequential-level dependency edges.

**Changes Made**:
- `factory/src/cli/import.ts` - Created: importer (yq-compat YAML read, mapping, tier parse, level edges)
- `factory/src/cli/import.test.ts` - Created: fixture, determinism, missing-yq, missing-PRD and software-factory smoke tests
- `factory/test/fixtures/prd/**` - Created: `ordinary/` and `umbrella/` fixture PRDs

**Notes**: A leaf with no `spec` maps to a task with `spec_path: null`, `tier: null`. Title falls back to the dir name if `PRD.md` has no `# ` heading.

---
