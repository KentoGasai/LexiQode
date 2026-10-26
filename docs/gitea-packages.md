# Publishing LexiQode to a Gitea package registry

Gitea ships a package registry with several formats. For a desktop application
the useful one is **generic**: it stores a file under a version, next to the
repository it came from, and needs nothing on the machine that downloads it. The
npm format would mean publishing an application as a JavaScript dependency, which
nobody wants to `npm install` to get an editor.

Everything below is two HTTP calls, so it works with nothing installed beyond
PowerShell. `scripts/publish-gitea.ps1` is the wrapper.

## Once per instance

1. Create a token: **Settings → Applications → Generate New Token**, scope
   `write:package` (add `read:package` if you also want to list versions).
2. Decide the owner: a user or an organisation. A package belongs to the owner,
   not to a repository.

## Publish

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1

$env:GITEA_TOKEN = '...'
powershell -ExecutionPolicy Bypass -File scripts/publish-gitea.ps1 `
    -Server https://git.example.com `
    -Owner your-name
```

The script takes the version from `app/package.json` and the newest zip from
`dist/`, prints the size and the SHA-256, uploads, and prints the download URL. It
also accepts `-Version`, `-File`, `-Package`, `-Check` (does the server answer,
and is the token accepted) and `-List` (which versions exist). The token is read
from `-Token` or `GITEA_TOKEN` and is never printed, logged or written anywhere.

## Consume

```powershell
curl -L -o lexiqode.zip "https://git.example.com/api/packages/your-name/generic/lexiqode/0.1.0/LexiQode-0.1.0-win32-x64.zip"
Expand-Archive lexiqode.zip -DestinationPath .
.\LexiQode-0.1.0-win32-x64\LexiQode.exe
```

The web interface also lists the package under **Packages**, with the same file
for download. Verify what you downloaded against the digest printed by the build:
the build writes `LexiQode-<version>-win32-x64.zip.sha256` beside the zip.

## Versions

The version in `app/package.json` is the version of the package. Bumping it is
the release step; uploading the same version twice is refused (HTTP 409) rather
than silently replacing a file somebody may already have downloaded.

## From CI

`.github/workflows/app.yml` publishes after the tests pass, on any branch, when
the repository is configured for it:

| Kind | Name | Value |
|---|---|---|
| variable | `GITEA_SERVER` | `https://git.example.com` |
| secret | `GITEA_OWNER` | the user or organisation |
| secret | `GITEA_TOKEN` | the token from above |

A repository without them still builds and uploads its artifact; the publishing
step is skipped, not failed.

## When something goes wrong

| Answer | Meaning |
|---|---|
| HTTP 401 or 403 | the token is missing, expired, or has no `write:package` scope |
| HTTP 409 | that version is already published; bump the version |
| HTTP 404 on the download | the owner, package or version in the URL is wrong; `-List` shows what exists |
| Connection refused | the server URL is wrong, or the instance is not reachable from here |