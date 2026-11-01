#!/usr/bin/env bash
#
# nmprune — find node_modules and .venv folders, show their sizes, delete some.
#
# Both are rebuilt by `npm install` / `uv sync`, so old projects' copies are
# usually the cheapest disk space to win back. Lists each with its size and how
# long ago the project itself was touched, biggest first.
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
${C_BOLD}nmprune${C_RESET} — reclaim space from node_modules and .venv folders

${C_BOLD}Usage:${C_RESET}
  nmprune [options] [dir]     (default dir: ~/projects)

${C_BOLD}Options:${C_RESET}
  -o, --older-than DAYS   Only list projects untouched for at least DAYS days
  -n, --dry-run           List only, never delete
  -y, --yes               Remove everything listed without prompting
      --rm                Delete permanently instead of moving to the Trash
  -h, --help              Show this help

"Untouched" is the newest modification time among the project's top-level
files, ignoring the dependency folder itself.
EOF
}

ROOT="$HOME/projects"
OLDER_THAN=0
DRY_RUN=false
ASSUME_YES=false
PERMANENT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o | --older-than)
      [[ ${2:-} =~ ^[0-9]+$ ]] || die "--older-than needs a number of days."
      OLDER_THAN="$2"
      shift
      ;;
    -n | --dry-run) DRY_RUN=true ;;
    -y | --yes) ASSUME_YES=true ;;
    --rm) PERMANENT=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      error "Unknown option: $1"
      usage >&2
      exit 1
      ;;
    *) ROOT="$1" ;;
  esac
  shift
done

[[ -d $ROOT ]] || die "Not a directory: $ROOT"
ROOT="$(cd "$ROOT" && pwd -P)"

mtime() { command stat -f %m "$1" 2>/dev/null || command stat -c %Y "$1"; }

# last_touched DEPS_DIR — newest mtime among the project's top-level entries.
last_touched() {
  local deps="$1" parent newest=0 m entry
  parent="$(dirname "$deps")"
  for entry in "$parent"/* "$parent"/.[!.]*; do
    [[ -e $entry && $entry != "$deps" ]] || continue
    m="$(mtime "$entry")"
    [[ $m -gt $newest ]] && newest=$m
  done
  [[ $newest -eq 0 ]] && newest="$(mtime "$parent")"
  printf '%s' "$newest"
}

ago() {
  local days="$1"
  if [[ $days -lt 1 ]]; then
    printf 'today'
  elif [[ $days -lt 14 ]]; then
    printf '%dd' "$days"
  elif [[ $days -lt 60 ]]; then
    printf '%dw' $((days / 7))
  elif [[ $days -lt 730 ]]; then
    printf '%dmo' $((days / 30))
  else
    printf '%dy' $((days / 365))
  fi
}

# ----- Scan -----------------------------------------------------------------

heading "Scanning $(tildify "$ROOT") for node_modules and .venv" "🔍"

work="$(mktemp -d -t nmprune)"
trap 'rm -rf "$work"' EXIT

# .git holds nothing relevant; .next has its own build-time node_modules.
find "$ROOT" \( -name .git -o -name .next \) -prune -o \
  \( -name node_modules -o -name .venv \) -type d -prune -print0 \
  2>/dev/null >"$work/dirs"

count="$(tr -cd '\0' <"$work/dirs" | wc -c | tr -d ' ')"
if [[ $count -eq 0 ]]; then
  success "Nothing to prune: no node_modules or .venv folders found."
  exit 0
fi

# shellcheck disable=SC2016  # $1 and $2 belong to the inner sh
run_with_spinner "Measuring $count folder(s)" sh -c \
  'xargs -0 -P 8 -n 8 du -sk <"$1" >"$2" 2>/dev/null; true' \
  _ "$work/dirs" "$work/sizes"

# Hide folders under 1 MB (nothing to win), ones committed to git (vendored
# code, not a disposable install), and, with --older-than, recent projects.
now="$(date +%s)"
small=0
tracked=0
recent=0
while IFS=$'\t' read -r kb path; do
  if [[ $kb -lt 1024 ]]; then
    small=$((small + 1))
    continue
  fi
  if [[ -n "$(git -C "$(dirname "$path")" ls-files -- "$(basename "$path")" 2>/dev/null | head -n 1)" ]]; then
    tracked=$((tracked + 1))
    continue
  fi
  days=$(((now - $(last_touched "$path")) / 86400))
  if [[ $days -lt $OLDER_THAN ]]; then
    recent=$((recent + 1))
    continue
  fi
  printf '%s\t%s\t%s\n' "$kb" "$days" "$path"
done <"$work/sizes" >"$work/unsorted"
sort -t $'\t' -k1,1nr "$work/unsorted" >"$work/rows"

paths=()
sizes=()
labels=()
total=0
while IFS=$'\t' read -r kb days path; do
  paths+=("$path")
  sizes+=("$kb")
  total=$((total + kb))
  labels+=("$(printf '%7s  %5s  %s' "$(human_kb "$kb")" "$(ago "$days")" "$(tildify "$path")")")
done <"$work/rows"

hidden=()
[[ $recent -gt 0 ]] && hidden+=("$recent touched in the last $OLDER_THAN days")
[[ $tracked -gt 0 ]] && hidden+=("$tracked committed to git")
[[ $small -gt 0 ]] && hidden+=("$small under 1 MB")
hidden_note=""
if [[ ${#hidden[@]} -gt 0 ]]; then
  hidden_note="$(printf '%s, ' "${hidden[@]}")"
  hidden_note="Hidden: ${hidden_note%, }."
fi

if [[ ${#paths[@]} -eq 0 ]]; then
  success "Nothing worth pruning. ${hidden_note}"
  exit 0
fi

stat "$(human_kb "$total") across ${#paths[@]} folder(s)" "Found"
[[ -n $hidden_note ]] && dim "  $hidden_note"

if $DRY_RUN || $ASSUME_YES; then
  printf '\n%s     size    age  folder%s\n' "$C_DIM" "$C_RESET"
  printf '  %s\n' "${labels[@]}"
  if $DRY_RUN; then
    printf '\n'
    dim "Dry run: nothing removed."
    exit 0
  fi
fi

# ----- Choose ---------------------------------------------------------------

chosen=()
if $ASSUME_YES; then
  chosen=("${!paths[@]}")
else
  printf '\n'
  multi_select "Select folders to remove (space toggles, a = all, Enter confirms)" "${labels[@]}"
  chosen=(${MULTI_SELECTED[@]+"${MULTI_SELECTED[@]}"})
fi

if [[ ${#chosen[@]} -eq 0 ]]; then
  dim "Nothing selected."
  exit 0
fi

targets=()
freed=0
for i in "${chosen[@]}"; do
  targets+=("${paths[$i]}")
  freed=$((freed + sizes[i]))
done

verb="Move"
dest=" to the Trash"
if $PERMANENT; then
  verb="Permanently delete"
  dest=""
fi

if ! $ASSUME_YES; then
  printf '\n'
  confirm "$verb ${#targets[@]} folder(s) ($(human_kb "$freed"))$dest?" n || {
    dim "Nothing removed."
    exit 0
  }
fi

# ----- Remove ---------------------------------------------------------------

if discard_paths "$PERMANENT" "${targets[@]}"; then
  if $PERMANENT; then
    success "Freed $(human_kb "$freed")." "🗑️ "
  else
    success "Moved $(human_kb "$freed") to the Trash. Empty it to free the space." "🗑️ "
  fi
  dim "  Restore a project's dependencies with npm install or uv sync."
else
  exit 1
fi
