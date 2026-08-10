$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

Write-Host "=== Generating Windows EXE installer ==="

# 清理上次构建残留的安装包 exe（构建机杀软可能仍锁定该文件，导致 Inno 重写同名文件时
# EndUpdateResource failed (110)）。仅删除 Inno 产物 VsSarosSetup*.exe，保留暂存的应用本体 (Code.exe 等)。
Get-ChildItem -Path .build\win32-x64 -Recurse -Filter VsSarosSetup*.exe -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue

# ===== 校验 @vscode/tree-sitter-wasm 已进打包产物（语法高亮 wasm）=====
# 构建机 npm install 偶发漏装该包 -> gulp 依赖流不进包 -> 运行时 tree-sitter.js 404。
# 在 Inno 打包前自愈：从仓库 node_modules 复制到 VSCode-win32-x64 产物目录。
$vsOutRoot = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"
$buildTsw = Join-Path $vsOutRoot "resources\app\node_modules\@vscode\tree-sitter-wasm"
$repoTsw  = Join-Path $repoRoot "node_modules\@vscode\tree-sitter-wasm"
$tswKey = "wasm\tree-sitter.js"
if (-not (Test-Path (Join-Path $buildTsw $tswKey))) {
  if (Test-Path (Join-Path $repoTsw $tswKey)) {
    Write-Host "[FIX] tree-sitter-wasm 缺失于打包产物，从仓库 node_modules 复制..."
    New-Item -ItemType Directory -Force -Path (Split-Path $buildTsw) | Out-Null
    Copy-Item -Recurse -Force $repoTsw $buildTsw
    Write-Host "[OK] tree-sitter-wasm 已复制到 $buildTsw"
  } else {
    Write-Host "[WARN] tree-sitter-wasm 在仓库 node_modules 也缺失（检查 install-deps.ps1 的 5.4 节）"
  }
}
if (-not (Test-Path (Join-Path $buildTsw $tswKey))) {
  Write-Error "FATAL: @vscode/tree-sitter-wasm 未进打包产物且无法自愈 - 语法高亮 wasm 缺失，禁止出包"
  exit 1
}
Write-Host "[OK] @vscode/tree-sitter-wasm 已确认进包 ($buildTsw)"

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
