// anime.js —— 二次元番茄钟视图层（独立入口）。
// 复用已验证的纯函数核心，不自写计时或存储逻辑（见 key 记忆「二次元视觉规范」第⑦点）：
//   - src/timer.js：createTimer / PHASE / DEFAULT_DURATIONS
//   - src/storage.js：getTodayCount / incrementToday / recordCompletion / retryPersist
// 计时校准（endAt 绝对时间戳 + 250ms 重绘 + visibilitychange 回前台 recalibrate→tick）、
// 跨零点、错误态重试口径，与首页 ui.js / 像素版 pixel.js / 卡通版 cartoon.js 完全一致。
// 不抄 pixel.js 的 notifyDone 死代码（从未 requestPermission，通知恒不弹）。

import { createTimer, PHASE } from "../timer.js";
import {
  getTodayCount,
  incrementToday,
  recordCompletion,
  retryPersist,
  isStorageAvailable,
} from "../storage.js";
import { renderStats } from "../stats.js";

const TICK_MS = 250;
const STATUS_TEXT = {
  idle: "准备开始",
  running: "专注中",
  paused: "已暂停",
  finished: "已完成",
};

const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  phaseLabel: $("phaseLabel"),
  time: $("time"),
  stage: $("stage"),
  stateLabel: $("stateLabel"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  resetBtn: $("resetBtn"),
  todayCount: $("todayCount"),
  errorBanner: $("errorBanner"),
  retryBtn: $("retryBtn"),
  viewTask: $("view-task"),
  viewStats: $("view-stats"),
  navTask: $("navTask"),
  navStat: $("navStat"),
  statsGoFocus: $("statsGoFocus"),
  statsRetry: $("statsRetry"),
};

const timer = createTimer();
let tickHandle = null;
let storageOk = true;

// 二次元时钟：把 "MM:SS" 写进 #time 文本（单一元素，靠 tabular-nums 等宽不抖）。
function renderClock(text) {
  els.time.textContent = text;
  els.time.setAttribute("aria-label", `剩余 ${text.replace(":", " 分 ")} 秒`);
}

function fmt(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function render() {
  const snap = timer.snapshot();
  els.phaseLabel.textContent = snap.modeLabel;

  // 阶段配色：专注=莓粉、休息=糖果蓝，套在 .anime-app 上驱动 .anime-phase 颜色
  els.app.classList.toggle("is-focus", snap.phase === PHASE.FOCUS);
  els.app.classList.toggle("is-break", snap.phase !== PHASE.FOCUS);

  renderClock(fmt(snap.remainingMs));
  els.stateLabel.textContent = STATUS_TEXT[snap.status] || "";

  // 控制按钮可用性：运行前 / 暂停中，暂停键禁用（与首页口径一致）
  els.pauseBtn.disabled = snap.status !== "running";
  els.startBtn.disabled = snap.status === "running";
  els.resetBtn.disabled = snap.status === "idle" && snap.remainingMs === snap.totalMs;

  // 错误态横幅：真实写失败才显示
  els.errorBanner.hidden = storageOk;

  // 今日计数（含跨零点）
  els.todayCount.textContent = String(getTodayCount().count);
}

function startTick() {
  if (tickHandle) return;
  tickHandle = setInterval(onTick, TICK_MS);
}

function stopTick() {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

function onTick() {
  const res = timer.tick(Date.now());
  if (res.finished) onPhaseFinished(res);
  render();
}

function onPhaseFinished(res) {
  if (res.finishedPhase === PHASE.FOCUS) {
    // 完成一个番茄：写今日计数 + 记录完成事件（可能抛错 → 错误态）
    try {
      incrementToday();
      recordCompletion(""); // MVP 无任务输入框，记「未命名任务」
    } catch {
      storageOk = false;
    }
  }
  // 自动进入下一阶段（idle 等待用户开始），并刷新显示
  timer.reset();
  stopTick();
  startTick(); // 保持 tick 循环；reset 后 status=idle 不漂移
  render();
}

// —— 事件绑定 ——
els.startBtn.addEventListener("click", () => {
  // 开始前先探测存储是否可用（真实写失败 → 错误态）
  storageOk = isStorageAvailable();
  timer.start();
  startTick();
  render();
});

els.pauseBtn.addEventListener("click", () => {
  timer.pause();
  stopTick();
  render();
});

els.resetBtn.addEventListener("click", () => {
  timer.reset();
  stopTick();
  render();
});

els.retryBtn.addEventListener("click", () => {
  // 必须真碰 localStorage 且成功才消横幅；内存兜底写入不算成功
  storageOk = retryPersist(getTodayCount().count, "");
  render();
});

// —— 统计视图（SPA：location.hash 切换 #task / #stats，复用 src/stats.js renderStats）——
function currentView() {
  return location.hash === "#stats" ? "stats" : "task";
}

function showView(view) {
  const isStats = view === "stats";
  els.viewStats.hidden = !isStats;
  els.viewTask.hidden = isStats;

  // tabbar 高亮（.active + aria-current，与首页镜像）
  els.navStat.classList.toggle("active", isStats);
  els.navTask.classList.toggle("active", !isStats);
  els.navStat.setAttribute("aria-current", isStats ? "page" : "false");
  els.navTask.setAttribute("aria-current", isStats ? "false" : "page");

  // 进入统计页时渲染三态（正常/空态/错误态由 src/stats.js 驱动）
  if (isStats) renderStats();
}

els.statsGoFocus.addEventListener("click", () => {
  location.hash = "#task";
});

els.statsRetry.addEventListener("click", () => {
  // 错误态重试：真碰 localStorage 重探测，再回统计页渲染
  storageOk = retryPersist(getTodayCount().count, "");
  showView("stats");
});

window.addEventListener("hashchange", () => showView(currentView()));

// 后台/锁屏回到前台：用 Date.now() 重新校准，避免节流导致少算
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    timer.recalibrate(Date.now());
    // 后台期间若番茄已跑完：回前台必须真的触发完成 + 今日+1，
    // 不能只把读数重绘成 0（漏计数路径）。暂停态下 recalibrate/tick 均不生效。
    const res = timer.tick(Date.now());
    if (res.finished) onPhaseFinished(res);
    render();
  }
});

// 初始化
storageOk = isStorageAvailable();
render();
showView(currentView());
