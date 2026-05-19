@echo on
cd /d "%~dp0"

echo ============================================
echo Step 1: Production compile (with mangling)
echo ============================================
call npx gulp compile-build-with-mangling --verbose
if %ERRORLEVEL% neq 0 (
    echo Compile build failed! Trying dev compile instead...
    call npm run compile
    if %ERRORLEVEL% neq 0 (
        echo Compile failed! Exiting.
        exit /b 1
    )
)

echo.
echo ============================================
echo Step 2: Compile extensions (build)
echo ============================================
call npx gulp compile-extensions-build --verbose
if %ERRORLEVEL% neq 0 (
    echo Extensions build failed!
    exit /b 1
)

echo.
echo ============================================
echo Step 3: Package VS Code for Win32 x64
echo ============================================
call npx gulp vscode-win32-x64 --verbose
if %ERRORLEVEL% neq 0 (
    echo Packaging failed!
    exit /b 1
)

echo.
echo ============================================
echo Build complete!
echo ============================================
echo Output should be in: .build\win32-x64\
echo.
echo To create a user setup installer, run:
echo   npx gulp vscode-win32-x64-user-setup
echo.
pause
