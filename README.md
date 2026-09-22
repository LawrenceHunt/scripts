# scripts

Small command-line tools I use every day, installed globally with one symlink-based
installer. Each one does a single job, says clearly what it is about to do, and asks
before anything irreversible.

## Install

```sh
git clone https://github.com/LawrenceHunt/scripts.git
cd scripts
./install.sh
```

`install.sh` symlinks every tool into `~/.local/bin` by its basename (plus any short
aliases it declares) and tells you if that directory is not on your `PATH`. No `sudo`
needed. Re-run it after adding a tool.

Optional: [`gum`](https://github.com/charmbracelet/gum) (`brew install gum`). When it
is present, menus, confirmations and spinners use it. When it is absent, everything
falls back to plain bash, so no tool ever hard-fails for want of it.

## Tools

| Command | Does |
| --- | --- |
| `gprune` | Prunes local git branches whose remote branch has been deleted |
| `portkill` (`pk`) | Shows what is listening on your ports and kills it |

### gprune

Fetches with `--prune`, finds local branches whose upstream is gone, and lists each
with its last commit before deleting anything. Branches that `git branch -d` refuses
are checked properly: if every commit is reachable from another ref, or the branch was
squash-merged into the default branch, it is deleted with a note. Anything genuinely
unmerged is shown commit by commit and needs explicit consent.

```sh
gprune            # list stale branches, then choose what to delete
gprune --dry-run  # list only
gprune --yes      # delete all stale branches without prompting
```

### portkill (pk)

```sh
pk                   # scan listening ports, pick one from a dropdown
pk 3000              # show what holds port 3000 and offer to kill it
pk 3000 8080 5432    # several ports in turn
pk --list            # never kill anything
pk --all             # include high ports (>= 32768)
pk --udp             # include bound UDP sockets
pk --force           # SIGKILL immediately instead of SIGTERM first
```

It sends `SIGTERM` and waits up to five seconds, then asks before escalating to
`SIGKILL`, and confirms the port is actually free afterwards. Ports held by another
user are flagged with `!` and need `sudo pk <port>`. It refuses to kill pid 1 or
itself. High ports are hidden from the scan by default because they are nearly always
app-internal rather than a server you started; the hidden count is always printed.

## Layout

Grouped by language first, then by theme:

```
bash/
  lib/
    common.sh          # colours, emojis, spinners, prompts, output helpers
  git/
    gprune
  net/
    portkill
```

A tool is an executable file with no extension — the filename is the command name.
Shared libraries live in `lib/`, keep their extension, and are never installed.

## Adding a tool

1. Drop the executable in the right `<language>/<theme>/` directory and `chmod +x` it.
2. Start with `#!/usr/bin/env bash` and `set -euo pipefail`, then source
   `bash/lib/common.sh` after resolving the script's real path (it runs via a symlink).
3. Want a short name? Add a comment near the top: `# aliases: pk`. The installer
   symlinks each alias at the same tool.
4. Re-run `./install.sh`.

## Requirements

`bash` (3.2 is fine — macOS ships it), plus whatever a tool's own domain needs: `git`
for `gprune`, `lsof` for `portkill`. Written and tested on macOS; the tools avoid
anything macOS-specific but Linux is untested.
