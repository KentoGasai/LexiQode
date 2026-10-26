# Roadmap

Where this is going: a Windows IDE where the agent is not a sidebar that talks,
but a participant that uses the same tools the editor does - and where the tools
it can use are not limited to the ones shipped in this repository.

Two rules for this file. A version is planned, not promised: order and dates move
when the measurement disagrees with the plan. And nothing is listed as shipped
unless it is in a release: the "Now" section describes 0.2.0 exactly, and
everything below it is work that does not exist in the application yet.

## Now - 0.2.0

An editor with a working assistant, on your own endpoint.

* Monaco editor with tabs, find in file, unsaved-change markers, line endings
  preserved.
* File tree that follows the disk, a right-click menu, quick open, find in files
  with streaming results and cancellation.
* Git panel: staged and unstaged separated, diffs, stage, unstage, discard,
  commit, branch switching.
* A real PowerShell session in the bottom panel.
* Assistant: streaming answers, folded reasoning, one line of tools per turn,
  approvals, cancel, five modes (Agent, Ask, Plan, Debug, Review).
* Chats saved as documents and opened in tabs; context gauge and automatic
  compaction; the context window and the answer budget are configurable.
* Dark and light themes, Russian and English, an OpenAI-compatible endpoint and
  no other network access.

## 0.3.0 - the agent becomes a participant

The assistant today works on the conversation, one turn at a time. This release is
about it working on the *project*.

* **Inline edits** in the editor: select code, ask for a change, review it in a
  diff before it lands. The core already answers one-shot requests; the editor
  needs the surface.
* **Multi-file work with a review step**: a change that spans several files is
  presented as one diff, applied or rejected as a whole.
* **A real diff view** in the window, so a write is reviewed where it happens
  rather than trusted.
* **Checkpoints in the conversation**: rewind to the state before a step, and
  re-run from there. Undo stops being "close the file without saving".
* **A tool that reads the project's own index**: symbols and references, not only
  files and text, so a rename does not become a search for a string.

## 0.4.0 - MCP: the tools stop being ours

Model Context Protocol is the direction the ecosystem has settled on, and it is
the point at which this stops being an IDE with a fixed tool set.

* **An MCP client in the core**: servers declared in settings, their tools
  registered beside the built-in ones, and each one shown in the approval prompt
  the way a local tool is.
* **Transport**: stdio first, then streamable HTTP, because a local server is
  what a user starts with.
* **Per-server trust**: an MCP server is third-party code with access to the
  workspace; approvals, timeouts and output limits are per server, not global.
* **A server list in the settings** with its tool inventory, what it last
  answered, and how to turn one off.

Nothing of this exists yet. The protocol and the settings shape will be written
down in `docs/protocol.md` before the code, as the core protocol was.

## 0.5.0 - Skills: procedure, not just tools

Tools do one thing; a skill is a procedure for doing a thing well - how this
project writes migrations, tests, releases or pull requests.

* **Skills as files in the repository** (`.lexiqode/skills/*.md`) with a
  description the model sees and a body it reads when the task matches.
* **Progressive disclosure**: a skill states its trigger and its steps; the body
  is read only when the skill is chosen, because a prompt that carries every
  procedure is a prompt that fits nothing.
* **Project rules and skills in one place**, so "how we do things here" is
  versioned with the code and reviewable in a pull request.
* **MCP prompts as skills** where a server offers them.

## 0.6.0 - several agents, and the others the user already has

* **Subagents**: a task that can be split is handed to a worker with its own
  context, and only the result comes back to the main conversation.
* **Parallel reads**: the exploration phase of a task runs concurrently instead of
  one tool call at a time.
* **Other agents as tools**: a CLI agent installed on the machine (its own login,
  its own model) can be called like any other tool, with the result returned to
  the conversation.
* **The terminal as a first-class tool**: a long-running command the agent can
  start, read and stop, in the panel the user can watch.

## 1.0.0 - what 1.0 has to mean

1.0 is not a feature count; it is a promise about breaking things.

* **The settings and protocol contract freeze.** A configuration or an external
  client written against 1.0 keeps working through 1.x.
* **A published extension surface** for MCP servers, skills and tools, with the
  version of the contract they were written against stated in the handshake.
* **Session portability**: conversations and settings that survive a machine
  change, in a format documented well enough for another tool to read.
* **Remote work**: the core reachable over a network the user controls, with the
  token and the workspace boundary treated as security boundaries rather than
  conveniences.
* **A release process**: a signed and reproducible build, and the digest
  published beside it.

## Not planned

Saying no is part of a roadmap.

* **A hosted service.** Model access is the user's endpoint; there is no account,
  no telemetry, and no code path that talks to a server this project runs.
* **Shipping a model.** The application ships no weights and no licence for one.
* **A Linux or macOS build before 1.0.** The core is platform-neutral and the
  window is Electron, so the port is not the hard part - the terminal handling and
  the path rules are, and both are Windows-first today.
* **A plugin marketplace.** Extensions arrive as files in the repository (skills)
  or as MCP servers the user names. A marketplace is a supply-chain problem
  before it is a feature.

## How the order is chosen

An item moves up when a measurement shows it is what limits the work: the
assistant that did not answer was not a missing feature but a blocked process,
and finding that out took instrumenting a real window. Probes in `app/scripts/`
exist for that reason, and every release in this file is expected to leave them
greener than it found them.