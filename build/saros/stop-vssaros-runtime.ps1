# Stop detached VsSaros / dsh Host processes before Inno Setup replaces native modules.
#
# Why: dsh Host is spawned detached. Closing the main window does not necessarily stop it,
# and it keeps loading `*.node` addons such as koffi.node. Inno Setup then fails with
# "DeleteFile failed; code 5 (Access is denied)" while upgrading dsh-runtime.
#
# This script is embedded into the installer with `Flags: dontcopy` and called from
# code.iss `PrepareToInstall()` before any file is replaced. It intentionally:
#   - kills node.exe process trees (dsh Host and its subprocesses);
#   - in background updates, keeps VsSaros.exe/VsSarosis.exe alive so the client can
#     show the "restart" prompt after installation; pass -BackgroundUpdate from code.iss;
#   - in manual installs, kills only the main app process itself, never its process tree
#     (the installer may be a child of the app during an update);
#   - excludes dev checkouts (.vssaros-dev / SarosWorkspace) from termination;
#   - never aborts the installer: restartreplace remains the last-resort fallback.
#
# Set VS_SAROS_STOP_RUNTIME_DRYRUN=1 to list matching processes without stopping them.

param([switch]$BackgroundUpdate)

$ErrorActionPreference = 'Continue'
$script:BackgroundUpdateEnabled = [bool]$BackgroundUpdate
$dryRun = $env:VS_SAROS_STOP_RUNTIME_DRYRUN -eq '1'
if ($script:BackgroundUpdateEnabled) {
	Write-Output 'mode=background: keep main app alive, stop detached dsh Host only'
}
$systemRoot = $env:SystemRoot
if (-not $systemRoot) { $systemRoot = 'C:\Windows' }
$taskkill = Join-Path $systemRoot 'System32\taskkill.exe'

function Get-VsSarosRuntimeProcesses {
	$names = @('node.exe', 'VsSaros.exe', 'VsSarosis.exe')
	$all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
		Where-Object { $names -contains $_.Name })
	if ($all.Count -eq 0) {
		# ★ 2026-11-24：CIM 被禁用 / 权限不足时上面会**静默**返回空 ⇒ 一个占用者都杀不到
		#   ⇒ 直接撞 DeleteFile 错误代码 5。换 WMI provider 再试，并把失败如实写进日志。
		$all = @(Get-WmiObject Win32_Process -ErrorAction SilentlyContinue |
			Where-Object { $names -contains $_.Name })
	}
	if ($all.Count -eq 0) {
		Write-Output 'warn: 进程枚举不可用（CIM/WMI 都拿不到），只能依赖 *.node 行的 restartreplace 兜底'
	}
	foreach ($p in $all) {
		$cmd = [string]$p.CommandLine
		$path = [string]$p.ExecutablePath

		# 不要把开发实例（launch.bat / .vssaros-dev / 仓库 dsh-runtime）一起杀掉。
		if ($cmd -like '*\.vssaros-dev\*' -or $cmd -like '*\SarosWorkspace\*' -or
			$path -like '*\.vssaros-dev\*' -or $path -like '*\SarosWorkspace\*') {
			continue
		}

		$isApp = ($p.Name -eq 'VsSaros.exe') -or ($p.Name -eq 'VsSarosis.exe')
		$isHost = $p.Name -eq 'node.exe' -and (
			$cmd -match '\\resources\\app\\dsh-runtime\\' -or
			$path -match '\\resources\\app\\dsh-runtime\\' -or
			$cmd -match '\\\.vssaros\\dsh-(home|run|runtime)\\' -or
			$path -match '\\\.vssaros\\dsh-runtime\\node\\node\.exe$'
		)
		if ($script:BackgroundUpdateEnabled -and $isApp) {
			continue
		}
		if ($isApp -or $isHost) { $p }
	}
}

$targets = @(Get-VsSarosRuntimeProcesses)
foreach ($p in $targets) {
	if ($dryRun) {
		Write-Output "DRYRUN would stop $($p.Name) pid=$($p.ProcessId)"
		continue
	}
	try {
		if ($p.Name -eq 'node.exe' -and (Test-Path -LiteralPath $taskkill)) {
			& $taskkill /PID $p.ProcessId /T /F 2>&1 | Out-Null
		} else {
			Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
		}
		Write-Output "stopped $($p.Name) pid=$($p.ProcessId)"
	} catch {
		Write-Output "could not stop $($p.Name) pid=$($p.ProcessId): $($_.Exception.Message)"
	}
}

if (-not $dryRun) {
	$deadline = (Get-Date).AddSeconds(6)
	while ((Get-Date) -lt $deadline) {
		if (@(Get-VsSarosRuntimeProcesses).Count -eq 0) { break }
		Start-Sleep -Milliseconds 500
	}
}

exit 0
