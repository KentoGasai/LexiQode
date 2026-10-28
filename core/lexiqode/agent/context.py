"""Cheap, bounded facts about the workspace, injected into the prompt.

The agent works far better when it knows the layout and the version-control
state up front, instead of spending its first three tool calls discovering them.
Everything here is best-effort: a missing ``git`` binary or a huge directory
degrades the snapshot rather than failing the turn.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .tools.fs import IGNORED_DIRS

_GIT_TIMEOUT = 10
_MAX_TOP_LEVEL = 60


def _git(workspace: Path, *arguments: str) -> str:
    try:
        completed = subprocess.run(
            ["git", *arguments],
            cwd=str(workspace),
            capture_output=True,
            # `stdin` has to be closed, not inherited. The editor starts the core
            # with a pipe on stdin and never writes to it, and a git process that
            # inherits an open pipe waits on it: `git status` here blocked for as
            # long as the editor stayed open, which hung the whole turn before the
            # model was ever called - the assistant answered nothing, ever, in a
            # workspace that is a repository. Started from a console the same code
            # is fine, because a console's stdin is a terminal, which is why this
            # survived every command-line test.
            stdin=subprocess.DEVNULL,
            timeout=_GIT_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    if completed.returncode != 0:
        return ""
    return completed.stdout.decode("utf-8", errors="replace").strip()


def git_state(workspace: Path) -> dict[str, object]:
    """Branch, HEAD and a count of modified files, when this is a repository.

    The check is ``exists``, not ``is_dir``, and that is the whole point: in a
    linked worktree, a submodule or a clone made with ``--separate-git-dir``,
    ``.git`` is a *file* holding a ``gitdir:`` pointer rather than a directory.
    Testing for a directory reported every one of those as "not a repository",
    so the agent was told its workspace had no version control while ``git``
    itself answered perfectly well - and the source-control panel, which asks
    git directly, disagreed with the prompt.
    """

    if not (workspace / ".git").exists():
        return {"is_repo": False}
    branch = _git(workspace, "rev-parse", "--abbrev-ref", "HEAD")
    head = _git(workspace, "rev-parse", "--short", "HEAD")
    status = _git(workspace, "status", "--porcelain")
    changed = len([line for line in status.splitlines() if line.strip()])
    return {"is_repo": True, "branch": branch, "head": head, "changed_files": changed}


def top_level_entries(workspace: Path) -> list[str]:
    """Direct children of the workspace, directories first and marked with '/'."""

    try:
        entries = sorted(workspace.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
    except OSError:
        return []
    rows: list[str] = []
    for entry in entries:
        if entry.is_dir():
            if entry.name in IGNORED_DIRS:
                continue
            rows.append(f"{entry.name}/")
        else:
            rows.append(entry.name)
        if len(rows) >= _MAX_TOP_LEVEL:
            rows.append("...")
            break
    return rows


def workspace_snapshot(workspace: Path) -> dict[str, object]:
    return {
        "path": workspace.as_posix(),
        "git": git_state(workspace),
        "entries": top_level_entries(workspace),
    }