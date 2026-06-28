#!/usr/bin/env bash
# PostToolUse hook: keep umbrella PRDs in sync when a child's tasks.yaml is edited.
#
# Optional. `npx skills install` does NOT register this automatically — wire it
# into your settings.json to keep umbrella leaf statuses fresh on every manual
# Edit/Write to a child's tasks.yaml (see the repository README). The prd scripts
# already roll status changes up at their source (update-task-status.sh), so this
# hook only matters for tasks.yaml edited by hand / by another tool. Never blocks.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# shellcheck source=../scripts/lib/yq-compat.sh
source "${SKILL_ROOT}/scripts/lib/yq-compat.sh"
# shellcheck source=../scripts/lib/umbrella-lib.sh
source "${SKILL_ROOT}/scripts/lib/umbrella-lib.sh"

# Missing tools should not block Claude — degrade gracefully.
for dep in jq yq; do
    if ! command -v "$dep" &>/dev/null; then
        echo "sync-umbrellas hook: missing dependency '$dep'; skipping." >&2
        exit 0
    fi
done

INPUT=$(cat)
FILE_PATH=$(jq -r '.tool_input.file_path // empty' <<< "$INPUT")

[[ -z "$FILE_PATH" ]] && exit 0
# Only react to a tasks.yaml under a PRD directory.
[[ ! "$FILE_PATH" =~ \.claude/prds/([^/]+)/tasks\.yaml$ ]] && exit 0
CHILD="${BASH_REMATCH[1]}"

# Roll this PRD's progress up into any umbrella that owns it as a child slice.
while IFS= read -r parent; do
    [[ -z "$parent" ]] && continue
    echo "sync-umbrellas hook: syncing umbrella '$parent' after edit to '$CHILD'." >&2
    "${SKILL_ROOT}/scripts/sync-umbrella.sh" "$parent" >/dev/null 2>&1 || true
done < <(ul_parent_umbrellas "$CHILD")

exit 0
