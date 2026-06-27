# Dependencies

The `prd` skill's scripts and validation need a few common CLI tools. The
`breakdown` skill reuses the same tools via the sibling `prd` skill.

## Required

### `jq` — JSON processing

Used by every script and hook. Any recent version (1.6+).

| Platform | Command |
|----------|---------|
| macOS (Homebrew) | `brew install jq` |
| Ubuntu/Debian | `apt install jq` |
| Arch Linux | `pacman -S jq` |
| NixOS | `nix-env -iA nixpkgs.jq` |
| Windows (Chocolatey) | `choco install jq` |

### `yq` — YAML ⇄ JSON

Used to read/write `tasks.yaml` and `research.yaml`. **Either flavor works** — two
unrelated programs ship as `yq`:
- Go [mikefarah/yq](https://github.com/mikefarah/yq)
- Python [kislyuk/yq](https://github.com/kislyuk/yq) (a jq wrapper)

`scripts/lib/yq-compat.sh` detects which is installed and adapts; all querying is
done with `jq` for uniformity, so you don't need a specific one.

| Platform | Go yq (mikefarah) | Python yq (kislyuk) |
|----------|-------------------|---------------------|
| macOS (Homebrew) | `brew install yq` | `pip install yq` |
| Ubuntu/Debian | `snap install yq` | `pip install yq` |
| Arch Linux | `pacman -S go-yq` | `pacman -S yq` |
| NixOS | `nix-env -iA nixpkgs.yq-go` | `nix-env -iA nixpkgs.python3Packages.yq` |
| pip (any) | — | `pip install yq` |

**Caveat (Python yq only):** the Python wrapper round-trips YAML through JSON, so
in-place status updates (`update-task-status.sh`) **strip comments** from
`tasks.yaml`. Keep prose in `PRD.md`, not `tasks.yaml` comments, if you rely on it.
The Go yq preserves comments.

### `check-jsonschema` — schema validation

Used by `scripts/validate-prd.sh` and the optional hooks to validate `tasks.yaml`
and `research.yaml`.

```bash
pip install check-jsonschema
```

If `check-jsonschema` is missing, the hooks degrade gracefully (skip validation
rather than block edits) and `validate-prd.sh` exits with an error explaining how
to install it.

## Optional

### Exa MCP server — research

The `prd-researcher` agent uses the Exa MCP tools during PlanPRD's research step.
Without Exa, the researcher falls back to `WebSearch`/`WebFetch` (or reports that
research is unavailable). To enable Exa:

1. Get an API key from [Exa AI](https://exa.ai).
2. Configure the Exa MCP server in your Claude settings.
3. Set `EXA_API_KEY` in your environment.

### graphify — codebase knowledge graph

If the `graphify` skill is installed (it turns a codebase into a queryable
knowledge graph), PlanPRD's "Explore Codebase" step will use it to map
architecture and file relationships, and will prefer querying an existing
`graphify-out/` graph before falling back to Glob/Grep. Entirely optional — if
graphify isn't present, planning proceeds with normal text search.

## Quick check

```bash
for t in jq yq check-jsonschema; do
  if command -v "$t" >/dev/null 2>&1; then echo "[ok] $t"; else echo "[missing] $t"; fi
done
```
