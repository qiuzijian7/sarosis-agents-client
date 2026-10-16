@echo off
setlocal

title VSCode Dev

pushd %~dp0\..

:: Get electron, compile, built-in extensions
if "%VSCODE_SKIP_PRELAUNCH%"=="" (
	node build/lib/preLaunch.ts
)

set "NAMESHORT="
for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"nameShort\":.*" product.json') do if not defined NAMESHORT set "NAMESHORT=%%~a"
set NAMESHORT=%NAMESHORT: "=%
set NAMESHORT=%NAMESHORT:"=%.exe
:: Try .build\electron first, then fall back to versioned dir
if exist ".build\electron\%NAMESHORT%" (
	set CODE=".build\electron\%NAMESHORT%"
) else if exist ".build\electron-v39.8.8\%NAMESHORT%" (
	set CODE=".build\electron-v39.8.8\%NAMESHORT%"
) else if exist ".build\electron-v39.8.7\%NAMESHORT%" (
	set CODE=".build\electron-v39.8.7\%NAMESHORT%"
) else (
	set CODE=".build\electron\%NAMESHORT%"
)

:: Manage built-in extensions
if "%~1"=="--builtin" goto builtin

:: Configuration
set NODE_ENV=development
set VSCODE_DEV=1
set VSCODE_CLI=1
set ELECTRON_ENABLE_LOGGING=1
set ELECTRON_ENABLE_STACK_DUMPING=1

:: [Saros] 同步写看门狗：定位"挂机后卡死"（主线程卡在 fs 同步写里，DLP 挡住了文件名取证）。
:: 通过 NODE_OPTIONS 预加载 scripts/hooks/sync-write-watchdog.cjs，包装 fs 同步写族并
:: 把 BEGIN/END 落到 %TEMP%\saros-syncwatch-<pid>-<role>.log —— 卡死时"没有配对 END 的
:: 最后一行 BEGIN"就是元凶（函数名+目标路径+调用栈）。关掉：set SAROSIS_SYNC_WRITE_WATCHDOG=0
if "%SAROSIS_SYNC_WRITE_WATCHDOG%"=="" set "SAROSIS_SYNC_WRITE_WATCHDOG=1"
if "%SAROSIS_SYNC_WRITE_WATCHDOG%"=="1" set "NODE_OPTIONS=%NODE_OPTIONS% --require %~dp0hooks\sync-write-watchdog.cjs"

set DISABLE_TEST_EXTENSION="--disable-extension=vscode.vscode-api-tests"
for %%A in (%*) do (
	if "%%~A"=="--extensionTestsPath" (
		set DISABLE_TEST_EXTENSION=""
	)
)

:: Launch Code
:: [Saros] Pass the repo root as an absolute path (`%CD%`) instead of `.` so
:: `app.getAppPath()` is absolute — the taskbar jump-list "New Window" task needs
:: an absolute app path to reload this app from an arbitrary cwd.
%CODE% "%CD%" %DISABLE_TEST_EXTENSION% %*
goto end

:builtin
%CODE% build/builtin

:end

popd

endlocal
