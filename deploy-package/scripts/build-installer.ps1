# build-installer.ps1
# 构建 VsSarosis 安装包

param(
    [string]$BuildType = "user",  # user 或 system
    [string]$Configuration = "Release"
)

Write-Host "=== VsSarosis 安装包构建脚本 ===" -ForegroundColor Green
Write-Host "构建类型: $BuildType" -ForegroundColor Yellow
Write-Host "配置: $Configuration" -ForegroundColor Yellow
Write-Host ""

# 检查当前目录
$currentPath = Get-Location
if (-not $currentPath.Path.EndsWith("saros-agents-client")) {
    Write-Host "错误: 请在 saros-agents-client 根目录下运行此脚本" -ForegroundColor Red
    exit 1
}

# 1. 修复品牌配置
Write-Host "[1/5] 修复品牌配置..." -ForegroundColor Cyan
npm run fix-branding
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误: 品牌配置修复失败" -ForegroundColor Red
    exit 1
}

# 2. 预装「内置 dsh 运行时」（关键构件，2026-10-16 补）
#    为什么必须先跑：`/dsh-runtime/` 在 .gitignore 里（由本步现生成），CI / 干净检出里**没有**它；
#    而 gulp 的 dshRuntime 资源流是 allowEmpty（dev 可跳过）⇒ 不走这一步就会**静默**打出一个
#    "找不到 dsh" 的包：装完首启弹「需要准备 DeepSeek Harness 运行环境」，要求用户自己 npm 装运行时 ✗✗。
#    幂等：目标目录已有同版 bin.js 时跳过安装（--force 才会重装）。约 200MB / 需能访问 npm 源。
Write-Host "[2/5] 预装内置 dsh 运行时（dsh-runtime/<bundled>）..." -ForegroundColor Cyan
node build/prepack-dsh-runtime.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误: 预装 dsh 运行时失败（装出来的包会缺 dsh）" -ForegroundColor Red
    exit 1
}

# 3. 构建安装包
Write-Host "[3/5] 构建安装包..." -ForegroundColor Cyan
if ($BuildType -eq "user") {
    npm run gulp vscode-win32-x64-user-setup
} elseif ($BuildType -eq "system") {
    npm run gulp vscode-win32-x64-system-setup
} else {
    Write-Host "错误: 未知的构建类型: $BuildType" -ForegroundColor Red
    exit 1
}

if ($LASTEXITCODE -ne 0) {
    Write-Host "错误: 构建失败" -ForegroundColor Red
    exit 1
}

# 4. 校验内置运行时**真的进了包**（硬门：宁可不出包，也不出"找不到 dsh"的包）
#    判据与运行时解析同源：<appPath>/dsh-runtime/<bundled>/node_modules/@deepseek-ai/dsh/lib/bin.js
#    版本取 dsh-plugins/dsh-compat.json 的 bundled（不在脚本里写死，防漂移）。
Write-Host "[4/5] 校验内置 dsh 运行时..." -ForegroundColor Cyan
$compatPath = "dsh-plugins\dsh-compat.json"
if (-not (Test-Path $compatPath)) {
    Write-Host "错误: 找不到 $compatPath（无法确定内置哪个 dsh 版本）" -ForegroundColor Red
    exit 1
}
$bundledVersion = (Get-Content $compatPath -Raw | ConvertFrom-Json).bundled
if ([string]::IsNullOrWhiteSpace($bundledVersion)) {
    Write-Host "错误: $compatPath 的 bundled 字段为空" -ForegroundColor Red
    exit 1
}
$runtimeBin = ".build\win32-x64\$BuildType-setup\resources\app\dsh-runtime\$bundledVersion\node_modules\@deepseek-ai\dsh\lib\bin.js"
if (-not (Test-Path $runtimeBin)) {
    Write-Host "错误: 安装包里没有内置 dsh 运行时: $runtimeBin" -ForegroundColor Red
    Write-Host "      （用户首启会弹『需要准备 DeepSeek Harness 运行环境』；先跑 node build/prepack-dsh-runtime.mjs）" -ForegroundColor Red
    exit 1
}
Write-Host "  ✅ 内置运行时 $bundledVersion 已进包" -ForegroundColor Green

# 5. 查找构建产物
Write-Host "[5/5] 查找构建产物..." -ForegroundColor Cyan
$expectedName = if ($BuildType -eq "user") { "VsSarosUserSetup.exe" } else { "VsSarosisSetup.exe" }
$buildOutputPath = ".build\win32-x64\$BuildType-setup\$expectedName"

if (-not (Test-Path $buildOutputPath)) {
    Write-Host "错误: 构建产物未找到: $buildOutputPath" -ForegroundColor Red
    exit 1
}

$fileInfo = Get-Item $buildOutputPath
Write-Host "构建成功: $buildOutputPath" -ForegroundColor Green
Write-Host "文件大小: $([math]::Round($fileInfo.Length / 1MB, 2)) MB" -ForegroundColor Yellow

# 5.1 计算 SHA256 哈希（与"查找产物"同一阶段：产物 + 摘要一起交出去）
$sha256 = Get-FileHash $buildOutputPath -Algorithm SHA256
Write-Host "SHA256: $($sha256.Hash)" -ForegroundColor Yellow

# 输出结果
Write-Host ""
Write-Host "=== 构建完成 ===" -ForegroundColor Green
Write-Host "安装包路径: $buildOutputPath" -ForegroundColor Yellow
Write-Host "SHA256: $($sha256.Hash)" -ForegroundColor Yellow
Write-Host ""
Write-Host "下一步:" -ForegroundColor Magenta
Write-Host "1. 上传安装包到下载服务器" -ForegroundColor White
Write-Host "2. 运行 .\update-manifest.ps1 更新版本信息" -ForegroundColor White
Write-Host ""

# 返回构建信息供其他脚本使用
return @{
    InstallerPath = $buildOutputPath
    InstallerName = $expectedName
    Sha256Hash = $sha256.Hash
    FileSize = $fileInfo.Length
    BuildType = $BuildType
}
