# 生成 EXE 安装包 (user & system setup)
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..' '..')).Path
Set-Location $repoRoot

npx gulp vscode-win32-x64-inno-updater --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "Inno updater setup failed"; exit 1 }
Start-Sleep -Seconds 5
npx gulp vscode-win32-x64-user-setup --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "User setup failed"; exit 1 }
Start-Sleep -Seconds 5
npx gulp vscode-win32-x64-system-setup --verbose
if ($LASTEXITCODE -ne 0) { Write-Error "System setup failed"; exit 1 }
