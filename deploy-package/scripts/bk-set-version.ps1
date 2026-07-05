# bk-set-version.ps1
# ============================================================
# CI Pipeline Step: Update version number
#
# Computes version = 2.a.b where:
#   a = floor(commitCount / 65536)
#   b = commitCount % 65536
#
# Updates product.json and package.json in place.
# Subsequent pipeline steps use the updated version.
#
# Usage in BK pipeline step script:
#   powershell -ExecutionPolicy Bypass -File deploy-package/scripts/bk-set-version.ps1
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  STEP: Set Version Number" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

node build/saros/set-all-versions.cjs

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Version update failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

# Verify the update
$productJson = Get-Content "product.json" -Raw | ConvertFrom-Json
$pkgJson = Get-Content "package.json" -Raw | ConvertFrom-Json

Write-Host ""
Write-Host "=== Verification ==="
Write-Host "  product.json version: $($productJson.version)"
Write-Host "  package.json version: $($pkgJson.version)"

if ($productJson.version -ne $pkgJson.version) {
    Write-Host "  [ERROR] Version mismatch between product.json and package.json!" -ForegroundColor Red
    exit 1
}

Write-Host "  [OK] Version consistent across both files" -ForegroundColor Green
Write-Host ""
