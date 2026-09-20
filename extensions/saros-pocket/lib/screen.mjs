// Saros Pocket — 桌面画面采集（远程查看 VsSaros.exe 的 UI）
//
// 为什么需要它：Pocket 原先只能代理 VsSaros 的 **server/web 模式**（HTTP+WS）。
// 桌面版 VsSaros（vssaros.exe，Electron）不暴露 HTTP 端口，代理会 502，手机看不到。
// 参考 billd-desk 的「web 网页观看/控制电脑端」形态：被控端抓屏 → 编码 → 推给浏览器。
//
// 与 billd-desk 的差异（受运行环境影响，非偏好）：
//   - billd-desk 被控端是 Electron 应用，能用 `desktopCapturer` + WebRTC 走硬件编码；
//   - Pocket 跑在 VsSaros 的**扩展宿主**（纯 Node，无 Electron API、不能装原生模块），
//     所以走「PowerShell/系统命令抓屏 → JPEG → MJPEG over HTTP」这条零依赖路线：
//     无原生模块、无 WebRTC 信令、浏览器 <img> 直接渲染，代价是 fps/带宽不如 WebRTC。
//
// 三条后端：
//   - win32  长驻 PowerShell 子进程（抓屏循环，base64 行写 stdout）——实测 ~13fps @0.75
//   - darwin 每帧 `screencapture`（全屏；不支持按窗口）
//   - linux  每帧 `import`（ImageMagick）或 `ffmpeg`（x11grab）

