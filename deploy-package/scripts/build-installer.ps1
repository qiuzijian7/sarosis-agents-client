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
Write-Host "[1/4] 修复品牌配置..." -ForegroundColor Cyan
npm run fix-branding
if ($LASTEXITCODE -ne 0) {
    Write-Host "错误: 品牌配置修复失败" -ForegroundColor Red
    exit 1
}

# 2. 构建安装包
Write-Host "[2/4] 构建安装包..." -ForegroundColor Cyan
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

# 3. 查找构建产物
Write-Host "[3/4] 查找构建产物..." -ForegroundColor Cyan
$expectedName = if ($BuildType -eq "user") { "VsSarosisUserSetup.exe" } else { "VsSarosisSetup.exe" }
$buildOutputPath = ".build\win32-x64\$BuildType-setup\$expectedName"

if (-not (Test-Path $buildOutputPath)) {
    Write-Host "错误: 构建产物未找到: $buildOutputPath" -ForegroundColor Red
    exit 1
}

$fileInfo = Get-Item $buildOutputPath
Write-Host "构建成功: $buildOutputPath" -ForegroundColor Green
Write-Host "文件大小: $([math]::Round($fileInfo.Length / 1MB, 2)) MB" -ForegroundColor Yellow

# 4. 计算 SHA256 哈希
Write-Host "[4/4] 计算 SHA256 哈希..." -ForegroundColor Cyan
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
