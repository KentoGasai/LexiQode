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
    # An explicit -Source wins, then the environment, then the local clone this
    # repository was developed against. A CI runner has none of the three, which
    # is why it always passes -Source.
    [string]$Source = $(if ($env:VSCODE_SOURCE) { $env:VSCODE_SOURCE } else { 'C:\lexiqode\vscode' }),
    # Empty means "leave the packaged build next to the source tree", which is the
    # least surprising place for it and needs no writable C:\lexiqode.
    [string]$Out = '',
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

function Find-SignTool {
    # Packaging a Windows build verifies and strips Authenticode signatures with
    # signtool.exe (build/gulpfile.vscode.ts spawns it for every win32 target, and
    # build/gulpfile.reh.ts does the same for the server), so the Windows SDK has to
    # be *reachable*, not merely installed. Its bin folder is not on PATH by
    # default, which is why a packaging run would otherwise fail at the very end
    # with "spawn signtool.exe ENOENT" after taking the whole build to get there.
    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10\bin')
    ) | Where-Object { $_ -and (Test-Path $_) }

    $candidates = foreach ($root in $roots) {
        Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'x64\signtool.exe' } |
            Where-Object { Test-Path $_ }
    }
    if (-not $candidates) { return $null }

    # Several SDKs can be installed side by side; the newest one is the least
    # likely to choke on a modern PE header.
    return $candidates |
        Sort-Object {
            $match = [regex]::Match((Split-Path (Split-Path $_ -Parent) -Leaf), '\d+(\.\d+)+')
            if ($match.Success) { [version]$match.Value } else { [version]'0.0' }
        } -Descending |
        Select-Object -First 1
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

if (-not $Dev) {
    $signtool = Find-SignTool
    if (-not $signtool) {
        Write-Host 'the Windows SDK is missing, and packaging needs it' -ForegroundColor Yellow
        Write-Host 'signtool.exe from the SDK is what verifies and strips Authenticode signatures'
        Write-Host 'while packaging (build/gulpfile.vscode.ts). Without it the build would run to'
        Write-Host 'the end and then fail with "spawn signtool.exe ENOENT". Install the component:'
        Write-Host ''
        Write-Host '  winget install --id Microsoft.VisualStudio.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --add Microsoft.VisualStudio.Component.Windows11SDK.26100"'
        Write-Host ''
        Write-Host 'Or run with -Dev to compile and start the editor without packaging.'
        throw 'the Windows SDK (signtool.exe) is required to package a Windows build'
    }
    # The build shells out to signtool; putting its folder first means it wins over
    # any other copy the machine happens to have.
    $env:PATH = "$(Split-Path $signtool -Parent);$env:PATH"
    Write-Host "  signtool: $signtool"
}

$wanted = (Get-Content (Join-Path $Source '.nvmrc') -Raw).Trim()
$have = (node -v).TrimStart('v')
if ($wanted -and $have -ne $wanted) {
    Write-Host "  note: the source asks for Node $wanted, this is $have. Native modules are built for the running version, so a mismatch can bite later." -ForegroundColor Yellow
}

# ------------------------------------------------------------------ product shape

