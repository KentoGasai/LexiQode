"""Guards for the source-build script, which cannot be run in CI on Linux.

Three failures in a row came from this file's neighbourhood, and all three cost a
full Windows packaging run (~40 minutes) to discover:

* a ref that had no tag, and a hard-coded path that only existed locally;
* a packaging step that needs an artifact from a vendor extension;
* a guard that searched for a bare function name, which also occurs in the
  function's own definition - it would have thrown on a healthy tree.

The rules below are cheap to check here and expensive to check in CI, so they are
checked here: every text patch the script applies to the upstream sources must
match the exact upstream line and must not match the look-alikes around it, the
patches must be ordered after the dependency install, and the packaging step must
report its own reason instead of a bare exit code.

    python scripts/tests/test_ide_script.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent
SCRIPT = REPO / "scripts" / "build-ide.ps1"
WORKFLOW = REPO / ".github" / "workflows" / "build-ide.yml"

#: Real upstream lines, exactly as they appear at the pinned tag.
POSITIVE = {
    "install list entry": "\t'extensions/copilot',\n",
    "compile step": "\t\t\tcompileCopilotExtensionBuildTask,\n",
    "shim step": "\t\t\tprepareCopilotRipgrepShimTask(platform, arch, destinationFolderName)\n",
}

#: Lines that a careless pattern would also match. Removing any of these would
#: either delete live code or, worse, let the script believe it had succeeded.
NEGATIVE = [
    # The definition of the removed task still contains the bare name.
    "function prepareCopilotRipgrepShimTask(platform: string, arch: string, destinationFolderName: string): void {\n",
    # A single-line import contains the compile task's name.
    "import { checkApiProposalNamesTask, compileAllExtensionsBuildTask, compileCopilotExtensionBuildTask } from './lib/compilation.ts';\n",
    # A comment mentioning the path must not be treated as the path.
    "\tconst builtInCopilotExtensionDir = path.join(appBase, 'extensions', 'copilot');\n",
]

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


def extract_patterns(text: str) -> list[str]:
    """Every upstream-edit regex the script applies, in the order it applies them.

    Only the ones that anchor a whole line, marked by `(?m)`: other `-Pattern`
    literals in the script feed Select-String and are not edits to the sources.
    """

    return [match.group(2) for match in re.finditer(r"Pattern\s*=?\s*(['\"])(\(\?m\).*?)\1", text)]


def main() -> int:
    text = SCRIPT.read_text(encoding="utf-8")
    patterns = extract_patterns(text)

    print("the script applies text patches to upstream sources")
    for pattern in patterns:
        print(f"        {pattern}")
    check(
        len(patterns) == 6,
        f"found {len(patterns)} upstream-edit patterns (expected 6: three applied, three re-checked)",
    )

    # The same three patterns appear twice: once to apply, once to re-verify.
    for label, line in POSITIVE.items():
        matching = [p for p in patterns if re.search(p, line)]
        check(len(matching) >= 1, f"a pattern matches the real upstream {label}")

    print()
    print("no pattern matches a look-alike line")
    for look_alike in NEGATIVE:
        matching = [p for p in patterns if re.search(p, look_alike)]
        check(
            not matching,
            f"no pattern matches: {look_alike.strip()[:70]}",
        )

    print()
    print("upstream patches are verified, not assumed")
    check("Remove-UpstreamLine" in text, "the removal helper exists")
    check(
        text.count("Remove-UpstreamLine -Path") >= 3,
        "all three upstream lines are removed through the helper",
    )
    check(
        "could not remove" in text and "upstream changed that line" in text,
        "a pattern that stops matching is an error, not a silent skip",
    )
    check(
        text.count("the packaging would fail") >= 1,
        "the applied edits are re-checked afterwards",
    )

    print()
    print("the order of the build steps is load-bearing")
    order = [
        text.find("installing dependencies"),
        text.find("removing the built-in vendor chat extension"),
        text.find("applying our identity"),
        text.find("packaging a Windows x64 build"),
    ]
    check(all(index >= 0 for index in order), "all four steps are present")
    check(
        order[0] < order[1],
        "the vendor chat extension is removed after the install, because postinstall "
        "does not check that a listed directory exists",
    )
    check(order[1] < order[2] < order[3], "removal happens before branding and packaging")

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