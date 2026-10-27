"""Settings, paths and profile resolution."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from lexiqode.config import (
    ENV_API_KEY,
    ENV_BASE_URL,
    ENV_CONFIG_DIR,
    ENV_DATA_DIR,
    ENV_MODEL,
    SETTINGS_VERSION,
    AgentSettings,
    ModelProfile,
    Settings,
    config_dir,
    data_dir,
    redact,
    settings_path,
)
from lexiqode.errors import ConfigError


class ConfigPathsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self._saved = {
            key: os.environ.get(key)
            for key in (ENV_CONFIG_DIR, ENV_DATA_DIR, ENV_BASE_URL, ENV_API_KEY, ENV_MODEL)
        }
        os.environ[ENV_CONFIG_DIR] = str(Path(self._temp.name) / "cfg")
        os.environ[ENV_DATA_DIR] = str(Path(self._temp.name) / "data")
        for key in (ENV_BASE_URL, ENV_API_KEY, ENV_MODEL):
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        for key, value in self._saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_overrides_are_honoured(self) -> None:
        self.assertEqual(config_dir(), Path(self._temp.name) / "cfg")
        self.assertEqual(data_dir(), Path(self._temp.name) / "data")
        self.assertEqual(settings_path(), Path(self._temp.name) / "cfg" / "settings.json")

    def test_defaults_are_used_without_overrides(self) -> None:
        os.environ.pop(ENV_CONFIG_DIR)
        os.environ.pop(ENV_DATA_DIR)
        self.assertIn("LexiQode", str(config_dir()))
        self.assertNotEqual(config_dir(), data_dir() if os.name == "nt" else config_dir())


class ProfileTest(unittest.TestCase):
    def test_base_url_is_normalised(self) -> None:
        cases = {
            "https://api.example.com": "https://api.example.com/v1",
            "https://api.example.com/": "https://api.example.com/v1",
            "https://api.example.com/v1": "https://api.example.com/v1",
            "https://gateway.example.com/openai/v1": "https://gateway.example.com/openai/v1",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                profile = ModelProfile(id="p", base_url=raw, model="m").normalised()
                self.assertEqual(profile.base_url, expected)

    def test_urls_are_derived(self) -> None:
        profile = ModelProfile(id="p", base_url="http://localhost:1234/v1", model="m").normalised()
        self.assertEqual(profile.chat_completions_url(), "http://localhost:1234/v1/chat/completions")
        self.assertEqual(profile.models_url(), "http://localhost:1234/v1/models")

    def test_missing_base_url_raises(self) -> None:
        with self.assertRaises(ConfigError):
            ModelProfile(id="p", model="m").chat_completions_url()

    def test_public_view_hides_the_key(self) -> None:
        profile = ModelProfile(id="p", base_url="http://x/v1", model="m", api_key="secret-value")
        public = profile.to_public()
        self.assertEqual(public["api_key"], "")
        self.assertTrue(public["has_api_key"])
        self.assertNotIn("secret-value", json.dumps(public))


class RoundTripTest(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.path = Path(self._temp.name) / "settings.json"

    def test_save_and_load_round_trip(self) -> None:
        settings = Settings()
        settings.set_profile(
            ModelProfile(id="local", base_url="http://localhost:8000", model="qwen", api_key="k")
        )
        settings.agent = AgentSettings(max_steps=7, auto_approve=True)
        settings.save(self.path)

        loaded = Settings.load(self.path)
        self.assertEqual(loaded.agent.max_steps, 7)
        self.assertTrue(loaded.agent.auto_approve)
        self.assertEqual(loaded.profiles["local"].base_url, "http://localhost:8000/v1")
        self.assertEqual(loaded.profiles["local"].api_key, "k")

    def test_save_is_atomic_and_leaves_no_temp_file(self) -> None:
        Settings().save(self.path)
        leftovers = [item.name for item in self.path.parent.iterdir() if item.name != "settings.json"]
        self.assertEqual(leftovers, [])

    def test_malformed_file_is_reported(self) -> None:
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(ConfigError):
            Settings.load(self.path)

    def test_missing_file_yields_a_default_profile(self) -> None:
        settings = Settings.load(self.path)
        self.assertIn("default", settings.profiles)

    def test_unknown_profile_field_is_rejected(self) -> None:
        self.path.write_text(
            json.dumps({"profiles": {"default": {"id": "default", "nonsense": 1}}}),
            encoding="utf-8",
        )
        with self.assertRaises(ConfigError):
            Settings.load(self.path)

    def test_effective_profile_prefers_environment(self) -> None:
        settings = Settings()
        settings.set_profile(ModelProfile(id="a", base_url="http://a", model="model-a"))
        settings.set_profile(ModelProfile(id="b", base_url="http://b", model="model-b"))
        settings.active_profile = "a"

        self.assertEqual(settings.effective_profile().model, "model-a")
        self.assertEqual(settings.effective_profile("b").model, "model-b")

        saved = os.environ.get(ENV_BASE_URL)
        os.environ[ENV_BASE_URL] = "http://override"
        try:
            resolved = settings.effective_profile()
            self.assertEqual(resolved.base_url, "http://override/v1")
            self.assertEqual(resolved.model, "model-a")
        finally:
            if saved is None:
                os.environ.pop(ENV_BASE_URL, None)
            else:
                os.environ[ENV_BASE_URL] = saved

    def test_effective_profile_requires_a_model(self) -> None:
        settings = Settings()
        settings.set_profile(ModelProfile(id="default", base_url="http://x"))
        with self.assertRaises(ConfigError):
            settings.effective_profile()

    def test_redacted_output_never_contains_the_key(self) -> None:
        settings = Settings()
        settings.set_profile(
            ModelProfile(id="default", base_url="http://x", model="m", api_key="topsecret123")
        )
        blob = json.dumps(settings.redacted())
        self.assertNotIn("topsecret123", blob)
        self.assertIn("paths", json.loads(blob))

    def test_redact_helper(self) -> None:
        self.assertEqual(redact(""), "<unset>")
        self.assertEqual(redact("short"), "*" * 5)
        self.assertTrue(redact("a" * 40).startswith("aaaa"))
        self.assertNotIn("a" * 40, redact("a" * 40))


class SettingsMigrationTest(unittest.TestCase):
    """A settings file written by an older build is brought forward, once.

    A backstop nobody chose is not a decision, and leaving it alone is what made
    a working session drop messages at the end of nearly every turn: the message
    ceiling of an agent turn is spent in a few steps. A number somebody typed is a
    decision, and stays.
    """

    def test_the_old_message_ceiling_is_raised(self) -> None:
        settings = Settings.from_dict({"version": 1, "agent": {"max_history_messages": 60}})

        self.assertEqual(settings.agent.max_history_messages, AgentSettings().max_history_messages)
        self.assertEqual(settings.version, SETTINGS_VERSION)

    def test_a_ceiling_somebody_chose_is_left_alone(self) -> None:
        settings = Settings.from_dict({"version": 1, "agent": {"max_history_messages": 250}})

        self.assertEqual(settings.agent.max_history_messages, 250)

    def test_a_current_file_is_not_touched(self) -> None:
        settings = Settings.from_dict(
            {"version": SETTINGS_VERSION, "agent": {"max_history_messages": 60}}
        )

        self.assertEqual(settings.agent.max_history_messages, 60)


if __name__ == "__main__":
    unittest.main()