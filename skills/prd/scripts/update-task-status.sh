#!/usr/bin/env bash
# Updates the status of a given task for a PRD

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/yq-compat.sh
source "${SCRIPT_DIR}/lib/yq-compat.sh"
# shellcheck source=lib/umbrella-lib.sh
source "${SCRIPT_DIR}/lib/umbrella-lib.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/update-task-status.sh <prd-name> <task-name> <new-status>"
    echo ""
    echo "Updates the status of a task in a PRD's tasks.yaml file."
    echo ""
    echo "Arguments:"
    echo "  prd-name    Name of the PRD (directory name under .claude/prds/)"
    echo "  task-name   Name of the task to update"
    echo "  new-status  New status (draft, defined, in-progress, or completed)"
    exit 1
}

if [[ $# -lt 3 ]]; then
    usage
fi

PRD_NAME="$1"
TASK_NAME="$2"
NEW_STATUS="$3"

TASKS_FILE=".claude/prds/${PRD_NAME}/tasks.yaml"

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "Error: Tasks file not found: $TASKS_FILE" >&2
    exit 1
fi

# Validate status
case "$NEW_STATUS" in
    draft|defined|in-progress|completed) ;;
    *)
        echo "Error: Invalid status '$NEW_STATUS'. Must be one of: draft, defined, in-progress, completed" >&2
        exit 1
        ;;
esac

# Check if task exists (either as top-level leaf or subtask)
# shellcheck disable=SC2016 # $name is a jq variable, not bash
TASK_EXISTS=$(yaml_to_json "$TASKS_FILE" | jq --arg name "$TASK_NAME" '
    [ (.[] | select(.name == $name and .status)),
      (.[] | .subtasks[]? | select(.name == $name)) ] | length
')

if [[ "$TASK_EXISTS" -eq 0 ]]; then
    echo "Error: Task '$TASK_NAME' not found in $TASKS_FILE" >&2
    exit 1
fi

# Update in place (handles both top-level leaf tasks and subtasks)
yaml_set_status "$TASKS_FILE" "$TASK_NAME" "$NEW_STATUS"

echo "Updated task '$TASK_NAME' status to '$NEW_STATUS'"

# Auto-roll-up: if this PRD is a child of one or more umbrella PRDs, refresh those
# umbrellas so their derived leaf statuses never drift from reality. Re-entrancy
# is guarded by PRD_NO_UMBRELLA_SYNC (set by sync-umbrella.sh when it calls back
# into this script). Best-effort — a sync hiccup never fails the status update.
if [[ -z "${PRD_NO_UMBRELLA_SYNC:-}" ]]; then
    while IFS= read -r parent; do
        [[ -z "$parent" ]] && continue
        PRD_NO_UMBRELLA_SYNC=1 "${SCRIPT_DIR}/sync-umbrella.sh" "$parent" >/dev/null 2>&1 || true
    done < <(ul_parent_umbrellas "$PRD_NAME")
fi
