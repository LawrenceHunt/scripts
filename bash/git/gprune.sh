#!/usr/bin/env bash
#
# gprune — prune local git branches in stages, from merged work to abandoned work.
#
# Fetches with --prune, sorts every local branch into a stage by how safe it is
# to delete (remote gone and merged, merged, PR merged, PR closed, no PR), then
# shows each stage as a checklist. Safe stages start ticked, risky ones start
# unticked. Every deleted branch is written to a restore file first.
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

STAGE_COUNT=5

# detect_base_ref — the integration branch to test merges against.
# Prefers the remote's default branch (origin/HEAD), then common fallbacks.
detect_base_ref() {
  local ref c
  if ref="$(git symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null)"; then
    printf '%s' "${ref#refs/remotes/}"
    return 0
  fi
  for c in origin/main origin/master main master; do
    if git rev-parse --verify --quiet "$c" >/dev/null 2>&1; then
      printf '%s' "$c"
      return 0
    fi
  done
  return 1
}

# is_squash_merged BRANCH BASE — true if BRANCH's combined diff already exists in
# BASE as a single patch (i.e. it was squash- or rebase-merged, so the individual
# commit SHAs differ but no actual change would be lost).
is_squash_merged() {
  local branch="$1" base="$2" mb tree dangling
  mb="$(git merge-base "$base" "$branch" 2>/dev/null)" || return 1
  tree="$(git rev-parse "$branch^{tree}" 2>/dev/null)" || return 1
  dangling="$(git commit-tree "$tree" -p "$mb" -m _ 2>/dev/null)" || return 1
  [[ "$(git cherry "$base" "$dangling" 2>/dev/null)" == "-"* ]]
}

# is_merged BRANCH BASE — true if every change on BRANCH is already in BASE.
is_merged() {
  git merge-base --is-ancestor "$1" "$2" 2>/dev/null || is_squash_merged "$1" "$2"
}

# commits_only_here BRANCH — how many commits on BRANCH no other ref reaches,
# i.e. what deleting it would lose.
commits_only_here() {
  git rev-list --count "$1" --not --exclude="refs/heads/$1" --all 2>/dev/null || echo 0
}

# pr_for BRANCH — "<state><TAB><number>" of the pull request whose head is BRANCH.
# When several share the name, an open PR wins, then a merged one.
pr_for() {
  printf '%s\n' "$PR_STATES" | awk -F'\t' -v b="$1" '
    $1 == b {
      rank = ($2 == "OPEN") ? 3 : ($2 == "MERGED") ? 2 : 1
      if (rank > best) { best = rank; found = $2 "\t" $3 }
    }
    END { if (found != "") print found }'
}

# stage_title N / stage_guidance N / stage_checked N — how each stage is presented.
stage_title() {
  case "$1" in
    1) printf 'Remote deleted, already merged' ;;
    2) printf 'Merged into %s' "$BASE_REF" ;;
    3) printf "PR merged, but some commits aren't in %s" "$BASE_REF" ;;
    4) printf 'PR closed without merging' ;;
    5) if $HAVE_PRS; then printf 'No pull request'; else printf 'Not merged'; fi ;;
  esac
}
stage_guidance() {
  case "$1" in
    1) printf 'Their remote branch is gone and every change is in %s. Nothing is lost by deleting them.' "$BASE_REF" ;;
    2) printf 'Every change is in %s (merged or squashed), though the remote branch may still exist. Nothing is lost by deleting them.' "$BASE_REF" ;;
    3) printf "GitHub says the PR merged, but git can't match every change in %s: usually review fixups or commits made after merging. Check the commits-only-here count." "$BASE_REF" ;;
    4) printf "Abandoned or replaced work. Commits only here are lost when the branch is deleted, apart from the restore file." ;;
    5) if $HAVE_PRS; then
      printf 'Backups, scratch work and checkouts that never had a PR. Commits only here are lost when the branch is deleted, apart from the restore file.'
    else
      printf "Branches git can't show are merged. Without PR state they aren't split further. Commits only here are lost when deleted, apart from the restore file."
    fi ;;
  esac
}
stage_checked() { [[ "$1" -le 3 ]]; }

