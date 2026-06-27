# WorkPRD Workflow

This workflow guides you through implementing (and resuming) the tasks defined in a planned PRD.

## Prerequisites

IMPORTANT: You MUST verify the following before proceeding.

1. **Identify the PRD**
   - If not specified, list available PRDs with `scripts/list-prds.sh` and confirm which to work on.

2. **Detect whether this is an umbrella PRD**
   - An umbrella PRD's leaves point at child PRDs (their `spec` is a `PRD.md`, e.g. `../f0-combat-contract/PRD.md`). `scripts/get-task.sh <prd> <task>` reports `is_umbrella_child: true` for such leaves.
   - **If umbrella** → follow "Driving an Umbrella PRD" below instead of the normal per-task steps.
   - Otherwise, continue with the normal flow.

3. **Check readiness**

   | Check | Command | Pass Criteria |
   |-------|---------|---------------|
   | There is work to do | `scripts/task-status.sh [prd_name]` | `defined` > 0 OR `in-progress` > 0 |
   | Research complete | `scripts/research-status.sh [prd_name]` | `draft` == 0 (or no research.yaml) |
   | Discussion answered | Read PRD.md | All questions have answers |

   If tasks are still in `draft`, switch to the **PlanPRD** workflow first.

## Step 0: Resume Interrupted Work FIRST

A previous session may have been interrupted mid-task (token limit, crash). Those tasks are marked `in-progress` and MUST be picked up before any new work.

1. Run `scripts/list-in-progress-tasks.sh <prd-name>`.
2. For each in-progress task, dispatch a worker with `resuming: true` (see "Dispatching a worker"). The worker reads the latest `In Progress` checkpoint in `log.md` plus the current code state and continues from "Resume from" — it does not redo completed work.
3. Only once no `in-progress` tasks remain, proceed to Step 1.

## Step 1: Implement Defined Tasks

Get defined tasks with `scripts/list-defined-tasks.sh <prd-name>`.

**Execution order:**
- Top-level tasks: execute **sequentially** (wait for completion before starting the next).
- Subtasks within a parent: launch **in parallel** when possible.

For each defined task, dispatch a worker (below) and wait for completion.

### Dispatching a worker

Spawn a subagent that owns the task end-to-end:

- `subagent_type`: `general-purpose`
- suggested `model`: `sonnet`
- `prompt`: "Read and follow the instructions in `<absolute path to this skill>/agents/prd-worker.md`. Inputs —
  `spec_path`: [the `spec_path` field from `scripts/get-task.sh <prd> <task>`];
  `prd_name`: [prd_name];
  `task_name`: [exact task name];
  `status_script`: [absolute path to `scripts/update-task-status.sh`];
  `log_path`: `.claude/prds/<prd>/log.md`;
  `resuming`: [`true` only when re-dispatching an already `in-progress` task].
  Return only the JSON the worker prompt specifies."

**The worker owns the status transitions** (`defined → in-progress → completed`) and writes resume checkpoints to `log.md`. Do **not** update task status from this workflow. After the worker returns:

1. Verify with `scripts/get-task.sh <prd> <task>` that the status is now `completed` (success) or still `in-progress` (incomplete/blocked).
2. If the worker reported `blocked` or left the task `in-progress`, document the blocker and move on to tasks that don't depend on it.

**Handling blockers:**
- A task left `in-progress` with a `blocked` report is documented and surfaced.
- Continue with other tasks that don't depend on the blocked one.
- It will be retried/resumed on the next Work run (Step 0).
- Report blockers at the end.

## Driving an Umbrella PRD

An umbrella PRD is not implemented directly — each leaf is a **child PRD** worked separately. This workflow drives that slate and reflects progress back.

1. **Sync first.** Run `scripts/sync-umbrella.sh <umbrella>` so the umbrella leaf statuses reflect the children's real progress before deciding what to do.

2. **Pick the next work in dependency order.** Top-level entries are dependency levels (work them **sequentially**); subtasks within a level are slices whose dependencies are satisfied (they may proceed in **parallel**). Skip leaves already `completed`.

3. **Work each child slice.** For a leaf whose status is `defined` (child fully planned) or `in-progress` (child partially done), apply the normal **WorkPRD** flow to the child PRD (the child name is the directory the leaf's `spec` points into, e.g. `f0-combat-contract`). If a leaf is `draft`, the child still needs planning — apply **PlanPRD** to it first (or surface it).

4. **Sync after each child.** Run `scripts/sync-umbrella.sh <umbrella>` again so the completed/partial child is reflected in the umbrella leaf. Never hand-edit umbrella leaf statuses — they are derived.

5. **Repeat** until all umbrella leaves are `completed`, then report.

The umbrella's own statuses always trail the children: `sync-umbrella.sh` maps child-not-planned→`draft`, child-planned→`defined`, child-partly-done→`in-progress`, child-all-done→`completed`.

## Step 2: Update Documentation

After implementation, update codebase documentation as needed.

IMPORTANT: Follow any documentation guidelines defined in the codebase (e.g., CONTRIBUTING.md, style guides, CLAUDE.md).

| Check | Action |
|-------|--------|
| **README** | Update if new features, setup steps, or usage patterns were added |
| **API docs** | Document new public functions, endpoints, or interfaces |
| **Inline comments** | Add comments for complex logic that isn't self-explanatory |
| **Configuration** | Document new environment variables or config options |
| **Examples** | Add usage examples for new functionality |

**Documentation principle:** Focus on the **Why** and intent, not the What — code shows what it does, documentation explains why. Only add documentation that provides value, and follow existing patterns in the codebase.

## Step 3: Report Results

Provide a comprehensive summary:

```markdown
## PRD Implementation Summary: [prd-name]

### Tasks Completed
- [x] Task 1 name
- [x] Task 2 name
- [ ] Task 3 name (in-progress / blocked)

### Files Affected
- `path/to/file1.ts` - Created: [description]
- `path/to/file2.ts` - Modified: [description]

### Key Decisions
- [Decision and rationale]

### Blockers Requiring Attention
- [Blocker description and what's needed to resolve]

### Next Steps
- [Any follow-up actions needed]
```

## Implementation Log

Maintain a log at `.claude/prds/<prd-name>/log.md`. Workers write two kinds of entries (see `reference/log-spec.md`):

- **In Progress** checkpoints while a task is underway (with "Done so far" and "Resume from"), so an interrupted task can be resumed.
- **Completed** entries when a task finishes.

New entries go at the **top** (reverse chronological order).

## Core Principles

1. **Resume before starting new work**: Always clear `in-progress` tasks first.
2. **Stay focused**: Only implement what's in the spec.
3. **Respect constraints**: Follow technical requirements strictly.
4. **Test thoroughly**: Verify all acceptance criteria.
5. **Handle blockers**: Document, don't force through.
6. **Verify dependencies**: Ensure prerequisite tasks are complete.
7. **Understand context**: Read surrounding code before modifying.
8. **Document progress**: Keep the log checkpoints current in real time.

## Error Recovery

If a task fails:
1. Capture the error details.
2. Check if it's a dependency issue or a missed prerequisite.
3. Document in the log with full context (and an accurate "Resume from").
4. Leave the task `in-progress` so it is resumed; report to the user with a suggested resolution.

Never mark a task `completed` if:
- Tests are failing
- Implementation is partial
- Acceptance criteria aren't met
- Blockers remain unresolved
