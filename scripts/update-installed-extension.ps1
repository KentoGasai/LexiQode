<#
.SYNOPSIS
    Copy the current extension into an installed LexiQode build.

.DESCRIPTION
    A full CI build takes about forty minutes, which is far too slow to look at a
    change in the chat surface. The built-in extension inside an installed build
    is an ordinary folder, so the compiled extension can be dropped into it
    directly and the editor will load it on the next start.

    This is a development loop, not a release step: the artifact stays a local
    installation and nothing is published.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/update-installed-extension.ps1
    powershell -ExecutionPolicy Bypass -File scripts/update-installed-extension.ps1 -NoLaunch
#>

param(
    [string]$Install = (Join-Path $env:LOCALAPPDATA 'Programs\LexiQode'),
    [switch]$SkipBuild,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo 'extension'

$exe = Join-Path $Install 'LexiQode.exe'
if (-not (Test-Path $exe)) {
    throw "no LexiQode build at $Install. Download the CI artifact first (scripts/use-artifact.ps1)."
}
$app = Join-Path $Install 'resources\app'
$productPath = Join-Path $app 'product.json'
$target = Join-Path $app 'extensions\lexiqode'
if (-not (Test-Path $target)) {
    throw "the build has no built-in extension at $target"
}

if (-not $SkipBuild) {
    Write-Host 'compiling the extension...'
    Push-Location $extension
    try {
        & npm run compile
        if ($LASTEXITCODE -ne 0) { throw "tsc failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# The editor reads its extensions on startup, so a running copy has to go first or
# the files cannot be replaced.
$running = @(Get-Process -Name 'LexiQode' -ErrorAction SilentlyContinue)
if ($running.Count) {
    Write-Host "closing the running build ($($running.Count) process(es))..."
    $running | Stop-Process -Force
    Start-Sleep -Seconds 2
}

# Replaced rather than merged: a stale file left behind by a rename would keep
# being loaded, and the directory is disposable.
foreach ($item in 'out', 'media') {
    $existing = Join-Path $target $item
    if (Test-Path $existing) { Remove-Item $existing -Recurse -Force }
}
foreach ($item in 'package.json', 'README.md', 'out', 'media') {
    $source = Join-Path $extension $item
    if (Test-Path $source) { Copy-Item $source $target -Recurse }
}

$copied = (Get-ChildItem $target -Recurse -File | Measure-Object).Count
$product = Get-Content $productPath -Raw | ConvertFrom-Json
Write-Host ''
Write-Host "updated the built-in extension of '$($product.nameLong)'"
Write-Host "  location: $target"
Write-Host "  files:    $copied"
Write-Host "  core:     $(if (Test-Path (Join-Path $Install 'resources\lexiqode-core\lexiqode')) { 'bundled' } else { 'MISSING' })"

if (-not $NoLaunch) {
    Start-Process -FilePath $exe -ArgumentList $repo | Out-Null
    Write-Host ''
    Write-Host "started on $repo"
    Write-Host 'The chat is in the right-hand side bar (Ctrl+Alt+L brings it back).'
}