@echo off
chcp 65001 > nul
setlocal enabledelayedexpansion

echo 🚀 启动完整开发流程...
echo ===========================

REM 检查 Node.js 版本
node -v > nul 2>&1
if errorlevel 1 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js 16.0 或更高版本
    pause
    exit /b 1
)

for /f "tokens=2 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 16 (
    echo ❌ Node.js 版本过低，需要 16.0 或更高版本
    echo 当前版本: 
    node -v
    pause
    exit /b 1
)

echo ✅ Node.js 版本检查通过: 
node -v

REM 检查依赖是否安装
if not exist "node_modules\" (
    echo 📦 首次运行，正在安装依赖...
    call npm install
    if errorlevel 1 (
        echo ❌ 依赖安装失败
        pause
        exit /b 1
    )
)

echo ✅ 依赖检查完成

REM 设置默认参数
set AI_ENABLED=true
set SKIP_TESTS=false
set SKIP_CHECKS=false
set AUTO_COMMIT=false
set CONFIG_FILE=

REM 解析命令行参数
:parse_args
if "%~1"=="" goto :end_parse
if "%~1"=="--no-ai" (
    set AI_ENABLED=false
    shift
    goto :parse_args
)
if "%~1"=="--skip-tests" (
    set SKIP_TESTS=true
    shift
    goto :parse_args
)
if "%~1"=="--skip-checks" (
    set SKIP_CHECKS=true
    shift
    goto :parse_args
)
if "%~1"=="--auto-commit" (
    set AUTO_COMMIT=true
    shift
    goto :parse_args
)
if "%~1"=="--config" (
    set CONFIG_FILE=%~2
    shift
    shift
    goto :parse_args
)
if "%~1"=="--help" goto :show_help
if "%~1"=="-h" goto :show_help

echo ❌ 未知选项: %~1
echo 使用 --help 查看帮助
pause
exit /b 1

:show_help
echo 用法: dev-workflow.bat [选项]
echo.
echo 选项:
echo   --no-ai              禁用 AI 辅助
echo   --skip-tests          跳过测试阶段
echo   --skip-checks        跳过错误检查阶段
echo   --auto-commit        自动提交（使用 AI 生成的提交信息）
echo   --config ^<path^>      指定配置文件路径
echo   --help, -h           显示帮助信息
echo.
echo 示例:
echo   dev-workflow.bat
echo   dev-workflow.bat --no-ai
echo   dev-workflow.bat --skip-tests
pause
exit /b 0

:end_parse

echo.
echo 📋 配置:
echo   AI 辅助: %AI_ENABLED%
echo   跳过测试: %SKIP_TESTS%
echo   跳过检查: %SKIP_CHECKS%
echo   自动提交: %AUTO_COMMIT%
if not "%CONFIG_FILE%"=="" echo   配置文件: %CONFIG_FILE%
echo.

REM 构建命令
set CMD=node ai-dev-workflow.js

if "%AI_ENABLED%"=="false" (
    set CMD=%CMD% --no-ai
)

if "%SKIP_TESTS%"=="true" (
    set CMD=%CMD% --skip-tests
)

if "%SKIP_CHECKS%"=="true" (
    set CMD=%CMD% --skip-checks
)

if "%AUTO_COMMIT%"=="true" (
    set CMD=%CMD% --auto-commit
)

if not "%CONFIG_FILE%"=="" (
    set CMD=%CMD% --config %CONFIG_FILE%
)

echo 🚀 执行命令: %CMD%
echo ===========================

REM 执行命令
call %CMD%

REM 检查执行结果
if %errorlevel% equ 0 (
    echo.
    echo ===================
    echo ✅ 开发流程执行成功！
    echo ===================
    pause
    exit /b 0
) else (
    echo.
    echo ===================
    echo ❌ 开发流程执行失败！
    echo 请查看上面的错误信息
    echo ===================
    pause
    exit /b 1
)
