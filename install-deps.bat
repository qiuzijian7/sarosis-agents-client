@echo on
REM Run this from "x64 Native Tools Command Prompt for VS 2022"
REM REQUIRES: VS Installer -> Individual components -> Spectre mitigated libs (Latest)
REM
REM Usage:
REM   install-deps.bat                  -> 默认 x64，会执行 npm rebuild + 下载 Electron
REM   install-deps.bat arm64            -> 指定其他架构
REM   install-deps.bat x64 --skip-electron  -> 跳过 Step 2 (Electron 下载)，节省时间

cd /d "%~dp0"

REM 解析参数：%1 = arch（默认 x64），%2 = --skip-electron 时跳过 Step 2
set ARCH=%1
if "%ARCH%"=="" set ARCH=x64
if /I "%ARCH%"=="--skip-electron" (
    set ARCH=x64
    set SKIP_ELECTRON=1
)
if /I "%2"=="--skip-electron" set SKIP_ELECTRON=1

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set npm_config_registry=https://registry.npmmirror.com/
set GYP_MSVS_VERSION=2022

echo === Env check ===
echo VCINSTALLDIR=%VCINSTALLDIR%
where node >nul 2>&1
if errorlevel 1 (
    echo *** ERROR: node is not in PATH ***
    echo Run: nvm install 22.22.1  ^&^&  nvm use 22.22.1
    pause
    exit /b 1
)
node -v
where cl.exe >nul 2>&1
if errorlevel 1 (
    echo *** ERROR: cl.exe NOT in PATH! ***
    echo You are NOT in "x64 Native Tools Command Prompt for VS 2022".
    echo Open Start Menu -^> "Visual Studio 2022" -^> "x64 Native Tools Command Prompt for VS 2022"
    pause
    exit /b 1
)
echo cl.exe found, MSVC env OK
echo.

echo === Step 1: Force rebuild native modules using npm rebuild ===
echo This bypasses lock-file checks and forcibly recompiles each native module.
echo Output goes to install.log
echo.

REM npm rebuild <pkg> 会强制对 node_modules 中已存在的指定包跑 install script (node-gyp rebuild)
REM 即使 lock 显示 "up to date" 也照样编译。
REM 注意：必须用 Electron 39.8.8 的 headers 编译（否则 F5 启动会 NODE_MODULE_VERSION 不匹配）
set npm_config_target=39.8.8
set npm_config_runtime=electron
set npm_config_disturl=https://electronjs.org/headers
set npm_config_arch=x64
set npm_config_target_arch=x64
set npm_config_build_from_source=true

call npm rebuild ^
    @vscode/windows-registry ^
    @vscode/spdlog ^
    @vscode/windows-process-tree ^
    @vscode/deviceid ^
    @vscode/policy-watcher ^
    @vscode/native-watchdog ^
    native-keymap ^
    node-pty ^
    kerberos ^
    @parcel/watcher ^
    --foreground-scripts > install.log 2>&1
set REBUILD_EXIT=%ERRORLEVEL%

echo === npm rebuild exit code: %REBUILD_EXIT% ===
echo.
echo --- Compiler / gyp errors ---
powershell -NoProfile -Command "Get-Content install.log | Select-String -Pattern 'error C[0-9]|error MSB|fatal error|gyp ERR|node-gyp.*failed|Could not find|Cannot find|MSBUILD : error|EPERM|ENOENT' | Select-Object -First 40 LineNumber,Line | Format-Table -AutoSize -Wrap"
echo.
echo --- Native build attempts ---
powershell -NoProfile -Command "Get-Content install.log | Select-String -Pattern 'rebuild|node-gyp|cl : |cl\.exe|MSBuild|Building' | Select-Object -First 40 LineNumber,Line | Format-Table -AutoSize -Wrap"
echo.
echo --- Native module build status (Electron 39.8.8 target) ---
if exist "node_modules\@vscode\windows-registry\build\Release\winregistry.node" (
    echo [OK]      @vscode/windows-registry
) else (
    echo [MISSING] @vscode/windows-registry
)
if exist "node_modules\@vscode\spdlog\build\Release\spdlog.node" (
    echo [OK]      @vscode/spdlog
) else (
    echo [MISSING] @vscode/spdlog
)
if exist "node_modules\@vscode\windows-process-tree\build\Release\windows_process_tree.node" (
    echo [OK]      @vscode/windows-process-tree
) else (
    echo [MISSING] @vscode/windows-process-tree
)
if exist "node_modules\@vscode\deviceid\build\Release\windows.node" (
    echo [OK]      @vscode/deviceid
) else (
    echo [MISSING] @vscode/deviceid
)
if exist "node_modules\@vscode\policy-watcher\build\Release\vscode-policy-watcher.node" (
    echo [OK]      @vscode/policy-watcher
) else (
    echo [MISSING] @vscode/policy-watcher
)
if exist "node_modules\@vscode\native-watchdog\build\Release\watchdog.node" (
    echo [OK]      @vscode/native-watchdog
) else (
    echo [MISSING] @vscode/native-watchdog
)
if exist "node_modules\node-pty\build\Release\conpty.node" (
    echo [OK]      node-pty
) else (
    echo [MISSING] node-pty
)
if exist "node_modules\native-keymap\build\Release\keymapping.node" (
    echo [OK]      native-keymap
) else (
    echo [MISSING] native-keymap
)
if exist "node_modules\kerberos\build\Release\kerberos.node" (
    echo [OK]      kerberos
) else (
    echo [MISSING] kerberos
)
echo.
echo --- Last 40 lines of install.log ---
powershell -NoProfile -Command "Get-Content install.log | Select-Object -Last 40"
echo.

echo === Step 2: Download / Extract Electron binary (arch=%ARCH%) ===
if defined SKIP_ELECTRON (
    echo Skipped: --skip-electron specified.
    goto :after_electron
)
echo This will rimraf .build\electron\ and re-download Electron via @vscode/gulp-electron.
echo Mirror: %ELECTRON_MIRROR%
echo Output goes to electron-download.log
echo.

call node build/lib/electron.ts %ARCH% > electron-download.log 2>&1
set ELECTRON_EXIT=%ERRORLEVEL%
echo === Electron download exit code: %ELECTRON_EXIT% ===
echo.
echo --- Electron download errors (if any) ---
powershell -NoProfile -Command "Get-Content electron-download.log | Select-String -Pattern 'Error|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|404|403|HTTPError' | Select-Object -First 20 LineNumber,Line | Format-Table -AutoSize -Wrap"
echo.
echo --- Electron binary status ---
if exist ".build\electron\Code - OSS.exe" (
    for %%I in (".build\electron\Code - OSS.exe") do echo [OK]      .build\electron\Code - OSS.exe ^(size: %%~zI bytes^)
) else (
    echo [MISSING] .build\electron\Code - OSS.exe
)
if exist ".build\electron\version" (
    echo [INFO]    Electron version:
    type ".build\electron\version"
    echo.
)
echo.
echo --- Last 30 lines of electron-download.log ---
powershell -NoProfile -Command "Get-Content electron-download.log | Select-Object -Last 30"

:after_electron
echo.
echo === All done ===
pause