Write-Step 'removing the built-in vendor chat extension'
# Upstream ships its own chat extension as a built-in, together with a packaging step
# whose only job is to materialize that extension's SDK natives. The step throws when the
# directory is missing, which is how an earlier packaging run failed:
#
#   Error: [prepareBuiltInCopilotRipgrepShim] Copilot SDK directory not found at
#   ...\resources\app\extensions\copilot\node_modules\@github\copilot\sdk
#
# Neither the extension nor the step belongs in this product: the agent is ours, and this
# is meant to run without a vendor account.
#
# The surgery itself lives in one script, not here. It rewrites nine scripts in
# package.json through the JSON parser, drops one line from the install list and two from
# the packaging series, then deletes the directory. Doing that with a few replacements in
# this file is how two references were missed before, each miss costing a forty-minute
# build. scripts/tests/remove-vendor-chat.test.mjs covers it and CI runs that test, so a
# mistake is caught in a minute on a free runner instead.
#
# It runs before `npm install` on purpose. The install list still points at the removed
# directory when this starts, and removing the entry first is what saves about four
# minutes of installing dependencies for an extension that will not ship.
& node (Join-Path $repo 'scripts\remove-vendor-chat.mjs') $Source
if ($LASTEXITCODE -ne 0) { throw "removing the vendor chat extension failed with exit code $LASTEXITCODE" }

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
# Read through .NET with an explicit encoding: Windows PowerShell's own reader falls
# back to the ANSI code page for a file without a byte-order mark, which would mangle
# any non-ASCII character it found.
$overlay = [System.IO.File]::ReadAllText((Join-Path $repo 'ide\product.overlay.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$current = [System.IO.File]::ReadAllText($product, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
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
Write-Host "  $changed field(s) set; identity is now '$($current.nameLong)'"

Write-Step 'removing vendor service endpoints'
# The sources name other vendors' services in product.json, and two kinds of them
# matter: sign-up and billing links under defaultChatAgent, and the entitlement
# and token endpoints the chat surface would call on behalf of an account. This
# product is meant to work with a user's own endpoint and no account, so every URL
# to those hosts is emptied. The host list is shared with scripts/check_branding.py
# so the transform and the release check cannot disagree.
$hosts = @(
    Get-Content (Join-Path $repo 'ide\vendor-hosts.txt') |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -and -not $_.StartsWith('#') }
)
if (-not $hosts) { throw 'ide/vendor-hosts.txt lists no hosts; refusing to guess what is ours' }
$vendorPattern = '^https?://([a-z0-9-]+\.)*(' +
    (($hosts | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')([:/]|$)'

# The two download feeds are build inputs, not runtime services: they are read
# while packaging to fetch Node and Electron and never contacted by the installed
# product. scripts/check_branding.py exempts the same two keys, so the transform
# and the release check stay in step.
function Clear-VendorUrlExcept {
    param($Node, [string[]]$SkipKeys)
    if ($null -eq $Node -or $Node -is [string]) { return 0 }
    if ($Node -is [System.Collections.IEnumerable]) {
        $sum = 0
        foreach ($item in $Node) { $sum += Clear-VendorUrlExcept -Node $item -SkipKeys $SkipKeys }
        return $sum
    }
    $total = 0
    foreach ($property in @($Node.PSObject.Properties)) {
        if ($SkipKeys -contains $property.Name) { continue }
        if ($property.Value -is [string]) {
            # Only values held by a key are emptied. A URL inside an array has no
            # key to set to an empty string, and replacing the element would
            # silently change the length of a list whose meaning is unknown; the
            # release check reports those instead. scripts/check_branding.py
            # behaves identically, and its tests pin that.
            if ($property.Value -match $vendorPattern) {
                $Node.$($property.Name) = ''
                $total++
            }
        } else {
            $total += Clear-VendorUrlExcept -Node $property.Value -SkipKeys $SkipKeys
        }
    }
    return $total
}

$emptied = Clear-VendorUrlExcept -Node $current -SkipKeys @('nodejsArtifactFeed', 'electronArtifactFeed')
Write-Host "  $emptied vendor URL(s) emptied"
if ($emptied -eq 0) {
    # Worth noticing rather than passing silently: it either means upstream cleaned
    # them up, in which case this step can go, or that the pattern stopped matching.
    Write-Host '  note: no vendor endpoints were found in product.json' -ForegroundColor Yellow
}

$json = $current | ConvertTo-Json -Depth 40
[System.IO.File]::WriteAllText($product, $json, (New-Object System.Text.UTF8Encoding($false)))

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
$packageLog = Join-Path $Source 'gulp-package.log'
Push-Location $Source
try {
    # The output is kept as well as shown, so a failure can be explained further down
    # this log. gulp prints the reason *before* the stack trace, and a pasted tail
    # therefore never contains it - which cost two round trips already.
    & npm run gulp vscode-win32-x64 2>&1 | Tee-Object -FilePath $packageLog
    $packageCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($packageCode -ne 0) {
    Write-Host ''
    Write-Host 'packaging failed; the reason is in its own output:' -ForegroundColor Red
    $packageLines = @()
    if (Test-Path $packageLog) { $packageLines = @(Get-Content $packageLog -ErrorAction SilentlyContinue) }
    Write-Host "  ($($packageLines.Count) lines captured; first matches first)"
    $matched = $packageLines |
        Select-String -Pattern 'Error:|error:|ENOENT|EPERM|EBUSY|EACCES|rate limit|not found|Failed to|failed to|cannot find' |
        Select-Object -First 15
    foreach ($line in $matched) { Write-Host "  > $($line.Line.Trim())" }
    Write-Host '  ... and the last 25 lines:'
    foreach ($line in ($packageLines | Select-Object -Last 25)) { Write-Host "  | $line" }
    throw "packaging failed with exit code $packageCode"
}

$built = Join-Path (Split-Path $Source -Parent) 'VSCode-win32-x64'
if (-not (Test-Path $built)) { throw "packaging reported success but there is no build at $built" }

Write-Step 'installing the agent into the build'
# The agent ships inside the product: a built-in extension in the application's
# own extensions folder, plus the Python core next to it. Neither is installable
# or removable through the UI, which is the point.
$extension = Join-Path $repo 'extension'
if (-not (Test-Path (Join-Path $extension 'out\extension.js'))) {
    throw "the extension is not compiled; run: npm --prefix extension run compile"
}

$target = Join-Path $built 'resources\app\extensions\lexiqode'
if (Test-Path $target) { Remove-Item $target -Recurse -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null
foreach ($item in 'package.json', 'README.md', 'out', 'media') {
    $itemPath = Join-Path $extension $item
    if (Test-Path $itemPath) { Copy-Item $itemPath $target -Recurse }
}
# Source maps are development artefacts; a shipped build should not carry them.
Get-ChildItem $target -Recurse -Filter '*.js.map' -ErrorAction SilentlyContinue | Remove-Item -Force

$core = Join-Path $built 'resources\lexiqode-core'
if (Test-Path $core) { Remove-Item $core -Recurse -Force }
New-Item -ItemType Directory -Force -Path $core | Out-Null
# Copied entry by entry rather than wholesale: tests, caches and stray scratch
# files are not part of the product.
foreach ($item in 'lexiqode', 'pyproject.toml', 'README.md', 'requirements.txt') {
    $itemPath = Join-Path $repo (Join-Path 'core' $item)
    if (-not (Test-Path $itemPath)) { continue }
    if (Test-Path $itemPath -PathType Container) {
        $destination = Join-Path $core $item
        New-Item -ItemType Directory -Force -Path $destination | Out-Null
        Copy-Item (Join-Path $itemPath '*') $destination -Recurse -Exclude '__pycache__'
    } else {
        Copy-Item $itemPath $core
    }
}
Get-ChildItem $core -Recurse -Directory -Filter '__pycache__' -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force
Get-ChildItem $core -Recurse -Filter '*.pyc' -ErrorAction SilentlyContinue | Remove-Item -Force

if ($Out -and $Out -ne (Split-Path $built -Parent)) {
    Write-Step "moving the build to $Out"
    if (Test-Path (Join-Path $Out (Split-Path $built -Leaf))) {
        Remove-Item (Join-Path $Out (Split-Path $built -Leaf)) -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    Move-Item $built (Join-Path $Out (Split-Path $built -Leaf))
    $built = Join-Path $Out (Split-Path $built -Leaf)
}

# Read the identity back out of the build instead of trusting the earlier steps:
# this is the file the application itself will read at startup.
$shipped = Get-Content (Join-Path $built 'resources\app\product.json') -Raw | ConvertFrom-Json
$launcher = Get-ChildItem $built -Filter '*.exe' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'unins000.exe' } | Select-Object -First 1

Write-Host ''
Write-Host 'the IDE is built' -ForegroundColor Green
Write-Host "  folder:    $built"
Write-Host "  launcher:  $(if ($launcher) { $launcher.Name } else { '(no executable found)' })"
Write-Host "  identity:  $($shipped.nameLong) ($($shipped.applicationName))"
Write-Host "  profile:   $($shipped.dataFolderName)"
Write-Host "  gallery:   $($shipped.extensionsGallery.serviceUrl)"
Write-Host "  telemetry: $($shipped.enableTelemetry)"
Write-Host "  agent:     built-in extension + bundled core"
Write-Host "  size:      $([int]((Get-ChildItem $built -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)) MB"