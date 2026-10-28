"""Filesystem tools: read, write, edit, list, glob and grep.

Every path goes through :meth:`ToolContext.resolve`, so a model cannot reach
outside the workspace even if it invents an absolute path or a ``..`` chain.
Traversal also prunes the directories that would otherwise dominate a large
repository (``.git``, ``node_modules``, build output) and reads binary files as
an explicit refusal instead of mangled text.
"""

from __future__ import annotations

import fnmatch
import os
import re
from pathlib import Path
from typing import Any, Iterator

from ...errors import ToolError
from .base import FAMILY_READ, FAMILY_WRITE, Tool, ToolContext, ToolResult

#: Directories never worth walking in a coding agent.
IGNORED_DIRS = frozenset(
    {
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        "env",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "dist",
        "build",
        "out",
        "target",
        ".next",
        ".nuxt",
        ".turbo",
        ".gradle",
        ".idea",
        ".vs",
        "vendor",
        "coverage",
        ".cache",
    }
)

MAX_FILE_BYTES = 4 * 1024 * 1024


def _is_binary(path: Path) -> bool:
    try:
        with path.open("rb") as stream:
            return b"\x00" in stream.read(1024)
    except OSError:
        return True


def _read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise ToolError(f"cannot read {path.name}: {exc}") from exc


def iter_workspace_files(root: Path, *, limit: int = 20_000) -> Iterator[Path]:
    """Walk the workspace, pruning ignore directories, without following links."""

    seen = 0
    for current, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
        for filename in sorted(filenames):
            seen += 1
            if seen > limit:
                return
            yield Path(current) / filename


class ReadFileTool(Tool):
    name = "read_file"
    description = (
        "Read a text file from the workspace. Returns numbered lines. Use "
        "start_line/end_line for large files instead of reading everything."
    )
    family = FAMILY_READ
    parameters = {
        "path": {"type": "string", "description": "File path relative to the workspace root."},
        "start_line": {"type": "integer", "description": "First line to return (1-based)."},
        "end_line": {"type": "integer", "description": "Last line to return (inclusive)."},
    }
    required = ["path"]

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        path = context.resolve(str(arguments.get("path", "")), must_exist=True)
        if path.is_dir():
            raise ToolError(f"{context.relative(path)} is a directory; use list_dir")
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ToolError(
                f"{context.relative(path)} is larger than {MAX_FILE_BYTES // 1024} KiB; "
                "use grep to locate what you need"
            )
        if _is_binary(path):
            raise ToolError(f"{context.relative(path)} looks binary and cannot be read as text")

        text = _read_text(path)
        lines = text.splitlines()
        total = len(lines)
        cap = context.settings.max_read_lines
        start = max(1, int(arguments.get("start_line") or 1))
        end = int(arguments.get("end_line") or 0)
        if end <= 0:
            end = min(total, start + cap - 1)
        end = min(end, total)
        if start > total:
            raise ToolError(f"start_line {start} is past the end of the file ({total} lines)")

        width = len(str(end))
        body = "\n".join(
            f"{index:>{width}}| {lines[index - 1]}" for index in range(start, end + 1)
        )
        header = f"{context.relative(path)} (lines {start}-{end} of {total})\n"
        return ToolResult(
            ok=True,
            content=header + body,
            meta={"path": context.relative(path), "total_lines": total,
                  "returned_lines": end - start + 1, "truncated": end < total},
        )


class ListDirTool(Tool):
    name = "list_dir"
    description = "List files and directories under a workspace folder, up to a depth limit."
    family = FAMILY_READ
    parameters = {
        "path": {"type": "string", "description": "Folder relative to the workspace root; defaults to the root."},
        "depth": {"type": "integer", "description": "How deep to descend (1-4). Defaults to 1."},
    }
    required = []

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        root = context.resolve(str(arguments.get("path") or "."), must_exist=True)
        if not root.is_dir():
            raise ToolError(f"{context.relative(root)} is a file; use read_file")
        depth = max(1, min(int(arguments.get("depth") or 1), 4))
        base_depth = len(root.parts)
        rows: list[str] = []
        truncated = False

        for current, dirnames, filenames in os.walk(root):
            current_path = Path(current)
            level = len(current_path.parts) - base_depth
            dirnames[:] = sorted(d for d in dirnames if d not in IGNORED_DIRS)
            if level >= depth:
                dirnames[:] = []
            indent = "  " * level
            for name in dirnames:
                rows.append(f"{indent}{name}/")
            for name in sorted(filenames):
                size = 0
                try:
                    size = (current_path / name).stat().st_size
                except OSError:
                    pass
                rows.append(f"{indent}{name} ({size} B)")
            if len(rows) > 2000:
                truncated = True
                break

        label = context.relative(root) or "."
        return ToolResult(
            ok=True,
            content=f"{label}/\n" + "\n".join(rows[:2000]),
            meta={"path": label, "entries": len(rows), "truncated": truncated},
        )


