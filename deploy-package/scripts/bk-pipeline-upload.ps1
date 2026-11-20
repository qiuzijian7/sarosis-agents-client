# bk-pipeline-upload.ps1
# ============================================================
# Upload exe to update server after packaging.
#
# Uses curl.exe instead of Invoke-RestMethod for large file uploads.
# PowerShell 5.1 (Windows Server 2016) has issues with Invoke-RestMethod
# for large files (connection drops after ~95s). curl.exe streams the
# file natively without buffering.
#
# Usage in BK pipeline:
#   powershell -ExecutionPolicy Bypass -File deploy-package/scripts/bk-pipeline-upload.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# Disable Expect: 100-continue for any .NET HTTP calls
[System.Net.ServicePointManager]::Expect100Continue = $false

# ---- Config ----
$UpdateServer = $env:SAROS_UPDATE_SERVER
if (-not $UpdateServer) { $UpdateServer = "http://zijianqiu-any1.devcloud.woa.com:3030" }
$UploadToken = $env:SAROS_UPLOAD_TOKEN

node build/saros/release-assets.mjs --invalidate-upload
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Failed to invalidate old upload receipts" -ForegroundColor Red; exit 1 }
node build/saros/pack-optimization.mjs --check-exes
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Installer gate failed; upload aborted" -ForegroundColor Red; exit 1 }
$assetsJson = node build/saros/pack-optimization.mjs --targets-json
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Invalid packaging policy" -ForegroundColor Red; exit 1 }
try { $setupAssets = ConvertFrom-Json -InputObject ($assetsJson -join "`n") } catch { Write-Host "[ERROR] Invalid installer target JSON: $($_.Exception.Message)" -ForegroundColor Red; exit 1 }
if (@($setupAssets).Count -lt 1 -or @($setupAssets).Count -gt 2) { Write-Host "[ERROR] Invalid installer target count" -ForegroundColor Red; exit 1 }
foreach ($asset in $setupAssets) {
  if (@('user', 'system') -notcontains $asset.target -or @('win32-x64-user', 'win32-x64') -notcontains $asset.platform -or [string]::IsNullOrWhiteSpace($asset.rel)) {
    Write-Host "[ERROR] Invalid installer target metadata" -ForegroundColor Red
    exit 1
  }
}

Write-Host "=== VsSaros exe upload to update server ===" -ForegroundColor Green
Write-Host "Server: $UpdateServer"

# ---- Read version info ----
if (-not (Test-Path "product.json")) {
    Write-Host "[ERROR] product.json not found" -ForegroundColor Red
    exit 1
}
$productJson = Get-Content "product.json" -Raw | ConvertFrom-Json
$productVersion = $productJson.version
$commit = git rev-parse HEAD

if (-not $commit -or $commit.Length -ne 40) {
    Write-Host "[ERROR] Invalid commit: $commit" -ForegroundColor Red
    exit 1
}

# ---- Print version banner ----
$buildDate = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
$commitCount = (git rev-list --count HEAD 2>$null).Trim()
Write-Host ""
Write-Host "========================================"
Write-Host "  Product:  VsSaros"
Write-Host "  Version:  $productVersion"
Write-Host "  Commit:   $($commit.Substring(0, 10)) ($commitCount commits)"
Write-Host "  Date:     $buildDate"
Write-Host "========================================"
Write-Host ""

# ---- Verify version-info.json exists (written by packaging step) ----
$firstSetupTarget = @($setupAssets)[0].target
$versionInfoPath = ".build\win32-x64\${firstSetupTarget}-setup\version-info.json"
if (Test-Path $versionInfoPath) {
    $versionInfo = Get-Content $versionInfoPath -Raw | ConvertFrom-Json
    Write-Host "Packaged version-info.json:"
    Write-Host "  Version: $($versionInfo.version)"
    Write-Host "  Commit:  $($versionInfo.commitShort)"
    Write-Host "  Arch:    $($versionInfo.arch)"
    Write-Host "  Target:  $($versionInfo.target)"
    Write-Host "  Date:    $($versionInfo.buildDate)"
    Write-Host ""
    # Verify version matches
    if ($versionInfo.version -ne $productVersion) {
        Write-Host "[WARN] Version mismatch: product.json=$productVersion vs version-info.json=$($versionInfo.version)" -ForegroundColor Yellow
    }
} else {
    Write-Host "[WARN] version-info.json not found at $versionInfoPath" -ForegroundColor Yellow
}

# ---- Check curl.exe availability ----
$curlExe = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
if (-not $curlExe) {
    Write-Host "[ERROR] curl.exe not found. Please install curl or add it to PATH." -ForegroundColor Red
    exit 1
}
Write-Host "Using: $curlExe"
Write-Host ""

# ---- Packages to upload ----
$packages = @($setupAssets | ForEach-Object {
    @{ Platform = $_.platform; ExePath = $_.rel; Name = $_.target }
})

# ---- Upload each package ----
$successCount = 0
$failCount = 0
$maxRetries = 3

