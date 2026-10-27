<#
.SYNOPSIS
    Start LexiQode, from the sources or from a built bundle.

.DESCRIPTION
    The sources are the default, and that is the whole point: a working copy is
    edited and then looked at, and a script that quietly starts a bundle built an
    hour ago makes every change look as though it did nothing. Starting a build is
    a separate decision, so it has a switch of its own.

    * no arguments - the sources, through Electron in app/;
    * -Bundle      - the newest built bundle in dist/;
    * -Deploy      - copies the newest bundle into
                     %LOCALAPPDATA%\Programs\LexiQode (per-user, no administrator
                     rights) and starts that copy, because verifying the install
                     is what deploying is for.

.PARAMETER Folder
    A folder to open. Passed to the app, which opens it instead of the last one.

.PARAMETER Bundle
    Start the newest bundle in dist/ instead of the sources.

.PARAMETER Source
    Kept so that habits and scripts that already pass it keep working: the
    sources are the default, so this changes nothing.

.PARAMETER Deploy
    Copy the newest bundle into the per-user programs directory, then start it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-app.ps1 -Folder F:\work\project

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-app.ps1 -Bundle
#>
[CmdletBinding()]
param(
    [string]$Folder,
    [switch]$Bundle,
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

$arguments = @()
if ($Folder) { $arguments += (Resolve-Path $Folder).Path }

function Start-App([string]$FilePath, [string]$WorkingDirectory, [string[]]$Leading) {
    # `-ArgumentList` is left out when there is nothing to pass, and that is not a
    # detail: `Start-Process -ArgumentList @()` fails parameter binding with
    # "the argument is null or empty", so starting the app with no folder - the
    # plain, expected way to start it - threw before a window could appear. That
    # is the failure this script was reported with.
    #
    # `$Leading` is what a caller has to pass before the folder: for the sources
    # that is the application path, which Electron reads as the first non-switch
    # argument.
    $list = @()
    if ($Leading) { $list += $Leading }
    if ($arguments.Count -gt 0) { $list += $arguments }
    $start = @{ FilePath = $FilePath }
    if ($WorkingDirectory) { $start['WorkingDirectory'] = $WorkingDirectory }
    if ($list.Count -gt 0) { $start['ArgumentList'] = $list }
    Start-Process @start
}

function Start-FromSource {
    # The application path has to come first: Electron reads the first
    # non-switch argument as the application to run, so a folder passed before it
    # becomes the app and Electron answers with an error dialog.
    $electron = Join-Path $app 'node_modules\electron\dist\electron.exe'
    if (-not (Test-Path $electron)) {
        throw 'the Electron binary is missing; run: cd app; npm install; node node_modules/electron/install.js'
    }
    # Started, not called.
    #
    # This was `& $electron .`, and a call operator waits for the process to exit:
    # the window opened and the terminal stayed busy until it was closed, so the
    # command looked hung and the next one could not be run. A starter script has
    # to come back.
    # The application path has to come first, and the folder to open after it.
    Start-App $electron $app @('.')
}

if ($Deploy) {
    $bundleExe = Find-Bundle
    if (-not $bundleExe) {
        throw 'there is no bundle in dist/ to deploy; run scripts/build-app.ps1 first'
    }
    Write-Host "Deploying to $install"
    if (Test-Path $install) {
        # The app is running while this happens sometimes; a locked file fails
        # loudly rather than leaving a half-replaced install.
        Remove-Item $install -Recurse -Force
    }
    New-Item -ItemType Directory -Path $install -Force | Out-Null
    Copy-Item (Join-Path (Split-Path -Parent $bundleExe) '*') $install -Recurse -Force
    # The deployed copy is what is started: a deploy that leaves the freshly
    # written folder untouched proves nothing about it.
    $installedExe = Join-Path $install 'LexiQode.exe'
    Write-Host "Starting the deployed copy $installedExe"
    Start-App $installedExe ''
    return
}

if ($Bundle) {
    $bundleExe = Find-Bundle
    if (-not $bundleExe) {
        throw 'there is no bundle in dist/; run scripts/build-app.ps1 first, or start the sources with no arguments'
    }
    Write-Host "Starting the bundle $bundleExe"
    Start-App $bundleExe ''
    return
}

Write-Host 'Starting from the sources'
Start-FromSource