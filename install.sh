#!/usr/bin/env bash
#
# install.sh — make every tool in this repo globally executable.
#
# Scans the language directories for executable tools (skipping lib/ and this
# script), symlinks each into ~/.local/bin by its basename, and checks that
# ~/.local/bin is on PATH.
#
# A tool can declare short aliases with a comment line near the top:
#
#   # aliases: pk
#
# Each alias gets its own symlink to the same tool.
#
set -euo pipefail

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load shared styling if available; otherwise fall back to plain output.
if [[ -f "$REPO_DIR/bash/lib/common.sh" ]]; then
  # shellcheck source=bash/lib/common.sh
  source "$REPO_DIR/bash/lib/common.sh"
else
  heading() { printf '\n== %s\n' "$1"; }
  info()    { printf '• %s\n' "$1"; }
  success() { printf 'OK %s\n' "$1"; }
  warn()    { printf '! %s\n' "$1" >&2; }
  stat()    { printf '%s %s\n' "$2" "$1"; }
  C_BOLD='' C_RESET='' C_DIM='' C_CYAN=''
fi

BIN_DIR="${HOME}/.local/bin"

heading "Installing scripts" "🔧"
info "Repo:   ${C_BOLD}${REPO_DIR}${C_RESET}"
info "Target: ${C_BOLD}${BIN_DIR}${C_RESET}"
mkdir -p "$BIN_DIR"

installed=0
skipped=0

# link_one TOOL NAME [NOTE] — symlink one command name at a tool.
# Returns 0 when a new link was created, 1 when nothing was done.
link_one() {
  local tool="$1" name="$2" note="${3:-}" link="$BIN_DIR/$2"

  if [[ -L "$link" && "$(readlink "$link")" == "$tool" ]]; then
    info "$name ${C_DIM}(already linked)${C_RESET}"
    return 1
  fi
  if [[ -e "$link" && ! -L "$link" ]]; then
    warn "$name — a real file already exists at $link; leaving it untouched."
    return 1
  fi

  ln -sf "$tool" "$link"
  success "$name → ${C_DIM}${tool#"$REPO_DIR"/}${note}${C_RESET}"
  return 0
}

# Executable tools live at <language>/<theme>/<tool>. Skip anything under a
# lib/ directory and skip files with a dot in the basename (libs keep .sh; tools
# are extensionless commands).
while IFS= read -r -d '' tool; do
  name="$(basename "$tool")"

  if link_one "$tool" "$name"; then ((installed++)) || true; else ((skipped++)) || true; fi

  # Optional short names, declared in the tool as: # aliases: pk foo
  aliases="$(sed -n 's/^# aliases:[[:space:]]*//p' "$tool" | head -1)"
  for alias_name in $aliases; do
    if link_one "$tool" "$alias_name" " (alias of $name)"; then
      ((installed++)) || true
    else
      ((skipped++)) || true
    fi
  done
done < <(
  find "$REPO_DIR" \
    -type d -name lib -prune -o \
    -type f -perm -u+x ! -name '*.*' ! -name 'install.sh' -print0
)

echo
stat "newly linked" "$installed"
stat "already present/skipped" "$skipped"

# --- PATH check -------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*)
    success "${BIN_DIR} is already on your PATH." "✅"
    ;;
  *)
    warn "${BIN_DIR} is not on your PATH."
    shell_name="$(basename "${SHELL:-}")"
    case "$shell_name" in
      zsh)  profile="~/.zshrc" ;;
      bash) profile="~/.bashrc" ;;
      *)    profile="your shell profile" ;;
    esac
    printf '   Add this line to %s%s%s and restart your shell:\n\n' "$C_BOLD" "$profile" "$C_RESET"
    printf '     %sexport PATH="$HOME/.local/bin:$PATH"%s\n\n' "$C_CYAN" "$C_RESET"
    ;;
esac

# --- optional enhancement: gum ----------------------------------------------
if command -v gum >/dev/null 2>&1; then
  success "gum detected — interactive prompts will use the enhanced UI. ✨"
else
  warn "gum not found (optional). Tools work without it, but menus/spinners are nicer with it."
  if command -v brew >/dev/null 2>&1; then
    printf '   Install with: %sbrew install gum%s\n' "$C_CYAN" "$C_RESET"
  else
    printf '   See: %shttps://github.com/charmbracelet/gum%s\n' "$C_CYAN" "$C_RESET"
  fi
fi

success "Installation complete. 🎉"
