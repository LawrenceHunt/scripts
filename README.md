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
| `pdf2text` | Extracts the text of a PDF |
| `speak` | Turns text into an mp3 with ElevenLabs |
| `yt-summary` | `yt-transcript URL \| summarise`, in one command (`--speak` to hear it) |
| `pdf-summary` | `pdf2text FILE \| summarise`, in one command (`--speak` to hear it) |
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

### AI tools: yt-transcript, transcribe, pdf2text, summarise, speak, *-summary

Small pieces that pipe into each other. Data goes to stdout; progress goes to stderr.

```sh
yt-summary URL                              # transcript → 500-word summary
yt-summary URL --words 150 --prompt "just the investing advice"
yt-transcript URL > talk.txt                # captions if available, else Whisper
transcribe meeting.m4a | summarise          # any local audio or video
summarise notes.txt --provider anthropic    # force a provider
pdf-summary book.pdf --pages 1-40 --speak   # summarise chapters, then read it aloud
pdf2text report.pdf > report.txt
summarise notes.txt | speak --play          # any text to speech
speak summary.txt -o out.mp3 --voice Sarah  # or --pick-voice for a menu
```

- `yt-transcript` uses the video's own captions when it can: instant and free. Without
  them it runs `ytdl --audio` then `transcribe`. `--no-captions` forces that route.
- `transcribe` re-encodes to speech-quality mono and splits into 10-minute chunks
  that run in parallel (default model `gpt-4o-transcribe`).
- `summarise` uses Claude (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set,
  otherwise OpenAI (`gpt-5.5`). Override with `--provider`, `--model` or
  `SUMMARISE_PROVIDER`. It drops sponsor reads and filler and streams as it writes.
- `pdf2text` takes `--pages 1-20,25`. It warns about pages with no text layer and
  stops if the whole PDF is scanned, since that needs OCR first.
- `speak` uses ElevenLabs (default voice George, `eleven_multilingual_v2`). Before
  spending, it shows the character count against your remaining quota. It asks
  first if a job is over 5,000 characters or would exceed the quota (`--yes` skips
  that; non-interactive runs require it). Long text is split at sentence ends and
  voiced with its neighbours as context, so the joins sound natural.
  `--list-voices` lists the voices on your account.
- Transcripts and speech are cached in `~/.cache/scripts/`, so re-running costs
  nothing. `--no-cache` skips the cache.

### Chaining tools

Every AI tool reads stdin and writes plain data to stdout. Progress, prompts and
errors go to stderr, so they still show in a pipeline without getting mixed into
the data. Text flows through the pipe as text. Audio is passed as a file path:
`ytdl --audio` and `speak` print the path of the file they saved when their
output is piped.

#### YouTube

```sh
# Download audio, transcribe it, summarise it: the long way round yt-summary
ytdl --audio URL | transcribe | summarise

# Keep the transcript and the summary
yt-transcript URL | tee talk.txt | summarise --words 200 > summary.txt

# Compare several videos in one summary (each transcript starts with "# <title>")
cat urls.txt | xargs -n1 yt-transcript | summarise --prompt "Compare their arguments"

# A spoken briefing of a video, to listen to later
yt-transcript URL | summarise --words 300 | speak -o briefing.mp3
```

#### Meetings and other audio

```sh
# Action items from a recording, read back to you
transcribe meeting.m4a | summarise --prompt "Just the decisions and action items, as bullets" | speak --play

# Transcribe a batch of files (transcribe takes paths on stdin, one per line)
ls ~/Recordings/*.m4a | transcribe > all-transcripts.txt
```

#### PDFs and documents

```sh
# One chapter as an audiobook-style summary
pdf2text book.pdf --pages 40-75 | summarise --words 400 | speak -o chapter-3.mp3

# Search a PDF's text
pdf2text report.pdf | grep -i "revenue"
```

#### Clipboard and everything else

```sh
# Summarise whatever you just copied, and put the summary back on the clipboard
pbpaste | summarise --words 100 | pbcopy

# Hear any text
pbpaste | speak --play

# speak prints its mp3 path when piped, so it can feed another command
summarise notes.txt | speak | xargs afplay
```

`yt-summary` and `pdf-summary` are just the most common chains packaged as
commands. Add `--speak` to either to hear the result.

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
    yt-summary  pdf-summary
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
    yt-transcript  transcribe  pdf2text  summarise  speak
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
