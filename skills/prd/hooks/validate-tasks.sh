#!/usr/bin/env bash
# PostToolUse hook: validate a tasks.yaml file after it is edited.
#
# Optional. `npx skills install` does NOT register this automatically — wire it
# into your settings.json to enforce validation on every Edit/Write (see the
# repository README). The in-workflow validator scripts/validate-prd.sh runs the
# same checks (lib/validate-lib.sh) without any settings wiring.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCHEMA_PATH="${SKILL_ROOT}/schemas/tasks.schema.json"

# shellcheck source=../scripts/lib/yq-compat.sh
source "${SKILL_ROOT}/scripts/lib/yq-compat.sh"
# shellcheck source=../scripts/lib/validate-lib.sh
source "${SKILL_ROOT}/scripts/lib/validate-lib.sh"

# Missing tools should not block Claude — degrade gracefully.
for dep in jq yq check-jsonschema; do
    if ! command -v "$dep" &>/dev/null; then
        echo "validate-tasks hook: missing dependency '$dep'; skipping validation." >&2
        exit 0
    fi
done

INPUT=$(cat)
FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<< "$INPUT")

[[ -z "$FILE_PATH" ]] && exit 0
# Only validate tasks.yaml files under a PRD directory
[[ ! "$FILE_PATH" =~ \.claude/prds/.*/tasks\.yaml$ ]] && exit 0
[[ ! -f "$FILE_PATH" ]] && { echo "File not found: $FILE_PATH" >&2; exit 0; }

echo "Validating: $FILE_PATH" >&2

ERRORS=""
SCHEMA_ERR=$(vl_check_schema "$SCHEMA_PATH" "$FILE_PATH") || ERRORS="${ERRORS}${SCHEMA_ERR}\n"
SPEC_ERR=$(vl_check_task_specs "$FILE_PATH") || ERRORS="${ERRORS}${SPEC_ERR}\n"

if [[ -n "$ERRORS" ]]; then
    jq -n --arg reason "$(printf '%b' "$ERRORS")Please fix the tasks.yaml structure before proceeding." \
        '{decision: "block", reason: $reason}'
    exit 0
fi

echo "OK" >&2
exit 0
