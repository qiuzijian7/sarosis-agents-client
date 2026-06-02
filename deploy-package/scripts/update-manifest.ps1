# update-manifest.ps1
# 更新 update-server/manifest.json 中的版本信息

param(
    [string]$ManifestPath = "..\update-server\manifest.json",
    [string]$Platform = "win32-x64-user",  # win32-x64-user 或 win32-x64
    [string]$Version = "",                 # Git commit SHA
    [string]$ProductVersion = "",         # 产品版本号，如 1.0.0
    [string]$Url = "",                    # 安装包下载 URL
    [string]$Sha256Hash = "",            # 安装包 SHA256 哈希
    [long]$Timestamp = 0                  # 发布时间戳（毫秒）
)

Write-Host "=== 更新 manifest.json ===" -ForegroundColor Green
Write-Host "Manifest 路径: $ManifestPath" -ForegroundColor Yellow
Write-Host "平台: $Platform" -ForegroundColor Yellow
Write-Host ""

# 读取现有 manifest
if (-not (Test-Path $ManifestPath)) {
    Write-Host "警告: manifest.json 不存在，将创建新文件" -ForegroundColor Yellow
    $manifest = @{}
} else {
    $manifestContent = Get-Content $ManifestPath -Encoding UTF8 -Raw
    $manifest = $manifestContent | ConvertFrom-Json
}

# 交互式输入（如果参数未提供）
if ([string]::IsNullOrEmpty($Version)) {
    $Version = Read-Host "请输入 Git commit SHA (完整 40 位)"
}

if ([string]::IsNullOrEmpty($ProductVersion)) {
    $ProductVersion = Read-Host "请输入产品版本号 (如 1.0.0)"
}

if ([string]::IsNullOrEmpty($Url)) {
    $Url = Read-Host "请输入安装包下载 URL"
}

if ([string]::IsNullOrEmpty($Sha256Hash)) {
    $Sha256Hash = Read-Host "请输入安装包 SHA256 哈希 (可选，回车跳过)"
}

if ($Timestamp -eq 0) {
    $Timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# 更新 manifest
$platformData = @{
    version = $Version
    productVersion = $ProductVersion
    url = $Url
    sha256hash = if ([string]::IsNullOrEmpty($Sha256Hash)) { $null } else { $Sha256Hash }
    timestamp = $Timestamp
}

# 转换为 PSObject 以便正确序列化
$platformObj = New-Object PSObject -Property $platformData

if ($manifest.PSObject.Properties.Name -contains $Platform) {
    $manifest.$Platform = $platformObj
} else {
    Add-Member -InputObject $manifest -MemberType NoteProperty -Name $Platform -Value $platformObj
}

# 保存 manifest
$manifestJson = $manifest | ConvertTo-Json -Depth 10
$manifestJson | Out-File -FilePath $ManifestPath -Encoding UTF8

Write-Host ""
Write-Host "=== manifest.json 更新完成 ===" -ForegroundColor Green
Write-Host "平台: $Platform" -ForegroundColor Yellow
Write-Host "版本: $Version" -ForegroundColor Yellow
Write-Host "产品版本: $ProductVersion" -ForegroundColor Yellow
Write-Host "URL: $Url" -ForegroundColor Yellow
if (-not [string]::IsNullOrEmpty($Sha256Hash)) {
    Write-Host "SHA256: $Sha256Hash" -ForegroundColor Yellow
}
Write-Host "时间戳: $Timestamp" -ForegroundColor Yellow
Write-Host ""
Write-Host "请重启更新服务器以应用更改" -ForegroundColor Magenta
