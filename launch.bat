@echo off
cd /d g:\CustomWorkspaces\AIProjects\sarosis-agents-client
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
".build\electron\Code - OSS.exe" . 2>stderr2.txt 1>stdout2.txt
echo Exit code: %ERRORLEVEL% > exitcode.txt
