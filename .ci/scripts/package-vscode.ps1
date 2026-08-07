# 打包 vscode-win32-x64
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

npx gulp vscode-win32-x64 --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Packaging failed"; exit 1 }
