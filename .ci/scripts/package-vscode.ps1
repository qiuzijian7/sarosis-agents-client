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

# 构建期预装 dsh 运行时（`/dsh-runtime/` 被 .gitignore ⇒ CI / 干净检出里**没有**它）：
# 缺它 ⇒ 装出来首启弹「需要准备 DeepSeek Harness 运行环境」（2026-10-16 用户报"打包出的 vssaros.exe
# 无法找到 dsh"）。必须在 gulp **之前**跑：gulp 的 dshRuntime 资源流是 allowEmpty（有意允许 dev 跳过），
# 而 <appPath>/dsh-runtime 是"首启零下载"的唯一来源 ⇒ 不预装就是静默出一个坏包 ✗✗。
# 幂等（已有同版 bin.js 时跳过安装）；strip-before-pack 阶段还有一道硬门兜底。
Write-Host "Prepacking bundled dsh runtime"
node build/prepack-dsh-runtime.mjs
if ($LASTEXITCODE -ne 0) { Write-Error "prepack-dsh-runtime failed"; exit 1 }

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
