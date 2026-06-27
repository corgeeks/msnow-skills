#!/usr/bin/env bash
# Validate a PRD's tasks.yaml and research.yaml against the schemas, and confirm
# every task past the draft stage has an existing spec file.
#
# This is the in-workflow validator: workflows call it after writing tasks.yaml /
# research.yaml so a plain `npx skills install` (which does NOT auto-register the
# PostToolUse hooks) still gets validation. The hooks under hooks/ enforce the
# same rules automatically on every edit if you wire them into settings.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=lib/yq-compat.sh
source "${SCRIPT_DIR}/lib/yq-compat.sh"
# shellcheck source=lib/validate-lib.sh
source "${SCRIPT_DIR}/lib/validate-lib.sh"

usage() {
    echo "Usage: scripts/validate-prd.sh <prd-name>"
    echo ""
    echo "Validates .claude/prds/<prd-name>/{tasks,research}.yaml against the schemas"
    echo "and checks that defined/in-progress/completed tasks have spec files."
    exit 1
}

[[ $# -lt 1 ]] && usage

# Dependencies are fatal here (unlike the hooks, which degrade gracefully).
require_yaml_tools || exit 1
if ! command -v check-jsonschema &>/dev/null; then
    echo "Error: check-jsonschema not found. Install it with: pip install check-jsonschema" >&2
    exit 1
fi

PRD_NAME="$1"
PRD_DIR=".claude/prds/${PRD_NAME}"
TASKS_FILE="${PRD_DIR}/tasks.yaml"
RESEARCH_FILE="${PRD_DIR}/research.yaml"
TASKS_SCHEMA="${SKILL_ROOT}/schemas/tasks.schema.json"
RESEARCH_SCHEMA="${SKILL_ROOT}/schemas/research.schema.json"

if [[ ! -d "$PRD_DIR" ]]; then
    echo "Error: PRD directory not found: $PRD_DIR" >&2
    exit 1
fi

FAILED=0
CHECKED=0

if [[ -f "$TASKS_FILE" ]]; then
    CHECKED=$((CHECKED + 1))
    vl_check_schema "$TASKS_SCHEMA" "$TASKS_FILE" || FAILED=1
    vl_check_task_specs "$TASKS_FILE" || FAILED=1
fi

if [[ -f "$RESEARCH_FILE" ]]; then
    CHECKED=$((CHECKED + 1))
    vl_check_schema "$RESEARCH_SCHEMA" "$RESEARCH_FILE" || FAILED=1
fi

if [[ "$CHECKED" -eq 0 ]]; then
    echo "Nothing to validate (no tasks.yaml or research.yaml in $PRD_DIR)."
    exit 0
fi

if [[ "$FAILED" -ne 0 ]]; then
    echo "PRD '$PRD_NAME' is INVALID — fix the errors above." >&2
    exit 1
fi

echo "PRD '$PRD_NAME' is valid."
