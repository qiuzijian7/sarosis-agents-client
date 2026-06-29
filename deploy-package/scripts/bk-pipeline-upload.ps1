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
$versionInfoPath = ".build\win32-x64\user-setup\version-info.json"
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

    # Build curl arguments
    # --upload-file streams the file without buffering (unlike --data-binary)
    # -H "Expect:" suppresses Expect: 100-continue header
    # -sS shows errors but not progress bar (we add our own logging)
    # --connect-timeout 30 --max-time 600 sets reasonable timeouts
    $curlArgs = @(
        "-sS",
        "-X", "POST",
        "-H", "Content-Type: application/octet-stream",
        "-H", "Expect:",
        "--connect-timeout", "30",
        "--max-time", "600",
        "--upload-file", $exePath,
        "-o", "NUL",
        "-w", "`n%{http_code}"
    )

    if ($UploadToken) {
        $curlArgs += @("-H", "X-Upload-Token: $UploadToken")
    }
    $curlArgs += $uploadUrl

    $uploaded = $false
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        Write-Host "  Uploading... (attempt $attempt/$maxRetries)"

        $output = & $curlExe @curlArgs 2>&1
        $exitCode = $LASTEXITCODE

        # Extract HTTP status code from last line of output
        $lines = ($output -join "`n").Trim().Split("`n")
        $httpCode = $lines[-1].Trim()

        if ($exitCode -eq 0 -and $httpCode -eq "200") {
            Write-Host "  [OK] Upload successful (HTTP 200)" -ForegroundColor Green
            $successCount++
            $uploaded = $true
            break
        } else {
            $errMsg = ($output | Select-Object -First 5) -join " "
            if ($attempt -lt $maxRetries) {
                Write-Host "  [WARN] Upload failed (curl exit=$exitCode, HTTP $httpCode): $errMsg -- retrying in 5s..." -ForegroundColor Yellow
                Start-Sleep -Seconds 5
            } else {
                Write-Host "  [ERROR] Upload failed (curl exit=$exitCode, HTTP $httpCode): $errMsg" -ForegroundColor Red
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
