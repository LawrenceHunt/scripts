#!/usr/bin/env -S mise exec python@3.13 uv@0.9 -- uv run --quiet --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["anthropic>=0.70", "openai>=2.8", "rich>=13"]
# ///
"""
summarise — summarise text from stdin (or a file) with Claude or OpenAI.

Provider: --provider, else $SUMMARISE_PROVIDER, else Anthropic when
ANTHROPIC_API_KEY is set, else OpenAI when OPENAI_API_KEY is set.
The summary streams to stdout as it is written.

    yt-transcript URL | summarise
    summarise notes.txt --words 200
    pdf2text book.pdf | summarise --prompt "List the key arguments as bullets"
"""

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
from scriptlib import console, fail, load_env, read_input  # noqa: E402

DEFAULT_MODELS = {"anthropic": "claude-opus-5-5", "openai": "gpt-5.5"}

SYSTEM = (
    "You summarise transcripts and documents for a busy reader. Lead with the "
    "main point, keep the speaker's or author's actual claims and numbers, and "
    "leave out sponsor reads, adverts, calls to like/subscribe and other filler. "
    "Write plain prose (short headings or bullets only where they genuinely help). "
    "Output only the summary, with no preamble."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog=os.path.basename(sys.argv[0]),
        description="Summarise text from stdin or a file. The summary streams to stdout.",
    )
    parser.add_argument("file", nargs="?", help="text file (default: stdin)")
    parser.add_argument("--words", type=int, default=500, help="target length in words (default: %(default)s)")
    parser.add_argument("--prompt", help="extra instructions, e.g. 'focus on the investing advice'")
    parser.add_argument("--provider", choices=["anthropic", "openai"], help="override provider selection")
    parser.add_argument("--model", help="override the provider's default model")
    return parser.parse_args()


def pick_provider(requested: str | None) -> str:
    choice = requested or os.environ.get("SUMMARISE_PROVIDER")
    if choice:
        return choice
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    fail("No API key found.", "Set ANTHROPIC_API_KEY or OPENAI_API_KEY in the repo's .env.")


def stream_anthropic(model: str, prompt: str):
    import anthropic

    client = anthropic.Anthropic()
    try:
        # fallbacks="default": if a safety classifier declines, the API re-runs
        # the request on Anthropic's recommended fallback model.
        with client.beta.messages.stream(
            model=model,
            max_tokens=16000,
            system=SYSTEM,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            extra_body={"fallbacks": "default"},
            messages=[{"role": "user", "content": prompt}],
        ) as stream:
            yield from stream.text_stream
            final = stream.get_final_message()
    except TypeError as e:
        # Raised by the SDK when no API key, token or `ant auth login` profile exists.
        if "authentication method" not in str(e):
            raise
        fail("No Anthropic credentials found.", "Set ANTHROPIC_API_KEY in the repo's .env.")
    except anthropic.AuthenticationError:
        fail("Anthropic rejected the API key.")
    except anthropic.RateLimitError:
        fail("Anthropic rate limit hit.", "Try again shortly.")
    except anthropic.APIStatusError as e:
        fail(f"Anthropic API error ({e.status_code}): {e.message}")
    except anthropic.APIConnectionError:
        fail("Could not reach the Anthropic API.")
    if final.stop_reason == "refusal":
        fail("The model declined to summarise this text.")
    if final.stop_reason == "max_tokens":
        console.print("[yellow]⚠️  Summary hit the token limit and may be cut off.[/]")


def stream_openai(model: str, prompt: str):
    import openai

    client = openai.OpenAI(max_retries=3)
    try:
        stream = client.chat.completions.create(
            model=model,
            stream=True,
            messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}],
        )
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
    except openai.AuthenticationError:
        fail("OpenAI rejected the API key.")
    except openai.RateLimitError:
        fail("OpenAI rate limit or quota hit.")
    except openai.APIStatusError as e:
        fail(f"OpenAI API error ({e.status_code}): {e.message}")
    except openai.APIConnectionError:
        fail("Could not reach the OpenAI API.")


def main() -> int:
    args = parse_args()
    load_env()
    text = read_input(args.file).strip()
    if not text:
        fail("Input is empty.")

    provider = pick_provider(args.provider)
    model = args.model or DEFAULT_MODELS[provider]
    instructions = f"Summarise the following in about {args.words} words."
    if args.prompt:
        instructions += f"\n\nAdditional instructions: {args.prompt}"
    prompt = f"{instructions}\n\n<document>\n{text}\n</document>"

    console.print(
        f"[bold cyan]🧠 Summarising[/] {len(text.split()):,} words → ~{args.words} "
        f"[dim]({provider} · {model})[/]"
    )
    started = time.monotonic()
    chunks = stream_anthropic(model, prompt) if provider == "anthropic" else stream_openai(model, prompt)

    status = console.status("⏳ Waiting for the first words…")
    status.start()
    written = []
    try:
        for piece in chunks:
            if status:
                status.stop()
                status = None
            sys.stdout.write(piece)
            sys.stdout.flush()
            written.append(piece)
    finally:
        if status:
            status.stop()
    if written and not written[-1].endswith("\n"):
        sys.stdout.write("\n")
    sys.stdout.flush()

    words = len("".join(written).split())
    console.print(f"[bold green]✅ Done[/] [dim]({words:,} words, {time.monotonic() - started:.1f}s)[/]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        console.print("\n[yellow]⚠️  Cancelled.[/]")
        sys.exit(130)
