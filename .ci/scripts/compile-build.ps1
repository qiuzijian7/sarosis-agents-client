# 生产编译 compile-build-with-mangling
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
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

npx gulp compile-build-with-mangling --verbose
if ($LASTEXITCODE -ne 0) {
  Write-Host "compile-build-with-mangling failed, fallback to dev compile..."
  npm run compile
  if ($LASTEXITCODE -ne 0) { Write-Error "Compile failed"; exit 1 }
}
