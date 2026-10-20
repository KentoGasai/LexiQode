<#
.SYNOPSIS
    Start the editor with LexiQode ready to use.

.DESCRIPTION
    Compiles the extension, installs it into VSCodium's profile and then starts
    VSCodium on a folder. Run it once and the editor is usable; run it again after
    changing the code and the installed copy is refreshed first.

    The first thing to do inside the editor is run "LexiQode: Set Up the Model
    Endpoint" from the command palette - three questions, and the agent works.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-lexiqode.ps1
    powershell -ExecutionPolicy Bypass -File scripts/run-lexiqode.ps1 -Workspace C:\src\my-project
    powershell -ExecutionPolicy Bypass -File scripts/run-lexiqode.ps1 -Rebuild
#>

param(
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [switch]$Rebuild
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $env:LOCALAPPDATA 'Programs\VSCodium\VSCodium.exe'

if (-not (Test-Path $exe)) {
    throw "VSCodium is not installed at $exe. Run scripts/install-vscodium.ps1 first."
}
if (-not (Test-Path $Workspace)) {
    throw "The folder does not exist: $Workspace"
}

$installed = Join-Path $env:USERPROFILE '.vscode-oss\extensions\lexiqode-1.0.0\out\extension.js'
if ($Rebuild -or -not (Test-Path $installed)) {
    Write-Host 'building and installing the extension...'
    & powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'install-extension.ps1')
    if ($LASTEXITCODE -ne 0) { throw "installing the extension failed with exit code $LASTEXITCODE" }
} else {
    Write-Host 'the extension is already installed; pass -Rebuild to refresh it'
}

Write-Host ''
Write-Host "starting VSCodium on $Workspace"
Write-Host 'inside: open the LexiQode icon, then run "LexiQode: Set Up the Model Endpoint"'
Write-Host ''

# Detached on purpose: this script is a launcher, not a wrapper, so the terminal
# stays usable while the editor runs.
Start-Process -FilePath $exe -ArgumentList $Workspace | Out-Null

Write-Host 'VSCodium started.'