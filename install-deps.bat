@echo off
setlocal EnableDelayedExpansion

REM --- 强制切到 UTF-8 代码页（脚本以 UTF-8 编码保存，确保无论用户 cmd 默认是 GBK 还是 UTF-8 都能正确显示中文）---
chcp 65001 >nul

REM ============================================================================
REM  sarosis-agents-client Windows 一键安装脚本
REM  -----------------------------------------------------------------
REM  必须从 "x64 Native Tools Command Prompt for VS 2022" 启动
REM  (开始菜单 -> Visual Studio 2022 -> x64 Native Tools Command Prompt for VS 2022)
REM
REM  Usage:
REM    install-deps.bat                       默认 x64，做完整流程
REM    install-deps.bat arm64                 指定其他架构
REM    install-deps.bat x64 --skip-electron   跳过 Electron 二进制下载
REM    install-deps.bat --check-only          只做预检查不安装
REM
REM  Stages:
REM    Stage 0: 交互式收集 GitHub Token / HTTPS_PROXY (可跳过)
REM    Stage 1: 9 项预检查 (只读)
REM    Stage 2: 安装 + 编译 (含 ripgrep 三级 fallback)
REM ============================================================================

cd /d "%~dp0"

REM --- 解析参数 ---
set ARCH=
set SKIP_ELECTRON=
set CHECK_ONLY=

:parse_args
if "%1"=="" goto :args_done
if /I "%1"=="--skip-electron" set SKIP_ELECTRON=1 & shift & goto :parse_args
if /I "%1"=="--check-only"    set CHECK_ONLY=1   & shift & goto :parse_args
if "%ARCH%"=="" set ARCH=%1
shift
goto :parse_args

:args_done
if "%ARCH%"=="" set ARCH=x64

REM --- 关键环境变量（先设上，后面 install/rebuild 都用得到）---
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set npm_config_registry=https://registry.npmmirror.com/
set GYP_MSVS_VERSION=2022

REM ============================================================================
REM  Stage 0: 交互式收集可选输入（GitHub Token / Proxy）
REM  ----------------------------------------------------------------
REM  这些不是必须的，但提前设上能避免后面踩 GitHub 403 / 网络不通的坑。
REM  --check-only 模式下也会问，因为 Check 9 需要它们才能给出准确判断。
REM ============================================================================
echo.
echo ============================================================
echo  Stage 0: OPTIONAL INPUT
echo ============================================================
echo.
echo The next checks/install may hit GitHub API ^(@vscode/ripgrep
echo postinstall^). Anonymous limit is 60 req/hr and easily triggers 403.
echo You can optionally provide:
echo   * GITHUB_TOKEN ^(no scope needed^) -^> raises limit to 5000 req/hr
echo   * HTTPS_PROXY                    -^> if your network needs proxy
echo.

REM --- GitHub Token ---
if defined GITHUB_TOKEN (
    echo [GITHUB_TOKEN] already set in environment, skipping prompt.
) else (
    choice /C YN /N /M "Provide a GitHub token now? (Y/N) "
    if errorlevel 2 (
        echo [GITHUB_TOKEN] skipped. Anonymous mode ^(may hit 403^).
    ) else (
        echo Generate a token at: https://github.com/settings/tokens
        echo ^(no scopes required, used only for rate limit^)
        set /p GITHUB_TOKEN="Paste GITHUB_TOKEN (or empty to skip): "
        if defined GITHUB_TOKEN (
            echo [GITHUB_TOKEN] set for this session.
        ) else (
            echo [GITHUB_TOKEN] empty input, anonymous mode.
        )
    )
)
echo.

REM --- HTTPS Proxy ---
if defined HTTPS_PROXY (
    echo [HTTPS_PROXY] already set: !HTTPS_PROXY!
) else (
    choice /C YN /N /M "Configure HTTPS_PROXY for this session? (Y/N) "
    if errorlevel 2 (
        echo [HTTPS_PROXY] skipped.
    ) else (
        set /p HTTPS_PROXY="Enter proxy URL (e.g. http://127.0.0.1:7890): "
        if defined HTTPS_PROXY (
            set HTTP_PROXY=!HTTPS_PROXY!
            echo [HTTPS_PROXY] set: !HTTPS_PROXY!
        ) else (
            echo [HTTPS_PROXY] empty input, no proxy.
        )
    )
)
echo.
echo Stage 0 done. Starting checks...
echo.

