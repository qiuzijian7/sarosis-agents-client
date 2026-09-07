# 编译扩展 compile-extensions-build
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 依赖完整性自愈：install-deps.ps1 会先 rd /s /q build\node_modules 再在末段重装；
# 若它在中途（如 native rebuild）失败 exit 1，蓝盾并不会中断 Job，build/node_modules 便一直是空的，
# 于是这里的 gulp bundle-extensions-build 在 118ms 内报 Cannot find module '@vscode/vsce'
# （vsce 属于 build/package.json，不在根 node_modules）——白跑 30 分钟编译才暴露。
if (-not (Test-Path 'build\node_modules\@vscode\vsce')) {
  Write-Host '[deps-heal] build/node_modules/@vscode/vsce missing - reinstalling build/ dependencies...'
  Push-Location build
  npm install --ignore-scripts
  $healRc = $LASTEXITCODE
  Pop-Location
  if ($healRc -ne 0) { Write-Error 'FATAL: build/ npm install failed (deps-heal)'; exit 1 }
  Write-Host '[deps-heal] build/ dependencies restored'
}

# 删除自链接 junction：39 个扩展的 package.json 都声明 "vssaros": "file:../.."，npm install 会在
# extensions/*/node_modules/vssaros 建一个指向【仓库根】的 junction。编译/打包扩展时遍历器顺着它
# 拉入全仓（尤其 out-build/ 十万级文件）→ EMFILE (too many open files)。
# 只删 vssaros；保留 saros-shared（指向 extensions/shared，是扩展真实依赖）。
# cmd rmdir 对 junction 只断开链接本身，不触碰目标内容；枚举仅列一层目录名，无递归风险。
# ★ 必须在【所有 npm install 之后】再调用一次：任何一次 extension 内的 npm install 都会重建该 junction
#   （2026-09-07 事故：junction-clean 删掉 40 个后，codebuddy-provider 的 npm install 又装回 1 个，
#    gulp 遂在 extensions\codebuddy-provider\node_modules\vssaros\out-build\... 上 EMFILE）。
function Remove-VssarosJunctions {
  param([string]$Tag)
  $juncRemoved = 0
  $nmDirs = @(Get-ChildItem extensions -Directory -EA SilentlyContinue | ForEach-Object { Join-Path $_.FullName 'node_modules' })
  $nmDirs += (Join-Path $repoRoot 'extensions\node_modules')
  foreach ($nm in $nmDirs) {
    if (-not (Test-Path $nm)) { continue }
    $link = Join-Path $nm 'vssaros'
    if (Test-Path $link) {
      cmd /c rmdir "$link" 2>$null
      if (-not (Test-Path $link)) { $juncRemoved++ }
    }
  }
  Write-Host ('[junction-clean:' + $Tag + '] removed ' + $juncRemoved + ' vssaros self-link junctions')
}
Remove-VssarosJunctions -Tag 'pre'


# Delete extensions known to fail vsce packaging (workspace cache safety)
cmd /c "rd /s /q extensions\hermes-agent 2>nul"
cmd /c "rd /s /q extensions\execution-example 2>nul"
cmd /c "rd /s /q extensions\kanban-example 2>nul"
cmd /c "rd /s /q extensions\memory-example 2>nul"
cmd /c "rd /s /q extensions\planning-example 2>nul"
cmd /c "rd /s /q extensions\retrieval-example 2>nul"
cmd /c "rd /s /q extensions\tool-example 2>nul"

# 强制修正 shared/package.json 的 name（workspace 跨次复用，旧 @saros/shared 可能残留）。
# 内容纯 ASCII，但必须写【无 BOM】：PS 5.1 的 Set-Content -Encoding utf8 会加 BOM，
# vsce 的 JSON.parse 拒绝 BOM 前缀，报 "Unexpected token"。用 WriteAllText + UTF8Encoding($false)。
$sharedJson = '{"name":"saros-shared","version":"1.0.0","description":"Shared utilities","main":"./out/index.js","engines":{"vscode":"^1.95.0"},"activationEvents":[],"types":"./out/index.d.ts","dependencies":{},"scripts":{"compile":"tsc -p ./","watch":"tsc -watch -p ./"},"devDependencies":{"@types/node":"22.x","@types/vscode":"^1.95.0","typescript":"^6.0.3"}}'
[IO.File]::WriteAllText(($pwd.Path + '\extensions\shared\package.json'), $sharedJson, (New-Object Text.UTF8Encoding $false))

# 切勿重写 codebuddy-provider/package.json：含中文 description，GBK 下会污染字节。
# 仓库副本已正确（dep=saros-shared, UTF-8），只需 reinstall 刷新符号链接。
Push-Location extensions\codebuddy-provider
Remove-Item -Recurse -Force -EA SilentlyContinue node_modules\@sarosis
Remove-Item -Recurse -Force -EA SilentlyContinue node_modules\saros-shared
npm install --ignore-scripts
Pop-Location

