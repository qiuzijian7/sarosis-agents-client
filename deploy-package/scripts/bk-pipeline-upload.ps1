# bk-pipeline-upload.ps1
# ============================================================
# 蓝盾流水线专用：打包成功后上传 exe 到升级服务器
# 替代流水线中的内联上传脚本
#
# 在蓝盾流水线编排中，将"上传 exe 到升级服务器"步骤的脚本改为：
#   powershell -ExecutionPolicy Bypass -File deploy-package/scripts/bk-pipeline-upload.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# ---- 参数 ----
$UpdateServer = $env:SAROS_UPDATE_SERVER
if (-not $UpdateServer) { $UpdateServer = "http://zijianqiu-any1.devcloud.woa.com:3030" }
$UploadToken = $env:SAROS_UPLOAD_TOKEN

Write-Host "=== VsSaros exe 上传到升级服务器 ===" -ForegroundColor Green
Write-Host "服务器: $UpdateServer"

# ---- 读取版本信息 ----
if (-not (Test-Path "product.json")) {
    Write-Host "❌ product.json not found" -ForegroundColor Red
    exit 1
}
$productJson = Get-Content "product.json" -Raw | ConvertFrom-Json
$productVersion = $productJson.version
$commit = git rev-parse HEAD

if (-not $commit -or $commit.Length -ne 40) {
    Write-Host "❌ Invalid commit: $commit" -ForegroundColor Red
    exit 1
}

Write-Host "版本: $productVersion"
Write-Host "Commit: $($commit.Substring(0, 10))..."
Write-Host ""

# ---- 定义安装包 ----
$packages = @(
    @{ Platform = "win32-x64-user"; ExePath = ".build\win32-x64\user-setup\VsSarosUserSetup.exe"; Name = "User Setup" }
    @{ Platform = "win32-x64";     ExePath = ".build\win32-x64\system-setup\VsSarosisSetup.exe"; Name = "System Setup" }
)

# ---- 逐个上传 ----
$successCount = 0
$failCount = 0
$maxRetries = 3

foreach ($pkg in $packages) {
    $platform = $pkg.Platform
    $exePath = $pkg.ExePath
    $name = $pkg.Name

    Write-Host "--- $name ($platform) ---"

    if (-not (Test-Path $exePath)) {
        Write-Host "  ⚠️  跳过: 文件不存在 ($exePath)" -ForegroundColor Yellow
        $failCount++
        continue
    }

    $sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
    Write-Host "  文件大小: ${sizeMB} MB"

    # 构建上传 URL
    $uploadUrl = "${UpdateServer}/admin/upload?platform=${platform}&commit=${commit}&productVersion=${productVersion}"

    # 构建请求头（Content-Type 用 -ContentType 参数，不放在 headers 中）
    $headers = @{}
    if ($UploadToken) { $headers["X-Upload-Token"] = $UploadToken }

    $uploaded = $false
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            Write-Host "  上传中... (尝试 $attempt/$maxRetries)"
            $response = Invoke-RestMethod -Uri $uploadUrl -Method POST -ContentType "application/octet-stream" -Headers $headers -InFile $exePath -TimeoutSec 600
            Write-Host "  ✅ 上传成功" -ForegroundColor Green
            Write-Host "  SHA256: $($response.sha256hash)"
            $successCount++
            $uploaded = $true
            break
        } catch {
            $statusCode = $_.Exception.Response.StatusCode.value__
            $errMsg = $_.Exception.Message
            if ($attempt -lt $maxRetries) {
                Write-Host "  ⚠️  上传失败 (HTTP $statusCode): $errMsg — 将在 5 秒后重试..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
            } else {
                Write-Host "  ❌ 上传失败 (HTTP $statusCode): $errMsg" -ForegroundColor Red
            }
        }
    }
    if (-not $uploaded) { $failCount++ }
    Write-Host ""
}

# ---- 汇总 ----
Write-Host "=== 上传完成 ===" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Yellow" })
Write-Host "成功: $successCount, 失败: $failCount"

if ($failCount -gt 0) {
    Write-Host "❌ 存在上传失败，终止流水线" -ForegroundColor Red
    exit 1
}

# ---- 验证：检查服务器 manifest 是否更新 ----
Write-Host ""
Write-Host "--- 验证 manifest ---"
try {
    # 用 user 平台验证
    $verifyUrl = "${UpdateServer}/api/update/win32-x64-user/saros/${commit}"
    $response = Invoke-WebRequest -Uri $verifyUrl -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -eq 204) {
        Write-Host "✅ 验证成功：服务器 manifest 已更新，客户端 commit 匹配" -ForegroundColor Green
    } else {
        Write-Host "⚠️  验证返回 $($response.StatusCode)，manifest 可能未正确更新" -ForegroundColor Yellow
    }
} catch {
    # 204 会触发异常，正常情况
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 204) {
        Write-Host "✅ 验证成功：服务器 manifest 已更新，客户端 commit 匹配" -ForegroundColor Green
    } else {
        Write-Host "⚠️  验证失败 (HTTP $statusCode)" -ForegroundColor Yellow
    }
}
