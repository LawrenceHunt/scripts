#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["pytubefix>=8.12", "rich>=13"]
# ///
"""
ytdl — download a YouTube video at the highest resolution available, ad free.

YouTube only serves high resolutions as separate video and audio streams, so
both are downloaded and merged into one .mp4 with ffmpeg (no re-encoding).
With --audio, only the best audio stream is saved (.m4a, no ffmpeg needed).

Progress goes to stderr. When stdout is piped, the saved file paths are
printed there, one per line, so other tools can consume them.

Runs via mise (provides python + uv) and uv (resolves the inline dependencies
above into a cached environment), so there is nothing to install by hand
beyond ffmpeg.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from pytubefix import YouTube, exceptions
from rich.console import Console
from rich.progress import (
    BarColumn,
    DownloadColumn,
    Progress,
    TextColumn,
    TimeRemainingColumn,
    TransferSpeedColumn,
)

console = Console(stderr=True)
PROG = os.path.basename(sys.argv[0])


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description="Download YouTube videos at the highest resolution available.",
    )
    parser.add_argument("urls", nargs="+", metavar="URL", help="one or more YouTube URLs")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path.home() / "Movies",
        help="directory to save into (default: ~/Movies)",
    )
    parser.add_argument("--audio", action="store_true", help="save audio only (.m4a)")
    return parser.parse_args()


def pick_streams(yt: YouTube):
    """Best mp4 video stream and best mp4 audio stream."""
    video = (
        yt.streams.filter(adaptive=True, only_video=True, mime_type="video/mp4")
        .order_by("resolution")
        .desc()
        .first()
    )
    audio = yt.streams.filter(only_audio=True, mime_type="audio/mp4").order_by("abr").desc().first()
    return video, audio


def fetch(yt: YouTube, stream, label: str, folder: str, filename: str) -> str:
    """Download one stream with a progress bar. Returns the file path."""
    with Progress(
        TextColumn(f"   {label}"),
        BarColumn(),
        DownloadColumn(),
        TransferSpeedColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(label, total=stream.filesize)
        yt.register_on_progress_callback(
            lambda s, _chunk, remaining: progress.update(task, completed=s.filesize - remaining)
        )
        return stream.download(output_path=folder, filename=filename)


def download_audio(yt: YouTube, output: Path) -> Path | None:
    """Save the best mp4 audio stream as .m4a. Returns the path."""
    audio = yt.streams.filter(only_audio=True, mime_type="audio/mp4").order_by("abr").desc().first()
    if audio is None:
        console.print("[bold red]❌ No audio stream found.[/]")
        return None
    console.print(f"   🎬 [bold]{yt.title}[/]")
    console.print(f"   [dim]{yt.author} · {audio.abr} audio · {audio.filesize_mb:.1f} MB[/]")
    target = output / f"{audio.default_filename.rsplit('.', 1)[0]}.m4a"
    if target.exists():
        console.print(f"[yellow]⚠️  Already exists, skipping:[/] {target}")
        return target
    started = time.monotonic()
    fetch(yt, audio, "🔊 audio", str(output), target.name)
    console.print(f"[bold green]✅ Saved[/] {target} [dim]({time.monotonic() - started:.1f}s)[/]")
    return target


def download(url: str, output: Path, audio_only: bool = False) -> Path | None:
    """Download one video. Returns the saved path, or None on failure."""
    console.print(f"\n[bold cyan]🔍 Looking up[/] [dim]{url}[/]")
    try:
        with console.status("⏳ Fetching video info…"):
            yt = YouTube(url)
            video, audio = pick_streams(yt)
        if audio_only:
            return download_audio(yt, output)
        if video is None or audio is None:
            console.print("[bold red]❌ No downloadable video/audio streams found.[/]")
            return None

        total_mb = video.filesize_mb + audio.filesize_mb
        console.print(f"   🎬 [bold]{yt.title}[/]")
        console.print(
            f"   [dim]{yt.author} · {video.resolution} {video.fps}fps · "
            f"{audio.abr} audio · {total_mb:.1f} MB[/]"
        )

        target = output / f"{video.default_filename.rsplit('.', 1)[0]}.mp4"
        if target.exists():
            console.print(f"[yellow]⚠️  Already exists, skipping:[/] {target}")
            return target

        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="ytdl-") as tmp:
            video_path = fetch(yt, video, "🎞️  video", tmp, "video.mp4")
            audio_path = fetch(yt, audio, "🔊 audio", tmp, "audio.m4a")
            merged = os.path.join(tmp, "merged.mp4")
            with console.status("⏳ Merging with ffmpeg…"):
                result = subprocess.run(
                    ["ffmpeg", "-v", "error", "-y", "-i", video_path, "-i", audio_path,
                     "-c", "copy", "-movflags", "+faststart", merged],
                    capture_output=True,
                    text=True,
                )
            if result.returncode != 0:
                console.print(f"[bold red]❌ ffmpeg failed:[/] {result.stderr.strip()}")
                return None
            shutil.move(merged, target)

        elapsed = time.monotonic() - started
        console.print(f"[bold green]✅ Saved[/] {target} [dim]({elapsed:.1f}s)[/]")
        return target

    except (exceptions.PytubeFixError, OSError) as e:
        console.print(f"[bold red]❌ {type(e).__name__}:[/] {e}")
        return None


def main() -> int:
    args = parse_args()
    if not args.audio and shutil.which("ffmpeg") is None:
        console.print("[bold red]❌ ffmpeg is required to merge video and audio.[/]")
        console.print("   Install with: [cyan]brew install ffmpeg[/]")
        return 1
    output = args.output.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=True)
    console.print(f"[bold]📁 Saving to[/] {output}")

    saved = [download(url, output, args.audio) for url in args.urls]
    if not sys.stdout.isatty():
        for path in filter(None, saved):
            print(path, flush=True)
    ok = sum(1 for path in saved if path)
    failed = len(args.urls) - ok

    console.print(f"\n📊 [green]{ok} downloaded[/]" + (f", [red]{failed} failed[/]" if failed else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
