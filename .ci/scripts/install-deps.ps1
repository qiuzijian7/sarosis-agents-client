# VS Saros — Windows EXE 打包：依赖安装脚本
# 该脚本由 .ci/package-win-exe.yml 的「安装依赖 (npm ci)」步骤通过
#   powershell -ExecutionPolicy Bypass -File .ci/scripts/install-deps.ps1
# 调用。抽离为独立文件可彻底避免蓝盾 PAC 对 inline script 的 PowerShell 内容转换 bug。

# 确保工作目录为仓库根（脚本位于 .ci/scripts/，上溯两级即仓库根）
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# ===== 1. Node =====
$nodeVersion = "22.22.1"
if (-not (nvm list 2>$null | Select-String $nodeVersion)) { nvm install $nodeVersion }
nvm use $nodeVersion
node --version

# ===== 2. Cleanup =====
cmd /c "rd /s /q node_modules 2>nul"
cmd /c "rd /s /q build\node_modules 2>nul"

# extensions/*/node_modules 此前【从不清理】，而蓝盾工作区跨次构建复用（E:\data\landun\workspace），
# 于是历次失败/中断的 npm install 残骸永久累积。2026-09-07 事故实证：
#   extensions\css-language-features\node_modules\balanced-match\node_modules\@shikijs\langs\dist\*.mjs
# balanced-match 是零依赖的几十行 tiny 包，本仓库任何 package.json / package-lock.json 都不含
# shiki（已 git grep 验证为 0 命中）——纯属陈年残骸。@shikijs/langs 单包就有 200+ 个 .mjs，
# 被 gulp 扩展流当作扩展内容遍历读取，直接把 Windows CRT 句柄打爆 → EMFILE。
# 这也解释了为何 build/lib/extensions.ts 里的 graceful-fs 加固没能救回来：graceful-fs 只能在
# 句柄紧张时排队重试，扛不住「凭空多出上万个本不该存在的文件」这种量级。
# 逐个 rd 而非整体删 extensions（扩展源码在版本控制内，node_modules 不在），保持可重入。
Write-Host '=== Cleaning stale extensions/*/node_modules (workspace is reused across builds) ==='
$staleCount = 0
foreach ($d in (Get-ChildItem extensions -Directory -Recurse -Depth 2 -Filter 'node_modules' -EA SilentlyContinue)) {
  cmd /c ('rd /s /q "' + $d.FullName + '" 2>nul')
  if (-not (Test-Path $d.FullName)) { $staleCount++ }
}
cmd /c "rd /s /q extensions\node_modules 2>nul"
Write-Host ('[clean] removed ' + $staleCount + ' extensions node_modules dirs')

