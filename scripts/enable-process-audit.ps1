# =============================================================================
#  enable-process-audit.ps1 —— 开启「进程创建」审计，用于抓"谁杀了 Saroasis harness.exe"
#
#  为什么需要它：应用被外部以 TerminateProcess(code=1) 杀掉时**不写任何日志**
#  （process.on('exit') 都不触发、无 dump、无 will-quit）。只有 Windows 的
#  安全日志 4688 能记下"哪个父进程执行了什么命令行"。
#
#  用法（会弹 UAC，点"是"）：
#      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\enable-process-audit.ps1
#
#  之后用 scripts\show-kill-forensics.ps1 查看谁动过它。
#
#  说明：子类别用 **GUID**（{0CCE922B-…} = Process Creation）而不是中文名，
#        避免 auditpol 在非中文/不同语言系统上认不出名字。
# =============================================================================

$ErrorActionPreference = 'Stop'

function Test-Admin {
	$id = [Security.Principal.WindowsIdentity]::GetCurrent()
	return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
	Write-Host '[i] 需要管理员权限，正在请求提权（会弹 UAC）…' -ForegroundColor Yellow
	$args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath))
	Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -Verb RunAs
	return
}

$PROC_CREATION = '{0CCE922B-69AE-11D9-BED3-505054503030}'

# 留证：把本次提权执行的输出写进文件（非管理员会话查不了审计策略，只能靠这个看结果）
# 2026-10-28：userData 统一为 ~/.vssaros（dev 不再用 .vssaros-dev）
$logDir = Join-Path $env:USERPROFILE '.vssaros\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'audit-setup.log'
Start-Transcript -Path $logFile -Append | Out-Null

Write-Host '=== 1) 开启「进程创建」成功审计 ===' -ForegroundColor Cyan
& auditpol.exe /set /subcategory:"$PROC_CREATION" /success:enable | Out-Null
& auditpol.exe /get /subcategory:"$PROC_CREATION"

Write-Host ''
Write-Host '=== 2) 让 4688 记录完整命令行 ===' -ForegroundColor Cyan
$key = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System\Audit'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
New-ItemProperty -Path $key -Name 'ProcessCreationIncludeCmdLine_Enabled' -PropertyType DWord -Value 1 -Force | Out-Null
Get-ItemProperty -Path $key -Name 'ProcessCreationIncludeCmdLine_Enabled' | Select-Object -ExpandProperty ProcessCreationIncludeCmdLine_Enabled |
	ForEach-Object { Write-Host "    ProcessCreationIncludeCmdLine_Enabled = $_" }

Write-Host ''
Write-Host '=== 3) 安全日志容量（太小会滚动丢失证据）===' -ForegroundColor Cyan
& wevtutil.exe gl Security | Select-String -Pattern 'maxSize|retention'

Write-Host ''
Write-Host '完成。下次应用被结束后运行：' -ForegroundColor Green
Write-Host '    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\show-kill-forensics.ps1'
Write-Host ''
Write-Host ('日志: ' + $logFile) -ForegroundColor DarkGray
Stop-Transcript | Out-Null