import { spawn, execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 默认采集参数（够看清 + 带宽可控：约 80KB/帧 × 4fps ≈ 320KB/s）。 */
export const DEFAULTS = Object.freeze({
  fps: 4,
  quality: 55,
  scale: 0.5,
  mode: 'window',      // 'window' = 只抓 VsSaros 窗口；'screen' = 整屏
  processName: 'vssaros',
  monitor: -1,         // -1 = 主屏
  maxWidth: 0,         // 0 = 不限制；>0 时按「观看端显示宽度」再压一道缩放
  idleStopMs: 3000,    // 无人观看多久后停掉采集进程
});

const FPS_LIMITS = Object.freeze({ min: 1, max: 15 });

/** Windows 采集脚本：长驻循环，逐帧输出 base64(JPEG)，诊断信息走 stderr。 */
const WIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::ASCII } catch { }
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public struct SRECT { public int Left; public int Top; public int Right; public int Bottom; }
public class SWin {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out SRECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@
function Read-Num($name, $fallback) {
  $v = [double](Get-Item "Env:\$name" -ErrorAction SilentlyContinue).Value
  if ($null -eq $v -or $v -le 0) { return [double]$fallback }
  return $v
}
$fps = Read-Num 'SAROS_POCKET_FPS' 4
if ($fps -gt 15) { $fps = 15 }
if ($fps -lt 1) { $fps = 1 }
$quality = [long](Read-Num 'SAROS_POCKET_QUALITY' 55)
if ($quality -lt 10) { $quality = 55 }
if ($quality -gt 95) { $quality = 95 }
$scale = Read-Num 'SAROS_POCKET_SCALE' 0.5
if ($scale -gt 1) { $scale = 1 }
$maxWidth = Read-Num 'SAROS_POCKET_MAX_WIDTH' 0
$mode = $env:SAROS_POCKET_MODE
$proc = $env:SAROS_POCKET_PROCESS
$monitor = 0
[void][int]::TryParse($env:SAROS_POCKET_MONITOR, [ref]$monitor)
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, $quality)
$interval = [int](1000 / $fps)
function Get-TargetRect {
  if ($mode -eq 'window' -and $proc) {
    $p = Get-Process -Name $proc -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p -and -not [SWin]::IsIconic($p.MainWindowHandle)) {
      $r = New-Object SRECT
      if ([SWin]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
        $w = $r.Right - $r.Left
        $h = $r.Bottom - $r.Top
        if ($w -gt 64 -and $h -gt 64) {
          return @{ X = $r.Left; Y = $r.Top; W = $w; H = $h; Hwnd = $p.MainWindowHandle }
        }
      }
    }
  }
  $screens = [System.Windows.Forms.Screen]::AllScreens
  if ($monitor -ge 0 -and $monitor -lt $screens.Length) { $s = $screens[$monitor] } else { $s = [System.Windows.Forms.Screen]::PrimaryScreen }
  return @{ X = $s.Bounds.X; Y = $s.Bounds.Y; W = $s.Bounds.Width; H = $s.Bounds.Height; Hwnd = [IntPtr]::Zero }
}
while ($true) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $t = Get-TargetRect
  try {
    $src = New-Object System.Drawing.Bitmap $t.W, $t.H
    $g = [System.Drawing.Graphics]::FromImage($src)
    if ($t.Hwnd -ne [IntPtr]::Zero) {
      $hdc = $g.GetHdc()
      $ok = [SWin]::PrintWindow($t.Hwnd, $hdc, 2)
      $g.ReleaseHdc($hdc)
      if (-not $ok) { $g.CopyFromScreen($t.X, $t.Y, 0, 0, $src.Size) }
    } else {
      $g.CopyFromScreen($t.X, $t.Y, 0, 0, $src.Size)
    }
    $g.Dispose()
    # 实际缩放：min(设定缩放, 观看端宽度上限 / 区域宽)——区域会随窗口变化，故每帧算
    $eff = $scale
    if ($maxWidth -gt 0 -and $t.W -gt 0) {
      $byWidth = $maxWidth / $t.W
      if ($byWidth -lt $eff) { $eff = $byWidth }
    }
    if ($eff -gt 1) { $eff = 1 }
    if ($eff -lt 0.1) { $eff = 0.1 }
    $dstW = [int]($t.W * $eff)
    $dstH = [int]($t.H * $eff)
    $dst = $src
    if ($eff -lt 0.999) {
      $dst = New-Object System.Drawing.Bitmap $dstW, $dstH
      $g2 = [System.Drawing.Graphics]::FromImage($dst)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($src, 0, 0, $dstW, $dstH)
      $g2.Dispose()
    }
    $ms = New-Object System.IO.MemoryStream
    $dst.Save($ms, $codec, $ep)
    [Console]::Error.WriteLine("SAROS_RECT $($t.X) $($t.Y) $($t.W) $($t.H)")
    [Console]::Out.WriteLine([Convert]::ToBase64String($ms.ToArray()))
    [Console]::Out.Flush()
    $ms.Dispose()
    if ($dst -ne $src) { $dst.Dispose() }
    $src.Dispose()
  } catch {
    [Console]::Error.WriteLine($_.Exception.Message)
  }
  $wait = $interval - $sw.ElapsedMilliseconds
  if ($wait -gt 0) { Start-Sleep -Milliseconds $wait }
}
`;

function clampConfig(raw) {
  const c = { ...DEFAULTS, ...(raw ?? {}) };
  const fps = Number(c.fps);
  const quality = Number(c.quality);
  const scale = Number(c.scale);
  return {
    fps: Number.isFinite(fps) ? Math.min(FPS_LIMITS.max, Math.max(FPS_LIMITS.min, fps)) : DEFAULTS.fps,
    quality: Number.isFinite(quality) ? Math.min(95, Math.max(10, Math.round(quality))) : DEFAULTS.quality,
    scale: Number.isFinite(scale) ? Math.min(1, Math.max(0.2, scale)) : DEFAULTS.scale,
    mode: c.mode === 'screen' ? 'screen' : 'window',
    processName: String(c.processName ?? DEFAULTS.processName).trim() || DEFAULTS.processName,
    monitor: Number.isInteger(Number(c.monitor)) ? Number(c.monitor) : DEFAULTS.monitor,
    // 观看端显示宽度上限：手机屏小，让它下载 2K 帧纯属浪费带宽/解码。
    // 实际缩放 = min(scale, maxWidth / 采集区域宽)，由采集脚本每帧算（区域会变）。
    maxWidth: Number(c.maxWidth) > 0 ? Math.round(Number(c.maxWidth)) : 0,
  };
}

/** 当前平台的采集后端（null = 不支持）。 */
export function backendFor(platform = process.platform) {
  if (platform === 'win32') return 'powershell';
  if (platform === 'darwin') return 'screencapture';
  if (platform === 'linux') return 'imagemagick';
  return null;
}

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout, stderr });
    });
  });
}

/**
 * 创建屏幕采集源（懒启动：有人订阅才抓屏，没人看 3 秒后停）。
 * @param {object} opts
 * @param {() => object} [opts.getConfig] 采集参数（fps/quality/scale/mode/processName/monitor）
 * @param {() => boolean} [opts.enabled] 总开关（false 时拒绝启动）
 * @param {object} [opts.log] 日志
 */
export function createScreenSource({ getConfig = () => ({}), enabled = () => true, log = console } = {}) {
  const logLine = (msg) => {
    if (log?.appendLine) log.appendLine(msg);
    else (log?.info ?? log?.log ?? (() => { })).call(log, msg);
  };

  const platform = process.platform;
  const backend = backendFor(platform);
  const subscribers = new Set();
  let child = null;
  let idleTimer = null;
  let config = clampConfig(getConfig());
  let lastFrame = null;
  let lastFrameAt = 0;
  let lastError = null;
  let frames = 0;
  let rect = null;      // 当前采集区域（屏幕绝对坐标，供输入映射）
  let stopping = false;

  function emit(frame) {
    frames += 1;
    lastFrame = frame;
    lastFrameAt = Date.now();
    for (const fn of Array.from(subscribers)) {
      try { fn(frame); } catch { /* 单个订阅者出错不影响其他 */ }
    }
  }

  function stop(reason) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (child) {
      const c = child;
      child = null;
      stopping = true;
      try { c.kill(); } catch { /* 已退出 */ }
      setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* 忽略 */ } }, 1500).unref?.();
      logLine(`Saros Pocket: 屏幕采集已停止（${reason}）`);
    }
    stopping = false;
  }

  function startWindows() {
    const childEnv = {
      ...process.env,
      SAROS_POCKET_FPS: String(config.fps),
      SAROS_POCKET_QUALITY: String(config.quality),
      SAROS_POCKET_SCALE: String(config.scale),
      SAROS_POCKET_MODE: config.mode,
      SAROS_POCKET_PROCESS: config.processName,
      SAROS_POCKET_MONITOR: String(config.monitor),
      SAROS_POCKET_MAX_WIDTH: String(config.maxWidth ?? 0),
    };
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_SCRIPT,
    ], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let buf = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { emit(Buffer.from(line, 'base64')); } catch { /* 非法帧丢弃 */ }
      }
    });
    let errBuf = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      errBuf += chunk;
      let idx;
      while ((idx = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, idx).trim();
        errBuf = errBuf.slice(idx + 1);
        if (!line) continue;
        const m = /^SAROS_RECT\s+(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)/.exec(line);
        if (m) {
          rect = { x: Number(m[1]), y: Number(m[2]), width: Number(m[3]), height: Number(m[4]) };
          continue;
        }
        lastError = line.slice(0, 500);
      }
    });
    proc.on('error', (err) => { lastError = String(err?.message ?? err); });
    proc.on('exit', (code) => {
      if (child === proc) child = null;
      if (!stopping && code != null) logLine(`Saros Pocket: 屏幕采集进程退出（code=${code}）`);
    });
    return proc;
  }

  /** 非 Windows：每帧起一次系统命令（macOS screencapture / Linux import|ffmpeg）。 */
  async function captureOnce() {
    const file = join(tmpdir(), `saros-pocket-frame-${process.pid}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    try {
      if (backend === 'screencapture') {
        const args = ['-x', '-C', '-t', 'jpg'];
        if (config.mode === 'screen' && config.monitor >= 0) args.push('-m');
        args.push(file);
        const r = await run('screencapture', args, 5000);
        if (r.err) throw new Error(`screencapture 失败：${r.err.message}`);
        return await readFile(file);
      }
      if (backend === 'imagemagick') {
        const r = await run('import', ['-window', 'root', '-quality', String(config.quality), `jpeg:${file}`], 8000);
        if (r.err) {
          const f = await run('ffmpeg', ['-y', '-f', 'x11grab', '-i', ':0', '-frames:v', '1', '-q:v', '3', file], 8000);
          if (f.err) throw new Error(`未找到可用的抓屏命令（import / ffmpeg 都不可用）：${r.err.message}`);
        }
        return await readFile(file);
      }
      throw new Error(`当前平台不支持屏幕采集：${platform}`);
    } finally {
      await rm(file, { force: true }).catch(() => { });
    }
  }

  async function startFallbackLoop() {
    // 用定时器驱动的单帧采集（macOS/Linux）
    const tick = async () => {
      if (!child) return;
      try {
        const buf = await captureOnce();
        emit(buf);
      } catch (err) {
        lastError = String(err?.message ?? err);
      }
      if (child) child.timer = setTimeout(tick, Math.max(60, Math.round(1000 / config.fps)));
    };
    const fake = { kill: () => { if (fake.timer) clearTimeout(fake.timer); }, timer: null };
    child = fake;
    void tick();
    return fake;
  }

  async function ensureStarted() {
    if (child) return child;
    if (!backend) throw new Error(`当前平台不支持屏幕采集：${platform} | screen capture unsupported`);
    if (enabled() === false) throw new Error('桌面画面已关闭：请开启 sarosPocket.desktopEnabled | desktop view disabled');
    config = clampConfig(getConfig());
    lastError = null;
    if (backend === 'powershell') child = startWindows();
    else child = await startFallbackLoop();
    logLine(`Saros Pocket: 屏幕采集启动（backend=${backend} mode=${config.mode} fps=${config.fps} scale=${config.scale}）`);
    return child;
  }

  return {
    backend,
    platform,
    /** 订阅帧；(frame: Buffer) => void —— 返回 false 表示背压（调用方可丢帧）。 */
    subscribe(fn) {
      subscribers.add(fn);
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      ensureStarted().catch((err) => { lastError = String(err?.message ?? err); });
      if (lastFrame) {
        try { fn(lastFrame); } catch { /* 忽略 */ }
      }
      return () => {
        subscribers.delete(fn);
        if (subscribers.size === 0) {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => { if (subscribers.size === 0) stop('无人观看'); }, DEFAULTS.idleStopMs);
          idleTimer.unref?.();
        }
      };
    },
    /** 单帧快照（截图按钮 / 轮询模式）。 */
    async snapshot() {
      if (!backend) throw new Error(`当前平台不支持屏幕采集：${platform}`);
      if (enabled() === false) throw new Error('桌面画面已关闭 | desktop view disabled');
      if (backend === 'powershell') {
        await ensureStarted();
        // 等第一帧（最多 5 秒）
        const started = frames;
        for (let i = 0; i < 100 && frames === started; i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!lastFrame) throw new Error(lastError ?? '抓屏超时 | capture timeout');
        return lastFrame;
      }
      return captureOnce();
    },
    /** 修改参数后重启采集（下次订阅/下一帧生效）。 */
    reconfigure(patch) {
      config = clampConfig({ ...config, ...(patch ?? {}) });
      const had = subscribers.size > 0;
      stop('参数变更');
      if (had) ensureStarted().catch((err) => { lastError = String(err?.message ?? err); });
      return config;
    },
    config: () => ({ ...config }),
    rect: () => (rect ? { ...rect } : null),
    status() {
      return {
        supported: backend !== null,
        platform,
        backend,
        running: child !== null,
        clients: subscribers.size,
        frames,
        lastFrameAt: lastFrameAt || null,
        lastFrameBytes: lastFrame?.length ?? null,
        rect: rect ? { ...rect } : null,
        config: { ...config },
        lastError,
      };
    },
    dispose() {
      subscribers.clear();
      stop('扩展卸载');
    },
  };
}

/** MJPEG 边界。 */
export const MJPEG_BOUNDARY = '--saros-pocket-frame';
