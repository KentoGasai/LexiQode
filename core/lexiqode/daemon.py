"""Process lifetime helpers: runtime descriptor, liveness and health probing.

The editor needs to answer one question on activation: "is a core already
running for this workspace, or should I start one?". A pid alone is not enough
(pids are reused), so the descriptor is validated in two steps: the recorded pid
must still be alive *and* an unauthenticated ``/api/health`` call must report the
same workspace.

The liveness check is deliberately Windows-aware. ``os.kill(pid, 0)`` is not a
harmless probe on Windows - it can terminate the target - so the Win32 API is
used there instead.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from .config import runtime_descriptor_path
from .version import PROTOCOL_VERSION, PRODUCT_NAME

STILL_ACTIVE = 259
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def is_pid_alive(pid: int) -> bool:
    """True only when a process with this pid is still running."""

    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def write_descriptor(payload: dict[str, Any], path: Path | None = None) -> Path:
    """Publish how to reach the running core."""

    target = path or runtime_descriptor_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    data = {
        "product": PRODUCT_NAME,
        "protocol": PROTOCOL_VERSION,
        "written_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        **payload,
    }
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(target)
    return target


def read_descriptor(path: Path | None = None) -> dict[str, Any] | None:
    target = path or runtime_descriptor_path()
    if not target.is_file():
        return None
    try:
        data = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def clear_descriptor(path: Path | None = None, *, only_pid: int | None = None) -> None:
    """Remove the descriptor, unless it belongs to a different process."""

    target = path or runtime_descriptor_path()
    if only_pid is not None:
        current = read_descriptor(target)
        if current and int(current.get("pid") or 0) != only_pid:
            return
    try:
        target.unlink()
    except OSError:
        pass


def probe_health(base_url: str, *, timeout: float = 1.5) -> dict[str, Any] | None:
    """Unauthenticated liveness probe against ``/api/health``."""

    url = f"{base_url.rstrip('/')}/api/health"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def find_live_core(workspace: Path | None = None, *, path: Path | None = None) -> dict[str, Any] | None:
    """Return the descriptor only when its core is alive and matches."""

    descriptor = read_descriptor(path)
    if not descriptor:
        return None
    pid = int(descriptor.get("pid") or 0)
    if not is_pid_alive(pid):
        clear_descriptor(path)
        return None
    base_url = str(descriptor.get("base_url") or "")
    health = probe_health(base_url)
    if not health or not health.get("ok"):
        return None
    if workspace is not None:
        reported = Path(str(health.get("workspace") or "")).as_posix()
        if reported and reported != Path(workspace).as_posix():
            return None
    return {**descriptor, "health": health}