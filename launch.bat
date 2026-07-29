@echo off
cd /d "%~dp0"
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set VSCODE_SKIP_PRELAUNCH=1
set VSCODE_DEV_DEBUG_OBSERVABLES=1
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

del stdout2.txt stderr2.txt exitcode.txt 2>nul

".build\electron\Code - OSS.exe" . ^
  --inspect=5875 ^
  --remote-debugging-port=9222 ^
  --no-cached-data ^
  --crash-reporter-directory="%~dp0.profile-oss\crashes" ^
  --disable-features=CalculateNativeWinOcclusion ^
  --disable-extension=vscode.vscode-api-tests ^
  --skip-sessions-welcome ^
  --agents ^
  --user-data-dir="%USERPROFILE%\.vssaros-dev" ^
  1>stdout2.txt 2>stderr2.txt

echo Exit code: %ERRORLEVEL% > exitcode.txt
echo.
echo === Exit code: %ERRORLEVEL% ===
echo.
echo === stderr2.txt (last lines) ===
powershell -Command "if (Test-Path stderr2.txt) { Get-Content stderr2.txt | Select-Object -Last 40 }"
echo.
echo === stdout2.txt (last lines) ===
powershell -Command "if (Test-Path stdout2.txt) { Get-Content stdout2.txt | Select-Object -Last 40 }"
pause
