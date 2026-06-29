# bk-pipeline-upload.ps1
# ============================================================
# Upload exe to update server after packaging.
#
# Usage in BK pipeline:
#   powershell -ExecutionPolicy Bypass -File deploy-package/scripts/bk-pipeline-upload.ps1
# ============================================================

$ErrorActionPreference = "Stop"

# ---- Config ----
$UpdateServer = $env:SAROS_UPDATE_SERVER
if (-not $UpdateServer) { $UpdateServer = "http://zijianqiu-any1.devcloud.woa.com:3030" }
$UploadToken = $env:SAROS_UPLOAD_TOKEN

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

Write-Host "Version: $productVersion"
Write-Host "Commit: $($commit.Substring(0, 10))..."
Write-Host ""

# ---- Packages to upload ----
$packages = @(
    @{ Platform = "win32-x64-user"; ExePath = ".build\win32-x64\user-setup\VsSarosUserSetup.exe"; Name = "User Setup" }
    @{ Platform = "win32-x64";     ExePath = ".build\win32-x64\system-setup\VsSarosisSetup.exe"; Name = "System Setup" }
)

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

    # Build upload URL
    $uploadUrl = "${UpdateServer}/admin/upload?platform=${platform}&commit=${commit}&productVersion=${productVersion}"

    # Build headers (Content-Type via -ContentType param, not in headers)
    $headers = @{}
    if ($UploadToken) { $headers["X-Upload-Token"] = $UploadToken }

    $uploaded = $false
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        try {
            Write-Host "  Uploading... (attempt $attempt/$maxRetries)"
            $response = Invoke-RestMethod -Uri $uploadUrl -Method POST -ContentType "application/octet-stream" -Headers $headers -InFile $exePath -TimeoutSec 600
            Write-Host "  [OK] Upload successful" -ForegroundColor Green
            Write-Host "  SHA256: $($response.sha256hash)"
            $successCount++
            $uploaded = $true
            break
        } catch {
            $statusCode = $_.Exception.Response.StatusCode.value__
            $errMsg = $_.Exception.Message
            if ($attempt -lt $maxRetries) {
                Write-Host "  [WARN] Upload failed (HTTP $statusCode): $errMsg -- retrying in 5s..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
            } else {
                Write-Host "  [ERROR] Upload failed (HTTP $statusCode): $errMsg" -ForegroundColor Red
            }
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

# ---- Verify: check server manifest ----
Write-Host ""
Write-Host "--- Verify manifest ---"
try {
    $verifyUrl = "${UpdateServer}/api/update/win32-x64-user/saros/${commit}"
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
