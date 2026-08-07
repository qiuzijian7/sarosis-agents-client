# 构建 KB markdown webview bundle (kbblocks.js)
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$webviewDir = "src\vs\sessions\contrib\agentStudio\webview"
if (Test-Path ($webviewDir + '\package.json')) {
  Push-Location $webviewDir
  npm install --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host ('[WARN] webview npm install exited ' + $LASTEXITCODE + ' (non-fatal)')
  }
  Pop-Location
}
Push-Location $webviewDir
node esbuild.kbblocks.config.mjs
if ($LASTEXITCODE -ne 0) {
  Write-Host "[WARN] kbblocks esbuild failed (may use stale bundle if available)"
} elseif (Test-Path "media\kbblocks.js") {
  $sz = (Get-Item "media\kbblocks.js").Length
  Write-Host ('[OK] kbblocks.js built ' + $sz + ' bytes')
}
Pop-Location
