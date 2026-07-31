---
name: breakdown
description: Analyze an existing PRD's plan and recommend — then, on confirmation, apply — breaking it into smaller units: splitting oversized tasks into subtasks, or decomposing the whole PRD into an umbrella of child PRDs. USE WHEN a PRD or its plan feels too big, a task is too broad to implement in one pass, or the user asks to break down, decompose, split, or slice a PRD.
model: opus
---

You analyze a **single existing PRD** and help break it into smaller, independently implementable units. You first produce a recommendation; then, only after the user confirms, you restructure the PRD's `tasks.yaml` in place.

This skill is the companion to the **prd** skill. It assumes a PRD already exists at `<prd-root>/<prd-name>/` (created via the prd skill's CreatePRD/PlanPRD workflows) — `<prd-root>` is `../prd/scripts/prd-root.sh`'s output (defaults to `docs/prd`; see `../prd/reference/prd-spec.md`). It does not create PRDs or implement tasks — it reshapes the plan.

## Sibling prd skill

The prd skill ships the data model, scripts, and schema this skill builds on. It is installed as a sibling directory (both skills land under the same `skills/` directory), so resolve it relative to **this** skill's directory as `../prd/`:

- Data model & rules: `../prd/reference/prd-spec.md` (read this — especially "Umbrella PRDs")
- Tasks schema: `../prd/schemas/tasks.schema.json`
- PRD root: `../prd/scripts/prd-root.sh` (prints the configured PRD root directory, e.g. `docs/prd`)
- State queries: `../prd/scripts/task-status.sh`, `../prd/scripts/get-task.sh`, `../prd/scripts/list-prds.sh`
- Validation: `../prd/scripts/validate-prd.sh`

If the prd skill is not installed alongside this one, tell the user to install it (`npx skills install corgeeks/msnow-skills` installs both) and otherwise operate directly on the YAML using `yq`/`jq`.

See `reference/heuristics.md` in this skill for the detailed sizing signals and the exact `tasks.yaml` transformations.

## When Invoked

1. **Identify the PRD.** If no name is given, run `../prd/scripts/list-prds.sh` and ask which PRD to analyze. Resolve `<prd-root>` with `../prd/scripts/prd-root.sh`.

2. **Read the inputs.** Read `../prd/reference/prd-spec.md`, then the target PRD:
   - `<prd-root>/<name>/PRD.md` (objective, constraints, architecture)
   - `<prd-root>/<name>/tasks.yaml` (the current plan)
   - the spec files under `<prd-root>/<name>/specs/` for any sizeable tasks
   - `../prd/scripts/task-status.sh <name>` for the status mix

3. **Check safety.** Note any `in-progress` or `completed` tasks. Restructuring touches the plan, so **never silently rewrite work that is already done or underway** — call those out and ask before changing them. The safest target is a PRD still in `draft`/`defined`.

4. **Analyze size & shape.** Apply the heuristics (`reference/heuristics.md`). Decide, per the plan, which of these applies:
   - **No change** — the plan is already appropriately sliced.
   - **Split tasks** — one or more leaf tasks are too broad and should become a parent with parallel/sequential subtasks (still one PRD).
   - **Umbrella** — the effort is several largely independent slices (different subsystems, a dependency-ordered slate, separable architectures); convert the PRD into an **umbrella** whose leaves point at child PRDs.
   - A mix of the above.

5. **Present the recommendation** (see format below) and **STOP for confirmation.** Do not modify any file yet.

6. **Restructure on confirmation.** Apply only what the user approved (see "Restructuring").

7. **Validate & report.** Run `../prd/scripts/validate-prd.sh <name>`, show the new `task-status.sh`, and state the next steps.

## Recommendation Format

Present, concisely:

```markdown
## Breakdown analysis: <prd-name>

**Verdict**: <no change | split tasks | umbrella | mixed>

**Why**: <the size/coupling signals that drove the verdict — be specific>

### Proposed structure
<for "split tasks": the task(s) to split and the proposed subtasks>
<for "umbrella": the child PRDs (one per slice), grouped into dependency levels,
 with each leaf's spec path (../child/PRD.md) and a one-line scope>

### Impact & caveats
- Tasks affected and their current status
- Specs that will need to be (re)written, and which existing specs are reused/retired
- Anything already in-progress/completed that this would touch (requires explicit OK)
```

Recommend the smallest change that fixes the actual problem. Prefer splitting tasks within one PRD over an umbrella unless the slices are genuinely independent — an umbrella adds coordination overhead and is only worth it when slices can be planned and worked separately.

## Restructuring

Edit `<prd-root>/<name>/tasks.yaml` to conform to `../prd/schemas/tasks.schema.json`. Two transformations (details and worked examples in `reference/heuristics.md`):

### Split a task into subtasks
- Convert the oversized leaf into a **parent task** (`name`, `description`, `subtasks: [...]`). A parent has no `status`/`spec` of its own.
- Each new subtask is a leaf with `status: draft` and a fresh `spec:` path under `specs/`.
- New subtasks start as `draft` — they need their own spec files, which is the prd skill's PlanPRD job. Do not invent `defined` specs here.
- If the original leaf was `defined`, its existing spec becomes source material for the subtasks' specs (note this; do not leave a dangling spec marked `defined`).

### Convert to an umbrella
- Replace the implementation tasks with **umbrella leaves**: top-level entries are dependency **levels** (worked sequentially); subtasks within a level are slices that can run in **parallel**.
- If a level genuinely **can't be planned until an earlier level is implemented** (its plan depends on code that doesn't exist yet), mark that level `plan_after_prior: true`. The status board then shows its children as `requires-work` until the earlier levels are `complete`, rather than `ready-to-plan`. Default (omit it) means the level can be planned ahead. See `../prd/reference/prd-spec.md`, "Planning that depends on earlier implementation."
- Each leaf's `spec` points at a child PRD's `PRD.md` (e.g. `../<child-name>/PRD.md`) and starts as `status: draft` (the child isn't planned yet — draft umbrella leaves don't require the file to exist, so this validates).
- This skill restructures the **umbrella's** `tasks.yaml` only. To create the child PRD directories, run `../prd/scripts/init-umbrella-children.sh <name>` — it scaffolds a stub `PRD.md` for every leaf that lacks one. Then the user plans the whole slate in one go with the prd skill: *"plan the `<name>` PRD"* (PlanPRD's umbrella branch shows the status board and plans each child level by level), and later *"work the `<name>` PRD"*. Child progress rolls up automatically; `../prd/scripts/umbrella-status.sh <name>` shows the board and `../prd/scripts/sync-umbrella.sh <name>` is the manual sync.

After any rewrite, run `../prd/scripts/validate-prd.sh <name>` and fix anything it flags.

## Output

1. Confirm what was changed (or that nothing was changed).
2. Show the new task status counts.
3. Next steps: for split tasks → plan the new subtasks (prd skill, PlanPRD). For an umbrella → run `../prd/scripts/init-umbrella-children.sh <name>` to scaffold the child PRDs, then *"plan the `<name>` PRD"* and *"work the `<name>` PRD"*.

## Principles

- **Suggest first, change only on confirmation.** The recommendation step always stops for the user.
- **Smallest effective cut.** Don't over-decompose; each unit should be a coherent piece of work.
- **Preserve done work.** Never rewrite `completed`/`in-progress` tasks without explicit approval.
- **Stay schema-valid.** The result must pass `validate-prd.sh`.
