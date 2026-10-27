# Publishing this repository

What has to be true before the repository is public, what was actually checked,
and what to do in the GitHub interface. Written so that the whole thing can be
re-done later - on a bigger release, or after a new file has been added that
nobody thought about.

## 1. Before it is public: the credential audit

A public repository publishes **every commit**, not the current file list. A key
that was added in one commit and removed in the next is still readable in the
history, and GitHub's search will find it. So the audit is over the history.

### What was checked, and the result (2026-10-26)

| Check | Method | Result |
|---|---|---|
| Secrets in every commit | scanned all added lines of all 83 commits on all branches for OpenAI keys, GitHub tokens, AWS ids, Slack tokens, private-key blocks, JWTs, assigned `api_key`/`secret`/`password` values, credentials inside URLs, Yandex markers, and the corporate host names seen in the machine's git configuration | **nothing real**; three matches, all false positives (see below) |
| Files that should never be committed | every path ever committed, filtered for `.env`, `secret`, `credential`, `token`, `*.key`, `*.pem`, `settings.json`, `*.bak`, `runtime.json` | only `.vscode/settings.json` and `extension/.vscode/settings.json` (editor settings, local TypeScript path) |
| Working tree | tracked files scanned with the same patterns; untracked files listed | clean, nothing untracked |
| Binary or large objects | tracked files by extension; objects over 200 KB in history | none; the repository is 1.30 MiB |
| Where the settings actually live | read `.gitignore` | settings, logs, databases and the runtime descriptor are ignored by name and by rule |
| Release archive | entries listed and the text files inside searched | no settings file, no key, no log (see §4) |
| Remotes | `git remote -v`, `git config --list` | plain HTTPS URLs, no token embedded |

The three matches, so that the next person does not have to work it out again:

1. `app/src/renderer/css/app.css` - a comment explaining that a model id can look
   like `gpt://folder/name/version`.
2. `core/tests/test_config.py` - two test fixtures whose key is the literal
   string `secret-value` / `topsecret123`.
3. The same fixtures again in the current tree.

### Re-running the audit

The script is not committed as a tool, because it is twenty lines and a script
that is trusted is worse than a command that is read. To repeat it:

```powershell
cd F:\Gitea\LexiQode2

# Every path ever committed, filtered for credential-shaped names
git log --all --name-only --pretty=format: | Sort-Object -Unique |
  Select-String -Pattern '\.env|secret|credential|password|token|\.key$|\.pem$|settings\.json|\.bak'

# Every added line in history, filtered for credential-shaped values
git log --all -p --no-merges | Select-String -Pattern 'sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|BEGIN [A-Z ]*PRIVATE KEY|://[^/@\s]+:[^/@\s]+@'

# Anything large that should not be in a public repository
git count-objects -vH
```

Three rules that keep it clean from here:

* Settings, keys and conversations belong in `%APPDATA%` / `%LOCALAPPDATA%` and
  are already in `.gitignore`. Nothing about a model endpoint belongs in the
  tree, not even in a test - the tests use literal placeholders.
* An exception that was already published once must be treated as compromised:
  rotate the key, do not delete the file.
* Check before pushing, not before releasing. The release is the announcement;
  the push is the publication.

### One honest note about the history

The history contains about thirty `cline checkpoint` / `untracked files on cline
checkpoint` commits - bookkeeping commits written by the development tool. They
contain only this project's own files (the scan above covered them), but they make
`git log` noisy for a reader who came from the release page.

If a clean history is wanted, it is a squash, and it is done **before** the first
public tag, never after:

```powershell
# History-free start: one commit containing the released tree
git checkout --orphan release
git add -A
git commit -m "LexiQode 0.2.0"
git branch -M release main
git push --force origin main
```

That throws away the record of how the project was built. The alternative - an
interactive rebase dropping the checkpoint commits - keeps the narrative and
rewrites every SHA after the first dropped commit, which also needs a force push.
Neither is required: nothing above found a secret.

## 2. Making the repository public

GitHub interface: **Settings ▸ General ▸ Danger Zone ▸ Change repository
visibility ▸ Change to public**. GitHub warns about forks, stars, watchers and
Actions secrets; there are none here.

With the GitHub CLI (not installed on this machine - `winget install GitHub.cli`,
then `gh auth login`):

```powershell
gh repo edit KentoGasai/LexiQode --visibility public --accept-visibility-change-consequences
```

GitHub reports that this repository has moved to `KentoGasai/LexiQode`. Either
name works; if the shorter one is the future, change the remote and the clone
lines in both READMEs together, or one of them will send a newcomer to a redirect.

