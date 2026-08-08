$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

Write-Host "=== Generating Windows EXE installer ==="

# 清理上次构建残留的安装包 exe（构建机杀软可能仍锁定该文件，导致 Inno 重写同名文件时
# EndUpdateResource failed (110)）。仅删除 Inno 产物 VsSarosSetup*.exe，保留暂存的应用本体 (Code.exe 等)。
Get-ChildItem -Path .build\win32-x64 -Recurse -Filter VsSarosSetup*.exe -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue

function Invoke-InnoTask {
  param([string]$Task)
  $max = 3
  for ($i = 1; $i -le $max; $i++) {
    npx gulp $Task --verbose
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host ('[WARN] ' + $Task + ' failed (exit ' + $LASTEXITCODE + '), retry ' + $i + '/' + $max + ' after 10s')
    Start-Sleep -Seconds 10
    Get-ChildItem -Path .build\win32-x64 -Recurse -Filter VsSarosSetup*.exe -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue
  }
  return $false
}

if (-not (Invoke-InnoTask 'vscode-win32-x64-inno-updater'))  { Write-Error "Inno updater setup failed"; exit 1 }
if (-not (Invoke-InnoTask 'vscode-win32-x64-user-setup'))    { Write-Error "User setup failed"; exit 1 }
if (-not (Invoke-InnoTask 'vscode-win32-x64-system-setup'))  { Write-Error "System setup failed"; exit 1 }

Write-Host "=== EXE installers generated ==="
