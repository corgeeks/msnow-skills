#!/usr/bin/env bash
# Returns JSON array of unanswered research questions for a PRD

set -euo pipefail

# shellcheck source=lib/yq-compat.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/yq-compat.sh"

# Check dependencies (supports either Go or Python yq)
require_yaml_tools || exit 1

usage() {
    echo "Usage: scripts/get-unanswered-research.sh <prd-name>"
    echo ""
    echo "Returns JSON array of unanswered research questions."
    echo "Each question includes 'text' and 'mode' fields."
    exit 1
}

if [[ $# -lt 1 ]]; then
    usage
fi

PRD_NAME="$1"
RESEARCH_FILE=".claude/prds/${PRD_NAME}/research.yaml"

if [[ ! -f "$RESEARCH_FILE" ]]; then
    echo "Error: Research file not found: $RESEARCH_FILE" >&2
    exit 1
fi

# Get questions without answers
yaml_to_json "$RESEARCH_FILE" | jq '
    [.[] | select(.answer == null or .answer == "") | {
        "text": .text,
        "mode": .mode
    }]
'
