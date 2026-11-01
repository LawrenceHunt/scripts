#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["pymupdf>=1.24", "rich>=13"]
# ///
"""
pdf2text — extract the text of one or more PDFs to stdout.

Pages are separated by a blank line. Scanned PDFs (images with no text
layer) are detected and reported, since there is nothing to extract without
OCR.

    pdf2text book.pdf > book.txt
    pdf2text book.pdf --pages 1-30 | summarise --words 300
"""

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Protocol, cast

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
import pymupdf
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn
from scriptlib import console, emit, fail, prog_name


class PdfPage(Protocol):
    def get_text(self) -> str: ...  # default "text" mode always returns str


class PdfDocument(Protocol):
    """The parts of pymupdf.Document used here (its own annotations are loose)."""

    @property
    def needs_pass(self) -> bool: ...
    @property
    def page_count(self) -> int: ...
    @property
    def metadata(self) -> dict[str, str] | None: ...

    def __getitem__(self, index: int) -> PdfPage: ...


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=prog_name(),
        description="Extract text from PDFs (stdout).",
    )
    parser.add_argument("files", nargs="+", metavar="FILE", help="PDF files")
    parser.add_argument("--pages", help="page range, 1-based, e.g. 1-20 or 3,5,9-12 (default: all)")
    return parser.parse_args()


def page_numbers(spec: str | None, count: int) -> list[int]:
    """0-based page indexes for a spec like '1-3,7'."""
    if not spec:
        return list(range(count))
    pages: list[int] = []
    for raw in spec.split(","):
        part = raw.strip()
        try:
            if "-" in part:
                start, end = (int(x) for x in part.split("-", 1))
                pages.extend(range(start - 1, min(end, count)))
            else:
                pages.append(int(part) - 1)
        except ValueError:
            fail(f"Bad page range: {spec}", "Use e.g. 1-20 or 3,5,9-12")
    return [p for p in pages if 0 <= p < count]


def extract(path: Path, spec: str | None) -> str:
    try:
        doc = cast(PdfDocument, pymupdf.open(path))
    except Exception as e:  # pymupdf raises its own varied error types
        fail(f"Could not open {path.name}: {e}")
    if doc.needs_pass:
        fail(f"{path.name} is password-protected.")

    pages = page_numbers(spec, doc.page_count)
    if not pages:
        fail(f"No pages in range {spec} — {path.name} has {doc.page_count} pages.")
    title = (doc.metadata or {}).get("title") or path.stem
    console.print(
        f"[bold cyan]📄 Reading[/] {path.name} "
        f"[dim]({len(pages)} of {doc.page_count} pages · {title})[/]"
    )

    started = time.monotonic()
    texts: list[str] = []
    empty = 0
    with Progress(
        TextColumn("   📖"),
        BarColumn(),
        MofNCompleteColumn(),
        console=console,
        transient=True,
    ) as progress:
        task = progress.add_task("pages", total=len(pages))
        for index in pages:
            text = doc[index].get_text().strip()
            if not text:
                empty += 1
            texts.append(text)
            progress.advance(task)

    if pages and empty == len(pages):
        fail(
            f"No text found in {path.name}.",
            "It looks scanned (images only); it needs OCR first.",
        )
    if empty:
        console.print(f"   [yellow]⚠️  {empty} page(s) had no text (scanned images?)[/]")

    text = "\n\n".join(t for t in texts if t)
    elapsed = time.monotonic() - started
    console.print(
        f"[bold green]✅ Extracted[/] {len(text.split()):,} words [dim]({elapsed:.1f}s)[/]"
    )
    return text


def main() -> int:
    args = parse_args()
    for name in args.files:
        path = Path(name).expanduser()
        if not path.is_file():
            fail(f"Not a file: {path}")
        emit(extract(path, args.pages))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
