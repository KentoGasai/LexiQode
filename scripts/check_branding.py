#!/usr/bin/env python3
"""Verify that a build really carries our identity.

Two modes, one set of assertions:

``--source``
    Take a pristine upstream ``product.json``, apply ``ide/product.overlay.json``
    in memory, and check the result. This runs anywhere, needs no C++ toolchain,
    and is how the overlay is proven against a specific upstream tag.

``--built``
    Check a ``product.json`` taken out of a packaged build. This is what CI runs,
    so the thing that ships is inspected rather than the steps that produced it.

Exit code is 0 only when every assertion passes in the requested mode.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OVERLAY = REPO / "ide" / "product.overlay.json"

#: Identity that must be present in a shipped build.
EXPECTED = {
    "nameShort": "LexiQode",
    "nameLong": "LexiQode",
    "applicationName": "lexiqode",
    "dataFolderName": ".lexiqode",
    "urlProtocol": "lexiqode",
    "win32MutexName": "lexiqode",
    "win32AppUserModelId": "LexiQode.LexiQode",
    "win32RegValueName": "LexiQode",
}

GALLERY_FRAGMENT = "open-vsx.org"

#: Endpoints that must be empty: naming a vendor service the user never chose is
#: the exact surprise this build exists to avoid.
EXPECTED_EMPTY = ("voiceWsUrl", "webviewContentExternalBaseUrlTemplate")

#: Download feeds for build inputs (Node, Electron). They are consumed while the
#: build runs and never contacted by the installed product, so they are allowed to
#: keep their upstream value. Kept as an explicit list rather than a pattern so a
#: new straggler cannot slip through unnoticed.
FEED_KEYS = {"nodejsArtifactFeed", "electronArtifactFeed"}

#: Hosts that belong to a vendor service. Loaded from a file because the build
#: script empties matching URLs while this script proves they are gone: if the two
#: lists drifted, a release could pass a check the build never applied.
HOSTS_FILE = REPO / "ide" / "vendor-hosts.txt"


def vendor_hosts() -> list[str]:
    """Every host from the shared list, with comments and blanks removed."""

    hosts: list[str] = []
    for line in HOSTS_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            hosts.append(line.lower())
    if not hosts:
        raise SystemExit(f"{HOSTS_FILE} lists no hosts; refusing to guess what is ours")
    return hosts


def vendor_url(value: str, hosts: list[str]) -> bool:
    """True when the string is an absolute URL to one of those hosts."""

    match = re.match(r"^https?://([^/:]+)", value, re.IGNORECASE)
    if not match:
        return False
    host = match.group(1).lower()
    return any(host == entry or host.endswith("." + entry) for entry in hosts)


def blank_vendor_urls(node: object, hosts: list[str]) -> int:
    """Empty every vendor URL, in place. Returns how many were emptied.

    This is the same transform the build performs. Doing it here as well is what
    makes ``--source`` a real prediction of the packaged result instead of a check
    of the overlay alone.

    Only values held by a key are emptied. A URL inside an array is left alone on
    purpose: there is no key to set to an empty string, and replacing the element
    would silently change the length of a list whose meaning is unknown. Such a
    URL is not ignored, though - :func:`check` walks arrays too, sees it, and
    refuses the build.
    """

    count = 0
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if isinstance(value, str):
                if vendor_url(value, hosts):
                    node[key] = ""
                    count += 1
            else:
                count += blank_vendor_urls(value, hosts)
    elif isinstance(node, list):
        for item in node:
            count += blank_vendor_urls(item, hosts)
    return count


def read_json(path: Path) -> dict:
    """Read a JSON document whatever encoding it arrived in.

    A ``product.json`` reaching this script may have been written by the build, by
    a text editor running a build script, or by PowerShell's ``>`` operator, which
    on Windows produces UTF-16 with a byte-order mark. Insisting on UTF-8 turned
    that into a UnicodeDecodeError instead of a check, so the BOM decides.
    """

    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        text = raw.decode("utf-16")
    elif raw.startswith(b"\xef\xbb\xbf"):
        text = raw.decode("utf-8-sig")
    else:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            # Last resort rather than a crash: a manifest with a stray byte should
            # still be inspectable, and every check below is on ASCII keys.
            text = raw.decode("latin-1")
    return json.loads(text)


def merge(upstream: dict, overlay: dict) -> tuple[dict, list[str], list[str]]:
    """Apply the overlay the same way the build script does."""

    merged = json.loads(json.dumps(upstream))
    changed: list[str] = []
    added: list[str] = []
    for key, value in overlay.items():
        # Keys starting with an underscore are documentation for humans; the build
        # script skips them and so does this.
        if key.startswith("_"):
            continue
        if key in merged:
            if merged[key] != value:
                changed.append(key)
            merged[key] = value
        else:
            merged[key] = value
            added.append(key)
    return merged, changed, added


def walk_strings(node: object, path: str = "") -> list[tuple[str, str]]:
    """Every string in the document, with the path that reaches it."""

    found: list[tuple[str, str]] = []
    if isinstance(node, dict):
        for key, value in node.items():
            found.extend(walk_strings(value, f"{path}.{key}" if path else key))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            found.extend(walk_strings(value, f"{path}[{index}]"))
    elif isinstance(node, str):
        found.append((path, node))
    return found


def check(product: dict, label: str, hosts: list[str]) -> list[str]:
    """Return the problems found; an empty list means the build is ours."""

    problems: list[str] = []

    for key, expected in EXPECTED.items():
        actual = product.get(key)
        if actual != expected:
            problems.append(f"{key} is {actual!r}, expected {expected!r}")

    if product.get("enableTelemetry") is not False:
        # telemetryUtils.ts reads exactly this field to decide whether any event
        # is sent, so a truthy value here is not cosmetic.
        problems.append(
            f"enableTelemetry is {product.get('enableTelemetry')!r}, expected False"
        )

    gallery = product.get("extensionsGallery") or {}
    if GALLERY_FRAGMENT not in str(gallery.get("serviceUrl", "")):
        problems.append(f"extensionsGallery.serviceUrl is {gallery.get('serviceUrl')!r}")

    for key in EXPECTED_EMPTY:
        if product.get(key, "") != "":
            problems.append(f"{key} is {product.get(key)!r}, expected empty")

    for path, value in walk_strings(product):
        root = path.split(".")[0].split("[")[0]
        if root in FEED_KEYS:
            continue
        if vendor_url(value, hosts):
            problems.append(f"{path} still points at a vendor service: {value}")

    if not problems:
        print(f"{label}: every check passed")
    return problems


def check_built_tree(product_path: Path) -> list[str]:
    """Inspect the packaged tree, not just the manifest."""

    problems: list[str] = []
    app = product_path.parent
    extension = app / "extensions" / "lexiqode" / "out" / "extension.js"
    if not extension.is_file():
        problems.append(f"the agent is not inside the build ({extension} is missing)")
    core = app.parent / "lexiqode-core" / "lexiqode" / "server" / "http.py"
    if not core.is_file():
        problems.append(f"the core is not inside the build ({core} is missing)")
    return problems


def known_leftovers(product: dict, product_path: Path | None = None) -> list[str]:
    """Vendor names that are deliberately still present.

    Reported on every run rather than silently tolerated. These are not URLs, so
    removing them is a different kind of change: the ids are typed as required
    strings in ``IDefaultChatAgent``, and the extension folder is part of the
    upstream sources. Emptying a URL cannot break anything that reads a link;
    deleting a required id or a bundled extension can, so each of these is a
    decision to make rather than a cleanup to guess at.
    """

    found: list[str] = []
    agent = product.get("defaultChatAgent") or {}
    for key in ("extensionId", "chatExtensionId", "providerExtensionId"):
        value = agent.get(key)
        if value:
            found.append(f"defaultChatAgent.{key} is still {value!r}")
    if product_path is not None:
        bundled = product_path.parent / "extensions" / "copilot"
        if bundled.is_dir():
            found.append(
                f"{bundled.relative_to(product_path.parent)} ships in the build "
                "(upstream's own chat extension, whose prompts point at a vendor account)"
            )
    return found


def report_leftovers(lines: list[str]) -> None:
    if not lines:
        return
    print("known leftovers (reported, not failures):")
    for line in lines:
        print(f"  * {line}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--source", help="a pristine upstream product.json to brand in memory")
    group.add_argument("--built", help="a product.json taken from a packaged build")
    args = parser.parse_args()

    if args.source:
        upstream_path = Path(args.source).resolve()
        upstream = read_json(upstream_path)
        overlay = read_json(OVERLAY)
        merged, changed, added = merge(upstream, overlay)
        hosts = vendor_hosts()
        blanked = blank_vendor_urls(merged, hosts)
        print(
            f"upstream {upstream_path.name}: {len(upstream)} keys, "
            f"{len(changed)} overridden, {len(added)} added, "
            f"{blanked} vendor URL(s) emptied"
        )
        if added:
            # Worth printing: an added key means upstream does not carry it, so the
            # build is introducing it. That is fine when intended and a signal when
            # it is not.
            print(f"  added: {', '.join(sorted(added))}")
        problems = check(merged, "overlay result", hosts)
        if problems:
            print("\nthe overlay would not produce a correct build:", file=sys.stderr)
            for problem in problems:
                print(f"  - {problem}", file=sys.stderr)
            return 1
        # A source tree has no bundled folders to inspect, so only the manifest
        # can be reported on here.
        report_leftovers(known_leftovers(merged))
        return 0

    product_path = Path(args.built).resolve()
    if not product_path.is_file():
        print(f"no product.json at {product_path}", file=sys.stderr)
        return 1
    product = read_json(product_path)
    problems = check(product, "packaged build", vendor_hosts())
    problems.extend(check_built_tree(product_path))
    if problems:
        print("\nthis build is not ours:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("  agent:     built-in extension and bundled core are present")
    report_leftovers(known_leftovers(product, product_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())