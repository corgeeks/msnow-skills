#!/usr/bin/env bash
# Lists all PRDs with their status and task completion counts.
#
# Each entry is additionally tagged for umbrella relationships:
#   is_umbrella     - true if this PRD's leaves point at child PRDs (a program tracker)
#   umbrella_parent - the umbrella PRD that owns this one as a child slice, else null
# so the prd skill can group children under their umbrella in the listing.

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"
# shellcheck source=lib/umbrella-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/umbrella-lib.sh"
# shellcheck source=lib/prd-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prd-root.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

PRD_DIR="$(resolve_prd_root)"

if [[ ! -d "$PRD_DIR" ]]; then
    echo "[]"
    exit 0
fi

# Pre-pass: map which PRDs are umbrellas and which PRDs are their children, so the
# second pass can tag each entry without depending on directory iteration order.
declare -A IS_UMBRELLA=()
declare -A PARENT_OF=()

for prd_path in "$PRD_DIR"/*/; do
    [[ -d "$prd_path" ]] || continue
    name=$(basename "$prd_path")
    tasks_file="${prd_path}tasks.yaml"
    [[ -f "$tasks_file" ]] || continue

    tasks_json=$(yaml_to_json "$tasks_file" 2>/dev/null || echo "null")
    leaves=$(ul_leaves "$tasks_json" "${prd_path%/}")
    [[ "$(jq 'length' <<< "$leaves")" -gt 0 ]] || continue

    IS_UMBRELLA["$name"]=1
    while IFS= read -r child; do
        [[ -z "$child" ]] && continue
        PARENT_OF["$child"]="$name"
    done < <(jq -r '.[].child_name' <<< "$leaves")
done

# Build JSON array of PRD statuses
result="[]"

for prd_path in "$PRD_DIR"/*/; do
    if [[ ! -d "$prd_path" ]]; then
        continue
    fi

    prd_name=$(basename "$prd_path")
    tasks_file="${prd_path}tasks.yaml"

    is_umbrella="false"
    [[ -n "${IS_UMBRELLA[$prd_name]:-}" ]] && is_umbrella="true"
    parent="${PARENT_OF[$prd_name]:-}"

    if [[ ! -f "$tasks_file" ]]; then
        # No tasks file
        result=$(jq --arg name "$prd_name" \
            --argjson is_umbrella "$is_umbrella" \
            --arg parent "$parent" \
            '. += [{"name": $name, "status": "no-tasks", "completed": 0, "total": 0,
                    "is_umbrella": $is_umbrella,
                    "umbrella_parent": (if $parent == "" then null else $parent end)}]' \
            <<< "$result")
        continue
    fi

    tasks_json=$(yaml_to_json "$tasks_file" 2>/dev/null || echo "null")

    # Count completed, in-progress, and total leaf/subtask nodes
    completed=$(jq '
        [ (.[] | select(.status == "completed")),
          (.[] | .subtasks[]? | select(.status == "completed")) ] | length
    ' <<< "$tasks_json" 2>/dev/null || echo "0")

    in_progress=$(jq '
        [ (.[] | select(.status == "in-progress")),
          (.[] | .subtasks[]? | select(.status == "in-progress")) ] | length
    ' <<< "$tasks_json" 2>/dev/null || echo "0")

    total=$(jq '
        [ (.[] | select(.status)), (.[] | .subtasks[]? | select(.status)) ] | length
    ' <<< "$tasks_json" 2>/dev/null || echo "0")

    # Determine rollup status
    if [[ "$total" -eq 0 ]]; then
        status="no-tasks"
    elif [[ "$completed" -eq "$total" ]]; then
        status="complete"
    elif [[ "$completed" -gt 0 || "$in_progress" -gt 0 ]]; then
        status="in-progress"
    else
        status="draft"
    fi

    result=$(jq --arg name "$prd_name" \
        --arg status "$status" \
        --argjson completed "$completed" \
        --argjson total "$total" \
        --argjson is_umbrella "$is_umbrella" \
        --arg parent "$parent" \
        '. += [{"name": $name, "status": $status, "completed": $completed, "total": $total,
                "is_umbrella": $is_umbrella,
                "umbrella_parent": (if $parent == "" then null else $parent end)}]' \
        <<< "$result")
done

echo "$result"
