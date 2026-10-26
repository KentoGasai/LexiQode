<#
.SYNOPSIS
    Build the portable LexiQode distribution.

.DESCRIPTION
    Produces a folder that runs by double-clicking, plus a zip and its digest.
    No installer and no administrator rights are involved: the app is an Electron
    binary renamed to LexiQode.exe with the application and the Python core beside
    it, which is also what makes the download something a person can inspect.

    The layout matters, because the app finds the core by walking up from its own
    file:

        <dist>/LexiQode/LexiQode.exe
        <dist>/LexiQode/resources/app/...      our sources
        <dist>/LexiQode/resources/core/...     the Python core

    Python 3.11 or newer must be on PATH to run the agent; the editor half works
    without it.

.PARAMETER SkipTests
    Skip the test suites. Only useful when they have just been run.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-app.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'app'
$core = Join-Path $repo 'core'
$dist = Join-Path $repo 'dist'
$packageJson = Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
$version = $packageJson.version
$bundle = Join-Path $dist "LexiQode-$version-win32-x64"
$zip = "$bundle.zip"

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkingDirectory) {
    Write-Host "   $File $($Arguments -join ' ')"
    Push-Location $WorkingDirectory
    try {
        & $File @Arguments
        if ($LASTEXITCODE -ne 0) {
            throw "$File exited with code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}

Write-Step 'Checking the prerequisites'
$electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path (Join-Path $app 'node_modules'))) {
    Invoke-Checked 'npm' @('install', '--no-audit', '--no-fund') $app
}
if (-not (Test-Path $electron)) {
    # Electron downloads its binary in its own install script, which a failed
    # install can leave undone while still reporting success overall.
    Invoke-Checked 'node' @('node_modules/electron/install.js') $app
}
if (-not (Test-Path $electron)) {
    throw "the Electron binary is still missing at $electron"
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Warning 'python was not found on PATH: the agent half will not start in this build'
}

Write-Step 'Copying the browser bundles the window loads'
Invoke-Checked 'node' @('scripts/vendor.mjs') $app
foreach ($asset in 'monaco\vs\loader.js', 'xterm\xterm.js', 'xterm\xterm.css', 'xterm\addon-fit.js') {
    if (-not (Test-Path (Join-Path $app "vendor\$asset"))) {
        throw "vendoring did not produce $asset"
    }
}

if (-not $SkipTests) {
    Write-Step 'Running the app test suite'
    Invoke-Checked 'node' @('--test') $app
    Write-Step 'Running the core test suite'
    Invoke-Checked 'python' @('-m', 'pytest', '-q') $core
}

Write-Step "Staging $bundle"
if (Test-Path $bundle) { Remove-Item $bundle -Recurse -Force }
New-Item -ItemType Directory -Path $bundle -Force | Out-Null

# The Electron runtime, with its entry point named after the product so the task
# manager and the window title agree with what the user installed.
Copy-Item (Join-Path $app 'node_modules\electron\dist\*') $bundle -Recurse -Force
Rename-Item (Join-Path $bundle 'electron.exe') 'LexiQode.exe'
foreach ($stale in 'resources\default_app.asar', 'LICENSE', 'version') {
    $path = Join-Path $bundle $stale
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
}

$appRoot = Join-Path $bundle 'resources\app'
New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
foreach ($item in 'src', 'vendor') {
    Copy-Item (Join-Path $app $item) $appRoot -Recurse -Force
}
Copy-Item (Join-Path $app 'package.json') $appRoot -Force
Copy-Item $core (Join-Path $bundle 'resources\core') -Recurse -Force

# Python writes bytecode beside the sources unless told otherwise, and a
# read-only install location is exactly where that fails. The test runner's
# caches go too: they name the tests of the machine that built the archive, and
# a published download should carry the product and nothing about the workshop.
$coreRoot = Join-Path $bundle 'resources\core'
foreach ($cache in '__pycache__', '.pytest_cache', '.ruff_cache', '.mypy_cache', '.venv', 'venv') {
    Get-ChildItem $coreRoot -Recurse -Directory -Filter $cache -ErrorAction SilentlyContinue |
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

$readme = @"
LexiQode $version

Run LexiQode.exe. Nothing is installed and no administrator rights are needed.

The assistant half needs Python 3.11 or newer on PATH; the editor half runs
without it.

Settings live in %APPDATA%\LexiQode (app-settings.json for this window,
settings.json for the agent, which is also where the endpoint and the model id
are stored). Transcripts and other per-machine data live in %LOCALAPPDATA%\LexiQode.
"@
Set-Content -Path (Join-Path $bundle 'README.txt') -Value $readme -Encoding UTF8

Write-Step 'Packing the zip'
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $bundle -DestinationPath $zip -CompressionLevel Optimal

$hash = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path -Leaf $zip)" | Set-Content "$zip.sha256" -Encoding ASCII

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host ''
Write-Host "bundle: $bundle" -ForegroundColor Green
Write-Host "zip:    $zip ($size MB)" -ForegroundColor Green
Write-Host "sha256: $hash" -ForegroundColor Green