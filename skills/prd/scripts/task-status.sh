#!/usr/bin/env bash
# Returns JSON with task counts by status for a PRD

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"
# shellcheck source=lib/prd-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prd-root.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/task-status.sh <prd-name>"
    echo ""
    echo "Returns JSON with task counts by status and total."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
TASKS_FILE="$(resolve_prd_root)/${PRD_NAME}/tasks.yaml"

if [[ ! -f "$TASKS_FILE" ]]; then
    jq -n '{"draft": 0, "defined": 0, "in-progress": 0, "completed": 0, "total": 0}'
    exit 0
fi

# Transcode once, count with jq
TASKS_JSON=$(yaml_to_json "$TASKS_FILE" 2>/dev/null || echo "null")

# Handle empty or null YAML content
task_count=$(jq 'if type == "array" then length else 0 end' <<< "$TASKS_JSON" 2>/dev/null || echo "0")
if [[ "$task_count" -eq 0 ]]; then
    jq -n '{"draft": 0, "defined": 0, "in-progress": 0, "completed": 0, "total": 0}'
    exit 0
fi

# Count both top-level leaf tasks and subtasks by status, in one pass
jq '
    [ (.[] | select(.status)), (.[] | .subtasks[]? | select(.status)) ]
    | (map(select(.status == "draft"))       | length) as $draft
    | (map(select(.status == "defined"))     | length) as $defined
    | (map(select(.status == "in-progress")) | length) as $in_progress
    | (map(select(.status == "completed"))   | length) as $completed
    | {
        "draft": $draft,
        "defined": $defined,
        "in-progress": $in_progress,
        "completed": $completed,
        "total": ($draft + $defined + $in_progress + $completed)
      }
' <<< "$TASKS_JSON"
