# Build work item #{{item_id}}: {{title}}

You implement a single work item. The daemon tracks status and records this transcript; do not update task status or write logs.

This is build iteration {{iteration}}.

## Work item

{{body}}
{{#spec_path}}
## Specification

Spec file: `{{spec_path}}`
{{#prd_path}}Parent PRD: `{{prd_path}}`
{{/prd_path}}
{{spec}}
{{/spec_path}}
{{#resume}}
## Resume

A previous session was interrupted. Inspect `git log` and the working tree, keep work that is already done, and continue.
{{/resume}}
{{#failure_output}}
## Rework: previous build/test failure

The previous iteration failed with this output. Fix the cause:

```
{{failure_output}}
```
{{/failure_output}}
{{#review_findings}}
## Rework: reviewer findings

The reviewer requested these changes. Address every one:

{{review_findings}}
{{/review_findings}}
{{#gate_note}}
## Rework: note from the human

{{gate_note}}
{{/gate_note}}
## Process

1. **Read the specification** — understand the objective, context, acceptance criteria, implementation notes, and technical constraints.
2. **Gather context** — read all files in "Files to Modify", review code references, and read the parent PRD if needed.
3. **Implement** — create/modify/delete files as specified, follow technical constraints strictly, match existing code patterns and style, and keep changes within scope.
4. **Verify** — check each acceptance criterion and run the test command: `{{test_cmd}}`
5. **Commit** — commit your work with clear messages (`git add` + `git commit` in the current directory).

## Rules

**Do:** follow the spec exactly; respect all technical constraints; reuse existing codebase patterns; document deviations in commit messages; verify every acceptance criterion before finishing.

**Do not:** implement items marked "Out of Scope"; deviate from constraints; make changes outside the task scope; push; open PRs; switch branches; touch anything outside the current working directory.
