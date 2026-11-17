<#
  VTube Pro - what "Stop VTube Pro.cmd" runs. Stops ONLY the server this folder started (the PID saved in
  .setup-state\server.pid by "Start VTube Pro" or setup.ps1 -Detach), after checking it is still that very process
  (same start time, a node process running server/index.ts or the bundled dist-helper/index.mjs). Never stops anything by name or by port.
  Keep this file ASCII-only (Windows PowerShell 5.1).
#>
$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$State = Join-Path $Root '.setup-state'
$PidFile = Join-Path $State 'server.pid'
$InfoFile = Join-Path $State 'server.json'

function Forget { foreach ($f in @($PidFile, $InfoFile)) { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force } } }

Write-Host ''
Write-Host '  VTube Pro' -ForegroundColor Magenta
if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Host '   VTube Pro is not running from this folder (nothing to stop).' -ForegroundColor Gray
  Write-Host '   If you started it with START.bat or npm, close that window instead.' -ForegroundColor DarkGray
  exit 0
}
$id = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$id)) { Forget; Write-Host '   Nothing to stop.' -ForegroundColor Gray; exit 0 }
$p = Get-Process -Id $id -ErrorAction SilentlyContinue
$ours = [bool]$p
if ($ours -and (Test-Path -LiteralPath $InfoFile)) {
  try {
    $info = Get-Content -LiteralPath $InfoFile -Raw | ConvertFrom-Json
    if ([int]$info.pid -eq $id -and [string]$info.started -and [string]$info.started -ne [string]$p.StartTime.ToFileTimeUtc()) { $ours = $false }
  } catch { }
}
if ($ours) {
  $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
  if (-not $cim -or "$($cim.CommandLine)" -notmatch '(server[\\/]index\.ts|dist-helper[\\/]index\.mjs)') { $ours = $false }
}
if (-not $ours) {
  Forget
  Write-Host '   VTube Pro had already stopped (nothing to stop).' -ForegroundColor Gray
  exit 0
}
# /T: also the helper programs VTube Pro itself started (GPU tracking sidecars), which belong to it
& taskkill /PID $id /T /F | Out-Null
Start-Sleep -Milliseconds 400
if (Get-Process -Id $id -ErrorAction SilentlyContinue) {
  Write-Host "   Could not stop VTube Pro (process $id). Restarting the PC also stops it." -ForegroundColor Yellow
  exit 1
}
Forget
Write-Host "   [ok] VTube Pro stopped (process $id)." -ForegroundColor Green
Write-Host '   Start it again any time with "Start VTube Pro".' -ForegroundColor DarkGray
exit 0
