# Qwen Station model launcher (ASCII only: Windows PowerShell 5.1 misreads UTF-8 without BOM).
# Starts the same Qwen3.8 27B KVMem server as D:\openclaw\bin\model-mode.ps1 gpu-deep, plus the vision
# projector (mmproj, kept on CPU so it costs no VRAM). It writes the same pid/mode files, so OpenClaw's
# model-mode.ps1 still sees and manages this process. model-mode.ps1 itself is not modified.
#   model.ps1 start   -> make sure the model is running WITH vision (restarts it if it runs without)
#   model.ps1 stop    -> unload local models (delegates to model-mode.ps1 stop)
param([ValidateSet('start', 'stop')][string]$Mode = 'start')
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$oc = 'D:\openclaw'
$modelMode = Join-Path $oc 'bin\model-mode.ps1'
$runtime = Join-Path $oc 'runtime\kvmem-v0.16.0-rc3-cuda13.2.86\kvmem-v0.16.0-rc3-windows-x86_64-cuda13.2.86'
$server = Join-Path $runtime 'bin\llama-kvmem-server.exe'
$model = Join-Path $oc 'models\qwen3.8-27b-gsq-rco\Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf'
$mmproj = Join-Path $here 'models\mmproj-Qwen3.8-27B-Q5_K-MIX.gguf'
$stateDir = Join-Path $oc 'state\model-runtime'
$logDir = Join-Path $oc 'logs'
$port = 8001

function Stop-Models { & powershell -NoProfile -ExecutionPolicy Bypass -File $modelMode stop | Out-Null }
if ($Mode -eq 'stop') { Stop-Models; exit 0 }

function Test-Ready { try { return (Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3).status -eq 'ok' } catch { return $false } }
$pidFile = Join-Path $stateDir 'deep.pid'
if ((Test-Ready) -and (Test-Path -LiteralPath $pidFile)) {
    $running = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int](Get-Content -Raw -LiteralPath $pidFile)) -ErrorAction SilentlyContinue
    if ($running -and $running.CommandLine -like '*--mmproj*') { exit 0 }
}

# Never take the GPU from a running ComfyUI job; when ComfyUI is idle ask it to unload its models first.
foreach ($p in @(8188, 8189)) {
    try {
        $q = Invoke-RestMethod -Uri "http://127.0.0.1:$p/queue" -TimeoutSec 3
        if (@($q.queue_running).Count -gt 0 -or @($q.queue_pending).Count -gt 0) { Write-Error "ComfyUI port $p has an active job; model not started."; exit 3 }
        try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$p/free" -ContentType 'application/json' -Body '{"unload_models":true,"free_memory":true}' -TimeoutSec 15 | Out-Null } catch {}
    } catch {}
}

foreach ($f in @($server, $model, $mmproj)) { if (-not (Test-Path -LiteralPath $f)) { Write-Error "Missing file: $f"; exit 2 } }
Stop-Models
New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null
$serverArgs = @(
    '--model', $model, '--alias', 'qwen3.8-27b-gsq-rco',
    '--mmproj', $mmproj, '--no-mmproj-offload',
    '--host', '127.0.0.1', '--port', "$port",
    '--ctx-size', '184320', '--parallel', '1',
    '--threads', '4', '--threads-batch', '4',
    '--gpu-layers', 'all', '--flash-attn', 'on',
    '--n-predict', '16384', '--batch-size', '512', '--ubatch-size', '128',
    '--cache-type-k', 'q8_0', '--cache-type-v', 'q8_0', '--load-mode', 'mmap',
    '--kvmem-budget', '32768', '--kvmem-gen-reserve', '16384',
    '--kvmem-block-tokens', '128', '--kvmem-query-policy', 'user',
    '--spec-type', 'draft-mtp', '--spec-draft-n-max', '3',
    '--reasoning-effort', 'none', '--timeout', '900',
    '--no-ui', '--verbosity', '3'
)
$started = Start-Process -FilePath $server -ArgumentList $serverArgs -WorkingDirectory $runtime -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'model-gpu-deep.stdout.log') -RedirectStandardError (Join-Path $logDir 'model-gpu-deep.stderr.log') -PassThru
Set-Content -LiteralPath $pidFile -Value $started.Id -Encoding ascii
Set-Content -LiteralPath (Join-Path $stateDir 'deep.mode.txt') -Value 'gpu-deep' -Encoding ascii

$deadline = (Get-Date).AddSeconds(900)
while ((Get-Date) -lt $deadline) {
    if ($started.HasExited) { Write-Error "Model server exited during startup. See $logDir"; exit 4 }
    if (Test-Ready) { exit 0 }
    Start-Sleep -Seconds 2
}
Write-Error 'Model did not become ready in time.'; exit 5
