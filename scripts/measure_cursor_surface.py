"""Measure the feature surface of an installed Cursor build.

This produces the raw numbers the parity report is written from. Cursor ships
its agent UI inside patched workbench bundles rather than in its extensions, so
the interesting surface is text inside those bundles, not extension manifests.

    python scripts/measure_cursor_surface.py
    python scripts/measure_cursor_surface.py --app "C:/path/to/cursor/resources/app"

Writes docs/cursor/cursor-ui-surface.json. Read-only: no file is executed.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_APP = Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "cursor" / "resources" / "app"

#: Bundles worth measuring. Cursor's agent UI is patched into the workbench and
#: its agent runtime lives in out/main.js.
BUNDLES = (
    ("workbench.desktop.main.js", "out/vs/workbench/workbench.desktop.main.js"),
    ("workbench.glass.main.js", "out/vs/workbench/workbench.glass.main.js"),
    ("workbench.anysphere-ui-automations.js", "out/vs/workbench/workbench.anysphere-ui-automations.js"),
    ("main.js", "out/main.js"),
    ("bootstrap-fork.js", "out/bootstrap-fork.js"),
)

COMMAND_PATTERN = re.compile(r'["\'](cursor[.\-][A-Za-z0-9_.\-]{2,64})["\']')
SETTING_PATTERN = re.compile(r'["\'](cursor[.\-][A-Za-z0-9_.\-]{2,64})["\']\s*:\s*\{')
AGENT_TOOL_PATTERN = re.compile(
    r'["\'](read_file|write_file|edit_file|apply_patch|run_terminal_cmd|list_dir|grep|glob_file_search|'
    r'codebase_search|web_search|delete_file|read_lints|fetch_rules|reapply|search_replace)["\']'
)
MODE_PATTERN = re.compile(r'["\'](agent|ask|plan|spec|debug|multitask|triage|project|composer)["\']\s*:')


def measure_bundle(path: Path) -> dict:
    if not path.is_file():
        return {"present": False, "path": path.as_posix()}
    text = path.read_text(encoding="utf-8", errors="replace")
    commands = sorted(set(COMMAND_PATTERN.findall(text)))
    settings = sorted(set(SETTING_PATTERN.findall(text)))
    tools = Counter(AGENT_TOOL_PATTERN.findall(text))
    modes = sorted(set(MODE_PATTERN.findall(text)))
    return {
        "present": True,
        "path": path.as_posix(),
        "bytes": path.stat().st_size,
        "distinct_cursor_ids": len(commands),
        "cursor_ids_sample": commands[:40],
        "setting_like_ids": len(settings),
        "agent_tool_names": dict(tools.most_common()),
        "mode_like_names": modes,
    }


def measure_extensions(app: Path) -> list[dict]:
    root = app / "extensions"
    if not root.is_dir():
        return []
    rows: list[dict] = []
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or not entry.name.startswith("cursor"):
            continue
        manifest = entry / "package.json"
        row: dict = {"name": entry.name}
        if manifest.is_file():
            try:
                payload = json.loads(manifest.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                payload = {}
            contributes = payload.get("contributes") or {}
            row.update(
                {
                    "version": payload.get("version"),
                    "main": payload.get("main"),
                    "activation_events": len(payload.get("activationEvents") or []),
                    "commands": [
                        item.get("command")
                        for item in (contributes.get("commands") or [])
                        if isinstance(item, dict)
                    ],
                    "contributes": sorted(contributes),
                }
            )
        dist = entry / "dist"
        if dist.is_dir():
            row["dist_bytes"] = sum(
                item.stat().st_size for item in dist.rglob("*") if item.is_file()
            )
        rows.append(row)
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure an installed Cursor build")
    parser.add_argument("--app", default=str(DEFAULT_APP), help="Cursor resources/app directory")
    parser.add_argument("--out", default=str(REPO / "docs" / "cursor" / "cursor-ui-surface.json"))
    args = parser.parse_args(argv)

    app = Path(args.app)
    if not app.is_dir():
        print(f"not a directory: {app}", file=sys.stderr)
        return 1

    report = {
        "app": app.as_posix(),
        "bundles": {},
        "extensions": measure_extensions(app),
    }
    for label, relative in BUNDLES:
        report["bundles"][label] = measure_bundle(app / relative)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"wrote {out}")
    for label, data in report["bundles"].items():
        if not data["present"]:
            print(f"  {label:<44} missing")
            continue
        print(
            f"  {label:<44} {data['bytes']:>12,} B  ids={data['distinct_cursor_ids']:<5} "
            f"settings={data['setting_like_ids']:<5} tools={len(data['agent_tool_names'])}"
        )
    print(f"  cursor-* extensions: {len(report['extensions'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())