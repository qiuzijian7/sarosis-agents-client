# -----------------------------------------------------------------------------
# VsSaros "New Window" 启动器
#
# 任务栏 jump list 的 "New Window" 经此脚本启动一个【独立】的 VsSaros 实例，
# 而不是转发给已运行的主实例。每次点击生成唯一 --instance <id>，使新进程
# 的 IPC 单实例锁/可变状态（state.vscdb、workspaceStorage、Backups、logs）
# 按实例拆分，静态数据（agents/skills/settings/extensions）共享。
#
# 用法（由 jump list 注册代码生成，勿手改）:
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass `
#     -File new-window.ps1 -ExePath "<VsSaros.exe>" [-AppPath "<appRoot>"] [-UserDataDir "<dir>"]
#
#   -ExePath     VsSaros 可执行文件绝对路径（dev 为 .build/electron/VsSaros.exe）
#   -AppPath     仅 dev 需要：electron 二进制需 app path 作为第一个参数（绝对路径）
#   -UserDataDir 与主实例一致的 user-data-dir（dev 默认 ~/.vssaros-dev）
# -----------------------------------------------------------------------------
param(
    [Parameter(Mandatory = $true)][string]$ExePath,
    [Parameter(Mandatory = $false)][string]$AppPath,
    [Parameter(Mandatory = $false)][string]$UserDataDir,
    [Parameter(Mandatory = $false)][switch]$Dev
)

$ErrorActionPreference = 'Stop'

# 诊断日志（每次点击写入 %TEMP%\vssaros-new-window.log，排障用）
$diag = Join-Path $env:TEMP 'vssaros-new-window.log'

try {
    Add-Content -Path $diag -Value ("{0} START Exe={1} App={2} UserData={3}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $ExePath, $AppPath, $UserDataDir)

    # 唯一实例 id：时间戳 + 随机后缀，保证每次点击都是全新独立实例
    $id = 'w' + (Get-Date -Format 'yyyyMMddHHmmssfff') + ('{0:x3}' -f (Get-Random -Maximum 0x1000))

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $ExePath
    $psi.UseShellExecute = $false

    # dev 实例由 code.bat 设置 VSCODE_DEV=1（环境服务 isBuilt = !VSCODE_DEV）。
    # 本脚本由 explorer 上下文中的 powershell 启动，不会继承 VSCODE_DEV，
    # 需显式补上，否则新实例被误判为 built（userData 不带 -dev、jump list
    # 指向打包路径等）。打包版不传 -Dev，保持默认。
    if ($Dev) {
        $psi.EnvironmentVariables['VSCODE_DEV'] = '1'
    }

    $argList = New-Object 'System.Collections.Generic.List[string]'
    if ($AppPath) {
        $argList.Add('"' + $AppPath + '"')
    }
    if ($UserDataDir) {
        $argList.Add('--user-data-dir="' + $UserDataDir + '"')
    }
    $argList.Add('--instance=' + $id)

    $psi.Arguments = [string]::Join(' ', $argList)
    $proc = [System.Diagnostics.Process]::Start($psi)
    Add-Content -Path $diag -Value ("{0} OK pid={1} cmd={2}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $proc.Id, $psi.Arguments)
}
catch {
    # 启动失败：写入诊断日志（错误日志同时保留，避免在桌面环境弹窗干扰）
    Add-Content -Path $diag -Value ("{0} FAIL {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $_.Exception.Message)
    try {
        $log = Join-Path $env:TEMP 'vssaros-new-window-error.log'
        Add-Content -Path $log -Value ("{0} New Window 启动失败: {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $_.Exception.Message)
    }
    catch { }
}
