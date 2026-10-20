<#
.SYNOPSIS
    Turn the CI artifact into a working, portable application.

.DESCRIPTION
    The build produced in CI arrives as a zip. This unpacks it somewhere the user
    can write to, checks that what arrived really is our product with the agent
    inside it, and reports how to start it. Nothing is installed, nothing is
    registered, and no administrator rights are involved - which is the whole
    point of building elsewhere.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/use-artifact.ps1 -Zip "$env:USERPROFILE\Downloads\LexiQode-win32-x64.zip"
    powershell -ExecutionPolicy Bypass -File scripts/use-artifact.ps1 -Zip .\build.zip -Launch
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$Zip,
    [string]$Target = (Join-Path $env:LOCALAPPDATA 'Programs\LexiQode'),
    [switch]$Launch,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Zip)) { throw "the artifact is not there: $Zip" }
$Zip = (Resolve-Path $Zip).Path

Write-Host ''
Write-Host 'unpacking' -ForegroundColor Cyan
$staging = Join-Path $env:TEMP ('lexiqode-artifact-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $staging | Out-Null
try {
    # Expand-Archive is slow on a build this size, but it is always available;
    # .NET is used when it can be, which is several times faster.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($Zip, $staging)

    # The upload contains a folder, but a hand-made zip may contain its contents
    # instead. Find the product by looking for the file the application reads.
    $productPath = Get-ChildItem $staging -Recurse -Filter 'product.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match 'resources\\app\\product\.json$' } |
        Select-Object -First 1
    if (-not $productPath) {
        throw "no resources\app\product.json inside $Zip - this is not an IDE build"
    }
    $root = Split-Path (Split-Path (Split-Path $productPath.FullName -Parent) -Parent) -Parent
    Write-Host "  product root: $root"

    Write-Host ''
    Write-Host 'checking what arrived' -ForegroundColor Cyan
    $product = Get-Content $productPath.FullName -Raw | ConvertFrom-Json
    $checks = [System.Collections.Generic.List[object]]::new()
    function Check {
        param([string]$Name, [bool]$Ok, [string]$Detail)
        $checks.Add([pscustomobject]@{ Name = $Name; Ok = $Ok })
        $mark = if ($Ok) { 'ok  ' } else { 'FAIL' }
        Write-Host ("{0} {1,-38} {2}" -f $mark, $Name, $Detail)
    }

    Check 'identity is ours' ($product.nameLong -eq 'LexiQode') $product.nameLong
    Check 'own profile folder' ($product.dataFolderName -eq '.lexiqode') $product.dataFolderName
    Check 'telemetry off' ($product.enableTelemetry -eq $false) ([string]$product.enableTelemetry)
    Check 'gallery is Open VSX' ("$($product.extensionsGallery.serviceUrl)" -like '*open-vsx.org*') `
        "$($product.extensionsGallery.serviceUrl)"
    $builtin = Join-Path $root 'resources\app\extensions\lexiqode\out\extension.js'
    Check 'agent built in' (Test-Path $builtin) 'resources\app\extensions\lexiqode'
    $core = Join-Path $root 'resources\lexiqode-core\lexiqode\server\http.py'
    Check 'core bundled' (Test-Path $core) 'resources\lexiqode-core'
    $launcher = Get-ChildItem $root -Filter '*.exe' -File | Where-Object { $_.Name -ne 'unins000.exe' } |
        Select-Object -First 1
    Check 'launcher present' ($null -ne $launcher) $(if ($launcher) { $launcher.Name } else { 'none found' })

    if (Test-Path $Target) {
        if (-not $Force) {
            throw "$Target already exists; pass -Force to replace it"
        }
        Write-Host ''
        Write-Host "replacing $Target"
        # A running instance holds its executable, and the error for that is
        # unhelpful, so it is named here instead.
        try {
            Remove-Item $Target -Recurse -Force
        } catch {
            throw "cannot replace $Target - close every LexiQode window and try again"
        }
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $Target -Parent) | Out-Null
    Move-Item $root $Target

    Write-Host ''
    Write-Host 'ready' -ForegroundColor Green
    Write-Host "  folder:   $Target"
    Write-Host "  launcher: $(Join-Path $Target $launcher.Name)"
    Write-Host ''
    Write-Host 'First run: open a folder, then set your endpoint with'
    Write-Host '  LexiQode: Set Up the Model Endpoint   (Command Palette, Ctrl+Shift+P)'
    Write-Host 'The agent sits in the right-hand side bar, or in a tab with Ctrl+Alt+C.'

    if ($Launch) {
        Start-Process -FilePath (Join-Path $Target $launcher.Name) | Out-Null
        Write-Host ''
        Write-Host 'started.'
    }

    $failed = @($checks | Where-Object { -not $_.Ok })
    if ($failed.Count -gt 0) {
        Write-Host ''
        Write-Host ("{0} check(s) failed: {1}" -f $failed.Count, ($failed.Name -join ', ')) -ForegroundColor Yellow
        exit 1
    }
    exit 0
} finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}