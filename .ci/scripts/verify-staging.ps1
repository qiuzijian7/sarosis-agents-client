# 验证打包关键构件
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$appRoot = Join-Path (Split-Path $pwd.Path -Parent) "VSCode-win32-x64\resources\app"
if (-not (Test-Path $appRoot)) { $appRoot = "..\VSCode-win32-x64\resources\app" }
Write-Host ('Verifying staging dir: ' + $appRoot)
$required = @(
  "node_modules\@vscode\ripgrep\bin\rg.exe",
  "extensions\agentmemory-memory\dist\extension.js",
  "extensions\codebuddy-provider\dist\extension.cjs.js",
  "extensions\tof-authentication\out\extension.js",
  "out\vs\sessions\contrib\agentStudio\browser\views\knowledgeBase\kbWorker.js",
  "out\vs\sessions\sessions.desktop.main.js",
  "out\vs\sessions\contrib\agentStudio\webview\media\kbblocks.js"
)
$missing = @()
foreach ($rel in $required) {
  $p = Join-Path $appRoot $rel
  if (Test-Path $p) { Write-Host ('  [OK] ' + $rel) }
  else { Write-Host ('  [MISSING] ' + $rel); $missing += $rel }
}
if ($missing.Count -gt 0) {
  Write-Error (('Staging verification failed, missing:' + [Environment]::NewLine + ' - ') + ($missing -join ([Environment]::NewLine + ' - ')))
  exit 1
}
Write-Host "[OK] All critical artifacts present in staging."