foreach ($pkg in $packages) {
    $platform = $pkg.Platform
    $exePath = $pkg.ExePath
    $name = $pkg.Name

    Write-Host "--- $name ($platform) ---"

    if (-not (Test-Path $exePath)) {
        Write-Host "  [SKIP] File not found ($exePath)" -ForegroundColor Yellow
        $failCount++
        continue
    }

    $sizeMB = [math]::Round((Get-Item $exePath).Length / 1MB, 2)
    Write-Host "  File size: ${sizeMB} MB"

    # 与更新服务器 MAX_UPLOAD_SIZE（默认 2 GiB）对齐：超限就地失败并给出可读原因，
    # 不再白传几百 MB 后只拿到 curl (55) Broken pipe。
    $maxUploadMB = 2048
    if ($env:SAROS_MAX_UPLOAD_MB) { $maxUploadMB = [int]$env:SAROS_MAX_UPLOAD_MB }
    if ($sizeMB -gt $maxUploadMB) {
        Write-Host "  [ERROR] ${sizeMB} MB exceeds upload limit ${maxUploadMB} MB (server MAX_UPLOAD_SIZE / SAROS_MAX_UPLOAD_MB)" -ForegroundColor Red
        $failCount++
        continue
    }

    # Build upload URL
    $uploadUrl = "${UpdateServer}/admin/upload?platform=${platform}&commit=${commit}&productVersion=${productVersion}"

    # Build curl arguments
    # --upload-file streams the file without buffering (unlike --data-binary)
    # -H "Expect:" suppresses Expect: 100-continue header
    # -sS shows errors but not progress bar (we add our own logging)
    # --connect-timeout 30 --max-time 600 sets reasonable timeouts
    $responseDir = Join-Path (Get-Location).Path '.build\pack-reports\upload-responses'
    New-Item -ItemType Directory -Path $responseDir -Force | Out-Null
    $responseFile = Join-Path $responseDir ($platform + '.json')
    $curlArgs = @(
        "-sS",
        "-X", "POST",
        "-H", "Content-Type: application/octet-stream",
        "-H", "Expect:",
        "--connect-timeout", "30",
        "--max-time", "600",
        "--upload-file", $exePath,
        "-o", $responseFile,
        "-w", "`n%{http_code}"
    )

    if ($UploadToken) {
        $curlArgs += @("-H", "X-Upload-Token: $UploadToken")
    }
    $curlArgs += $uploadUrl

    $uploaded = $false
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        Write-Host "  Uploading... (attempt $attempt/$maxRetries)"
        if (Test-Path -LiteralPath $responseFile) { Remove-Item -LiteralPath $responseFile -Force }

        # PowerShell 5.1 会把本机命令的 stderr 转成 ErrorRecord；在 $ErrorActionPreference=Stop
        # 下 curl 的任何告警都会抛 NativeCommandError 并终止整个脚本 —— 3 次重试和第二个
        # 安装包都跑不到。调用期间临时降级为 Continue，让重试与错误汇总真正生效。
        $prevErrorAction = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $output = & $curlExe @curlArgs 2>&1
            $exitCode = $LASTEXITCODE
        } finally {
            $ErrorActionPreference = $prevErrorAction
        }

        # Extract HTTP status code from last line of output
        $lines = ($output -join "`n").Trim().Split("`n")
        $httpCode = $lines[-1].Trim()

        if ($exitCode -eq 0 -and $httpCode -eq "200") {
            node build/saros/release-assets.mjs --record-upload $platform $responseFile $UpdateServer
            if ($LASTEXITCODE -eq 0) {
                Write-Host "  [OK] Upload and immutable archive receipt verified" -ForegroundColor Green
                $successCount++
                $uploaded = $true
                break
            }
            Write-Host "  [WARN] HTTP 200 did not provide a valid immutable archive receipt" -ForegroundColor Yellow
        }
        $errMsg = ($output | Select-Object -First 5) -join " "
        if ($attempt -lt $maxRetries) {
            Write-Host "  [WARN] Upload failed (curl exit=$exitCode, HTTP $httpCode): $errMsg -- retrying in 5s..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        } else {
            Write-Host "  [ERROR] Upload failed (curl exit=$exitCode, HTTP $httpCode): $errMsg" -ForegroundColor Red
        }
    }
    if (-not $uploaded) { $failCount++ }
    Write-Host ""
}

# ---- Summary ----
Write-Host "=== Upload complete ===" -ForegroundColor $(if ($failCount -eq 0) { "Green" } else { "Yellow" })
Write-Host "Success: $successCount, Failed: $failCount"

if ($failCount -gt 0) {
    Write-Host "[ERROR] Upload failures detected, aborting pipeline" -ForegroundColor Red
    exit 1
}

node build/saros/release-assets.mjs --complete-upload $UpdateServer
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Immutable archive links are incomplete or not downloadable; release blocked" -ForegroundColor Red; exit 1 }

# ---- Verify: check server manifest ----
Write-Host ""
Write-Host "--- Verify manifest ---"
try {
    $verifyPlatform = $packages[0].Platform
    $verifyUrl = "${UpdateServer}/api/update/${verifyPlatform}/saros/${commit}"
    $response = Invoke-WebRequest -Uri $verifyUrl -UseBasicParsing -TimeoutSec 10
    if ($response.StatusCode -eq 204) {
        Write-Host "[OK] Verify success: server manifest updated, commit matches" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Verify returned $($response.StatusCode), manifest may not be updated" -ForegroundColor Yellow
    }
} catch {
    # 204 triggers an exception in PowerShell, this is normal
    $statusCode = $_.Exception.Response.StatusCode.value__
    if ($statusCode -eq 204) {
        Write-Host "[OK] Verify success: server manifest updated, commit matches" -ForegroundColor Green
    } else {
        Write-Host "[WARN] Verify failed (HTTP $statusCode)" -ForegroundColor Yellow
    }
}
