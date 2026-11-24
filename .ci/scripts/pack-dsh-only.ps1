# pack-dsh-only.ps1 — 插件级快包编排（只改 dsh-plugins/ 时复用已有暂存目录）
#
# 前提：本机/本构建机上有一次**成功全量构建**留下的 ../VSCode-win32-x64/ 与
#   .build/pack-reports/staging-build.json，并在那之后跑过一次本脚本 -InitBaseline。
#
# 用法：
#   powershell -File .ci/scripts/pack-dsh-only.ps1 -InitBaseline   # 全量基线成功后调用一次
#   powershell -File .ci/scripts/pack-dsh-only.ps1                  # 之后每次只改插件时调用
#   powershell -File .ci/scripts/pack-dsh-only.ps1 -Only vssaros-chat-surface,vssaros-bridge
#
# 硬门（任一不满足即拒绝出包，防止「新版本号 + 旧内核」的坏包）：
#   1) git diff 相对基线只允许 dsh-plugins/**；
#   2) product.json 版本 / SAROS_PACK_MODE / 媒体与 Office 开关必须与基线一致；
#   3) staging 里所有内核哨兵的 sha256 必须与基线快照一致；
#   4) 后续的 --check-seed / verify-staging / check-pack-contents / --record-exes 一个都不跳过。
#
# ⚠ PowerShell 5.1（Windows Server 2016 构建机）兼容：不用 Join-Path 三参数、不用 -AsHashtable。

