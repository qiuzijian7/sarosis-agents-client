# 进程名：2026-10-29 起 exe 叫 `VsSaros`（原来 `Saroasis harness`）⇒ 两个都认（过渡期兼容）
# ★ 2026-10-30：dev 的 exe 改用独立名 `VsSaros Dev.exe`（与安装版 `VsSaros.exe` 区分开）
param([string[]]$ProcessName = @('VsSaros Dev', 'VsSaros', 'Saroasis harness'))
# ============================================================================
# 把已经在跑的 dev 实例的窗口提到最前面。
#
# 为什么需要（2026-10-26，用户报「F5 后仍然没有显示 desktop 窗口」）：
#   start-dev-app.mjs 发现已有实例在跑时会 `SKIP ... attach to it` ⇒ **新实例不起**、
#   屏幕上也不会有任何变化；而那扇已存在的窗口常常被别的（最大化的）应用窗口盖住
#   ⇒ 用户看到的就是"按了 F5 毫无反应"。⇒ SKIP 时必须把它的窗口提上来 ✓
#
# ★ 为什么用"置顶来回切一次"而不是只调 SetForegroundWindow：
#   F5 的进程链是「前台进程(IDE) → cmd → node（detach 脱离）→ powershell」，
#   脱离之后不再满足 Windows 前台锁那条"前台进程的子进程"⇒ SetForegroundWindow
#   会被系统拒绝（窗口只在任务栏闪 ✗）。
#   而 HWND_TOPMOST / HWND_NOTOPMOST 这种 z 序调整**不受前台锁限制** ⇒
#   至少保证窗口被放到最上层看得见 ✓；碰巧有前台权限时 SetForegroundWindow 也会生效。
#
# 输出：一行 `RAISED <hwnd> <title> fg=<bool>` 或 `NOTFOUND`
# ============================================================================
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class RaiseDev {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static IntPtr TOPMOST = new IntPtr(-1);
  public static IntPtr NOTOPMOST = new IntPtr(-2);
  public static IntPtr Find(uint[] pids) {
    var set = new HashSet<uint>(pids);
    IntPtr best = IntPtr.Zero; string bestTitle = "";
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid)) { return true; }
      if (!IsWindowVisible(h) || IsIconic(h)) { return true; }
      var t = new StringBuilder(256); GetWindowTextW(h, t, 256);
      if (t.Length == 0) { return true; }
      RECT r; GetWindowRect(h, out r);
      if (r.R - r.L <= 1 || r.B - r.T <= 1) { return true; }
      // 桌面窗口优先（它就是用户要看的那扇）；IDE 主窗口("…Dev")只在没有桌面窗口时用
      if (best == IntPtr.Zero) { best = h; bestTitle = t.ToString(); }
      else if (t.ToString() != bestTitle && bestTitle.Contains("Dev") && !t.ToString().Contains("Dev")) { best = h; bestTitle = t.ToString(); }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
'@
$pids = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
if ($pids.Count -eq 0) { Write-Output 'NOTFOUND'; exit 0 }
$h = [RaiseDev]::Find($pids)
if ($h -eq [IntPtr]::Zero) { Write-Output 'NOTFOUND'; exit 0 }
$t = New-Object System.Text.StringBuilder 256
[void][RaiseDev]::GetWindowTextW($h, $t, 256)
[void][RaiseDev]::ShowWindow($h, 9)
[void][RaiseDev]::SetWindowPos($h, [RaiseDev]::TOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002)
[void][RaiseDev]::SetForegroundWindow($h)
[void][RaiseDev]::SetWindowPos($h, [RaiseDev]::NOTOPMOST, 0, 0, 0, 0, 0x0001 -bor 0x0002)
Start-Sleep -Milliseconds 150
$fg = ([RaiseDev]::GetForegroundWindow() -eq $h)
Write-Output ("RAISED {0} {1} fg={2}" -f $h, $t.ToString(), $fg)
