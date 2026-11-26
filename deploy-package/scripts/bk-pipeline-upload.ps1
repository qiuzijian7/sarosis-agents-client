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

function Resolve-UploadCurl {
    if (-not [string]::IsNullOrWhiteSpace($env:SAROS_CURL_BIN)) {
        return $env:SAROS_CURL_BIN.Trim()
    }
    $nativeCurl = Join-Path $env:SystemRoot 'System32\curl.exe'
    if (Test-Path -LiteralPath $nativeCurl -PathType Leaf) {
        return $nativeCurl
    }
    return (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
}

function ConvertTo-UploadArgument {
    param([AllowEmptyString()][string]$Value)

    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-UploadCurl {
    param(
        [Parameter(Mandatory = $true)][string]$Executable,
        [string[]]$Arguments,
        [Parameter(Mandatory = $true)][ref]$Result,
        [ValidateRange(1, 2147483)][int]$TimeoutSeconds = 660
    )

    $Result.Value = $null
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Executable
    $startInfo.Arguments = (($Arguments | ForEach-Object { ConvertTo-UploadArgument $_ }) -join ' ')
    $startInfo.UseShellExecute = $false
    $startInfo.WorkingDirectory = (Get-Location).ProviderPath
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.StandardOutputEncoding = [Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $started = $false
    $elapsed = [Diagnostics.Stopwatch]::StartNew()
    try {
        $started = $process.Start()
        if (-not $started) { throw 'Upload process did not start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $Result.Value = [pscustomobject]@{ ExitCode = 28; StandardOutput = ''; StandardError = 'Upload process timed out' }
        } else {
            $remaining = [int][Math]::Max(0, ($TimeoutSeconds * 1000) - $elapsed.ElapsedMilliseconds)
            $outputComplete = [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdoutTask, $stderrTask), $remaining)
            if (-not $outputComplete) {
                $Result.Value = [pscustomobject]@{ ExitCode = 28; StandardOutput = ''; StandardError = 'Upload process output timed out' }
            } else {
                $Result.Value = [pscustomobject]@{ ExitCode = $process.ExitCode; StandardOutput = $stdoutTask.GetAwaiter().GetResult(); StandardError = $stderrTask.GetAwaiter().GetResult() }
            }
        }
    } catch {
        $Result.Value = [pscustomobject]@{ ExitCode = -1; StandardOutput = ''; StandardError = $_.Exception.Message }
    } finally {
        if ($started) {
            try {
                if (-not $process.HasExited) {
                    $process.Kill()
                    [void]$process.WaitForExit(5000)
                }
            } catch { }
        }
        $elapsed.Stop()
        $process.Dispose()
    }
}

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
if (@($setupAssets).Count -ne 1) { Write-Host "[ERROR] Exactly one user installer is required" -ForegroundColor Red; exit 1 }
foreach ($asset in $setupAssets) {
  if ($asset.target -ne 'user' -or $asset.platform -ne 'win32-x64-user' -or $asset.rel -ne '.build/win32-x64/user-setup/VsSarosUserSetup.exe') {
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
$curlExe = Resolve-UploadCurl
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
    if (-not [string]::IsNullOrWhiteSpace($env:SAROS_MAX_UPLOAD_MB)) {
        $parsedLimit = 0
        if ([int]::TryParse($env:SAROS_MAX_UPLOAD_MB.Trim(), [ref]$parsedLimit) -and $parsedLimit -gt 0) {
            $maxUploadMB = $parsedLimit
        } else {
            Write-Host "  [WARN] Invalid SAROS_MAX_UPLOAD_MB; using ${maxUploadMB} MB" -ForegroundColor Yellow
        }
    }
    $uploadLimitText = [string]$maxUploadMB
    if ($sizeMB -gt $maxUploadMB) {
        Write-Host "  [ERROR] ${sizeMB} MB exceeds upload limit ${uploadLimitText} MB (server MAX_UPLOAD_SIZE / SAROS_MAX_UPLOAD_MB)" -ForegroundColor Red
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
    $statusFormatFile = Join-Path $responseDir 'http-status.txt'
    [IO.File]::WriteAllText($statusFormatFile, '\n%{http_code}', (New-Object Text.UTF8Encoding($false)))
    $curlArgs = @(
        "-q", "-sS", "--globoff",
        "-X", "POST",
        "-H", "Content-Type: application/octet-stream",
        "-H", "Expect:",
        "--connect-timeout", "30",
        "--max-time", "600",
        "--upload-file", $exePath,
        "-o", $responseFile,
        "-w", ('@' + $statusFormatFile.Replace('\', '/'))
    )

    if ($UploadToken) {
        $curlArgs += @("-H", "X-Upload-Token: $UploadToken")
    }
    $curlArgs += $uploadUrl

    $uploaded = $false
    for ($attempt = 1; $attempt -le $maxRetries; $attempt++) {
        Write-Host "  Uploading... (attempt $attempt/$maxRetries)"
        if (Test-Path -LiteralPath $responseFile) { Remove-Item -LiteralPath $responseFile -Force }

        $curlResult = $null
        Invoke-UploadCurl -Executable $curlExe -Arguments $curlArgs -Result ([ref]$curlResult)
        if ($null -eq $curlResult -or $null -eq $curlResult.ExitCode -or $null -eq $curlResult.StandardOutput -or $null -eq $curlResult.StandardError) {
            Write-Host '[ERROR] Upload process returned an invalid result; retry aborted' -ForegroundColor Red
            exit 1
        }
        $exitCode = $curlResult.ExitCode
        $httpCode = 'missing'
        $statusMatch = [regex]::Match($curlResult.StandardOutput.Trim(), '^\d{3}$')
        if ($statusMatch.Success) { $httpCode = $statusMatch.Value }
        $errMsg = $curlResult.StandardError.Trim()
        if ($UploadToken) { $errMsg = $errMsg.Replace($UploadToken, '[redacted]') }
        if (-not $errMsg) { $errMsg = 'No curl diagnostic output' }

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
if ($LASTEXITCODE -ne 0) { Write-Host "[ERROR] Installer archives or update feeds failed verification; release blocked" -ForegroundColor Red; exit 1 }
Write-Host "[OK] All selected installer channels verified: version, commit, hash, download target and immutable archive" -ForegroundColor Green
