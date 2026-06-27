#!/usr/bin/env bash
# PostToolUse hook: validate a research.yaml file after it is edited.
#
# Optional. `npx skills install` does NOT register this automatically — wire it
# into your settings.json to enforce validation on every Edit/Write (see the
# repository README). The in-workflow validator scripts/validate-prd.sh runs the
# same check without any settings wiring.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SCHEMA_PATH="${SKILL_ROOT}/schemas/research.schema.json"

# shellcheck source=../scripts/lib/validate-lib.sh
source "${SKILL_ROOT}/scripts/lib/validate-lib.sh"

# Missing tools should not block Claude — degrade gracefully.
for dep in jq check-jsonschema; do
    if ! command -v "$dep" &>/dev/null; then
        echo "validate-research hook: missing dependency '$dep'; skipping validation." >&2
        exit 0
    fi
done

INPUT=$(cat)
FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<< "$INPUT")

[[ -z "$FILE_PATH" ]] && exit 0
[[ ! "$FILE_PATH" =~ research\.yaml$ ]] && exit 0
[[ ! -f "$FILE_PATH" ]] && { echo "File not found: $FILE_PATH" >&2; exit 0; }

echo "Validating: $FILE_PATH" >&2

if ERR=$(vl_check_schema "$SCHEMA_PATH" "$FILE_PATH"); then
    echo "OK" >&2
    exit 0
fi

jq -n --arg reason "${ERR}"$'\n'"Please fix the research.yaml structure before proceeding." \
    '{decision: "block", reason: $reason}'
exit 0
