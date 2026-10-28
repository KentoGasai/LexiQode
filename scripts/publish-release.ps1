<#
.SYNOPSIS
    Publish a GitHub release with the built archive and its digest.

.DESCRIPTION
    The release is created through GitHub's REST API using the credential that
    git already stores for the repository - the same one `git push` uses. That is
    the point of this script: the GitHub CLI is a convenience wrapper over exactly
    these calls and is not required to publish anything, so a machine that cannot
    install `gh` can still put out a release.

    What it does, in order:

    * reads the version from app/package.json unless -Version is given;
    * refuses to go on unless the tag is already in the repository, so a release
      cannot quietly create a tag on whatever the default branch happens to be;
    * takes the archive and its .sha256 from dist/ and checks the digest in the
      file against the archive itself, because a wrong digest published beside a
      correct archive is worse than no digest;
    * creates the release if it is missing, reuses it if it exists, and attaches
      only the files that are not there yet, so running it twice is harmless;
    * reports the release page and the attached sizes.

    The notes file is `docs/release-notes/v<version>.md`, which is the release's
    own section of CHANGELOG.md with a paragraph on how to start it on top.

.PARAMETER Version
    Version to publish, for example 0.2.4. Defaults to the version in
    app/package.json, which is the version the archive carries.

.PARAMETER Tag
    Tag to publish under. Defaults to v<Version>.

.PARAMETER Notes
    Path to the release notes. Defaults to docs/release-notes/v<Version>.md.

.PARAMETER Repo
    GitHub repository as owner/name. Defaults to the origin remote.

.PARAMETER Replace
    Attach the files again even if an asset of that name exists, replacing it.

.PARAMETER DryRun
    Print what would be published and change nothing.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/publish-release.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/publish-release.ps1 -Version 0.2.4 -DryRun
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$Tag,
    [string]$Notes,
    [string]$Repo,
    [switch]$Replace,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Get-RepoSlug {
    # `-C` rather than the caller's directory: the script has to behave the same
    # when it is started from anywhere, and a background job starts in the user's
    # home, where `git remote` answers "not a git repository".
    $url = (git -C $root remote get-url origin 2>$null)
    if (-not $url) {
        throw "there is no origin remote in $root; pass -Repo owner/name"
    }
    $url = $url.Trim()
    # https://github.com/owner/name(.git), and ssh:// or git@github.com:owner/name(.git)
    $match = [regex]::Match($url, 'github\.com[/:](?<owner>[^/]+)/(?<name>[^/]+?)(\.git)?$')
    if (-not $match.Success) {
        throw "the origin remote ($url) does not name a GitHub repository; pass -Repo owner/name"
    }
    return "$($match.Groups['owner'].Value)/$($match.Groups['name'].Value)"
}

function Get-Token {
    # A token in the environment wins: that is how a machine without an
    # interactive credential store publishes, and how a workflow would.
    foreach ($name in 'GITHUB_TOKEN', 'GH_TOKEN') {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) { return $value }
    }
    # Otherwise the credential git itself uses. `git credential fill` reads the
    # same store that made `git push` work, so no second login exists to forget.
    # Terminal prompts are off: without a stored credential this has to fail
    # rather than wait for a password nobody is there to type.
    $previous = $env:GIT_TERMINAL_PROMPT
    $env:GIT_TERMINAL_PROMPT = '0'
    try {
        $lines = "protocol=https`nhost=github.com`n`n" | git credential fill
    }
    finally {
        $env:GIT_TERMINAL_PROMPT = $previous
    }
    $password = ($lines | Where-Object { $_ -like 'password=*' } | Select-Object -First 1)
    if (-not $password) {
        throw 'no credential for github.com is stored for git; run git push once, or set GITHUB_TOKEN'
    }
    return $password.Substring('password='.Length)
}

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Uri,
        [hashtable]$Headers,
        [object]$Body
    )
    $arguments = @{ Method = $Method; Uri = $Uri; Headers = $Headers }
    if ($null -ne $Body) {
        # UTF-8 bytes rather than a string: the release notes are Russian, and a
        # string body is encoded as Latin-1 by Windows PowerShell, which turns
        # every Cyrillic letter into a question mark on the published page.
        $json = $Body | ConvertTo-Json -Depth 4
        $arguments['Body'] = [Text.Encoding]::UTF8.GetBytes($json)
        $arguments['ContentType'] = 'application/json; charset=utf-8'
    }
    return Invoke-RestMethod @arguments
}

Write-Step 'Reading what to publish'
if (-not $Version) {
    $Version = (Get-Content (Join-Path $root 'app\package.json') -Raw | ConvertFrom-Json).version
}
if (-not $Tag) { $Tag = "v$Version" }
if (-not $Repo) { $Repo = Get-RepoSlug }
if (-not $Notes) { $Notes = Join-Path $root "docs\release-notes\$Tag.md" }
if (-not (Test-Path $Notes)) { throw "the release notes are missing at $Notes" }

