# Changelog

Versions follow [semantic versioning](https://semver.org/): the major number
marks a change no older configuration survives, the minor number a release that
adds features, and the patch number a release that only fixes them. Nothing in
this file is retrospective filler - each entry is a change that was made,
measured on a running window, and re-checked by a test or a probe.

## Unreleased - planned 0.3.0

Everything below is in the repository and verified by the suite and the probes,
and none of it is in the 0.2.0 tag: the tag is published, so these changes belong
to the next release rather than to a rewritten past.

### Files are coloured again

* A file was given its own extension as its language, so `.js`, `.ts`, `.py`,
  `.md`, `.ps1` and `.yml` were never a language Monaco knew: they opened as
  plain text, with no colours and no language service, and nothing threw to say
  so. Only `.json`, `.css` and `.html` looked right, and only because for those
  three the extension and the language id happen to be the same word.
* The language is now asked of Monaco's own registry - name first, so a
  `Dockerfile` or a `Makefile` is recognised, then extension - and the id the
  entry carries is what the model is created with.
* Measured on a running window: seven files of seven kinds, each with the right
  language id and between 3 and 8 distinct token colours. Before the change, all
  seven were `plaintext` with one.

### The message's context is the user's to edit

* A file that appeared in the context by itself could not be taken out. Every file
  the next message will carry is now a chip with a cross, an "add a file" button
  offers the file in the editor, and the tree's own menu adds and removes files by
  right-click, where files are actually found.
* Removing means removing: taking out the file that is open in the editor sets
  it aside for the message instead of unpinning it and letting the preference
  draw it again.
* The pinned files are named in the preamble the agent receives, deduplicated and
  bounded, and they are named rather than read: the agent has tools for reading.

### The model, beside the mode

* The model in force is a chooser next to the mode button, where the two
  decisions that shape a message belong together. The list is the endpoint's own,
  asked once per profile, and choosing writes the model into the profile the core
  already has - so the endpoint, the key and the limits survive.

### A button for the theme, and settings of the window's own

* The theme has a button in the bottom-left corner of the status bar. It cycles
  dark, light and "follow the system", names the current theme and says what the
  next click will do; the palette command runs the same cycle.
* The window has a settings dialog at `Ctrl+,` (File ▸ Settings…, or the
  palette): appearance, editor, layout, files, terminal, assistant defaults,
  updates, and the version. Every control writes through the settings API, and
  the dialog redraws from the file rather than believing itself.
* `includeActiveFile` and `includeSelection` finally have a surface: they
  decided what every message carried and could only be changed in JSON.

### A folder opens with a shell in it

* Opening a folder shows a PowerShell session already in that folder in the
  bottom panel. A session belongs to the directory it was started in, so the one
  from the previous folder is closed rather than left pointing elsewhere.
  `terminal.openWithFolder` turns it off.

### A new release is looked for, and installed after the app has gone

* On start, and on demand from Help ▸ Check for Updates…, the newest release is
  read from GitHub. A newer one is offered in a window with its notes, a Download
  button and a link to the release page.
* The install is the part worth describing, because a running application cannot
  replace its own files on Windows. The archive is downloaded to
  `%APPDATA%\LexiQode\updates`, unpacked completely, and handed to
  `apply-update.ps1`, which is started detached and waits for the application's
  process to disappear. Only then is the application folder renamed aside, the
  new tree moved into its place, the new version started, and the old folder
  removed. If any step fails the previous version is renamed back and started
  again, and every step is appended to a log next to the archive.
* Settings and per-machine data live outside the application folder, so replacing
  it does not touch a single preference.
* A build started from source refuses to replace itself and says so.

### Verified

* 179 window tests and 162 core tests. Two new probes drive the real window: one
  opens files of seven kinds and counts the token colours, the other exercises
  the shell that opens with a folder, the model chooser, taking a file out of a
  message and putting it back, the theme button, the settings dialog and its
  write path, and what the update check reports.
* The update check was exercised against GitHub's release API itself, not only
  against a stub: pointed at a public repository it read the newest release,
  compared it with the running version, and picked an archive.

## 0.2.0 - 2026-10-26

The first release with a working assistant, and the reason this project exists at
all. 0.1.0 was an editor; this is an editor with an agent inside it.

### The assistant actually answers

* A turn no longer hangs before it reaches the model. The workspace snapshot ran
  `git status` with the core's stdin inherited, and the editor starts the core
  with a pipe nobody writes to: git waited on that pipe, so every turn blocked
  before the first token. Every command-line test passed, because a console's
  stdin is a terminal.
* The panel subscribes to the events the core emits. They were produced and
  never drawn, which is what an assistant that answers nothing looks like.
* Reasoning is one disclosure above the answer: open while the model thinks,
  folded to "Thought for Ns" when the answer starts, a click away at any time.
* Tool calls are one collapsed line per turn instead of a full-width row each,
  with the arguments the model actually sent - they used to render as
  `read_file [object Object]`.

### The context is managed instead of overflowing

* `context_window` is finally used. Past 75% of the window (minus the room an
  answer needs) the core asks the model to summarise the oldest part of the
  conversation, replaces it with that summary, and keeps the summary through
  later compactions. Before this, the only limit was a count of 60 messages
  applied after a turn had already run.
* The composer shows how full the window is, and says whether the number was
  reported by the server or estimated by the core.
* The context window, the answer budget and the compaction threshold are
  editable in the settings form; they were stored by the core and reachable
  nowhere.

### Chats are kept

* Every conversation is a document of its own, saved as it is written, listed by
  title, and opened in a tab. "New conversation" opens a new chat instead of
  resetting the current one into oblivion.
* Tabs are restored on the next start; a chat can be reopened from the list,
  renamed, or deleted, without touching the others.

### The window follows the folder

* The file tree updates when the folder changes on disk - a build, a
  `git checkout`, another editor, or the agent writing through the core. A file
  created outside the application appears on its own.
* A right-click opens a real menu: Open, Open to the side, Reveal in Explorer,
  Copy path, Copy relative path, Rename, Delete - and for empty space, New file,
  New folder, Reveal folder, Copy path, Refresh.
* The theme is switchable from the settings (system, dark, light), not only from
  the command palette.
* The model the agent is actually configured with is named in the status bar, and
  the folder that is open is named in the title bar with a button that opens
  another one.

### Core and interface

* 162 core tests, 145 window tests, and four probes that drive a real application
  window and report what it shows.
* Settings written through the API are coerced to the type their field declares,
  so a quoted `"128000"` cannot stop the agent with a `TypeError` in arithmetic
  the user never sees.
* The core and the application report one version. They used to disagree: the
  artefact was named 0.1.0 and the core introduced itself as 1.0.0.

## 0.1.0 - 2026-10-25

The first working build: a Windows editor with a file tree, a Monaco editor with
tabs, find in files, a git panel, a real PowerShell terminal, and an assistant
panel that could reach an OpenAI-compatible endpoint the user configured.

Not a public release. Kept in the changelog because the repository has no tags
before this one, and a first entry that pretends to be a first release would be
wrong.