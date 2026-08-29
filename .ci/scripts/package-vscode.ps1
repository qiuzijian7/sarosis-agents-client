# 打包 vscode-win32-x64
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Set-Location $repoRoot

npx gulp vscode-win32-x64 --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Packaging failed"; exit 1 }

# 自定义扩展 agent-studio 的 out/ 由 tsc 生成（gulp 扩展管线不认识它，且 out/ 被 .gitignore 排除）。
# 必须在预打包自愈之前产出，否则干净构建里自愈无源可拷。
# 详见 build/saros/strip-before-pack.mjs（2026-08-29 生产事故修复）。
Write-Host "Building custom extension: agent-studio (tsc)"
npx tsc -p extensions/agent-studio/tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Error "agent-studio tsc failed"; exit 1 }
if (-not (Test-Path "extensions/agent-studio/out/extension.js")) {
  Write-Error "extensions/agent-studio/out/extension.js not produced"; exit 1
}

# 预打包自愈：补齐 agent-studio/out、node_modules/typescript 等 gulp 不认识的构件。
# 缺失且无法自愈时脚本会 exit(1) 禁止带病出包。
node build/saros/strip-before-pack.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "strip-before-pack failed"; exit 1 }
