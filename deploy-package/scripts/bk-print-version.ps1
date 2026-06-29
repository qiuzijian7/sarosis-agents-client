# bk-print-version.ps1
# ============================================================
# Print version info at the start of each CI pipeline step.
# Call this as the first line of each step's script:
#   . deploy-package/scripts/bk-print-version.ps1
# ============================================================

$stepName = $args[0]
if (-not $stepName) { $stepName = "unknown step" }

$productJson = Get-Content "product.json" -Raw | ConvertFrom-Json
$version = $productJson.version
$commit = (git rev-parse HEAD 2>$null).Trim()
$commitShort = if ($commit) { $commit.Substring(0, 10) } else { "unknown" }
$commitCount = (git rev-list --count HEAD 2>$null).Trim()
$branch = (git rev-parse --abbrev-ref HEAD 2>$null).Trim()
$buildDate = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")

Write-Host ""
Write-Host "========================================"
Write-Host "  Step:     $stepName"
Write-Host "  Product:  VsSaros"
Write-Host "  Version:  $version"
Write-Host "  Commit:   $commitShort ($commitCount commits)"
Write-Host "  Branch:   $branch"
Write-Host "  Date:     $buildDate"
Write-Host "========================================"
Write-Host ""
