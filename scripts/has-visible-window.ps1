# 进程名：2026-10-29 起 exe 叫 `VsSaros`（原来 `Saroasis harness`）⇒ 两个都认，
# 否则改名过渡期会"看不见"旧名实例的窗口 ⇒ 被误判成僵尸态、白杀一次。
param([string[]]$ProcessName = @('VsSaros', 'Saroasis harness'))
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
$pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
if ($pids.Count -eq 0) { Write-Output 0; exit 0 }
Write-Output ([VisWin]::Count($pids))
