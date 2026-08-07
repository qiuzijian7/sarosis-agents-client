# VS Sarosis — Windows EXE 打包：依赖安装脚本
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

npm rebuild `
  @parcel/watcher @vscode/native-watchdog @vscode/policy-watcher `
  @vscode/spdlog @vscode/windows-process-tree @vscode/windows-registry `
  @vscode/deviceid @vscode/sqlite3 @vscode/windows-mutex `
  @vscode/windows-ca-certs kerberos native-keymap node-pty `
  windows-foreground-love `
  --foreground-scripts
if ($LASTEXITCODE -ne 0) { Write-Error "FATAL: native rebuild failed"; exit 1 }

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
$extRoots = Get-ChildItem extensions -Directory -Depth 2
foreach ($extDir in $extRoots) {
  if (Test-Path ($extDir.FullName + '/package.json')) {
    Push-Location $extDir.FullName
    npm install --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      Write-Host ('[WARN] ' + $extDir + ' npm install exited ' + $LASTEXITCODE + ' (non-critical)')
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
