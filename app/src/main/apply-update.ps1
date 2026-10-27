<#
    Put a downloaded LexiQode where the running one is.

    Written as a file rather than assembled on a command line so that anyone can
    read what an update does to their machine, and started detached by
    `update-service.js` just before the application exits - because a process
    cannot replace the files it is running from, which is the whole of the
    conflict between an update and a running app.

    The order below is what makes it safe. The archive is unpacked completely
    before anything moves; the current folder is renamed aside rather than
    deleted; and if the new tree cannot take its place, the previous version is
    renamed back. The application is never left half-replaced, and every step is
    appended to the log that was passed in.
#>
param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Exe,
    [Parameter(Mandatory = $true)][string]$Log
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Log([string]$Message) {
    $line = '[{0}] {1}' -f (Get-Date).ToString('s'), $Message
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

$stage = Join-Path ([System.IO.Path]::GetTempPath()) ('lexiqode-update-' + [guid]::NewGuid().ToString('n'))
$old = "$Target.old"

try {
    Write-Log "waiting for the application (pid $ProcessId) to exit"
    while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }
    Start-Sleep -Milliseconds 300

    Write-Log "unpacking $Archive"
    New-Item -ItemType Directory -Path $stage -Force | Out-Null
    Expand-Archive -LiteralPath $Archive -DestinationPath $stage -Force

    # The archive holds one folder, and its contents are the new application.
    $inner = Get-ChildItem -LiteralPath $stage -Directory | Select-Object -First 1
    $source = if ($inner) { $inner.FullName } else { $stage }

    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
    Write-Log "moving $Target aside to $old"
    Move-Item -LiteralPath $Target -Destination $old
    try {
        Write-Log "moving $source into $Target"
        Move-Item -LiteralPath $source -Destination $Target
    } catch {
        Write-Log "the new version could not be moved into place: $_"
        Write-Log 'putting the previous version back'
        Move-Item -LiteralPath $old -Destination $Target -Force
        throw
    }

    Write-Log "starting $Exe"
    Start-Process -FilePath $Exe -WorkingDirectory $Target
    Start-Sleep -Seconds 2
    Write-Log 'removing the previous version'
    Remove-Item -LiteralPath $old -Recurse -Force -ErrorAction SilentlyContinue
    Write-Log 'the update finished'
} catch {
    Write-Log "the update failed: $_"
    # The one outcome that must never happen is an application that is not there.
    if ((Test-Path -LiteralPath $old) -and -not (Test-Path -LiteralPath (Join-Path $Target 'LexiQode.exe'))) {
        Write-Log 'restoring the previous version'
        try { Move-Item -LiteralPath $old -Destination $Target -Force } catch { Write-Log "restoring failed: $_" }
    }
    if (Test-Path -LiteralPath $Exe) {
        Write-Log 'starting the application again'
        Start-Process -FilePath $Exe -WorkingDirectory $Target
    }
} finally {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}