# ===== 3. Install Spectre =====
$vsPath = "C:\Program Files\Microsoft Visual Studio\2022\Community"
$vsInstaller = "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vs_installer.exe"
$latestMsvc = Get-ChildItem ($vsPath + '\VC\Tools\MSVC') -Directory -EA SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
if ($latestMsvc -and -not (Test-Path ($vsPath + '\VC\Tools\MSVC\' + $latestMsvc.Name + '\lib\spectre\x64\libcmt.lib'))) {
  Write-Host "=== Installing Spectre Libraries ==="
  & $vsInstaller modify --installPath $vsPath --quiet --norestart `
    --add Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre `
    --add Microsoft.VisualStudio.Component.VC.ATL.Spectre `
    --add Microsoft.VisualStudio.Component.VC.MFC.Spectre 2>&1 | Out-Null
}
$vsMsvcDir = $vsPath + '\VC\Tools\MSVC\14.38.33130'
Remove-Item -Recurse -Force $vsMsvcDir -ErrorAction SilentlyContinue

# ===== 4. Env vars for Electron native build =====
$env:GYP_MSVS_VERSION      = "2022"
$env:npm_config_target     = "39.8.8"
$env:npm_config_runtime    = "electron"
$env:npm_config_disturl    = "https://electronjs.org/headers"
$env:npm_config_arch       = "x64"
$env:npm_config_target_arch = "x64"
$env:npm_config_build_from_source = "true"
$env:npm_config_registry   = "https://registry.npmmirror.com/"
$env:ELECTRON_MIRROR       = "https://npmmirror.com/mirrors/electron/"

# ===== 5. Install root dependencies =====
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Error "FATAL: npm install --ignore-scripts failed"; exit 1 }

# node-gyp 的 VS 探测（powershell + Add-Type 编译 Find-VisualStudio.cs）在构建机上偶发失败：
# 同一次 rebuild 里前两个包刚 "find VS using VS2022" 成功，下一个包就报
# "could not use PowerShell to find Visual Studio 2017 or newer"，整条 npm rebuild 随之中止。
# 该失败一旦发生，脚本 exit 1 → 后续 build/ 依赖、扩展依赖、ripgrep 全部跳过，
# 而流水线不会因此中断，白跑 30 分钟编译后在 compile-extensions 报 Cannot find module '@vscode/vsce'
# （2026-09-07 事故）。因此这里按重试处理（npm rebuild 幂等，已成功的包会被跳过/快速重建）。
$env:npm_config_msvs_version = "2022"
$nativeOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
  npm rebuild `
    @parcel/watcher @vscode/native-watchdog @vscode/policy-watcher `
    @vscode/spdlog @vscode/windows-process-tree @vscode/windows-registry `
    @vscode/deviceid @vscode/sqlite3 @vscode/windows-mutex `
    @vscode/windows-ca-certs kerberos native-keymap node-pty `
    windows-foreground-love `
    --foreground-scripts
  if ($LASTEXITCODE -eq 0) { $nativeOk = $true; break }
  Write-Host ('[WARN] native rebuild attempt ' + $attempt + ' failed (exit ' + $LASTEXITCODE + '), retrying in 15s...')
  Start-Sleep -Seconds 15
}
if (-not $nativeOk) { Write-Error "FATAL: native rebuild failed after 3 attempts"; exit 1 }

# ===== 5.4 @vscode/tree-sitter-wasm 显式保障（语法高亮 wasm 打包必需）=====
# 背景：蓝盾构建机 npm install 偶发漏装该包，导致打包产物 resources/app/node_modules/
# @vscode/tree-sitter-wasm 缺失，运行时 vscode.git / 实验性 tree-sitter 高亮报
# "Failed to load resource: net::ERR_FILE_NOT_FOUND"。
$treeSitterJs = "node_modules\@vscode\tree-sitter-wasm\wasm\tree-sitter.js"
if (-not (Test-Path $treeSitterJs)) {
  Write-Host "[FIX] @vscode/tree-sitter-wasm 缺失，从 registry 显式安装..."
  npm install @vscode/tree-sitter-wasm@0.3.1 --ignore-scripts --no-save --no-fund --no-audit
  if ($LASTEXITCODE -ne 0) { Write-Error "FATAL: @vscode/tree-sitter-wasm install failed"; exit 1 }
}
if (-not (Test-Path $treeSitterJs)) {
  Write-Error "FATAL: @vscode/tree-sitter-wasm wasm\tree-sitter.js 缺失 - 语法高亮 wasm 不可用"
  exit 1
}
$tswWasmCount = (Get-ChildItem "node_modules\@vscode\tree-sitter-wasm\wasm" -Filter *.wasm -EA SilentlyContinue).Count
Write-Host ('[OK] @vscode/tree-sitter-wasm present (' + $tswWasmCount + ' wasm files)')

# ===== 5.5 @vscode/sqlite3 vendored fallback (图谱 SQLite 后端必需) =====
$sqliteNode = "node_modules\@vscode\sqlite3\build\Release\vscode-sqlite3.node"
if (-not (Test-Path $sqliteNode)) {
  $vendoredSqlite = "build\saros\bin\vscode-sqlite3.node"
  if (Test-Path $vendoredSqlite) {
    New-Item -ItemType Directory -Force -Path (Split-Path $sqliteNode) | Out-Null
    Copy-Item $vendoredSqlite $sqliteNode -Force
    Write-Host "[FIX] @vscode/sqlite3 native restored from vendored"
  }
}
if (-not (Test-Path $sqliteNode)) {
  Write-Error "FATAL: @vscode/sqlite3 native binary missing - 图谱 SQLite 后端不可用"
  exit 1
}
$sqliteSize = (Get-Item $sqliteNode).Length
Write-Host ('[OK] @vscode/sqlite3 present ' + $sqliteSize + ' bytes')

if (-not (Test-Path "node_modules\gulp\bin\gulp.js")) {
  Write-Error "FATAL: node_modules/gulp not found after npm install + rebuild"
  exit 1
}
Write-Host "[OK] node_modules/gulp found"

# ===== 6. Install build/ dependencies =====
Push-Location build
npm install --ignore-scripts
if ($LASTEXITCODE -ne 0) { Write-Error "FATAL: build/ npm install failed"; exit 1 }

# FIX: tree-sitter binding.gyp forces /std:c++17, but Node 39.8.8 requires C++20
$tsGyp = "node_modules\tree-sitter\binding.gyp"
if (Test-Path $tsGyp) {
  $gypContent = Get-Content $tsGyp -Raw
  $gypContent = $gypContent -replace '/std:c\+\+17', '/std:c++20'
  [System.IO.File]::WriteAllText((Resolve-Path $tsGyp), $gypContent, (New-Object System.Text.UTF8Encoding $false))
  Write-Host "[FIX] tree-sitter binding.gyp patched: /std:c++17 -> /std:c++20"
}

# FIX: only rebuild tree-sitter (avoids triggering ripgrep postinstall -> 403)
npm rebuild tree-sitter --foreground-scripts
if ($LASTEXITCODE -ne 0) { Write-Error "FATAL: build/ tree-sitter rebuild failed"; exit 1 }
Pop-Location

# ===== 7. ripgrep (postinstall -> vendored 兜底，缺则 fail) =====
$mainRg = "node_modules\@vscode\ripgrep\bin\rg.exe"
if (-not (Test-Path $mainRg)) {
  Write-Host "[RG] Trying postinstall (GitHub CDN)..."
  try {
    node node_modules/@vscode/ripgrep/lib/postinstall.js --force
  } catch { Write-Host ('[RG] postinstall failed: ' + $_) }
}
$vendoredRg = "build/saros/bin/rg.exe"
if (-not (Test-Path $mainRg) -and (Test-Path $vendoredRg)) {
  New-Item -Force -ItemType Directory (Split-Path $mainRg) | Out-Null
  Copy-Item $vendoredRg $mainRg -Force
  Write-Host "[RG] Restored from vendored build/saros/bin/rg.exe"
}
if (-not (Test-Path $mainRg)) {
  Write-Error "rg.exe unavailable. Refusing to package without ripgrep."
  exit 1
}

# ===== 8. Install extension dependencies =====
# 原写法 `Get-ChildItem extensions -Directory -Depth 2` 会递归进 node_modules：
# extensions\<ext>\node_modules\<pkg> 的深度【正好是 2】，于是脚本把上千个 npm 包目录
# 当成扩展逐个执行 npm install（2026-09-07 日志里成片的
# "[WARN] commander/katex/d3-array/stylis/mlly/ufo/agent-base npm install exited 1" 即是此因，
# 它们全是 npm 包而非扩展）。这些越权 install 正是 extensions/*/node_modules 里
# balanced-match\node_modules\@shikijs 这类脏依赖的来源——直接导致 gulp 遍历时 EMFILE。
# 同时 out/ 是编译产物，其 package.json 是构建脚本写入的 {"type":"commonjs"}，对它 install 同样有害。
$extRoots = Get-ChildItem extensions -Directory -Recurse -Depth 2 -EA SilentlyContinue |
  Where-Object { $_.FullName -notmatch '\\node_modules(\\|$)' -and $_.FullName -notmatch '\\(out|dist)(\\|$)' }
foreach ($extDir in $extRoots) {
  if (Test-Path ($extDir.FullName + '/package.json')) {
    Push-Location $extDir.FullName
    npm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      Write-Host ('[WARN] ' + $extDir.FullName + ' npm install exited ' + $LASTEXITCODE + ' (non-critical)')
    }
    Pop-Location
  }
}
Write-Host "[OK] Extension dependencies installed"

# ===== 8b. Install .vscode/extensions dependencies =====
if (Test-Path ".vscode/extensions") {
  $vscExtRoots = Get-ChildItem .vscode/extensions -Directory
  foreach ($extDir in $vscExtRoots) {
    if (Test-Path ($extDir.FullName + '/package.json')) {
      Push-Location $extDir.FullName
      npm install --ignore-scripts
      if ($LASTEXITCODE -ne 0) {
        Write-Host ('[WARN] ' + $extDir + ' npm install exited ' + $LASTEXITCODE + ' (non-critical)')
      }
      Pop-Location
    }
  }
  Write-Host "[OK] .vscode/extensions dependencies installed"
}

# ===== 8c. Hoist typescript to extensions/node_modules =====
$extTsTarget = "extensions\node_modules\typescript"
$rootTs = "node_modules\typescript"
if ((Test-Path $rootTs) -and -not (Test-Path $extTsTarget)) {
  New-Item -Force -ItemType Directory "extensions\node_modules" | Out-Null
  $resolvedRootTs = (Resolve-Path $rootTs).Path
  New-Item -ItemType Junction -Path $extTsTarget -Target $resolvedRootTs -Force 2>&1 | Out-Null
  if (-not (Test-Path ($extTsTarget + '\lib\typescript.d.ts'))) {
    Write-Host "[INFO] junction failed, falling back to copy"
    Copy-Item -Recurse -Force $rootTs $extTsTarget
  }
  Write-Host ('[FIX] typescript hoisted to ' + $extTsTarget)
}

# ===== 8d. Agent Studio webview dependencies (katex 等，kbblocks 构建必需) =====
$webviewDir = "src\vs\sessions\contrib\agentStudio\webview"
if (Test-Path ($webviewDir + '\package.json')) {
  Push-Location $webviewDir
  npm install --ignore-scripts
  if ($LASTEXITCODE -ne 0) {
    Write-Host ('[WARN] ' + $webviewDir + ' npm install exited ' + $LASTEXITCODE + ' (non-critical)')
  }
  Pop-Location
  Write-Host "[OK] Agent Studio webview dependencies installed"
}
