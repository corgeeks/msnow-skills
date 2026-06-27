#!/usr/bin/env bash
# Lists all leaf tasks with defined status for a PRD

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/list-defined-tasks.sh <prd-name>"
    echo ""
    echo "Lists all tasks with 'defined' status that are ready for implementation."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
PRD_DIR=".claude/prds/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"

if [[ ! -d "$PRD_DIR" ]]; then
    echo "Error: PRD directory not found: $PRD_DIR" >&2
    exit 1
fi

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "[]"
    exit 0
fi

# Get defined tasks from both top-level and subtasks
# shellcheck disable=SC2016 # $parent is a jq variable, not bash
yaml_to_json "$TASKS_FILE" | jq '
    [
        # Top-level leaf tasks with defined status
        ( .[] | select(.status == "defined") | {
            "name": .name,
            "description": .description,
            "spec": .spec,
            "parent": null
        } ),
        # Subtasks with defined status
        ( .[] | select(.subtasks) | . as $parent | .subtasks[] | select(.status == "defined") | {
            "name": .name,
            "description": .description,
            "spec": .spec,
            "parent": $parent.name
        } )
    ]
'
