# Breakdown Heuristics

Signals for deciding whether a PRD plan is too big, and how to cut it. These are
guidelines, not hard thresholds — judge the actual coupling and scope, not just
the counts.

## When a single leaf TASK should be split into subtasks

Split a leaf task into a parent + subtasks when several of these hold:

- **Many acceptance criteria** — roughly **> 7** verifiable criteria in its spec.
- **Multiple distinct concerns** — it bundles unrelated changes (e.g. "add the API
  endpoint *and* the migration *and* the UI"), each of which could be verified and
  reviewed on its own.
- **Touches many files/subsystems** — changes span layers that don't have to change
  together (data layer + transport + UI + docs).
- **Mixed sequencing inside one task** — part of it must happen before another part,
  which is really two tasks.
- **Too large for one worker pass** — realistically can't be implemented and verified
  in a single focused session.
- **Vague/compound description** — the description uses "and"/"then" to chain
  separable outcomes.

Keep it as one task when the work is cohesive, shares one acceptance surface, and a
worker can finish it in one pass.

## When the whole PRD should become an UMBRELLA

Convert the PRD into an umbrella of child PRDs when several of these hold:

- **Many leaf tasks** — roughly **> 10–12** leaves, especially across different areas.
- **Independent slices** — groups of work map to different subsystems/services that
  can be designed, planned, and worked **separately**.
- **Per-slice architecture** — each slice deserves its own Architecture/Constraints
  discussion (i.e. one PRD's "Implementation Details" can't sensibly cover them all).
- **A dependency-ordered slate** — the work forms levels: a foundational slice gates
  others, then several slices fan out in parallel, etc.
- **Separable verification & ownership** — slices could be implemented by different
  people/sessions without constant coordination.

Prefer splitting tasks within one PRD (not an umbrella) when the work is one
subsystem with shared design and tight coupling — an umbrella adds coordination
overhead and is only worth it when slices are genuinely independent.

## When to leave it alone

- The plan already has cohesive, single-pass leaf tasks.
- Top-level ordering and parallel subtasks already express the real dependencies.
- It's small (a handful of leaves) and tightly related.

Say so plainly — "no change" is a valid, common verdict.

## Transformation: split a leaf into subtasks

Before — one oversized leaf:

```yaml
- name: "Build authentication"
  description: "Add JWT auth: config, middleware, login endpoint, and docs"
  status: defined
  spec: "specs/build-authentication.md"
```

After — a parent with parallel subtasks (new subtasks start as `draft` and need
their own specs; the old spec becomes source material):

```yaml
- name: "Build authentication"
  description: "Add JWT auth across config, middleware, and the login endpoint"
  subtasks:
    - name: "Auth configuration"
      description: "Environment variables, secrets, and config wiring"
      status: draft
      spec: "specs/auth-config.md"
    - name: "Auth middleware"
      description: "JWT verification middleware and role checks"
      status: draft
      spec: "specs/auth-middleware.md"
    - name: "Login endpoint"
      description: "POST /login issuing tokens"
      status: draft
      spec: "specs/login-endpoint.md"
```

Notes:
- A parent task has **no** `status`/`spec` (schema: `parentTask` requires only
  `name`, `description`, `subtasks`).
- If subtasks have an order dependency among themselves, they are NOT parallel —
  promote them to separate **top-level** tasks instead (top-level = sequential).
- Don't carry the old `defined` status onto the new subtasks; they aren't specced
  yet. Plan them with the prd skill (PlanPRD) to write specs and advance to
  `defined`.

## Transformation: convert a PRD into an umbrella

Before — a flat list of many tasks across subsystems:

```yaml
- name: "Combat data contract"
  description: "..."
  status: defined
  spec: "specs/combat-data-contract.md"
- name: "Authority loop"
  description: "..."
  status: draft
  spec: "specs/authority-loop.md"
# ...10 more, spanning different subsystems...
```

After — an umbrella: top-level entries are dependency **levels** (sequential),
subtasks are same-level slices (parallel); each leaf points at a child `PRD.md`
and starts as `draft`:

```yaml
- name: "L0 · Combat contract (gates everything)"
  description: "First slice; fixes the data shapes every other slice depends on."
  spec: "../f0-combat-contract/PRD.md"
  status: draft
- name: "L1 · Foundation fan-out"
  description: "Slices that depend only on L0."
  subtasks:
    - name: "F1 — Live authority loop"
      description: "..."
      spec: "../f1-live-authority-loop/PRD.md"
      status: draft
    - name: "F2 — Damage resolver"
      description: "..."
      spec: "../f2-damage-resolver/PRD.md"
      status: draft
```

Notes:
- An umbrella leaf's `spec` basename is `PRD.md` — that's how the prd skill detects
  it (`get-task.sh` → `is_umbrella_child: true`).
- Leaves start `draft`; the child PRDs don't exist yet. `draft` tasks are not
  required to have an existing spec file, so this passes `validate-prd.sh`.
- This skill rewrites the umbrella's `tasks.yaml` only. Creating and planning each
  child PRD is the prd skill's job (CreatePRD → PlanPRD per child). Once children
  exist, `../prd/scripts/sync-umbrella.sh <umbrella>` derives the umbrella leaf
  statuses from child progress — never hand-edit them.
- Choose child directory names in kebab-case; the umbrella leaf path is
  `../<child-name>/PRD.md` (siblings under `.claude/prds/`).

## Safety

- Identify `in-progress`/`completed` tasks before changing anything. Converting or
  splitting them discards or invalidates real work — get explicit approval, and
  prefer to leave finished slices intact (e.g. keep a completed task as its own
  top-level entry rather than folding it into a new structure).
- Always finish with `../prd/scripts/validate-prd.sh <name>` and resolve any errors.
