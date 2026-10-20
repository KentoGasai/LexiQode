<#
.SYNOPSIS
    Build our own IDE from the VS Code source tree.

.DESCRIPTION
    This is the path Cursor took: the product is a patched build of the VS Code
    sources, not an editor plus an add-on. What it buys us is real - our own name
    and profile, our agent shipped as a built-in part of the product, room to
    change the workbench itself, and none of Microsoft's marketplace or account
    machinery.

    The script refuses to start without the C++ toolchain instead of failing
    halfway through npm install with a node-gyp error, which is what happens
    otherwise. The check is a real probe: it looks for a Visual Studio
    installation that carries the C++ workload.

.PARAMETER Dev
    Skip packaging. Compiles and starts the editor straight from the sources,
    which is the loop to use while developing.

.PARAMETER SkipInstall
    Assume node_modules is already installed.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-ide.ps1
    powershell -ExecutionPolicy Bypass -File scripts/build-ide.ps1 -Dev
#>

param(
    [string]$Source = 'C:\lexiqode\vscode',
    [string]$Out = 'C:\lexiqode\out',
    [switch]$Dev,
    [switch]$SkipInstall,
    [string]$Workspace
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$product = Join-Path $Source 'product.json'

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "== $Text" -ForegroundColor Cyan
}

# ------------------------------------------------------------------ prerequisites

function Test-CppToolchain {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (-not (Test-Path $vswhere)) { return $null }
    $path = & $vswhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    if ($path) { return $path }
    return $null
}

Write-Step 'checking the toolchain'
if (-not (Test-Path (Join-Path $Source 'package.json'))) {
    throw "no VS Code source tree at $Source. Clone it with: git clone --depth 1 https://github.com/microsoft/vscode.git $Source"
}

$vs = Test-CppToolchain
if (-not $vs) {
    Write-Host 'the C++ toolchain is missing' -ForegroundColor Yellow
    Write-Host 'native modules (@vscode/windows-process-tree, policy-watcher, deviceid) are compiled with node-gyp and cannot be skipped.'
    Write-Host 'Install it from an elevated PowerShell, then run this script again:'
    Write-Host ''
    Write-Host '  winget install --id Microsoft.VisualStudio.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows11SDK.26100 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.Spectre --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre"'
    Write-Host ''
    throw 'the C++ toolchain is required to build the IDE'
}
Write-Host "  Visual Studio: $vs"
Write-Host "  node: $(node -v)"
Write-Host "  source: $Source"

$wanted = (Get-Content (Join-Path $Source '.nvmrc') -Raw).Trim()
$have = (node -v).TrimStart('v')
if ($wanted -and $have -ne $wanted) {
    Write-Host "  note: the source asks for Node $wanted, this is $have. Native modules are built for the running version, so a mismatch can bite later." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ dependencies

if (-not $SkipInstall) {
    Write-Step 'installing dependencies (this compiles the native modules)'
    Push-Location $Source
    try {
        & npm install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }
}

# ------------------------------------------------------------------ branding

Write-Step 'applying our identity'
$overlay = Get-Content (Join-Path $repo 'ide\product.overlay.json') -Raw | ConvertFrom-Json
$current = Get-Content $product -Raw | ConvertFrom-Json
$changed = 0
foreach ($property in $overlay.PSObject.Properties) {
    if ($property.Name.StartsWith('_')) { continue }
    if ($current.PSObject.Properties.Name -contains $property.Name) {
        $existing = $current.$($property.Name)
        if ($existing -ne $property.Value) {
            $current.$($property.Name) = $property.Value
            $changed++
        }
    } else {
        $current | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value
        $changed++
    }
}
$json = $current | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($product, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "  $changed field(s) set; identity is now '$($current.nameLong)'"

# ------------------------------------------------------------------ compile

Write-Step 'compiling the client'
Push-Location $Source
try {
    & npm run compile
    if ($LASTEXITCODE -ne 0) { throw "compile failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# ------------------------------------------------------------------ run or package

if ($Dev) {
    Write-Step 'starting the editor from source'
    $launcher = Join-Path $Source 'scripts\code.bat'
    if (-not (Test-Path $launcher)) { throw "the launcher is missing at $launcher" }
    if (-not $Workspace) { $Workspace = $repo }
    Write-Host "  workspace: $Workspace"
    Start-Process -FilePath $launcher -ArgumentList $Workspace | Out-Null
    Write-Host '  the editor is starting. The agent is built in, so it needs no install.'
    return
}

Write-Step 'packaging a Windows x64 build'
Push-Location $Source
try {
    & npm run gulp vscode-win32-x64
    if ($LASTEXITCODE -ne 0) { throw "packaging failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$built = Join-Path (Split-Path $Source -Parent) 'VSCode-win32-x64'
if (-not (Test-Path $built)) { throw "packaging reported success but there is no build at $built" }

Write-Step 'installing the agent into the build'
$target = Join-Path $built 'resources\app\extensions\lexiqode'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
$extension = Join-Path $repo 'extension'
foreach ($item in 'package.json', 'out', 'media') {
    Copy-Item (Join-Path $extension $item) $target -Recurse
}
$core = Join-Path $built 'resources\lexiqode-core'
if (Test-Path $core) { Remove-Item $core -Recurse -Force }
Copy-Item (Join-Path $repo 'core') $core -Recurse

Write-Host ''
Write-Host 'the IDE is built' -ForegroundColor Green
Write-Host "  folder: $built"
Write-Host "  launcher: $(Join-Path $built 'LexiQode.exe')"
Write-Host "  agent: built-in extension + bundled core"