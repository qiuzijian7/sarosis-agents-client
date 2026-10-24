# ============================================================================
# Start the dev app AND record its exit code (death recorder).
#
# Why (2026-10-23): the app repeatedly vanished mid-heartbeat with
#   no before-quit, no will-quit, no WER, no watchdog STALL.
#   That shape is only distinguishable by the EXIT CODE:
#     4294967295 (-1) => PowerShell Stop-Process -Force / .NET Process.Kill
#     1               => taskkill /F (or libuv kill)
#     0xC0000005 etc. => native crash (access violation)
#     0 / other       => the app exited itself (app.exit(code))
#   Everything is appended to ~/.vssaros-dev/logs/app-exit.log
#
# Invoked (detached) by scripts/start-dev-app.cmd, which is the preLaunchTask
# of the "Launch & Attach Dev (9799)" launch configuration.
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less files as ANSI,
#       and non-ASCII comments here used to break the parser.
# ============================================================================
param(
	[int]$Port = 9799
)

$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo '.build\electron\Saroasis harness.exe'
$logDir = Join-Path $env:USERPROFILE '.vssaros-dev\logs'
$exitLog = Join-Path $logDir 'app-exit.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Note([string]$line) {
	$stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff')
	Add-Content -Path $exitLog -Value ($stamp + '  ' + $line) -Encoding UTF8
}

if (-not (Test-Path $exe)) {
	Note 'ABORT exe not found (run: npm run transpile-client)'
	exit 1
}
if (Get-Process -Name 'Saroasis harness' -ErrorAction SilentlyContinue) {
	Note 'SKIP a dev instance is already running, attach to it'
	exit 0
}

# Port pre-flight. A dead process can leave a LISTENING socket behind ("ghost",
# reproducible on this machine: pid 137784 kept holding 9799 long after it was
# gone). The app then fails to bind --inspect / --remote-debugging-port and
# exits within ~1s WITHOUT writing any log directory at all (reproduced
# 2026-10-23 23:11 / 23:12) -- which looks exactly like "app closes itself".
#
# Fix: never trust the configured ports. Probe them, and if a port is taken by
# anything other than our own live instance, walk a candidate list until we find
# a free pair. The chosen pair is recorded so "attach" can use the right one.
function Test-PortFree([int]$p) {
	if ($null -ne (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { return $false }
	$c = New-Object System.Net.Sockets.TcpClient
	try { $c.Connect('127.0.0.1', $p); return $false } catch { return $true } finally { $c.Dispose() }
}
$inspectPort = 5888
$debugPort = $Port
$chosen = $false
foreach ($dbg in @($Port, 9799, 9899, 9999, 9446, 9555)) {
	if ((Test-PortFree $dbg) -and (Test-PortFree $inspectPort)) { $debugPort = $dbg; $chosen = $true; break }
	$inspectPort++   # keep the pair moving
}
if (-not $chosen) {
	Note 'ABORT no free debug/inspect port pair (ghosts everywhere?) -- reboot or pick ports manually'
	exit 1
}
if ($debugPort -ne $Port) {
	Note ('PORTFALLBACK configured=' + $Port + ' using=' + $debugPort + ' (ghost/occupied; attach to the used one)')
}
Note ('PORTS inspect=' + $inspectPort + ' debug=' + $debugPort)

# dev runtime env (normally set by scripts/code.bat)
$env:NODE_ENV = 'development'
$env:VSCODE_DEV = '1'
$env:VSCODE_CLI = '1'
$env:VSCODE_SKIP_PRELAUNCH = '1'
$env:ELECTRON_ENABLE_LOGGING = '1'
# Native crash evidence (2026-10-23): the app dies with 0xC000001D / 0xE06D7363
# (V8 ImmediateCrash / unhandled C++ exception) and WER is disabled on this
# machine, so nothing is recorded anywhere. With stack dumping on, Electron
# prints the native stack of the crashing frame to stderr -> captured below.
$env:ELECTRON_ENABLE_STACK_DUMPING = '1'

$argList = @(
	$repo,
	('--inspect=' + $inspectPort),
	('--remote-debugging-port=' + $debugPort),
	'--no-cached-data',
	'--skip-sessions-welcome',
	('--user-data-dir=' + $env:USERPROFILE + '\.vssaros-dev')
)

# Keep the child's console: it is the ONLY place a native crash stack shows up.
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
$outLog = Join-Path $logDir ('app-stdout-' + $stamp + '.log')
$errLog = Join-Path $logDir ('app-stderr-' + $stamp + '.log')

Note ('START  port=' + $debugPort)
Note ('CONSOLE ' + $errLog)
$proc = Start-Process -FilePath $exe -ArgumentList $argList -PassThru -WorkingDirectory $repo `
	-RedirectStandardOutput $outLog -RedirectStandardError $errLog
Note ('PID    ' + $proc.Id)

$proc.WaitForExit()
$code = $proc.ExitCode
if ($null -eq $code) {
	$hex = 'unknown'
} else {
	$hex = ('0x{0:X8}' -f [uint32]$code)
}
Note ('EXIT   pid=' + $proc.Id + ' code=' + $code + ' (' + $hex + ')')
