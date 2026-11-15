[CmdletBinding()]
param(
    [switch]$Advanced
)

$ErrorActionPreference = 'Stop'
$settings = @{
    ABDB_BIND = '127.0.0.1'
    ABDB_LOCAL_ONLY = '1'
    COOKIE_SECURE = '0'
    ABDB_IP = ''
    ABDB_DOMAIN = ''
    ABDB_ADVANCED_ENABLED = $(if ($Advanced) { '1' } else { '0' })
}
$previous = @{}
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath 'compose.yaml' -PathType Leaf)) {
        throw 'compose.yaml is missing. Run install.ps1 from a complete AbDbAdmin checkout.'
    }
    Get-Command docker -ErrorAction Stop | Out-Null
    $version = docker version --format '{{.Server.Version}}'
    if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop and try again.' }
    if ($version -notmatch '^(\d+)\.' -or [int]$Matches[1] -lt 28) {
        throw 'Local-only mode requires Docker Engine 28 or newer.'
    }
    foreach ($name in $settings.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process')
    }
    $compose = @('compose', '-f', (Join-Path $PSScriptRoot 'compose.yaml'))
    if ($Advanced) { $compose += @('--profile', 'advanced') }

    docker @compose up --build -d --wait
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose failed to start AbDbAdmin.' }

    $address = docker @compose port abdbadmin 8099
    if ($LASTEXITCODE -ne 0) { throw 'Could not determine the AbDbAdmin address.' }
    Write-Host "AbDbAdmin: http://$address"
    if ($Advanced) {
        $advancedAddress = docker @compose port phpmyadmin 80
        if ($LASTEXITCODE -ne 0) { throw 'Could not determine the phpMyAdmin address.' }
        Write-Host "Advanced MySQL/MariaDB: http://$advancedAddress"
    }
    docker @compose exec -T abdbadmin node --disable-warning=ExperimentalWarning server.mjs show-access
    if ($LASTEXITCODE -ne 0) { throw 'Could not display sign-in details.' }
}
finally {
    foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process')
    }
    Pop-Location
}
