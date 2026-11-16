# Starts the Valour adapter with stdout/stderr redirected to files under logs\.
#
# Why this exists: the Valour SDK writes ~60 debug lines before the first line of
# application output. If the adapter is launched with a stdout pipe that nobody
# drains, the process blocks on a full pipe buffer and looks hung: alive, socket
# established, log empty. Redirecting to a file makes that impossible.
#
# Usage:
#   .\run-adapter.ps1              # background, logs to logs\adapter-<stamp>.log
#   .\run-adapter.ps1 -Foreground  # run in this console
#   .\run-adapter.ps1 -TimeoutSeconds 20

param(
    [int]$TimeoutSeconds = 45,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$csproj = Join-Path $projectRoot 'AnathemaValourAdapter.csproj'
$logDir = Join-Path $projectRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$outLog = Join-Path $logDir "adapter-$stamp.log"
$errLog = Join-Path $logDir "adapter-$stamp.err.log"

# One listener only: two adapters would relay every message to Discord twice.
Get-Process AnathemaValourAdapter -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

$env:VALOUR_STEP_TIMEOUT_SECONDS = $TimeoutSeconds

if ($Foreground) {
    & dotnet run --no-build --project $csproj
    exit $LASTEXITCODE
}

$proc = Start-Process -FilePath 'dotnet' `
    -ArgumentList "run --no-build --project `"$csproj`"" `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden

Write-Host "adapter pid = $($proc.Id)"
Write-Host "stdout      = $outLog"
Write-Host "stderr      = $errLog"
