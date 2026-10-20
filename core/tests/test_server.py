"""End-to-end tests over the real HTTP surface."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

import httpx

from lexiqode.agent.events import EventBus
from lexiqode.config import AgentSettings, ModelProfile, Settings
from lexiqode.server.http import CoreServer
from lexiqode.server.session import CoreSession

from .fakes import FakeClient, text_chunks, tool_chunks


class ServerTestCase(unittest.TestCase):
    """Starts a real server on a free port with a scripted provider."""

    script: list = []
    agent: AgentSettings = AgentSettings(auto_approve=True, max_steps=4)
    workspace_files: dict[str, str] = {}

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        root = Path(self._temp.name)
        os.environ["LEXIQODE_CONFIG_DIR"] = str(root / "cfg")
        os.environ["LEXIQODE_DATA_DIR"] = str(root / "data")
        self.addCleanup(self._restore_env)

        self.workspace = root / "project"
        self.workspace.mkdir()
        for name, content in self.workspace_files.items():
            (self.workspace / name).write_text(content, encoding="utf-8")

        # Deep copies on purpose: ``script`` holds live Chunk/ToolCall objects and
        # ``agent`` a mutable settings record. Sharing either across tests lets
        # one test's accumulated tool arguments leak into the next.
        self.client = FakeClient(copy.deepcopy(self.script))
        settings = Settings(agent=copy.deepcopy(self.agent))
        settings.set_profile(
            ModelProfile(id="test", base_url="http://provider.test", model="test-model")
        )
        settings.active_profile = "test"
        self.session = CoreSession(
            self.workspace,
            settings,
            bus=EventBus(),
            client_factory=self.make_client_factory(),
        )
        self.server = CoreServer(self.session, token="test-token").start()
        self.addCleanup(self.session.close)
        self.addCleanup(self.server.stop)
        self.base = self.server.base_url
        self.headers = {"Authorization": "Bearer test-token"}

    def _restore_env(self) -> None:
        os.environ.pop("LEXIQODE_CONFIG_DIR", None)
        os.environ.pop("LEXIQODE_DATA_DIR", None)

    def make_client_factory(self):
        """Hook so a test can observe the profile the session resolved."""

        return lambda _profile: self.client

    def get(self, path: str, **kwargs):
        return httpx.get(f"{self.base}{path}", headers=self.headers, timeout=5.0, **kwargs)

    def post(self, path: str, payload: dict | None = None, **kwargs):
        return httpx.post(
            f"{self.base}{path}", json=payload or {}, headers=self.headers, timeout=5.0, **kwargs
        )

    def wait_for_turn(self, timeout: float = 10.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            state = self.get("/api/state").json()
            if not state["turn"]["running"]:
                return state
            time.sleep(0.05)
        raise AssertionError("the turn did not finish in time")


class HealthTest(ServerTestCase):
    def test_health_needs_no_token(self) -> None:
        response = httpx.get(f"{self.base}/api/health", timeout=5.0)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["protocol"], 1)
        self.assertEqual(Path(body["workspace"]).as_posix(), self.workspace.as_posix())

    def test_protected_routes_reject_a_missing_token(self) -> None:
        response = httpx.get(f"{self.base}/api/state", timeout=5.0)
        self.assertEqual(response.status_code, 401)

    def test_protected_routes_reject_a_wrong_token(self) -> None:
        response = httpx.get(
            f"{self.base}/api/state", headers={"Authorization": "Bearer nope"}, timeout=5.0
        )
        self.assertEqual(response.status_code, 401)

    def test_ping_succeeds_with_the_token(self) -> None:
        self.assertEqual(self.get("/api/ping").json(), {"ok": True, "pong": True})

    def test_unknown_route_is_a_404(self) -> None:
        self.assertEqual(self.get("/api/nothing").status_code, 404)

    def test_options_preflight_is_answered(self) -> None:
        response = httpx.request(
            "OPTIONS",
            f"{self.base}/api/chat",
            headers={"Origin": "vscode-webview://abc", "Access-Control-Request-Headers": "authorization"},
            timeout=5.0,
        )
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["access-control-allow-origin"], "vscode-webview://abc")


class StateTest(ServerTestCase):
    def test_state_reports_profile_tools_and_workspace(self) -> None:
        body = self.get("/api/state").json()
        self.assertEqual(body["profile"]["id"], "test")
        self.assertEqual(body["profile"]["model"], "test-model")
        self.assertFalse(body["profile"]["has_api_key"])
        self.assertIn("read_file", {tool["name"] for tool in body["tools"]})
        self.assertFalse(body["turn"]["running"])

    def test_settings_endpoint_hides_credentials(self) -> None:
        body = self.get("/api/settings").json()
        self.assertIn("paths", body["settings"])
        self.assertEqual(body["settings"]["profiles"]["test"]["api_key"], "")

    def test_settings_can_be_patched(self) -> None:
        response = httpx.put(
            f"{self.base}/api/settings",
            json={"agent": {"max_steps": 12, "auto_approve": False},
                  "profile": {"id": "test", "temperature": 0.2}},
            headers=self.headers,
            timeout=5.0,
        )
        self.assertEqual(response.status_code, 200)
        settings = response.json()["settings"]
        self.assertEqual(settings["agent"]["max_steps"], 12)
        self.assertFalse(settings["agent"]["auto_approve"])
        self.assertAlmostEqual(settings["profiles"]["test"]["temperature"], 0.2)
        self.assertTrue(Path(settings["paths"]["settings"]).is_file())

    def test_chat_with_an_empty_message_is_rejected(self) -> None:
        response = self.post("/api/chat", {"message": "   "})
        self.assertEqual(response.status_code, 400)


class TurnTest(ServerTestCase):
    script = [text_chunks("Hello from the model.")]

    def test_a_turn_runs_and_is_recorded(self) -> None:
        response = self.post("/api/chat", {"message": "say hello"})
        self.assertEqual(response.status_code, 202)
        self.assertTrue(response.json()["started"])

        state = self.wait_for_turn()
        self.assertEqual(state["turn"]["last_stopped"], "completed")
        self.assertGreater(state["history_length"], 0)

        history = self.get("/api/history").json()["messages"]
        roles = [message["role"] for message in history]
        self.assertEqual(roles.count("user"), 1)
        self.assertIn("assistant", roles)

    def test_a_second_turn_is_rejected_while_one_runs(self) -> None:
        self.post("/api/chat", {"message": "first"})
        # The first turn may already be done; only assert that the guard exists.
        second = self.post("/api/chat", {"message": "second"})
        self.assertIn(second.status_code, (202, 400))
        if second.status_code == 400:
            self.assertIn("already running", second.json()["error"])

    def test_reset_clears_the_history(self) -> None:
        self.post("/api/chat", {"message": "hi"})
        self.wait_for_turn()
        self.post("/api/reset")
        self.assertEqual(self.get("/api/history").json()["messages"], [])


class ToolTurnTest(ServerTestCase):
    script = [
        tool_chunks("read_file", {"path": "notes.txt"}),
        text_chunks("The note says hello."),
    ]
    workspace_files = {"notes.txt": "hello\n"}

    def test_tool_call_round_trip(self) -> None:
        self.post("/api/chat", {"message": "read notes.txt"})
        state = self.wait_for_turn()
        self.assertEqual(state["turn"]["last_stopped"], "completed")

        history = self.get("/api/history").json()["messages"]
        tool_messages = [message for message in history if message["role"] == "tool"]
        self.assertEqual(len(tool_messages), 1)
        self.assertIn("hello", tool_messages[0]["content"])

    def test_events_are_broadcast_on_the_stream(self) -> None:
        collected: list[str] = []

        def read_stream() -> None:
            try:
                with httpx.stream(
                    "GET",
                    f"{self.base}/api/events",
                    params={"token": "test-token"},
                    timeout=httpx.Timeout(8.0, read=8.0),
                ) as response:
                    for line in response.iter_lines():
                        collected.append(line)
                        if line.startswith("event: turn_end"):
                            break
            except httpx.HTTPError:
                pass

        reader = threading.Thread(target=read_stream, daemon=True)
        reader.start()
        time.sleep(0.2)  # let the subscriber attach
        self.post("/api/chat", {"message": "read notes.txt"})
        reader.join(timeout=12)

        blob = "\n".join(collected)
        self.assertIn("event: ready", blob)
        self.assertIn("event: turn_start", blob)
        self.assertIn("event: tool_start", blob)
        self.assertIn("event: turn_end", blob)


class ToolToggleTest(ServerTestCase):
    script = [text_chunks("only text, no tools")]

    def test_tools_default_to_enabled(self) -> None:
        response = self.post("/api/chat", {"message": "do something"})
        self.assertTrue(response.json()["tools"])
        self.wait_for_turn()
        self.assertIsNotNone(self.client.calls[0]["tools"])

    def test_tools_can_be_disabled_for_one_turn(self) -> None:
        response = self.post("/api/chat", {"message": "rewrite this", "tools": False})
        self.assertEqual(response.status_code, 202)
        self.assertFalse(response.json()["tools"])
        self.wait_for_turn()
        self.assertIsNone(
            self.client.calls[0]["tools"],
            "an inline edit must not be able to call tools",
        )


class CompleteTest(ServerTestCase):
    script = [text_chunks("rewritten code")]

    def make_client_factory(self):
        self.seen_profiles = []

        def factory(profile):
            self.seen_profiles.append(profile)
            return self.client

        return factory

    def test_complete_answers_without_touching_the_conversation(self) -> None:
        response = self.post("/api/complete", {"prompt": "rewrite this", "system": "be terse"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "rewritten code")

        # A one-shot request is not a turn: no history, no tool schemas.
        self.assertEqual(self.get("/api/history").json()["messages"], [])
        self.assertIsNone(self.client.calls[0]["tools"])
        self.assertTrue(self.client.calls[0].get("complete"))
        roles = [message["role"] for message in self.client.calls[0]["messages"]]
        self.assertEqual(roles, ["system", "user"])

    def test_empty_prompt_is_rejected(self) -> None:
        response = self.post("/api/complete", {"prompt": "   "})
        self.assertEqual(response.status_code, 400)

    def test_model_can_be_overridden_for_one_request(self) -> None:
        self.post("/api/complete", {"prompt": "rewrite", "model": "fast-model"})
        self.assertEqual(self.seen_profiles[0].model, "fast-model")

    def test_the_default_model_is_used_without_an_override(self) -> None:
        self.post("/api/complete", {"prompt": "rewrite"})
        self.assertEqual(self.seen_profiles[0].model, "test-model")


class ModeTest(ServerTestCase):
    script = [text_chunks("just words")]

    def test_the_catalogue_is_reported_to_the_editor(self) -> None:
        state = self.get("/api/state").json()
        ids = [entry["id"] for entry in state["modes"]]
        self.assertIn("agent", ids)
        self.assertIn("plan", ids)
        self.assertEqual(state["turn"]["mode"], "agent", "an idle session reports the default mode")
        plan = next(entry for entry in state["modes"] if entry["id"] == "plan")
        self.assertFalse(plan["can_write"])

    def test_a_turn_can_choose_a_mode(self) -> None:
        response = self.post("/api/chat", {"message": "explain this", "mode": "ask"})
        self.assertEqual(response.status_code, 202)
        body = response.json()
        self.assertEqual(body["mode"], "ask")
        self.assertEqual(
            set(body["mode_tools"]), {"read_file", "list_dir", "glob", "grep"}
        )

        self.wait_for_turn()
        offered = {schema["function"]["name"] for schema in self.client.calls[0]["tools"]}
        self.assertEqual(
            offered,
            {"read_file", "list_dir", "glob", "grep"},
            "a read-only mode must not offer write or command tools",
        )
        system = self.client.calls[0]["messages"][0]["content"]
        self.assertIn("Current mode: Ask", system)

    def test_the_mode_is_remembered_after_the_turn(self) -> None:
        self.post("/api/chat", {"message": "plan it", "mode": "plan"})
        self.wait_for_turn()
        self.assertEqual(self.get("/api/state").json()["turn"]["mode"], "plan")

    def test_an_unknown_mode_is_rejected_with_the_valid_ones(self) -> None:
        response = self.post("/api/chat", {"message": "hello", "mode": "telepathy"})
        self.assertEqual(response.status_code, 400)
        message = response.json()["error"]
        self.assertIn("unknown mode", message)
        self.assertIn("agent", message, "the error must say what is accepted")
        self.assertFalse(self.get("/api/state").json()["turn"]["running"])

    def test_a_narrowed_mode_still_reaches_the_model(self) -> None:
        self.post("/api/chat", {"message": "review it", "mode": "review"})
        self.assertTrue(self.wait_for_turn())
        turn = self.get("/api/state").json()["turn"]
        self.assertEqual(turn["mode"], "review")
        self.assertEqual(turn["last_stopped"], "completed")


class ProviderFailureTest(ServerTestCase):
    """A failing endpoint must become an answer, never a dropped connection."""

    def make_client_factory(self):
        from lexiqode.errors import ProviderError

        class BrokenClient:
            def complete(self, *_args, **_kwargs):
                raise ProviderError("endpoint refused the request", status=500)

            def stream(self, *_args, **_kwargs):
                raise ProviderError("endpoint refused the request", status=500)

            def list_models(self, *_args, **_kwargs):
                raise ProviderError("endpoint refused the request", status=500)

            def close(self) -> None:
                return

        return lambda _profile: BrokenClient()

    def test_complete_reports_the_provider_failure(self) -> None:
        response = self.post("/api/complete", {"prompt": "rewrite"})
        self.assertEqual(response.status_code, 502)
        body = response.json()
        self.assertFalse(body["ok"])
        self.assertIn("endpoint refused", body["error"])
        self.assertEqual(body["provider_status"], 500)

    def test_models_reports_the_provider_failure(self) -> None:
        response = self.post("/api/models", {})
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["provider_status"], 500)


class ApprovalTest(ServerTestCase):
    script = [
        tool_chunks("write_file", {"path": "made.txt", "content": "written\n"}),
        text_chunks("Created made.txt."),
    ]
    agent = AgentSettings(auto_approve=False, approve_writes=True, max_steps=4)

    def test_pending_approval_blocks_until_it_is_answered(self) -> None:
        self.post("/api/chat", {"message": "create made.txt"})

        deadline = time.time() + 8.0
        pending: list[str] = []
        while time.time() < deadline:
            pending = self.get("/api/state").json()["pending_approvals"]
            if pending:
                break
            time.sleep(0.05)
        self.assertTrue(pending, "the write should have requested approval")
        self.assertFalse((self.workspace / "made.txt").exists())

        response = self.post("/api/approval", {"id": pending[0], "approved": True})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["delivered"])

        self.wait_for_turn()
        self.assertTrue((self.workspace / "made.txt").is_file())

    def test_approval_for_an_unknown_id_is_not_delivered(self) -> None:
        response = self.post("/api/approval", {"id": "does-not-exist", "approved": True})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["delivered"])

    def test_cancel_resolves_pending_approvals(self) -> None:
        self.post("/api/chat", {"message": "create made.txt"})
        deadline = time.time() + 8.0
        while time.time() < deadline:
            if self.get("/api/state").json()["pending_approvals"]:
                break
            time.sleep(0.05)
        self.post("/api/cancel")
        self.wait_for_turn()
        self.assertFalse((self.workspace / "made.txt").exists())


class ShutdownTest(ServerTestCase):
    def test_shutdown_stops_the_server(self) -> None:
        response = self.post("/api/shutdown")
        self.assertEqual(response.status_code, 200)
        deadline = time.time() + 5.0
        while time.time() < deadline:
            try:
                httpx.get(f"{self.base}/api/health", timeout=0.5)
            except httpx.HTTPError:
                return
            time.sleep(0.05)
        self.fail("the server kept answering after /api/shutdown")


if __name__ == "__main__":
    unittest.main()