#!/usr/bin/env bash
# Status board for an umbrella PRD.
#
# For each child PRD the umbrella tracks, reports its dependency level (L0, L1,
# ...), its plan status (draft|planned) and its work status
# (needs-scaffold|needs-plan|ready|started|complete) — all computed LIVE from each
# child's own tasks.yaml, so the board is accurate even if sync-umbrella.sh has
# not been run. Read-only: it never mutates any file.
#
# This is the data behind the table the prd skill shows when you plan or work an
# umbrella (render it as | Level | PRD | Plan | Work |). The `next_plan_level` and
# `next_work_level` pointers identify the next dependency level to act on, so
# "plan the next one" / "work the next one" need no hand computation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/yq-compat.sh
source "${SCRIPT_DIR}/lib/yq-compat.sh"
# shellcheck source=lib/umbrella-lib.sh
source "${SCRIPT_DIR}/lib/umbrella-lib.sh"
# shellcheck source=lib/prd-root.sh
source "${SCRIPT_DIR}/lib/prd-root.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/umbrella-status.sh <umbrella-prd-name>"
    echo ""
    echo "Returns a JSON status board (per-child plan/work status grouped by"
    echo "dependency level) for an umbrella PRD. Read-only."
    exit 1
}

[[ $# -lt 1 ]] && usage

PRD_NAME="$1"
PRD_DIR="$(resolve_prd_root)/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"

if [[ ! -f "$TASKS_FILE" ]]; then
    echo "Error: Tasks file not found: $TASKS_FILE" >&2
    exit 1
fi

TASKS_JSON=$(yaml_to_json "$TASKS_FILE")
LEAVES=$(ul_leaves "$TASKS_JSON" "$PRD_DIR")

if [[ "$(jq 'length' <<< "$LEAVES")" -eq 0 ]]; then
    echo "Error: '$PRD_NAME' is not an umbrella PRD (no leaf points at a child PRD.md)." >&2
    echo "Use scripts/task-status.sh for an ordinary PRD." >&2
    exit 2
fi

# Build one row per child: merge its leaf metadata with its live rollup. The plan
# column is resolved in the final jq pass, where the cross-level dependency view
# (which earlier levels are implemented) is available.
rows="[]"
while IFS= read -r leaf; do
    [[ -z "$leaf" ]] && continue
    child_dir=$(jq -r '.child_dir' <<< "$leaf")
    child_tasks="${child_dir}/tasks.yaml"
    prd_exists="false"
    [[ -f "${child_dir}/PRD.md" ]] && prd_exists="true"

    cs=$(ul_child_status "$child_tasks")

    row=$(jq -n --argjson leaf "$leaf" --argjson cs "$cs" --argjson pe "$prd_exists" '{
        level: $leaf.level,
        level_name: $leaf.level_name,
        prd: $leaf.child_name,
        leaf_status: $leaf.status,
        planned: ($cs.plan_status == "planned"),
        plan_after_prior: ($leaf.plan_after_prior // false),
        work_status: (if ($pe | not) and $cs.total == 0 then "needs-scaffold" else $cs.work_status end),
        child_prd_exists: $pe,
        counts: {
            draft: $cs.draft, defined: $cs.defined,
            "in-progress": $cs."in-progress", completed: $cs.completed, total: $cs.total
        }
    }')
    rows=$(jq --argjson r "$row" '. += [$r]' <<< "$rows")
done < <(jq -c '.[]' <<< "$LEAVES")

jq -n --arg prd "$PRD_NAME" --argjson rows "$rows" '
    # Levels in dependency order, each with its implementation completeness.
    ($rows | sort_by(.level) | group_by(.level) | map({
        level: .[0].level,
        name: .[0].level_name,
        plan_after_prior: (.[0].plan_after_prior // false),
        children: .,
        work_complete: all(.[]; .work_status == "complete")
    })) as $lv0
    # Tag each level with whether ALL earlier levels are implemented (prior_complete).
    | ($lv0 | to_entries | map(.value + {
        prior_complete: ([ $lv0[0:.key][] | .work_complete ] | all)
      })) as $levels
    # Resolve each child''s plan_status:
    #   planned        -> already has defined tasks
    #   requires-work  -> unplanned, level is plan_after_prior, earlier level(s) not yet implemented
    #   ready-to-plan  -> unplanned and plannable now
    | ([ $levels[] | .prior_complete as $pc | .children[] | . + {
        plan_status: (
            if .planned then "planned"
            elif (.plan_after_prior and ($pc | not)) then "requires-work"
            else "ready-to-plan" end)
      }]) as $children
    | ($levels | map(. as $L | {
        level: $L.level,
        name: $L.name,
        plan_after_prior: $L.plan_after_prior,
        prior_complete: $L.prior_complete,
        children: [ $children[] | select(.level == $L.level) ],
        plan_complete: all($L.children[]; .planned),
        work_complete: $L.work_complete
      })) as $levelsOut
    | {
        prd: $prd,
        children: $children,
        levels: $levelsOut,
        summary: {
            children: ($children | length),
            levels: ($levelsOut | length),
            planned:       ($children | map(select(.plan_status == "planned"))       | length),
            ready_to_plan: ($children | map(select(.plan_status == "ready-to-plan")) | length),
            requires_work: ($children | map(select(.plan_status == "requires-work")) | length),
            ready:    ($children | map(select(.work_status == "ready"))    | length),
            started:  ($children | map(select(.work_status == "started"))  | length),
            complete: ($children | map(select(.work_status == "complete")) | length)
        },
        next_plan_level: (
            [ $levelsOut[] | select(any(.children[]; .plan_status == "ready-to-plan")) ] | (.[0] // null)
            | if . == null then null
              else {level: .level, name: .name,
                    children: (.children | map(select(.plan_status == "ready-to-plan")) | map(.prd))}
              end),
        blocked_plan_levels: [
            $levelsOut[]
            | select(any(.children[]; .plan_status == "requires-work"))
            | . as $bl
            | {level: $bl.level, name: $bl.name,
               children: ($bl.children | map(select(.plan_status == "requires-work")) | map(.prd)),
               waiting_on: [ $levelsOut[] | select(.level < $bl.level and (.work_complete | not)) | {level: .level, name: .name} ]}
        ],
        next_work_level: (
            [ $levelsOut[] | select(.work_complete | not) ] | (.[0] // null)
            | if . == null then null
              else {level: .level, name: .name,
                    ready:   (.children | map(select(.work_status == "ready"))   | map(.prd)),
                    started: (.children | map(select(.work_status == "started")) | map(.prd)),
                    needs_plan: (.children | map(select(.work_status == "needs-plan" or .work_status == "needs-scaffold")) | map(.prd))}
              end)
      }'
