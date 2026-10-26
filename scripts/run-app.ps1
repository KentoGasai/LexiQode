<#
.SYNOPSIS
    Start LexiQode, from the sources or from a built bundle.

.DESCRIPTION
    Three modes, chosen so that the common case needs no arguments:

    * a bundle in dist/ is used when one exists;
    * otherwise the sources are started through Electron;
    * -Deploy installs the bundle into %LOCALAPPDATA%\Programs\LexiQode, which is
      per-user and needs no administrator rights.

.PARAMETER Folder
    A folder to open. Passed to the app, which opens it instead of the last one.

.PARAMETER Source
    Start from the sources even when a bundle exists.

.PARAMETER Deploy
    Copy the newest bundle into the per-user programs directory before starting.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-app.ps1 -Folder F:\work\project
#>
[CmdletBinding()]
param(
    [string]$Folder,
    [switch]$Source,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'app'
$dist = Join-Path $repo 'dist'
$install = Join-Path $env:LOCALAPPDATA 'Programs\LexiQode'

function Find-Bundle {
    if (-not (Test-Path $dist)) { return $null }
    $folders = Get-ChildItem $dist -Directory -Filter 'LexiQode-*-win32-x64' -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending
    foreach ($folder in $folders) {
        $exe = Join-Path $folder.FullName 'LexiQode.exe'
        if (Test-Path $exe) { return $exe }
    }
    return $null
}

if ($Deploy) {
    $bundle = Find-Bundle
    if (-not $bundle) { throw 'there is no bundle in dist/ to deploy; run scripts/build-app.ps1 first' }
    Write-Host "Deploying to $install"
    if (Test-Path $install) {
        # The app is running while this happens sometimes; a locked file fails
        # loudly rather than leaving a half-replaced install.
        Remove-Item $install -Recurse -Force
    }
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    Copy-Item (Join-Path (Split-Path -Parent $bundle) '*') $install -Recurse -Force
}

$arguments = @()
if ($Folder) { $arguments += (Resolve-Path $Folder).Path }

function Start-FromSource {
    # The application path has to come first: Electron reads the first
    # non-switch argument as the application to run, so a folder passed before it
    # becomes the app and Electron answers with an error dialog.
    $electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electron)) {
        throw 'the Electron binary is missing; run: cd app; npm install; node node_modules/electron/install.js'
    }
    $splat = @(@('.') + $arguments)
    Push-Location $app
    try {
        & $electron @splat
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

if ($Source) {
    Write-Host 'Starting from the sources'
    exit (Start-FromSource)
}

# A bundle in dist/ wins over whatever is installed. The installed copy is the
# older of the two by construction - it is only ever written by -Deploy - and
# preferring it would start a build that no longer matches the sources, which is
# exactly the confusion this script exists to prevent.
$bundleExe = Find-Bundle
$installedExe = Join-Path $install 'LexiQode.exe'
$executable = if ($bundleExe) { $bundleExe } elseif (Test-Path $installedExe) { $installedExe } else { $null }

if (-not $Deploy -and -not $Source -and -not $bundleExe -and (Test-Path $installedExe)) {
    Write-Host "using the installed copy (no bundle in dist/): $installedExe"
}

if ($executable) {
    Write-Host "Starting $executable"
    Start-Process -FilePath $executable -ArgumentList $arguments
    return
}

Write-Host 'No bundle found, starting from the sources'
Start-FromSource | Out-Null