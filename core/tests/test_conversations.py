"""Saved conversations: a chat has an id, a title and a place in a list."""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from lexiqode.agent.events import EventBus
from lexiqode.config import AgentSettings, ModelProfile, Settings
from lexiqode.conversations import ConversationStore, folder_key, title_from
from lexiqode.errors import ConfigError
from lexiqode.server.session import CoreSession

from .fakes import FakeClient, text_chunks


def user(text: str) -> dict:
    return {"role": "user", "content": text}


def assistant(text: str) -> dict:
    return {"role": "assistant", "content": text}


class StoreTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        root = Path(self._temp.name)
        self.workspace = root / "project"
        self.workspace.mkdir()
        self.store = ConversationStore(self.workspace, root=root / "chats")

    def test_a_title_comes_from_the_first_question(self) -> None:
        self.assertEqual(title_from([user("Fix the parser"), assistant("Done")]), "Fix the parser")
        self.assertEqual(title_from([assistant("Hello"), user("Second")]), "Second")
        self.assertEqual(title_from([]), "")

    def test_the_editor_context_is_not_part_of_the_title(self) -> None:
        # The window prepends the open file and the selection to every message.
        # A tab named after that preamble would name a file path nobody typed.
        message = user("Context from the editor:\nfile: app.js\n\nWhy does this fail?")
        self.assertEqual(title_from([message]), "Why does this fail?")

    def test_a_long_question_is_clipped(self) -> None:
        title = title_from([user("w" * 400)])
        self.assertEqual(len(title), 61)
        self.assertTrue(title.endswith("…"))

    def test_conversations_are_listed_newest_first_without_their_messages(self) -> None:
        first = self.store.create(messages=[user("one"), assistant("a")])
        second = self.store.create(messages=[user("two"), assistant("b")])
        rows = self.store.list()

        self.assertEqual([row["id"] for row in rows][0], second["id"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["messages"], 2)
        self.assertEqual(rows[0]["preview"], "b")
        self.assertEqual(self.store.read(first["id"])["messages"][0]["content"], "one")

    def test_a_rename_survives_the_next_save(self) -> None:
        created = self.store.create(messages=[user("first question")])
        self.assertEqual(self.store.read(created["id"])["title"], "first question")

        self.store.rename(created["id"], "Perf work")
        self.store.save(created["id"], [user("first question"), assistant("partial")])
        self.assertEqual(self.store.read(created["id"])["title"], "Perf work")

    def test_deleting_removes_the_file_and_nothing_else(self) -> None:
        keep = self.store.create(messages=[user("keep me")])
        doomed = self.store.create(messages=[user("delete me")])

        self.assertTrue(self.store.delete(doomed["id"]))
        self.assertFalse(self.store.delete(doomed["id"]))
        self.assertEqual([row["id"] for row in self.store.list()], [keep["id"]])

    def test_two_folders_with_the_same_name_do_not_share_chats(self) -> None:
        other = Path(self._temp.name) / "elsewhere" / "project"
        other.mkdir(parents=True)
        self.assertNotEqual(folder_key(self.workspace), folder_key(other))

    def test_a_damaged_file_is_skipped_rather_than_fatal(self) -> None:
        good = self.store.create(messages=[user("fine")])
        (self.store.root / "broken.json").write_text("{ not json", encoding="utf-8")

        self.assertEqual([row["id"] for row in self.store.list()], [good["id"]])
        self.assertIsNone(self.store.read("broken"))


def answers() -> FakeClient:
    return FakeClient([text_chunks("answered")])


class SessionConversationTest(unittest.TestCase):
    """A turn writes a chat, and a new chat does not throw the old one away."""

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        root = Path(self._temp.name)
        self.workspace = root / "project"
        self.workspace.mkdir()
        os.environ["LEXIQODE_CONFIG_DIR"] = str(root / "cfg")
        os.environ["LEXIQODE_DATA_DIR"] = str(root / "data")
        self.addCleanup(self._forget_env)

        settings = Settings(agent=AgentSettings(auto_approve=True, max_steps=4))
        settings.set_profile(ModelProfile(id="test", base_url="http://provider.test", model="m"))
        settings.active_profile = "test"
        self.settings = settings
        self.events: list[tuple[str, dict]] = []
        bus = EventBus()
        bus.subscribe(lambda event_type, data: self.events.append((event_type, data)))
        self.session = CoreSession(
            self.workspace,
            settings,
            bus=bus,
            client_factory=lambda _profile: answers(),
        )
        self.addCleanup(self.session.close)

    def _forget_env(self) -> None:
        os.environ.pop("LEXIQODE_CONFIG_DIR", None)
        os.environ.pop("LEXIQODE_DATA_DIR", None)

    def titles(self) -> list[str]:
        return [row["title"] for row in self.session.list_conversations()["conversations"]]

    def reasons(self) -> list[str]:
        return [
            data.get("reason", "")
            for event_type, data in self.events
            if event_type == "conversation_changed"
        ]

    def test_a_turn_is_saved_with_a_title_and_survives_a_new_session(self) -> None:
        self.session.start_turn("Fix the parser")
        self.assertTrue(self.session.wait(timeout=10))

        listed = self.session.list_conversations()
        self.assertEqual(listed["current"]["title"], "Fix the parser")
        self.assertEqual(len(listed["conversations"]), 1)
        first_id = listed["current"]["id"]
        self.assertIn("saved", self.reasons())

        # A session built again over the same folder is what reopening the window
        # does, and it has to find the same chat.
        again = CoreSession(
            self.workspace,
            self.settings,
            bus=EventBus(),
            client_factory=lambda _profile: FakeClient([]),
        )
        self.addCleanup(again.close)
        self.assertEqual(again.current_conversation()["id"], first_id)
        self.assertEqual(again.conversation_messages()[0]["content"], "Fix the parser")

    def test_a_new_chat_keeps_the_previous_one(self) -> None:
        self.session.start_turn("first chat")
        self.assertTrue(self.session.wait(timeout=10))
        before = self.session.current_conversation()["id"]

        created = self.session.new_conversation()
        self.assertNotEqual(created["id"], before)
        self.assertEqual(self.session.conversation_messages(), [])
        self.assertEqual(len(self.titles()), 2)
        self.assertIn("first chat", self.titles())
        self.assertIn("created", self.reasons())

    def test_opening_a_saved_chat_restores_its_messages(self) -> None:
        self.session.start_turn("the first question")
        self.assertTrue(self.session.wait(timeout=10))
        first = self.session.current_conversation()["id"]
        self.session.new_conversation()

        opened = self.session.open_conversation(first)
        self.assertEqual(opened["id"], first)
        messages = self.session.conversation_messages()
        self.assertEqual(messages[0]["content"], "the first question")
        self.assertEqual(messages[-1]["role"], "assistant")
        # And the loop the next turn uses is the one holding those messages: a
        # switch that only changed a label would answer as if the chat were empty.
        self.assertEqual(self.session.loop().messages[0]["content"], "the first question")

    def test_reset_starts_a_new_chat_instead_of_erasing_the_old_one(self) -> None:
        self.session.start_turn("do not lose me")
        self.assertTrue(self.session.wait(timeout=10))

        self.session.reset()
        self.assertEqual(self.session.conversation_messages(), [])
        self.assertIn("do not lose me", self.titles())

    def test_renaming_and_deleting_are_reported(self) -> None:
        self.session.start_turn("name me")
        self.assertTrue(self.session.wait(timeout=10))
        current = self.session.current_conversation()["id"]

        renamed = self.session.rename_conversation(current, "Renamed chat")
        self.assertEqual(renamed["title"], "Renamed chat")
        self.assertIn("Renamed chat", self.titles())
        self.assertIn("renamed", self.reasons())

        result = self.session.delete_conversation(current)
        self.assertEqual(result["deleted"], current)
        self.assertNotEqual(result["current"]["id"], current)
        self.assertNotIn("Renamed chat", self.titles())

    def test_opening_an_unknown_chat_is_refused(self) -> None:
        with self.assertRaises(ConfigError):
            self.session.open_conversation("does-not-exist")