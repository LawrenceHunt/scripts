#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["elevenlabs>=2.20", "rich>=13"]
# ///
"""
speak — turn text from stdin (or a file) into an mp3 with ElevenLabs.

Long text is split on sentence boundaries into chunks that are voiced with
their neighbours as context (so joins sound natural) and stitched with
ffmpeg. Before spending anything it shows the character count against your
remaining ElevenLabs quota, and asks first if the job is large or would
exceed it. Audio is cached by text + voice + model in ~/.cache/scripts/speech.

When stdout is piped, the saved mp3 path is printed there.

    summarise notes.txt | speak --play
    speak summary.txt -o summary.mp3 --voice Sarah
    speak --list-voices
"""

import argparse
import hashlib
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path
from typing import cast

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
from elevenlabs.client import ElevenLabs
from elevenlabs.core import ApiError
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeElapsedColumn
from scriptlib import (
    cache_path,
    choose,
    confirm,
    console,
    emit,
    fail,
    interactive,
    load_env,
    prog_name,
    read_input,
    require_env,
)

DEFAULT_VOICE = "JBFqnCBsd6RMkjVDRZzb"  # George — warm storyteller
DEFAULT_MODEL = "eleven_multilingual_v2"
CHUNK_CHARS = 4000
CONFIRM_ABOVE = 5000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=prog_name(),
        description="Text to speech (mp3) with ElevenLabs. Reads stdin if no file is given.",
    )
    parser.add_argument("file", nargs="?", help="text file (default: stdin)")
    parser.add_argument(
        "-o", "--output", type=Path, help="mp3 path (default: ./speech-<timestamp>.mp3)"
    )
    parser.add_argument(
        "--voice", default=DEFAULT_VOICE, help="voice name (e.g. Sarah) or ID (default: George)"
    )
    parser.add_argument("--pick-voice", action="store_true", help="choose a voice from a list")
    parser.add_argument(
        "--model", default=DEFAULT_MODEL, help="ElevenLabs model (default: %(default)s)"
    )
    parser.add_argument(
        "--play", action="store_true", help="play the result when done (macOS afplay)"
    )
    parser.add_argument("-y", "--yes", action="store_true", help="don't ask before large jobs")
    parser.add_argument(
        "--list-voices", action="store_true", help="print available voices and exit"
    )
    parser.add_argument("--no-cache", action="store_true", help="always generate fresh audio")
    return parser.parse_args()


def resolve_voice(client: ElevenLabs, wanted: str, pick: bool) -> tuple[str, str]:
    """(voice_id, display name) from a name, an ID, or an interactive pick."""
    # (voice_id, name); the API's name is optional, so fall back to the ID.
    voices = [(v.voice_id, v.name or v.voice_id) for v in client.voices.get_all().voices]
    if pick:
        picked = choose("Which voice?", [name for _, name in voices])
        if picked is None:
            fail("Cancelled.", code=130)
        return voices[picked]
    for voice_id, name in voices:
        short = name.split(" - ")[0].strip().lower()
        if wanted == voice_id or wanted.lower() in (short, name.lower()):
            return voice_id, name
    if re.fullmatch(r"[A-Za-z0-9]{20}", wanted):
        return wanted, wanted  # an ID not in the account's list (e.g. library voice)
    names = ", ".join(name.split(" - ")[0] for _, name in voices)
    fail(f"Unknown voice: {wanted}", f"Available: {names}")


def split_text(text: str, limit: int = CHUNK_CHARS) -> list[str]:
    """Chunks under `limit` chars, broken at paragraph, then sentence, ends."""
    chunks: list[str] = []
    current = ""
    for piece in re.split(r"(?<=[.!?…])\s+|\n{2,}", text):
        sentence = piece.strip()
        if not sentence:
            continue
        while len(sentence) > limit:  # pathological run-on: hard split on a space
            cut = sentence.rfind(" ", 0, limit)
            cut = cut if cut > 0 else limit
            chunks.append(sentence[:cut].strip())
            sentence = sentence[cut:].strip()
        if current and len(current) + 1 + len(sentence) > limit:
            chunks.append(current)
            current = sentence
        else:
            current = f"{current} {sentence}".strip()
    if current:
        chunks.append(current)
    return chunks


def remaining_quota(client: ElevenLabs) -> tuple[int, int] | None:
    try:
        sub = client.user.subscription.get()
        return sub.character_limit - sub.character_count, sub.character_limit
    except ApiError:
        return None  # key may lack the user_read permission; not fatal


