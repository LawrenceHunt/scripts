#!/usr/bin/env bash
#
# space — see what is using disk space, biggest first, and delete from a menu.
#
# Lists a folder's contents by size. Pick a folder to go into it, or choose
# "Delete items here…" to tick several and send them to the Trash. Sizes are
# cached for the session, so moving back up is instant.
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
${C_BOLD}space${C_RESET} — find what is using disk space and delete it

${C_BOLD}Usage:${C_RESET}
  space [options] [dir]       (default dir: ~)

${C_BOLD}Options:${C_RESET}
  -n, --top N     Show the N largest items per folder (default 50)
      --rm        Delete permanently instead of moving to the Trash
  -h, --help      Show this help

${C_BOLD}Keys:${C_RESET}
  Enter on a folder goes into it; on a file, offers Trash or Reveal in Finder.
  Esc quits.

macOS hides some folders (Mail, Messages, Safari…) from apps without Full Disk
Access, so their sizes may read low. Grant your terminal Full Disk Access in
System Settings › Privacy & Security for complete numbers.
EOF
}

START="$HOME"
TOP=50
PERMANENT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --top)
      [[ ${2:-} =~ ^[1-9][0-9]*$ ]] || die "--top needs a positive number."
      TOP="$2"
      shift
      ;;
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
    *) START="$1" ;;
  esac
  shift
done

[[ -d $START ]] || die "Not a directory: $START"
START="$(cd "$START" && pwd -P)"
_tty_ok || die "space is interactive and needs a terminal."

CACHE="$(mktemp -d -t space)"
REMOVED_KB=0
finish() {
  rm -rf "$CACHE"
  if [[ $REMOVED_KB -gt 0 ]]; then
    if $PERMANENT; then
      success "Freed $(human_kb "$REMOVED_KB") this session." "🗑️ "
    else
      success "Moved $(human_kb "$REMOVED_KB") to the Trash. Empty it to free the space." "🗑️ "
    fi
  fi
}
trap finish EXIT

# Spinner without the ✅ line run_with_spinner prints: this redraws often.
spin() {
  local msg="$1"
  shift
  if $HAVE_GUM; then
    gum spin --spinner dot --title "$msg" -- "$@"
  else
    printf '%s⏳ %s%s\n' "$C_DIM" "$msg" "$C_RESET" >&2
    "$@"
  fi
}

cache_file() { printf '%s/%s' "$CACHE" "$(printf '%s' "$1" | shasum | cut -c1-16)"; }

# scan DIR — print the path of a file listing DIR's children as "KB<TAB>path",
# largest first. Measured once, then served from the cache.
scan() {
  local dir="$1" out
  out="$(cache_file "$dir")"
  if [[ ! -e $out ]]; then
    # shellcheck disable=SC2016  # $1 and $2 belong to the inner sh
    spin "Measuring $(tildify "$dir")" sh -c '
      find "$1" -mindepth 1 -maxdepth 1 -print0 2>/dev/null |
        xargs -0 -P 8 -n 4 du -skx 2>/dev/null >"$2.raw"
      sort -t "	" -k1,1nr "$2.raw" >"$2"
      rm -f "$2.raw"' _ "$dir" "$out"
  fi
  printf '%s' "$out"
}

# forget DIR — drop cached sizes for DIR and every folder above it.
forget() {
  local p="$1"
  while :; do
    rm -f "$(cache_file "$p")"
    [[ $p == / ]] && break
    p="$(dirname "$p")"
  done
}

