<#
.SYNOPSIS
    Run the LexiQode extension inside a real editor and verify it end to end.

.DESCRIPTION
    Starts VSCodium (or VS Code) as an extension development host, pointed at the
    repository as the workspace, and runs extension/test/vscode/run.js inside its
    extension host. Unlike the stub tests, nothing here is simulated: the editor
    activates the extension, the panel asks it to start the Python core, and the
    core really spawns and answers on its port.
    The host runs against a throwaway user profile, so your own settings,
    extensions and secret storage are not touched.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/test-in-editor.ps1
#>

param(
    [ValidateSet('codium', 'code')]
    [string]$Editor = 'codium',
    [switch]$KeepProfile
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$extension = Join-Path $repo 'extension'
$runner = Join-Path $extension 'test\vscode\run.js'

if (-not (Test-Path $runner)) { throw "the in-editor runner is missing at $runner" }
if (-not (Test-Path (Join-Path $extension 'out\extension.js'))) {
    throw 'compile the extension first: npm run compile'
}

$exe = switch ($Editor) {
    'codium' { Join-Path $env:LOCALAPPDATA 'Programs\VSCodium\VSCodium.exe' }
    'code' { Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe' }
}
if (-not (Test-Path $exe)) { throw "$Editor is not installed at $exe" }

# A throwaway profile keeps this run away from the real one.
$profileRoot = Join-Path $env:TEMP ('lexiqode-editor-test-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$userData = Join-Path $profileRoot 'user-data'
$extensionsDir = Join-Path $profileRoot 'extensions'
$configDir = Join-Path $profileRoot 'config'
New-Item -ItemType Directory -Force -Path $userData, $extensionsDir, $configDir | Out-Null

# Point the core at a closed port: this test never calls a model.
$settings = @{
    version        = 1
    active_profile = 'test'
    profiles       = @{
        test = @{
            id       = 'test'
            label    = 'Test'
            base_url = 'http://127.0.0.1:1/v1'
            model    = 'test-model'
        }
    }
    agent          = @{ auto_approve = $true; max_steps = 4 }
}
# Written through .NET because the core parses this file as JSON and Windows
# PowerShell 5.1 writes a byte-order mark with -Encoding UTF8, which breaks it.
$settingsJson = $settings | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText(
    (Join-Path $configDir 'settings.json'),
    $settingsJson,
    (New-Object System.Text.UTF8Encoding($false))
)

$env:LEXIQODE_CONFIG_DIR = $configDir
$env:LEXIQODE_DATA_DIR = Join-Path $profileRoot 'data'
$env:LEXIQODE_RUNTIME_FILE = Join-Path $configDir 'core-runtime.json'

Write-Host "running the extension inside $Editor..."
Write-Host "  profile: $profileRoot"

$arguments = @(
    "--extensionDevelopmentPath=$extension",
    "--extensionTestsPath=$runner",
    "--user-data-dir=$userData",
    "--extensions-dir=$extensionsDir",
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-gpu',
    $repo
)

$process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru -Wait
$code = $process.ExitCode

if (-not $KeepProfile) {
    # The editor releases its file handles a moment after the process exits, so
    # the first removal attempt can fail on a directory that is still open.
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Remove-Item $profileRoot -Recurse -Force -ErrorAction Stop
            break
        } catch {
            if ($attempt -eq 5) {
                Write-Host "note: the throwaway profile could not be removed: $profileRoot"
            }
            Start-Sleep -Milliseconds 400
        }
    }
}

Write-Host ''
if ($code -eq 0) {
    Write-Host 'in-editor verification PASSED'
} else {
    Write-Host "in-editor verification FAILED (exit code $code)"
    Write-Host 'the editor prints the assertion and stack above this line'
}
exit $code