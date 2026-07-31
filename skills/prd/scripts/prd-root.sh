#!/usr/bin/env bash
# Prints the resolved PRD root directory for the current project (see
# lib/prd-root.sh for the resolution order). Used by the skill to decide
# whether to ask the user where PRDs should live (CreatePRD, step "Determine
# the PRD Root Directory") and by the sibling breakdown skill, which has no
# scripts of its own for this.

set -euo pipefail

# shellcheck source=lib/prd-root.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/prd-root.sh"

resolve_prd_root
