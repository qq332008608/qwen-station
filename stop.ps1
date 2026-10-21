# Stop Qwen Station (ASCII only). Stops the platform and its headless browser, and unloads the local model to free the GPU.
# The film workbench and ComfyUI are left running; close them with their own window or launcher.
$ErrorActionPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$cfg = Get-Content -Raw -Encoding UTF8 (Join-Path $here 'config.json') | ConvertFrom-Json
foreach ($port in @($cfg.port, 18801)) {
    Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }
}
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'model.ps1') stop
Write-Host 'Qwen Station stopped and the local model unloaded.'
Start-Sleep -Seconds 2
