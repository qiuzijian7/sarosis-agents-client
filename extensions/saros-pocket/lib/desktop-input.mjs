// Saros Pocket — 桌面输入转发（鼠标/键盘/滚轮）
//
// ★ 这是「能改变被控端状态」的一条出口，护栏与既有出口同规格：
//   1. 默认关闭（sarosPocket.allowDesktopInput=false），必须显式开启；
//   2. 调用前已过 Pocket 的访问密码（路由挂在代理鉴权之后）；
//   3. 坐标只能落在「当前采集区域」内（由 screen.rect() 给出），越界直接拒；
//   4. 目前仅 Windows（user32 P/Invoke via PowerShell），其他平台明确报不支持。
//
// 与 billd-desk 的差异：billd-desk 用驱动级键鼠（绕游戏风控）；这里只用普通
// user32 事件，够点界面/打字，不适合游戏或 UAC 提权窗口。

import { spawn } from 'node:child_process';

const SUPPORTED = process.platform === 'win32';

const PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class SPIn {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int data, int extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, int extra);
}
'@
$act = $env:SP_ACT
$x = [int]$env:SP_X
$y = [int]$env:SP_Y
$delta = [int]$env:SP_DELTA
$key = $env:SP_KEY
$text = $env:SP_TEXT
$MOUSEEVENTF_MOVE = 0x0001
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_WHEEL = 0x0800
$KEYEVENTF_KEYUP = 0x0002
$vkMap = @{
  'enter' = 13; 'tab' = 9; 'esc' = 27; 'escape' = 27; 'backspace' = 8; 'delete' = 46;
  'space' = 32; 'up' = 38; 'down' = 40; 'left' = 37; 'right' = 39;
  'home' = 36; 'end' = 35; 'pageup' = 33; 'pagedown' = 34; 'insert' = 45;
}
switch ($act) {
  'move' { [void][SPIn]::SetCursorPos($x, $y) }
  'click' {
    [void][SPIn]::SetCursorPos($x, $y)
    if ($env:SP_BUTTON -eq 'right') { [SPIn]::mouse_event($MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0); [SPIn]::mouse_event($MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0) }
    else { [SPIn]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); [SPIn]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0) }
  }
  'dblclick' {
    [void][SPIn]::SetCursorPos($x, $y)
    [SPIn]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); [SPIn]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    [SPIn]::mouse_event($MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0); [SPIn]::mouse_event($MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
  }
  'wheel' { [SPIn]::mouse_event($MOUSEEVENTF_WHEEL, 0, 0, $delta, 0) }
  'key' {
    $parts = $key -split '\+'
    $mods = @()
    $main = ''
    foreach ($p in $parts) {
      $q = $p.Trim().ToLower()
      if ($q -eq 'ctrl' -or $q -eq 'control') { $mods += 17 }
      elseif ($q -eq 'alt') { $mods += 18 }
      elseif ($q -eq 'shift') { $mods += 16 }
      elseif ($q -eq 'win' -or $q -eq 'meta') { $mods += 91 }
      else { $main = $q }
    }
    foreach ($m in $mods) { [SPIn]::keybd_event([byte]$m, 0, 0, 0) }
    if ($main -ne '') {
      $vk = 0
      if ($vkMap.ContainsKey($main)) { $vk = $vkMap[$main] }
      elseif ($main.Length -eq 1) { $vk = [int][char]::ToUpper($main[0]) }
      if ($vk -gt 0) {
        [SPIn]::keybd_event([byte]$vk, 0, 0, 0)
        [SPIn]::keybd_event([byte]$vk, 0, $KEYEVENTF_KEYUP, 0)
      }
    }
    for ($i = $mods.Length - 1; $i -ge 0; $i--) { [SPIn]::keybd_event([byte]$mods[$i], 0, $KEYEVENTF_KEYUP, 0) }
  }
  'text' {
    $sb = ''
    foreach ($ch in $text.ToCharArray()) {
      if ('+^%~(){}[]'.Contains($ch)) { $sb += '{' + $ch + '}' } else { $sb += $ch }
    }
    [System.Windows.Forms.SendKeys]::SendWait($sb)
  }
  default { throw "unknown action: $act" }
}
`;

function runPs(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS], {
      env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(err.trim().slice(0, 300) || `powershell 退出（code=${code}）`));
    });
  });
}

/** 归一化坐标（0..1，相对采集区域）→ 屏幕绝对坐标；越界抛错。 */
export function mapPoint(rect, x, y) {
  const r = rect ?? { x: 0, y: 0, width: 0, height: 0 };
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
    throw new Error('坐标越界（应为 0~1 的相对坐标）| coordinates out of range');
  }
  if (!r.width || !r.height) throw new Error('还没有采集区域，无法定位鼠标 | capture rect unavailable');
  return { x: Math.round(r.x + nx * r.width), y: Math.round(r.y + ny * r.height) };
}

/**
 * 创建输入转发器。
 * @param {object} opts
 * @param {() => boolean} opts.allowed 总开关（sarosPocket.allowDesktopInput）
 * @param {() => object|null} opts.getRect 当前采集区域（屏幕绝对坐标）
 */
export function createDesktopInput({ allowed = () => false, getRect = () => null } = {}) {
  async function send(action) {
    if (!SUPPORTED) throw new Error('桌面输入仅支持 Windows | desktop input is Windows-only');
    if (allowed() !== true) {
      throw new Error('桌面输入已关闭：请在 VsSaros 设置里开启 sarosPocket.allowDesktopInput | desktop input disabled');
    }
    const type = String(action?.type ?? '');
    const env = { SP_ACT: '', SP_X: '0', SP_Y: '0', SP_DELTA: '0', SP_BUTTON: 'left', SP_KEY: '', SP_TEXT: '' };
    if (type === 'move' || type === 'click' || type === 'dblclick') {
      const p = mapPoint(getRect(), action.x, action.y);
      env.SP_ACT = type;
      env.SP_X = String(p.x);
      env.SP_Y = String(p.y);
      env.SP_BUTTON = action?.button === 'right' ? 'right' : 'left';
    } else if (type === 'wheel') {
      const p = mapPoint(getRect(), action.x, action.y);
      env.SP_ACT = 'wheel';
      env.SP_X = String(p.x);
      env.SP_Y = String(p.y);
      env.SP_DELTA = String(Math.max(-1200, Math.min(1200, Number(action?.delta) || 0)));
    } else if (type === 'key') {
      const key = String(action?.key ?? '').trim();
      if (!key) throw new Error('缺少按键 | missing key');
      env.SP_ACT = 'key';
      env.SP_KEY = key.slice(0, 64);
    } else if (type === 'text') {
      const text = String(action?.text ?? '');
      if (!text) throw new Error('缺少文本 | missing text');
      env.SP_ACT = 'text';
      env.SP_TEXT = text.slice(0, 2000);
    } else {
      throw new Error(`未知输入类型：${type} | unknown input type`);
    }
    await runPs(env);
    return { ok: true, type };
  }

  return { supported: SUPPORTED, send };
}
