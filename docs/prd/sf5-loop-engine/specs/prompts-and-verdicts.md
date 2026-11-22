# Executor and reviewer prompts

## Objective

Create the two prompt templates the loop engine sends to omp sessions, and the pure module that renders them and parses the reviewer's verdict:
- `prompts/executor.md`: the build prompt, ported from `skills/prd/agents/prd-worker.md` with all status bookkeeping removed (the daemon owns status).
- `prompts/reviewer.md`: the cross-family review prompt. The reviewer must not modify files and must end with one fenced `json` verdict block.
- `prompts.ts`: `buildExecutorPrompt`, `buildReviewerPrompt`, `parseVerdict`.

## Suggested Model

Standard: `anthropic/claude-sonnet-5-5` — prompt porting plus a small pure parser; well specified, no concurrency.

## Context

`runChange` (sf5 "change loop state machine") calls `buildExecutorPrompt` for every build iteration and `buildReviewerPrompt` for every review, and feeds the reviewer's `SessionOutcome.finalText` (sf1) to `parseVerdict`. The umbrella rule "code decides when work is done" applies: a missing or malformed verdict must never count as approval.

### Parent PRD

- **PRD**: sf5-loop-engine
- **PRD Path**: `docs/prd/sf5-loop-engine/PRD.md`. The "Prompts" bullets and step 4 (review) of the `change` state machine are normative.

### Related Tasks

- **Depends on**: sf0 "Scaffold package, config, and shared types" (package, tsconfig, `node --test` script).
- **Parallel sibling**: "Retro computation" (no shared code).
- **Blocks**: "change loop state machine", which relies on exactly these signatures:
  - `buildExecutorPrompt(v: ExecutorVars): string`
  - `buildReviewerPrompt(v: ReviewerVars): string`
  - `parseVerdict(finalText: string): Verdict`
  - `NO_VERDICT_FINDING = 'reviewer returned no parseable verdict'`

## Acceptance Criteria

**`executor.md` (ported from prd-worker.md)**
- [ ] **Keeps**: read the spec; gather context (files to modify, code references, parent PRD); implement within the spec's scope; never implement Out of Scope items; verify every acceptance criterion; run the test command; commit work with clear messages (`git add` + `git commit` in the current directory).
- [ ] **Drops**: the status script and every status transition, `log.md` checkpoints, the `Input` list of script paths, the "Getting Unstuck" Exa/MCP steps, and the JSON "Output Format". It says plainly: "The daemon tracks status and records this transcript; do not update task status or write logs."
- [ ] Tells the executor: do not push, do not open PRs, do not switch branches, stay inside the current working directory.
- [ ] Has a conditional **resume** section: "A previous session was interrupted. Inspect `git log` and the working tree, keep work that is already done, and continue."
- [ ] Has conditional **rework** sections for the previous failure output (build/test), the reviewer findings, and the human's failure-gate note.

**`reviewer.md`**
- [ ] Review the diff against the spec's acceptance criteria and Out of Scope; run the test command if useful.
- [ ] Contains the instruction **"Do not modify, create, or delete any files, and do not commit. Changes you make will be reverted and reported."**
- [ ] Ends by requiring exactly one fenced `json` block, shaped `{ "verdict": "approve" | "changes", "findings": string[] }`, as the last thing in the reply; `findings` lists concrete, actionable problems (empty on approve).

**`prompts.ts`**
- [ ] Templates are read once from `new URL('./prompts/<name>.md', import.meta.url)` with `node:fs` and rendered with `{{var}}` substitution. Unknown `{{var}}` names throw (catches template typos in tests).
- [ ] Conditional sections use `{{#var}}…{{/var}}`: the block is kept when `var` is a non-empty string or `true`, dropped otherwise. No other template syntax.
- [ ] Variable values are inserted verbatim (no recursive expansion of `{{` inside values).
- [ ] `parseVerdict` rules:
  1. Find all fenced blocks opened by a line matching ```` ```json ```` (case-insensitive, optional trailing spaces) and closed by a line of ```` ``` ````. Take the **last** one.
  2. `JSON.parse` it. Valid only if `verdict` is exactly `'approve'` or `'changes'` and `findings` is an array of strings (missing `findings` with `approve` → `[]`).
  3. Anything else (no block, bad JSON, wrong shape) → `{ verdict: 'changes', findings: [NO_VERDICT_FINDING] }`.
  4. `approve` with non-empty findings stays `approve`; findings are kept for the retro.

