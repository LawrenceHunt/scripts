#!/usr/bin/env bash
#
# gb — list local branches with their status and switch with the arrow keys.
#
# Each row shows the branch's age, how far it is ahead of / behind the default
# branch, its upstream tracking state, author and last commit. Any arguments are
# handed straight to `git branch`, so `gb -D old` and `gb new-thing` still work.
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

ME="$(basename "$0")"

usage() {
  cat <<EOF
${C_BOLD}${ME}${C_RESET} — list local branches with their status and switch with the arrow keys

${C_BOLD}Usage:${C_RESET}
  ${ME}                 branch overview; ↑/↓ and Enter to switch, Esc to cancel
  ${ME} -l, --list      print the overview without the picker
  ${ME} <git branch args>
                     anything else runs \`git branch <args>\` unchanged
  ${ME} -h, --help      show this help

${C_BOLD}Columns:${C_RESET}
  ● current branch    ⎇ checked out in another worktree
  vs <base>           commits ahead (+) / behind (−) the default branch,
                      or "merged" when it has nothing the base lacks
  upstream            ↑ unpushed / ↓ unpulled, "gone" if the remote branch was
                      deleted, "local" if it has never been pushed
                      (as of the last fetch — run \`git fetch\` to refresh)

${C_BOLD}Examples:${C_RESET}
  ${ME}                 pick a branch to switch to
  ${ME} -D old-spike    delete a branch, as \`git branch -D\` would
  ${ME} | less          the overview as plain text
EOF
}

LIST_ONLY=false
case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  -l | --list)
    LIST_ONLY=true
    shift
    ;;
esac
if [[ $# -gt 0 ]]; then
  exec git branch "$@"
fi

require_cmd git
git rev-parse --git-dir >/dev/null 2>&1 || die "Not inside a git repository."

current="$(git branch --show-current)"
here="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# The branch everything is measured against: origin's HEAD, else main/master.
base="$(git symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null || true)"
if [[ -z $base ]]; then
  for b in main master; do
    if git show-ref -q --verify "refs/heads/$b"; then
      base="$b"
      break
    fi
  done
fi
base_local="${base#origin/}"

# --- gather -----------------------------------------------------------------
# Fields are split on the unit separator: tabs would collapse empty fields.
SEP=$'\x1f'
fmt="%(refname:short)$SEP%(committerdate:unix)$SEP%(upstream:short)$SEP"
fmt+="%(upstream:track,nobracket)$SEP%(worktreepath)$SEP%(authorname)$SEP%(subject)"
[[ -n $base ]] && fmt+="$SEP%(ahead-behind:$base)"

names=()
ages=()
upstreams=()
tracks=()
worktrees=()
authors=()
subjects=()
vsbase=()
while IFS="$SEP" read -r name ts upstream track worktree author subject ab; do
  names+=("$name")
  ages+=("$ts")
  upstreams+=("$upstream")
  tracks+=("$track")
  worktrees+=("$worktree")
  authors+=("$author")
  subjects+=("$subject")
  vsbase+=("${ab:-}")
done < <(git for-each-ref --sort=-committerdate --format="$fmt" refs/heads)

if [[ ${#names[@]} -eq 0 ]]; then
  info "No branches yet — make a first commit." "🌿"
  exit 0
fi

# --- format -----------------------------------------------------------------

# short_age UNIX_TS — "5m", "3h", "2d", "6w", "4mo", "1y".
now="$(date +%s)"
short_age() {
  local s=$((now - $1))
  if ((s < 3600)); then
    printf '%dm' $((s / 60))
  elif ((s < 86400)); then
    printf '%dh' $((s / 3600))
  elif ((s < 14 * 86400)); then
    printf '%dd' $((s / 86400))
  elif ((s < 60 * 86400)); then
    printf '%dw' $((s / 604800))
  elif ((s < 365 * 86400)); then
    printf '%dmo' $((s / 2592000))
  else
    printf '%dy' $((s / 31536000))
  fi
}

# fit TEXT WIDTH — TEXT cut to WIDTH characters (with …) and padded to it.
# Pads by characters rather than bytes, so ↑/−/… line up.
fit() {
  local s="$1" w="$2"
  [[ ${#s} -gt $w ]] && s="${s:0:w-1}…"
  printf '%s%*s' "$s" $((w - ${#s})) ''
}

# Plain text for each cell first, so column widths ignore colour codes.
c_mark=() c_age=() c_base=() c_up=() c_author=()
w_name=0 w_base=0 w_up=0 w_author=0
for i in "${!names[@]}"; do
  name="${names[$i]}"

  if [[ $name == "$current" ]]; then
    c_mark+=("●")
  elif [[ -n ${worktrees[$i]} && ${worktrees[$i]} != "$here" ]]; then
    c_mark+=("⎇")
  else
    c_mark+=(" ")
  fi

  c_age+=("$(short_age "${ages[$i]}")")

  cell=""
  if [[ -n $base ]]; then
    read -r ahead behind <<<"${vsbase[$i]}"
    if [[ $name == "$base_local" ]]; then
      if [[ $base == origin/* ]]; then
        [[ $ahead -gt 0 ]] && cell+="+$ahead "
        [[ $behind -gt 0 ]] && cell+="−$behind"
        [[ -z $cell ]] && cell="base"
      else
        cell="base"
      fi
    elif [[ $ahead -eq 0 ]]; then
      cell="merged"
    else
      cell="+$ahead"
      [[ $behind -gt 0 ]] && cell+=" −$behind"
    fi
  fi
  cell="${cell% }"
  c_base+=("$cell")

  track="${tracks[$i]}"
  if [[ -z ${upstreams[$i]} ]]; then
    cell="local"
  elif [[ $track == gone ]]; then
    cell="gone"
  elif [[ -z $track ]]; then
    cell="✓"
  else
    cell=""
    [[ $track =~ ahead\ ([0-9]+) ]] && cell+="↑${BASH_REMATCH[1]} "
    [[ $track =~ behind\ ([0-9]+) ]] && cell+="↓${BASH_REMATCH[1]}"
    cell="${cell% }"
  fi
  c_up+=("$cell")

  c_author+=("${authors[$i]%% *}")

  [[ ${#name} -gt $w_name ]] && w_name=${#name}
  [[ ${#c_base[$i]} -gt $w_base ]] && w_base=${#c_base[$i]}
  [[ ${#c_up[$i]} -gt $w_up ]] && w_up=${#c_up[$i]}
  [[ ${#c_author[$i]} -gt $w_author ]] && w_author=${#c_author[$i]}
done
[[ $w_name -gt 40 ]] && w_name=40
[[ $w_name -lt 6 ]] && w_name=6
[[ $w_author -gt 12 ]] && w_author=12
vs_title="vs ${base:-base}"
[[ ${#vs_title} -gt $w_base ]] && w_base=${#vs_title}
[[ $w_up -lt 8 ]] && w_up=8

# Colour for a vs-base or upstream cell.
tint() {
  case "$1" in
    merged | ✓) printf '%s' "${C_GREEN}" ;;
    gone) printf '%s' "${C_RED}" ;;
    local | base) printf '%s' "${C_DIM}" ;;
    *) printf '%s' "${C_YELLOW}" ;;
  esac
}

header="$(printf '  %s  %s  %s  %s  %s  %s' "$(fit branch "$w_name")" "$(fit age 4)" \
  "$(fit "$vs_title" "$w_base")" "$(fit upstream "$w_up")" "$(fit author "$w_author")" "last commit")"

labels=()
current_label=""
for i in "${!names[@]}"; do
  mark="${c_mark[$i]}"
  name_style=""
  if [[ $mark == "●" ]]; then
    mark="${C_GREEN}●${C_RESET}"
    name_style="${C_BOLD}${C_GREEN}"
  elif [[ $mark == "⎇" ]]; then
    mark="${C_MAGENTA}⎇${C_RESET}"
    name_style="${C_DIM}"
  fi
  label="$mark $name_style$(fit "${names[$i]}" "$w_name")${C_RESET}"
  label+="  ${C_CYAN}$(fit "${c_age[$i]}" 4)${C_RESET}"
  label+="  $(tint "${c_base[$i]}")$(fit "${c_base[$i]}" "$w_base")${C_RESET}"
  label+="  $(tint "${c_up[$i]}")$(fit "${c_up[$i]}" "$w_up")${C_RESET}"
  label+="  ${C_BLUE}$(fit "${c_author[$i]}" "$w_author")${C_RESET}"
  subject="${subjects[$i]}"
  [[ ${#subject} -gt 60 ]] && subject="${subject:0:59}…"
  label+="  ${C_DIM}${subject}${C_RESET}"
  labels+=("$label")
  [[ ${names[$i]} == "$current" ]] && current_label="$label"
done

summary() {
  local n=${#names[@]} merged=0 gone=0 i
  for i in "${!names[@]}"; do
    [[ ${c_base[$i]} == merged ]] && merged=$((merged + 1))
    [[ ${c_up[$i]} == gone ]] && gone=$((gone + 1))
  done
  local line="$n branch(es)"
  [[ $merged -gt 0 ]] && line+=" · $merged merged into ${base}"
  [[ $gone -gt 0 ]] && line+=" · $gone with a deleted upstream"
  printf '%s' "$line"
}

# --- list mode: no picker ---------------------------------------------------
if $LIST_ONLY || [[ ! -t 1 ]] || ! _tty_ok; then
  printf '%s%s%s\n' "${C_DIM}" "$header" "${C_RESET}"
  printf '%s\n' "${labels[@]}"
  if [[ -t 1 ]]; then
    stat "$(summary)" "🌿"
    [[ $(summary) == *merged* || $(summary) == *deleted* ]] && dim "  gprune tidies those up."
  fi
  exit 0
fi

# --- pick and switch --------------------------------------------------------
dirty="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
title="🌿 On ${current:-a detached HEAD}"
[[ $dirty -gt 0 ]] && title+=" · ⚠️  $dirty uncommitted change(s)"
title+=" · $(summary)"

chosen=-1
if $HAVE_GUM; then
  # label<US>index: gum shows the label and prints the index. --selected
  # matches on the label, which puts the cursor on the current branch.
  items=()
  for i in "${!labels[@]}"; do
    items+=("${labels[$i]}$SEP$i")
  done
  height=${#items[@]}
  max_height=$(($(tput lines 2>/dev/null || echo 24) - 5))
  [[ $max_height -lt 5 ]] && max_height=5
  [[ $height -gt $max_height ]] && height=$max_height
  selected=()
  [[ -n $current_label ]] && selected=(--selected "$current_label")
  # As in common.sh's menu(): items go in through the pipe; gum reads keys from /dev/tty.
  rc=0
  pick="$(printf '%s\n' "${items[@]}" |
    gum choose --no-strip-ansi --label-delimiter "$SEP" --height "$height" \
      --header "$title"$'\n'"$header" --cursor '❯ ' \
      ${selected[@]+"${selected[@]}"})" || rc=$?
  [[ $rc -eq 130 ]] && exit 130
  [[ $rc -eq 0 && -n $pick ]] && chosen="$pick"
else
  printf '%s\n' "$title"
  menu "Switch to (columns: $header)" "${labels[@]}"
  chosen=$MENU_INDEX
fi

if [[ $chosen -lt 0 ]]; then
  dim "No branch chosen."
  exit 0
fi

target="${names[$chosen]}"
if [[ $target == "$current" ]]; then
  info "Already on ${C_BOLD}$target${C_RESET}." "🌿"
  exit 0
fi
if [[ ${c_mark[$chosen]} == "⎇" ]]; then
  die "${C_BOLD}$target${C_RESET} is checked out in another worktree: $(tildify "${worktrees[$chosen]}")"
fi
git switch "$target"
