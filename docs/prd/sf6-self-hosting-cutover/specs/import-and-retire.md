# Import program and retire docs/prd

## Objective

Load the software-factory program into the factory DB so it becomes the only tracker. Normalize statuses so the imported state matches reality. Delete `docs/prd/`, and make sure the imported state is committed to `main`.

## Suggested Model

Light: `anthropic/claude-haiku-5-5`. This is a mechanical runbook against the CLI and API with explicit checks.

## Context

After this task, no YAML PRDs remain in this repo. L4 (sf7–sf12) is planned in the harness and added with `factory add --parent <stub-id>`. The imported stub items are those parents.

### Parent PRD

- **PRD**: sf6-self-hosting-cutover
- **PRD Path**: `docs/prd/sf6-self-hosting-cutover/PRD.md`. The "Import and retire" section is normative.

### Related Tasks

- **Depends on**: Self-hosted README loop; Extract architecture doc
- **Blocks**: nothing. This is the last YAML task in the repo.

## Acceptance Criteria

- [ ] Before importing: every other sf6 task is `completed` in YAML. Mark this task `in-progress` first.
- [ ] The daemon is running at the repo root on `main`.
- [ ] `node factory/src/cli/main.ts import docs/prd/software-factory --dry-run` prints the tree.
- [ ] The real import prints `created 46, skipped 0`. That is 1 umbrella + 13 prd + 9 groups + 23 tasks. If the counts differ, stop and report.
- [ ] Status normalization through the API, with `PATCH /api/items/:id {status, from}`:
  - the sf6 task items are imported as `ready`; set the three completed ones and this task to `done`;
  - every container (umbrella, prd, group) whose children are all `done` is set to `done`;
  - the sf7–sf12 stub `prd` items stay `draft`;
  - the umbrella and the L4 group stay as imported, because their children aren't all done.
- [ ] `factory status` shows 0 `ready` tasks and 6 `draft` stubs. The README item from the self-hosted loop stays `done`, separate from the import.
- [ ] Mark this task `completed` in YAML (the log entry goes in the sf6 log), then run `git rm -r docs/prd` and commit to `main` as a human-authored commit with the message `chore: retire YAML PRDs; factory is the tracker`. `.claude/prd-root` is kept. Run `git pull --rebase`, then push.
- [ ] Stop the daemon with SIGTERM. Verify a `factory: state (…)` commit containing `.factory/factory.db` lands on `origin/main`, then `git pull`. On a fresh checkout, `sqlite3 .factory/factory.db 'select count(*) from work_items'` (or the API) shows 47 items: the 46 imported plus the README item.

## Implementation Notes

### Technical Constraints

- Change statuses only through the API, with `from` CAS. Never edit the DB file by hand.
- Do not touch `.factory/main`.
- Writing this task's own final log entry has to happen *before* `docs/prd` is deleted. The log is deleted with it, so put the final summary in the commit message body as well.

### Relevant Code References

- `factory/src/cli/import.ts`: the mapping
- `factory/src/daemon/http.ts`: `PATCH /api/items/:id`
- `factory/src/daemon/state-commit.ts`: shutdown flush

## Testing Requirements

- [ ] The counts and statuses checked above, using `factory status --json` and `GET /api/items`.
- [ ] `test ! -e docs/prd` on `origin/main`.

## Out of Scope

- Planning or adding L4 tasks
- Any code change
