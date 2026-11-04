# 构建能力插件 transpile-plugins
# Join-Path 三参数形式需 PS 7+；构建机为 PS 5.1，改用 Split-Path 两次。
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$nvmNodeDir = ($env:LOCALAPPDATA + '\nvm\v22.22.1')
$env:PATH = ($nvmNodeDir + ';' + $env:PATH)
node build/next/index.ts transpile-plugins
if ($LASTEXITCODE -ne 0) { Write-Error "transpile-plugins failed"; exit 1 }
# 2026-11-04：AgentMemory 扩展已删除（记忆改由 dsh-plugins/vssaros-memory 提供），
# 不再有必须产出的能力插件，空清单属正常。
