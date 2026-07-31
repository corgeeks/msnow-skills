# msnow-skills

Agent skills for running features through a full **PRD (Product Requirements
Document)** lifecycle — create, plan, and implement — plus a companion skill for
**breaking a plan down** into smaller units.

Two skills ship from this repo:

| Skill | What it does |
|-------|--------------|
| **prd** | Create, plan (research + task breakdown), and implement PRDs. Supports **umbrella PRDs** (decompose a large effort into a slate of child PRDs whose progress rolls up to the parent) and is **resilient to interruptions** (an `in-progress` status + log checkpoints let a new session resume a task a previous one left unfinished). |
| **breakdown** | Analyze an existing PRD and recommend — then, on confirmation, apply — splitting oversized tasks into subtasks or decomposing the PRD into an umbrella of child PRDs. |

## Install

```bash
# installs both skills (you'll be prompted to choose / confirm)
npx skills install corgeeks/msnow-skills

# install to ~/.claude/skills (global) instead of the project's .claude/skills
npx skills install corgeeks/msnow-skills -g

# install just one
npx skills install corgeeks/msnow-skills --skill prd
```

`npx skills` is [Vercel Labs' open skills tool](https://github.com/vercel-labs/skills).
It copies each skill (and its `scripts/`, `reference/`, `schemas/`, `hooks/`,
`agents/`) into `.claude/skills/<name>/`. The two skills install as siblings, which
is what lets `breakdown` reuse `prd` via `../prd/`.

Install both — `breakdown` builds on `prd`'s scripts and schema.

## Requirements

`jq`, `yq` (Go or Python flavor — auto-detected), and `check-jsonschema`. The Exa
MCP server is optional (powers the research step; otherwise the researcher falls
back to web search). See [DEPENDENCIES.md](DEPENDENCIES.md).

### Optional integrations

- **Exa MCP** — automated research during PlanPRD (falls back to web search).
- **graphify** — if the `graphify` codebase-knowledge-graph skill is installed (or a
  `graphify-out/` graph exists in the repo), PlanPRD's "Explore Codebase" step uses
  it to map architecture and file relationships before falling back to Glob/Grep.
  Strictly optional — the workflow runs normally without it.

## Using it

Invoke the skills in conversation — describe what you want and Claude routes to the
right workflow:

- **Create** — "create a PRD for user authentication" → gathers objective,
  motivation, constraints; writes `docs/prd/<name>/PRD.md` (or wherever the
  project has configured PRDs to live — see below).
- **Plan** — "plan the user-authentication PRD" → deep analysis, codebase
  exploration, research (Exa), then a `tasks.yaml` of specced tasks. Decides
  whether the effort should become an **umbrella** of child PRDs.
- **Work** — "work the user-authentication PRD" → resumes any interrupted
  (`in-progress`) tasks first, then dispatches a worker per defined task. For an
  umbrella, it drives the child slate and syncs progress back up.

For an **umbrella PRD**, you drive the whole slate through the parent — "plan the
combat-next PRD" plans its child PRDs level by level (L0 → L1 → …), and "work the
combat-next PRD" implements them — without listing each child by hand. Both open
with a status board (`| Level | PRD | Plan | Work |`) and offer "do the next level"
or "do all". Child progress rolls up to the umbrella automatically.
- **Break down** — "this PRD is too big, break it down" → analysis + a proposed
  decomposition; restructures `tasks.yaml` after you confirm.

PRDs live under `docs/prd/<name>/` in your project by default — a plain,
visible directory, since PRDs are product documentation for the whole team,
not Claude-specific state:

```
docs/prd/<name>/
├── PRD.md            # requirements document
├── tasks.yaml        # task definitions (validated against the schema)
├── research.yaml     # research questions (optional)
├── log.md            # implementation log + resume checkpoints
└── specs/            # one spec file per leaf task
```

The first time you create a PRD in a project, the skill asks where you'd like
them stored (default `docs/prd`) and remembers your answer in
`.claude/prd-root` for every later session. Projects that already have PRDs
under the legacy `.claude/prds/` location keep working there automatically —
nothing to migrate. See `skills/prd/reference/prd-spec.md` and
`skills/prd/workflows/CreatePRD.md` for the full resolution order.

The scripts are also usable directly (paths are relative to the installed skill
directory):

```bash
scripts/list-prds.sh
scripts/task-status.sh <name>
scripts/validate-prd.sh <name>
scripts/umbrella-status.sh <umbrella-name>        # per-child plan/work status board
scripts/init-umbrella-children.sh <umbrella-name> # scaffold child PRDs from leaves
scripts/sync-umbrella.sh <umbrella-name>          # (usually automatic) roll child progress up
```

See `skills/prd/reference/cli-tools.md` for the full list.

## Optional: automatic validation hooks

`scripts/validate-prd.sh` is called inside the workflows, so validation works on a
plain install. If you also want `tasks.yaml` / `research.yaml` validated
automatically on **every** edit (including manual ones), wire the bundled hooks
into your Claude Code `settings.json`.

For a **project** install (`.claude/skills/prd/`):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/skills/prd/hooks/validate-tasks.sh" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/skills/prd/hooks/validate-research.sh" },
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/skills/prd/hooks/sync-umbrellas.sh" }
        ]
      }
    ]
  }
}
```

For a **global** install, use the absolute path instead, e.g.
`~/.claude/skills/prd/hooks/validate-tasks.sh`. The hooks degrade gracefully if
`jq`/`yq`/`check-jsonschema` are missing (they skip rather than block).

`sync-umbrellas.sh` is optional: when a child PRD's `tasks.yaml` is edited by hand,
it rolls that progress up into any umbrella that owns the child. Status changes
made through `scripts/update-task-status.sh` (what the workers use) already
roll up on their own, so this hook only covers manual edits.

## Layout

```
msnow-skills/
└── skills/
    ├── prd/
    │   ├── SKILL.md
    │   ├── workflows/      # CreatePRD, PlanPRD, WorkPRD
    │   ├── agents/         # prd-worker, prd-researcher (prompt files)
    │   ├── reference/      # prd-spec, task-spec, log-spec, cli-tools
    │   ├── schemas/        # tasks.schema.json, research.schema.json
    │   ├── scripts/        # CLI tools (+ lib/, validate-prd.sh)
    │   └── hooks/          # optional PostToolUse validators + umbrella auto-sync
    └── breakdown/
        ├── SKILL.md
        └── reference/      # heuristics
```

## Credits

Synthesized from [fullykubed/nixos-config](https://github.com/fullykubed/nixos-config/tree/main/modules/common/claude/skills/PRD)
(the PRD skill and scripts) and the umbrella-workflow + interruption-resilience
work from [cc-prd](https://github.com/itzsaga/cc-prd), repackaged as portable,
`npx skills`-installable skills (no Nix, no plugin marketplace).

## License

MIT
