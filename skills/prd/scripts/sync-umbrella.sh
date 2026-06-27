#!/usr/bin/env bash
# Recompute an umbrella PRD's task statuses from the progress of its child PRDs.
#
# An umbrella PRD is a program tracker: each leaf/subtask's `spec` points at a
# CHILD PRD (a path ending in PRD.md, e.g. "../f0-combat-contract/PRD.md") rather
# than at a normal spec file under specs/. The child is planned and worked
# separately; this script reflects each child's aggregate progress back into the
# umbrella leaf's status:
#
#   child not planned (no tasks / tasks still draft)  -> draft
#   child fully planned, nothing started               -> defined
#   child partially implemented (any completed/in-progress, not all done) -> in-progress
#   child fully implemented (all tasks completed)      -> completed
#
# Leaves that point at a normal spec (not a PRD.md) are left untouched, so it is
# safe to run on any PRD. Idempotent: run it at WorkPRD start, after each child
# slice, and whenever you want the umbrella to reflect reality.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/yq-compat.sh
source "${SCRIPT_DIR}/lib/yq-compat.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/sync-umbrella.sh <umbrella-prd-name>"
    echo ""
    echo "Recomputes the umbrella PRD's leaf statuses from its child PRDs' progress."
    echo "Returns a JSON summary of which leaves changed."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
PRD_DIR=".claude/prds/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "Error: Tasks file not found: $TASKS_FILE" >&2
    exit 1
fi

TASKS_JSON=$(yaml_to_json "$TASKS_FILE")

# Given a child PRD's tasks file, emit a JSON object with status counts plus the
# umbrella status the parent leaf should take.
compute_child_status() {
    local child_tasks="$1"
    local child_json="null"
    if [[ -f "$child_tasks" ]]; then
        child_json=$(yaml_to_json "$child_tasks" 2>/dev/null || echo "null")
    fi
    jq -n --argjson t "$child_json" '
        (if ($t | type) == "array" then $t else [] end) as $t
        | ([ ($t[] | select(.status)), ($t[] | .subtasks[]? | select(.status)) ]) as $all
        | ($all | map(select(.status == "draft"))       | length) as $draft
        | ($all | map(select(.status == "defined"))     | length) as $defined
        | ($all | map(select(.status == "in-progress")) | length) as $inprog
        | ($all | map(select(.status == "completed"))   | length) as $done
        | ($draft + $defined + $inprog + $done) as $total
        | {
            draft: $draft,
            defined: $defined,
            "in-progress": $inprog,
            completed: $done,
            total: $total,
            status: (
                if   $total == 0                       then "draft"
                elif $done == $total                   then "completed"
                elif ($done > 0 or $inprog > 0)        then "in-progress"
                elif $draft == 0                       then "defined"
                else "draft" end)
          }'
}

changes="[]"
synced=0
changed_count=0

while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    name=$(jq -r '.name' <<< "$row")
    spec=$(jq -r '.spec // empty' <<< "$row")
    cur=$(jq -r '.status' <<< "$row")

    # Only umbrella child references (spec points at a child PRD.md)
    [[ -n "$spec" && "$(basename "$spec")" == "PRD.md" ]] || continue

    spec_dir=$(dirname "$spec")
    child_name=$(basename "$spec_dir")
    child_tasks="${PRD_DIR}/${spec_dir}/tasks.yaml"

    child_info=$(compute_child_status "$child_tasks")
    new=$(jq -r '.status' <<< "$child_info")

    synced=$((synced + 1))
    is_changed="false"
    if [[ "$new" != "$cur" ]]; then
        "${SCRIPT_DIR}/update-task-status.sh" "$PRD_NAME" "$name" "$new" >/dev/null
        is_changed="true"
        changed_count=$((changed_count + 1))
    fi

    record=$(jq -n \
        --arg name "$name" \
        --arg child "$child_name" \
        --arg from "$cur" \
        --arg to "$new" \
        --argjson changed "$is_changed" \
        --argjson child_status "$child_info" \
        '{name: $name, child: $child, from: $from, to: $to, changed: $changed, child_status: $child_status}')
    changes=$(jq --argjson r "$record" '. += [$r]' <<< "$changes")
done < <(jq -c '
    [ ( .[] | select(.status) | {name, spec, status} ),
      ( .[] | .subtasks[]? | select(.status) | {name, spec, status} ) ] | .[]
' <<< "$TASKS_JSON")

jq -n \
    --arg prd "$PRD_NAME" \
    --argjson synced "$synced" \
    --argjson changed "$changed_count" \
    --argjson tasks "$changes" \
    '{prd: $prd, child_refs: $synced, changed: $changed, tasks: $tasks}'
