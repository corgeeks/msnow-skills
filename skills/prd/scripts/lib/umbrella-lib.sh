#!/usr/bin/env bash
# Shared helpers for umbrella PRDs.
#
# An umbrella PRD is a program tracker: each leaf's `spec` points at a CHILD PRD
# (a path ending in PRD.md, e.g. "../f0-combat-contract/PRD.md") rather than at a
# normal spec file under specs/. Top-level umbrella entries are dependency LEVELS
# (worked sequentially); subtasks within a level are slices that can proceed in
# PARALLEL. These functions are the single source of truth for detecting umbrella
# leaves, resolving them to child directories, and rolling each child's live
# progress back up.
#
# Assumes lib/yq-compat.sh and lib/prd-root.sh are already sourced (for
# `yaml_to_json` / `resolve_prd_root`) and that `jq` is available. All
# functions print to stdout; they never mutate any file.

# Roll a child PRD's tasks.yaml up into a status summary.
#   ul_child_status <child-tasks-file>
# Emits a JSON object with the per-status counts, the single umbrella `status`
# (the leaf status the parent should take), and the split `plan_status`
# (draft|planned) / `work_status` (needs-plan|ready|started|complete) labels the
# status board renders. A missing/empty child file rolls up as "draft".
ul_child_status() {
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
        | (if   $total == 0                       then "draft"
           elif $done == $total                   then "completed"
           elif ($done > 0 or $inprog > 0)        then "in-progress"
           elif $draft == 0                       then "defined"
           else "draft" end) as $status
        | {
            draft: $draft,
            defined: $defined,
            "in-progress": $inprog,
            completed: $done,
            total: $total,
            status: $status,
            plan_status: (if $status == "draft" then "draft" else "planned" end),
            work_status: (
                if   $status == "draft"       then "needs-plan"
                elif $status == "defined"     then "ready"
                elif $status == "in-progress" then "started"
                else "complete" end)
          }'
}

# Resolve an umbrella's leaves to their child PRDs.
#   ul_leaves <umbrella-tasks-json> <umbrella-prd-dir>
# Emits a JSON array, one object per umbrella leaf (a leaf whose spec ends in
# PRD.md), each carrying its dependency `level` (the 0-based top-level index, i.e.
# L0, L1, ...), the parent `level_name`, the stored leaf `status`, and the
# resolved `child_name` / `child_dir`. Non-umbrella leaves (specs under specs/)
# are filtered out, so the result is empty for a normal PRD.
ul_leaves() {
    local tasks_json="$1" prd_dir="$2"
    jq -c --arg dir "$prd_dir" '
        (if type == "array" then . else [] end)
        | [ to_entries[]
            | .key as $lvl
            | .value as $top
            | ($top.plan_after_prior // false) as $gate
            | ( if ($top | type) == "object" and ($top | has("subtasks"))
                then ($top.subtasks[] | {name, description, spec, status, level: $lvl, level_name: $top.name, plan_after_prior: $gate})
                else {name: $top.name, description: $top.description, spec: $top.spec, status: $top.status, level: $lvl, level_name: $top.name, plan_after_prior: $gate}
                end )
          ]
        | map(select((.spec // "") | endswith("PRD.md")))
        | map(. + {
            child_name: (.spec | sub("/PRD\\.md$"; "") | sub("^.*/"; "")),
            child_dir:  ($dir + "/" + (.spec | sub("/PRD\\.md$"; "")))
          })
    ' <<< "$tasks_json"
}

# Is this tasks JSON an umbrella (does it have any child-PRD leaf)?
#   ul_is_umbrella <umbrella-tasks-json> <prd-dir>   -> exit 0 if umbrella, else 1
ul_is_umbrella() {
    local n
    n=$(ul_leaves "$1" "$2" | jq 'length')
    [[ "${n:-0}" -gt 0 ]]
}

# Print the names of every umbrella PRD that references <child-prd-name> as a
# child leaf. Used to roll a child's status change back up to its parent(s).
#   ul_parent_umbrellas <child-prd-name>
# Assumes lib/prd-root.sh is already sourced (for `resolve_prd_root`).
ul_parent_umbrellas() {
    local child="$1"
    local prds_root
    prds_root="$(resolve_prd_root)"
    [[ -d "$prds_root" ]] || return 0
    local dir name tasks tj
    for dir in "$prds_root"/*/; do
        [[ -d "$dir" ]] || continue
        name=$(basename "$dir")
        [[ "$name" == "$child" ]] && continue
        tasks="${dir}tasks.yaml"
        [[ -f "$tasks" ]] || continue
        tj=$(yaml_to_json "$tasks" 2>/dev/null || echo "null")
        if jq -e --arg c "$child" '
            (if type == "array" then . else [] end)
            | [ .[]?, (.[]? | .subtasks[]?) ]
            | any(.[];
                  (.spec // "") as $s
                  | ($s | endswith("PRD.md"))
                    and (($s | sub("/PRD\\.md$"; "") | sub("^.*/"; "")) == $c))
        ' <<< "$tj" >/dev/null 2>&1; then
            printf '%s\n' "$name"
        fi
    done
}
