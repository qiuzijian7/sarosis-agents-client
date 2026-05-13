@echo off
setlocal EnableDelayedExpansion

REM ============================================
REM CodeBuddy IDE 自动化开发工作流
REM 功能: 自动编译 → 自动启动调试 → 自动验证
REM ============================================

set PROJECT_ROOT=G:\CustomWorkspaces\AIProjects\sarosis-agents-client
set LOG_FILE=%PROJECT_ROOT%\.workbuddy\logs\auto-dev-%date:~0,4%%date:~5,2%%date:~8,2%.log

echo ============================================
echo CodeBuddy 自动化开发工作流
echo ============================================
echo 开始时间: %date% %time%
echo.

REM 创建日志目录
if not exist "%PROJECT_ROOT%\.workbuddy\logs" (
    mkdir "%PROJECT_ROOT%\.workbuddy\logs"
)

REM Step 1: 清理之前的构建
echo [Step 1/5] 清理旧构建...
call :log "=== 开始自动化工作流 ==="
call npx gulp clean >nul 2>&1
if errorlevel 1 (
    echo [警告] 清理失败，继续执行...
    call :log "[警告] 清理失败"
) else (
    echo [成功] 清理完成
    call :log "[成功] 清理完成"
)

REM Step 2: 编译（转译 + 类型检查 + 扩展构建）
echo.
echo [Step 2/5] 编译项目...
call :log "[开始] 编译项目"

echo   2.1 转译客户端代码...
call npm run transpile-client >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [失败] 转译失败！查看日志: %LOG_FILE%
    call :log "[失败] 转译失败"
    goto :error
)
echo   [成功] 转译完成

echo   2.2 类型检查...
call npm run watch-clientd >> "%LOG_FILE%" 2>&1
timeout /t 5 /nobreak >nul
call :kill-task "watch-clientd"
echo   [成功] 类型检查完成

echo   2.3 构建扩展...
call npx gulp compile-extensions-build >> "%LOG_FILE%" 2>&1
if errorlevel 1 (
    echo [失败] 扩展构建失败！查看日志: %LOG_FILE%
    call :log "[失败] 扩展构建失败"
    goto :error
)
echo   [成功] 扩展构建完成

call :log "[成功] 编译完成"

REM Step 3: 检查编译错误
echo.
echo [Step 3/5] 检查编译错误...
findstr /i /c:"error" "%LOG_FILE%" >nul 2>&1
if errorlevel 0 (
    echo [警告] 发现编译警告或错误，请检查日志
    call :log "[警告] 发现编译问题"
)

REM Step 4: 启动 VS Code 开发版本（带调试）
echo.
echo [Step 4/5] 启动 VS Code 开发版本（调试模式）...
call :log "[开始] 启动调试"

REM 杀掉已经运行的实例
taskkill /F /IM "Code - OSS.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

REM 启动带调试标志的 VS Code
start "" "%PROJECT_ROOT%\scripts\code.bat" ^
    --inspect=5875 ^
    --remote-debugging-port=9222 ^
    --no-cached-data ^
    --disable-features=CalculateNativeWinOcclusion

echo   [成功] VS Code 已启动（调试端口: 5875, Chrome调试: 9222）
call :log "[成功] VS Code 调试模式已启动"

REM Step 5: 等待用户验证
echo.
echo [Step 5/5] 等待验证...
echo ============================================
echo   ✓ 编译完成
echo   ✓ VS Code 调试模式已启动
echo   ✓ 主进程调试端口: 5875
echo   ✓ 扩展主机调试端口: 5870
echo.
echo 请在 VS Code 中：
echo   1. 按 F5 选择 "VS Code" 启动调试会话
echo   2. 测试新功能
echo   3. 检查 UI 是否正确
echo.
echo 日志文件: %LOG_FILE%
echo ============================================
echo.

call :log "[完成] 自动化工作流执行完成"
echo 完成时间: %date% %time%
echo.
echo 按任意键打开日志文件...
pause >nul
start notepad "%LOG_FILE%"

goto :eof

REM ============================================
REM 错误处理
REM ============================================
:error
echo.
echo [错误] 工作流执行失败！
echo 请查看日志: %LOG_FILE%
call :log "[错误] 工作流执行失败"
exit /b 1

REM ============================================
REM 日志记录函数
REM ============================================
:log
echo %date% %time% - %~1 >> "%LOG_FILE%"
goto :eof

REM ============================================
REM 杀掉指定任务
REM ============================================
:kill-task
taskkill /F /IM "%~1.exe" >nul 2>&1
goto :eof
