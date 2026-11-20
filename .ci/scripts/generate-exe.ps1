$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot
$vsOutRoot = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"

foreach ($report in @('.build/pack-reports/installers.json', '.build/pack-reports/uploads.json', '.build/pack-reports/installer-comparison.json')) {
  if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force -ErrorAction Stop }
}
foreach ($installer in @('.build/win32-x64/user-setup/VsSarosUserSetup.exe', '.build/win32-x64/system-setup/VsSarosSetup.exe')) {
  if (Test-Path -LiteralPath $installer) { Remove-Item -LiteralPath $installer -Force -ErrorAction Stop }
}

Write-Host "=== EXE preflight: seed / staging / model ==="
node build/saros/pack-optimization.mjs --check-seed
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Bundled seed preflight failed; EXE generation aborted" -ForegroundColor Red; exit 1 }
node build/saros/pack-optimization.mjs --check-staging $vsOutRoot
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Staging build identity preflight failed; EXE generation aborted" -ForegroundColor Red; exit 1 }
node build/saros/pack-optimization.mjs --check-model $vsOutRoot
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Whisper model policy preflight failed; EXE generation aborted" -ForegroundColor Red; exit 1 }
$verifyReceipt = '.build/pack-reports/staging-verified.json'
if (-not (Test-Path -LiteralPath $verifyReceipt)) { Write-Host "[ERROR] verify-staging did not complete; EXE generation aborted" -ForegroundColor Red; exit 1 }
try { $verified = Get-Content -LiteralPath $verifyReceipt -Raw -Encoding utf8 | ConvertFrom-Json } catch { Write-Host "[ERROR] Invalid staging verification receipt" -ForegroundColor Red; exit 1 }
$currentCommit = (git rev-parse HEAD).Trim()
$currentVersion = (Get-Content product.json -Raw -Encoding utf8 | ConvertFrom-Json).version
$currentMode = (node build/saros/pack-optimization.mjs --mode).Trim()
if ($LASTEXITCODE -ne 0 -or $verified.schemaVersion -ne 1 -or $verified.commit -ne $currentCommit -or $verified.productVersion -ne $currentVersion -or $verified.packMode -ne $currentMode) {
  Write-Host "[ERROR] Staging verification receipt is stale or for another build" -ForegroundColor Red
  exit 1
}

# 直接调本地 gulp，绕开 npx（npx 找不到本地包时会交互式询问 "Ok to proceed?"，
# CI 无 stdin 导致无限挂起）。
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'
if (-not (Test-Path $gulp)) { Write-Error "local gulp not found at $gulp"; exit 1 }

Write-Host "=== Generating Windows EXE installer ==="

function Assert-SetupAssets($Assets, [int]$ExpectedCount, [string]$Label) {
  $items = @($Assets)
  if ($items.Count -ne $ExpectedCount) { throw "$Label must contain $ExpectedCount installer targets (actual $($items.Count))" }
  foreach ($asset in $items) {
    if (@('user', 'system') -notcontains $asset.target) { throw "$Label has invalid target: $($asset.target)" }
    if (@('win32-x64-user', 'win32-x64') -notcontains $asset.platform) { throw "$Label has invalid platform: $($asset.platform)" }
    if ([string]::IsNullOrWhiteSpace($asset.rel) -or $asset.rel -notlike '.build/win32-x64/*/*.exe') { throw "$Label has invalid installer path: $($asset.rel)" }
  }
}

