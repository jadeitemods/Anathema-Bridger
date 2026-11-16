# Starts the Anathema bridge with stdout/stderr redirected to files under logs\.
#
# Same reasoning as the adapter script: the bridge is normally launched by a job
# runner whose captured output disappears when that job closes, leaving no log.
#
# Usage:
#   .\run-bridge.ps1              # background, logs to logs\bridge-<stamp>.log
#   .\run-bridge.ps1 -Foreground  # run in this console

param(
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$entry = Join-Path $root 'index.js'
$logDir = Join-Path $root 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$outLog = Join-Path $logDir "bridge-$stamp.log"
$errLog = Join-Path $logDir "bridge-$stamp.err.log"

# Clear any previous listener on the bridge ports (3000 ws, 3001 valour ingress).
$ports = 3000, 3001
$stale = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -in $ports } |
    Select-Object -ExpandProperty OwningProcess -Unique
foreach ($id in $stale) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
if ($stale) { Start-Sleep -Milliseconds 500 }

if ($Foreground) {
    # index.js loads .env from the working directory, so run from the project root.
    Push-Location $root
    try {
        & node $entry
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

$proc = Start-Process -FilePath 'node' -ArgumentList "`"$entry`"" `
    -WorkingDirectory $root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru -WindowStyle Hidden

Write-Host "bridge pid = $($proc.Id)"
Write-Host "stdout     = $outLog"
Write-Host "stderr     = $errLog"