param(
    [switch]$InitBaseline,
    [string]$Target = 'user',
    [string]$Only = '',
    [switch]$SkipSeed
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot
$staging = Join-Path (Split-Path $repoRoot) 'VSCode-win32-x64'
$reports = Join-Path $repoRoot '.build\pack-reports'
$baselineFile = Join-Path $reports 'quick-baseline.json'
$recordFile = Join-Path $reports 'staging-build.json'

function Write-Json([string]$Path, [object]$Value) {
    $json = ($Value | ConvertTo-Json -Depth 8) + "`n"
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Get-RepoPluginVersions {
    $map = @{}
    foreach ($dir in Get-ChildItem -LiteralPath (Join-Path $repoRoot 'dsh-plugins') -Directory) {
        $manifest = Join-Path $dir.FullName 'package.json'
        if (Test-Path -LiteralPath $manifest) {
            $pkg = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
            if ($pkg.name) { $map[[string]$pkg.name] = [string]$pkg.version }
        }
    }
    return $map
}

function Get-PackMode {
    return (node build/saros/pack-optimization.mjs --mode | Out-String).Trim()
}

function Assert-Exit([string]$Label) {
    if ($LASTEXITCODE -ne 0) { throw "$Label 失败（exit $LASTEXITCODE）" }
}

function Write-BaselineSnapshot {
    param([string]$Commit, [object]$Record, [hashtable]$Plugins, [string]$PackMode)
    $snapshot = [ordered]@{
        schemaVersion  = 1
        commit         = $Commit
        productVersion = $Record.productVersion
        packMode       = $PackMode
        staging        = (Resolve-Path -LiteralPath $staging).Path
        files          = @($Record.files | ForEach-Object { [ordered]@{ path = $_.path; sha256 = $_.sha256 } })
        plugins        = $Plugins
        env            = [ordered]@{
            mediaMode  = [string]$env:SAROS_MEDIA_MODE
            skipOffice = [string]$env:VSSAROS_SKIP_OFFICE_RUNTIME
        }
        createdAt      = (Get-Date).ToUniversalTime().ToString('o')
    }
    Write-Json $baselineFile $snapshot
}

if (-not (Test-Path -LiteralPath (Join-Path $staging 'resources\app\out\main.js'))) {
    throw "基线暂存不存在或不完整：$staging`n先跑一次全量 .ci/scripts/package-vscode.ps1 + verify-staging 生成基线。"
}
if (-not (Test-Path -LiteralPath $recordFile)) {
    throw "缺少 $recordFile（由 package-vscode.ps1 的 --record-staging 生成）⇒ 无法确认基线身份。"
}
$record = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
$currentCommit = (git rev-parse HEAD).Trim()
$mode = Get-PackMode
Assert-Exit '读取 pack mode'
$plugins = Get-RepoPluginVersions

# ── 模式一：把刚跑完的全量基线登记为「可复用基线」 ──────────────────────────────
if ($InitBaseline) {
    Write-BaselineSnapshot -Commit $currentCommit -Record $record -Plugins $plugins -PackMode $mode
    Write-Host "[quick-pack] 基线已登记：$baselineFile"
    Write-Host "  commit=$currentCommit version=$($record.productVersion) mode=$mode 插件=$($plugins.Count)"
    exit 0
}

# ── 模式二：插件级快包 ────────────────────────────────────────────────────────
$t0 = Get-Date
if (-not (Test-Path -LiteralPath $baselineFile)) {
    throw "缺少基线快照 $baselineFile ⇒ 先跑一次全量构建，再执行 -InitBaseline。"
}
$base = Get-Content -LiteralPath $baselineFile -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'))) {
    throw 'node_modules 不全（构建机被清理过）⇒ 回退主流水线 install-deps + 全量构建。'
}

Write-Host '=== [1/6] 差异守门（只允许 dsh-plugins/） ==='
git cat-file -e "$($base.commit)^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
    throw "基线 commit $($base.commit) 不在当前仓库 ⇒ 不能复用这台机器的暂存。"
}
$allChanged = @()
$allChanged += @(git diff --name-only $base.commit)
$allChanged += @(git ls-files --others --exclude-standard)
$changedFiles = @($allChanged | Where-Object { $_ } | ForEach-Object { ($_ -replace '\\', '/').Trim() } | Select-Object -Unique)
$blocked = @($changedFiles | Where-Object { $_ -notmatch '^dsh-plugins/' })
if ($blocked.Count -gt 0) {
    throw "检测到 dsh-plugins/ 之外的改动（$($blocked.Count) 个，例：$($blocked[0])）⇒ 必须走全量流水线。`n改动清单：$($blocked -join ', ')"
}
Write-Host "  ✅ 差异 $($changedFiles.Count) 个文件，全部落在 dsh-plugins/"
# 只守 dsh-plugins/README.md 的规则 1：改了运行时内容必须 bump 版本，否则 pnpm 的 file:
# spec 逐字不变 ⇒ 装机后一个字节都不换。刻意不调用 check-dsh-release.mjs：那个发布守卫
# 还查 dsh-runtime 裁剪 / PRUNE_LIST 等与「资源替换」无关的状态，会把快包无谓地拦死。
$changedSet = New-Object 'System.Collections.Generic.HashSet[string]'
foreach ($f in $changedFiles) { [void]$changedSet.Add($f) }
$needBump = @{}
foreach ($f in $changedFiles) {
    if ($f -notmatch '^dsh-plugins/([^/]+)/(.+)$') { continue }
    $pkgDir = $Matches[1]
    $rel = $Matches[2]
    if ($rel -eq 'package.json' -or $rel -match '^(dev|test)/' -or $rel -match '\.md$') { continue }
    $needBump[$pkgDir] = $true
}
$missingBump = @($needBump.Keys | Where-Object { -not $changedSet.Contains("dsh-plugins/$_/package.json") })
if ($missingBump.Count -gt 0) {
    throw "以下插件改了运行时内容却没 bump 版本（pnpm 判无变化 ⇒ 装机后仍是旧代码）：$($missingBump -join ', ')`n先跑 node scripts/dsh-plugin-deploy.mjs --bump"
}
Write-Host '  ✅ 版本 bump 规则通过'

Write-Host '=== [2/6] 基线与内核身份校验 ==='
$currentVersion = (Get-Content -LiteralPath (Join-Path $repoRoot 'product.json') -Raw | ConvertFrom-Json).version
if ([string]$currentVersion -ne [string]$base.productVersion) {
    throw "product.json 版本变了（$($base.productVersion) → $currentVersion）⇒ 必须走全量（ISCC 从 staging 的 product.json 读版本）。"
}
if ($mode -ne [string]$base.packMode) { throw "SAROS_PACK_MODE 变了（$($base.packMode) → $mode）⇒ 必须走全量。" }
foreach ($pair in @(@('SAROS_MEDIA_MODE', 'mediaMode'), @('VSSAROS_SKIP_OFFICE_RUNTIME', 'skipOffice'))) {
    $envValue = [string]([Environment]::GetEnvironmentVariable($pair[0]))
    if ($envValue -ne [string]$base.env.($pair[1])) {
        throw "$($pair[0]) 变了（$($base.env.($pair[1])) → $envValue）⇒ 必须走全量。"
    }
}
$basePlugins = @{}
foreach ($prop in $base.plugins.PSObject.Properties) { $basePlugins[$prop.Name] = [string]$prop.Value }
$bumped = @()
foreach ($name in $plugins.Keys) {
    if (-not $basePlugins.ContainsKey($name) -or $basePlugins[$name] -ne $plugins[$name]) { $bumped += $name }
}
foreach ($f in $base.files) {
    # dsh-compat.json 属于插件资源，允许随插件一起变；其余都是内核/扩展产物，一个字节都不许动。
    if ($f.path -eq 'resources/app/dsh-plugins/dsh-compat.json') { continue }
    $p = Join-Path $staging ($f.path -replace '/', '\')
    if (-not (Test-Path -LiteralPath $p)) { throw "基线哨兵缺失：$($f.path) ⇒ 暂存被清理过，必须走全量。" }
    $actual = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne ([string]$f.sha256).ToLowerInvariant()) {
        throw "内核构件已变化：$($f.path) ⇒ 暂存不是这份基线，必须走全量。"
    }
}
Write-Host "  ✅ 内核哨兵 $($base.files.Count) 项一致；版本 bump 的插件 $($bumped.Count) 个"