# ===== 编译本地 tsc 扩展（产物 out/ 或 dist/ 为 gitignored，CI checkout 后不存在）=====
# gulp compile-extensions-build 对 esbuild 扩展（有 esbuild.mts/.esbuild.mts）会自动跑 esbuild 产出 dist/，
# 但对纯 tsc 扩展只做 vsce 打包（不编译），产物必须预先存在。此前这些扩展的 out/ 从未在 CI 生成，
# 导致打包后扩展激活失败（如 codebuddy-provider 缺 dist/extension.cjs.js -> command 'codebuddy.login'
# not found；tof-authentication 缺 out/extension.js -> Timed out waiting for auth provider 'tof'）。
# 这里动态扫描所有扩展：对「有 compile 脚本、main 指向 out/ 或 dist/、无 esbuild 配置、且非测试/示例」
# 的扩展逐个执行 npm run compile。shared 需在其它扩展前编译（作为依赖被引用）。
# （transpile-plugins 已用 esbuild 处理有 contributes.agentCapabilities 的 agentmemory-memory。）
$extSkip = @('hermes-agent','execution-example','kanban-example','memory-example','planning-example',
  'retrieval-example','tool-example','vscode-api-tests','vscode-colorize-tests',
  'vscode-colorize-perf-tests','vscode-test-resolver','agent-studio')
$compileTargets = @()
foreach ($extDir in (Get-ChildItem extensions -Directory)) {
  $ext = $extDir.Name
  if ($extSkip -contains $ext) { continue }
  $pkgPath = "extensions\$ext\package.json"
  if (-not (Test-Path $pkgPath)) { continue }
  $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
  # 无 esbuild 配置 + main 指向 out/dist + 有 compile 脚本
  $hasEsbuild = (Test-Path "extensions\$ext\esbuild.mts") -or (Test-Path "extensions\$ext\esbuild.ts") `
    -or (Test-Path "extensions\$ext\.esbuild.mts") -or (Test-Path "extensions\$ext\.esbuild.ts")
  if ($hasEsbuild) { continue }
  $main = [string]$pkg.main
  $hasCompile = $null -ne $pkg.scripts.compile
  if ($main -notmatch '(^|/)(out|dist)/') { continue }
  if (-not $hasCompile) { continue }
  $compileTargets += $ext
}
foreach ($ext in ($compileTargets | Sort-Object { $_ -eq 'shared' } -Descending)) {
  Push-Location "extensions\$ext"
  Write-Host ("[compile-ext] Compiling tsc extension: " + $ext)
  npm run compile
  if ($LASTEXITCODE -ne 0) {
    Write-Error ("FATAL: " + $ext + " npm run compile failed")
    Pop-Location
    exit 1
  }
  Pop-Location
}

# ===== agent-studio 单独编译 =====
# 它既没有 compile 脚本（不会被上面的动态循环选中），也不被 gulp 扩展管线识别，而 out/ 又被 .gitignore
# 排除 → CI checkout 后永远没有 out/extension.js，generate-exe.ps1 的自愈拿不到源，直接 FATAL 拒绝出包
# （2026-09-07：extensions\agent-studio\out 在仓库也缺失）。这里用根 tsc 显式编译。
$asDir = 'extensions\agent-studio'
if (Test-Path (Join-Path $asDir 'tsconfig.json')) {
  Write-Host '[compile-ext] Compiling agent-studio (no compile script, tsc -p)'
  & node (Join-Path $repoRoot 'node_modules\typescript\bin\tsc') -p $asDir
  if ($LASTEXITCODE -ne 0) { Write-Error 'FATAL: agent-studio tsc failed'; exit 1 }
  # 根 package.json 是 "type": "module"，产物是 CJS，必须落 out/package.json 覆盖模块类型，
  # 否则 require 时报 ERR_REQUIRE_ESM。写【无 BOM】UTF-8。
  [IO.File]::WriteAllText((Join-Path $repoRoot "$asDir\out\package.json"), '{"type":"commonjs"}', (New-Object Text.UTF8Encoding $false))
  if (-not (Test-Path (Join-Path $asDir 'out\extension.js'))) {
    Write-Error 'FATAL: agent-studio out\extension.js 未生成'
    exit 1
  }
  Write-Host '[OK] agent-studio compiled'
}

# 所有 npm install 已结束，此处必须再清一次 junction（见上方函数注释）。
Remove-VssarosJunctions -Tag 'pre-gulp'

# 直接调本地 gulp，绕开 npx（npx 找不到本地包时会交互式询问 "Ok to proceed?"，
# CI 无 stdin 导致无限挂起）。
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'
if (-not (Test-Path $gulp)) { Write-Error "local gulp not found at $gulp"; exit 1 }
& $gulp compile-extensions-build --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Extensions build failed"; exit 1 }