## 3. Being found: what actually decides it

Being *findable* and being *noticed* are different things, and only the first is
something a repository can set up for itself.

**Findable** is metadata, and it is worth ten minutes:

* **Topics** - the strongest signal in GitHub's own search and in the topic pages
  people browse. Suggested set for this project:

  ```
  ai, ai-ide, code-editor, developer-tools, llm, local-llm, openai, openai-api,
  agent, autonomous-agents, mcp, model-context-protocol, electron, windows,
  monaco-editor, self-hosted, local-first, privacy, ollama, python
  ```

  `gh repo edit KentoGasai/LexiQode --add-topic ai --add-topic ai-ide ...`
* **Description** - one sentence, the words a person would search for:
  *"A Windows AI IDE with a built-in agent that runs on your own OpenAI-compatible endpoint - local-first, no account, no telemetry."*
* **Social preview** - the image GitHub shows when the link is pasted anywhere.
  Upload `docs/social-preview.png` (1280×640, captured from the running
  application) under **Settings ▸ General ▸ Social preview**.
* **README first screen** - a search engine indexes the text, a person reads the
  first paragraph and looks at the first image. Both were rewritten for that.
* **A release, not just commits** - the release page is what a link from anywhere
  else lands on, and it is the only thing that says "this is a thing you can
  download".

**Noticed** is people, and no tag makes it happen. GitHub Trending is a burst of
stars in a short window, so it is a consequence of being shared somewhere with an
audience, not a mechanism that can be switched on. What does work, in the order
that costs least:

1. A place to talk: enable **Discussions**, so the first interested person has
   somewhere to ask a question that is not an issue.
2. Cheap credibility: `CONTRIBUTING.md`, issue templates, and a working
   `LICENSE` - a stranger deciding whether to spend an evening on a project looks
   for exactly these.
3. Somewhere with an audience that cares about this specific thing. The honest
   list for this project: `r/LocalLLaMA` and `r/ChatGPTCoding`, Hacker News (Show
   HN, once, with a plain description), `awesome-selfhosted` and the `awesome-*`
   lists for local LLM tooling, Habr or a Telegram channel for the Russian
   audience, and dev.to for a written walkthrough. Each of these wants a *story*,
   not a link: for this project the story is the git call that blocked every turn
   because of an inherited stdin pipe, and the probe that found it.
4. Post once per release, not once per commit. A repository that appears in the
   same five places every week is a repository people mute.

## 4. The release

```powershell
cd F:\Gitea\LexiQode2
powershell -ExecutionPolicy Bypass -File scripts\build-app.ps1
```

The version comes from `app/package.json`; the script runs both test suites,
stages `dist\LexiQode-<version>-win32-x64`, and writes the archive plus its
`.sha256` beside it. Then:

```powershell
gh release create v0.2.0 `
  dist\LexiQode-0.2.0-win32-x64.zip `
  dist\LexiQode-0.2.0-win32-x64.zip.sha256 `
  --title "LexiQode 0.2.0" --notes-file docs\release-notes\v0.2.0.md
```

The notes file is the 0.2.0 section of `CHANGELOG.md` with a download paragraph on
top, so the release page opens with what this version is and how to run it. The
full changelog stays in the repository for anyone reading the history.

Or, in the interface: **Releases ▸ Draft a new release ▸ choose the tag ▸ attach
both files**. GitHub's own limits are 2 GB per asset and 100 characters per tag;
the archive is about 157 MB, which is fine, and exactly why the application is
never committed to the tree.

Before attaching, check the archive itself - it is built from this tree, and a
stray settings file inside it would publish a key without ever appearing in the
history:

```powershell
tar -tf dist\LexiQode-0.2.0-win32-x64.zip | Select-String -Pattern 'settings\.json|\.env|\.key$|\.pem$|logs/'
```

An empty result is the expected result.

## 5. Checklist

- [ ] Repository visibility changed to public.
- [ ] Description set to the one-sentence version above.
- [ ] Topics added (the list above).
- [ ] Social preview uploaded (`docs/social-preview.png`).
- [ ] Discussions enabled; issue templates added.
- [ ] `v0.2.0` tag pushed.
- [ ] Release published with the archive and the `.sha256` attached.
- [ ] The clone URL in both READMEs points at the name that will be kept.
- [ ] Search the published page for a key once more, from outside the account, in
      a private window: `https://github.com/<owner>/<repo>/search?q=sk-`