usage() {
  cat <<EOF
${C_BOLD}gprune${C_RESET} — prune local branches in stages, from merged work to abandoned work

${C_BOLD}Usage:${C_RESET}
  gprune [options]

${C_BOLD}Options:${C_RESET}
  -n, --dry-run    List every stage but never delete
  -y, --yes        Delete stages 1–2 (already merged) without prompting; skip the rest
  -h, --help       Show this help

${C_BOLD}Stages${C_RESET} (each branch appears in the first one it matches):
  1. Remote deleted, already merged     ${C_DIM}starts ticked${C_RESET}
  2. Merged into the default branch     ${C_DIM}starts ticked${C_RESET}
  3. PR merged, but commits remain      ${C_DIM}starts ticked${C_RESET}
  4. PR closed without merging          ${C_DIM}starts unticked${C_RESET}
  5. No pull request                    ${C_DIM}starts unticked${C_RESET}

  Each stage is a checklist: x toggles, Enter then asks to delete the ticked
  branches, Esc skips the stage, Ctrl-C stops. Stages 3–4 need the gh CLI;
  without it those branches go in stage 5.

${C_BOLD}Never shown:${C_RESET}
  The current branch, the default branch, branches checked out in a worktree
  and branches with an open PR.

${C_BOLD}Undo:${C_RESET}
  Deleted branches are written to a restore file (path printed at the end).
  Run it with bash to recreate them while git still has the commits.
EOF
}

DRY_RUN=false
ASSUME_YES=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n | --dry-run) DRY_RUN=true ;;
    -y | --yes) ASSUME_YES=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      usage >&2
      exit 2
      ;;
  esac
  shift
done

require_cmd git

# --- sanity: inside a work tree ---------------------------------------------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
  die "Not inside a git repository."

REPO_ROOT="$(git rev-parse --show-toplevel)"
REPO_NAME="$(basename "$REPO_ROOT")"
CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"

heading "gprune · $REPO_NAME" "🌿"
info "Current branch: ${C_BOLD}${CURRENT_BRANCH}${C_RESET}"

# --- refresh remote-tracking refs -------------------------------------------
if git remote | grep -q .; then
  run_with_spinner "Fetching and pruning deleted remote branches…" \
    git fetch --all --prune --quiet ||
    die "git fetch failed — check your network or remote configuration."
else
  warn "No remotes configured; using existing tracking information only."
fi

BASE_REF="$(detect_base_ref || true)"
BASE_BRANCH="${BASE_REF#origin/}"
if [[ -n "$BASE_REF" ]]; then
  info "Default branch: ${C_BOLD}${BASE_REF}${C_RESET}"
else
  warn "No default branch found (origin/HEAD, main or master), so no branch counts as merged."
fi

# --- pull request state (optional: needs gh) --------------------------------
# Lines of "<head branch><TAB><state><TAB><number>".
PR_STATES=""
HAVE_PRS=false
if command -v gh >/dev/null 2>&1; then
  PR_FILE="$(mktemp)"
  trap 'rm -f "$PR_FILE"' EXIT
  # The spinner runs a command, so a tiny sh -c writes gh's output to the file.
  # shellcheck disable=SC2016  # $1 is expanded by that inner sh, not here
  if run_with_spinner "Looking up pull requests on GitHub…" \
    sh -c 'gh pr list --state all --limit 5000 --json headRefName,state,number \
      --jq ".[] | [.headRefName, .state, (.number | tostring)] | @tsv" >"$1" 2>/dev/null' \
    _ "$PR_FILE"; then
    PR_STATES="$(cat "$PR_FILE")"
    HAVE_PRS=true
  else
    warn "Couldn't list pull requests with gh (not a GitHub repo, or not logged in?)."
  fi
else
  warn "gh isn't installed, so pull request state is unknown."
fi
$HAVE_PRS || dim "   Unmerged branches all go in the last stage, and open PRs can't be held back."

