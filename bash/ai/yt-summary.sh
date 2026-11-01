#!/usr/bin/env bash
#
# yt-summary — summarise a YouTube video: yt-transcript URL | summarise [opts]
#
# Options after the URL go to summarise (--words, --prompt, --provider,
# --model). Add --speak to also read the summary aloud (speak --play), saving
# the mp3 next to where you ran it.
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
REPO_DIR="$(cd "$REAL_DIR/../.." && pwd)"
# shellcheck source=SCRIPTDIR/../lib/common.sh
source "$REAL_DIR/../lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/summary.sh
source "$REAL_DIR/../lib/summary.sh"

if [[ $# -lt 1 || "$1" == "-h" || "$1" == "--help" ]]; then
  printf 'Usage: %s <youtube-url> [--speak] [summarise options]\n' "$(basename "$0")"
  printf '  e.g. %s URL --words 200 --prompt "focus on the advice" --speak\n' "$(basename "$0")"
  exit 1
fi

url="$1"
shift
summarise_with_speech "yt-summary" "$REPO_DIR/python/ai/yt-transcript.py" "$url" -- "$@"
