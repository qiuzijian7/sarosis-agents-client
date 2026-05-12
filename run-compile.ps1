param()
$ErrorActionPreference = "Continue"
cd "G:\CustomWorkspaces\AIProjects\sarosis-agents-client"
npm run compile 2>&1 | Out-File -FilePath "compile-latest.txt" -Encoding UTF8
Write-Host "编译完成，退出码: $LASTEXITCODE"
Get-Content "compile-latest.txt" -Tail 15
