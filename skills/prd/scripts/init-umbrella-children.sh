#!/usr/bin/env bash
# Scaffold child PRD directories for an umbrella's leaves that don't have one yet.
#
# An umbrella's tasks.yaml leaves point at child PRDs (e.g. "../f1-foo/PRD.md")
# that often don't exist yet right after the umbrella is shaped (by PlanPRD or the
# breakdown skill). This materializes each missing child as a directory plus a
# stub PRD.md: Objective/Motivation seeded from the leaf, the rest left as the same
# planning placeholders CreatePRD uses, so you can immediately plan each child.
#
# Idempotent: a child whose PRD.md already exists is left untouched. It does NOT
# create tasks.yaml or change any status — a freshly scaffolded child has no tasks,
# so the umbrella reads it as draft / needs-plan until you run PlanPRD on it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/yq-compat.sh
source "${SCRIPT_DIR}/lib/yq-compat.sh"
# shellcheck source=lib/umbrella-lib.sh
source "${SCRIPT_DIR}/lib/umbrella-lib.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/init-umbrella-children.sh <umbrella-prd-name> [--child <child-name>]"
    echo ""
    echo "Creates a stub PRD.md for each umbrella leaf whose child PRD does not"
    echo "exist yet. With --child, only scaffolds that one child. Idempotent."
    exit 1
}

[[ $# -lt 1 ]] && usage

PRD_NAME="$1"; shift || true
ONLY_CHILD=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        --child) ONLY_CHILD="${2:-}"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "Error: unknown argument '$1'" >&2; usage ;;
    esac
done

PRD_DIR=".claude/prds/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "Error: Tasks file not found: $TASKS_FILE" >&2
    exit 1
fi

TASKS_JSON=$(yaml_to_json "$TASKS_FILE")
LEAVES=$(ul_leaves "$TASKS_JSON" "$PRD_DIR")

if [[ "$(jq 'length' <<< "$LEAVES")" -eq 0 ]]; then
    echo "Error: '$PRD_NAME' is not an umbrella PRD (no leaf points at a child PRD.md)." >&2
    exit 2
fi

# Write a stub child PRD.md seeded from the umbrella leaf.
write_stub() {
    local prd_md="$1" title="$2" objective="$3" child="$4"
    cat > "$prd_md" <<EOF
# ${title}

> Scaffolded from umbrella **${PRD_NAME}**. Plan this child with the prd skill —
> e.g. *"plan the ${child} PRD"* — or plan the whole slate at once with
> *"plan the ${PRD_NAME} PRD"*.

## Objective

${objective}

## Motivation

<To be filled in — why this slice matters to the ${PRD_NAME} umbrella.>

## Implementation Details

### Architecture

<To be determined during planning>

### Constraints

<To be determined during planning>

### Relevant Guides

<To be determined during planning>

### Relevant Files

<To be determined during planning>

## Discussion
EOF
}

created="[]"
skipped="[]"

while IFS= read -r leaf; do
    [[ -z "$leaf" ]] && continue
    child_name=$(jq -r '.child_name' <<< "$leaf")
    [[ -n "$ONLY_CHILD" && "$child_name" != "$ONLY_CHILD" ]] && continue

    child_dir=$(jq -r '.child_dir' <<< "$leaf")
    leaf_name=$(jq -r '.name // .child_name' <<< "$leaf")
    leaf_desc=$(jq -r '.description // ""' <<< "$leaf")
    prd_md="${child_dir}/PRD.md"

    if [[ -f "$prd_md" ]]; then
        skipped=$(jq --arg c "$child_name" '. += [$c]' <<< "$skipped")
        continue
    fi

    objective="$leaf_desc"
    [[ -z "$objective" ]] && objective="<To be filled in.>"

    mkdir -p "$child_dir"
    write_stub "$prd_md" "$leaf_name" "$objective" "$child_name"
    created=$(jq --arg c "$child_name" '. += [$c]' <<< "$created")
done < <(jq -c '.[]' <<< "$LEAVES")

jq -n \
    --arg prd "$PRD_NAME" \
    --argjson created "$created" \
    --argjson skipped "$skipped" \
    '{
        umbrella: $prd,
        created: $created,
        skipped: $skipped,
        created_count: ($created | length),
        skipped_count: ($skipped | length)
    }'
