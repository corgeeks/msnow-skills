#!/usr/bin/env bash
# Resolves the project's PRD root directory — the directory PRDs live under,
# e.g. "docs/prd/<name>/". Not every project uses Claude, so this is a plain,
# visible directory by default rather than something hidden inside `.claude/`.
#
# Resolution order (first match wins), relative to the current working
# directory (the user's project root):
#   1. $PRD_ROOT_DIR env var          - explicit override for one invocation
#   2. .claude/prd-root               - the path a user picked when first
#                                        asked (see workflows/CreatePRD.md);
#                                        a plain text file, one line, no
#                                        trailing whitespace requirements
#   3. .claude/prds/ if it exists     - legacy default from before this file
#                                        existed; keeps old installs working
#                                        without a migration step
#   4. docs/prd                       - default for a project that has never
#                                        used this skill before
#
# Source this file, then call:
#   resolve_prd_root   -> prints the resolved root directory (relative path)

resolve_prd_root() {
    if [[ -n "${PRD_ROOT_DIR:-}" ]]; then
        printf '%s\n' "$PRD_ROOT_DIR"
        return
    fi

    local config_file=".claude/prd-root"
    if [[ -f "$config_file" ]]; then
        local configured
        configured="$(tr -d '[:space:]' < "$config_file")"
        if [[ -n "$configured" ]]; then
            printf '%s\n' "$configured"
            return
        fi
    fi

    if [[ -d ".claude/prds" ]]; then
        printf '%s\n' ".claude/prds"
        return
    fi

    printf '%s\n' "docs/prd"
}
