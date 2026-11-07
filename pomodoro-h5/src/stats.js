// stats.js —— 统计页聚合与渲染（纯函数便于自测，渲染函数接 DOM）
//
// 三态（与 Designer 原型一致）：
//  - 正常：今日 hero 数、最近 7 天柱状趋势（今日高亮）、专注记录列表
//  - 空态：还没有完成的番茄
//  - 错误态：localStorage 读取失败（isStorageAvailable() 为 false）

import { getHistory, getTodayCount, isStorageAvailable, todayKey } from "./storage.js";

/**
 * 计算最近 7 天趋势。今天排在最右、并标记 highlight。
 * @param {Date} [now]
 * @returns {Array<{date:string, count:number, label:string, highlight:boolean}>}
 */
export function computeTrend(now = new Date()) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(now.getDate() - i);
    const dateStr = todayKey(d);
    const label = String(d.getMonth() + 1) + "/" + d.getDate();
    days.push({ date: dateStr, count: 0, label, highlight: false });
  }
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const ev of getHistory(now)) {
    const bucket = byDate.get(ev.date);
    if (bucket) bucket.count += 1;
  }
  days[days.length - 1].highlight = true; // 今日
  return days;
}

/**
 * 计算专注记录列表：按日期聚合，每天一条（同一天多个任务名用「、」合并）。
 * 按日期倒序（最近在前）。
 * @param {Date} [now]
 * @returns {Array<{date:string, count:number, taskName:string}>}
 */
export function computeList(now = new Date()) {
  // 每天维护一个 Set 记录已合并的任务名：用「精确相等」判重，
  // 不能用 indexOf（子串误判会丢任务名，如「任务A」被「任务B/C」包含时 B 丢失）。
  const map = new Map();
  const seen = new Map();
  for (const ev of getHistory(now)) {
    const cur = map.get(ev.date);
    if (!cur) {
      const taskName = ev.taskName;
      map.set(ev.date, { date: ev.date, count: 1, taskName });
      seen.set(ev.date, new Set([taskName]));
    } else {
      cur.count += 1;
      const names = seen.get(ev.date);
      if (!names.has(ev.taskName)) {
        names.add(ev.taskName);
        cur.taskName = cur.taskName + "、" + ev.taskName;
      }
    }
  }
  return [...map.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function el(id) {
  return document.getElementById(id);
}

/** 渲染统计页（由 ui.js 在切换到统计视图时调用）。返回是否渲染成功（false=错误态）。 */
export function renderStats() {
  const normal = el("statsNormal");
  const empty = el("statsEmpty");
  const error = el("statsError");
  if (!normal || !empty || !error) return true; // DOM 未就绪，交给页面默认

  // 错误态：存储不可用
  if (!isStorageAvailable()) {
    normal.hidden = true;
    empty.hidden = true;
    error.hidden = false;
    return false;
  }

  let history = [];
  try {
    history = getHistory();
  } catch {
    normal.hidden = true;
    empty.hidden = true;
    error.hidden = false;
    return false;
  }

  // 空态：没有任何完成记录
  if (history.length === 0) {
    normal.hidden = true;
    error.hidden = true;
    empty.hidden = false;
    const reason = el("statsEmptyReason");
    if (reason) {
      // 新安装 / 凌晨后第一天：today 计数也为 0 ⇒ 给一个友好原因
      const today = getTodayCount();
      reason.textContent =
        today.count === 0
          ? "完成第一个番茄后，这里会显示你的专注趋势。"
          : "今天还差一点点，完成当前番茄就会出现在这里。";
    }
    return true;
  }

  // 正常态
  error.hidden = true;
  empty.hidden = true;
  normal.hidden = false;

  const today = getTodayCount();
  const todayEl = el("statsTodayCount");
  if (todayEl) todayEl.textContent = String(today.count);

  renderTrend(computeTrend());
  renderList(computeList());
  return true;
}

function renderTrend(days) {
  const wrap = el("statsTrend");
  if (!wrap) return;
  const max = Math.max(1, ...days.map((d) => d.count));
  wrap.innerHTML = "";
  for (const d of days) {
    const item = document.createElement("div");
    item.className = "trend-item" + (d.highlight ? " on" : "");

    const bar = document.createElement("div");
    bar.className = "trend-bar";
    bar.style.height = Math.round((d.count / max) * 100) + "%";
    bar.setAttribute("aria-label", d.date + "：" + d.count + " 个");
    if (d.count === 0) bar.classList.add("zero");

    const label = document.createElement("div");
    label.className = "trend-label";
    label.textContent = d.label;

    item.appendChild(bar);
    item.appendChild(label);
    wrap.appendChild(item);
  }
}

function renderList(rows) {
  const ul = el("statsList");
  if (!ul) return;
  ul.innerHTML = "";
  for (const r of rows) {
    const li = document.createElement("li");
    li.className = "history-item";

    const date = document.createElement("span");
    date.className = "history-date";
    date.textContent = r.date;

    const name = document.createElement("span");
    name.className = "history-task";
    name.textContent = r.taskName;
    name.title = r.taskName; // 长任务名 tooltip 显示全文

    const count = document.createElement("span");
    count.className = "history-count";
    count.textContent = r.count + " 个";

    li.appendChild(date);
    li.appendChild(name);
    li.appendChild(count);
    ul.appendChild(li);
  }
}
