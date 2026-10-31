#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["pytubefix>=8.12", "rich>=13"]
# ///
"""
yt-transcript — print a YouTube video's transcript to stdout.

Uses the video's own captions when it has them (instant and free), preferring
manual over auto-generated ones in the requested language. If there are only
captions in other languages, it asks which to use (or whether to transcribe
instead). With no captions at all it falls back to `ytdl --audio | transcribe`
(OpenAI, costs money, takes minutes). Prompts only appear in a terminal;
non-interactive runs go straight to transcription.

The first line is `# <video title>` so downstream tools have context; pass
--no-title to drop it. Results are cached per video in
~/.cache/scripts/yt-transcripts.

    yt-transcript URL | summarise
"""

import argparse
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
from scriptlib import cache_path, choose, console, emit, fail, interactive, tool  # noqa: E402

from pytubefix import YouTube, exceptions  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=os.path.basename(sys.argv[0]),
        description="Print a YouTube video's transcript (captions, or Whisper as a fallback).",
    )
    parser.add_argument("url", metavar="URL")
    parser.add_argument("--lang", default="en", help="caption language code (default: %(default)s)")
    parser.add_argument("--no-captions", action="store_true", help="skip captions; always transcribe the audio")
    parser.add_argument("--no-title", action="store_true", help="don't prefix the transcript with the title")
    parser.add_argument("--no-cache", action="store_true", help="ignore and overwrite any cached transcript")
    return parser.parse_args()


def caption_label(caption) -> str:
    kind = "auto-generated" if caption.code.startswith("a.") else "manual"
    return f"{caption.name} · {kind} ({caption.code})"


def from_captions(yt: YouTube, lang: str) -> str | None:
    with console.status("⏳ Checking captions…"):
        captions = list(yt.captions)
    for wanted in (lang, f"a.{lang}"):
        caption = next((c for c in captions if c.code == wanted or c.code.startswith(f"{wanted}-")), None)
        if caption:
            console.print(f"   💬 Using {caption_label(caption)}")
            return caption.generate_txt_captions()
    if not captions:
        console.print("   [dim]No captions on this video.[/]")
        return None

    console.print(f"   [yellow]⚠️  No '{lang}' captions.[/] [dim]Available: {', '.join(c.code for c in captions)}[/]")
    if not interactive():
        return None
    options = [caption_label(c) for c in captions] + ["🎧 Transcribe the audio instead (OpenAI, billed)", "Cancel"]
    picked = choose("Which transcript should I use?", options)
    if picked is None or picked == len(options) - 1:
        fail("Cancelled.", code=130)
    if picked == len(captions):
        return None
    console.print(f"   💬 Using {options[picked]}")
    return captions[picked].generate_txt_captions()


def from_audio(url: str) -> str:
    console.print("   🎧 Falling back to audio transcription [dim](OpenAI, billed)[/]")
    with tempfile.TemporaryDirectory(prefix="yt-transcript-") as tmp:
        dl = subprocess.run([tool("ytdl"), "--audio", "-o", tmp, url], stdout=subprocess.PIPE, text=True)
        audio = dl.stdout.strip().splitlines()
        if dl.returncode != 0 or not audio:
            fail("Audio download failed.")
        tr = subprocess.run([tool("transcribe"), audio[0]], stdout=subprocess.PIPE, text=True)
        if tr.returncode != 0:
            fail("Transcription failed.")
        return tr.stdout.strip()


def main() -> int:
    args = parse_args()
    console.print(f"[bold cyan]🔍 Looking up[/] [dim]{args.url}[/]")
    try:
        with console.status("⏳ Fetching video info…"):
            yt = YouTube(args.url)
            title = yt.title
        console.print(f"   🎬 [bold]{title}[/]")

        source = "audio" if args.no_captions else "auto"
        cached = cache_path("yt-transcripts", f"{yt.video_id}-{args.lang}-{source}")
        if cached.exists() and not args.no_cache:
            console.print(f"   [dim]Using cached transcript ({cached})[/]")
            text = cached.read_text()
        else:
            text = None if args.no_captions else from_captions(yt, args.lang)
            if not text:
                text = from_audio(args.url)
            cached.write_text(text)
    except exceptions.PytubeFixError as e:
        fail(f"{type(e).__name__}: {e}")

    console.print(f"[bold green]✅ Transcript ready[/] [dim]({len(text.split()):,} words)[/]")
    emit(text if args.no_title else f"# {title}\n\n{text}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
