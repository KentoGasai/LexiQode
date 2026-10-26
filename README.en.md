# LexiQode

An IDE with an AI assistant that runs on **your** endpoint: any server compatible
with the OpenAI `/chat/completions` API. No subscription, no account, no vendor
relay.

[Русская версия](README.md)

## What it is made of

| Part | What it is |
|---|---|
| The window | our own interface, served over an internal `app://` scheme |
| The editor | Monaco, the editing component from VS Code, used as a library |
| The terminal | xterm.js and a shell connected through pipes |
| The assistant | a separate Python core that the window starts and supervises |
| The model | any OpenAI-compatible endpoint you configure |
| Interface languages | Russian and English, switchable at runtime |

## Requirements

* Windows 10 or 11, 64-bit.
* **Python 3.11 or newer on `PATH`** for the assistant. The editor works without
  it, and the app says what is missing.
* No administrator rights: it is a folder you unpack and run.
* Node.js 24 only if you build it yourself.

## Install and run

**The simple way.** Unpack the archive and run `LexiQode.exe`:

```
dist\LexiQode-0.1.0-win32-x64.zip
```

The `.sha256` beside it carries the digest the build printed, so a download can be
checked.

**Install for the current user and make shortcuts** (no privileges needed):

```powershell
cd F:\Gitea\LexiQode2
powershell -ExecutionPolicy Bypass -File scripts\run-app.ps1 -Deploy
powershell -ExecutionPolicy Bypass -File scripts\create-shortcuts.ps1
```

**Run from the sources** (while changing code):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\run-app.ps1 -Source
```

**Build the archive again:**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-app.ps1
```

It runs the tests, stages the folder and writes the archive into `dist\`.
`-SkipTests` skips the tests.

## First run

The app **opens nothing by itself**. You get a screen with an *Open a folder*
button and the recent folders. A folder can also be opened:

* from the status bar, by clicking the leftmost item;
* with `Ctrl+K Ctrl+O`;
* through `Ctrl+Shift+P` → *Open folder…*;
* by passing a path: `LexiQode.exe F:\work\project` (an absolute path).

Then configure a model; without one the assistant will say that no model is
selected.

## Configuring the model

Open the assistant panel (`Ctrl+Shift+A`) and press the gear.

| Field | What goes in it |
|---|---|
| endpoint | a base URL, for example `https://api.example.com/v1` or `http://127.0.0.1:11434/v1` |
| api key | stored on your machine, sent only to that endpoint |
| model | the model id |

The model list is **fetched on its own** as soon as the endpoint and the key are
entered - there is nothing to save first. If the endpoint is unreachable or the
list is empty, the form shows why and offers *Ask again*.

The scan calls `GET {endpoint}/models`, which is how the OpenAI-compatible
protocol works; the base URL has to be the one that makes that path right.

The same settings can be set without the window:

```powershell
$env:LEXIQODE_BASE_URL = 'https://api.example.com/v1'
$env:LEXIQODE_API_KEY  = 'sk-...'
$env:LEXIQODE_MODEL    = 'your-model'
python -m lexiqode doctor
```

Where things live:

* `%APPDATA%\LexiQode\settings.json` - the agent: endpoint, key, model, limits;
* `%APPDATA%\LexiQode\app-settings.json` - the window: layout, theme, language,
  open tabs;
* `%LOCALAPPDATA%\LexiQode` - transcripts and other per-machine data.

## Modes

The mode is chosen in the composer at the bottom of the assistant panel, from a
dropdown with icons. It is the decision about what the next message may do, and it
is enforced by the core: a forbidden tool is removed from the schemas **and**
refused by the registry, so a mode cannot be talked around.

| Mode | Reads files | Writes | Runs commands |
|---|---|---|---|
| Agent | yes | yes | yes |
| Ask | yes | no | no |
| Plan | yes | no | no |
| Debug | yes | yes | yes |
| Review | yes | no | no |

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl+P` | go to a file |
| `Ctrl+Shift+P` | command palette |
| `Ctrl+S` | save the file |
| `Ctrl+Shift+S` | save all files |
| `Ctrl+Shift+F` | search across files |
| `Ctrl+B` | show or hide the sidebar |
| `Ctrl+J` | show or hide the bottom panel (terminal) |
| `Ctrl+Shift+A` | show or hide the assistant |
| `Ctrl+L` | focus the assistant's input |
| `Ctrl+Shift+E` | explorer |
| `Ctrl+Shift+G` | source control |
| `Ctrl+K Ctrl+O` | open a folder |
| `Esc` | close a list or the palette |

## Changing the interface language

The *window language* row in the agent settings, or the *Window language: change*
command in the palette, cycles system → Russian → English. By default it follows
the system.

Dictionaries are plain data files, `app/src/shared/i18n.ru.json` and
`app/src/shared/i18n.en.json`. Adding a language means adding such a file and one
code in `app/src/shared/i18n.js`; a test compares the files key by key.

## What it does

Explorer (create, rename, delete to the recycle bin, reveal); Monaco (syntax,
tabs, dirty state, line endings preserved on save, find in file); quick open;
find in files with cancellation; source control (staged and unstaged separated,
diffs, stage, unstage, discard, commit, branch switching); a terminal with a real
PowerShell session; the assistant with streaming, separately shown reasoning, tool
rows, approvals and cancel; a resizable, restorable layout; dark and light themes.

## What it does not do

* **The terminal is a command console.** Full-screen programs (`vim`, `top`) do not
  work in it, because a shell driven through pipes has no pseudo-console.
  Everything that reads a command and prints lines works.
* **No third-party extensions.** Languages, themes and commands come from the app.
* **Language intelligence is Monaco's.** Real language services for TypeScript,
  JavaScript, JSON, CSS and HTML; syntax, brackets and folding elsewhere.
* **One folder per window.**
* **No telemetry.** The window has no network access at all (`connect-src 'none'`);
  only the core uses the network, and only to reach your endpoint.
* Messages that come from the core are printed as the core phrased them.

## Tests

```powershell
cd core;  python -m pytest tests -q      # the agent, its tools and its protocol
cd app;   npm test                       # 111 tests: shared logic and window contracts
```

Two probes start the application and interrogate it:

```powershell
node app\scripts\probe-window.cjs        # the interface: tree, editor, search, terminal, modes, settings form
node app\scripts\probe-chat.cjs          # stands up an OpenAI stub and drives the core through it
```

The window's tests include a live shell test and static contracts: elements,
channels, imports, the key set of both dictionaries, and that the core serves the
routes this window calls.

## Building and publishing

There is no CI; builds are local:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-app.ps1
```

That produces the staged folder, `dist\LexiQode-<version>-win32-x64.zip` and its
digest file. The version comes from `app/package.json`.

To publish on GitHub, attach the archive to a release (requires `gh`):

```powershell
gh release create v0.1.0 `
  dist\LexiQode-0.1.0-win32-x64.zip `
  dist\LexiQode-0.1.0-win32-x64.zip.sha256 `
  --title "LexiQode 0.1.0" --notes "First build"
```

For an existing release: `gh release upload v0.1.0 path\to\archive`.

## Repository layout

```
app/                  the window
  src/main/           window, IPC, workspace, search, git, terminal, agent bridge
  src/preload/        the entire surface the page may call
  src/renderer/       the interface: markup, styles, modules
  src/shared/         logic both sides use, and the language dictionaries
  test/               the window's tests
core/                 the Python agent, with its own tests
scripts/              build, run, shortcuts
docs/protocol.md      the protocol between the window and the core
```

## Licence

MIT. The build uses Monaco (MIT) and xterm.js (MIT).