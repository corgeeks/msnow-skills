#!/usr/bin/env bash
# yq compatibility layer
#
# Two incompatible programs are both commonly installed as `yq`:
#   - Go yq    (mikefarah/yq):  https://github.com/mikefarah/yq   -- own expression language
#   - Python yq (kislyuk/yq):   https://github.com/kislyuk/yq     -- a jq wrapper for YAML
#
# Rather than demanding one, this layer detects which is present and exposes a
# small, uniform API the rest of the scripts use. The guiding idea: use yq ONLY
# to transcode YAML <-> JSON, and do all querying with jq (always required, and
# identical across platforms). The single in-place mutation is branched per flavor
# so it preserves the file's native YAML formatting where the tool allows.
#
# Source this file, then call:
#   yq_detect            -> echoes "go" or "python" (also caches in $YQ_FLAVOR)
#   require_yaml_tools   -> exits non-zero with a helpful message if yq/jq missing
#   yaml_to_json FILE    -> prints the YAML file as JSON on stdout (pipe into jq)
#   yaml_set_status FILE NAME STATUS  -> in-place set .status for the leaf/subtask named NAME

# Detect the installed yq flavor. Result is cached in YQ_FLAVOR for the session.
yq_detect() {
    if [[ -n "${YQ_FLAVOR:-}" ]]; then
        printf '%s\n' "$YQ_FLAVOR"
        return 0
    fi

    local version
    version="$(yq --version 2>&1 || true)"

    if printf '%s' "$version" | grep -qi 'mikefarah'; then
        YQ_FLAVOR="go"
    elif printf '%s' "$version" | grep -qiE 'kislyuk|^yq [0-9]'; then
        YQ_FLAVOR="python"
    else
        # Unknown version banner: probe behavior. Only Go yq accepts -o=json.
        if printf 'a: 1\n' | yq -o=json '.' >/dev/null 2>&1; then
            YQ_FLAVOR="go"
        else
            YQ_FLAVOR="python"
        fi
    fi

    export YQ_FLAVOR
    printf '%s\n' "$YQ_FLAVOR"
}

# Verify the YAML toolchain is present. Callers decide whether a missing tool is
# fatal (scripts: exit 1) or should degrade gracefully (hooks: exit 0).
require_yaml_tools() {
    local missing=()
    command -v yq &>/dev/null || missing+=("yq")
    command -v jq &>/dev/null || missing+=("jq")
    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Error: Required dependencies not found: ${missing[*]}" >&2
        echo "Install jq and either Go yq (mikefarah) or Python yq (kislyuk)." >&2
        return 1
    fi
    yq_detect >/dev/null
    return 0
}

# Print a YAML file as JSON on stdout. All querying is then done with jq, so the
# query language is uniform regardless of which yq is installed.
yaml_to_json() {
    local file="$1"
    case "$(yq_detect)" in
        go)     yq -o=json '.' "$file" ;;
        python) yq '.' "$file" ;;        # kislyuk yq emits JSON by default
    esac
}

# Set the `status` of the leaf task (or subtask) named "$2" to "$3", in place.
#
# Matches both top-level leaf tasks (objects that have a `status`) and subtasks.
# Go yq preserves comments and formatting; Python yq round-trips through JSON and
# therefore DROPS comments (documented limitation -- keep prose in PRD.md, not
# tasks.yaml comments, if you rely on the Python wrapper).
yaml_set_status() {
    local file="$1" name="$2" status="$3"
    case "$(yq_detect)" in
        go)
            TASK_NAME="$name" NEW_STATUS="$status" yq -i '
                (.[] | select(.name == strenv(TASK_NAME)) | select(has("status")) | .status) = strenv(NEW_STATUS) |
                (.[] | select(has("subtasks")) | .subtasks[] | select(.name == strenv(TASK_NAME)) | .status) = strenv(NEW_STATUS)
            ' "$file"
            ;;
        python)
            yq -y -i --arg name "$name" --arg status "$status" '
                (.[] | select(.name == $name and .status) | .status) = $status |
                (.[] | select(.subtasks) | .subtasks[] | select(.name == $name) | .status) = $status
            ' "$file"
            ;;
    esac
}
