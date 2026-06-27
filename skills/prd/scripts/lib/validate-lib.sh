#!/usr/bin/env bash
# Shared validation logic for tasks.yaml / research.yaml.
#
# Both the callable validator (scripts/validate-prd.sh) and the optional
# PostToolUse hooks (hooks/validate-*.sh) source this file so they enforce
# exactly the same rules. All functions print human-readable errors to stdout
# and return 0 (valid) or 1 (invalid). They assume yq-compat.sh is already
# sourced (for `yaml_to_json`) and that `jq` / `check-jsonschema` exist — callers
# decide how to handle missing tools (scripts: fatal; hooks: degrade gracefully).

# Validate a YAML file against a JSON schema using check-jsonschema.
#   vl_check_schema <schema_path> <yaml_file>
vl_check_schema() {
    local schema="$1" file="$2" out
    if out=$(check-jsonschema --schemafile "$schema" "$file" 2>&1); then
        return 0
    fi
    printf 'Schema validation failed for %s:\n%s\n' "$file" "$out"
    return 1
}

# Verify every task past the draft stage has an existing spec file. For umbrella
# PRDs the spec points at a child PRD.md, which must also exist once referenced.
#   vl_check_task_specs <tasks_file>
# Resolves spec paths relative to the tasks file's directory (the PRD directory).
vl_check_task_specs() {
    local file="$1"
    local prd_dir errors="" task name status spec full
    prd_dir=$(dirname "$file")

    local spec_tasks
    spec_tasks=$(yaml_to_json "$file" 2>/dev/null | jq '
        def beyond_draft: (.status == "defined" or .status == "in-progress" or .status == "completed");
        [
            ( .[] | select(beyond_draft) | {name, status, spec} ),
            ( .[] | .subtasks[]? | select(beyond_draft) | {name, status, spec} )
        ]
    ' 2>/dev/null || echo "[]")

    [[ "$spec_tasks" == "[]" || -z "$spec_tasks" ]] && return 0

    while IFS= read -r task; do
        [[ -z "$task" ]] && continue
        name=$(jq -r '.name' <<< "$task")
        status=$(jq -r '.status' <<< "$task")
        spec=$(jq -r '.spec // empty' <<< "$task")
        [[ -z "$spec" ]] && continue
        full="${prd_dir}/${spec}"
        if [[ ! -f "$full" ]]; then
            errors="${errors}Task '${name}' has status '${status}' but spec file not found: ${full}\n"
        fi
    done < <(jq -c '.[]' <<< "$spec_tasks")

    if [[ -n "$errors" ]]; then
        printf '%b' "$errors"
        return 1
    fi
    return 0
}
