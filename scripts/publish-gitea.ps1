<#
.SYNOPSIS
    Publish a built LexiQode bundle to a Gitea package registry.

.DESCRIPTION
    Uploads the zip that scripts/build-app.ps1 produced into Gitea's generic
    package registry, which is the one that suits a desktop application: it keeps
    the file exactly as built, next to the git tag that describes it, and needs no
    package manager on the machine that downloads it.

    The token is read from -Token or from the GITEA_TOKEN environment variable and
    is never echoed, logged or written to a file. Nothing here installs a tool:
    the upload is two HTTP calls, so this works on a machine that has nothing but
    PowerShell.

.PARAMETER Server
    Base URL of the Gitea instance, for example https://git.example.com.

.PARAMETER Owner
    User or organisation that owns the package.

.PARAMETER Version
    Version to publish. Defaults to the version in app/package.json.

.PARAMETER File
    The file to upload. Defaults to the newest bundle in dist/.

.PARAMETER List
    List the published versions and exit without uploading.

.PARAMETER Check
    Only check that the server answers and that the token is accepted.

.EXAMPLE
    $env:GITEA_TOKEN = '...'
    powershell -ExecutionPolicy Bypass -File scripts/publish-gitea.ps1 `
        -Server https://git.example.com -Owner kento
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$Owner,
    [string]$Package = 'lexiqode',
    [string]$Version,
    [string]$File,
    [string]$Token,
    [switch]$List,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repo = Split-Path -Parent $PSScriptRoot
$app = Join-Path $repo 'app'

$base = $Server.TrimEnd('/')
if (-not $base.StartsWith('http')) { $base = "https://$base" }

if (-not $Token) { $Token = $env:GITEA_TOKEN }
if (-not $Token -and -not $List) {
    throw 'a token is required: pass -Token or set GITEA_TOKEN (Gitea: Settings > Applications > Generate token, scope write:package)'
}
if (-not $Owner) { $Owner = $env:GITEA_OWNER }
if (-not $Owner -and -not $Check) { throw 'an owner is required: pass -Owner (the user or organisation that owns the package)' }

if (-not $Version) {
    $Version = (Get-Content (Join-Path $app 'package.json') -Raw | ConvertFrom-Json).version
}

function Invoke-Gitea {
    param(
        [string]$Method,
        [string]$Path,
        [byte[]]$Body,
        [string]$ContentType = 'application/octet-stream'
    )
    $headers = @{ Accept = 'application/json' }
    # The token goes in a header and is never interpolated into a message.
    if ($Token) { $headers['Authorization'] = "token $Token" }
    $parameters = @{
        Method      = $Method
        Uri         = "$base$Path"
        Headers     = $headers
        ErrorAction = 'Stop'
    }
    if ($Body) {
        $parameters['Body'] = $Body
        $parameters['ContentType'] = $ContentType
    }
    try {
        return Invoke-RestMethod @parameters
    }
    catch {
        $status = $null
        $detail = $_.Exception.Message
        if ($_.Exception.Response) {
            $status = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $payload = $reader.ReadToEnd()
                if ($payload) { $detail = $payload }
            }
            catch {
                # Keep the transport message.
            }
        }
        if ($status -eq 401 -or $status -eq 403) {
            throw "Gitea refused the token (HTTP $status). $detail"
        }
        if ($status -eq 409) {
            throw "version $Version of $Package already exists on $base (HTTP 409). Bump the version or delete the package."
        }
        throw "Gitea answered HTTP $status for $Method $Path. $detail"
    }
}

# PowerShell variable names are case-insensitive, so a local `$version` would be
# the same variable as the `-Version` parameter and silently overwrite the
# release version. The answer is held under a name that cannot collide, and read
# defensively: a server that answers with something other than an object should
# produce a message, not a strict-mode property error.
$serverInfo = Invoke-Gitea -Method GET -Path '/api/v1/version'
$serverVersion = if ($serverInfo -is [string]) { $serverInfo } else { "$($serverInfo.version)" }
if (-not $serverVersion) { $serverVersion = '(unreported)' }
Write-Host "server: $base"
Write-Host "gitea:  $serverVersion"

if ($Check) {
    if (-not $Token) { Write-Host 'token:  not provided, so only reachability was checked' }
    else {
        $who = Invoke-Gitea -Method GET -Path '/api/v1/user'
        $login = if ($who -is [string]) { $who } else { "$($who.login)" }
        if (-not $login) { $login = '(the server did not name the account)' }
        Write-Host "token:  accepted for $login"
    }
    return
}

if ($List) {
    $packages = Invoke-Gitea -Method GET -Path "/api/packages/$Owner/generic/$Package"
    foreach ($entry in $packages) {
        Write-Host ("{0}  {1} file(s)" -f $entry.version, $entry.file_count)
    }
    return
}

if (-not $File) {
    $dist = Join-Path $repo 'dist'
    if (-not (Test-Path $dist)) { throw 'there is no dist/ to publish; run scripts/build-app.ps1 first' }
    $candidate = Get-ChildItem $dist -File -Filter 'LexiQode-*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $candidate) { throw 'no zip was found in dist/; run scripts/build-app.ps1 first' }
    $File = $candidate.FullName
}
if (-not (Test-Path $File)) { throw "no such file: $File" }

$name = Split-Path -Leaf $File
$bytes = [System.IO.File]::ReadAllBytes($File)
$digest = (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant()
$sizeMb = [math]::Round($bytes.Length / 1MB, 1)

Write-Host ''
Write-Host "publishing $name ($sizeMb MB, sha256 $digest)"
Invoke-Gitea -Method PUT -Path "/api/packages/$Owner/generic/$Package/$Version/$name" -Body $bytes | Out-Null

$download = "$base/api/packages/$Owner/generic/$Package/$Version/$name"
Write-Host ''
Write-Host 'published' -ForegroundColor Green
Write-Host "  download: $download" -ForegroundColor Green
Write-Host "  sha256:   $digest" -ForegroundColor Green
Write-Host ''
Write-Host 'To check it:  curl -L -o lexiqode.zip "' + $download + '"'