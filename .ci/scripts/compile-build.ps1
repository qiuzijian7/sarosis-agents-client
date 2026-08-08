# 生产编译 compile-build-with-mangling
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$nodeVersion = "22.22.1"
$installed = nvm list 2>$null | Select-String $nodeVersion
if (-not $installed) {
  Write-Host ('Installing Node ' + $nodeVersion + '...')
  nvm install $nodeVersion
}
nvm use $nodeVersion
node --version
npm --version

# 清理跨构建残留的陈旧编译产物：构建机 agent 复用同一工作区时 out/ 与 *.tsbuildinfo 会遗留，
# 增量编译据此误判 base/common/lifecycle.js 等已最新而跳过重编，保留旧 .js
# （缺 DisposableStore / raceTimeout / generateUuid 等导出），导致后续 compile-extensions 报"模块无导出成员"。
# 全量重编彻底消除该问题。
Remove-Item -Recurse -Force -EA SilentlyContinue out
Get-ChildItem -Recurse -Filter *.tsbuildinfo -EA SilentlyContinue | Remove-Item -Force -EA SilentlyContinue

npx gulp compile-build-with-mangling --verbose
if ($LASTEXITCODE -ne 0) {
  Write-Host "compile-build-with-mangling failed, fallback to dev compile..."
  npm run compile
  if ($LASTEXITCODE -ne 0) { Write-Error "Compile failed"; exit 1 }
}
