# Registers the watchdog to start at logon, and starts it now.
#
# Uses the per-user Startup folder, so no administrator rights are needed. The watchdog
# itself keeps the bridge and adapter alive after they start.
#
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-autostart.ps1 -Remove

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$watchdog = Join-Path $root 'tools\watchdog.ps1'
$startup = [Environment]::GetFolderPath('Startup')
$shortcut = Join-Path $startup 'Bridger Watchdog.vbs'

if ($Remove) {
    if (Test-Path $shortcut) {
        Remove-Item $shortcut -Force
        Write-Host "removed $shortcut"
    }

    Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -like '*watchdog.ps1*' } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

    Write-Host 'autostart disabled'
    return
}

if (-not (Test-Path $watchdog)) {
    throw "watchdog not found at $watchdog"
}

$launcher = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""$watchdog""", 0, False
"@

Set-Content -Path $shortcut -Value $launcher -Encoding ASCII
Write-Host "installed $shortcut"

# Start it now so we do not have to wait for the next sign-in.
Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -like '*watchdog.ps1*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$shortcut`"" -WindowStyle Hidden
Start-Sleep -Seconds 3

$running = [bool](Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*watchdog.ps1*' })
Write-Host "watchdog running: $running"
Write-Host "log: $(Join-Path $root 'watchdog.log')"
