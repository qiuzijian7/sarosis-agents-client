# 构建能力插件 transpile-plugins
$repoRoot = (Resolve-Path (Split-Path (Split-Path $PSScriptRoot))).Path
Set-Location $repoRoot

$nvmNodeDir = ($env:LOCALAPPDATA + '\nvm\v22.22.1')
$env:PATH = ($nvmNodeDir + ';' + $env:PATH)
node build/next/index.ts transpile-plugins
if ($LASTEXITCODE -ne 0) { Write-Error "transpile-plugins failed"; exit 1 }
if (-not (Test-Path "extensions/agentmemory-memory/dist/extension.js")) {
  Write-Error "agentmemory-memory/dist/extension.js not produced"; exit 1
}