class GlobTool(Tool):
    name = "glob"
    description = (
        "Find workspace files by glob pattern, e.g. '**/*.ts' or 'src/**/test_*.py'."
    )
    family = FAMILY_READ
    parameters = {
        "pattern": {"type": "string", "description": "Glob pattern matched against workspace-relative paths."},
        "limit": {"type": "integer", "description": "Maximum matches to return. Defaults to 200."},
    }
    required = ["pattern"]

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        pattern = str(arguments.get("pattern") or "").strip()
        if not pattern:
            raise ToolError("a glob pattern is required")
        limit = max(1, min(int(arguments.get("limit") or 200), 2000))
        root = context.workspace.resolve()
        matches: list[str] = []
        for path in iter_workspace_files(root):
            relative = path.relative_to(root).as_posix()
            if fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(path.name, pattern):
                matches.append(relative)
                if len(matches) >= limit:
                    break
        if not matches:
            return ToolResult(ok=True, content=f"no files match {pattern!r}", meta={"matches": 0})
        return ToolResult(
            ok=True,
            content="\n".join(matches),
            meta={"matches": len(matches), "truncated": len(matches) >= limit},
        )


class GrepTool(Tool):
    name = "grep"
    description = (
        "Search file contents with a regular expression. Returns 'path:line: text' rows."
    )
    family = FAMILY_READ
    parameters = {
        "pattern": {"type": "string", "description": "Python regular expression."},
        "path": {"type": "string", "description": "Folder or file to search; defaults to the workspace root."},
        "glob": {"type": "string", "description": "Only search files matching this glob, e.g. '*.py'."},
        "case_sensitive": {"type": "boolean", "description": "Defaults to false."},
        "context_lines": {"type": "integer", "description": "Lines of context around each hit. Defaults to 0."},
        "limit": {"type": "integer", "description": "Maximum hits. Defaults to 100."},
    }
    required = ["pattern"]

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        raw_pattern = str(arguments.get("pattern") or "")
        if not raw_pattern:
            raise ToolError("a search pattern is required")
        flags = 0 if arguments.get("case_sensitive") else re.IGNORECASE
        try:
            regex = re.compile(raw_pattern, flags)
        except re.error as exc:
            raise ToolError(f"invalid regular expression: {exc}") from exc

        target = context.resolve(str(arguments.get("path") or "."), must_exist=True)
        file_glob = str(arguments.get("glob") or "").strip()
        limit = max(1, min(int(arguments.get("limit") or 100), 1000))
        padding = max(0, min(int(arguments.get("context_lines") or 0), 5))

        candidates = [target] if target.is_file() else list(iter_workspace_files(target))
        rows: list[str] = []
        hits = 0
        for path in candidates:
            if file_glob and not fnmatch.fnmatch(path.name, file_glob):
                continue
            if _is_binary(path):
                continue
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            lines = _read_text(path).splitlines()
            for index, line in enumerate(lines):
                if not regex.search(line):
                    continue
                hits += 1
                relative = context.relative(path)
                low = max(0, index - padding)
                high = min(len(lines), index + padding + 1)
                for cursor in range(low, high):
                    marker = ":" if cursor == index else "-"
                    rows.append(f"{relative}{marker}{cursor + 1}{marker} {lines[cursor]}")
                if hits >= limit:
                    break
            if hits >= limit:
                break

        if not rows:
            return ToolResult(ok=True, content=f"no matches for {raw_pattern!r}", meta={"hits": 0})
        return ToolResult(
            ok=True,
            content="\n".join(rows),
            meta={"hits": hits, "truncated": hits >= limit},
        )


