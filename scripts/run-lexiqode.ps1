<#
.SYNOPSIS
    Start the installed LexiQode build.

.DESCRIPTION
    Launches the product this repository builds, not a development host and not a
    foreign editor. The build is a local installation, so nothing needs to be
    installed or elevated to run it.

    The agent chat sits in the right-hand side bar and opens itself the first time
    a project is opened.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/run-lexiqode.ps1
    powershell -ExecutionPolicy Bypass -File scripts/run-lexiqode.ps1 -Workspace C:\src\my-project
#>

param(
    [string]$Install = (Join-Path $env:LOCALAPPDATA 'Programs\LexiQode'),
    # Defaults to this repository, which is the tree the agent was built against.
    [string]$Workspace = (Split-Path -Parent $PSScriptRoot),
    [switch]$Wait
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $Install 'LexiQode.exe'
if (-not (Test-Path $exe)) {
    Write-Host "no LexiQode build at $Install" -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Get one either way:'
    Write-Host '  download the CI artifact:  scripts\use-artifact.ps1 -Zip <path to LexiQode-win32-x64.zip>'
    Write-Host '  or build it locally:       scripts\build-ide.ps1      (needs the C++ toolchain)'
    throw 'the build is missing'
}

$arguments = @()
if ($Workspace -and (Test-Path $Workspace)) {
    $arguments += $Workspace
} elseif ($Workspace) {
    Write-Host "the folder does not exist, starting without one: $Workspace" -ForegroundColor Yellow
}

if ($Wait) {
    & $exe @arguments
    return
}

# Detached on purpose: this is a launcher, so the terminal stays usable.
Start-Process -FilePath $exe -ArgumentList $arguments | Out-Null
Write-Host "LexiQode started$(if ($arguments) { " on $Workspace" })"
Write-Host 'The agent is in the right-hand side bar; Ctrl+Alt+L brings it back.'