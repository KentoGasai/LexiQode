<#
.SYNOPSIS
    Download, verify and unpack VSCodium for Windows.

.DESCRIPTION
    VSCodium is the editor shell LexiQode runs in: upstream VS Code built without
    the Microsoft branding, telemetry and marketplace layers, using Open VSX
    instead. The official portable archive is used rather than an installer, so
    nothing is written to the registry and removing the folder removes the
    editor.
    The archive is checked against the sha256 published next to it. A mismatch
    stops the script instead of unpacking something unexpected.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/install-vscodium.ps1
    powershell -ExecutionPolicy Bypass -File scripts/install-vscodium.ps1 -Version 1.140.06880 -Force
#>

param(
    [string]$Version = 'latest',
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'Programs\VSCodium'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$headers = @{ 'User-Agent' = 'lexiqode-installer' }

$exe = Join-Path $Destination 'VSCodium.exe'
if ((Test-Path $exe) -and -not $Force) {
    $installed = (Get-Item $exe).VersionInfo.ProductVersion
    Write-Host "VSCodium is already installed at $Destination (version $installed)."
    Write-Host 'Pass -Force to replace it.'
    exit 0
}

if ($Version -eq 'latest') {
    Write-Host 'asking GitHub for the latest VSCodium release...'
    $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/VSCodium/vscodium/releases/latest' -Headers $headers -TimeoutSec 60
    $Version = $release.tag_name
}
Write-Host "version: $Version"

$asset = "VSCodium-win32-x64-$Version.zip"
$base = "https://github.com/VSCodium/vscodium/releases/download/$Version"
$work = Join-Path $env:TEMP "lexiqode-vscodium-$Version"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$zip = Join-Path $work $asset
$sum = "$zip.sha256"

if (-not (Test-Path $zip)) {
    Write-Host 'downloading (about 230 MB)...'
    Invoke-WebRequest -Uri "$base/$asset" -OutFile $zip -Headers $headers -TimeoutSec 3600
}
Invoke-WebRequest -Uri "$base/$asset.sha256" -OutFile $sum -Headers $headers -TimeoutSec 120

$expected = ((Get-Content $sum -Raw) -split '\s+')[0].Trim().ToLower()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
Write-Host "expected sha256: $expected"
Write-Host "actual   sha256: $actual"
if ($expected -ne $actual) {
    throw "the downloaded archive does not match the published sha256; refusing to unpack it"
}
Write-Host 'checksum verified'

Write-Host "unpacking to $Destination ..."
if (Test-Path $Destination) {
    Remove-Item $Destination -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $Destination)

if (-not (Test-Path $exe)) {
    throw "VSCodium.exe was not found in the archive; the layout may have changed"
}

# Keep the download for a re-install, drop the empty shell of a work directory.
Remove-Item $sum -Force -ErrorAction SilentlyContinue

$product = Get-Content (Join-Path $Destination 'resources\app\product.json') -Raw | ConvertFrom-Json
$gallery = $product.extensionsGallery.serviceUrl
$builtin = (Get-ChildItem (Join-Path $Destination 'resources\app\extensions') -Directory | Measure-Object).Count

Write-Host ''
Write-Host 'VSCodium is ready.'
Write-Host "  version:          $Version"
Write-Host "  executable:       $exe"
Write-Host "  extension gallery: $gallery"
Write-Host "  built-in extensions: $builtin"
Write-Host ''
Write-Host 'Next: powershell -ExecutionPolicy Bypass -File scripts/install-extension.ps1'