class WriteFileTool(Tool):
    name = "write_file"
    description = (
        "Create a file or replace its whole contents. Prefer edit_file for changes "
        "to an existing file."
    )
    family = FAMILY_WRITE
    parameters = {
        "path": {"type": "string", "description": "File path relative to the workspace root."},
        "content": {"type": "string", "description": "Full file contents to write."},
    }
    required = ["path", "content"]

    def describe(self, arguments: dict[str, Any]) -> str:
        return f"write {arguments.get('path')}"

    def approval_detail(self, arguments: dict[str, Any]) -> str:
        content = str(arguments.get("content") or "")
        head = "\n".join(content.splitlines()[:12])
        return f"{len(content)} characters\n\n{head}"

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        path = context.resolve(str(arguments.get("path", "")))
        if path.exists() and path.is_dir():
            raise ToolError(f"{context.relative(path)} is a directory")
        content = str(arguments.get("content") or "")
        existed = path.exists()
        before = _read_text(path) if existed else ""
        if existed and before == content:
            return ToolResult(ok=True, content=f"{context.relative(path)} is already up to date",
                              meta={"changed": False})
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            path.write_text(content, encoding="utf-8", newline="")
        except OSError as exc:
            raise ToolError(f"cannot write {path.name}: {exc}") from exc
        verb = "updated" if existed else "created"
        lines = content.count("\n") + (1 if content else 0)
        return ToolResult(
            ok=True,
            content=f"{verb} {context.relative(path)} ({lines} lines)",
            meta={"path": context.relative(path), "changed": True, "created": not existed},
            change={"path": context.relative(path), "before": before, "after": content},
        )


class EditFileTool(Tool):
    name = "edit_file"
    description = (
        "Replace an exact piece of text in one file. 'old_text' must match "
        "character-for-character, including indentation. Use replace_all for "
        "repeated occurrences."
    )
    family = FAMILY_WRITE
    parameters = {
        "path": {"type": "string", "description": "File path relative to the workspace root."},
        "old_text": {"type": "string", "description": "Exact text to replace, with enough context to be unique."},
        "new_text": {"type": "string", "description": "Replacement text."},
        "replace_all": {"type": "boolean", "description": "Replace every occurrence. Defaults to false."},
    }
    required = ["path", "old_text", "new_text"]

    def describe(self, arguments: dict[str, Any]) -> str:
        return f"edit {arguments.get('path')}"

    def approval_detail(self, arguments: dict[str, Any]) -> str:
        old = str(arguments.get("old_text") or "")
        new = str(arguments.get("new_text") or "")
        return f"- {old[:400]}\n\n+ {new[:400]}"

    def run(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        path = context.resolve(str(arguments.get("path", "")), must_exist=True)
        if _is_binary(path):
            raise ToolError(f"{context.relative(path)} is binary and cannot be edited as text")
        old = str(arguments.get("old_text") or "")
        new = str(arguments.get("new_text") or "")
        if not old:
            raise ToolError("old_text must not be empty")
        if old == new:
            raise ToolError("old_text and new_text are identical")

        text = _read_text(path)
        occurrences = text.count(old)
        if occurrences == 0:
            raise ToolError(
                f"{context.relative(path)} does not contain that text; read the file again "
                "and copy the exact snippet"
            )
        replace_all = bool(arguments.get("replace_all"))
        if occurrences > 1 and not replace_all:
            raise ToolError(
                f"old_text appears {occurrences} times in {context.relative(path)}; add "
                "surrounding context or pass replace_all"
            )
        updated = text.replace(old, new) if replace_all else text.replace(old, new, 1)
        try:
            path.write_text(updated, encoding="utf-8", newline="")
        except OSError as exc:
            raise ToolError(f"cannot write {path.name}: {exc}") from exc
        changed = occurrences if replace_all else 1
        return ToolResult(
            ok=True,
            content=f"replaced {changed} occurrence(s) in {context.relative(path)}",
            meta={"path": context.relative(path), "changed": True, "occurrences": changed},
            change={"path": context.relative(path), "before": text, "after": updated},
        )