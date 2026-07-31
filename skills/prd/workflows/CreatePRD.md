# CreatePRD Workflow

This workflow guides you through creating a new PRD (Product Requirements Document) from scratch.

## Workflow Steps

These workflow steps MUST be followed exactly as written.

### 1. Gather the Objective

Ask the user to describe what they want to accomplish. Get a clear understanding of the feature, fix, or improvement they need.

**Questions to ask:**
- What problem are you trying to solve?
- Who is this for (users, developers, system)?
- What does success look like?

**Follow-up as needed:**
- Clarify ambiguous requirements
- Identify scope boundaries

### 2. Gather the Motivation

Understand why this objective matters. This provides context for decision-making during planning and implementation.

**Questions to ask:**
- Why is this important now?
- What problem does this solve?
- What is the impact of not doing this?
- What value does this provide to users/developers/the system?

### 3. Identify Constraints

Work with the user to identify constraints for the implementation:

- **Technical constraints**: Language, framework, library requirements
- **Compatibility constraints**: Must work with existing systems/patterns
- **Performance constraints**: Speed, memory, scalability requirements
- **Scope constraints**: What is explicitly out of scope

### 4. Document Discussion

Record all clarifying questions and their answers in the Discussion section. This creates a record of decisions and context for future reference.

Format each Q&A as:
```md
### [Question Title]

_[Full question text]_

[User's answer]
```

### 5. Determine the PRD Root Directory

Before writing anything, resolve where this project's PRDs live — run `scripts/prd-root.sh` (or, equivalently, `bash -c 'source scripts/lib/prd-root.sh && resolve_prd_root'`) from the skill directory. It returns one of:

- **`.claude/prds`** — this project already has PRDs there from before this config existed. Use it as-is; do not ask.
- **A path from `.claude/prd-root`** — a previous session already asked and recorded the answer. Use it as-is; do not ask.
- **`docs/prd`** (the fallback, meaning neither of the above exists) — this is either a brand-new project for this skill, or truly has no PRDs yet. **Ask the user** where PRDs should live before creating the first one, e.g.: *"Where should PRDs live in this repo? Default: `docs/prd` — a plain, visible directory any teammate or tool can read, not hidden inside `.claude/`."* Accept their answer, or `docs/prd` if they have no preference.
  - **Persist the answer** (even if it's the default) by writing it, and nothing else, to `.claude/prd-root` (create the `.claude/` directory if needed). This is a one-line project config file, not a PRD document — every later script call and future session then resolves the same root automatically, with no need to ask again.

Call the resolved directory `<prd-root>` in the steps below.

### 6. Create the PRD File

Create a PRD file following the exact structure defined in the PRD specification (`reference/prd-spec.md`).

**File location:** `<prd-root>/[prd_name]/PRD.md`

Where `[prd_name]` is a kebab-case name derived from the objective (e.g., `user-authentication`, `dark-mode-toggle`).

### 7. Fill Out Sections

Focus on gathering information and filling out only:

| Section | Action |
|---------|--------|
| **Objective** | Fill with the user-provided description of what they want to accomplish |
| **Motivation** | Fill with why this objective matters, the problem it solves, and impact |
| **Constraints** | Fill with any constraints mentioned by the user or that you identify |
| **Discussion** | Fill with clarifying questions and their answers |

### 8. Leave Placeholders

The following sections should be left as placeholders for the planning workflow. Do NOT fill these out during PRD creation:

| Section | Placeholder Text |
|---------|------------------|
| **Architecture** | `<To be determined during planning>` |
| **Relevant Guides** | `<To be determined during planning>` |
| **Relevant Files** | `<To be determined during planning>` |

### 9. Do NOT Create tasks.yaml

Task generation is handled separately during the PlanPRD workflow. Creating tasks prematurely may lead to:
- Incomplete task definitions
- Tasks that don't align with discovered constraints
- Missing research-informed decisions

### 10. Validate and Confirm

Before completing:

1. **Read back the PRD** to the user for confirmation
2. **Verify** the objective clearly captures what they want
3. **Verify** the motivation explains why this matters
4. **Confirm** all known constraints are documented
5. **Check** the Discussion section captures key decisions

## Output

After completion:
1. Display the path to the created PRD
2. Summarize what was captured
3. Suggest the next step: plan the PRD (the **PlanPRD** workflow) — e.g. say *"plan the `[prd_name]` PRD"*.

## Guidelines

- **Keep the objective focused**: A PRD should address one feature or improvement
- **Be thorough with constraints**: Better to capture too many than miss important ones
- **Document decisions**: The Discussion section is valuable context for planning
- **Don't over-specify**: Leave room for the planning phase to determine implementation details
- **Flag large, multi-slice programs**: If the effort is clearly a big program that splits into independent slices, note that in Motivation/Constraints. PlanPRD may decompose it into an **umbrella PRD** of several child PRDs planned and worked separately (see `reference/prd-spec.md`, "Umbrella PRDs"). The **breakdown** skill can analyze the eventual plan and propose the split.
