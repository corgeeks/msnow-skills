---
name: prd
description: Comprehensive PRD (Product Requirements Document) workflow — create, plan (research + task breakdown), and implement features through their full lifecycle, including umbrella PRDs that decompose a large effort into a slate of child PRDs whose progress rolls up to the parent. USE WHEN the user mentions PRDs, wants to plan or scope a feature, needs to implement planned tasks, or asks to resume in-progress work.
model: opus
---

You manage PRDs (Product Requirements Documents) through their complete lifecycle. Based on the user's request, you select and follow the appropriate workflow.

## Script & Path Resolution

This skill ships its own CLI scripts under `scripts/` and reference docs under `reference/`, `schemas/`, and `workflows/`, all **relative to this skill's directory** (wherever it was installed, e.g. `.claude/skills/prd/` or `~/.claude/skills/prd/`).

Before running any script, resolve its full path from this skill's directory — e.g. if this file loaded from `/abs/path/to/skills/prd/SKILL.md`, then `scripts/list-prds.sh` means `/abs/path/to/skills/prd/scripts/list-prds.sh`. All script references in the workflows use these skill-relative paths. The scripts themselves operate on PRDs stored at `.claude/prds/<prd-name>/` **relative to the current working directory** (the user's project root).

Requirements: `jq`, `yq` (Go or Python flavor — auto-detected), and `check-jsonschema`. See the repository README / `DEPENDENCIES.md`.

## When Invoked

1. **Read the PRD spec.** You MUST read the PRD specification completely before proceeding:
   @./reference/prd-spec.md

2. **Gather context.** If a PRD name is mentioned or implied:
   - Run `scripts/list-prds.sh` to see existing PRDs and their rollup status. The output tags each PRD with `is_umbrella` and `umbrella_parent`, so you can tell an umbrella (a program tracker over child PRDs) from an ordinary PRD or one of its children.
   - For an umbrella, run `scripts/umbrella-status.sh <prd-name>` (the per-child plan/work status board). For an ordinary PRD, run `scripts/task-status.sh <prd-name>` (counts of draft / defined / in-progress / completed tasks).

3. **Determine intent.** Analyze the request:
   - Are they creating something new, or working with an existing PRD?
   - Which action do they want (create, plan, implement, resume)?
   - Match against the trigger words in the Workflow Routing table.

4. **Select the workflow** using this decision logic:
   1. Does the user want to create something new, or does no PRD exist for this feature yet? → **CreatePRD**
   2. **Is the named PRD an umbrella** (`is_umbrella: true`)? Route by the user's verb, not by task counts (an umbrella usually has a mix of planned and unplanned children): *plan / define / scope* → **PlanPRD** ("Planning an Umbrella PRD"); *work / implement / resume* → **WorkPRD** ("Driving an Umbrella PRD"). Both open with the umbrella status board. If the verb is ambiguous, ask.
   3. Does the PRD have `in-progress` tasks (a previous session was interrupted)? → **WorkPRD** (Step 0 resumes them first).
   4. Does the PRD lack defined tasks ready for implementation (`defined` == 0 and `in-progress` == 0)? → **PlanPRD**
   5. Otherwise (`defined` > 0 or `in-progress` > 0) → **WorkPRD**
   6. When in doubt, ask the user which workflow they want.

5. **Execute the workflow.** Tell the user "Running <workflow-name> using the PRD skill...". You MUST read the workflow document completely before proceeding, then follow its process exactly.

6. **Report results.** Summarize what was accomplished and suggest the next step.

## Workflow Routing

| Workflow | Trigger Words | When to Use |
|----------|---------------|-------------|
| [CreatePRD](./workflows/CreatePRD.md) | "create", "new", "start", "begin", "draft", "write" | Create a new PRD from scratch, define a new feature, or start planning something new |
| [PlanPRD](./workflows/PlanPRD.md) | "plan", "analyze", "research", "refine", "complete", "fill out", "detail", "define tasks" | An existing PRD needs analysis, research, task generation, or refinement |
| [WorkPRD](./workflows/WorkPRD.md) | "work", "implement", "build", "execute", "do", "code", "develop", "resume", "continue" | Implement (or resume) tasks from a planned PRD, or drive an umbrella PRD's child slate |

## Umbrella PRDs

A large effort can be decomposed into an **umbrella PRD**: a program tracker whose `tasks.yaml` leaves point at **child PRDs** (each leaf's `spec` is a child's `PRD.md`) rather than at task specs. Each child is planned and worked as a normal PRD. You drive the whole slate through the umbrella — *"plan the `<umbrella>` PRD"* plans its children level by level; *"work the `<umbrella>` PRD"* implements them — without listing each child by hand. The supporting scripts:

- `scripts/umbrella-status.sh <umbrella>` — the per-child **status board** (dependency level, `plan_status`, `work_status`), rendered as a `| Level | PRD | Plan | Work |` table, plus `next_plan_level` / `next_work_level` pointers for "do the next one".
- `scripts/init-umbrella-children.sh <umbrella>` — **scaffolds** stub child PRDs for leaves that don't exist yet, so they can be planned.
- `scripts/sync-umbrella.sh <umbrella>` — recomputes leaf statuses from children (now mostly automatic: `update-task-status.sh` rolls a child's status change back up to its umbrella).

PlanPRD decides whether to make a PRD an umbrella and plans its children; WorkPRD drives the slate. See `reference/prd-spec.md` ("Umbrella PRDs").

To analyze an existing plan and decide whether/how to split it (into subtasks or an umbrella), use the sibling **breakdown** skill.

## Reference

- [PRD Spec](./reference/prd-spec.md) — directory layout, `tasks.yaml` / `research.yaml` structure, statuses, umbrella PRDs
- [Task Spec Template](./reference/task-spec.md)
- [Log Spec](./reference/log-spec.md) — implementation log and resume checkpoints
- [CLI Tools](./reference/cli-tools.md) — every script with examples
