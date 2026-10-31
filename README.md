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

`install.sh` installs Node dependencies, then symlinks every tool into `~/.local/bin` by its basename (plus any short
aliases it declares) and tells you if that directory is not on your `PATH`. No `sudo`
needed. Re-run it after adding a tool.

API keys go in `.env` at the repo root (gitignored); copy `.env.example` to start.
The AI tools read it from wherever you run them.

Python and Node tools need [mise](https://mise.jdx.dev) (`brew install mise`). Each
one's shebang asks mise for the exact runtime it needs, so they work from any
directory regardless of what's active in your shell. `mise run install` does the
same as `./install.sh`.

Optional: [`gum`](https://github.com/charmbracelet/gum) (`brew install gum`). When it
is present, menus, confirmations and spinners use it. When it is absent, everything
falls back to plain bash, so no tool ever hard-fails for want of it.

## Tools

| Command | Does |
| --- | --- |
| `gprune` | Prunes local git branches whose remote branch has been deleted |
| `portkill` (`pk`) | Shows what is listening on your ports and kills it |
| `ytdl` | Downloads YouTube videos at the best available resolution |
| `yt-transcript` | Prints a YouTube video's transcript (captions, or transcribes the audio) |
| `transcribe` | Transcribes an audio or video file to text (OpenAI) |
| `summarise` | Summarises text from stdin or a file (Claude or OpenAI) |
| `yt-summary` | `yt-transcript URL \| summarise`, in one command |
| `img-opt` | Resizes and converts images (webp by default) |
| `vid-opt` | Re-encodes video for the web (H.264/AAC, optional webm + poster) |
| `glb-opt` | Shrinks `.glb` 3D models (simplify, quantise, meshopt, webp textures) |
| `pdf-opt` | Compresses PDFs with Ghostscript |

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

### ytdl

```sh
ytdl <url> [<url> ...]        # save into ~/Movies
ytdl -o . <url>               # save somewhere else
ytdl --audio <url>            # audio only (.m4a)
```

YouTube only serves high resolutions as separate video and audio streams, so `ytdl`
downloads the best mp4 video and audio and merges them with ffmpeg (stream copy, no
re-encode). Existing files are skipped. When stdout is piped, it prints the saved
paths, so `ytdl --audio URL | transcribe` works.

### AI tools: yt-transcript, transcribe, summarise, yt-summary

Small pieces that pipe into each other. Data goes to stdout; progress goes to stderr.

```sh
yt-summary URL                              # transcript → 500-word summary
yt-summary URL --words 150 --prompt "just the investing advice"
yt-transcript URL > talk.txt                # captions if available, else Whisper
transcribe meeting.m4a | summarise          # any local audio or video
summarise notes.txt --provider anthropic    # force a provider
```

- `yt-transcript` uses the video's own captions when it can: instant and free. Without
  them it runs `ytdl --audio` then `transcribe`. `--no-captions` forces that route.
- `transcribe` re-encodes to speech-quality mono and splits into 10-minute chunks
  that run in parallel (default model `gpt-4o-transcribe`).
- `summarise` uses Claude (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set,
  otherwise OpenAI (`gpt-5.5`). Override with `--provider`, `--model` or
  `SUMMARISE_PROVIDER`. It drops sponsor reads and filler and streams as it writes.
- Transcripts are cached in `~/.cache/scripts/`, so re-summarising with a different
  prompt costs nothing for the transcript. `--no-cache` skips the cache.

### img-opt / vid-opt / glb-opt / pdf-opt

```sh
img-opt --input ./photos [--output-dir out] [--output-fmt webp] [--quality 75]
vid-opt big.mov [out/] [--format mp4|webm|both] [--width 1280] [--crf 28]
glb-opt model.glb [model.optimized.glb]
pdf-opt doc.pdf [out.pdf] [--quality ebook]
```

`img-opt` writes to an `optimized/` folder next to the input by default and caps width
at 3000px; HEIC is decoded with macOS `sips`. `vid-opt --help` lists every option.

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
  ai/
    yt-summary
node/
  package.json         # shared deps (node_modules is gitignored)
  media/
    img-opt  vid-opt  glb-opt  pdf-opt
python/
  lib/
    scriptlib.py       # shared console/.env/cache helpers
  media/
    ytdl               # deps declared inline (PEP 723)
  ai/
    yt-transcript  transcribe  summarise
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

`bash` (3.2 is fine — macOS ships it), `mise` for the Python and Node tools, plus
whatever a tool's own domain needs: `git` for `gprune`, `lsof` for `portkill`, `ffmpeg`
for `ytdl` and `vid-opt`, Ghostscript for `pdf-opt`. Written and tested on macOS; the tools avoid
anything macOS-specific but Linux is untested.
