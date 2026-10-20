"""CLI behaviour, including the stdout handshake the extension depends on."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from lexiqode.cli import build_parser, main
from lexiqode.config import ModelProfile, Settings
from lexiqode.version import HANDSHAKE_PREFIX

CORE_DIR = Path(__file__).resolve().parents[1]


class CliTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = Path(self._temp.name)
        self.cfg = self.root / "cfg"
        self.data = self.root / "data"
        self.workspace = self.root / "project"
        self.workspace.mkdir()
        self.settings_file = self.cfg / "settings.json"

        self._saved = {
            key: os.environ.get(key)
            for key in ("LEXIQODE_CONFIG_DIR", "LEXIQODE_DATA_DIR", "LEXIQODE_RUNTIME_FILE")
        }
        os.environ["LEXIQODE_CONFIG_DIR"] = str(self.cfg)
        os.environ["LEXIQODE_DATA_DIR"] = str(self.data)
        self.addCleanup(self._restore_env)

    def _restore_env(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def write_settings(self, base_url: str = "http://127.0.0.1:1/v1") -> None:
        settings = Settings()
        settings.set_profile(ModelProfile(id="default", base_url=base_url, model="test-model"))
        settings.save(self.settings_file)


class ParserTest(unittest.TestCase):
    def test_all_commands_are_registered(self) -> None:
        parser = build_parser()
        actions = [action for action in parser._actions if hasattr(action, "choices") and action.choices]
        commands = set()
        for action in actions:
            commands.update(action.choices)
        self.assertEqual(commands, {"serve", "run", "chat", "tools", "doctor", "config"})

    def test_serve_defaults(self) -> None:
        args = build_parser().parse_args(["serve"])
        self.assertTrue(args.handshake)
        self.assertTrue(args.exit_on_stdin_close)
        self.assertEqual(args.port, 0)
        self.assertEqual(args.host, "127.0.0.1")


class ToolsCommandTest(CliTestCase):
    def test_tools_lists_the_builtins(self) -> None:
        self.assertEqual(main(["tools"]), 0)

    def test_tools_json_is_machine_readable(self) -> None:
        import io
        from contextlib import redirect_stdout

        buffer = io.StringIO()
        with redirect_stdout(buffer):
            self.assertEqual(main(["tools", "--json"]), 0)
        names = {entry["name"] for entry in json.loads(buffer.getvalue())}
        self.assertEqual(
            names,
            {"read_file", "list_dir", "glob", "grep", "write_file", "edit_file", "run_command"},
        )


class ConfigCommandTest(CliTestCase):
    def test_init_creates_the_file(self) -> None:
        self.assertEqual(main(["config", "init"]), 0)
        self.assertTrue(self.settings_file.is_file())

    def test_set_and_get_round_trip(self) -> None:
        main(["config", "init"])
        self.assertEqual(
            main(["config", "set", "profile.default.base_url", "https://gateway.test"]), 0
        )
        self.assertEqual(main(["config", "set", "profile.default.model", "my-model"]), 0)
        self.assertEqual(main(["config", "set", "agent.max_steps", "9"]), 0)
        self.assertEqual(main(["config", "set", "agent.auto_approve", "true"]), 0)

        loaded = Settings.load(self.settings_file)
        self.assertEqual(loaded.profiles["default"].base_url, "https://gateway.test/v1")
        self.assertEqual(loaded.profiles["default"].model, "my-model")
        self.assertEqual(loaded.agent.max_steps, 9)
        self.assertTrue(loaded.agent.auto_approve)

    def test_unknown_key_is_rejected(self) -> None:
        main(["config", "init"])
        self.assertEqual(main(["config", "set", "nonsense", "1"]), 1)
        self.assertEqual(main(["config", "set", "profile.default.nope", "1"]), 1)

    def test_path_action(self) -> None:
        self.assertEqual(main(["config", "path"]), 0)


class DoctorCommandTest(CliTestCase):
    def test_unreachable_endpoint_is_a_problem(self) -> None:
        self.write_settings("http://127.0.0.1:1/v1")
        self.assertEqual(main(["doctor"]), 1)

    def test_missing_base_url_is_a_problem(self) -> None:
        settings = Settings()
        settings.set_profile(ModelProfile(id="default", model="test-model"))
        settings.save(self.settings_file)
        self.assertEqual(main(["doctor"]), 1)

    def test_stale_workspace_is_reported_not_crashing(self) -> None:
        self.write_settings()
        settings = Settings.load(self.settings_file)
        settings.last_workspace = str(self.root / "gone")
        settings.save(self.settings_file)
        # The endpoint problem still dominates, but a missing workspace must not
        # raise: this used to be an unhandled error.
        self.assertEqual(main(["doctor"]), 1)


class ServeTest(CliTestCase):
    """Runs ``serve`` as a real child process, exactly as the extension does."""

    def start_serve(self) -> tuple[subprocess.Popen, Path]:
        runtime = self.root / "core-runtime.json"
        os.environ["LEXIQODE_RUNTIME_FILE"] = str(runtime)
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        process = subprocess.Popen(
            [sys.executable, "-m", "lexiqode", "serve", str(self.workspace)],
            cwd=str(CORE_DIR),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        self.addCleanup(self._kill, process)
        return process, runtime

    @staticmethod
    def _kill(process: subprocess.Popen) -> None:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)

    def test_handshake_is_one_parseable_line(self) -> None:
        self.write_settings()
        process, runtime = self.start_serve()

        line = process.stdout.readline()
        self.assertTrue(line.startswith(HANDSHAKE_PREFIX), f"unexpected stdout: {line!r}")
        payload = json.loads(line[len(HANDSHAKE_PREFIX):].strip())
        self.assertEqual(payload["protocol"], 1)
        self.assertEqual(payload["product"], "LexiQode")
        self.assertEqual(Path(payload["workspace"]).as_posix(), self.workspace.as_posix())
        self.assertTrue(payload["token"])
        self.assertGreater(payload["port"], 0)

        # The unauthenticated health probe must agree with that line.
        with urllib.request.urlopen(f"{payload['base_url']}/api/health", timeout=5) as response:
            health = json.loads(response.read().decode("utf-8"))
        self.assertTrue(health["ok"])
        self.assertEqual(health["pid"], payload["pid"])

        descriptor = json.loads(runtime.read_text(encoding="utf-8"))
        self.assertEqual(descriptor["token"], payload["token"])

        # Closing stdin is the cross-platform way for the editor to stop a core.
        process.stdin.close()
        self.assertEqual(process.wait(timeout=15), 0)
        self.assertFalse(runtime.exists(), "the runtime descriptor should be removed on exit")

    def test_missing_workspace_fails_without_a_handshake(self) -> None:
        self.write_settings()
        env = os.environ.copy()
        process = subprocess.run(
            [sys.executable, "-m", "lexiqode", "serve", str(self.root / "absent")],
            cwd=str(CORE_DIR),
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=30,
        )
        self.assertEqual(process.returncode, 1)
        self.assertEqual(process.stdout.strip(), "", "no handshake may be printed on failure")
        self.assertIn("does not exist", process.stderr)

    def test_core_serves_an_authenticated_request(self) -> None:
        self.write_settings()
        process, _ = self.start_serve()
        line = process.stdout.readline()
        payload = json.loads(line[len(HANDSHAKE_PREFIX):].strip())

        request = urllib.request.Request(
            f"{payload['base_url']}/api/ping",
            headers={"Authorization": f"Bearer {payload['token']}"},
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            self.assertEqual(json.loads(response.read().decode("utf-8")), {"ok": True, "pong": True})

        process.stdin.close()
        process.wait(timeout=15)


if __name__ == "__main__":
    unittest.main()