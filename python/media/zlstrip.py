#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["rich>=13"]
# ///
"""
zlstrip — remove the z-library tag from downloaded file names.

Renames files in place, e.g. "Dune (z-library.sk, 1lib.sk, z-lib.sk).epub"
becomes "Dune.epub". Files whose cleaned name already exists are skipped.

    zlstrip                 # ~/Downloads
    zlstrip ~/Books
"""

import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
from scriptlib import console, fail, prog_name

TAG = "(z-library.sk, 1lib.sk, z-lib.sk)"
TAG_RE = re.compile(r"\s*" + re.escape(TAG))

DEFAULT_FOLDER = "~/Downloads"


def main() -> int:
    parser = argparse.ArgumentParser(
        prog=prog_name(),
        description="Remove the z-library tag from downloaded file names.",
    )
    parser.add_argument(
        "folder",
        nargs="?",
        default=DEFAULT_FOLDER,
        help=f"folder to search (default: {DEFAULT_FOLDER})",
    )
    args = parser.parse_args()

    folder = Path(args.folder).expanduser()
    if not folder.is_dir():
        fail(f"Not a folder: {folder}")

    console.print(f"[bold]🔍 Scanning[/] [cyan]{folder}[/]")
    renamed = skipped = 0
    for file in sorted(folder.iterdir()):
        if TAG not in file.name:
            continue
        target = file.with_name(TAG_RE.sub("", file.name))
        if target.exists():
            console.print(
                f"[yellow]⚠️  Skipped[/] {file.name} [dim](already exists: {target.name})[/]"
            )
            skipped += 1
            continue
        file.rename(target)
        console.print(f"[green]✅[/] {target.name}")
        renamed += 1

    if renamed == skipped == 0:
        console.print("[dim]Nothing to rename.[/]")
    else:
        console.print(f"📊 [bold]{renamed}[/] renamed, [bold]{skipped}[/] skipped")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
