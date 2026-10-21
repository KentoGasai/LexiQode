"""Guards for the source build, which cannot be run in CI on Linux.

Every failure so far in this area cost a full Windows packaging run (~40 minutes)
to discover, and each one was avoidable:

* a ref that had no tag, and a hard-coded path that only existed locally;
* a packaging step that needs an artifact from a vendor extension;
* a guard that searched for a bare function name, which also occurs in the
  function's own definition - it would have thrown on a healthy tree;
* a removal that left two references behind, because the references were taken out
  one at a time from a script no test could exercise.

The lesson of the last one shapes this file. The surgery now lives in
`scripts/remove-vendor-chat.mjs`, which has its own behavioural test that CI runs,
so it is checked by running it rather than by reading it. What is left to guard
here is the arrangement around it: that the build script delegates instead of
patching upstream files itself, that the call happens before the dependency
install for the reason given below, and that a packaging failure reports its own
cause instead of a bare exit code.

    python scripts/tests/test_ide_script.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO / "scripts" / "build-ide.ps1"
REMOVAL = REPO / "scripts" / "remove-vendor-chat.mjs"
REMOVAL_TEST = REPO / "scripts" / "tests" / "remove-vendor-chat.test.mjs"
WORKFLOW = REPO / ".github" / "workflows" / "build-ide.yml"

failures: list[str] = []
checks = 0


def check(condition: bool, description: str) -> None:
    global checks
    checks += 1
    if condition:
        print(f"  ok    {description}")
    else:
        print(f"  FAIL  {description}")
        failures.append(description)

def main() -> int:
    text = SCRIPT.read_text(encoding="utf-8")
    removal = REMOVAL.read_text(encoding="utf-8")

    print("the removal is delegated to a script that is tested by running it")
    check(REMOVAL.is_file(), "scripts/remove-vendor-chat.mjs exists")
    check(REMOVAL_TEST.is_file(), "it has a behavioural test of its own")
    check("remove-vendor-chat.mjs" in text, "the build script calls it")
    called_with = text.split("remove-vendor-chat.mjs", 1)[1][:160] if "remove-vendor-chat.mjs" in text else ""
    check("$Source" in called_with, "it is called with the source directory, not a fixed path")
    check(
        "Remove-UpstreamLine" not in text,
        "the build script no longer patches upstream files line by line",
    )

    print()
    print("the removal reaches every reference, and verifies before it writes")
    for target in ("build/npm/dirs.ts", "build/gulpfile.vscode.ts", "package.json"):
        check(target in removal, f"it edits {target}")
    check(
        "JSON.parse" in removal and "JSON.stringify" in removal,
        "package.json is edited through the parser, not by text",
    )
    check(
        "stillReachesExtension" in removal,
        "a script is judged by whether it can reach the extension, not by whether "
        "it contains the word copilot",
    )
    check(
        "const planned = [editPackageJson(root), ...planLines(root, LINE_EDITS)]" in removal,
        "every edit is planned before any file is written, so a failure leaves the "
        "tree untouched",
    )
    check(
        "isAlreadyClean" in removal,
        "a second run is a no-op, so rebuilding an already-patched tree is safe",
    )
    check(removal.count("fail(") >= 6, "each failure path reports instead of continuing")

    print()
    print("the order of the build steps is load-bearing")
    order = [
        text.find("removing the built-in vendor chat extension"),
        text.find("installing dependencies"),
        text.find("applying our identity"),
        text.find("packaging a Windows x64 build"),
    ]
    check(all(index >= 0 for index in order), "all four steps are present")
    check(
        order[0] < order[1],
        "the removal runs before the install: its install-list entry goes in the same "
        "step, and leaving it installs four minutes of dependencies for an extension "
        "that will not ship",
    )
    check(order[1] < order[2] < order[3], "then install, branding and packaging")

    print()
    print("a failure explains itself instead of ending in a bare exit code")
    check(
        "Tee-Object -FilePath $packageLog" in text,
        "the packaging output is captured",
    )
    check(
        "packaging failed; the reason is in its own output" in text,
        "the reason is printed at the end of the log",
    )
    check(
        "Select-String -Pattern 'Error:|error:" in text,
        "the captured output is searched for the failure line",
    )

    print()
    print("the workflow keeps the free checks off the expensive runner")
    if WORKFLOW.is_file():
        workflow = WORKFLOW.read_text(encoding="utf-8")
        verify = workflow.find("verify:")
        build = workflow.find("build:")
        check(verify >= 0 and build > verify, "a verify job exists and precedes build")
        check("needs: verify" in workflow, "the build waits for the free checks")
        verify_block = workflow[verify:build]
        check("ubuntu-latest" in verify_block, "the free checks run on Linux")
        build_block = workflow[build:]
        check(
            re.search(r"runs-on:\s*windows-\S+", build_block) is not None,
            "only packaging runs on a Windows runner",
        )
        check(
            "test_ide_script.py" in verify_block,
            "this guard runs in CI, otherwise it protects nothing",
        )
        check(
            "remove-vendor-chat.test.mjs" in verify_block,
            "the removal test runs in CI too",
        )
    else:
        check(False, f"the workflow exists at {WORKFLOW}")

    print()
    if failures:
        print(f"{len(failures)} check(s) failed out of {checks}")
        return 1
    print(f"all {checks} checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())