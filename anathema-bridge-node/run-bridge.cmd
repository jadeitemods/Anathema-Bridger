@echo off
REM Wrapper so the bridge can be started where .ps1 execution is blocked by policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-bridge.ps1" %*
