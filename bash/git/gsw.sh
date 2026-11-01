#!/usr/bin/env bash
#
# gsw — switch git branches with a fuzzy finder, most recently committed first.
#
# Type to filter by branch name or last commit message. With a query argument,
# a single match switches straight away.
#
set -euo pipefail

# --- resolve real path (run via symlink) and load shared helpers ------------
SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
REAL_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$REAL_DIR/../lib/common.sh"

usage() {
  cat <<EOF
${C_BOLD}gsw${C_RESET} — switch git branches with a fuzzy finder

${C_BOLD}Usage:${C_RESET}
  gsw [options] [query]

${C_BOLD}Options:${C_RESET}
  -r, --remote     Also list remote branches with no local copy (switching
                   creates a local tracking branch)
  -h, --help       Show this help

${C_BOLD}Examples:${C_RESET}
  gsw              pick from local branches, most recent first
  gsw auth         switch straight to the only branch matching "auth",
                   or open the picker filtered to "auth"
  gsw -            back to the previous branch
EOF
}

INCLUDE_REMOTE=false
QUERY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -r | --remote) INCLUDE_REMOTE=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    -) QUERY="-" ;;
    -*)
      error "Unknown option: $1"
      usage >&2
      exit 1
      ;;
    *) QUERY="$1" ;;
  esac
  shift
done

require_cmd git
git rev-parse --git-dir >/dev/null 2>&1 || die "Not inside a git repository."

if [[ $QUERY == "-" ]]; then
  exec git switch -
fi

current="$(git branch --show-current)"

refs=(refs/heads)
$INCLUDE_REMOTE && refs+=(refs/remotes)

# Local branch names, newline-delimited, to hide remotes that are already local.
locals=$'\n'"$(git for-each-ref --format='%(refname:short)' refs/heads)"$'\n'

names=()
kinds=()
dates=()
subjects=()
while IFS=$'\t' read -r ref name date subject; do
  [[ $name == "$current" ]] && continue
  if [[ $ref == refs/remotes/* ]]; then
    [[ $ref == */HEAD ]] && continue
    [[ $locals == *$'\n'"${name#*/}"$'\n'* ]] && continue
    kinds+=(remote)
  else
    kinds+=(local)
  fi
  names+=("$name")
  dates+=("$date")
  subjects+=("$subject")
done < <(git for-each-ref --sort=-committerdate \
  --format='%(refname)%09%(refname:short)%09%(committerdate:relative)%09%(subject)' \
  "${refs[@]}")

if [[ ${#names[@]} -eq 0 ]]; then
  info "No other branches${current:+ besides ${C_BOLD}$current${C_RESET}}." "🌿"
  $INCLUDE_REMOTE || dim "  gsw --remote also lists remote branches."
  exit 0
fi

switch_to() {
  local i="$1"
  if [[ ${kinds[$i]} == remote ]]; then
    git switch --track "${names[$i]}"
  else
    git switch "${names[$i]}"
  fi
}

# A query that matches exactly one branch name switches without asking.
if [[ -n $QUERY ]]; then
  shopt -s nocasematch
  matches=()
  for i in "${!names[@]}"; do
    [[ ${names[$i]} == *"$QUERY"* ]] && matches+=("$i")
  done
  shopt -u nocasematch
  if [[ ${#matches[@]} -eq 1 ]]; then
    switch_to "${matches[0]}"
    exit
  fi
fi

# Picker labels: name, age and subject in aligned columns.
width=0
for name in "${names[@]}"; do
  [[ ${#name} -gt $width ]] && width=${#name}
done
[[ $width -gt 40 ]] && width=40

labels=()
for i in "${!names[@]}"; do
  labels+=("$(printf '%-*.*s  %-14s  %.60s' "$width" "$width" "${names[$i]}" \
    "${dates[$i]}" "${subjects[$i]}")")
done

filter_menu "🌿 On ${current:-a detached HEAD} — switch to:" "$QUERY" "${labels[@]}"
if [[ $MENU_INDEX -lt 0 ]]; then
  dim "No branch chosen."
  exit 0
fi
switch_to "$MENU_INDEX"
