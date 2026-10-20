<#
.SYNOPSIS
    Build the LexiQode extension and install it into VSCodium (or VS Code).

.DESCRIPTION
    VSCodium keeps user extensions in a profile folder it creates on first run.
    Copying the built extension there is the shortest development loop: no
    packaging step, no marketplace, and the next editor start picks it up.

    Re-running the script replaces the installed copy, so edit -> install ->
    reload is the whole cycle.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-extension.ps1
    powershell -ExecutionPolicy Bypass -File scripts/install-extension.ps1 -Editor code
#>

param(
    [ValidateSet('codium', 'code')]
    [string]$Editor = 'codium',
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo 'extension'

if (-not (Test-Path (Join-Path $extension 'package.json'))) {
    throw "extension/package.json not found under $repo"
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

$manifest = Get-Content (Join-Path $extension 'package.json') -Raw | ConvertFrom-Json
$folder = '{0}-{1}' -f $manifest.name, $manifest.version

$profileRoot = switch ($Editor) {
    # VSCodium's dataFolderName is ".vscode-oss", VS Code's is ".vscode".
    'codium' { Join-Path $env:USERPROFILE '.vscode-oss' }
    'code' { Join-Path $env:USERPROFILE '.vscode' }
}
$extensionsDir = Join-Path $profileRoot 'extensions'
$target = Join-Path $extensionsDir $folder

if (Test-Path $target) {
    Write-Host "removing the previous install at $target"
    Remove-Item $target -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

foreach ($item in 'package.json', 'out', 'media') {
    $source = Join-Path $extension $item
    if (-not (Test-Path $source)) { throw "$source is missing; build the extension first" }
    Copy-Item $source $target -Recurse
}
foreach ($optional in 'README.md', 'LICENSE') {
    $source = Join-Path $extension $optional
    if (Test-Path $source) { Copy-Item $source $target }
}

$installed = Get-ChildItem $target -Recurse -File | Measure-Object
Write-Host ''
Write-Host ("installed {0} ({1} files) for {2}" -f $folder, $installed.Count, $Editor)
Write-Host "  location: $target"
Write-Host ''
Write-Host 'Next: start the editor, open a folder, and use the LexiQode icon in the activity bar.'
Write-Host 'Then set your endpoint and key:  LexiQode: Set the Model API Key'