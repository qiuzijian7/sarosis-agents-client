# 进程名：2026-10-29 起 exe 叫 `VsSaros`（原来 `Saroasis harness`）⇒ 两个都认，
# 否则改名过渡期会"看不见"旧名实例的窗口 ⇒ 被误判成僵尸态、白杀一次。
# ★ 2026-10-30：dev 的 exe 改用独立名 `VsSaros Dev.exe`（与安装版 `VsSaros.exe` 区分开）
#   ⇒ 默认只认 dev 名（安装版的窗口不该被当成"dev 实例的窗口"，那会让 F5 走 SKIP）。
param([string[]]$ProcessName = @('VsSaros Dev', 'VsSaros', 'Saroasis harness'))
# 打印该进程（含其子进程）有几个**可见**的顶层窗口（WS_VISIBLE 且非 0x0）。
# 输出：一个整数。0 ⇒ 屏幕上没有它的窗口（= 僵尸态：进程活着但看不到 app）。
# 为什么不用 CDP / MainWindowTitle（2026-10-24 实测）：
#   · DevToolsActivePort 文件可能过期，连错端口 ⇒ 误判；
#   · aux（桌面）窗口没有 MainWindowHandle ⇒ MainWindowTitle 恒为空 ✗。
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class VisWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static int Count(uint[] pids) {
    var set = new HashSet<uint>(pids);
    int n = 0;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid)) { return true; }
      if (!IsWindowVisible(h)) { return true; }
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.Length == 0) { return true; }          // 无标题的辅助窗口不算
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L <= 1 || r.B - r.T <= 1) { return true; }
      n++;
      return true;
    }, IntPtr.Zero);
    return n;
  }
}
'@
# ★★ 2026-10-31（真机：**本脚本恒返回 0** ⇒ 每次 F5 都把正在用的 dev 实例误判成僵尸并杀掉 ✗✗）：
#   原来用 `Get-Process -Name <名>` 取 pid —— 而实测在这个会话里
#     `Get-Process -Name 'VsSaros'` ⇒ **0**（`Where -eq` 也是 0），
#     同时 `Feishu`=13、`CodeBuddy CN`=21 正常 ⇒ **它根本看不到我们的进程**
#     （`wmic` 看得到 14 个，`Get-Process -Id <pid>` 也能取到名字）。
#   ⇒ 换成两个可靠来源取并集：
#       ① CIM `Win32_Process`（与 wmic 同源，实测能看到）；
#       ② 从**可见窗口反查** pid，再取进程名（实测这路能拿到 `VsSaros`）。
$want = @($ProcessName | ForEach-Object { $_.ToLowerInvariant() })
$pids = New-Object 'System.Collections.Generic.HashSet[uint32]'

# ① CIM：按进程名（带不带 .exe 都认）
foreach ($n in $want) {
	$exe = if ($n.EndsWith('.exe')) { $n } else { $n + '.exe' }
	$filter = "Name = '" + $exe.Replace("'", "''") + "'"
	$rows = @(Get-CimInstance Win32_Process -Filter $filter -ErrorAction SilentlyContinue)
	foreach ($r in $rows) { [void]$pids.Add([uint32]$r.ProcessId) }
}

# ② 窗口反查：先拿到"所有可见有标题窗口"的 pid，再看它的进程名/路径命中不命中
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) {
	$name = ''
	try { $name = $p.ProcessName.ToLowerInvariant() } catch { $name = '' }
	if (-not $name) { continue }
	foreach ($n in $want) {
		if ($name -eq $n -or $name -eq ($n + '.exe')) { [void]$pids.Add([uint32]$p.Id); break }
	}
}

if ($pids.Count -eq 0) { Write-Output 0; exit 0 }
Write-Output ([VisWin]::Count(@($pids)))
