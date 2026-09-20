# create-release.ps1
# ============================================================
# CI Pipeline Step: create git tag + woa.git/GitHub releases
# with auto-generated changelog and exe assets.
#
# Thin wrapper around build/saros/create-release.cjs.
#
# Env consumed by the node script:
#   WOA_GITLAB_TOKEN - token for git.woa.com (fallback: git credential fill)
#   GITHUB_TOKEN     - GitHub PAT (repo scope); GitHub steps are skipped
#                      (warn only) when missing or api.github.com unreachable.
#
# Failure policy: GitLab failure aborts pipeline (exit 1);
# GitHub failure only warns (external mirror).
#
# Usage in BK pipeline step script:
#   powershell -ExecutionPolicy Bypass -File .ci/scripts/create-release.ps1
# ============================================================

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  STEP: Create Release (tag + changelog + GitLab/GitHub)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

node build/saros/create-release.cjs

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] create-release failed (exit code: $LASTEXITCODE)" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "[OK] Release step finished" -ForegroundColor Green
Write-Host ""
