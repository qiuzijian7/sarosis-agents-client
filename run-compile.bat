@echo off
cd /d G:\CustomWorkspaces\AIProjects\sarosis-agents-client
npm run compile > compile-latest.txt 2>&1
echo Exit code: %ERRORLEVEL%
type compile-latest.txt | findstr /C:"Finished compilation" /C:"errors"
