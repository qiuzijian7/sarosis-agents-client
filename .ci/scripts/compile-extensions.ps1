# 编译扩展 compile-extensions-build
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Set-Location $repoRoot

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

npx gulp compile-extensions-build --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Extensions build failed"; exit 1 }
