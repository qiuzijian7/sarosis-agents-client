$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 直接调本地 gulp，绕开 npx（npx 找不到本地包时会交互式询问 "Ok to proceed?"，
# CI 无 stdin 导致无限挂起）。
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'
if (-not (Test-Path $gulp)) { Write-Error "local gulp not found at $gulp"; exit 1 }

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

# ===== 自愈 agent-studio/out 与 node_modules/typescript（2026-08-29 生产事故）=====
# agent-studio 的 out/ 被 .gitignore 排除且 gulp 扩展管线不认识它；typescript 是
# html/css/json 语言服务器运行时依赖。两者若缺失会导致扩展激活失败 / 语言服务器 -32097。
# Inno 打包前兜底自愈：从仓库复制到 VSCode-win32-x64 产物目录。即使前面的 gulp/strip
# 被绕过或构建机复用残留暂存目录，这里也能保证进包。
$appStaging = Join-Path $vsOutRoot "resources\app"
function Copy-ExtIfMissing($rel, $sentinel) {
  $dst = Join-Path $appStaging $rel
  if (Test-Path (Join-Path $dst $sentinel)) { return }
  $src = Join-Path $repoRoot $rel
  if (Test-Path (Join-Path $src $sentinel)) {
    New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null
    Copy-Item -Recurse -Force $src $dst
    Write-Host ("[FIX] " + $rel + " 缺失于打包产物，已从仓库复制")
  } else {
    Write-Host ("[WARN] " + $rel + " 在仓库也缺失（检查 transpile / install-deps）")
  }
}
Copy-ExtIfMissing "extensions\agent-studio\out" "extension.js"
Copy-ExtIfMissing "node_modules\typescript" "package.json"
if (-not (Test-Path (Join-Path $appStaging "extensions\agent-studio\out\extension.js"))) {
  Write-Error "FATAL: extensions\agent-studio\out\extension.js 未进打包产物且无法自愈 - 禁止出包"
  exit 1
}
Write-Host "[OK] agent-studio/out 与 node_modules/typescript 已确认进包 ($appStaging)"

function Invoke-InnoTask {
  param([string]$Task)
  $max = 3
  for ($i = 1; $i -le $max; $i++) {
    & $gulp $Task --verbose
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