def synthesise(client: ElevenLabs, chunks: list[str], voice_id: str, model: str, out: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="speak-") as tmp:
        parts: list[Path] = []
        with Progress(
            TextColumn("   🔊"),
            BarColumn(),
            MofNCompleteColumn(),
            TimeElapsedColumn(),
            console=console,
        ) as progress:
            task = progress.add_task("chunks", total=len(chunks))
            for i, chunk in enumerate(chunks):
                audio = client.text_to_speech.convert(
                    voice_id=voice_id,
                    model_id=model,
                    text=chunk,
                    output_format="mp3_44100_128",
                    previous_text=chunks[i - 1][-500:] if i > 0 else None,
                    next_text=chunks[i + 1][:500] if i + 1 < len(chunks) else None,
                )
                part = Path(tmp) / f"part_{i:03d}.mp3"
                part.write_bytes(b"".join(audio))
                parts.append(part)
                progress.advance(task)

        if len(parts) == 1:
            shutil.copyfile(parts[0], out)
            return
        listing = Path(tmp) / "parts.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts))
        result = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "0",
                "-i",
                str(listing),
                "-c",
                "copy",
                str(out),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            fail("ffmpeg could not join the audio.", result.stderr.strip())


def api_error_message(body: object) -> str | None:
    """The human-readable message from an ElevenLabs error body, if any.

    Bodies look like {"detail": {"message": "..."}} or {"detail": "..."}."""
    if not isinstance(body, dict):
        return None
    detail = cast(dict[str, object], body).get("detail")
    if isinstance(detail, dict):
        message = cast(dict[str, object], detail).get("message")
        return str(message) if message else None
    return str(detail) if detail else None


def main() -> int:
    args = parse_args()
    load_env()
    client = ElevenLabs(api_key=require_env("ELEVENLABS_API_KEY"))

    try:
        if args.list_voices:
            for v in client.voices.get_all().voices:
                emit(f"{v.voice_id}\t{v.name}")
            return 0

        text = re.sub(r"[ \t]+", " ", read_input(args.file)).strip()
        if not text:
            fail("Input is empty.")
        chunks = split_text(text)
        if len(chunks) > 1 and shutil.which("ffmpeg") is None:
            fail("ffmpeg is required to join long audio.", "Install with: brew install ffmpeg")

        voice_id, voice_name = resolve_voice(client, args.voice, args.pick_voice)
        out = (
            (args.output or Path(f"speech-{datetime.now():%Y%m%d-%H%M%S}.mp3"))
            .expanduser()
            .resolve()
        )
        out.parent.mkdir(parents=True, exist_ok=True)

        chars = len(text)
        console.print(
            f"[bold cyan]🗣️  Speaking[/] {chars:,} characters in {len(chunks)} chunk(s) "
            f"[dim]({voice_name.split(' - ')[0]} · {args.model})[/]"
        )

        key = hashlib.sha256(f"{voice_id}\n{args.model}\n{text}".encode()).hexdigest()[:32]
        cached = cache_path("speech", key, ".mp3")
        if cached.exists() and not args.no_cache:
            console.print("   [dim]Using cached audio — no characters spent.[/]")
            shutil.copyfile(cached, out)
        else:
            quota = remaining_quota(client)
            if quota:
                left, limit = quota
                console.print(f"   📊 Quota: {left:,} of {limit:,} characters left this period")
                if chars > left:
                    console.print(
                        f"   [yellow]⚠️  This needs {chars:,} — more than you have left.[/]"
                    )
                    if not (
                        args.yes
                        or confirm("Try anyway? ElevenLabs will likely refuse part-way.", False)
                    ):
                        fail("Not enough quota — nothing spent.")
            if chars > CONFIRM_ABOVE and not args.yes:
                if not interactive():
                    fail(f"{chars:,} characters is a large job.", "Re-run with --yes to confirm.")
                if not confirm(f"Spend {chars:,} ElevenLabs characters on this?", False):
                    fail("Cancelled — nothing spent.", code=130)

            started = time.monotonic()
            synthesise(client, chunks, voice_id, args.model, out)
            shutil.copyfile(out, cached)
            console.print(f"   [dim]Took {time.monotonic() - started:.1f}s[/]")

    except ApiError as e:
        fail(f"ElevenLabs error ({e.status_code}): {api_error_message(e.body) or e}")

    size_kb = out.stat().st_size / 1024
    console.print(f"[bold green]✅ Saved[/] {out} [dim]({size_kb:,.0f} KB)[/]")
    if not sys.stdout.isatty():
        print(out, flush=True)
    if args.play:
        if shutil.which("afplay"):
            console.print("   ▶️  Playing… [dim](Ctrl-C to stop)[/]")
            subprocess.run(["afplay", str(out)], check=False)
        else:
            console.print("[yellow]⚠️  --play needs macOS afplay.[/]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
