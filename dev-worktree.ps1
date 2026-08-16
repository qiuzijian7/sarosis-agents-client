# 启动 worktree 分支的 VsSaros 实例（最小代价验证 worktree 代码运行效果）
#
# 原理：electron 二进制（.build/electron/VsSaros.exe）与代码目录（out/）解耦，
# 因此复用主 repo 已编译的 electron 二进制，只需编译 worktree 自己的 out/ 即可，
# 无需重新打包 201MB 的 electron。
#
# 用法：
#   .\dev-worktree.ps1 -WorktreeName feat-agentloop
#   .\dev-worktree.ps1 feat-agentloop
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$WorktreeName
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot            # 仓库根目录
$wt = Join-Path $root ".worktrees\$WorktreeName"     # worktree 绝对路径
$exe = Join-Path $root ".build\electron\VsSaros.exe"

if (-not (Test-Path $wt)) {
    Write-Host "[x] worktree 不存在: $wt" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $exe)) {
    Write-Host "[x] 未找到 electron 二进制: $exe" -ForegroundColor Red
    Write-Host "    请先在主 repo 构建（npm run gulp vscode-win32-x64 或 build-vscode.bat）" -ForegroundColor Yellow
    exit 1
}

Write-Host "=== 启动 worktree [$WorktreeName] 的 VsSaros ===" -ForegroundColor Cyan

# 1. node_modules junction（复用主 repo，省几 GB 磁盘）
if (-not (Test-Path "$wt\node_modules")) {
    New-Item -ItemType Junction -Path "$wt\node_modules" -Target "$root\node_modules" | Out-Null
    Write-Host "[1/4] node_modules junction 已创建（复用主 repo）" -ForegroundColor Green
} else {
    Write-Host "[1/4] node_modules 已存在" -ForegroundColor Gray
}

# 2. fix-const-enums.cjs（build 生成产物，非 git 跟踪，缺失会导致 non-fatal 警告）
if ((Test-Path "$root\build\fix-const-enums.cjs") -and -not (Test-Path "$wt\build\fix-const-enums.cjs")) {
    Copy-Item "$root\build\fix-const-enums.cjs" "$wt\build\fix-const-enums.cjs"
    Write-Host "[2/4] fix-const-enums.cjs 已复制" -ForegroundColor Green
}

# 3. 编译 worktree 的 out/
Write-Host "[3/4] 编译 worktree out/ ..." -ForegroundColor Yellow
Push-Location $wt
try {
    npm run transpile-client
    if ($LASTEXITCODE -ne 0) { throw "transpile-client 失败" }
} finally {
    Pop-Location
}

# 4. 启动（开发模式，加载 out/ 源码）
Write-Host "[4/4] 启动 VsSaros ..." -ForegroundColor Yellow
$env:NODE_ENV = "development"
$env:VSCODE_DEV = "1"
$env:ELECTRON_ENABLE_LOGGING = "1"
Start-Process -FilePath $exe -ArgumentList "`"$wt`"", "--skip-sessions-welcome"
Write-Host "✓ 已启动 worktree [$WorktreeName] 的 VsSaros（agents 窗口）" -ForegroundColor Green
Write-Host "  提示：完全退出主 VsSaros 后再运行本脚本，避免多实例混淆。"
