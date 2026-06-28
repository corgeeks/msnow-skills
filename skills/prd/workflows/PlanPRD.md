# PlanPRD Workflow

This workflow guides you through analyzing, researching, and planning an existing PRD to make it ready for implementation.

## Prerequisites

IMPORTANT: You MUST verify the following before proceeding.

1. **Identify the correct PRD name**
   - If a PRD name is specified, use it.
   - If not specified:
     1. Run `scripts/list-prds.sh` to list available PRDs.
     2. Present the list to the user with their statuses.
     3. Ask which PRD to plan.

2. **Verify the PRD exists**
   - Check that `.claude/prds/[prd_name]/PRD.md` exists.
   - Verify it has the required structure (Objective, Motivation, Implementation Details, Discussion sections).
   - Run `scripts/task-status.sh <prd-name>` to understand the current state.

3. **Detect whether this is an umbrella PRD**
   - An umbrella PRD's leaves point at child PRDs (their `spec` is a `PRD.md`). `scripts/list-prds.sh` tags it `is_umbrella: true`, and `scripts/umbrella-status.sh <prd>` succeeds on it (exits 2 on a normal PRD).
   - **If umbrella** → follow "Planning an Umbrella PRD" below instead of the linear Workflow Steps. Planning an umbrella means planning its **children**, not writing tasks for the umbrella itself.
   - Otherwise, continue with the normal flow.

## Planning an Umbrella PRD

When the user runs *"plan the `<umbrella>` PRD"*, do **not** make them list and plan each child by hand. Drive the slate:

1. **Show the status board.** Run `scripts/umbrella-status.sh <umbrella>` and render it as a table the user can scan:

   | Level | PRD | Plan | Work |
   |-------|-----|------|------|
   | L0 | f0-combat-contract | planned | complete |
   | L1 | f1-live-authority-loop | planned | started |
   | L1 | f2-spatial-index | ready-to-plan | needs-plan |
   | L2 | f8-polish | requires-work | needs-plan |

   One row per `children[]` entry (`Level` = `L<level>`, `PRD` = `prd`, `Plan` = `plan_status`, `Work` = `work_status`). This is the same table WorkPRD shows.

   The `Plan` column distinguishes **`ready-to-plan`** (plannable now) from **`requires-work`** (a gated level whose earlier levels must be *implemented* first — see `reference/prd-spec.md`, "Planning that depends on earlier implementation"). `requires-work` children appear in the script's `blocked_plan_levels` with the `waiting_on` levels.

