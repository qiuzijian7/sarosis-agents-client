# 打包 vscode-win32-x64
# Join-Path 的三参数形式（$PSScriptRoot '..' '..'）依赖 PowerShell 7+ 的
# -AdditionalChildPath；构建机是 Windows Server 2016 / PS 5.1，会抛
# "A positional parameter cannot be found that accepts argument '..'"，
# $repoRoot 因此为 null，随后 Set-Location 一并失败。改用 Split-Path 两次。
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

# 直接调本地 gulp/tsc，绕开 npx（npx 在 CI 无 stdin 时会交互式询问
# "Ok to proceed?" 从而无限挂起）。
$gulp = Join-Path $repoRoot 'node_modules\.bin\gulp.cmd'
$tsc = Join-Path $repoRoot 'node_modules\.bin\tsc.cmd'
if (-not (Test-Path $gulp)) { Write-Error "local gulp not found at $gulp"; exit 1 }
if (-not (Test-Path $tsc)) { Write-Error "local tsc not found at $tsc"; exit 1 }

& $gulp vscode-win32-x64 --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Packaging failed"; exit 1 }

# 自定义扩展 agent-studio 的 out/ 由 tsc 生成（gulp 扩展管线不认识它，且 out/ 被 .gitignore 排除）。
# 必须在预打包自愈之前产出，否则干净构建里自愈无源可拷。
# 详见 build/saros/strip-before-pack.mjs（2026-08-29 生产事故修复）。
Write-Host "Building custom extension: agent-studio (tsc)"
& $tsc -p extensions/agent-studio/tsconfig.json
if ($LASTEXITCODE -ne 0) { Write-Error "agent-studio tsc failed"; exit 1 }
if (-not (Test-Path "extensions/agent-studio/out/extension.js")) {
  Write-Error "extensions/agent-studio/out/extension.js not produced"; exit 1
}

# 预打包自愈：补齐 agent-studio/out、node_modules/typescript 等 gulp 不认识的构件。
# 缺失且无法自愈时脚本会 exit(1) 禁止带病出包。
node build/saros/strip-before-pack.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "strip-before-pack failed"; exit 1 }
