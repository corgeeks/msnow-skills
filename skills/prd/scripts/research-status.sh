#!/usr/bin/env bash
# Returns JSON describing research question status for a PRD

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/research-status.sh <prd-name>"
    echo ""
    echo "Returns JSON with research question counts: draft, complete, and total."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
RESEARCH_FILE=".claude/prds/${PRD_NAME}/research.yaml"

if [[ ! -f "$RESEARCH_FILE" ]]; then
    # No research file - return zeros
    jq -n '{
        "draft": 0,
        "complete": 0,
        "total": 0
    }'
    exit 0
fi

# Transcode once, count with jq
RESEARCH_JSON=$(yaml_to_json "$RESEARCH_FILE")

# Count questions by status
# Draft = no answer or empty answer
draft=$(jq '
    [.[] | select(.answer == null or .answer == "")] | length
' <<< "$RESEARCH_JSON")

# Complete = has an answer
complete=$(jq '
    [.[] | select(.answer != null and .answer != "")] | length
' <<< "$RESEARCH_JSON")

total=$((draft + complete))

jq -n \
    --argjson draft "$draft" \
    --argjson complete "$complete" \
    --argjson total "$total" \
    '{
        "draft": $draft,
        "complete": $complete,
        "total": $total
    }'