REM ============================================================================
REM  Stage 1: 预检查（只检查不修改任何文件）
REM ============================================================================
echo.
echo ============================================================
echo  Stage 1: PRE-FLIGHT CHECKS
echo ============================================================
echo.

set CHECK_FAILED=0
set WARN_COUNT=0

REM --- Check 1: 当前是否在 x64 Native Tools Command Prompt 里 ---
echo [Check 1] x64 Native Tools Command Prompt for VS 2022
where cl.exe >nul 2>&1
if errorlevel 1 (
    echo   [FAIL] cl.exe NOT in PATH.
    echo          You are NOT in "x64 Native Tools Command Prompt for VS 2022".
    echo          Open Start Menu -^> "Visual Studio 2022" -^>
    echo            "x64 Native Tools Command Prompt for VS 2022"
    echo          and re-run this script from there.
    set /a CHECK_FAILED+=1
) else (
    echo   [OK]   cl.exe found in PATH
    if defined VCINSTALLDIR (
        echo          VCINSTALLDIR=!VCINSTALLDIR!
    )
)
echo.

REM --- Check 2: Node.js 版本（必须 22.x，匹配 .nvmrc） ---
echo [Check 2] Node.js version (must be 22.x to match .nvmrc)
where node >nul 2>&1
if errorlevel 1 (
    echo   [FAIL] node not in PATH.
    REM --- 诊断 a: PATH 里是否有未展开的 %%NVM_HOME%%/%%NVM_SYMLINK%% 字面量
    echo !PATH! | findstr /C:"%%NVM_HOME%%" >nul
    if not errorlevel 1 (
        echo   [DIAG] Detected literal %%NVM_HOME%% / %%NVM_SYMLINK%% in PATH ^(not expanded^).

        REM --- 诊断 a.1: NVM_HOME 是否实际存在
        if defined NVM_HOME (
            echo          NVM_HOME      = !NVM_HOME!
            echo          NVM_SYMLINK   = !NVM_SYMLINK!
            echo          ^(env vars are set, so the issue is PATH registry type^)

            REM --- 诊断 a.2: 用户 PATH 注册表类型
            for /f "tokens=2*" %%a in ('reg query "HKCU\Environment" /v Path 2^>nul ^| findstr /R "REG_") do (
                echo          User PATH registry type: %%a
                if "%%a"=="REG_SZ" (
                    echo   [FIX]  Run this in PowerShell ^(no admin needed^) to fix it permanently:
                    echo.
                    echo            $p = ^(Get-ItemProperty 'HKCU:\Environment' -Name Path^).Path
                    echo            Remove-ItemProperty 'HKCU:\Environment' -Name Path
                    echo            New-ItemProperty 'HKCU:\Environment' -Name Path -Value $p -PropertyType ExpandString ^| Out-Null
                    echo.
                    echo          Then CLOSE ALL TERMINALS ^(including IDE^) and reopen
                    echo          "x64 Native Tools Command Prompt for VS 2022".
                )
                if "%%a"=="REG_EXPAND_SZ" (
                    echo          User PATH type is OK ^(REG_EXPAND_SZ^), but %%NVM_HOME%% still
                    echo          appears literal. Likely you are in an OLD terminal opened
                    echo          BEFORE the env was fixed. Close ALL terminals and reopen.
                )
            )
        ) else (
            echo          NVM_HOME / NVM_SYMLINK env vars are NOT set.
            echo   [FIX]  Re-run nvm-windows installer ^(will set them^), OR add USER env vars:
            echo            NVM_HOME    = C:\Users\^<you^>\AppData\Roaming\nvm
            echo            NVM_SYMLINK = C:\Users\^<you^>\AppData\Roaming\nvm\nodejs
            echo          Then close ALL terminals and reopen.
        )
    ) else (
        REM --- 诊断 b: nvm 命令在不在
        where nvm >nul 2>&1
        if errorlevel 1 (
            echo   [DIAG] nvm command also NOT in PATH.
            echo   [FIX]  Install nvm-windows from:
            echo            https://github.com/coreybutler/nvm-windows/releases
        ) else (
            echo   [DIAG] nvm exists but no active node version.
            echo   [FIX]  Run: nvm install 22.22.1 ^&^& nvm use 22.22.1
        )
    )
    set /a CHECK_FAILED+=1
    goto :check_node_done
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo   Detected: !NODE_VER!
echo !NODE_VER! | findstr /R "^v22\." >nul
if errorlevel 1 (
    echo   [FAIL] Node version is NOT 22.x.
    echo          .nvmrc requires 22.22.1. Run: nvm use 22.22.1
    set /a CHECK_FAILED+=1
) else (
    echo   [OK]   Node version OK
)
:check_node_done
echo.

REM --- Check 3: PATH 里是否有原生 Node 与 nvm 冲突 ---
echo [Check 3] PATH conflict (native Node vs nvm-windows)
set NODE_PATH_COUNT=0
for /f "delims=" %%p in ('where node 2^>nul') do (
    set /a NODE_PATH_COUNT+=1
    set NODE_PATH_!NODE_PATH_COUNT!=%%p
)
if !NODE_PATH_COUNT! GTR 1 (
    echo   [WARN] Multiple node.exe found in PATH:
    for /l %%i in (1,1,!NODE_PATH_COUNT!) do echo            !NODE_PATH_%%i!
    echo          If one of them is "C:\Program Files\nodejs\", uninstall the
    echo          standalone Node.js from Control Panel ^(keep nvm-windows^).
    echo          Otherwise nvm use will be silently overridden.
    set /a WARN_COUNT+=1
) else (
    echo   [OK]   Only one node.exe in PATH
)
echo.

REM --- Check 4: npm 版本（必须 < 11.2.0） ---
echo [Check 4] npm version (must be ^< 11.2.0, project preinstall.ts requirement)
for /f "tokens=*" %%v in ('npm -v 2^>nul') do set NPM_VER=%%v
echo   Detected: !NPM_VER!
for /f "tokens=1,2 delims=." %%a in ("!NPM_VER!") do (
    set NPM_MAJOR=%%a
    set NPM_MINOR=%%b
)
set NPM_OK=1
if !NPM_MAJOR! GTR 11 set NPM_OK=0
if !NPM_MAJOR! EQU 11 if !NPM_MINOR! GEQ 2 set NPM_OK=0
if !NPM_OK! EQU 0 (
    echo   [FAIL] npm !NPM_VER! is too new.
    echo          Run: npm install -g npm@10
    set /a CHECK_FAILED+=1
) else (
    echo   [OK]   npm version OK
)
echo.

REM --- Check 5: VS2022 安装位置（用 vswhere）---
echo [Check 5] Visual Studio 2022 installation
set VSWHERE="C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
set VS_INSTALL_PATH=
if not exist %VSWHERE% (
    echo   [FAIL] vswhere.exe not found ^(VS Installer not installed^).
    set /a CHECK_FAILED+=1
    goto :check_vs_done
)
for /f "usebackq tokens=*" %%i in (`%VSWHERE% -latest -products * -requires Microsoft.VisualStudio.Workload.NativeDesktop -property installationPath 2^>nul`) do set VS_INSTALL_PATH=%%i
if "!VS_INSTALL_PATH!"=="" (
    echo   [FAIL] No VS 2022 with "Desktop development with C++" workload found.
    echo          VS Installer -^> Modify -^> Workloads -^>
    echo            "Desktop development with C++"
    set /a CHECK_FAILED+=1
    goto :check_vs_done
)
echo   [OK]   VS install path: !VS_INSTALL_PATH!
:check_vs_done
echo.

REM --- Check 6: Spectre mitigation libraries 完整性 ---
echo [Check 6] Spectre mitigation libraries
if "!VS_INSTALL_PATH!"=="" (
    echo   [SKIP] Cannot check without VS install path
    goto :check_spectre_done
)
set MSVC_ROOT=!VS_INSTALL_PATH!\VC\Tools\MSVC
set DEFAULT_TOOLS_FILE=!VS_INSTALL_PATH!\VC\Auxiliary\Build\Microsoft.VCToolsVersion.default.txt
if not exist "!DEFAULT_TOOLS_FILE!" (
    echo   [FAIL] Cannot find Microsoft.VCToolsVersion.default.txt
    set /a CHECK_FAILED+=1
    goto :check_spectre_done
)
set /p VCTOOLS_VER=<"!DEFAULT_TOOLS_FILE!"
echo   Default VCToolsVersion: !VCTOOLS_VER!

set SPECTRE_DIR=!MSVC_ROOT!\!VCTOOLS_VER!\lib\spectre\x64
set SPECTRE_ATL_DIR=!MSVC_ROOT!\!VCTOOLS_VER!\atlmfc\lib\spectre\x64
set SPECTRE_OK=1

if not exist "!SPECTRE_DIR!\libcmt.lib" (
    echo   [FAIL] Spectre libcmt.lib NOT found at:
    echo            !SPECTRE_DIR!
    set SPECTRE_OK=0
)
if not exist "!SPECTRE_ATL_DIR!\atls.lib" (
    echo   [FAIL] Spectre ATL atls.lib NOT found at:
    echo            !SPECTRE_ATL_DIR!
    set SPECTRE_OK=0
)
if !SPECTRE_OK! EQU 0 (
    echo          VS Installer -^> Modify -^> Individual Components -^>
    echo            search "Spectre" and check ALL of:
    echo            * MSVC v143 - VS 2022 C++ x64/x86 Spectre mitigated libs
    echo            * MSVC v143 - VS 2022 C++ ATL ^(x86/x64^) Spectre mitigated libs
    echo            * MSVC v143 - VS 2022 C++ MFC ^(x86/x64^) Spectre mitigated libs
    set /a CHECK_FAILED+=1
) else (
    echo   [OK]   Spectre libs present ^(libcmt.lib + atls.lib^)
)
:check_spectre_done
echo.

REM --- Check 7: 旧版 v143 工具集 (14.38.x) 是否会干扰 ---
echo [Check 7] Stale v143 toolset (14.38.x has empty Spectre folder)
if "!MSVC_ROOT!"=="" goto :check_stale_done
set HAS_STALE=0
for /d %%d in ("!MSVC_ROOT!\14.38.*") do (
    set HAS_STALE=1
    set STALE_PATH=%%d
)
if !HAS_STALE! EQU 1 (
    if not exist "!STALE_PATH!\lib\spectre\x64\libcmt.lib" (
        echo   [WARN] Found stale v143 toolset !STALE_PATH! WITHOUT Spectre libs.
        echo          MSBuild may pick this version and report MSB8040 even when
        echo          14.44.x is installed. Recommendation:
        echo          VS Installer -^> Modify -^> Individual Components -^>
        echo            search "14.38" -^> uncheck all v143 14.38.x build tools.
        set /a WARN_COUNT+=1
    ) else (
        echo   [OK]   14.38.x present but has Spectre libs ^(safe^)
    )
) else (
    echo   [OK]   No stale v143 14.38.x toolset
)
:check_stale_done
echo.

REM --- Check 8: Python 3 (node-gyp 需要：python 或 py launcher 任一可用即可) ---
echo [Check 8] Python 3 ^(required by node-gyp; "python" or "py" both OK^)
set PY_CMD=
where python >nul 2>&1
if not errorlevel 1 (
    set PY_CMD=python
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do echo   [OK]   python OK ^(%%v^)
    goto :check_python_done
)
where py >nul 2>&1
if not errorlevel 1 (
    set PY_CMD=py
    for /f "tokens=*" %%v in ('py --version 2^>^&1') do echo   [OK]   py launcher OK ^(%%v^), node-gyp will use it
    goto :check_python_done
)

REM --- 都找不到才报 FAIL，并尝试自动诊断 ---
echo   [FAIL] Neither "python" nor "py" found in PATH.

set FOUND_PY=
for %%d in (
    "%LOCALAPPDATA%\Programs\Python\Python313"
    "%LOCALAPPDATA%\Programs\Python\Python312"
    "%LOCALAPPDATA%\Programs\Python\Python311"
    "%LOCALAPPDATA%\Programs\Python\Python310"
    "C:\Python313"
    "C:\Python312"
    "C:\Python311"
    "C:\Python310"
    "C:\Program Files\Python313"
    "C:\Program Files\Python312"
    "C:\Program Files\Python311"
    "C:\Program Files\Python310"
) do (
    if exist "%%~d\python.exe" (
        if not defined FOUND_PY set FOUND_PY=%%~d
    )
)

if defined FOUND_PY (
    echo   [DIAG] Found python.exe at: !FOUND_PY!
    echo   [FIX]  Add to user PATH ^(PowerShell, no admin needed^):
    echo.
    echo            $py = '!FOUND_PY!'
    echo            $old = ^(Get-ItemProperty 'HKCU:\Environment' -Name Path^).Path
    echo            $new = "$py;$py\Scripts;$old"
    echo            Remove-ItemProperty 'HKCU:\Environment' -Name Path
    echo            New-ItemProperty 'HKCU:\Environment' -Name Path -Value $new -PropertyType ExpandString ^| Out-Null
    echo.
    echo          Then close all terminals and reopen.
) else (
    echo   [DIAG] No Python install found in common locations.
    echo   [FIX]  Install Python 3.x from https://www.python.org/
    echo          ^(check "Add Python to PATH" during install^)
)
set /a CHECK_FAILED+=1

:check_python_done
echo.

REM --- Check 9: GitHub API 连通性 + token (ripgrep / electron 等 postinstall 必备) ---
echo [Check 9] GitHub API access ^(needed by @vscode/ripgrep postinstall^)
set GH_AUTH_HEADER=
if defined GITHUB_TOKEN (
    set GH_AUTH_HEADER=-H "Authorization: token %GITHUB_TOKEN%"
    echo   [INFO] GITHUB_TOKEN detected, will use authenticated API ^(5000 req/hr^)
) else (
    echo   [INFO] GITHUB_TOKEN NOT set. Anonymous limit is 60 req/hr,
    echo          which can hit 403 during ripgrep postinstall.
    echo          If you hit a 403 later, generate a token at:
    echo            https://github.com/settings/tokens
    echo          ^(no scopes needed^), then run:  set GITHUB_TOKEN=ghp_xxx
)
REM 用 PowerShell 探测 GitHub API（curl 在某些 Windows 上没装）
for /f "delims=" %%c in ('powershell -NoProfile -Command "try { (Invoke-WebRequest -Uri 'https://api.github.com/rate_limit' -UseBasicParsing -TimeoutSec 8).StatusCode } catch { 'FAIL' }" 2^>nul') do set GH_STATUS=%%c
if "!GH_STATUS!"=="200" (
    echo   [OK]   api.github.com reachable
    REM 如果有 token，验证有效性并显示剩余配额
    for /f "delims=" %%r in ('powershell -NoProfile -Command "try { $h=@{}; if($env:GITHUB_TOKEN){$h['Authorization']='token '+$env:GITHUB_TOKEN}; $r=(Invoke-RestMethod -Uri 'https://api.github.com/rate_limit' -Headers $h -TimeoutSec 8); '{0}/{1}' -f $r.rate.remaining,$r.rate.limit } catch { 'unknown' }" 2^>nul') do echo          rate limit remaining: %%r
) else (
    echo   [WARN] Cannot reach api.github.com ^(status=!GH_STATUS!^).
    echo          ripgrep postinstall may fail with 403/timeout.
    echo          Mitigations:
    echo            1. Set proxy:  set HTTPS_PROXY=http://your.proxy:port
    echo            2. Set token:  set GITHUB_TOKEN=ghp_xxx
    echo            3. Pre-place rg.exe at node_modules\@vscode\ripgrep\bin\rg.exe
    set /a WARN_COUNT+=1
)
echo.

REM --- 预检查总结 ---
echo ============================================================
echo  Pre-flight summary: !CHECK_FAILED! failure(s), !WARN_COUNT! warning(s)
echo ============================================================
if !CHECK_FAILED! GTR 0 (
    echo.
    echo Please fix the [FAIL] items above and re-run this script.
    pause
    exit /b 1
)
if defined CHECK_ONLY (
    echo Check-only mode finished. Exiting without installing.
    pause
    exit /b 0
)
if !WARN_COUNT! GTR 0 (
    echo.
    echo Warnings detected. You can proceed but may hit issues.
    choice /C YN /M "Continue with install?"
    if errorlevel 2 exit /b 1
)
echo.

REM ============================================================================
REM  Stage 2: 安装与编译
REM ============================================================================
echo.
echo ============================================================
echo  Stage 2: INSTALL ^& BUILD (arch=%ARCH%)
echo ============================================================
echo.

REM --- 设 Electron headers 编译目标（关键，否则 ABI 不匹配启动崩溃）---
set npm_config_target=39.8.8
set npm_config_runtime=electron
set npm_config_disturl=https://electronjs.org/headers
set npm_config_arch=%ARCH%
set npm_config_target_arch=%ARCH%
set npm_config_build_from_source=true

REM --- Step 2.0: 如果 node_modules 不存在，跑完整 npm install ---
if not exist "node_modules\package.json" (
    echo === Step 2.0: node_modules empty, running full npm install ===
    echo Output goes to install-full.log
    call npm install --foreground-scripts > install-full.log 2>&1
    set INSTALL_EXIT=!ERRORLEVEL!
    echo === npm install exit code: !INSTALL_EXIT! ===
    if !INSTALL_EXIT! NEQ 0 (
        echo.
        echo --- Last 40 lines of install-full.log ---
        powershell -NoProfile -Command "Get-Content install-full.log | Select-Object -Last 40"
    )
    echo.
)

REM --- Step 2.1: 强制 rebuild 所有 14 个 native 模块 ---
echo === Step 2.1: Force rebuild ALL native modules ===
echo Output goes to install.log
echo.

call npm rebuild ^
    @parcel/watcher ^
    @vscode/native-watchdog ^
    @vscode/policy-watcher ^
    @vscode/spdlog ^
    @vscode/windows-process-tree ^
    @vscode/windows-registry ^
    @vscode/deviceid ^
    @vscode/sqlite3 ^
    @vscode/windows-mutex ^
    @vscode/windows-ca-certs ^
    kerberos ^
    native-keymap ^
    node-pty ^
    windows-foreground-love ^
    --foreground-scripts > install.log 2>&1
set REBUILD_EXIT=!ERRORLEVEL!

echo === npm rebuild exit code: !REBUILD_EXIT! ===
echo.
echo --- Compiler / gyp errors ^(if any^) ---
powershell -NoProfile -Command "Get-Content install.log | Select-String -Pattern 'error C[0-9]|error MSB|fatal error|gyp ERR|node-gyp.*failed|Could not find|MSBUILD : error|EPERM|ENOENT' | Select-Object -First 40 LineNumber,Line | Format-Table -AutoSize -Wrap"
echo.

REM --- Step 2.2: 修复 ripgrep 二进制（GitHub 403 兜底，3 级 fallback）---
echo === Step 2.2: Verify @vscode/ripgrep binary ===
set MAIN_RG=node_modules\@vscode\ripgrep\bin\rg.exe
set BUILD_RG=build\node_modules\@vscode\ripgrep\bin\rg.exe
set RG_FIXED=0

if exist "!MAIN_RG!" (
    echo   [OK]   !MAIN_RG! exists ^(size:^)
    for %%I in ("!MAIN_RG!") do echo            %%~zI bytes
    goto :rg_done
)

echo   [WARN] !MAIN_RG! missing ^(typical cause: GitHub API 403 during postinstall^)

REM Fallback 1: 复制 build 子目录的同版本 rg.exe
if exist "!BUILD_RG!" (
    if not exist "node_modules\@vscode\ripgrep\bin" mkdir "node_modules\@vscode\ripgrep\bin"
    copy /Y "!BUILD_RG!" "!MAIN_RG!" >nul
    if exist "!MAIN_RG!" (
        echo   [FIX]  Fallback 1: copied from !BUILD_RG!
        set RG_FIXED=1
        goto :rg_done
    )
)

REM Fallback 2: 重跑 ripgrep 的 postinstall（带 GITHUB_TOKEN 提升 rate limit）
echo   [TRY]  Fallback 2: re-run @vscode/ripgrep postinstall
if not defined GITHUB_TOKEN (
    echo          ^(Tip: set GITHUB_TOKEN before retrying to avoid 60 req/hr limit^)
)
pushd "node_modules\@vscode\ripgrep" 2>nul
if errorlevel 1 (
    echo          @vscode/ripgrep package not installed. Run npm install first.
    goto :rg_fail
)
call node lib\postinstall.js > "%~dp0ripgrep-postinstall.log" 2>&1
set RG_RETRY_EXIT=!ERRORLEVEL!
popd
if exist "!MAIN_RG!" (
    echo   [FIX]  Fallback 2: postinstall succeeded
    set RG_FIXED=1
    goto :rg_done
)

REM Fallback 3: 直接从 GitHub 下载 ripgrep 15.0.0 prebuilt
echo   [TRY]  Fallback 3: direct download ripgrep 15.0.0 from GitHub
if not exist "node_modules\@vscode\ripgrep\bin" mkdir "node_modules\@vscode\ripgrep\bin"
set RG_URL=https://github.com/microsoft/ripgrep-prebuilt/releases/download/v15.0.0/ripgrep-v15.0.0-x86_64-pc-windows-msvc.zip
set RG_ZIP=%TEMP%\ripgrep-prebuilt.zip
powershell -NoProfile -Command "try { $h=@{}; if($env:GITHUB_TOKEN){$h['Authorization']='token '+$env:GITHUB_TOKEN}; Invoke-WebRequest -Uri '%RG_URL%' -OutFile '%RG_ZIP%' -Headers $h -UseBasicParsing -TimeoutSec 60; Expand-Archive -Path '%RG_ZIP%' -DestinationPath '%TEMP%\ripgrep-extract' -Force; Copy-Item -Path '%TEMP%\ripgrep-extract\rg.exe' -Destination '%CD%\!MAIN_RG!' -Force; Remove-Item -Recurse -Force '%TEMP%\ripgrep-extract','%RG_ZIP%' } catch { Write-Error $_; exit 1 }"
if exist "!MAIN_RG!" (
    echo   [FIX]  Fallback 3: downloaded from GitHub
    set RG_FIXED=1
    goto :rg_done
)

:rg_fail
echo   [FAIL] All 3 fallbacks failed. Manual fix:
echo          1. Get rg.exe ^(any source, ripgrep 14.x or 15.x^)
echo          2. Place at: %CD%\!MAIN_RG!
echo          Without this, Electron will start but CSS will fail to load
echo          ^(blank/broken layout, "MIME type text/css" errors in DevTools^).

:rg_done
REM 验证 rg.exe 能跑
if exist "!MAIN_RG!" (
    "!MAIN_RG!" --version >nul 2>&1
    if errorlevel 1 (
        echo   [FAIL] rg.exe present but cannot execute ^(corrupt download?^).
        echo          Delete it and re-run this script.
    ) else (
        for /f "tokens=*" %%v in ('"!MAIN_RG!" --version 2^>nul ^| findstr /R "^ripgrep"') do echo   [VERIFY] %%v
    )
)
echo.

REM --- Step 2.3: 盘点所有 14 个 native 模块 ---
echo === Step 2.3: Native module status (Electron 39.8.8 target) ===
set MISSING_COUNT=0
call :check_native "@parcel/watcher"            "node_modules\@parcel\watcher\build\Release\watcher.node"
call :check_native "@vscode/native-watchdog"    "node_modules\@vscode\native-watchdog\build\Release\watchdog.node"
call :check_native "@vscode/policy-watcher"     "node_modules\@vscode\policy-watcher\build\Release\vscode-policy-watcher.node"
call :check_native "@vscode/spdlog"             "node_modules\@vscode\spdlog\build\Release\spdlog.node"
call :check_native "@vscode/windows-process-tree" "node_modules\@vscode\windows-process-tree\build\Release\windows_process_tree.node"
call :check_native "@vscode/windows-registry"   "node_modules\@vscode\windows-registry\build\Release\winregistry.node"
call :check_native "@vscode/deviceid"           "node_modules\@vscode\deviceid\build\Release\windows.node"
call :check_native "@vscode/sqlite3"            "node_modules\@vscode\sqlite3\build\Release\vscode-sqlite3.node"
call :check_native "@vscode/windows-mutex"      "node_modules\@vscode\windows-mutex\build\Release\CreateMutex.node"
call :check_native "@vscode/windows-ca-certs"   "node_modules\@vscode\windows-ca-certs\build\Release\crypt32.node"
call :check_native "kerberos"                   "node_modules\kerberos\build\Release\kerberos.node"
call :check_native "native-keymap"              "node_modules\native-keymap\build\Release\keymapping.node"
call :check_native "node-pty"                   "node_modules\node-pty\build\Release\conpty.node"
call :check_native "windows-foreground-love"    "node_modules\windows-foreground-love\build\Release\foreground_love.node"
echo.
if !MISSING_COUNT! GTR 0 (
    echo --- Last 40 lines of install.log ^(check for errors^) ---
    powershell -NoProfile -Command "Get-Content install.log | Select-Object -Last 40"
    echo.
)

REM --- Step 2.4: Electron 二进制下载 ---
if defined SKIP_ELECTRON (
    echo === Step 2.4: SKIPPED ^(--skip-electron^) ===
    goto :after_electron
)
echo === Step 2.4: Download Electron binary (arch=%ARCH%) ===
echo Mirror: %ELECTRON_MIRROR%
echo Output goes to electron-download.log
echo.

call node build/lib/electron.ts %ARCH% > electron-download.log 2>&1
set ELECTRON_EXIT=!ERRORLEVEL!
echo === Electron download exit code: !ELECTRON_EXIT! ===
echo.
echo --- Electron download errors ^(if any^) ---
powershell -NoProfile -Command "Get-Content electron-download.log | Select-String -Pattern 'Error|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|404|403|HTTPError' | Select-Object -First 20 LineNumber,Line | Format-Table -AutoSize -Wrap"
echo.
if exist ".build\electron\Code - OSS.exe" (
    for %%I in (".build\electron\Code - OSS.exe") do echo [OK]      .build\electron\Code - OSS.exe ^(size: %%~zI bytes^)
) else (
    echo [MISSING] .build\electron\Code - OSS.exe
    echo --- Last 30 lines of electron-download.log ---
    powershell -NoProfile -Command "Get-Content electron-download.log | Select-Object -Last 30"
)
if exist ".build\electron\version" (
    echo [INFO]    Electron version:
    type ".build\electron\version"
    echo.
)

:after_electron
echo.
echo ============================================================
echo  All done. Missing native modules: !MISSING_COUNT!
echo ============================================================
echo.
echo Next steps:
echo   1. npm run watch       ^(keep terminal open until "Finished compilation"^)
echo   2. F5 in VSCode, or run scripts\code.bat
echo.
pause
exit /b 0


REM ============================================================================
REM  子函数：检查单个 native 模块产物
REM    %~1 = display name, %~2 = .node path
REM ============================================================================
:check_native
if exist "%~2" (
    echo   [OK]      %~1
) else (
    echo   [MISSING] %~1
    set /a MISSING_COUNT+=1
)
exit /b 0
