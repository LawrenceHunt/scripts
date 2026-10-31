# CLAUDE.md

System-level command-line scripts, executable globally from anywhere on the machine.

## What this repo is

A multi-language collection of small, self-contained CLI tools. Each tool does one
thing well, tells the user clearly what it's doing, and is pleasant to look at.

## Repository layout

Scripts are grouped **by language first, then by functionality/theme**:

```
<language>/
  lib/                 # shared helpers for that language (not installed as commands)
  <theme>/
    <toolname>         # one executable per tool, no file extension
```

Current tree:

```
bash/
  lib/
    common.sh          # colours, emojis, spinners, prompts, output helpers
  git/
    gprune             # prune local branches whose remote is gone
  net/
    portkill           # inspect listening ports and kill what holds them (alias: pk)
node/
  package.json         # shared deps for every node tool (node_modules is gitignored)
  media/
    img-opt            # resize/convert images with sharp
    vid-opt            # re-encode video for the web with ffmpeg
    glb-opt            # shrink .glb 3D models with gltf-transform
    pdf-opt            # compress PDFs with Ghostscript
python/
  media/
    ytdl               # download YouTube videos (merges streams with ffmpeg)
```

When a new language is introduced, mirror this shape (e.g. `python/lib/`,
`python/git/`). Never mix languages inside a theme directory — the language is
always the top level.

## Making scripts globally executable (the one consistent way)

There is a single mechanism. Do not invent per-tool install steps.

1. Every tool is a file with a shebang and the executable bit set (`chmod +x`).
2. Tools have **no file extension** — the filename is the command name (`gprune`,
   not `gprune.sh`). Shared libraries in `lib/` keep their extension and are never
   installed.
3. `./install.sh` scans the language directories for executable tools (skipping
   `lib/`) and symlinks each into `~/.local/bin` by its basename.
4. A tool may declare short aliases with a comment line near the top of the
   file — `# aliases: pk` — and `install.sh` symlinks each alias at the same
   tool. The tool prints `$(basename "$0")` in its help and hints, so suggested
   commands match whichever name was typed.
5. `~/.local/bin` is expected to be on `PATH`. `install.sh` checks this and prints
   the exact line to add to the user's shell profile if it is missing. We use
   `~/.local/bin` (not `/usr/local/bin`) so installation never needs `sudo`.

To add a new tool: drop the executable in the right `<language>/<theme>/` folder,
`chmod +x` it, and re-run `./install.sh`.

## Toolchains: mise

Runtimes come from [mise](https://mise.jdx.dev), never from whatever happens to
be on `PATH`. `mise.toml` at the repo root declares the versions, and each
non-bash tool pins the same versions in its shebang so it runs correctly from
any directory:

- **Python** — `#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script`,
  with dependencies declared inline in a PEP 723 `# /// script` block. uv builds
  and caches the environment on first run; there is no venv or lockfile to manage.
- **Node** — `#!/usr/bin/env -S mise exec node@22 -- node`. Dependencies live in
  the shared `node/package.json`; `install.sh` runs `npm install` there. Node
  resolves the symlink to the real file, so imports find `node/node_modules`.
  Code that compares `process.argv[1]` to its own path must `realpath` both.

When bumping a version, change it in `mise.toml` and in the shebangs together.
`mise run install` is an alias for `./install.sh`.

## Output & interaction conventions

Every tool should feel like it belongs to the same family:

- **Colour** — use it to structure output (headings, success, warning, error,
  dim detail). Bash tools source `bash/lib/common.sh` for the palette; other
  languages get an equivalent lib.
- **Emojis** — express *activity* (🔍 scanning, ⏳ waiting, 🌿 branches), *outcome*
  (✅ success, ⚠️ warning, ❌ error, 🗑️ deleted), and *stats* (📊 counts). Keep them
  meaningful, not decorative noise.
- **Detailed information** — always say what's about to happen, what happened, and
  show relevant stats (counts, timings, before/after). Never leave the user guessing.
- **Time & activity feedback** — long or blocking steps (network fetches, etc.) use
  a spinner or explicit "⏳ …" line so the user knows it's working.
- **Input** — prompt with clear CLI-style questions. Show the accepted keys, mark a
  default in `[UPPER/lower]` form, and echo the choice back. Destructive actions
  always require explicit confirmation and never default to "yes".
- **Safety** — confirm before anything irreversible; support a way to review before
  acting; exit cleanly (non-zero on error) and leave no partial state.

## Optional dependency: gum

[`gum`](https://github.com/charmbracelet/gum) (Charmbracelet) is a **recommended but
optional** enhancement. When it's installed, the shared bash helpers use it for
interactive dropdowns (`menu`), confirmations (`confirm`), and spinners
(`run_with_spinner`). When it's absent, every helper falls back to a pure-bash
implementation, so tools must never *require* it. `install.sh` detects it and
prints the `brew install gum` hint if missing.

Rule of thumb: reach for a CLI library for **interactive** flair (pickers, forms,
spinners) behind a capability check with a graceful fallback — never make a tool
hard-fail because a nicety isn't installed.

## Bash specifics

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Source shared helpers by resolving the script's *real* path first (it will be run
  via a symlink), then sourcing `../lib/common.sh` relative to the real location.
- Keep tools dependency-light: assume a POSIX environment plus the tool's own domain
  binary (e.g. `git` for git tools). Check for required binaries up front.
