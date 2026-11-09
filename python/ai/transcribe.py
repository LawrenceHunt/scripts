#!/usr/bin/env -S mise exec python@3.13 uv@0.11 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["openai>=2.8", "rich>=13"]
# ///
"""
transcribe — turn an audio (or video) file into text with OpenAI.

The file is re-encoded to mono 16 kHz speech-quality mp3 and split into
10-minute chunks with ffmpeg, which keeps every request well under the API's
size and duration limits. Chunks are transcribed in parallel and joined.

Transcripts are cached by file hash + model in ~/.cache/scripts/transcripts,
so re-running on the same file is free.

    transcribe talk.m4a > talk.txt
    ytdl --audio URL | transcribe | summarise
"""

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
from openai import OpenAI
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn
from scriptlib import cache_path, console, emit, fail, load_env, prog_name, require_env

CHUNK_SECONDS = 600
WORKERS = 4


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=prog_name(),
        description=(
            "Transcribe audio/video files to text (stdout). Reads paths from stdin if none given."
        ),
    )
    parser.add_argument("files", nargs="*", metavar="FILE", help="audio or video files")
    parser.add_argument(
        "--model",
        default="gpt-4o-transcribe",
        help="OpenAI transcription model (default: %(default)s)",
    )
    parser.add_argument(
        "--no-cache", action="store_true", help="ignore and overwrite any cached transcript"
    )
    return parser.parse_args()


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()[:32]


def split_audio(source: Path, folder: str) -> list[Path]:
    """Re-encode to speech-quality mono mp3 chunks. Returns them in order."""
    pattern = os.path.join(folder, "chunk_%03d.mp3")
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(source),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "32k",
            "-f",
            "segment",
            "-segment_time",
            str(CHUNK_SECONDS),
            pattern,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        fail("ffmpeg could not read the file.", result.stderr.strip())
    return sorted(Path(folder).glob("chunk_*.mp3"))


def transcribe_file(client: OpenAI, path: Path, model: str, use_cache: bool) -> str:
    console.print(f"[bold cyan]🎙️  Transcribing[/] {path.name}")
    with console.status("⏳ Hashing…"):
        cached = cache_path("transcripts", f"{file_hash(path)}-{model}")
    if use_cache and cached.exists():
        console.print(f"   [dim]Using cached transcript ({cached})[/]")
        return cached.read_text()

    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="transcribe-") as tmp:
        with console.status("⏳ Preparing audio with ffmpeg…"):
            chunks = split_audio(path, tmp)
        console.print(
            f"   [dim]{len(chunks)} chunk(s) of up to {CHUNK_SECONDS // 60} min · model {model}[/]"
        )

        def run(chunk: Path) -> str:
            with chunk.open("rb") as fh:
                return client.audio.transcriptions.create(model=model, file=fh).text

        with Progress(
            TextColumn("   📝"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("chunks", total=len(chunks))
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                futures = [pool.submit(run, chunk) for chunk in chunks]
                for future in futures:
                    future.add_done_callback(lambda _f: progress.advance(task))
                texts = [future.result() for future in futures]

    text = "\n".join(t.strip() for t in texts if t.strip())
    cached.write_text(text)
    elapsed = time.monotonic() - started
    console.print(
        f"[bold green]✅ Transcribed[/] {len(text.split()):,} words [dim]({elapsed:.1f}s)[/]"
    )
    return text


def main() -> int:
    args = parse_args()
    load_env()
    if shutil.which("ffmpeg") is None:
        fail("ffmpeg is required.", "Install with: brew install ffmpeg")

    files = args.files
    if not files:
        if sys.stdin.isatty():
            fail("No file given.", f"Usage: {prog_name()} FILE, or pipe paths in.")
        files = [line.strip() for line in sys.stdin if line.strip()]

    client = OpenAI(api_key=require_env("OPENAI_API_KEY"), max_retries=3, timeout=600)
    for name in files:
        path = Path(name).expanduser()
        if not path.is_file():
            fail(f"Not a file: {path}")
        emit(transcribe_file(client, path, args.model, not args.no_cache))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
