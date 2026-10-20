#!/usr/bin/env python3
"""Shape checks for the build workflow.

    python scripts/tests/test_workflow.py

GitHub refuses a workflow file outright when it uses a context the location does
not provide, and the failure is reported in the repository's Actions tab rather
than anywhere a developer would look. That is exactly what happened once: a
workflow-level ``env`` block referenced ``runner.temp``, which only exists inside
a step, and no build ran at all until a human noticed the notice in the web UI.

These tests are cheap and offline, so the same class of mistake cannot get as far
as the repository again.
"""

from __future__ import annotations

import re
import sys
import unittest
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent.parent
WORKFLOW = REPO / ".github" / "workflows" / "build-ide.yml"
ID_VSCODE_VERSION = REPO / "ide" / "vscode-version.txt"

#: Contexts a workflow- or job-level `env` block may not reference, because GitHub
#: does not provide them there. From the context availability table: `env` outside a
#: step gets `github`, `vars` and `inputs` only.
STEP_ONLY_CONTEXTS = ("runner.", "job.", "steps.", "secrets.", "matrix.")

EXPRESSION = re.compile(r"\$\{\{\s*([^}]+?)\s*\}\}")


def load() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def walk(node: object, path: tuple = ()):  # type: ignore[type-arg]
    """Yield ``(path, key, value)`` for every mapping entry in the document."""

    if isinstance(node, dict):
        for key, value in node.items():
            yield path, key, value
            yield from walk(value, path + (str(key),))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk(value, path + (f"[{index}]",))


def steps(document: dict) -> list[dict]:
    collected: list[dict] = []
    for _, key, value in walk(document):
        if key == "steps" and isinstance(value, list):
            collected.extend(step for step in value if isinstance(step, dict))
    return collected


class ContextTest(unittest.TestCase):
    def setUp(self) -> None:
        self.document = load()

    def env_blocks_outside_steps(self) -> list[tuple[str, dict]]:
        """Every `env` mapping that is not declared inside a step."""

        found: list[tuple[str, dict]] = []
        for path, key, value in walk(self.document):
            if key != "env" or not isinstance(value, dict):
                continue
            if "steps" in path:
                continue
            found.append((".".join(path) or "<workflow>", value))
        return found

    def test_no_env_block_outside_a_step_uses_a_step_only_context(self) -> None:
        problems: list[str] = []
        for location, block in self.env_blocks_outside_steps():
            for name, value in block.items():
                if not isinstance(value, str):
                    continue
                for match in EXPRESSION.finditer(value):
                    for context in STEP_ONLY_CONTEXTS:
                        if match.group(1).startswith(context):
                            problems.append(
                                f"{location}.env.{name} references {context[:-1]}, "
                                "which GitHub does not provide there"
                            )
        self.assertEqual(problems, [], "\n".join(problems))

class StepEnvTest(unittest.TestCase):
    """A shell step reading a variable nobody defines gets an empty string.

    Nothing fails; the step simply runs with a blank path. That is the quiet
    version of the same mistake this file exists to prevent, so it is checked.
    """

    #: Variables a runner always provides, so they need no definition here.
    PROVIDED = {"GITHUB_ENV", "GITHUB_OUTPUT", "GITHUB_PATH", "RUNNER_TEMP"}

    def test_every_powershell_env_reference_is_defined_for_that_step(self) -> None:
        document = load()
        inherited: set[str] = set()
        for _, key, value in walk(document):
            if key == "env" and isinstance(value, dict):
                inherited.update(str(name) for name in value)

        missing: list[str] = []
        for step in steps(document):
            run = step.get("run")
            if not isinstance(run, str):
                continue
            own = set(str(name) for name in (step.get("env") or {}))
            for name in re.findall(r"\$env:([A-Za-z_][A-Za-z0-9_]*)", run):
                if name in self.PROVIDED or name in own or name in inherited:
                    continue
                missing.append(
                    f"step {step.get('name', '<unnamed>')!r} reads $env:{name} "
                    "but nothing defines it"
                )
        self.assertEqual(missing, [], "\n".join(missing))


class ReferenceTest(unittest.TestCase):
    """An expression must not read a variable nothing defines."""

    def setUp(self) -> None:
        self.document = load()

    def defined_env_names(self) -> set[str]:
        names: set[str] = set()
        for _, key, value in walk(self.document):
            if key == "env" and isinstance(value, dict):
                names.update(str(name) for name in value)
        return names

    def test_every_env_reference_resolves(self) -> None:
        defined = self.defined_env_names()
        missing: list[str] = []
        for _, _, value in walk(self.document):
            if not isinstance(value, str):
                continue
            for match in EXPRESSION.finditer(value):
                expression = match.group(1)
                for name in re.findall(r"\benv\.([A-Za-z0-9_]+)", expression):
                    if name not in defined:
                        missing.append(f"${{{{ env.{name} }}}} is referenced but never defined")
        self.assertEqual(missing, [], "\n".join(sorted(set(missing))))


class PinnedVersionTest(unittest.TestCase):
    """One place says which upstream tag is built, and the workflow agrees."""

    def test_the_default_ref_matches_the_pinned_version(self) -> None:
        pinned = ID_VSCODE_VERSION.read_text(encoding="utf-8").strip()
        self.assertTrue(pinned, f"{ID_VSCODE_VERSION} is empty")

        document = load()
        # `on` is parsed as the boolean True by YAML 1.1, which is a known quirk.
        triggers = document.get(True) or document.get("on") or {}
        default = triggers["workflow_dispatch"]["inputs"]["vscode_ref"]["default"]
        self.assertEqual(
            default,
            pinned,
            f"the workflow builds {default!r} while ide/vscode-version.txt pins {pinned!r}",
        )

    def test_the_pinned_version_looks_like_a_tag(self) -> None:
        # A version on main has no tag, and cloning it fails with
        # "Remote branch not found" - which is how the first build died.
        pinned = ID_VSCODE_VERSION.read_text(encoding="utf-8").strip()
        self.assertRegex(pinned, r"^\d+\.\d+\.\d+$", "a pinned version must be a release tag")


class StructureTest(unittest.TestCase):
    def setUp(self) -> None:
        self.document = load()

    def test_the_build_job_runs_on_windows_with_the_toolchain(self) -> None:
        job = self.document["jobs"]["build"]
        self.assertEqual(job["runs-on"], "windows-2022")
        self.assertTrue(job["steps"], "the job has no steps")

    def test_the_artifact_is_checked_before_it_is_uploaded(self) -> None:
        names = [step.get("name", "") for step in steps(self.document)]
        verify = next(
            (name for name in names if name.startswith("Verify the packaged build")),
            None,
        )
        upload = next((name for name in names if name.startswith("Upload")), None)
        self.assertIsNotNone(verify, f"no verification step among: {names}")
        self.assertIsNotNone(upload, f"no upload step among: {names}")
        self.assertLess(
            names.index(verify),
            names.index(upload),
            "the artifact must be verified before it is uploaded",
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)