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

- Create one child PRD directory per slice (each a normal PRD planned separately — apply the **PlanPRD** workflow to each child).
- In the umbrella `tasks.yaml`, each leaf's `spec` is the child's `PRD.md` (e.g. `../f0-combat-contract/PRD.md`); top-level entries are dependency **levels** (sequential), subtasks are same-level slices (parallel).
- Do **not** hand-maintain umbrella leaf statuses — they are derived from the children by `scripts/sync-umbrella.sh`. See `reference/prd-spec.md` ("Umbrella PRDs").
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
