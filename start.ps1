# Start Qwen Station (ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM).
#   start.ps1              -> load the local model with vision, start the platform, open it in the browser
#   start.ps1 -Workbench   -> also start the AI film workbench and ComfyUI first (launcher path is in config.json)
#   start.ps1 -NoBrowser   -> do not open the browser
param([switch]$Workbench, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'config.json') | ConvertFrom-Json

if ($Workbench) {
    $up = $false
    try { $up = (Invoke-RestMethod -Uri "$($cfg.workbench)/__health" -TimeoutSec 2).ok -eq $true } catch {}
    if ($up) { Write-Host 'Film workbench is already running.' }
    elseif (Test-Path -LiteralPath $cfg.workbenchLauncher) {
        Write-Host 'Starting the film workbench and ComfyUI...'
        & $cfg.workbenchLauncher -NoBrowser
    }
    else { Write-Warning "Workbench launcher not found: $($cfg.workbenchLauncher)" }
}

Write-Host 'Checking the local model (loading can take a few minutes)...'
& (Join-Path $here 'model.ps1') start
if ($LASTEXITCODE -ne 0) { Write-Warning "The model is not loaded (exit code $LASTEXITCODE, where 3 means ComfyUI is busy). Chat needs the model." }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = 'D:\openclaw\runtime\node\node.exe' }
if (-not (Get-NetTCPConnection -LocalPort $cfg.port -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $node -ArgumentList 'station.cjs' -WorkingDirectory $here -WindowStyle Hidden -RedirectStandardOutput (Join-Path $here 'station.log') -RedirectStandardError (Join-Path $here 'station.err.log')
    Start-Sleep -Seconds 2
}
$page = ''
if ($Workbench) { $page = 'studio' }
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$($cfg.port)/$page" }
Write-Host "Qwen Station is ready: http://127.0.0.1:$($cfg.port)/"
Start-Sleep -Seconds 2