# --- sort branches into stages ----------------------------------------------
WORKTREE_BRANCHES="$(git worktree list --porcelain | sed -n 's|^branch refs/heads/||p')"
TOTAL_LOCAL="$(git for-each-ref refs/heads | wc -l | tr -d ' ')"

declare -a CAND_BRANCH=() CAND_STAGE=() CAND_DETAIL=()
held_back_worktree=0
held_back_open=0

info "Checking $TOTAL_LOCAL local branches…" "🔍"
# Fields are split on \x1f, not tabs: read merges runs of whitespace separators,
# so an empty upstream field would shift the rest along.
while IFS=$'\x1f' read -r branch track reldate subject; do
  [[ -z "$branch" ]] && continue
  [[ "$branch" == "$CURRENT_BRANCH" || "$branch" == "$BASE_BRANCH" ]] && continue
  if grep -qxF "$branch" <<<"$WORKTREE_BRANCHES"; then
    ((held_back_worktree++)) || true
    continue
  fi

  pr_state="" pr_number=""
  if $HAVE_PRS; then
    pr="$(pr_for "$branch")"
    if [[ -n "$pr" ]]; then
      pr_state="${pr%%$'\t'*}"
      pr_number="${pr##*$'\t'}"
    fi
  fi
  if [[ "$pr_state" == OPEN ]]; then
    ((held_back_open++)) || true
    continue
  fi

  merged=false
  [[ -n "$BASE_REF" ]] && is_merged "$branch" "$BASE_REF" && merged=true
  if $merged && [[ "$track" == *"[gone]"* ]]; then
    stage=1
  elif $merged; then
    stage=2
  elif [[ "$pr_state" == MERGED ]]; then
    stage=3
  elif [[ "$pr_state" == CLOSED ]]; then
    stage=4
  else
    stage=5
  fi

  detail="$reldate"
  [[ -n "$pr_number" ]] && detail+=" · PR #$pr_number"
  if [[ $stage -ge 3 ]]; then
    only_here="$(commits_only_here "$branch")"
    if [[ "$only_here" -eq 0 ]]; then
      detail+=" · no commits only here"
    else
      detail+=" · $only_here commit(s) only here"
    fi
  fi
  [[ ${#subject} -gt 50 ]] && subject="${subject:0:49}…"
  detail+=" · $subject"

  CAND_BRANCH+=("$branch")
  CAND_STAGE+=("$stage")
  CAND_DETAIL+=("$detail")
done < <(git for-each-ref --sort=committerdate \
  --format='%(refname:short)%1f%(upstream:track)%1f%(committerdate:relative)%1f%(contents:subject)' \
  refs/heads)

stat "local branches" "$TOTAL_LOCAL"
for ((stage = 1; stage <= STAGE_COUNT; stage++)); do
  n=0
  for s in ${CAND_STAGE[@]+"${CAND_STAGE[@]}"}; do [[ $s -eq $stage ]] && ((n++)) || true; done
  stat "stage $stage · $(stage_title "$stage")" "$n"
done
held_back="the current branch${BASE_BRANCH:+, $BASE_BRANCH}"
[[ $held_back_worktree -gt 0 ]] && held_back+=", $held_back_worktree checked out in a worktree"
[[ $held_back_open -gt 0 ]] && held_back+=", $held_back_open with an open PR"
dim "   Not shown: $held_back."

if [[ ${#CAND_BRANCH[@]} -eq 0 ]]; then
  success "Nothing to prune. 🎉"
  exit 0
fi

# --- delete, recording each branch in a restore file first ------------------
RESTORE_FILE=""
deleted=0
failed=0

# record_restore BRANCH SHA — append a line that recreates BRANCH at SHA.
record_restore() {
  if [[ -z "$RESTORE_FILE" ]]; then
    local dir="${XDG_STATE_HOME:-$HOME/.local/state}/scripts/gprune"
    mkdir -p "$dir"
    RESTORE_FILE="$dir/$REPO_NAME-$(date +%Y%m%d-%H%M%S).sh"
    {
      printf '# gprune restore file: recreates the branches deleted from %s on %s.\n' \
        "$REPO_ROOT" "$(date '+%Y-%m-%d %H:%M')"
      printf '# Run with bash. Git keeps unreferenced commits for at least two weeks.\n'
      printf 'cd %q || exit 1\n' "$REPO_ROOT"
    } >"$RESTORE_FILE"
  fi
  printf 'git branch %q %s\n' "$1" "$2" >>"$RESTORE_FILE"
}

# delete_branches BRANCH... — force-delete each (ticking it was the consent).
delete_branches() {
  local branch sha
  for branch in "$@"; do
    sha="$(git rev-parse --verify --quiet "refs/heads/$branch")" || sha=""
    if [[ -n "$sha" ]] && git branch -D "$branch" >/dev/null 2>&1; then
      record_restore "$branch" "$sha"
      success "Deleted ${C_BOLD}${branch}${C_RESET}" "🗑️"
      ((deleted++)) || true
    else
      error "Failed to delete '$branch'."
      ((failed++)) || true
    fi
  done
}

# --- work through the stages ------------------------------------------------
for ((stage = 1; stage <= STAGE_COUNT; stage++)); do
  heading "Stage $stage of $STAGE_COUNT · $(stage_title "$stage")" "🗂️"

  declare -a branches=() details=()
  for i in "${!CAND_BRANCH[@]}"; do
    if [[ ${CAND_STAGE[$i]} -eq $stage ]]; then
      branches+=("${CAND_BRANCH[$i]}")
      details+=("${CAND_DETAIL[$i]}")
    fi
  done
  if [[ ${#branches[@]} -eq 0 ]]; then
    dim "   None."
    continue
  fi
  info "$(stage_guidance "$stage")"

  # One label per branch: the name padded to the stage's longest (capped, so one
  # very long name doesn't push every row right), then detail.
  width=0
  for b in "${branches[@]}"; do [[ ${#b} -gt $width ]] && width=${#b}; done
  [[ $width -gt 45 ]] && width=45
  declare -a labels=()
  for i in "${!branches[@]}"; do
    labels+=("$(printf '%-*s  %s' "$width" "${branches[$i]}" "${details[$i]}")")
  done

  if $DRY_RUN; then
    for label in "${labels[@]}"; do printf '  %s\n' "$label"; done
    continue
  fi

  declare -a to_delete=()
  if $ASSUME_YES; then
    if [[ $stage -le 2 ]]; then
      to_delete=("${branches[@]}")
    else
      for label in "${labels[@]}"; do printf '  %s\n' "$label"; done
      info "Skipped: --yes only deletes branches that are already merged."
      continue
    fi
  else
    checked=()
    stage_checked "$stage" && checked=(--checked)
    multi_select ${checked[@]+"${checked[@]}"} \
      "x toggles, a toggles all, Enter to confirm, Esc skips this stage" "${labels[@]}"
    for i in ${MULTI_SELECTED[@]+"${MULTI_SELECTED[@]}"}; do
      to_delete+=("${branches[$i]}")
    done
    if [[ ${#to_delete[@]} -eq 0 ]]; then
      info "Kept all ${#branches[@]} branch(es) in this stage."
      continue
    fi
    for b in "${to_delete[@]}"; do dim "   $b"; done
    if ! confirm "Delete these ${#to_delete[@]} branch(es)?" n; then
      info "Kept all ${#branches[@]} branch(es) in this stage."
      continue
    fi
  fi
  delete_branches "${to_delete[@]}"
done

echo
if $DRY_RUN; then
  info "Dry run — no branches deleted." "🧪"
  exit 0
fi
stat "deleted" "$deleted"
[[ $failed -gt 0 ]] && stat "failed" "$failed"
if [[ -n "$RESTORE_FILE" ]]; then
  info "Restore file: $(tildify "$RESTORE_FILE")"
  dim "   Undo with: bash $(tildify "$RESTORE_FILE")"
fi
success "Done." "🎉"
