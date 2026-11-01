#!/usr/bin/env bash
#
# pdf-summary — summarise a PDF: pdf2text FILE | summarise [opts]
#
# Options after the file go to summarise (--words, --prompt, --provider,
# --model), except --pages, which goes to pdf2text. Add --speak to also read the summary aloud (speak --play), saving
# the mp3 next to where you ran it.
#
set -euo pipefail

# --- resolve real path (run via symlink) and load shared helpers ------------
SOURCE="${BASH_SOURCE[0]}"
while [ -L "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
REAL_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
REPO_DIR="$(cd "$REAL_DIR/../.." && pwd)"
# shellcheck source=../lib/common.sh
source "$REAL_DIR/../lib/common.sh"
# shellcheck source=../lib/summary.sh
source "$REAL_DIR/../lib/summary.sh"

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  printf 'Usage: %s <file.pdf> [--pages RANGE] [--speak] [summarise options]\n' "$(basename "$0")"
  printf '  e.g. %s book.pdf --words 1500 --speak\n' "$(basename "$0")"
  exit 1
fi

pdf="$1"; shift
[[ -f "$pdf" ]] || die "Not a file: $pdf"
stem="$(basename "${pdf%.*}")-summary"

# Pull --pages out for pdf2text; everything else goes to summarise.
source_args=("$pdf")
rest=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pages)   [[ $# -ge 2 ]] || die "--pages needs a range, e.g. 1-20"; source_args+=(--pages "$2"); shift 2 ;;
    --pages=*) source_args+=("$1"); shift ;;
    *)         rest+=("$1"); shift ;;
  esac
done

summarise_with_speech "$stem" "$REPO_DIR/python/ai/pdf2text.py" "${source_args[@]}" -- ${rest[@]+"${rest[@]}"}
