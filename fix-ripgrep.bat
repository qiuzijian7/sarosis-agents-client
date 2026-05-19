@echo on
REM Run this AFTER install-deps.bat fails on ripgrep 403.
REM
REM Step 1 (one-time): Get a GitHub token (no scopes needed):
REM     https://github.com/settings/tokens -> Generate new token (classic)
REM     -> Note: ripgrep-download -> Expiration: 7 days -> no scopes -> Generate
REM
REM Step 2: In the same VS Developer Prompt:
REM     set GITHUB_TOKEN=ghp_paste_your_token_here
REM     fix-ripgrep.bat

cd /d "%~dp0"

if not defined GITHUB_TOKEN (
    echo ERROR: GITHUB_TOKEN is not set.
    echo Run: set GITHUB_TOKEN=ghp_xxx
    pause
    exit /b 1
)

echo === Downloading @vscode/ripgrep binary ===
cd node_modules\@vscode\ripgrep
call node ./lib/postinstall.js
set RG_EXIT=%ERRORLEVEL%
cd /d "%~dp0"

echo === Done. Exit code: %RG_EXIT% ===
if "%RG_EXIT%"=="0" (
    echo SUCCESS - ripgrep binary downloaded
) else (
    echo FAILED - check error above
)
pause
