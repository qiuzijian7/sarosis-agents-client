// ui.js —— 视图层：把计时核心 + 存储封装接到 DOM，并维护三态（正常 / 空态 / 错误态）。
import { createTimer, PHASE } from "./timer.js";
import {
  getTodayCount,
  setTodayCount,
  incrementToday,
  getTask,
  setTask,
  isStorageAvailable,
  retryPersist,
  recordCompletion,
} from "./storage.js";
import { renderStats } from "./stats.js";

const RADIUS = 110;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS; // 动态算周长，不写死 691

const STATUS_TEXT = {
  idle: "准备开始",
  running: "进行中",
  paused: "已暂停",
  finished: "已完成",
};

const $ = (id) => document.getElementById(id);

const els = {
  root: document.querySelector(".phone"),
  modeLabel: $("modeLabel"),
  taskInput: $("taskInput"),
  emptyCard: $("emptyCard"),
  errorBanner: $("errorBanner"),
  retryBtn: $("retryBtn"),
  prog: $("prog"),
  time: $("time"),
  stateLabel: $("stateLabel"),
  startBtn: $("startBtn"),
  pauseBtn: $("pauseBtn"),
  resetBtn: $("resetBtn"),
  todayCount: $("todayCount"),
  todayHint: $("todayHint"),
  // 统计页与视图切换
  topTitle: $("topTitle"),
  viewTask: $("view-task"),
  viewStats: $("view-stats"),
  navTask: $("navTask"),
  navStat: $("navStat"),
  statsGoFocus: $("statsGoFocus"),
  statsRetry: $("statsRetry"),
};

const timer = createTimer();
const TICK_MS = 250;
let tickHandle = null;
let storageOk = true;

function fmt(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function render() {
  const snap = timer.snapshot();
  els.modeLabel.textContent = snap.modeLabel;

  // 圆环进度：剩余比例 → dashoffset
  const ratio = snap.totalMs > 0 ? snap.remainingMs / snap.totalMs : 0;
  els.prog.style.strokeDasharray = String(CIRCUMFERENCE);
  els.prog.style.strokeDashoffset = String(CIRCUMFERENCE * (1 - ratio));

  els.time.textContent = fmt(snap.remainingMs);
  els.stateLabel.textContent = STATUS_TEXT[snap.status] || "";

  // 控制按钮可用性：开始前 / 暂停中，暂停键禁用
  els.pauseBtn.disabled = snap.status !== "running";
  els.startBtn.disabled = snap.status === "running";
  els.resetBtn.disabled = snap.status === "idle" && snap.remainingMs === snap.totalMs;

  // 空态：任务名为空时提示（仍可开始）
  els.emptyCard.hidden = els.taskInput.value.trim().length > 0;

  // 错误态横幅
  els.errorBanner.hidden = storageOk;

  // 今日计数
  const today = getTodayCount();
  els.todayCount.textContent = String(today.count);
  const left = 4 - (today.count % 4);
  els.todayHint.textContent =
    today.count === 0 ? "今天还没开始" : `还差 ${left} 个进入长休息`;
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
  const now = Date.now();
  const res = timer.tick(now);
  if (res.finished) {
    onPhaseFinished(res);
  }
  render();
}

function onPhaseFinished(res) {
  if (res.finishedPhase === PHASE.FOCUS) {
    // 完成一个番茄：写今日计数 + 记录完成事件（可能抛错 → 错误态）
    try {
      incrementToday();
      recordCompletion(els.taskInput.value.trim());
    } catch {
      storageOk = false;
    }
    notifyDone("专注完成，休息一下 🍅");
  } else {
    notifyDone(res.finishedPhase === PHASE.LONG_BREAK ? "长休息结束" : "短休息结束");
  }
  // 自动进入下一阶段（idle 等待用户开始），并刷新显示
  timer.reset();
  stopTick();
  startTick(); // 保持 tick 循环；reset 后 status=idle 不漂移
  render();
}

function notifyDone(msg) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(msg);
  }
}

// —— 事件绑定 ——
els.startBtn.addEventListener("click", () => {
  // 开始前先尝试保存任务名，验证存储是否可用
  try {
    setTask(els.taskInput.value.trim());
    storageOk = true;
  } catch {
    storageOk = false; // 真实写失败 → 错误态
  }
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

els.taskInput.addEventListener("input", () => {
  try {
    setTask(els.taskInput.value.trim());
    storageOk = true;
  } catch {
    storageOk = false;
  }
  render();
});

els.retryBtn.addEventListener("click", () => {
  // 必须真碰 localStorage 且成功才消横幅；内存兜底写入不算成功
  const ok = retryPersist(getTodayCount().count, els.taskInput.value.trim());
  storageOk = ok;
  render();
});

// 后台/锁屏回到前台：用 Date.now() 重新校准，避免节流导致少算
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    timer.recalibrate(Date.now());
    // 后台期间若番茄已跑完（remaining ≤ 0）：回前台必须真的触发完成 + 今日+1，
    // 不能只把读数重绘成 0（比节流更隐蔽的漏计数路径）。
    // 暂停态下 recalibrate/tick 均不生效，remaining 保持不变——符合点 2。
    const res = timer.tick(Date.now());
    if (res.finished) onPhaseFinished(res);
    // 跨零点：重新读取今日计数
    render();
  }
});

// —— 视图切换（SPA：#task / #stats）——
function showView(view) {
  const isStats = view === "stats";
  if (els.viewTask) els.viewTask.hidden = isStats;
  if (els.viewStats) els.viewStats.hidden = !isStats;
  if (els.navTask) els.navTask.classList.toggle("active", !isStats);
  if (els.navStat) els.navStat.classList.toggle("active", isStats);
  // 屏幕阅读器可感知当前页
  if (els.navTask) {
    if (isStats) els.navTask.removeAttribute("aria-current");
    else els.navTask.setAttribute("aria-current", "page");
  }
  if (els.navStat) {
    if (isStats) els.navStat.setAttribute("aria-current", "page");
    else els.navStat.removeAttribute("aria-current");
  }
  if (els.topTitle) els.topTitle.textContent = isStats ? "统计" : "番茄钟";
  if (els.modeLabel) els.modeLabel.hidden = isStats;
  if (isStats) renderStats();
}

function currentView() {
  return location.hash === "#stats" ? "stats" : "task";
}

window.addEventListener("hashchange", () => showView(currentView()));

// 统计页「去专注」按钮：切回任务页
if (els.statsGoFocus) {
  els.statsGoFocus.addEventListener("click", () => {
    location.hash = "#task";
  });
}

// 统计页「重试读取」按钮：与首页错误态一致 —— 必须真碰 localStorage 重新探测可用
// 性（retryPersist 会重置不可用语并真实写入），再刷新统计视图。
if (els.statsRetry) {
  els.statsRetry.addEventListener("click", () => {
    retryPersist(getTodayCount().count, els.taskInput.value.trim());
    showView("stats");
  });
}

// 初始化
function init() {
  // 回填任务名
  try {
    els.taskInput.value = getTask();
  } catch {
    /* 读取失败忽略 */
  }
  storageOk = isStorageAvailable();
  render();
  showView(currentView());
}

init();
