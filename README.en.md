# LexiQode

An IDE whose assistant runs on **your** endpoint.

No subscription, no account, no vendor relay. Point it at anything that speaks the
OpenAI `chat/completions` API - a hosted gateway, a local runtime, your own proxy -
and the agent works in the folder you opened: reading files, editing them, running
commands, with a mode that decides what it may do.

[Русская версия](README.md)

## What it is

| Layer | Choice |
|---|---|
| The window | our own markup, styles and modules, served over an `app://` scheme |
| The editor | Monaco, the editing component from VS Code, used as a library |
| The terminal | xterm.js driving a shell through pipes |
| The assistant | our own Python core, started and supervised by the window |
| The model | any OpenAI-compatible endpoint, configured by you |
| Window languages | Russian and English, switchable at runtime |

This started as a patched build of the VS Code sources. That path is retired: two
days went into fighting a 40-minute native build and a window that insisted on
showing somebody else's chat, and none of it produced anything the user could see.

## Requirements

* Windows 10 or 11, 64-bit.
* **Python 3.11 or newer on `PATH`** for the assistant. The editor half runs
  without it, and the app says so.
* No administrator rights: it is a folder you unpack and run.
* Node.js 24 only if you build it yourself.

## Run it

**A built bundle.** Unpack `dist\LexiQode-<version>-win32-x64.zip` and run
`LexiQode.exe`. The `.sha256` beside the zip carries the same digest the build
printed.

**Install for the current user and make shortcuts** (no privileges needed):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-app.ps1 -Deploy
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
```

**From the sources** (after changing code):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-app.ps1 -Source
```

**Rebuild the bundle:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-app.ps1
```

It runs both test suites, stages the folder, and writes the zip and its digest into
`dist\`. `-SkipTests` skips the suites.

## It opens a folder only when asked

The app opens nothing by itself. Started with no argument it shows a welcome screen
with an *Open a folder* button and the recent folders. A folder can also be opened
by clicking the leftmost item in the status bar, with `Ctrl+K Ctrl+O`, through
`Ctrl+Shift+P` → *Open folder…*, or by passing an absolute path:
`LexiQode.exe F:\work\project`.

`files.reopenLastFolder` in `app-settings.json` turns the old behaviour back on; it
is off by default.

## Point it at a model

Open the assistant (`Ctrl+Shift+A`), press the gear, and fill in the **endpoint**,
the **api key** and the **model**. The model list is fetched on its own as soon as
the endpoint and the key are typed, and you pick from it - the request uses what is
typed, so there is nothing to save first.

The same settings can be set without the window:

```powershell
$env:LEXIQODE_BASE_URL = 'https://api.example.com/v1'
$env:LEXIQODE_API_KEY  = 'sk-...'
$env:LEXIQODE_MODEL    = 'your-model'
python -m lexiqode doctor
```

Settings live in `%APPDATA%\LexiQode` (`settings.json` for the agent,
`app-settings.json` for the window); transcripts and per-machine data live in
`%LOCALAPPDATA%\LexiQode`.

## Modes

The mode sits in the composer and is a **dropdown with icons**, because it is the
decision about what the next message may do. Modes are enforced by the core: an
excluded tool is removed from the schemas **and** refused by the registry.

| Mode | Reads | Writes | Runs |
|---|---|---|---|
| Agent | yes | yes | yes |
| Ask | yes | no | no |
| Plan | yes | no | no |
| Debug | yes | yes | yes |
| Review | yes | no | no |

## Changing the language

The window language is changed in the agent settings (*window language*) or with the
*Window language: change* command in the palette, which cycles system → Russian →
English. By default it follows the system.

Dictionaries are plain data files, `app/src/shared/i18n.ru.json` and
`app/src/shared/i18n.en.json`. Adding a language means adding such a file and one
code in `app/src/shared/i18n.js`; a test compares the files key by key and will not
let them drift.

## What works

Verified by driving the built application through the DevTools protocol, not by
reading the code (`app/scripts/probe-window.cjs`): file tree with create, rename and
delete to the recycle bin; Monaco with tabs, dirty state and CRLF preserved on save;
quick open; find in files with streaming and cancellation; source control with
staged and unstaged separated, diffs, stage, unstage, discard, commit and branch
switching; a real PowerShell session that keeps its directory; the assistant with
streaming, separately shown reasoning, tool rows, approvals, cancel and a new
conversation; a resizable, restorable layout; dark and light themes; and both
languages.

## What it deliberately does not do

* **The terminal is a command console.** A shell driven through pipes has no
  pseudo-console, so full-screen programs cannot run in it; everything that reads a
  command and prints lines does.
* **No extension API.**
* **Language intelligence is Monaco's**: real services for TypeScript, JavaScript,
  JSON, CSS and HTML; syntax, brackets and folding elsewhere.
* **One folder per window.**
* **No telemetry, and no network access from the window at all** - it is served with
  `connect-src 'none'`.
* **Some text is still English**: messages that come from the core (a model error,
  for instance) are printed as the core phrased them.

## Layout

```
app/                  the window: Electron main process, preload, our interface
  src/main/           window, IPC, workspace, search, git, terminal, agent bridge
  src/preload/        the entire surface the page is allowed to call
  src/renderer/       the interface: markup, styles, modules
  src/shared/         logic both sides use, and the language dictionaries
  test/               108 tests, `npm test`
core/                 the agent: Python, OpenAI-compatible, its own test suite
scripts/              build, run, publish, and the probes
docs/                 the core protocol and the package registry notes
```

## Tests

```powershell
cd core;  python -m pytest tests -q
cd app;   npm test
node app\scripts\probe-window.cjs        # starts the app and interrogates the window
node app\scripts\probe-chat.cjs          # starts a stub endpoint and drives the core
```

The window's tests include a live shell test and static contracts over its sources:
every element looked up must exist, every channel must exist in the shared
constants, every import must resolve, only the icon set and the markdown renderer
may produce markup, and both dictionaries must carry every key the code asks for.

The window probe is a smoke test against the real application - the thing that found
a terminal rendering nothing when the panel was restored open, and a fuzzy scorer
ranking `a-p-p-deep.js` above `app.js`. `LEXIQODE_PROBE_EXE` points it at a packaged
bundle instead of the sources.

## Publishing

`scripts/publish-gitea.ps1` uploads a built zip to Gitea's generic package registry.
See [docs/gitea-packages.md](docs/gitea-packages.md).