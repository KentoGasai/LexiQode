<#
.SYNOPSIS
    Report exactly what this machine still needs to build the IDE.

.DESCRIPTION
    Every requirement is probed, not assumed: the tool is located, its version is
    read, and the verdict comes from that. Each failure prints the one command
    that fixes it, so the list can be worked through without guessing.

    Requirements are split by what actually uses them. Only the source build
    needs the C++ toolchain; the VSCodium patch pipeline is gone, so jq and
    rustup are deliberately not asked for.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/check-prerequisites.ps1
    powershell -ExecutionPolicy Bypass -File scripts/check-prerequisites.ps1 -Source C:\lexiqode\vscode
#>

param(
    [string]$Source = 'C:\lexiqode\vscode'
)

$ErrorActionPreference = 'Continue'
$script:missing = [System.Collections.Generic.List[object]]::new()
$script:results = [System.Collections.Generic.List[object]]::new()

function Report {
    param(
        [string]$Requirement,
        [bool]$Present,
        [string]$Found,
        [string]$Fix = '',
        [switch]$Advisory
    )
    $state = if ($Present) { 'ok' } elseif ($Advisory) { 'warn' } else { 'MISSING' }
    Write-Host ("{0,-8} {1,-34} {2}" -f $state, $Requirement, $Found)
    $script:results.Add([pscustomobject]@{
        Requirement = $Requirement
        Present     = $Present
        Found       = $Found
        Advisory    = [bool]$Advisory
    })
    if (-not $Present -and -not $Advisory) {
        $script:missing.Add([pscustomobject]@{ Requirement = $Requirement; Fix = $Fix })
    }
}

