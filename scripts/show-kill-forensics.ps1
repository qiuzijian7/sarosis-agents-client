# =============================================================================
#  show-kill-forensics.ps1 —— 从安全日志 4688 里找出"谁动过 Saroasis harness.exe"
#
#  前提：先跑过一次 scripts\enable-process-audit.ps1（提权）。
#  用法：
#      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\show-kill-forensics.ps1
#      ... -Hours 48        # 看最近 48 小时
#      ... -Filter taskkill # 只看命令行里含 taskkill 的
#
#  输出：时间 | 创建者(父进程) | 新进程命令行
#  判读：
#    · 创建者是 `taskkill.exe`/`powershell.exe`/`wmic.exe`/`cmd.exe` 的一条，且新进程
#      命令行里含 `Saroasis harness.exe` ⇒ 就是它下的手（父进程名往往就是源头工具）。
# =============================================================================
param(
	[int]$Hours = 24,
	[string]$Filter = ''
)

$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal]([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
	Write-Host '[i] 读取安全日志需要管理员权限，正在提权（会弹 UAC）…' -ForegroundColor Yellow
	$args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $PSCommandPath), '-Hours', $Hours)
	if ($Filter) { $args2 += @('-Filter', $Filter) }
	Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 -Verb RunAs
	return
}

$since = (Get-Date).AddHours(-1 * $Hours)
Write-Host ("扫描 4688（自 {0:yyyy-MM-dd HH:mm} 起，最近 {1} 小时）…" -f $since, $Hours) -ForegroundColor Cyan

$events = Get-WinEvent -FilterHashtable @{
	LogName   = 'Security'
	Id        = 4688
	StartTime = $since
} -ErrorAction SilentlyContinue

if (-not $events) { Write-Host '没有 4688 事件：审计可能还没开启（先跑 enable-process-audit.ps1）。' -ForegroundColor Yellow; return }

$rows = foreach ($e in $events) {
	$x = [xml]$e.ToXml()
	$d = @{}
	foreach ($n in $x.Event.EventData.Data) { $d[$n.Name] = $n.'#text' }
	$cmdline = [string]$d['CommandLine']
	$newProc = [string]$d['NewProcessName']
	$creator = [string]$d['ParentProcessName']
	# 只留"碰过我们应用"或"执行了杀进程命令"的事件
	$hit = ($cmdline -match 'Saroasis harness') -or
		($newProc -match 'Saroasis harness') -or
		($cmdline -match 'taskkill|Stop-Process|TerminateProcess')
	if (-not $hit) { continue }
	if ($Filter -and ($cmdline -notmatch $Filter) -and ($creator -notmatch $Filter)) { continue }
	[pscustomobject]@{
		Time    = $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss')
		Creator = Split-Path -Leaf $creator
		NewProc = Split-Path -Leaf $newProc
		Command = if ($cmdline.Length -gt 150) { $cmdline.Substring(0, 150) + '…' } else { $cmdline }
	}
}

if (-not $rows) {
	Write-Host '窗口内没有相关事件（可能还没人动它，或审计是刚开的）。' -ForegroundColor Yellow
	return
}

$rows | Sort-Object Time | Format-Table -AutoSize -Wrap | Out-String -Width 300 |
	ForEach-Object { $_ -split "\r?\n" } | ForEach-Object { if ($_.Trim()) { Write-Output $_ } }

$logDir = Join-Path $env:USERPROFILE '.vssaros-dev\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir 'kill-forensics.log'
$rows | Sort-Object Time | ForEach-Object {
	('{0}  creator={1}  new={2}  cmd={3}' -f $_.Time, $_.Creator, $_.NewProc, $_.Command)
} | Set-Content -Path $logFile -Encoding UTF8
Write-Output ''
Write-Output ('结果已写入: ' + $logFile)
Write-Host ''
Write-Host '提示：TerminateProcess 由「创建者」发起 —— 看 Creator 一列就是源头工具。' -ForegroundColor Green
