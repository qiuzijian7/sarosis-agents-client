# diag-f5.ps1 - Diagnose "F5 hangs / no window" for the agents dev build.
# Run this in a REAL PowerShell (not inside any Electron-hosted terminal),
# from the repo root:  powershell -ExecutionPolicy Bypass -File scripts\diag-f5.ps1
#
# It launches the exact same runtime F5 uses, but with a clean env and logging
# ON, so any renderer/main crash is printed straight to this console.

$ErrorActionPreference = 'Continue'

Write-Host "=== 0. Kill leftover Code-OSS processes ===" -ForegroundColor Cyan
Get-Process -Name "Code - OSS" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

Write-Host "=== 1. Free leftover ports (9222/5875/8420/8520) ===" -ForegroundColor Cyan
foreach ($p in 9222,5875,8420,8520) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue
  if ($c) { Write-Host "  port $p held by PID $($c.OwningProcess) -> killing"; Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
}

Write-Host "=== 2. Remove stale single-instance markers ===" -ForegroundColor Cyan
$U = Join-Path $env:USERPROFILE ".vscode-oss-agents-dev"
foreach ($f in "DevToolsActivePort","SingletonLock","SingletonCookie","SingletonSocket","code.lock") {
  $fp = Join-Path $U $f
  if (Test-Path $fp) { Remove-Item $fp -Force -ErrorAction SilentlyContinue; Write-Host "  removed $f" }
}

Write-Host "=== 3. Pick runtime exe ===" -ForegroundColor Cyan
$root = (Resolve-Path "$PSScriptRoot\..").Path
$exe  = Join-Path $root ".build\electron\Code - OSS.exe"
if (-not (Test-Path $exe)) { $exe = Join-Path $root ".build\electron-v39.8.8\Code - OSS.exe" }
if (-not (Test-Path $exe)) { Write-Host "NO RUNTIME EXE FOUND under .build" -ForegroundColor Red; exit 1 }
Write-Host "  using: $exe"

Write-Host "=== 4. Clean env that breaks Electron (CRITICAL) ===" -ForegroundColor Cyan
# These leak in when launched from another Electron app and force the exe to run as plain node.
Remove-Item Env:ELECTRON_RUN_AS_NODE       -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue
Remove-Item Env:VSCODE_PID                 -ErrorAction SilentlyContinue
Remove-Item Env:VSCODE_CWD                 -ErrorAction SilentlyContinue
Remove-Item Env:VSCODE_NLS_CONFIG          -ErrorAction SilentlyContinue
Remove-Item Env:VSCODE_CODE_CACHE_PATH     -ErrorAction SilentlyContinue
Remove-Item Env:VSCODE_IPC_HOOK            -ErrorAction SilentlyContinue
$env:VSCODE_DEV = "1"
$env:ELECTRON_ENABLE_LOGGING = "1"
$env:ELECTRON_ENABLE_STACK_DUMPING = "1"

Write-Host "=== 5. LAUNCH (stderr/stdout will print below) ===" -ForegroundColor Green
Write-Host "    If a window appears -> the runtime is fine, problem was env/leftover state."
Write-Host "    If it crashes -> the real error prints right here. Copy ALL of it."
Write-Host "--------------------------------------------------------------------"

& "$exe" "$root" --agents --skip-sessions-welcome `
    --user-data-dir="$U" `
    --no-cached-data `
    --crash-reporter-directory="$root\.profile-oss\crashes" 2>&1 |
  ForEach-Object { Write-Host $_ }

Write-Host "--------------------------------------------------------------------"
Write-Host "=== 6. Exit. If no window showed and no error above, check watch terminal for compile errors. ===" -ForegroundColor Yellow