$zip = Join-Path $dist "LexiQode-$Version-win32-x64.zip"
$sum = "$zip.sha256"
foreach ($file in $zip, $sum) {
    if (-not (Test-Path $file)) {
        throw "$file is missing; run scripts/build-app.ps1 first"
    }
}

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
$declared = ((Get-Content $sum -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
if ($hash -ne $declared) {
    throw "the digest in $(Split-Path -Leaf $sum) does not match the archive: $declared against $hash"
}
$size = (Get-Item $zip).Length
Write-Host "version:  $Version"
Write-Host "tag:      $Tag"
Write-Host "repo:     $Repo"
Write-Host "notes:    $Notes"
Write-Host "archive:  $zip ($size bytes)"
Write-Host "sha256:   $hash (matches the digest file)"

Write-Step "Checking that the tag is in $Repo"
$remote = git -C $root ls-remote --tags origin "refs/tags/$Tag"
if (-not $remote) {
    throw "the tag $Tag is not in the repository; create it and push it first: git tag -a $Tag -m 'LexiQode $Version'; git push origin $Tag"
}
Write-Host "the tag is there: $($remote -split '\s+' | Select-Object -First 1)"

if ($DryRun) {
    Write-Host ''
    Write-Host 'dry run: nothing was created or uploaded' -ForegroundColor Yellow
    return
}

$headers = @{
    Authorization = "token $(Get-Token)"
    'User-Agent' = 'LexiQode-publish'
    Accept = 'application/vnd.github+json'
}

Write-Step 'Finding the release'
$release = $null
try {
    $release = Invoke-Api -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
    Write-Host "the release already exists: $($release.html_url)"
}
catch {
    $status = $null
    if ($_.Exception.Response) { $status = $_.Exception.Response.StatusCode.value__ }
    if ($status -ne 404) { throw }
}

if (-not $release) {
    $release = Invoke-Api -Method Post -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body @{
        tag_name   = $Tag
        name       = "LexiQode $Version"
        body       = [IO.File]::ReadAllText($Notes)
        draft      = $false
        prerelease = $false
    }
    Write-Host "created the release: $($release.html_url)"
}

Write-Step 'Attaching the archive and its digest'
$upload = ($release.upload_url -replace '\{.*$', '')
foreach ($file in $zip, $sum) {
    $name = Split-Path -Leaf $file
    $existing = $release.assets | Where-Object { $_.name -eq $name }
    if ($existing -and -not $Replace) {
        $expected = (Get-Item $file).Length
        if ($existing.size -eq $expected) {
            Write-Host "$name is already attached ($expected bytes); leaving it alone"
            continue
        }
        Write-Host "$name is attached but is $($existing.size) bytes instead of $expected; replacing it"
        Invoke-Api -Method Delete -Uri $existing.url -Headers $headers | Out-Null
    }
    elseif ($existing) {
        Write-Host "replacing $name"
        Invoke-Api -Method Delete -Uri $existing.url -Headers $headers | Out-Null
    }
    $asset = Invoke-RestMethod -Method Post -Uri "$upload`?name=$name" -Headers $headers `
        -ContentType 'application/octet-stream' -InFile $file
    Write-Host "attached $($asset.name) ($($asset.size) bytes)"
    # GitHub reports the digest of the bytes it stored, so the archive does not
    # have to be downloaded again to know that what is on the page is what was
    # built. Checked rather than assumed: the field is absent on older API
    # versions, and a wrong archive on a release page is the whole risk.
    $property = $asset.PSObject.Properties['digest']
    if ($property -and $property.Value) {
        if ($file -eq $zip -and $property.Value -ne "sha256:$hash") {
            throw "GitHub stored $($property.Value) instead of sha256:$hash for $name"
        }
        Write-Host "  GitHub reports $($property.Value)"
    }
}

Write-Step 'What the release looks like now'
$final = Invoke-Api -Method Get -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers
Write-Host "tag:       $($final.tag_name)"
Write-Host "published: $($final.published_at) draft: $($final.draft)"
Write-Host "title:     $($final.name)"
foreach ($asset in $final.assets) {
    $digest = $asset.PSObject.Properties['digest']
    $shown = ''
    if ($digest -and $digest.Value) { $shown = " $($digest.Value)" }
    Write-Host "asset:     $($asset.name) $($asset.size) bytes$shown"
}
$downloads = ($final.assets | ForEach-Object { $_.browser_download_url }) -join "`n           "
Write-Host ''
Write-Host "page:      $($final.html_url)" -ForegroundColor Green
Write-Host "download:  $downloads" -ForegroundColor Green