# Keeps the bridge and adapter alive.
#
# Started at logon by a shortcut in the Startup folder (see tools/install-autostart.ps1).
# Every 30 seconds it checks both processes and restarts whichever is missing, so a
# crash, a closed window, or a killed process does not silently stop chat.
#
# It checks the listening port for the bridge rather than the process name, because any
# node.exe satisfies "a node is running" but not "the bridge is serving".

$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$logFile = Join-Path $root 'watchdog.log'
$bridgeCmd = Join-Path $root 'anathema-bridge-node\run-bridge.cmd'
$adapterCmd = Join-Path $root 'anathema-bridge-valour\run-adapter.cmd'

function Write-Log([string]$message) {
    $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $message
    Add-Content -Path $logFile -Value $line
    Write-Host $line
}

# Single instance: two watchdogs would race to restart the same process and log noise.
$instanceMutex = New-Object System.Threading.Mutex($false, 'Global\AnathemaBridgerWatchdog')
if (-not $instanceMutex.WaitOne(0)) {
    exit
}

function Test-BridgeUp {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
}

function Test-AdapterUp {
    return [bool](Get-Process AnathemaValourAdapter -ErrorAction SilentlyContinue)
}

Write-Log "watchdog started (root: $root)"

while ($true) {
    if (-not (Test-Path $bridgeCmd)) {
        Write-Log "bridge launcher missing: $bridgeCmd"
    }
    elseif (-not (Test-BridgeUp)) {
        Write-Log 'bridge not listening on 3000 - starting it'
        Start-Process -FilePath $bridgeCmd -WindowStyle Hidden
        Start-Sleep -Seconds 10
    }

    if (-not (Test-Path $adapterCmd)) {
        Write-Log "adapter launcher missing: $adapterCmd"
    }
    elseif (-not (Test-AdapterUp)) {
        Write-Log 'adapter not running - starting it'
        Start-Process -FilePath $adapterCmd -ArgumentList '-TimeoutSeconds', '45' -WindowStyle Hidden
        Start-Sleep -Seconds 10
    }

    Start-Sleep -Seconds 30
}
