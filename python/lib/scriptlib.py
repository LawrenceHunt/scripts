"""
Shared helpers for the Python tools in this repo.

Tools find this module by resolving their own real path (they run via a
symlink in ~/.local/bin) and adding python/lib to sys.path:

    sys.path.insert(0, str(Path(os.path.realpath(__file__)).parents[1] / "lib"))
    from scriptlib import console, emit, load_env

Conventions: human-facing output (progress, emojis, errors) goes to stderr via
`console`; the tool's actual data goes to stdout via `emit`, so tools compose
in pipelines (`yt-transcript URL | summarise`).
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

from rich.console import Console

REPO_DIR = Path(__file__).resolve().parents[2]
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "scripts"

console = Console(stderr=True)


def prog_name() -> str:
    """The command name for usage text: argv[0] without directory or extension.

    Tools run via ~/.local/bin/<name> (no extension) or by repo path
    (python/ai/summarise.py); both show as `summarise`."""
    return Path(sys.argv[0]).stem


def emit(text: str) -> None:
    """Write data to stdout (never progress or decoration)."""
    sys.stdout.write(text)
    if not text.endswith("\n"):
        sys.stdout.write("\n")
    sys.stdout.flush()


def load_env() -> None:
    """Load REPO_DIR/.env into os.environ. Variables already set win."""
    path = REPO_DIR / ".env"
    if not path.is_file():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.removeprefix("export ").strip()
        value = value.strip().strip("'\"")
        if key and value:
            os.environ.setdefault(key, value)


def require_env(name: str, hint: str = "") -> str:
    """Return an env var or exit with a clear message."""
    value = os.environ.get(name)
    if not value:
        fail(f"{name} is not set.", hint or f"Add it to {REPO_DIR / '.env'}")
    return value


def cache_path(kind: str, key: str, suffix: str = ".txt") -> Path:
    """~/.cache/scripts/<kind>/<key><suffix>, creating the directory."""
    folder = CACHE_DIR / kind
    folder.mkdir(parents=True, exist_ok=True)
    return folder / f"{key}{suffix}"


def tool(name: str) -> str:
    """Absolute path of another tool in this repo (by command name), for composing tools."""
    for path in sorted(REPO_DIR.glob(f"*/*/{name}.*")):
        if path.parent.name != "lib" and os.access(path, os.X_OK):
            return str(path)
    fail(f"Tool not found in repo: {name}")


def fail(message: str, hint: str = "", code: int = 1) -> NoReturn:
    """Print an error (and optional hint) to stderr and exit."""
    console.print(f"[bold red]❌ {message}[/]")
    if hint:
        console.print(f"   {hint}")
    sys.exit(code)


def interactive() -> bool:
    """True when we can prompt: stderr is a terminal and /dev/tty opens.

    Deliberately ignores stdin/stdout, so prompts work mid-pipeline
    (e.g. inside `yt-transcript URL | summarise`)."""
    if not sys.stderr.isatty():
        return False
    try:
        open("/dev/tty").close()
        return True
    except OSError:
        return False


def _gum() -> str | None:
    return shutil.which("gum")


def confirm(question: str, default: bool = False) -> bool:
    """Yes/no prompt (gum if installed). Returns the default when not interactive."""
    if not interactive():
        return default
    gum = _gum()
    if gum:
        with open("/dev/tty") as tty_in, open("/dev/tty", "w") as tty_out:
            rc = subprocess.run(
                [gum, "confirm", question, f"--default={'true' if default else 'false'}"],
                stdin=tty_in,
                stdout=tty_out,
                stderr=tty_out,
                check=False,
            ).returncode
        if rc == 130:
            raise KeyboardInterrupt
        return rc == 0
    hint = "[Y/n]" if default else "[y/N]"
    with open("/dev/tty") as tty_in:
        while True:
            console.print(f"[yellow]❓[/] {question} [dim]{hint}[/] ", end="")
            reply = tty_in.readline().strip().lower() or ("y" if default else "n")
            if reply in ("y", "yes", "n", "no"):
                return reply.startswith("y")
            console.print("[yellow]⚠️  Please answer y or n.[/]")


def choose(header: str, options: list[str]) -> int | None:
    """Single-select picker (gum if installed). Returns the index, or None if
    cancelled or not interactive."""
    if not options or not interactive():
        return None
    gum = _gum()
    if gum:
        # Items on stdin; gum reads keys from /dev/tty itself and prints the choice.
        with open("/dev/tty", "w") as tty_out:
            result = subprocess.run(
                # Same cursor glyph as bash/lib/common.sh, deliberately not ">".
                [gum, "choose", "--header", header, "--cursor", "❯ "],  # noqa: RUF001
                input="\n".join(options),
                stdout=subprocess.PIPE,
                stderr=tty_out,
                text=True,
                check=False,
            )
        if result.returncode == 130:
            raise KeyboardInterrupt
        picked = result.stdout.strip()
        return options.index(picked) if picked in options else None
    console.print(f"[yellow]❓[/] {header}")
    for i, option in enumerate(options, 1):
        console.print(f"   [cyan]{i}[/]) {option}")
    with open("/dev/tty") as tty_in:
        while True:
            console.print(f"   [dim]1-{len(options)}, or Enter to cancel:[/] ", end="")
            reply = tty_in.readline().strip()
            if not reply:
                return None
            if reply.isdigit() and 1 <= int(reply) <= len(options):
                return int(reply) - 1


def read_input(path: str | None, what: str = "text") -> str:
    """Read from a file argument or stdin; refuse an interactive stdin."""
    if path and path != "-":
        return Path(path).expanduser().read_text()
    if sys.stdin.isatty():
        fail(f"No {what} given.", f"Pass a file, or pipe {what} in.")
    return sys.stdin.read()
