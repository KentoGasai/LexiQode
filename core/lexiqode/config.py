"""Settings, filesystem locations and OpenAI-compatible model profiles.

Location policy
---------------
LexiQode keeps its own state in the platform's roaming profile
(``%APPDATA%\\LexiQode`` on Windows, ``~/.config/LexiQode`` elsewhere). Roaming
was chosen deliberately: it is a directory no other tool on this machine uses,
so nothing here can collide with or overwrite somebody else's configuration.
Both locations can be redirected for tests and portable installs with
``LEXIQODE_CONFIG_DIR`` and ``LEXIQODE_DATA_DIR``.

Model policy
------------
A "profile" is one OpenAI-compatible endpoint: a base URL, an API key, a model
id and the limits the agent loop has to respect. Any server that speaks
``/chat/completions`` works - hosted gateways, local runtimes, or a private
proxy. Nothing in the core assumes a specific vendor, and no request is ever
made to an endpoint the user did not configure.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path
from typing import Any

from .errors import ConfigError
from .version import PRODUCT_NAME

#: Environment overrides. The first three let a shell or a CI job point the core
#: at a different endpoint without editing the settings file.
ENV_CONFIG_DIR = "LEXIQODE_CONFIG_DIR"
ENV_DATA_DIR = "LEXIQODE_DATA_DIR"
ENV_BASE_URL = "LEXIQODE_BASE_URL"
ENV_API_KEY = "LEXIQODE_API_KEY"
ENV_MODEL = "LEXIQODE_MODEL"
ENV_PROFILE = "LEXIQODE_PROFILE"
ENV_RUNTIME_FILE = "LEXIQODE_RUNTIME_FILE"

SETTINGS_FILE_NAME = "settings.json"

#: Bumped when the on-disk layout changes in a way that needs migration.
SETTINGS_VERSION = 1


def _roaming_root() -> Path:
    if os.name == "nt":
        base = os.environ.get("APPDATA")
        return Path(base) if base else Path.home() / "AppData" / "Roaming"
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def _local_root() -> Path:
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA")
        return Path(base) if base else Path.home() / "AppData" / "Local"
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state")


def config_dir() -> Path:
    """Directory holding settings and the runtime descriptor."""

    override = os.environ.get(ENV_CONFIG_DIR, "").strip()
    return Path(override).expanduser() if override else _roaming_root() / PRODUCT_NAME


def data_dir() -> Path:
    """Directory holding sessions, logs and other per-machine state."""

    override = os.environ.get(ENV_DATA_DIR, "").strip()
    return Path(override).expanduser() if override else _local_root() / PRODUCT_NAME


def settings_path() -> Path:
    return config_dir() / SETTINGS_FILE_NAME


def logs_dir() -> Path:
    return data_dir() / "logs"


def sessions_dir() -> Path:
    return data_dir() / "sessions"


def conversations_dir() -> Path:
    """Saved chats, one file per conversation, one folder per workspace."""

    return data_dir() / "conversations"


def runtime_descriptor_path() -> Path:
    """Where a running core publishes how to reach it.

    A second editor window reads this to *attach* to the live core instead of
    starting a competing one, which is what keeps a single agent state across
    windows.
    """

    override = os.environ.get(ENV_RUNTIME_FILE, "").strip()
    if override:
        return Path(override).expanduser()
    return config_dir() / "core-runtime.json"


@dataclass(slots=True)
class ModelProfile:
    """One OpenAI-compatible endpoint plus the limits of the loop using it."""

    id: str
    label: str = ""
    base_url: str = ""
    api_key: str = ""
    model: str = ""
    context_window: int = 128_000
    max_output_tokens: int = 8_192
    temperature: float = 0.0
    #: Extra request headers, for gateways that need a routing or project key.
    headers: dict[str, str] = field(default_factory=dict)
    #: Whether the endpoint accepts a ``tools`` array. Small local models often
    #: do not; the loop degrades to prompt-driven tool calls when this is false.
    supports_tools: bool = True
    #: Ask for token accounting in the stream. Some proxies reject the field, so
    #: the client retries without it.
    stream_usage: bool = True

    def normalised(self) -> "ModelProfile":
        """Return a copy with the endpoint URL and model id made consistent."""

        base = (self.base_url or "").strip().rstrip("/")
        if base and not base.endswith("/v1") and "/v1/" not in base + "/":
            # Users paste either the host root or the full base; accept both.
            base = base if base.rsplit("/", 1)[-1].startswith("v") else f"{base}/v1"
        label = self.label or self.id
        return replace(self, base_url=base, label=label, model=self.model.strip())

    def chat_completions_url(self) -> str:
        base = self.base_url.rstrip("/")
        if not base:
            raise ConfigError(f"profile {self.id!r} has no base_url configured")
        return f"{base}/chat/completions"

    def models_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/models"

    def to_public(self) -> dict[str, Any]:
        """Serialise for the editor, replacing the key with a presence flag."""

        data = asdict(self)
        data["api_key"] = ""
        data["has_api_key"] = bool(self.api_key)
        return data


@dataclass(slots=True)
class AgentSettings:
    """How far the loop may go on its own."""

    max_steps: int = 40
    #: Run tools without asking. Off by default: writing files and running shell
    #: commands deserve an explicit decision.
    auto_approve: bool = False
    #: Per-family switches, honoured when ``auto_approve`` is off.
    approve_writes: bool = True
    approve_commands: bool = True
    command_timeout: int = 120
    #: Lines of file content a single read may return.
    max_read_lines: int = 400
    #: Characters a single tool result may contribute to the conversation.
    max_tool_output: int = 24_000
    #: Fraction of the model's context window at which the conversation is
    #: compacted instead of being sent whole. The window itself belongs to the
    #: profile (``ModelProfile.context_window``), because it is a property of the
    #: model and not of how the agent behaves; what belongs here is when to act
    #: on it.
    compact_at: float = 0.75
    #: Hard ceiling on stored messages, whatever the window would allow. A
    #: backstop for an endpoint whose tokens are far more expensive than the
    #: four-characters-per-token estimate assumes.
    max_history_messages: int = 60


@dataclass(slots=True)
class Settings:
    version: int = SETTINGS_VERSION
    active_profile: str = "default"
    profiles: dict[str, ModelProfile] = field(default_factory=dict)
    agent: AgentSettings = field(default_factory=AgentSettings)
    #: Last workspace opened, only used to preselect a folder in the editor.
    last_workspace: str = ""
    #: Preferred TCP port for the API. 0 picks a free port on every start.
    port: int = 0

    # ------------------------------------------------------------------ loading
    @classmethod
    def load(cls, path: Path | None = None) -> "Settings":
        target = path or settings_path()
        data: dict[str, Any] = {}
        if target.is_file():
            try:
                data = json.loads(target.read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                raise ConfigError(f"{target} is not readable JSON: {exc}") from exc
            if not isinstance(data, dict):
                raise ConfigError(f"{target} must contain a JSON object")
        settings = cls.from_dict(data)
        if not settings.profiles:
            settings.profiles = {"default": ModelProfile(id="default", label="Default")}
        return settings

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Settings":
        raw_profiles = data.get("profiles")
        profiles: dict[str, ModelProfile] = {}
        if isinstance(raw_profiles, dict):
            for key, value in raw_profiles.items():
                if not isinstance(value, dict):
                    continue
                # A typo such as "base_urll" would otherwise be dropped silently
                # and surface much later as a confusing "no base_url" error.
                unknown = sorted(set(value) - set(ModelProfile.__slots__))
                if unknown:
                    raise ConfigError(
                        f"profile {key!r} has unknown field(s): {', '.join(unknown)}"
                    )
                payload = dict(value)
                payload.setdefault("id", str(key))
                try:
                    profiles[str(key)] = ModelProfile(**payload).normalised()
                except TypeError as exc:  # unknown field in a hand-edited file
                    raise ConfigError(f"profile {key!r} is malformed: {exc}") from exc

        raw_agent = data.get("agent")
        agent = AgentSettings()
        if isinstance(raw_agent, dict):
            known = {k: v for k, v in raw_agent.items() if k in AgentSettings.__slots__}
            agent = AgentSettings(**known)

        port = data.get("port", 0)
        return cls(
            version=int(data.get("version", SETTINGS_VERSION)),
            active_profile=str(data.get("active_profile") or "default"),
            profiles=profiles,
            agent=agent,
            last_workspace=str(data.get("last_workspace") or ""),
            port=int(port) if str(port).isdigit() else 0,
        )

    def save(self, path: Path | None = None) -> Path:
        target = path or settings_path()
        target.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": self.version,
            "active_profile": self.active_profile,
            "profiles": {key: asdict(profile) for key, profile in self.profiles.items()},
            "agent": asdict(self.agent),
            "last_workspace": self.last_workspace,
            "port": self.port,
        }
        _atomic_write_json(target, payload)
        return target

    # ------------------------------------------------------------------ profiles
    def set_profile(self, profile: ModelProfile) -> None:
        self.profiles[profile.id] = profile.normalised()
        if self.active_profile not in self.profiles:
            self.active_profile = profile.id

    def effective_profile(
        self, profile_id: str | None = None, *, require_model: bool = True
    ) -> ModelProfile:
        """Resolve the profile the loop should use, applying environment overrides.

        Precedence: explicit argument -> ``LEXIQODE_PROFILE`` -> ``active_profile``
        -> the single configured profile. Environment variables then patch the
        individual fields so a shell can retarget the core without touching disk.

        ``require_model=False`` describes the profile *without* insisting it is
        usable. The daemon needs that: it has to come up and report "no model is
        configured" so the editor can offer to set one, instead of dying on
        startup and leaving the user with an exit code.
        """

        wanted = (profile_id or os.environ.get(ENV_PROFILE) or self.active_profile).strip()
        profile = self.profiles.get(wanted)
        if profile is None:
            if not self.profiles:
                raise ConfigError("no model profile is configured")
            profile = next(iter(self.profiles.values()))

        overrides: dict[str, Any] = {}
        if (base := os.environ.get(ENV_BASE_URL, "").strip()):
            overrides["base_url"] = base
        if (key := os.environ.get(ENV_API_KEY, "").strip()):
            overrides["api_key"] = key
        if (model := os.environ.get(ENV_MODEL, "").strip()):
            overrides["model"] = model
        resolved = replace(profile, **overrides).normalised()

        if require_model and not resolved.model:
            raise ConfigError(
                f"profile {resolved.id!r} has no model id; set one in the editor "
                f"settings or with {ENV_MODEL}"
            )
        return resolved

    def describe_profile(self, profile_id: str | None = None) -> ModelProfile:
        """The profile as configured, even when it is not yet usable."""

        return self.effective_profile(profile_id, require_model=False)

    def redacted(self) -> dict[str, Any]:
        """Settings safe to log or hand to the editor."""

        return {
            "version": self.version,
            "active_profile": self.active_profile,
            "profiles": {k: v.to_public() for k, v in self.profiles.items()},
            "agent": asdict(self.agent),
            "last_workspace": self.last_workspace,
            "port": self.port,
            "paths": {
                "config_dir": str(config_dir()),
                "data_dir": str(data_dir()),
                "settings": str(settings_path()),
            },
        }


def _atomic_write_json(target: Path, payload: Any) -> None:
    """Write JSON so a crash cannot leave a half-written settings file."""

    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(dir=str(target.parent), suffix=".tmp")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(payload, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, target)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def redact(secret: str) -> str:
    """Render a key for logs without leaking it."""

    if not secret:
        return "<unset>"
    if len(secret) <= 8:
        return "*" * len(secret)
    return f"{secret[:4]}...{secret[-4:]} ({len(secret)} chars)"