#!/usr/bin/env bash
#
# scripts — browse every tool in this repo and run one from a menu.
#
# Reads each tool's description from its own header line ("name — what it
# does"), so the list never goes stale. Piped, it prints the list instead.
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
REPO_DIR="$(cd "$REAL_DIR/../.." && pwd)"

usage() {
  cat <<EOF
${C_BOLD}scripts${C_RESET} — browse and run the tools in this repo

${C_BOLD}Usage:${C_RESET}
  scripts            pick a tool, then run it, run it with arguments, or read its help
  scripts --list     print every tool and what it does (also what you get when piped)
  scripts -h         show this help
EOF
}

LIST=false
case "${1:-}" in
  "") ;;
  -l | --list) LIST=true ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    error "Unknown option: $1"
    usage >&2
    exit 1
    ;;
esac
if [[ ! -t 1 ]] || ! _tty_ok; then LIST=true; fi

# ----- Discover (same rule as install.sh: <language>/<theme>/<tool>.<ext>) --

files=()
names=()
themes=()
descs=()
while IFS= read -r file; do
  name="$(basename "${file%.*}")"
  # The header line looks like "# name — description." (or // or a docstring).
  desc="$(head -n 20 "$REPO_DIR/$file" | grep -m1 -E "^[#/ \"]*$name — " || true)"
  desc="${desc#*— }"
  desc="${desc%.}"
  aliases="$(head -n 20 "$REPO_DIR/$file" | sed -n 's/^# aliases: *//p' | head -n 1)"
  [[ -n $aliases ]] && name+=" (${aliases// /, })"
  files+=("$file")
  names+=("$name")
  themes+=("$(basename "$(dirname "$file")")")
  descs+=("${desc:-—}")
done < <(cd "$REPO_DIR" && find . -mindepth 3 -maxdepth 3 -type f -perm -u+x \
  ! -path './*/lib/*' ! -path './node_modules/*' ! -path './.*' |
  sed 's|^\./||' | sort -t / -k2,2 -k3,3)

[[ ${#files[@]} -gt 0 ]] || die "No tools found in $REPO_DIR."

width=0
for name in "${names[@]}"; do
  [[ ${#name} -gt $width ]] && width=${#name}
done

labels=()
for i in "${!files[@]}"; do
  labels+=("$(printf '%-*s  %-5s  %s' "$width" "${names[$i]}" "${themes[$i]}" "${descs[$i]}")")
done

if $LIST; then
  printf '%s\n' "${labels[@]}"
  exit 0
fi

# ----- Pick and run ---------------------------------------------------------

filter_menu "🧰 ${#files[@]} tools · type to filter · Esc quits" "" "${labels[@]}"
[[ $MENU_INDEX -lt 0 ]] && exit 0
i=$MENU_INDEX
tool="$REPO_DIR/${files[$i]}"
cmd="$(basename "${files[$i]%.*}")"

while :; do
  menu "$cmd — ${descs[$i]}" "▶  Run" "✏️  Run with arguments…" "❓ Show help"
  case $MENU_INDEX in
    0) args=() ;;
    1)
      if $HAVE_GUM; then
        input="$(gum input --header "$cmd" --placeholder 'arguments, as you would type them' </dev/tty)" ||
          exit 0
      else
        printf '%s❓ %s%s ' "$C_YELLOW" "$C_RESET" "$cmd" >/dev/tty
        IFS= read -r input </dev/tty
      fi
      # Split the way a shell would, so quotes work. This is your own typing in
      # your own terminal, exactly as if entered at the prompt.
      eval "args=($input)"
      ;;
    2)
      printf '\n'
      "$tool" --help || true
      printf '\n'
      continue
      ;;
    *) exit 0 ;;
  esac
  dim "\$ $cmd${args[*]+ ${args[*]}}"
  exec "$tool" ${args[@]+"${args[@]}"}
done
