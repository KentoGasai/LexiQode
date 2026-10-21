<#
.SYNOPSIS
    Put LexiQode in the Start menu and on the desktop.

.DESCRIPTION
    A local installation carries no shortcut of its own, so launching it otherwise
    means remembering a path. This creates the two shortcuts a normal application
    would have.

    The shortcuts open the product with no folder; use `scripts/run-lexiqode.ps1
    -Workspace <folder>` when a specific project should be opened, or pass
    -Workspace here to bake that folder into the shortcut.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/create-shortcuts.ps1
    powershell -ExecutionPolicy Bypass -File scripts/create-shortcuts.ps1 -Desktop:$false
#>

param(
    [string]$Install = (Join-Path $env:LOCALAPPDATA 'Programs\LexiQode'),
    [bool]$StartMenu = $true,
    [bool]$Desktop = $true,
    [string]$Workspace = ''
)

$ErrorActionPreference = 'Stop'

$exe = Join-Path $Install 'LexiQode.exe'
if (-not (Test-Path $exe)) {
    throw "no LexiQode build at $Install; see scripts/run-lexiqode.ps1 for how to get one"
}

$shell = New-Object -ComObject WScript.Shell
$workdir = if ($Workspace) { $Workspace } else { $Install }

$targets = @()
if ($StartMenu) {
    $targets += Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\LexiQode.lnk'
}
if ($Desktop) {
    $targets += Join-Path ([Environment]::GetFolderPath('Desktop')) 'LexiQode.lnk'
}

foreach ($path in $targets) {
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = $exe
    $shortcut.WorkingDirectory = $workdir
    # The icon is compiled into the executable, so pointing at it is enough.
    $shortcut.IconLocation = "$exe,0"
    $shortcut.Description = 'LexiQode: an AI coding agent, on your own models'
    if ($Workspace) { $shortcut.Arguments = "`"$Workspace`"" }
    $shortcut.Save()
    Write-Host "created $path"
}

Write-Host ''
$where = if ($Desktop) { 'the Start menu and the desktop' } else { 'the Start menu' }
Write-Host "LexiQode is now in $where."