Write-Host '=== [3/6] profile 种子（增量优先，失败自动回退全量） ==='
if (-not $SkipSeed) {
    node build/prepack-dsh-runtime.mjs --incremental-seed
    Assert-Exit 'prepack-dsh-runtime --incremental-seed'
    node build/saros/pack-optimization.mjs --check-seed
    Assert-Exit '--check-seed'
} else {
    Write-Host '  ⚠ -SkipSeed：跳过种子重建（仅用于「连版本号都没动」的纯内容验证）'
    node build/saros/pack-optimization.mjs --check-seed
    Assert-Exit '--check-seed'
}

Write-Host '=== [4/6] 同步插件资源到暂存 ==='
if ($bumped.Count -gt 0 -and $Only) {
    Write-Host '  ⚠ 检测到版本 bump ⇒ 忽略 -Only，改为同步全部插件目录（避免其它 bump 插件没进包）'
    $Only = ''
}
$syncArgs = @('build/saros/sync-dsh-plugins.mjs', '--staging', $staging)
if ($Only) { $syncArgs += @('--only', $Only) }
if ($bumped.Count -gt 0 -and -not $SkipSeed) { $syncArgs += '--sync-seed' }
node @syncArgs
Assert-Exit 'sync-dsh-plugins'
# sync-dsh-plugins.mjs 已逐文件 sha256 复核「产物 vs 仓库」，这里无需再跑 --dist 守卫。

Write-Host '=== [5/6] 刷新门禁回执 + 校验 ==='
node build/saros/pack-optimization.mjs --record-staging $staging
Assert-Exit '--record-staging'
powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $repoRoot '.ci\scripts\verify-staging.ps1')
Assert-Exit 'verify-staging'

Write-Host '=== [6/6] 只做 ISCC（不触发任何 gulp compile） ==='
if (-not $env:SAROS_SETUP_TARGETS) { $env:SAROS_SETUP_TARGETS = $Target }
powershell -ExecutionPolicy Bypass -NoProfile -File (Join-Path $repoRoot '.ci\scripts\generate-exe.ps1')
Assert-Exit 'generate-exe'

$elapsed = [int]((Get-Date) - $t0).TotalSeconds
Write-Json (Join-Path $reports 'timing-fast.json') ([ordered]@{
    phase = 'fast'; commit = $currentCommit; seconds = $elapsed
    changedPlugins = $bumped; changedFiles = $changedFiles.Count
})
# 快包成功后，把这份（内核未变的）暂存登记成下一次的基线。
$newRecord = Get-Content -LiteralPath $recordFile -Raw | ConvertFrom-Json
Write-BaselineSnapshot -Commit $currentCommit -Record $newRecord -Plugins $plugins -PackMode $mode

$baselineTiming = Join-Path $reports 'timing-baseline.json'
Write-Host "[quick-pack] 完成，耗时 $elapsed s"
if (Test-Path -LiteralPath $baselineTiming) {
    $baselineSeconds = (Get-Content -LiteralPath $baselineTiming -Raw | ConvertFrom-Json).seconds
    $saved = $baselineSeconds - $elapsed
    Write-Host ("[quick-pack] 全量基线 {0} s ⇒ 省 {1} s（{2}%）" -f $baselineSeconds, $saved, [math]::Round(100 * $saved / $baselineSeconds))
} else {
    Write-Host '[quick-pack] 提示：把全量构建的耗时写入 .build/pack-reports/timing-baseline.json 即可看到省时幅度'
}
