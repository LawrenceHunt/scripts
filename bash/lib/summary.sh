#!/usr/bin/env bash
# summary.sh — shared plumbing for the *-summary composition tools.
#
# Source after common.sh, with REPO_DIR set to the repo root.

# summarise_with_speech STEM SOURCE_TOOL [SOURCE_ARGS...] -- [summarise args...]
#
# Runs `SOURCE_TOOL SOURCE_ARGS... | summarise args...`, streaming the summary to
# stdout. If the args include --speak, that flag is removed, the summary is
# also saved and voiced with `speak --play`, and the mp3 is written to
# ./STEM-<timestamp>.mp3.
summarise_with_speech() {
  : "${REPO_DIR:?summary.sh: set REPO_DIR before calling summarise_with_speech}"
  local stem="$1" source_tool="$2"
  shift 2
  local source_args=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do
    source_args+=("$1")
    shift
  done
  [[ "${1:-}" == "--" ]] && shift

  local speak=false arg
  local args=()
  for arg in "$@"; do
    if [[ "$arg" == "--speak" ]]; then speak=true; else args+=("$arg"); fi
  done

  if ! $speak; then
    "$source_tool" "${source_args[@]}" | "$REPO_DIR/python/ai/summarise.py" ${args[@]+"${args[@]}"}
    return
  fi

  local summary_file
  summary_file="$(mktemp -t "${stem}.XXXXXX")"
  # shellcheck disable=SC2064  # expand now: the path is fixed
  trap "rm -f '$summary_file'" EXIT

  "$source_tool" "${source_args[@]}" |
    "$REPO_DIR/python/ai/summarise.py" ${args[@]+"${args[@]}"} |
    tee "$summary_file"
  "$REPO_DIR/python/ai/speak.py" "$summary_file" --play -o "./${stem}-$(date +%Y%m%d-%H%M%S).mp3"
}
