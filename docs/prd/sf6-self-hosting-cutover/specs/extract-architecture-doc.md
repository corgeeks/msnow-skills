# Extract architecture doc

## Objective

Create `docs/factory/architecture.md`, the living design document for the software factory. It preserves the umbrella PRD's architecture, constraints, execution facts, and decisions after `docs/prd/` is deleted, written for the people and agents who will change the factory next.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5`. This is careful editorial consolidation that must stay accurate to the code.

## Context

`docs/prd/` is about to be deleted (Import task). Until now the umbrella `docs/prd/software-factory/PRD.md` was the only written statement of the process model, git topology, data model, loop template, execution facts, and about 30 recorded decisions. The future planner (sf8) and the learn gate (sf10) will read and update this doc, and executor sessions editing the daemon should read it first.

### Parent PRD

- **PRD**: sf6-self-hosting-cutover
- **PRD Path**: `docs/prd/sf6-self-hosting-cutover/PRD.md`

### Related Tasks

- **Depends on**: Land v0 on main
- **Blocks**: Import program and retire docs/prd
- **Runs in parallel with**: Self-hosted README loop. That task only touches README.md through the factory's own PR.

## Acceptance Criteria

- [ ] `docs/factory/architecture.md` exists, with these sections in order:
  1. **Purpose and scope**: what the factory is and what v0 does and doesn't do.
  2. **Process model**: daemon, CLI, UI, omp sessions. Keep the mermaid diagram.
  3. **Git topology**: the `.factory/` paths table, the single git queue, the snapshot/commit flow, and unsigned factory commits.
  4. **Data model**: tables and status enums, **as implemented**. Verify every column against `factory/src/daemon/db.ts` migration 1 and every status list against `factory/src/shared/types.ts`, and fix any drift from the PRD sketch in favour of the code.
  5. **The `change` loop**: the mermaid diagram, node rules, budgets, gates, restart recovery, and reviewer containment, verified against `template-change.ts` and `engine.ts`.
  6. **Execution facts**: the omp RPC, `--max-time`, `cost_cap`, gh, and git worktree findings, plus the 1Password signing finding.
  7. **Module map**: one line per file in `factory/src/**` and `factory/ui/src/{lib,routes}` saying what it owns.
  8. **Decision log**: ADR-style entries (`### D-NN Title`, then Context / Decision / Consequences, each 1–3 lines) for every Discussion decision in the umbrella and the sf0–sf6 child PRDs. Number them in chronological order. Merge duplicates, and supersede the ones later changed (e.g. `better-sqlite3` → `node:sqlite`, and the original "one package.json" → the separate UI package) with a `Superseded by D-NN` line.
  9. **Open risks and v1 backlog**: the risks still open from the WorkPRD reports (flaky concurrent test hang, a missed SSE update with many tabs, daemon self-restart after a self-merge, Suggested Model not applied by the harness), plus the L4 list sf7–sf12, one line each.
- [ ] It has no references to `docs/prd/...` paths, which are about to be deleted. Link to code instead.
- [ ] `README.md` is **not** edited; the factory's own PR owns README.
- [ ] Commit it to `main` as a human-authored commit (normal signing): `docs(factory): living architecture and decision log`. Push it. If the daemon has pushed `factory: state` commits in the meantime, `git pull --rebase` first.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `docs/factory/architecture.md` | Create | The living design doc |

### Technical Constraints

- Where the PRDs and the code disagree, the code wins. List each such disagreement in the log.
- Keep it under about 600 lines. Use tables over prose where possible. Do not copy research citations, only the conclusions.

### Relevant Code References

- `docs/prd/software-factory/PRD.md`: Architecture, Constraints, Discussion
- `docs/prd/sf{0..6}-*/PRD.md`: child Discussions and Constraints
- `factory/src/daemon/{db,engine,template-change,forge,state-commit,omp}.ts`, `factory/src/shared/types.ts`

## Testing Requirements

- [ ] Every table and enum in sections 4 and 5 is checked against the code, and the log lists what was checked.
- [ ] `grep -n "docs/prd" docs/factory/architecture.md` returns nothing.

## Out of Scope

- README changes
- Deleting `docs/prd/` (Import task)
