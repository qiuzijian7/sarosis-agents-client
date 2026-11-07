// storage.js —— localStorage 封装（带 try/catch，安全降级，含跨零点按日计数）
//
// 口径（与 Code Reviewer / Designer 对齐）：
//  - key 统一加 `pomodoro:` 前缀，避免与其他应用串号。
//  - 读写全包 try/catch：无痕模式 / 配额超限 / 被禁用时抛错 ⇒ 降级内存态，不崩页。
//  - 今日计数按 `YYYY-MM-DD` 存；处理跨零点（App 开着过夜，过 0 点自动切新一天）。
//  - JSON.parse 失败回退默认值，脏数据不传染。

const PREFIX = "pomodoro:";
const KEY_TODAY = PREFIX + "today"; // { date: 'YYYY-MM-DD', count: number }
const KEY_TASK = PREFIX + "task"; // 当前任务名（字符串）
const KEY_HISTORY = PREFIX + "history"; // 完成事件数组：[{ date, taskName, ts }]

// 内存兜底：当 localStorage 不可用时，所有写入只进内存，并标记 unavailable。
let memoryStore = {};
let storageUnavailable = false;

function getRaw(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    storageUnavailable = true;
    return memoryStore[key] ?? null;
  }
}

function setRaw(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    storageUnavailable = true;
    memoryStore[key] = value;
    // 把原因抛给上层，由 UI 触发错误态
    const err = new Error("localStorage 写入失败");
    err.code = "STORAGE_WRITE_FAILED";
    throw err;
  }
}

export function isStorageAvailable() {
  // 重新探测：若之前已失败则直接返回 false，否则做一次探针
  if (storageUnavailable) return false;
  try {
    const probe = PREFIX + "__probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    storageUnavailable = true;
    return false;
  }
}

/** 本地日期字符串 `YYYY-MM-DD`（用本地时区，避免与「今日」语义错位）。 */
export function todayKey(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 读取今日已完成番茄数；跨零点或脏数据时自动归零。
 * @returns {{date:string,count:number}}
 */
export function getTodayCount(now = new Date()) {
  const key = todayKey(now);
  const fallback = { date: key, count: 0 };
  let raw;
  try {
    raw = getRaw(KEY_TODAY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 脏数据：兜底为今天 0，不传染
    try {
      setRaw(KEY_TODAY, JSON.stringify(fallback));
    } catch {
      /* 忽略：写入失败由调用方感知 */
    }
    return fallback;
  }
  if (
    !parsed ||
    typeof parsed.date !== "string" ||
    typeof parsed.count !== "number" ||
    !Number.isFinite(parsed.count)
  ) {
    return fallback;
  }
  // 跨零点：日期不同 ⇒ 新的一天，计数归零
  if (parsed.date !== key) {
    const fresh = { date: key, count: 0 };
    try {
      setRaw(KEY_TODAY, JSON.stringify(fresh));
    } catch {
      /* 忽略 */
    }
    return fresh;
  }
  return { date: parsed.date, count: Math.max(0, Math.floor(parsed.count)) };
}

/**
 * 写入今日计数；跨零点自动以新的一天计。可能抛 STORAGE_WRITE_FAILED。
 * @param {number} count
 * @param {Date} [now]
 */
export function setTodayCount(count, now = new Date()) {
  const key = todayKey(now);
  const value = { date: key, count: Math.max(0, Math.floor(count)) };
  setRaw(KEY_TODAY, JSON.stringify(value));
  return value;
}

/** 完成一个番茄：读取今日（含跨零点处理）并 +1，写入后返回最新值。 */
export function incrementToday(now = new Date()) {
  const cur = getTodayCount(now);
  const next = setTodayCount(cur.count + 1, now);
  return next;
}

/**
 * 记录一次番茄完成事件（供统计页的趋势与历史列表使用）。
 * 与 setTodayCount 同口径：写入失败抛 STORAGE_WRITE_FAILED ⇒ 上层进入错误态。
 * @param {string} taskName 当前任务名（空串记为「未命名任务」）
 * @param {Date} [now]
 * @returns {{date:string,taskName:string,ts:number}} 本次写入的事件
 */
export function recordCompletion(taskName, now = new Date()) {
  const date = todayKey(now);
  const name = (taskName && String(taskName).trim()) || "未命名任务";
  const event = { date, taskName: name, ts: now.getTime() };
  let list = [];
  try {
    const raw = getRaw(KEY_HISTORY);
    if (raw) list = JSON.parse(raw);
    if (!Array.isArray(list)) list = [];
  } catch {
    list = [];
  }
  list.push(event);
  setRaw(KEY_HISTORY, JSON.stringify(list)); // 可能抛 STORAGE_WRITE_FAILED
  return event;
}

/**
 * 读取完成事件历史；缺失 / 解析失败 / 脏数据一律回退空数组（不抛不崩）。
 * @param {Date} [now]
 * @returns {Array<{date:string,taskName:string,ts:number}>}
 */
export function getHistory(now = new Date()) {
  try {
    const raw = getRaw(KEY_HISTORY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e) =>
        e &&
        typeof e.date === "string" &&
        typeof e.taskName === "string" &&
        typeof e.ts === "number"
    );
  } catch {
    return [];
  }
}

export function getTask() {
  try {
    return getRaw(KEY_TASK) || "";
  } catch {
    return "";
  }
}

export function setTask(name) {
  setRaw(KEY_TASK, String(name ?? ""));
}

/**
 * 重试持久化：真正去碰一次 localStorage.setItem，且只有「真成功」才返回 true。
 * - 先重置不可用语，强制再做一次真实探测（否则会一直读内存兜底而误判）。
 * - 若 setRaw 抛错（无痕/配额/禁用），返回 false ⇒ 调用方应保持错误态，不让内存里的数据冒充成功。
 * @param {number} todayCount 当前要写回的今日计数
 * @param {string} taskName 当前任务名
 * @returns {boolean} 真实写入 localStorage 是否成功
 */
export function retryPersist(todayCount, taskName) {
  storageUnavailable = false; // 重新探测真实可用性
  try {
    setRaw(
      KEY_TODAY,
      JSON.stringify({ date: todayKey(), count: Math.max(0, Math.floor(todayCount || 0)) })
    );
    setRaw(KEY_TASK, String(taskName ?? ""));
    return true;
  } catch {
    // 真写不进：保持错误态（storageUnavailable 已在 setRaw 内置 true）
    return false;
  }
}

/** 仅供测试注入：重置内存兜底与不可用语（node 环境无 window 时）。 */
export function __resetForTest() {
  memoryStore = {};
  storageUnavailable = false;
}
