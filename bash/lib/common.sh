#!/usr/bin/env bash
# common.sh — shared styling, output and prompt helpers for bash tools.
#
# Source this from a tool after resolving the tool's real path, e.g.:
#
#   SOURCE="${BASH_SOURCE[0]}"
#   while [ -L "$SOURCE" ]; do
#     DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
#     SOURCE="$(readlink "$SOURCE")"
#     [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
#   done
#   REAL_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
#   source "$REAL_DIR/../lib/common.sh"
#
# All helpers respect NO_COLOR and non-tty output (colours disabled automatically).

# ----- Colour palette -------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
else
  C_RESET='' C_BOLD='' C_DIM='' C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_MAGENTA='' C_CYAN=''
fi

# ----- Output helpers -------------------------------------------------------
# Convention: informational output goes to stdout; warnings/errors to stderr.

heading() { printf '\n%s%s%s %s%s\n' "$C_BOLD" "$C_CYAN" "${2:-›}" "$1" "$C_RESET"; }
info()    { printf '%s%s%s %s\n' "$C_BLUE"  "${2:-•}"  "$C_RESET" "$1"; }
success() { printf '%s%s%s %s\n' "$C_GREEN" "${2:-✅}" "$C_RESET" "$1"; }
warn()    { printf '%s%s%s %s\n' "$C_YELLOW" "${2:-⚠️ }" "$C_RESET" "$1" >&2; }
error()   { printf '%s%s%s %s\n' "$C_RED"   "${2:-❌}" "$C_RESET" "$1" >&2; }
dim()     { printf '%s%s%s\n' "$C_DIM" "$1" "$C_RESET"; }
stat()    { printf '%s📊 %s%s%s %s%s\n' "$C_MAGENTA" "$C_BOLD" "$2" "$C_RESET$C_MAGENTA" "$1" "$C_RESET"; }

# die MESSAGE [EXIT_CODE] — print an error and exit.
die() { error "$1"; exit "${2:-1}"; }

# ----- Activity feedback ----------------------------------------------------

# run_with_spinner "message" command args...
# Runs the command, showing an animated spinner until it finishes.
run_with_spinner() {
  local msg="$1"; shift
  if [[ ! -t 1 ]]; then
    printf '⏳ %s\n' "$msg"
    "$@"
    return $?
  fi

  local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  "$@" &
  local pid=$!
  local i=0
  tput civis 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    local frame="${frames:i++%${#frames}:1}"
    printf '\r%s%s%s %s' "$C_CYAN" "$frame" "$C_RESET" "$msg"
    sleep 0.08
  done
  wait "$pid"
  local rc=$?
  tput cnorm 2>/dev/null || true
  if [[ $rc -eq 0 ]]; then
    printf '\r%s✅%s %s\n' "$C_GREEN" "$C_RESET" "$msg"
  else
    printf '\r%s❌%s %s\n' "$C_RED" "$C_RESET" "$msg"
  fi
  return $rc
}

# ----- Prompts --------------------------------------------------------------

# confirm "question" [default:y|n] — yes/no prompt. Returns 0 for yes, 1 for no.
confirm() {
  local q="$1" def="${2:-n}" hint reply
  if [[ $def == y ]]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    printf '%s❓ %s%s %s ' "$C_YELLOW" "$C_RESET" "$q" "$hint"
    read -r reply
    reply="${reply:-$def}"
    case "$reply" in
      [Yy]|[Yy][Ee][Ss]) return 0 ;;
      [Nn]|[Nn][Oo])     return 1 ;;
      *) warn "Please answer y or n." ;;
    esac
  done
}

# choose "question" "keys" — single-key choice from a set (e.g. "asn").
# Echoes the chosen (lowercased) key to stdout.
choose() {
  local q="$1" keys="$2" reply
  while true; do
    printf '%s❓ %s%s %s[%s]%s ' "$C_YELLOW" "$C_RESET" "$q" "$C_DIM" "$keys" "$C_RESET" >&2
    read -r reply
    reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
    if [[ ${#reply} -eq 1 && $keys == *"$reply"* ]]; then
      printf '%s' "$reply"
      return 0
    fi
    warn "Please choose one of: $keys"
  done
}

# require_cmd BIN — die if a required binary is missing.
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command '$1' not found on PATH."
}
