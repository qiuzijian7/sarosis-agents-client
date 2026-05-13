cd "G:\CustomWorkspaces\AIProjects\sarosis-agents-client"
npm run compile 2>&1 | Out-File -FilePath "compile-full-output.txt" -Encoding UTF8
Get-Content "compile-full-output.txt" | Select-String -Pattern "Error:" -Context 0,5
