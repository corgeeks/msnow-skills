#!/usr/bin/env bash
# Lists all leaf tasks with in-progress status for a PRD
#
# These are tasks a previous session started but did not finish (e.g. it hit a
# token limit). A resuming session should pick these up FIRST, before starting
# any new `defined` tasks. See workflows/WorkPRD.md ("Resuming interrupted work").

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"
# shellcheck source=lib/prd-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prd-root.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/list-in-progress-tasks.sh <prd-name>"
    echo ""
    echo "Lists all leaf/subtask tasks with 'in-progress' status (interrupted work to resume)."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
PRD_DIR="$(resolve_prd_root)/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"

if [[ ! -d "$PRD_DIR" ]]; then
    echo "Error: PRD directory not found: $PRD_DIR" >&2
    exit 1
fi

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "[]"
    exit 0
fi

# Get in-progress tasks from both top-level and subtasks
# shellcheck disable=SC2016 # $parent is a jq variable, not bash
yaml_to_json "$TASKS_FILE" | jq '
    [
        # Top-level leaf tasks with in-progress status
        ( .[] | select(.status == "in-progress") | {
            "name": .name,
            "description": .description,
            "spec": .spec,
            "parent": null
        } ),
        # Subtasks with in-progress status
        ( .[] | select(.subtasks) | . as $parent | .subtasks[] | select(.status == "in-progress") | {
            "name": .name,
            "description": .description,
            "spec": .spec,
            "parent": $parent.name
        } )
    ]
'