$expectedTargetCount = 2
if ($env:SAROS_SETUP_TARGETS -eq 'user' -or $env:SAROS_SETUP_TARGETS -eq 'system') { $expectedTargetCount = 1 }
$assetsJson = node build/saros/pack-optimization.mjs --targets-json
if ($LASTEXITCODE -ne 0) { Write-Error "Invalid packaging policy"; exit 1 }
try { $setupAssets = ConvertFrom-Json -InputObject ($assetsJson -join "`n") } catch { Write-Host "[ERROR] Invalid installer target JSON: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
Assert-SetupAssets $setupAssets $expectedTargetCount 'Selected targets'
$allAssetsJson = node build/saros/pack-optimization.mjs --all-targets-json
if ($LASTEXITCODE -ne 0) { Write-Error "Invalid packaging policy"; exit 1 }
try { $allSetupAssets = ConvertFrom-Json -InputObject ($allAssetsJson -join "`n") } catch { Write-Host "[ERROR] Invalid all-target JSON: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
Assert-SetupAssets $allSetupAssets 2 'All targets'
function Remove-InstallerArtifact([string]$RelativePath) {
  if (Test-Path -LiteralPath $RelativePath) { Remove-Item -LiteralPath $RelativePath -Force -ErrorAction Stop }
}
Remove-InstallerArtifact '.build/pack-reports/installers.json'
foreach ($asset in $allSetupAssets) { Remove-InstallerArtifact $asset.rel }
Write-Host "=== Packaging policy regression tests (120s per-test timeout) ==="
node --test --test-timeout=120000 --test-concurrency=1 build/saros/pack-optimization.test.mjs build/saros/release-assets.test.mjs dsh-plugins/vssaros-web-content-import/test/whisperModel.test.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "Packaging policy regression tests failed"; exit 1 }

# ===== 校验 @vscode/tree-sitter-wasm 已进打包产物（语法高亮 wasm）=====
# 构建机 npm install 偶发漏装该包 -> gulp 依赖流不进包 -> 运行时 tree-sitter.js 404。
# 在 Inno 打包前自愈：从仓库 node_modules 复制到 VSCode-win32-x64 产物目录。
$vsOutRoot = Join-Path (Split-Path $repoRoot) "VSCode-win32-x64"
node build/saros/pack-optimization.mjs --check-staging $vsOutRoot
if ($LASTEXITCODE -ne 0) { Write-Error "Staging was not built successfully for this commit; installer generation aborted"; exit 1 }
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
# ★ 2026-10-29：`@vscode/deviceid` 缺失 —— 产物里没有它时，用户机器上每次启动都会打一条
#   `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vscode/deviceid' imported from …/out/main.js`
#   （设备标识链降级）。`strip-before-pack.mjs` 里本来有补回，但那条在 `package-vscode.ps1` 阶段，
#   而这一步才是**紧挨着 iscc 的最后一道**⇒ 在这里再兜一次（幂等：存在就跳过）。
Copy-ExtIfMissing "node_modules\@vscode\deviceid" "dist\index.js"
if (-not (Test-Path (Join-Path $appStaging "node_modules\@vscode\deviceid\dist\index.js"))) {
  Write-Error "FATAL: @vscode/deviceid 未进打包产物且无法自愈 - 设备标识链会降级，禁止出包"
  exit 1
}
Write-Host "[OK] @vscode/deviceid 已确认进包 ($appStaging\node_modules\@vscode\deviceid)"
if (-not (Test-Path (Join-Path $appStaging "extensions\agent-studio\out\extension.js"))) {
  Write-Error "FATAL: extensions\agent-studio\out\extension.js 未进打包产物且无法自愈 - 禁止出包"
  exit 1
}
Write-Host "[OK] agent-studio/out 与 node_modules/typescript 已确认进包 ($appStaging)"

# ===== 校验 **内置 dsh 运行时** 已进打包产物（2026-10-16 生产事故）=====
# 现场：CI 上 prepack 崩在"裁剪 LibreOffice 内核"（ENOTEMPTY）⇒ 打包链在 gulp 之前中止 ⇒
# 这份暂存目录还是**上一次运行留下的**（不含 dsh-runtime）⇒ 上传的安装包装完首启弹
# 「需要准备 DeepSeek Harness 运行环境」，用户看到的正是"仍然无法找到 dsh"✗✗。
# 为什么这里必须自己判：BK 流水线配的是"前面插件失败也继续跑"，所以 verify-staging.ps1 红了**拦不住**
# 后面的步骤；而 Inno 任务一旦跑完就会产出/上传安装包 ⇒ 必须在**调用 Inno 之前**硬拦（exit 1 时
# 上面第 9–11 行已经把旧的 VsSarosSetup*.exe 删了 ⇒ 上传步骤无物可传，不会又发一份坏包 ✓）。
# 判据与运行时解析同源：<appPath>/dsh-runtime/<bundled>/node_modules/@deepseek-ai/dsh/lib/bin.js
$compatFile = Join-Path $repoRoot "dsh-plugins\dsh-compat.json"
if (-not (Test-Path $compatFile)) {
  Write-Error "FATAL: 找不到 dsh-plugins\dsh-compat.json（无法确定该内置哪个 dsh 版本）"
  exit 1
}
$bundledDsh = (Get-Content $compatFile -Raw -Encoding utf8 | ConvertFrom-Json).bundled
if ([string]::IsNullOrWhiteSpace($bundledDsh)) {
  Write-Error "FATAL: dsh-compat.json 的 bundled 字段为空"
  exit 1
}
$dshRuntimeBin = Join-Path $appStaging "dsh-runtime\$bundledDsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $dshRuntimeBin)) {
  Write-Error ("FATAL: 打包产物缺内置 dsh 运行时（$dshRuntimeBin）—— 装完首启会弹「需要准备 DeepSeek Harness 运行环境」，禁止出包。" + [Environment]::NewLine + "       先跑 node build/prepack-dsh-runtime.mjs（两个打包入口都会自动跑；prepack 失败时看它自己的日志）")
  exit 1
}
Write-Host "[OK] 内置 dsh 运行时 $bundledDsh 已确认进包 ($appStaging\dsh-runtime)"

