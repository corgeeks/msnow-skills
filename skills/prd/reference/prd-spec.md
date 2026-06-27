# PRD Specification
# Defines the structure and rules for Product Requirements Documents

## Overview

A PRD (Product Requirements Document) is a structured format for defining concrete objectives and enabling collaboration between users and Claude. PRDs are stored in `.claude/prds/[prd_name]/` directories within repository roots.

## Directory Structure

```
.claude/prds/[prd-name]/
├── PRD.md           # Main PRD document
├── tasks.yaml       # Task definitions (created during planning)
├── research.yaml    # Research questions (optional)
├── log.md           # Implementation log (created during work)
└── specs/           # Task specification files
    └── *.md
```

## PRD.md Structure

```markdown
# [PRD Name]

## Objective

<Clear statement of what this PRD accomplishes. User-provided with clarifying questions as needed.>

## Motivation

<Why this matters. What value does it provide? What problem does it solve?>

## Implementation Details

### Architecture

<High-level architectural decisions. Filled during planning phase.>

### Constraints

<Concise, but precise description of limitations and requirements.>

- Constraint 1
- Constraint 2

### Relevant Guides

<Documentation and guides that inform implementation.>

- `path/to/guide.md`

### Relevant Files

<Files that will be created, modified, or deleted.>

- `path/to/file.ts` - (Edit) Description of changes
- `path/to/new-file.ts` - (Create) Description of purpose

## Discussion

### [Question Topic]

_[Full question from Claude]_

[User's answer]
```

## tasks.yaml Structure

Top-level tasks execute **sequentially**. Subtasks execute **in parallel**.

```yaml
# Leaf task (no subtasks)
- name: "Task name"
  description: "Detailed description"
  status: draft|defined|in-progress|completed
  spec: "specs/task-name.md"

# Parent task with subtasks
- name: "Parent task name"
  description: "What this group accomplishes"
  subtasks:
    - name: "Subtask 1"
      description: "Description"
      status: draft|defined|in-progress|completed
      spec: "specs/subtask-1.md"
    - name: "Subtask 2"
      description: "Description"
      status: draft|defined|in-progress|completed
      spec: "specs/subtask-2.md"
```

**Task statuses**:
- `draft` - Task defined but spec not complete
- `defined` - Spec complete, ready for implementation
- `in-progress` - A session started this task but did not finish it (e.g. it hit a token limit). A later session resumes it. See "Resilience" below.
- `completed` - Implementation finished

### Resilience across sessions

A single session can be interrupted mid-task (token limits, crashes). To survive
this, the worker that implements a task **owns its status transitions**: it sets
the leaf to `in-progress` before it starts changing code, checkpoints its progress
to `log.md` as it goes, and only sets `completed` once acceptance criteria pass.

A status of `in-progress` therefore means "a previous session was working this and
may not have finished." The next session must treat these as resume points — it
re-reads the log's checkpoint notes and the current code state, and continues from
where the previous one left off, **before** starting any new `defined` task.
`scripts/list-in-progress-tasks.sh <prd>` surfaces them.

## research.yaml Structure

```yaml
- text: "Research question text"
  mode: answer|deep-research
  answer: "Answer from research (populated after research)"
  citations:
    - url: "https://example.com"
      title: "Source Title"
```

**Research modes**:
- `answer` - Quick search, returns direct answer
- `deep-research` - Comprehensive analysis, takes longer

## Umbrella PRDs

A large effort may decompose into **several PRDs that are planned and worked
separately** rather than one monolith. An **umbrella PRD** is a program tracker
for that slate: its `tasks.yaml` does not list implementation tasks — each leaf
represents one child PRD and its `spec` points at that child's `PRD.md`.

```yaml
# Umbrella tasks.yaml: top-level entries are dependency LEVELS (sequential);
# subtasks are slices in the same level that can proceed in PARALLEL.
- name: "L0 · F0 — Combat contract (gates everything)"
  description: "First slice; gates the data shapes of every other slice."
  spec: "../f0-combat-contract/PRD.md"   # <- points at a CHILD PRD, not specs/*.md
  status: defined
- name: "L1 · Foundation fan-out"
  description: "Slices that depend only on F0."
  subtasks:
    - name: "F1 — Live authority loop"
      description: "..."
      spec: "../f1-live-authority-loop/PRD.md"
      status: defined
```

**Detection:** a leaf is an umbrella child reference when its `spec` basename is
`PRD.md` (i.e. it points at another PRD rather than a spec under `specs/`).
`get-task.sh` reports this as `is_umbrella_child: true`.

**Status meaning on an umbrella leaf** (reinterpreted, but the same enum):

| Status | Meaning for the child PRD |
|--------|---------------------------|
| `draft` | Child PRD exists but is not yet planned (no defined tasks of its own) |
| `defined` | Child fully planned (its own tasks are `defined`); ready to work (apply WorkPRD to the child) |
| `in-progress` | Child partially implemented (some of its tasks completed/in-progress) |
| `completed` | Child fully implemented (all of its tasks completed) |

**Feedback (this is the point):** umbrella leaf statuses are **derived** from the
children, not edited by hand. Run `scripts/sync-umbrella.sh <umbrella>` to pull
each child's aggregate progress back into the umbrella. Run it at the start of
working an umbrella, after finishing each child slice, and whenever you want the
umbrella to reflect reality. See `workflows/WorkPRD.md` for the driving loop.

## Key Rules

1. **Relative Paths**: All paths in PRD files are relative to the PRD directory, not the repository root

2. **Temporary Files**: Store any temporary files within the PRD directory

3. **File Actions**: Use these labels in Relevant Files:
   - `(Edit)` - Modify existing file
   - `(Create)` - Create new file
   - `(Delete)` - Remove file
   - `(Review)` - Reference only, no changes

4. **Constraints**: Keep them "concise, but precise"

5. **Self-Containment**: After planning, the PRD should contain all context needed for implementation

## Schema Validation

Task and research files are validated against JSON schemas (under the skill's
`schemas/` directory):
- `schemas/tasks.schema.json`
- `schemas/research.schema.json`

Validate a PRD at any time with `scripts/validate-prd.sh <prd-name>`. The same
checks can run automatically on every edit if you wire up the `hooks/` (see the
repository README).
