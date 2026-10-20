"""Tool behaviour, including the containment and approval rules."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from typing import NamedTuple

from lexiqode.agent.tools.base import ApprovalDecision, ApprovalRequest, ToolContext
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings


class Harness(NamedTuple):
    """A tool context plus the events and approvals it produced."""

    context: ToolContext
    events: list[tuple[str, dict]]
    requests: list[ApprovalRequest]


def make_context(
    workspace: Path,
    *,
    auto_approve: bool = True,
    approve_writes: bool = True,
    approve_commands: bool = True,
    decision: ApprovalDecision | None = None,
) -> Harness:
    events: list[tuple[str, dict]] = []
    settings = AgentSettings(
        auto_approve=auto_approve,
        approve_writes=approve_writes,
        approve_commands=approve_commands,
    )
    captured: list[ApprovalRequest] = []

    def approve(request: ApprovalRequest) -> ApprovalDecision:
        captured.append(request)
        return decision or ApprovalDecision(approved=True)

    context = ToolContext(
        workspace=workspace,
        settings=settings,
        emit=lambda event_type, data: events.append((event_type, data)),
        approve=approve,
    )
    return Harness(context=context, events=events, requests=captured)


class ToolTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)
        (self.workspace / "src").mkdir()
        (self.workspace / "src" / "app.py").write_text(
            "def main():\n    return 42\n\n\nif __name__ == '__main__':\n    main()\n",
            encoding="utf-8",
        )
        (self.workspace / "README.md").write_text("# Demo\n", encoding="utf-8")
        (self.workspace / "node_modules").mkdir()
        (self.workspace / "node_modules" / "junk.js").write_text("noise\n", encoding="utf-8")
        (self.workspace / "blob.bin").write_bytes(b"\x00\x01\x02binary")
        self.registry = default_registry()
        harness = make_context(self.workspace)
        self.context = harness.context
        self.events = harness.events
        self.requests = harness.requests

    def call(self, name: str, **arguments):
        return self.registry.execute(name, arguments, self.context)


class ReadFileTest(ToolTestCase):
    def test_returns_numbered_lines(self) -> None:
        result = self.call("read_file", path="src/app.py")
        self.assertTrue(result.ok)
        self.assertIn("1| def main():", result.content)
        self.assertEqual(result.meta["total_lines"], 6)

    def test_line_range_is_honoured(self) -> None:
        result = self.call("read_file", path="src/app.py", start_line=2, end_line=2)
        self.assertTrue(result.ok)
        self.assertIn("2|     return 42", result.content)
        self.assertNotIn("1| ", result.content)

    def test_missing_file_is_an_error(self) -> None:
        result = self.call("read_file", path="src/nope.py")
        self.assertFalse(result.ok)
        self.assertIn("does not exist", result.content)

    def test_escape_from_workspace_is_refused(self) -> None:
        result = self.call("read_file", path="../../etc/hosts")
        self.assertFalse(result.ok)
        self.assertIn("outside the workspace", result.content)

    def test_absolute_path_outside_workspace_is_refused(self) -> None:
        target = Path(self._temp.name).parent / "elsewhere.txt"
        result = self.call("read_file", path=str(target))
        self.assertFalse(result.ok)
        self.assertIn("outside the workspace", result.content)

    def test_binary_file_is_refused(self) -> None:
        result = self.call("read_file", path="blob.bin")
        self.assertFalse(result.ok)
        self.assertIn("binary", result.content)

    def test_directory_is_refused(self) -> None:
        result = self.call("read_file", path="src")
        self.assertFalse(result.ok)
        self.assertIn("directory", result.content)


class WriteFileTest(ToolTestCase):
    def test_creates_and_then_reports_no_change(self) -> None:
        first = self.call("write_file", path="src/new.py", content="x = 1\n")
        self.assertTrue(first.ok)
        self.assertTrue(first.meta["created"])
        self.assertEqual((self.workspace / "src" / "new.py").read_text(encoding="utf-8"), "x = 1\n")

        second = self.call("write_file", path="src/new.py", content="x = 1\n")
        self.assertTrue(second.ok)
        self.assertFalse(second.meta["changed"])

    def test_creates_missing_directories(self) -> None:
        result = self.call("write_file", path="a/b/c/deep.txt", content="deep\n")
        self.assertTrue(result.ok)
        self.assertTrue((self.workspace / "a" / "b" / "c" / "deep.txt").is_file())

    def test_write_requires_approval_and_denial_is_reported(self) -> None:
        harness = make_context(
            self.workspace,
            auto_approve=False,
            decision=ApprovalDecision(approved=False, reason="not now"),
        )
        result = self.registry.execute(
            "write_file", {"path": "x.txt", "content": "hi"}, harness.context
        )
        self.assertFalse(result.ok)
        self.assertIn("denied", result.content)
        self.assertIn("not now", result.content)
        self.assertFalse((self.workspace / "x.txt").exists())
        self.assertTrue(harness.requests)

    def test_remember_clears_the_write_flag(self) -> None:
        harness = make_context(
            self.workspace,
            auto_approve=False,
            decision=ApprovalDecision(approved=True, remember=True),
        )
        self.registry.execute("write_file", {"path": "y.txt", "content": "hi"}, harness.context)
        self.assertFalse(harness.context.settings.approve_writes)

    def test_auto_approve_skips_the_prompt(self) -> None:
        result = self.call("write_file", path="z.txt", content="hi")
        self.assertTrue(result.ok)
        self.assertEqual(self.requests, [])


class EditFileTest(ToolTestCase):
    def test_replaces_the_matched_text(self) -> None:
        result = self.call(
            "edit_file", path="src/app.py", old_text="return 42", new_text="return 43"
        )
        self.assertTrue(result.ok)
        self.assertIn("return 43", (self.workspace / "src" / "app.py").read_text(encoding="utf-8"))

    def test_missing_text_is_an_error(self) -> None:
        result = self.call("edit_file", path="src/app.py", old_text="absent", new_text="x")
        self.assertFalse(result.ok)
        self.assertIn("does not contain that text", result.content)

    def test_ambiguous_match_needs_replace_all(self) -> None:
        (self.workspace / "dupes.txt").write_text("same\nsame\n", encoding="utf-8")
        refused = self.call("edit_file", path="dupes.txt", old_text="same", new_text="diff")
        self.assertFalse(refused.ok)
        self.assertIn("appears 2 times", refused.content)

        replaced = self.call(
            "edit_file", path="dupes.txt", old_text="same", new_text="diff", replace_all=True
        )
        self.assertTrue(replaced.ok)
        self.assertEqual((self.workspace / "dupes.txt").read_text(encoding="utf-8"), "diff\ndiff\n")

    def test_identical_text_is_refused(self) -> None:
        result = self.call("edit_file", path="src/app.py", old_text="x", new_text="x")
        self.assertFalse(result.ok)


class SearchToolsTest(ToolTestCase):
    def test_grep_returns_path_line_rows(self) -> None:
        result = self.call("grep", pattern="return", glob="*.py")
        self.assertTrue(result.ok)
        self.assertIn("src/app.py:2:     return 42", result.content)

    def test_grep_skips_ignored_directories(self) -> None:
        result = self.call("grep", pattern="noise")
        self.assertTrue(result.ok)
        self.assertNotIn("node_modules", result.content)

    def test_grep_invalid_regex_is_an_error(self) -> None:
        result = self.call("grep", pattern="[unclosed")
        self.assertFalse(result.ok)
        self.assertIn("invalid regular expression", result.content)

    def test_grep_without_matches_is_not_a_failure(self) -> None:
        result = self.call("grep", pattern="zzz-not-here")
        self.assertTrue(result.ok)
        self.assertIn("no matches", result.content)

    def test_glob_matches_recursively(self) -> None:
        result = self.call("glob", pattern="**/*.py")
        self.assertTrue(result.ok)
        self.assertIn("src/app.py", result.content)

    def test_list_dir_hides_ignored_directories(self) -> None:
        result = self.call("list_dir", depth=1)
        self.assertTrue(result.ok)
        self.assertIn("src/", result.content)
        self.assertNotIn("node_modules", result.content)


class RunCommandTest(ToolTestCase):
    def test_captures_stdout_and_exit_code(self) -> None:
        result = self.call("run_command", command=f'"{sys.executable}" -c "print(123)"')
        self.assertTrue(result.ok)
        self.assertIn("123", result.content)
        self.assertEqual(result.meta["exit_code"], 0)

    def test_failing_command_is_reported_with_output(self) -> None:
        result = self.call("run_command", command=f'"{sys.executable}" -c "raise SystemExit(3)"')
        self.assertFalse(result.ok)
        self.assertEqual(result.meta["exit_code"], 3)

    def test_command_runs_inside_the_workspace(self) -> None:
        result = self.call("run_command", command=f'"{sys.executable}" -c "import os;print(os.getcwd())"')
        self.assertTrue(result.ok)
        self.assertIn(self.workspace.name, result.content)

    def test_command_requires_approval_by_default(self) -> None:
        harness = make_context(
            self.workspace,
            auto_approve=False,
            approve_commands=True,
            decision=ApprovalDecision(approved=False, reason="no shell"),
        )
        result = self.registry.execute("run_command", {"command": "echo hi"}, harness.context)
        self.assertFalse(result.ok)
        self.assertIn("no shell", result.content)

    def test_reads_ask_for_no_approval(self) -> None:
        harness = make_context(self.workspace, auto_approve=False)
        result = self.registry.execute("read_file", {"path": "README.md"}, harness.context)
        self.assertTrue(result.ok)
        self.assertEqual(harness.requests, [])


class RegistryTest(ToolTestCase):
    def test_unknown_tool_is_rejected(self) -> None:
        result = self.call("nope")
        self.assertFalse(result.ok)
        self.assertIn("unknown tool", result.content)

    def test_disabled_tool_is_rejected(self) -> None:
        self.registry.disabled.add("read_file")
        result = self.call("read_file", path="README.md")
        self.assertFalse(result.ok)
        self.assertIn("disabled", result.content)

    def test_schemas_are_openai_shaped(self) -> None:
        for schema in self.registry.schemas():
            self.assertEqual(schema["type"], "function")
            self.assertIn("name", schema["function"])
            self.assertEqual(schema["function"]["parameters"]["type"], "object")

    def test_describe_reports_families(self) -> None:
        families = {entry["name"]: entry["family"] for entry in self.registry.describe()}
        self.assertEqual(families["read_file"], "read")
        self.assertEqual(families["write_file"], "write")
        self.assertEqual(families["run_command"], "command")


if __name__ == "__main__":
    unittest.main()