function Invoke-InnoTask {
  param([string]$Task)
  $max = 3
  for ($i = 1; $i -le $max; $i++) {
    & $gulp $Task --verbose | Out-Host
    if ($LASTEXITCODE -eq 0) { return $true }
    Write-Host ('[WARN] ' + $Task + ' failed (exit ' + $LASTEXITCODE + '), retry ' + $i + '/' + $max + ' after 10s')
    Start-Sleep -Seconds 10
    foreach ($asset in $setupAssets) {
      if ($Task -eq ('vscode-win32-x64-' + $asset.target + '-setup')) { Remove-InstallerArtifact $asset.rel }
    }
  }
  return $false
}

# ★★ 2026-10-29：**产物内容门禁 —— 放在 iscc 之前的最后一道**。
#   为什么必须有（真机）：CI 打出来的包在别人机器上缺 `@vscode/deviceid`
#   （`Error [ERR_MODULE_NOT_FOUND] … imported from …/out/main.js`）。
#   清单从 `build/saros/strip-before-pack.mjs` 的 ensureDir/ensureFile 调用**自动推导**（单一真相源），
#   缺一件就 exit 1 ⇒ **带病的包出不去**（这是"缺件溜到用户手上"的最后一道闸）。
#   ⚠ 用 `$vsOutRoot`（就是 iscc 的源）：目录明确、不靠猜。
Write-Host "=== 产物内容门禁（iscc 之前）==="
node build/saros/check-pack-contents.mjs $vsOutRoot
if ($LASTEXITCODE -ne 0) {
  Write-Error "FATAL: 产物内容门禁未通过 —— 禁止出包（见上面的缺失清单）"
  exit 1
}
Write-Host "[OK] 产物内容门禁通过"

node build/saros/pack-optimization.mjs --check-model $vsOutRoot
if ($LASTEXITCODE -ne 0) { Write-Error "Whisper model packaging policy mismatch"; exit 1 }
node build/saros/pack-optimization.mjs --audit $vsOutRoot --clean
if ($LASTEXITCODE -ne 0) { Write-Error "Staging optimization failed"; exit 1 }
node build/saros/check-pack-contents.mjs $vsOutRoot
if ($LASTEXITCODE -ne 0) { Write-Error "Staging content gate failed after cleanup"; exit 1 }

if (-not (Invoke-InnoTask 'vscode-win32-x64-inno-updater')) { Write-Error "Inno updater setup failed"; exit 1 }
foreach ($asset in $setupAssets) {
  if (-not (Invoke-InnoTask ('vscode-win32-x64-' + $asset.target + '-setup'))) {
    foreach ($candidate in $allSetupAssets) { Remove-InstallerArtifact $candidate.rel }
    Write-Error ($asset.target + " setup failed"); exit 1
  }
}
node build/saros/pack-optimization.mjs --record-exes $vsOutRoot
if ($LASTEXITCODE -ne 0) {
  foreach ($asset in $allSetupAssets) { Remove-InstallerArtifact $asset.rel }
  Write-Error "Installer size gate failed; artifacts removed to prevent upload"; exit 1
}
Write-Host "=== EXE installers generated ==="
