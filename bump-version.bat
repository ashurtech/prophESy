@echo off
REM Bump the version in package.json (patch by default)
setlocal
set FILE=package.json
set TMP=package.tmp.json

REM Use PowerShell to bump the version
powershell -Command "(Get-Content %FILE% | Out-String | ConvertFrom-Json).version -replace '(\d+\.\d+\.)(\d+)', {param($m) ($m.Groups[1].Value) + ([int]$m.Groups[2].Value + 1)} | Out-Null; $p = Get-Content %FILE% | Out-String | ConvertFrom-Json; $v = $p.version -split '\.'; $v[-1] = [string]([int]$v[-1] + 1); $p.version = $v -join '.'; $p | ConvertTo-Json -Depth 10 | Set-Content %TMP%"
move /Y %TMP% %FILE% >nul

echo Version bumped in package.json.
