"""
check_deps — fail if a tool's PEP 723 deps and pyproject's dev group disagree.

Each Python tool runs in its own uv environment built from its inline
`# /// script` block, while the IDE, pyright and `python3 <tool>.py` use the
repo .venv built from `[dependency-groups].dev`. This keeps the two lists in
step: same packages, same version specifiers. Run by `mise run lint`; not a
command, so it lives in lib/ and is never installed.
"""

import re
import sys
import tomllib
from pathlib import Path

from rich.markup import escape
from scriptlib import REPO_DIR, console

# The reference regex from PEP 723.
BLOCK_RE = re.compile(r"(?m)^# /// (?P<type>[a-zA-Z0-9-]+)$\s(?P<content>(^#(| .*)$\s)+)^# ///$")
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*")


def parse(requirement: str) -> tuple[str, str]:
    """Split "Rich >= 13" into its normalised name and specifier: ("rich", ">=13")."""
    match = NAME_RE.match(requirement.strip())
    if not match:
        raise ValueError(f"can't parse requirement: {requirement!r}")
    name = re.sub(r"[-_.]+", "-", match.group()).lower()
    return name, re.sub(r"\s+", "", requirement.strip()[match.end() :])


def inline_deps(path: Path) -> list[str] | None:
    """The dependencies in a file's PEP 723 block, or None if it has no block."""
    for match in BLOCK_RE.finditer(path.read_text()):
        if match.group("type") == "script":
            toml = "".join(
                line[2:] if line.startswith("# ") else line[1:]
                for line in match.group("content").splitlines(keepends=True)
            )
            deps: list[str] = tomllib.loads(toml).get("dependencies", [])
            return deps
    return None


def main() -> int:
    pyproject = tomllib.loads((REPO_DIR / "pyproject.toml").read_text())
    dev_list: list[str] = pyproject["dependency-groups"]["dev"]
    dev = dict(parse(req) for req in dev_list)

    problems: list[str] = []
    used: set[str] = set()
    tools = sorted(p for p in (REPO_DIR / "python").glob("*/*.py") if p.parent.name != "lib")
    for tool in tools:
        rel = tool.relative_to(REPO_DIR)
        deps = inline_deps(tool)
        if deps is None:
            problems.append(f"{rel}: no `# /// script` block")
            continue
        for req in deps:
            name, spec = parse(req)
            used.add(name)
            if name not in dev:
                problems.append(f"{rel}: {req!r} is missing from [dependency-groups].dev")
            elif spec != dev[name]:
                problems.append(f"{rel}: {req!r} differs from dev's {name + dev[name]!r}")

    problems += [
        f"pyproject.toml: {name!r} is in [dependency-groups].dev but no tool uses it"
        for name in sorted(dev.keys() - used)
    ]

    if problems:
        for problem in problems:
            console.print(f"[red]❌ {escape(problem)}[/]")
        console.print(
            escape(
                "   Keep each tool's PEP 723 block and [dependency-groups].dev in step, "
                "then run `mise run setup`."
            )
        )
        return 1
    console.print(f"✅ Dependencies in step: {len(tools)} tools, {len(dev)} packages")
    return 0


if __name__ == "__main__":
    sys.exit(main())
