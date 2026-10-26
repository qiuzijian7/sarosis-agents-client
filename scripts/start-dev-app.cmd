@echo off
rem ============================================================================
rem Launch the dev app detached (this script returns immediately) so that
rem F5 -> "Launch & Attach Dev (9222)" can attach instead of launching.
rem
rem Why detached + attach: js-debug's `launch` request tears the browser down
rem when the debug session ends (cleanUp: wholeBrowser), which looked exactly
rem like "the app closes itself a few seconds after F5". Attach never does that.
rem
rem The real work lives in start-dev-app.mjs, which also records HOW the app
rem died (exit code + signal) into %USERPROFILE%\.vssaros-dev\logs\app-exit.log.
rem
rem ★★ 2026-10-25（用户报「F5 无法启动」）——根因一：本脚本阻塞 preLaunchTask
rem   `start "" /b node ...` 让子进程共享当前控制台并继承 std 句柄；启动器又要常驻记录
rem   退出码 ⇒ 父进程 stdout 管道永远拿不到 EOF ⇒ VS Code 认为任务没结束 ⇒ 卡在
rem   "启动 preLaunchTask…"。现改为 node detached spawn（spawn-detached.mjs）。
rem
rem ★★ 2026-10-25（用户报「F5 没有反应」）——根因二：`node` 不在 PATH 时**静默失败**
rem   VS Code 任务环境里的 PATH 可能不含 node（实测最小 PATH 下本脚本输出
rem   `'node' is not recognized`），而脚本结尾无条件 `exit /b 0` ⇒ 任务被判"成功"、
rem   什么都没启动 ⇒ 完全是"按了没反应"。⇒ 现在：显式解析 node（PATH→常见安装目录），
rem   找不到就 **exit /b 1 并把原因打到 stderr**，让 F5 直接报错而不是无声失败。
rem ============================================================================
setlocal

rem ── 0) 立刻留痕：只要 VS Code 真的执行了这个任务，这里必然多一行 ────────────────
rem    判读：F5 后 launcher-invoked.log 没有新行 ⇒ 任务根本没被调用（IDE 侧问题）；
rem          有新行但没有 app-exit.log 的 LAUNCH 行 ⇒ 卡在下面的 node 解析/启动。
>> "%USERPROFILE%\.vssaros-dev\logs\launcher-invoked.log" echo [%date% %time%] start-dev-app.cmd invoked  param=%~1

rem ── 1) 找 node：先 PATH，再常见安装位置 ────────────────────────────────────
set "NODE_EXE="
for %%I in (node.exe) do if not defined NODE_EXE if exist "%%~$PATH:I" set "NODE_EXE=%%~$PATH:I"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "D:\Program Files\nodejs\node.exe" set "NODE_EXE=D:\Program Files\nodejs\node.exe"

if not defined NODE_EXE (
	echo [start-dev-app] ERROR: node.exe not found ^(PATH / ProgramFiles\nodejs / D:\Program Files\nodejs^).>&2
	echo [start-dev-app] Fix: install Node.js or set PATH so that `node -v` works in this terminal.>&2
	exit /b 1
)

rem ── 2) 校验脚本本身在（否则同样会"静默成功"）──────────────────────────────
if not exist "%~dp0spawn-detached.mjs" (
	echo [start-dev-app] ERROR: spawn-detached.mjs missing next to this script.>&2
	exit /b 1
)
if not exist "%~dp0start-dev-app.mjs" (
	echo [start-dev-app] ERROR: start-dev-app.mjs missing next to this script.>&2
	exit /b 1
)

rem ── 3) 脱离启动（不继承 std 句柄，本脚本秒返回）──────────────────────────────
"%NODE_EXE%" "%~dp0spawn-detached.mjs" "%~dp0start-dev-app.mjs"
if errorlevel 1 (
	echo [start-dev-app] ERROR: launcher refused to start ^(see ABORT above / %%USERPROFILE%%\.vssaros-dev\logs\app-exit.log^).>&2
	exit /b 1
)

exit /b 0
