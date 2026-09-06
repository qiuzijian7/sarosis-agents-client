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
# 注意：tsbuildinfo 只会出现在源码目录，绝不扫 node_modules（20 万文件，曾致清理卡 2h）。
if (Test-Path out) {
  Write-Host '[clean] removing out/ ...'
  cmd /c "rd /s /q out" 2>$null
  if (Test-Path out) { Remove-Item -Recurse -Force out -EA SilentlyContinue }
  Write-Host '[clean] out/ removed'
}
Write-Host '[clean] removing tsbuildinfo (bounded depth, no traversal)...'
# 禁止任何树遍历（Get-ChildItem -Recurse / git ls-files 均曾死循环）：extensions/*/node_modules/vssaros
# 是 npm workspace 指向仓库根的 junction 自引用，遍历器跟进去就是无限循环。
# 改为有界深度展开（0-3 层），展开前过滤 node_modules，只读目录名、绝不进入任何目录内部。
$dirs = @($repoRoot)
for ($i = 0; $i -lt 3; $i++) {
  $dirs = @($dirs) + @(
    $dirs | Where-Object { $_ -notmatch '\\node_modules' } |
      ForEach-Object { Get-ChildItem $_ -Directory -EA SilentlyContinue } |
      Select-Object -ExpandProperty FullName
  )
}
$removed = 0
foreach ($d in ($dirs | Sort-Object -Unique)) {
  $p = Join-Path $d 'tsconfig.tsbuildinfo'
  if (Test-Path $p) { Remove-Item -Force -EA SilentlyContinue $p; $removed++ }
}
Write-Host ('[clean] removed ' + $removed + ' tsbuildinfo files, starting gulp...')

# 直接调用本地 gulp，绕开 npx（npx 找不到本地包时会交互式询问 "Ok to proceed?"，CI 无 stdin 导致无限挂起）
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'
if (-not (Test-Path $gulp)) { Write-Error "local gulp not found at $gulp"; exit 1 }
& $gulp compile-build-with-mangling --verbose
if ($LASTEXITCODE -ne 0) {
  Write-Host "compile-build-with-mangling failed, fallback to dev compile..."
  npm run compile
  if ($LASTEXITCODE -ne 0) { Write-Error "Compile failed"; exit 1 }
}