2. **Ask the scope.** Offer the user the choice (use the `next_plan_level` pointer to name the next one concretely):
   - **Plan the next level** — the children in `next_plan_level` (e.g. "plan L1: f2-spatial-index, f3-…"). This is the common path: plans are dependency-ordered (L0 → L1 → L2), and L0 usually gates the data shapes the rest depend on, so plan one level at a time.
   - **Plan all** children that are **`ready-to-plan`** right now (skip `requires-work` ones — they aren't plannable yet).
   - **Plan a specific child** they name (if it's `requires-work`, warn that its plan depends on earlier levels being implemented first).

   **Surface blocked planning.** If `blocked_plan_levels` is non-empty, tell the user which levels are gated and what unblocks them — e.g. *"L2 (Polish) can't be planned yet; implement L1 (Foundation) first — `work the <umbrella> PRD`."* If **every** child is already `planned`, say so and suggest working it (*"work the `<umbrella>` PRD"*). If nothing is `ready-to-plan` but unplanned `requires-work` children remain, the next step is to **work**, not plan.

3. **Scaffold first.** Before planning a child whose `work_status` is `needs-scaffold` (its `PRD.md` doesn't exist yet), run `scripts/init-umbrella-children.sh <umbrella>` (or `--child <name>` for one). That creates a stub child PRD seeded from the umbrella leaf. Treat a freshly scaffolded child as needing a quick **CreatePRD** pass — fill its Objective/Motivation/Constraints/Discussion from the umbrella's cross-cutting context (and a short clarification with the user where needed) — before the full analysis in step 4.

4. **Plan each chosen child.** For every child in scope, apply the **normal Workflow Steps below (1–11) to the child PRD** (the child name is the directory its leaf's `spec` points into, e.g. `f2-spatial-index`). Children in the same level are independent — plan them in any order. The umbrella's own cross-cutting decisions and dependency ordering already live in the umbrella `PRD.md`; per-slice architecture belongs to each child.

5. **Re-show the board and report.** As each child gains `defined` tasks, the umbrella's leaf status rolls up automatically (via `update-task-status.sh`). Re-run `scripts/umbrella-status.sh <umbrella>`, render the updated table, and suggest the next step: plan the next level, or — once a level is fully `planned` — *"work the `<umbrella>` PRD"*.

## Workflow Steps

These workflow steps MUST be followed exactly as written.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                             WORKFLOW DIAGRAM                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│      ┌──────────────────┐                                                       │
│ ┌───►│ 1. Deep Analysis │                                                       │
│ │    └────────┬─────────┘                                                       │
│ │             ▼                                                                 │
│ │    ┌────────────────────┐                                                     │
│ │    │ 2. Explore Codebase│                                                     │
│ │    └────────┬───────────┘                                                     │
│ │             ▼                                                                 │
│ │    ┌─────────────────────┐                                                    │
│ │    │ 3. Clarify with User│                                                    │
│ │    └────────┬────────────┘                                                    │
│ │             ▼                                                                 │
│ │    ╔═══════════════════════════════════════════╗                             │
│ │    ║ 4. CHECKPOINT (Post-Clarification)        ║                             │
│ │    ║    Re-analysis required?                  ║                             │
│ │    ╚════════════╤══════════════════════════════╝                             │
│ │          Yes    │    No                                                       │
│ │◄────────────────┘    │                                                        │
│ │                      ▼                                                        │
│ │    ┌────────────────────────────┐                                            │
│ │    │ 5. Generate Research Qs    │                                            │
│ │    └────────────┬───────────────┘                                            │
│ │                 ▼                                                            │
│ │    ┌────────────────────────────┐                                            │
│ │    │ 6. Research                │─── No questions? ───┐                       │
│ │    └────────────┬───────────────┘                     │                       │
│ │                 ▼                                     ▼                       │
│ │    ╔═══════════════════════════════════════════════════════╗                 │
│ │    ║ 7. CHECKPOINT (Post-Research)                         ║                 │
│ │    ║    Re-analysis required?                              ║                 │
│ │    ╚════════════╤══════════════════════════════════════════╝                 │
│ │          Yes    │    No                                                       │
│ └◄────────────────┘    │                                                        │
│                        ▼                                                        │
│              ┌──────────────┐                                                   │
│              │ 8. Refine    │                                                   │
│              └──────┬───────┘                                                   │
│                     ▼                                                           │
│         ┌──────────────────────────────────┐                                   │
│         │ 9. Decide: umbrella or tasks?     │                                   │
│         │    then Generate Tasks            │                                   │
│         └───────────────┬──────────────────┘                                   │
│                         ▼                                                       │
│              ┌───────────────────────┐                                          │
│              │ 10. Generate Task Specs│                                         │
│              └───────────┬───────────┘                                          │
│                          ▼                                                      │
│                  ┌─────────────┐                                                │
│                  │ 11. Validate│                                                │
│                  └─────────────┘                                                │
│                                                                                │
│  Legend: ════════ = CHECKPOINT (STOP and evaluate before proceeding)           │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 1. Deep Analysis

Before making any changes, thoroughly analyze the PRD:

| Analysis Area | Questions to Answer |
|---------------|---------------------|
| **Completeness** | Which sections are missing or incomplete? |
| **Consistency** | Does the objective align with any existing tasks? |
| **Specificity** | Are tasks specific, measurable, and actionable? |
| **Implementation** | Are implementation details sufficient? |
| **Files** | Are all relevant files identified? |
| **Edge Cases** | Are there constraints or edge cases overlooked? |
| **Architecture** | Does the proposed structure fit the codebase? |

**Document findings:**
- List all gaps and issues found
- Prioritize by impact on implementation success
- Note any contradictions or ambiguities

### 2. Explore Codebase

Search the codebase to discover files relevant to the PRD's objective.

**Discovery goals:**
- Find files that will need to be modified
- Identify existing patterns and utilities to leverage
- Locate similar features to use as reference
- Determine appropriate locations for new files

**Optional — use graphify if available.** `graphify` is a skill that turns a codebase into a queryable knowledge graph (architecture, file relationships, call paths). If it is available, prefer it for understanding structure before falling back to text search:
- **Available** means the `graphify` skill is installed, or a `graphify-out/` directory already exists in the repo. (Check by listing the available skills and/or `ls graphify-out/`.) If neither is true, skip this block and use the search strategy below.
- If a `graphify-out/` graph already exists, treat your discovery goals as graphify queries first — use its query/path/explain tools to map the modules, dependencies, and call paths relevant to this PRD.
- If graphify is installed but no graph exists yet, you may build one over the areas relevant to this PRD, then query it.
- This **supplements** the search below; always fall back to Glob/Grep for specifics graphify doesn't surface. Never make graphify a hard requirement — the rest of this workflow proceeds normally without it.

**Search strategy:**
1. Use Glob to find files matching relevant patterns
2. Use Grep to search for related functionality
3. Read discovered files to understand existing patterns
4. Identify potential conflicts or architectural constraints

**Document findings:**
- List all discovered files and their relevance
- Note existing patterns and utilities to leverage
- Identify architectural constraints or conflicts
- Record gaps in the codebase that need addressing

### 3. Clarify with User

Present your findings from Steps 1–2 to the user and ask clarifying questions.

**You MUST ask clarifying questions if ANY of these apply:**
- Ambiguities or gaps discovered during analysis
- Multiple valid implementation approaches exist
- Scope boundaries are unclear or implicit
- Architectural decisions require user input
- Trade-offs exist that affect user experience or maintainability
- The PRD references external systems or dependencies not fully specified

**You MAY skip ONLY if ALL of these are true:**
- Zero ambiguities found during analysis (document this explicitly)
- Single obvious implementation approach with no alternatives
- PRD explicitly addresses all edge cases and constraints
- All architectural decisions are already specified
- No trade-offs require user preference

**Mandatory output:** Document one of:
- "Questions asked: [list]" with user responses
- "Clarification skipped: [specific reasons why ALL skip conditions are met]"

### 4. Checkpoint: Evaluate Re-analysis (Post-Clarification)

STOP. Before proceeding to research, evaluate whether user clarifications require returning to Step 1.

| Condition | Assessment Required |
|-----------|---------------------|
| New requirements | Did clarifications reveal new requirements or scope changes? |
| New constraints | Did discussion uncover constraints not identified during analysis? |
| Approach changes | Do the answers significantly change the approach or architecture? |

**Mandatory output:** Document one of:
- "Returning to Step 1: [specific clarifications that require re-analysis]"
- "Proceeding to Step 5: [explicit confirmation for each condition above]"

Do NOT proceed until you have documented your assessment.

### 5. Generate Research Questions

If there are unknowns that require external research, generate a `research.yaml` file.

**When to generate research questions:**
- Implementation involves unfamiliar libraries, APIs, or tools
- Best practices are unclear
- Multiple valid approaches exist and you need guidance
- Technical details are missing from documentation

**Research question guidelines:**

| Rule | Description |
|------|-------------|
| **Maximum questions** | Never generate more than 25 research questions total |
| **3rd-party interfaces** | Always ask about library/tool interfaces if the implementation involves external dependencies |
| **Exception** | Skip interface questions if the existing codebase demonstrates clear patterns |
| **Mode selection** | Use `answer` for straightforward questions; use `deep-research` sparingly for complex ones |

`research.yaml` is validated against `schemas/research.schema.json`. Structure:

```yaml
- text: "What is the recommended way to handle X in Y framework?"
  mode: answer        # or deep-research for complex topics
```

### 6. Research

Execute research if there are unanswered questions.

**Get unanswered questions:**
```bash
scripts/get-unanswered-research.sh [prd_name]
```

Returns a JSON array of questions with `text` and `mode` fields. If the array is empty, skip to Step 7.

**Research execution:** For each question, use the Agent/Task tool to spawn a subagent that performs the research:

- `subagent_type`: `general-purpose`
- suggested `model`: `haiku`
- `prompt`: "Read and follow the instructions in `<absolute path to this skill>/agents/prd-researcher.md`. Inputs — `question`: [question text]; `mode`: [answer|deep-research]. Return only the JSON it specifies."

(The `prd-researcher` prompt file uses the Exa MCP tools. If Exa is unavailable, the subagent reports that; fall back to manual research or `WebSearch`.)

**Execution order:** launch all research subagents in parallel; wait for all to complete.

**Update `research.yaml`** with each subagent's returned `answer` and `citations`.

### 7. Checkpoint: Evaluate Re-analysis (Post-Research)

STOP. Before refining the PRD, evaluate whether research findings require returning to Step 1.

| Condition | Assessment Required |
|-----------|---------------------|
| Research impact | Did research reveal information that invalidates or changes the analysis? |
| New constraints | Were architectural constraints, edge cases, or limitations discovered? |
| Approach changes | Does research suggest a different implementation approach? |
| Missing information | Did research reveal gaps that require additional user clarification? |

**Mandatory output:** Document one of:
- "Returning to Step 1: [specific findings that require re-analysis]"
- "Proceeding to Step 8: [explicit confirmation for each condition above]"

Do NOT proceed until you have documented your assessment.

### 8. Refine

Review and refine the PRD based on research findings.

IMPORTANT: All relevant research findings MUST be incorporated into the PRD document. The PRD should be self-contained so that `research.yaml` does not need to be referenced during implementation.

- Add new constraints discovered during research to the Constraints section
- Update Implementation Details with technical approaches validated by research
- Add relevant documentation links to Relevant Guides
- Update the Architecture section with design decisions informed by research
- Answer any Discussion questions that research resolved
- Revise Relevant Files if research revealed additional files
- Include code examples, patterns, or API details from research in Implementation Details

### 9. Decide — one plan or an umbrella of several? — then Generate Tasks

First decide the **shape** of the plan:

If the effort is large and naturally decomposes into slices that can be planned and worked **independently** (different subsystems, a dependency-ordered slate), it is often better to create **several PRDs** than one monolith. In that case make this PRD an **umbrella**: its `tasks.yaml` leaves point at child PRDs rather than at task specs.

- Write the umbrella `tasks.yaml`: each leaf's `spec` is the child's `PRD.md` (e.g. `../f0-combat-contract/PRD.md`), `status: draft`; top-level entries are dependency **levels** (sequential), subtasks are same-level slices (parallel).
- Scaffold the child PRDs with `scripts/init-umbrella-children.sh <prd_name>` — it creates a stub `PRD.md` for each leaf so they exist and validate.
- Then plan the children: this is exactly the "Planning an Umbrella PRD" flow at the top of this document — show the status board, plan a level (usually L0 first) or all, applying the normal steps to each child. **Stop generating tasks/specs for the umbrella itself** (skip Steps 10–11 for the umbrella; they apply per child).
- Do **not** hand-maintain umbrella leaf statuses — they are derived from the children (`update-task-status.sh` auto-rolls-up; `scripts/sync-umbrella.sh` forces it). See `reference/prd-spec.md` ("Umbrella PRDs").
- The cross-cutting decisions and dependency ordering ARE the umbrella's value; per-slice architecture belongs to each child PRD.

> Unsure whether to split, or how? The sibling **breakdown** skill analyzes a PRD and proposes a decomposition (subtasks or umbrella) you can apply.

Otherwise, generate ordinary implementation tasks.

**Update PRD.md** before generating tasks:
- Complete the Architecture section with design decisions
- Fill in Relevant Guides with discovered documentation
- Update Relevant Files with all files discovered during exploration
- Incorporate research findings into Constraints

**Create `tasks.yaml`** (validated against `schemas/tasks.schema.json`):
- Top-level tasks execute **sequentially**; subtasks execute **in parallel**.
- Each leaf task needs a `spec` (an umbrella leaf's `spec` is the child `PRD.md`).
- New tasks start as `draft`; planning advances them to `defined`. The `in-progress` status is set later, by workers during implementation — **never here**.

```yaml
- name: "Set up authentication infrastructure"
  description: "Create the base auth module and configuration"
  subtasks:
    - name: "Create auth configuration"
      description: "Set up environment variables and config files"
      status: draft
      spec: "specs/auth-config.md"
    - name: "Create auth middleware"
      description: "Implement authentication middleware"
      status: draft
      spec: "specs/auth-middleware.md"

- name: "Implement login endpoint"
  description: "Create the login API endpoint"
  status: draft
  spec: "specs/login-endpoint.md"
```

### 10. Generate Task Specs

Generate detailed specification files for each leaf task. These specs are handed off to subagents during implementation, so they must be self-contained and comprehensive.

**Read the task spec template:** `reference/task-spec.md`

(Umbrella leaves point at a child `PRD.md` and do not get a separate spec file — plan the child PRD instead.)

**Check task status:** `scripts/task-status.sh [prd_name]`

**If draft tasks exist (`draft` > 0):**
1. Run `scripts/list-prd-draft-tasks.sh [prd_name]` to get all draft tasks.
2. For each draft task:
   - Create a detailed spec file following the task spec template, at the path in the task's `spec` field.
   - Advance the task to `defined`:
     ```bash
     scripts/update-task-status.sh [prd_name] "[task-name]" defined
     ```

**Spec file guidelines:**
- Be thorough but focused.
- Use concrete file paths and line numbers in code references.
- Make acceptance criteria verifiable and specific.
- Keep "Out of Scope" clear to prevent scope creep.
- If a task is complex, break it into subtasks (or use the **breakdown** skill).

### 11. Validate

After planning, validate the PRD is ready for implementation.

| Check | Command/Action | Pass Criteria |
|-------|----------------|---------------|
| Schemas + spec files | `scripts/validate-prd.sh [prd_name]` | Exits 0 ("is valid") |
| Tasks defined | `scripts/task-status.sh [prd_name]` | `draft` == 0 (all advanced to `defined`) |
| Research complete | `scripts/research-status.sh [prd_name]` | `draft` == 0 (or no research.yaml) |
| Discussion answered | Read PRD.md Discussion | All questions have answers |
| Objective clear | Review Objective | Specific and actionable |
| Constraints documented | Review Constraints | Comprehensive list |

**If validation fails:** return to the appropriate step, ask the user for input if blocked, and document blockers in the Discussion section.

## Output

After completion:
1. Display the final task status counts.
2. Summarize what was planned (note if it became an umbrella, and list the child PRDs).
3. List any concerns or risks identified.
4. Suggest the next step: implement it (the **WorkPRD** workflow) — e.g. say *"work the `[prd_name]` PRD"*. For an umbrella, plan each child first.

## Key Principles

- Document all findings explicitly in the PRD.
- Keep skip conditions strict — all conditions must be met.
- Ensure the PRD is self-contained after planning.
- Research findings must be integrated, not just referenced.
- Create specs that a subagent can implement independently.
