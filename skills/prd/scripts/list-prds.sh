#!/usr/bin/env bash
# Lists all PRDs with their status and task completion counts

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

PRD_DIR=".claude/prds"

if [[ ! -d "$PRD_DIR" ]]; then
    echo "[]"
    exit 0
fi

# Build JSON array of PRD statuses
result="[]"

for prd_path in "$PRD_DIR"/*/; do
    if [[ ! -d "$prd_path" ]]; then
        continue
    fi

    prd_name=$(basename "$prd_path")
    tasks_file="${prd_path}tasks.yaml"

    if [[ ! -f "$tasks_file" ]]; then
        # No tasks file
        result=$(jq --arg name "$prd_name" \
            '. += [{"name": $name, "status": "no-tasks", "completed": 0, "total": 0}]' \
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
        '. += [{"name": $name, "status": $status, "completed": $completed, "total": $total}]' \
        <<< "$result")
done

echo "$result"
