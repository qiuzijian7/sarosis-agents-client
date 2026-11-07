import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getTodayCount,
  setTodayCount,
  incrementToday,
  todayKey,
  retryPersist,
  __resetForTest,
  recordCompletion,
  getHistory,
} from "../src/storage.js";

// 内存版 localStorage 模拟（node 无 window.localStorage）
function installLs(init = {}) {
  const store = { ...init };
  globalThis.window = {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    },
  };
  return store;
}

function uninstallLs() {
  delete globalThis.window;
}

test("todayKey: 本地时区 YYYY-MM-DD", () => {
  const d = new Date(2026, 10, 6, 23, 59); // 2026-11-06
  assert.equal(todayKey(d), "2026-11-06");
});

test("跨零点：旧日期计数不累加，自动切到新一天归零", () => {
  __resetForTest();
  installLs({ "pomodoro:today": JSON.stringify({ date: "2026-11-05", count: 7 }) });
  const fresh = getTodayCount(new Date(2026, 10, 6));
  assert.equal(fresh.date, "2026-11-06");
  assert.equal(fresh.count, 0); // 新的一天
  uninstallLs();
  __resetForTest();
});

test("脏数据：JSON.parse 失败回退默认，不抛不崩", () => {
  __resetForTest();
  installLs({ "pomodoro:today": "{not-json" });
  const f = getTodayCount(new Date(2026, 10, 6));
  assert.equal(f.date, "2026-11-06");
  assert.equal(f.count, 0);
  uninstallLs();
  __resetForTest();
});

test("incrementToday: 同日期 +1", () => {
  __resetForTest();
  installLs({ "pomodoro:today": JSON.stringify({ date: "2026-11-06", count: 2 }) });
  const r = incrementToday(new Date(2026, 10, 6));
  assert.equal(r.count, 3);
  uninstallLs();
  __resetForTest();
});

test("setTodayCount / getTodayCount 往返一致", () => {
  __resetForTest();
  installLs();
  const v = setTodayCount(5, new Date(2026, 10, 6));
  assert.equal(v.count, 5);
  assert.equal(getTodayCount(new Date(2026, 10, 6)).count, 5);
  uninstallLs();
  __resetForTest();
});

test("retryPersist: 真实写成功返回 true，且 today/task 都落盘", () => {
  __resetForTest();
  const store = installLs();
  const ok = retryPersist(3, "写需求文档");
  assert.equal(ok, true);
  const today = JSON.parse(store["pomodoro:today"]);
  assert.equal(today.count, 3);
  assert.equal(today.date, todayKey());
  assert.equal(store["pomodoro:task"], "写需求文档");
  uninstallLs();
  __resetForTest();
});

test("retryPersist: localStorage.setItem 抛错（无痕/配额）返回 false，不冒充成功", () => {
  __resetForTest();
  // 模拟 setItem 抛错，但不提供 removeItem 走空的兜底 —— 直接让写入失败
  globalThis.window = {
    localStorage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {},
    },
  };
  const ok = retryPersist(3, "任务");
  assert.equal(ok, false); // 调用方必须保持错误态，内存数据不能冒充成功
  uninstallLs();
  __resetForTest();
});

test("recordCompletion: 写入事件数组，空任务名记为「未命名任务」", () => {
  __resetForTest();
  installLs();
  const now = new Date(2026, 10, 6, 10, 0, 0);
  const ev = recordCompletion("写需求文档", now);
  assert.equal(ev.date, "2026-11-06");
  assert.equal(ev.taskName, "写需求文档");
  assert.equal(ev.ts, now.getTime());
  const list = getHistory(now);
  assert.equal(list.length, 1);
  assert.equal(list[0].taskName, "写需求文档");

  // 空任务名 → 未命名任务
  recordCompletion("   ", new Date(2026, 10, 6, 11, 0, 0));
  const list2 = getHistory(now);
  assert.equal(list2.length, 2);
  assert.equal(list2[1].taskName, "未命名任务");
  uninstallLs();
  __resetForTest();
});

test("getHistory: 缺失 / 脏数据 / 非数组 一律回退空数组，不抛不崩", () => {
  __resetForTest();
  // 缺失
  installLs();
  assert.deepEqual(getHistory(new Date(2026, 10, 6)), []);
  uninstallLs();

  // 脏数据（非法 JSON）
  __resetForTest();
  installLs({ "pomodoro:history": "{not-json" });
  assert.deepEqual(getHistory(new Date(2026, 10, 6)), []);
  uninstallLs();

  // 非数组
  __resetForTest();
  installLs({ "pomodoro:history": JSON.stringify({ date: "2026-11-06", n: 1 }) });
  assert.deepEqual(getHistory(new Date(2026, 10, 6)), []);
  uninstallLs();
  __resetForTest();
});

test("recordCompletion + getHistory: 跨多天累加，按日期聚合趋势正确", () => {
  __resetForTest();
  installLs();
  const dayA = new Date(2026, 10, 5, 9, 0, 0);
  const dayB = new Date(2026, 10, 6, 9, 0, 0);
  recordCompletion("任务A", dayA);
  recordCompletion("任务B", dayB);
  recordCompletion("任务C", dayB);
  const list = getHistory(dayB);
  assert.equal(list.length, 3);
  // 按日期计数：DayA=1, DayB=2
  const a = list.filter((e) => e.date === "2026-11-05").length;
  const b = list.filter((e) => e.date === "2026-11-06").length;
  assert.equal(a, 1);
  assert.equal(b, 2);
  uninstallLs();
  __resetForTest();
});