## Implementation Notes

### Files to Modify

| File Path | Action | Description |
|-----------|--------|-------------|
| `factory/src/daemon/prompts/executor.md` | Create | Executor template |
| `factory/src/daemon/prompts/reviewer.md` | Create | Reviewer template |
| `factory/src/daemon/prompts.ts` | Create | Render + parse |
| `factory/src/daemon/prompts.test.ts` | Create | Tests |

### Technical Constraints

- Only `node:*` imports; erasable syntax; `.ts` import extensions; `import type` for types.
- Pure module: no DB, bus, git, or process spawning.
- Template variables (exhaustive):

| Template | Variable | Source |
|---|---|---|
| executor | `item_id`, `title`, `body` | work item |
| executor | `spec` | spec file contents, `''` if no `spec_path` |
| executor | `spec_path`, `prd_path` | `spec_path`; parent PRD = `<dirname(dirname(spec_path))>/PRD.md`, `''` if none |
| executor | `test_cmd` | `item.test_cmd ?? config.defaultTestCmd` |
| executor | `iteration` | build iteration (number, rendered as text) |
| executor | `failure_output` | last failed build/test output, or `''` |
| executor | `review_findings` | previous review findings as a `- ` bullet list, or `''` |
| executor | `gate_note` | latest approved failure-gate note, or `''` |
| executor | `resume` | boolean |
| reviewer | `item_id`, `title`, `body`, `spec`, `spec_path`, `test_cmd` | as above |
| reviewer | `diff` | `origin/main...HEAD` diff text |
| reviewer | `test_output` | last passing test output tail |

### Relevant Code References

- `skills/prd/agents/prd-worker.md` — source for executor.md: keep "Process" steps 2, 4, 5, 6 and the "Rules" section; drop "You Own Your Task's Status", step 1/3/7, "Getting Unstuck", "Output Format".
- `docs/prd/sf1-session-runner/PRD.md` — `SessionOutcome.finalText` is the text parseVerdict receives.

### Code Examples

```ts
export interface ExecutorVars {
  item_id: number; title: string; body: string; spec: string; spec_path: string; prd_path: string;
  test_cmd: string; iteration: number; failure_output: string; review_findings: string;
  gate_note: string; resume: boolean;
}
export interface ReviewerVars {
  item_id: number; title: string; body: string; spec: string; spec_path: string;
  test_cmd: string; diff: string; test_output: string;
}
export interface Verdict { verdict: 'approve' | 'changes'; findings: string[] }
export const NO_VERDICT_FINDING = 'reviewer returned no parseable verdict';
```

## Testing Requirements

- [ ] Executor render with `resume: false` and empty rework vars contains no resume/rework section and no leftover `{{`; with `resume: true` and a `failure_output`, both sections appear with the text.
- [ ] A value containing `{{title}}` is inserted literally.
- [ ] Executor output contains none of: `status_script`, `log.md`, `update-task-status`, `Output Format`.
- [ ] Reviewer render contains the diff, the "Do not modify" instruction, and the verdict shape.
- [ ] `parseVerdict`: single approve block; two blocks (first `changes`, last `approve`) → approve; prose after the last block is ignored; no block → changes + `NO_VERDICT_FINDING`; malformed JSON → same; `verdict: "lgtm"` → same; ```` ```JSON ```` uppercase accepted; non-json fences (```` ```ts ````) ignored.

## Out of Scope

- Running sessions, choosing models, containment, or collecting diffs/test output (sf5 "change loop state machine").
- Retro computation (sibling "Retro computation").
- Changing `skills/prd/agents/prd-worker.md` itself.
