"""Agent modes: the catalogue, the narrowing, and the enforcement."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from lexiqode.agent.context import git_state
from lexiqode.agent.modes import (
    MODES,
    READ_TOOLS,
    UnknownMode,
    catalogue,
    get_mode,
    mode_ids,
)
from lexiqode.agent.tools.base import ToolContext
from lexiqode.agent.tools.registry import default_registry
from lexiqode.config import AgentSettings
from lexiqode.errors import ConfigError


class CatalogueTest(unittest.TestCase):
    def test_ids_are_unique(self) -> None:
        self.assertEqual(len(mode_ids()), len(set(mode_ids())))

    def test_the_default_mode_exists(self) -> None:
        self.assertEqual(get_mode(None).id, "agent")
        self.assertEqual(get_mode("").id, "agent")
        self.assertEqual(get_mode("  ").id, "agent")

    def test_every_mode_is_described_for_the_editor(self) -> None:
        described = catalogue()
        self.assertEqual(len(described), len(MODES))
        for entry in described:
            self.assertTrue(entry["label"], "a mode without a label is unusable in a menu")
            self.assertTrue(entry["summary"], f"{entry['id']} needs a summary")
            self.assertIn("can_write", entry)

    def test_an_unknown_mode_is_a_config_error(self) -> None:
        with self.assertRaises(UnknownMode) as caught:
            get_mode("telepathy")
        # The message has to be actionable, not just a rejection.
        self.assertIn("agent", str(caught.exception))
        self.assertIsInstance(caught.exception, ConfigError)

    def test_read_only_modes_cannot_write(self) -> None:
        for mode_id in ("ask", "plan", "review"):
            mode = get_mode(mode_id)
            self.assertFalse(mode.can_write, f"{mode_id} must not be able to write")
            self.assertEqual(set(mode.tools or ()), set(READ_TOOLS))

    def test_debug_may_run_commands_but_not_edit(self) -> None:
        mode = get_mode("debug")
        self.assertTrue(mode.allows("run_command"))
        self.assertFalse(mode.can_write)

    def test_agent_mode_places_no_restriction(self) -> None:
        mode = get_mode("agent")
        self.assertIsNone(mode.tools)
        self.assertTrue(mode.can_write)
        self.assertTrue(mode.allows("anything_at_all"))

    def test_a_mode_may_only_lower_the_step_budget(self) -> None:
        for mode in MODES:
            if mode.steps is not None:
                self.assertGreater(mode.steps, 0, f"{mode.id} needs a positive budget")


class EnforcementTest(unittest.TestCase):
    """A narrowed mode must refuse a call, not merely stop advertising it."""

    def setUp(self) -> None:
        self.registry = default_registry()
        self.context = ToolContext(
            workspace=Path("."),
            settings=AgentSettings(auto_approve=True),
            emit=lambda _name, _payload: None,
            approve=lambda _request: None,  # never reached: writes are not permitted
        )

    def test_schemas_are_filtered_by_mode(self) -> None:
        offered = {schema["function"]["name"] for schema in self.registry.schemas(get_mode("ask").tools)}
        self.assertEqual(offered, set(READ_TOOLS))
        self.assertNotIn("write_file", offered)
        self.assertNotIn("run_command", offered)

    def test_the_full_toolset_is_offered_without_a_mode(self) -> None:
        names = {schema["function"]["name"] for schema in self.registry.schemas()}
        for expected in ("read_file", "write_file", "edit_file", "run_command", "grep"):
            self.assertIn(expected, names)

    def test_a_write_call_is_refused_in_a_read_only_mode(self) -> None:
        result = self.registry.execute(
            "write_file",
            {"path": "anything.txt", "content": "no"},
            self.context,
            get_mode("ask").tools,
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.meta.get("error"), "not_available_in_mode")
        self.assertIn("not available in this mode", result.content)

    def test_a_command_is_refused_in_a_mode_that_excludes_it(self) -> None:
        result = self.registry.execute(
            "run_command", {"command": "echo hi"}, self.context, get_mode("plan").tools
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.meta.get("error"), "not_available_in_mode")

    def test_an_empty_tool_list_allows_nothing(self) -> None:
        result = self.registry.execute(
            "read_file", {"path": "x"}, self.context, ()
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.meta.get("error"), "not_available_in_mode")
        self.assertEqual(self.registry.schemas(()), [])


class PromptTest(unittest.TestCase):
    def test_the_prompt_names_the_mode_and_hides_its_tools(self) -> None:
        from lexiqode.agent.prompts import build_system_prompt
        from pathlib import Path

        registry = default_registry()
        prompt = build_system_prompt(Path("."), registry, mode=get_mode("ask"))
        self.assertIn("Current mode: Ask", prompt)
        self.assertIn("read_file", prompt)
        self.assertNotIn("write_file:", prompt)
        self.assertIn("you cannot change files", prompt)

    def test_the_prompt_lists_every_tool_without_a_mode(self) -> None:
        from lexiqode.agent.prompts import build_system_prompt
        from pathlib import Path

        prompt = build_system_prompt(Path("."), default_registry())
        self.assertIn("write_file:", prompt)
        self.assertNotIn("Current mode:", prompt)


class GitStateTest(unittest.TestCase):
    """A workspace is a repository when git says so, not when `.git` is a folder.

    A linked worktree, a submodule and a clone made with `--separate-git-dir` all
    put a *file* named `.git` in the working tree, holding a `gitdir:` pointer.
    Testing for a directory reported every one of those as "not a repository", so
    the agent was told its workspace had no version control while the source
    control panel - which asks git directly - showed the branch and the changes.
    """

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.workspace = Path(self._temp.name)

    def test_a_folder_without_git_is_not_a_repository(self) -> None:
        self.assertEqual(git_state(self.workspace), {"is_repo": False})

    def test_a_git_file_counts_as_a_repository(self) -> None:
        # What a worktree or a submodule has: a file, not a directory. The
        # pointer is deliberately unresolvable - the check is about the shape of
        # the entry, and a real gitdir would need a real repository to point at.
        (self.workspace / ".git").write_text(
            "gitdir: /somewhere/else/.git/worktrees/example\n", encoding="utf-8"
        )
        state = git_state(self.workspace)
        self.assertTrue(state["is_repo"], "a `.git` file is a repository too")


if __name__ == "__main__":
    unittest.main()