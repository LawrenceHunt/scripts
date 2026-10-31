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
  ai/
    yt-summary         # yt-transcript URL | summarise
node/
  package.json         # shared deps for every node tool (node_modules is gitignored)
  lib/
    ui.mjs             # palette, spinner, progress bar, sizes, gum confirm/choose
  media/
    img-opt            # resize/convert images with sharp
    vid-opt            # re-encode video for the web with ffmpeg
    glb-opt            # shrink .glb 3D models with gltf-transform
    pdf-opt            # compress PDFs with Ghostscript
python/
  lib/
    scriptlib.py       # stderr console, stdout emit, .env, cache, gum confirm/choose
  media/
    ytdl               # download YouTube videos (merges streams with ffmpeg)
  ai/
    yt-transcript      # captions, or ytdl --audio | transcribe as a fallback
    transcribe         # audio/video -> text (OpenAI)
    summarise          # text -> summary (Anthropic or OpenAI, whichever key is set)
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

Python tools import `python/lib/scriptlib.py` by resolving their real path:
`sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))`.
Each tool still lists every third-party package it imports (including `rich`,
which scriptlib uses) in its own PEP 723 block.

When bumping a version, change it in `mise.toml` and in the shebangs together.
`mise run install` is an alias for `./install.sh`.

## Output & interaction conventions

Every tool should feel like it belongs to the same family:

- **Colour** — use it to structure output (headings, success, warning, error,
  dim detail). Bash tools source `bash/lib/common.sh` for the palette; Python
  uses `python/lib/scriptlib.py` (rich) and Node `node/lib/ui.mjs`.
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

## Composable tools (stdout is data, stderr is for humans)

Tools that produce data are built to pipe into each other
(`yt-transcript URL | summarise`, `ytdl --audio URL | transcribe`):

- **stdout carries only the data** — text, or file paths one per line. Every
  spinner, progress bar, emoji and error goes to **stderr** (Python:
  `scriptlib.console`, which is a stderr `rich.Console`; write data with `emit`).
- Text flows through pipes; binary media is passed as a **file path**.
- A tool that prints decoration in a terminal but paths when piped decides by
  `sys.stdout.isatty()` (see `ytdl`).
- Read input from a file argument or stdin; refuse an interactive stdin with a
  usage hint rather than hanging (`scriptlib.read_input`).
- Cache paid or slow work in `~/.cache/scripts/<kind>/` keyed by content hash or
  ID, with a `--no-cache` flag.
- Compositions of other tools are small bash scripts (see `bash/ai/yt-summary`);
  Python tools that need another tool call it by path via `scriptlib.tool(name)`.

## Secrets: `.env`

API keys live in `.env` at the repo root, which is **gitignored and must never be
committed**; `.env.example` (committed) lists the variable names. Tools load it
with `scriptlib.load_env()` from any directory; variables already set in the
shell take priority. Never print a key, and check `git status` before committing.

## Optional dependency: gum

[`gum`](https://github.com/charmbracelet/gum) (Charmbracelet) is a **recommended but
optional** enhancement. When it's installed, the shared bash helpers use it for
interactive dropdowns (`menu`), confirmations (`confirm`), and spinners
(`run_with_spinner`). When it's absent, every helper falls back to a pure-bash
implementation, so tools must never *require* it. `install.sh` detects it and
prints the `brew install gum` hint if missing.

Every language has the same gum-backed prompt helpers, each with a fallback:

| | single choice | multi choice | yes/no | spinner |
| --- | --- | --- | --- | --- |
| bash (`common.sh`) | `menu` | `multi_select` | `confirm` | `run_with_spinner` |
| python (`scriptlib`) | `choose` | — | `confirm` | `console.status` (rich) |
| node (`ui.mjs`) | `choose` | — | `confirm` | `withSpinner`, `progressBar` |

Prompts talk to `/dev/tty`, so they work mid-pipeline; with no terminal they
return the default (or cancel) instead of blocking. Use a prompt where it saves
the user from a surprise (spending money, deleting something, a guess), not
for its own sake. Non-interactive runs must still do something sensible.

Rule of thumb: reach for a CLI library for **interactive** flair (pickers, forms,
spinners) behind a capability check with a graceful fallback — never make a tool
hard-fail because a nicety isn't installed.

## Bash specifics

- Start with `#!/usr/bin/env bash` and `set -euo pipefail`.
- Source shared helpers by resolving the script's *real* path first (it will be run
  via a symlink), then sourcing `../lib/common.sh` relative to the real location.
- Keep tools dependency-light: assume a POSIX environment plus the tool's own domain
  binary (e.g. `git` for git tools). Check for required binaries up front.