# Folders whose deletion would break the system or your account outright.
protected() {
  local p="$1" d
  for d in / /System /Library /Applications /Users /usr /bin /sbin /etc /var \
    /private /opt /Volumes "$HOME" "$HOME/Library" "$HOME/Desktop" \
    "$HOME/Documents" "$HOME/Downloads" "$HOME/Movies" "$HOME/Music" \
    "$HOME/Pictures" "$HOME/Applications"; do
    [[ $p == "$d" ]] && return 0
  done
  [[ $p == /System/* || $p == /usr/* || $p == /bin/* || $p == /sbin/* ]]
}

bar() {
  local kb="$1" max="$2" n i out=""
  n=$((max > 0 ? (kb * 10 + max / 2) / max : 0))
  for ((i = 0; i < 10; i++)); do
    if [[ $i -lt $n ]]; then out+="█"; else out+="░"; fi
  done
  printf '%s' "$out"
}

# remove DIR PATH KB [PATH KB...] — confirm, then trash or delete; DIR is the
# folder being browsed, whose cached sizes are then refreshed.
remove() {
  local dir="$1"
  shift
  local targets=() kbs=() p kb total=0 in_library=false i=0
  while [[ $# -gt 0 ]]; do
    p="$1" kb="$2"
    shift 2
    if protected "$p"; then
      warn "Skipping $(tildify "$p"): removing it would break your system or account."
      continue
    fi
    targets+=("$p")
    kbs+=("$kb")
    total=$((total + kb))
    [[ $p == "$HOME/Library/"* ]] && in_library=true
  done
  [[ ${#targets[@]} -eq 0 ]] && return 0

  printf '\n'
  for p in "${targets[@]}"; do
    printf '  %s%7s%s  %s\n' "$C_DIM" "$(human_kb "${kbs[$i]}")" "$C_RESET" "$(tildify "$p")"
    i=$((i + 1))
  done
  if $in_library; then
    warn "Apps keep their data in ~/Library. Caches are safe to clear, but Application Support, Containers and Group Containers can hold settings and files you can't get back."
  fi

  local verb="Move" dest=" to the Trash"
  $PERMANENT && verb="Permanently delete" dest=""
  if confirm "$verb ${#targets[@]} item(s) ($(human_kb "$total"))$dest?" n; then
    discard_paths "$PERMANENT" "${targets[@]}" || true
    REMOVED_KB=$((REMOVED_KB + total))
    forget "$dir"
  else
    dim "Nothing removed."
  fi
}

# ----- Browse ---------------------------------------------------------------

export GUM_CHOOSE_HEIGHT=25
dir="$START"
while :; do
  listing="$(scan "$dir")"

  paths=()
  sizes=()
  total=0
  count=0
  while IFS=$'\t' read -r kb path; do
    count=$((count + 1))
    total=$((total + kb))
    if [[ ${#paths[@]} -lt $TOP ]]; then
      paths+=("$path")
      sizes+=("$kb")
    fi
  done <"$listing"

  max=${sizes[0]:-0}
  free_kb="$(df -k "$dir" | awk 'NR == 2 { print $4 }')"

  # Fixed actions first, then entries. Labels must be unique (menu maps by text).
  actions=()
  [[ $dir != / ]] && actions+=("⬆  ..")
  [[ ${#paths[@]} -gt 0 ]] && actions+=("🗑  Delete items here…")
  actions+=("📂 Reveal this folder in Finder")

  labels=(${actions[@]+"${actions[@]}"})
  for i in "${!paths[@]}"; do
    name="$(basename "${paths[$i]}")"
    [[ -d ${paths[$i]} && ! -L ${paths[$i]} ]] && name+="/"
    pct=$((total > 0 ? sizes[i] * 100 / total : 0))
    labels+=("$(printf '%7s  %s %3d%%  %s' "$(human_kb "${sizes[$i]}")" \
      "$(bar "${sizes[$i]}" "$max")" "$pct" "$name")")
  done

  header="$(tildify "$dir")"$'\n'"$(human_kb "$total") in $count item(s) · $(human_kb "$free_kb") free"
  hidden=$((count - ${#paths[@]}))
  [[ $hidden -gt 0 ]] && header+=" · top $TOP shown"
  header+=" · Esc quits"

  menu "$header" "${labels[@]}"
  [[ $MENU_INDEX -lt 0 ]] && exit 0

  if [[ $MENU_INDEX -lt ${#actions[@]} ]]; then
    case "${actions[$MENU_INDEX]}" in
      "⬆  ..") dir="$(dirname "$dir")" ;;
      "📂 Reveal this folder in Finder") open "$dir" ;;
      "🗑  Delete items here…")
        entry_labels=("${labels[@]:${#actions[@]}}")
        multi_select "Select items to remove from $(tildify "$dir") (space toggles, Enter confirms)" \
          "${entry_labels[@]}"
        args=()
        for i in ${MULTI_SELECTED[@]+"${MULTI_SELECTED[@]}"}; do
          args+=("${paths[$i]}" "${sizes[$i]}")
        done
        if [[ ${#args[@]} -gt 0 ]]; then
          remove "$dir" "${args[@]}"
        fi
        ;;
    esac
    continue
  fi

  i=$((MENU_INDEX - ${#actions[@]}))
  picked="${paths[$i]}"
  if [[ -d $picked && ! -L $picked ]]; then
    dir="$picked"
    continue
  fi

  menu "$(tildify "$picked") · $(human_kb "${sizes[$i]}")" \
    "🗑  Remove" "📂 Reveal in Finder" "⬅  Back"
  case $MENU_INDEX in
    0) remove "$dir" "$picked" "${sizes[$i]}" ;;
    1) open -R "$picked" ;;
  esac
done