function Get-CommandPath {
    param([string]$Name)
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

Write-Host ''
Write-Host 'LexiQode build prerequisites' -ForegroundColor Cyan
Write-Host ''

# ------------------------------------------------------------------ base tools

$git = Get-CommandPath 'git'
$gitVersion = if ($git) { (& git --version) -replace 'git version ', '' } else { '' }
Report 'git' ([bool]$git) $(if ($git) { $gitVersion } else { 'not found' }) 'winget install --id Git.Git -e'

$bash = @('C:\Program Files\Git\bin\bash.exe', 'C:\Program Files (x86)\Git\bin\bash.exe') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
Report 'git bash (for build scripts)' ([bool]$bash) $(if ($bash) { 'present (ships with Git)' } else { 'not found' }) 'comes with Git for Windows'

$node = Get-CommandPath 'node'
$nodeVersion = if ($node) { (node -v).TrimStart('v') } else { '' }
Report 'node 22 or newer' ([bool]$node -and [version]$nodeVersion -ge [version]'22.0.0') $(if ($node) { "v$nodeVersion at $node" } else { 'not found' }) 'winget install --id OpenJS.NodeJS.LTS -e'

$npm = Get-CommandPath 'npm'
Report 'npm' ([bool]$npm) $(if ($npm) { "v$((npm -v))" } else { 'not found' }) 'installed with Node'

if ($node -and (Test-Path (Join-Path $Source '.nvmrc'))) {
    $wanted = (Get-Content (Join-Path $Source '.nvmrc') -Raw).Trim()
    Report 'node matches the source (.nvmrc)' ($nodeVersion -eq $wanted) `
        "source wants $wanted, running $nodeVersion" `
        "nvm install $wanted ; nvm use $wanted" -Advisory
}

$python = Get-CommandPath 'python'
$pythonVersion = if ($python) { (python --version) -replace 'Python ', '' } else { '' }
Report 'python (node-gyp)' ([bool]$python) $(if ($python) { "v$pythonVersion at $python" } else { 'not found' }) 'winget install --id Python.Python.3.12 -e'

if ($python) {
    $setuptools = (python -c "import setuptools,sys; print(setuptools.__version__)" 2>$null)
    Report 'python setuptools' ([bool]$setuptools) $(if ($setuptools) { "v$setuptools" } else { 'not importable' }) 'python -m pip install setuptools' -Advisory
}

$sevenZip = @('C:\Program Files\7-Zip\7z.exe', 'C:\Program Files (x86)\7-Zip\7z.exe') |
    Where-Object { Test-Path $_ } | Select-Object -First 1
Report '7-Zip' ([bool]$sevenZip) $(if ($sevenZip) { 'present' } else { 'not needed for the source build' }) 'winget install --id 7zip.7zip -e' -Advisory

# ------------------------------------------------------------------ the blocker

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vcTools = $null
$vsPath = $null
if (Test-Path $vswhere) {
    $vsPath = & $vswhere -latest -products * -property installationPath 2>$null
    $vcTools = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property displayName 2>$null
}

Report 'C++ compiler (MSVC VC.Tools.x86.x64)' ([bool]$vcTools) `
    $(if ($vcTools) { "$vcTools at $vsPath" } elseif ($vsPath) { "Visual Studio at $vsPath has no C++ workload" } else { 'no Visual Studio with C++ installed' }) `
    'see the elevated command below'

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\Include" -Directory -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending | Select-Object -First 1
Report 'Windows SDK' ([bool]$sdk) $(if ($sdk) { "version $($sdk.Name)" } else { 'not found' }) 'included with the Visual Studio command below' -Advisory

# ------------------------------------------------------------------ environment

$elevated = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Report 'this session is elevated' $elevated `
    $(if ($elevated) { 'yes, it could install the toolchain' } else { 'no, so the install must be done in an elevated window' }) `
    'open PowerShell with Run as administrator' -Advisory

$drive = (Split-Path -Qualifier $Source)
$free = [int]((Get-PSDrive ($drive.TrimEnd(':'))).Free / 1GB)
Report 'free space on the build volume' ($free -ge 20) "$free GB free on $drive" 'free at least 20 GB' -Advisory

$sourceReady = Test-Path (Join-Path $Source 'package.json')
Report 'VS Code source tree' $sourceReady $(if ($sourceReady) { $Source } else { "nothing at $Source" }) `
    "git clone --depth 1 https://github.com/microsoft/vscode.git $Source"

$branded = if ($sourceReady) { (Get-Content (Join-Path $Source 'product.json') -Raw | ConvertFrom-Json).nameLong } else { '' }
Report 'source carries our identity' ($branded -eq 'LexiQode') $(if ($branded) { "nameLong is $branded" } else { 'unknown' }) `
    'powershell -File scripts/build-ide.ps1' -Advisory

$modules = if (Test-Path (Join-Path $Source 'node_modules')) {
    @(Get-ChildItem (Join-Path $Source 'node_modules') -Directory).Count
} else { 0 }
Report 'dependencies installed' ($modules -gt 500) "$modules packages in node_modules" 'npm install (done by build-ide.ps1)' -Advisory

# ------------------------------------------------------------------ verdict

Write-Host ''
if ($script:missing.Count -eq 0) {
    Write-Host 'everything needed is present' -ForegroundColor Green
    Write-Host 'build the IDE:  powershell -ExecutionPolicy Bypass -File scripts\build-ide.ps1'
    exit 0
}

Write-Host ("{0} requirement(s) missing:" -f $script:missing.Count) -ForegroundColor Yellow
foreach ($item in $script:missing) {
    Write-Host ("  - {0}" -f $item.Requirement) -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'The only hard blocker for the source build is the C++ toolchain.'
Write-Host 'Run this from PowerShell opened with "Run as administrator":'
Write-Host ''
Write-Host '  winget install --id Microsoft.VisualStudio.BuildTools -e --source winget --override "--add Microsoft.VisualStudio.Component.Windows11SDK.26100 --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre --add Microsoft.VisualStudio.Component.VC.ATL.Spectre --add Microsoft.VisualStudio.Component.VC.ATLMFC.Spectre"'
Write-Host ''
Write-Host 'It downloads roughly 5 to 7 GB and takes 10 to 20 minutes.'
Write-Host 'Then re-run this script: it should report that everything is present.'
exit 1