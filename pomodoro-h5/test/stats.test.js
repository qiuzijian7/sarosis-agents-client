// 纯函数聚合测试（不依赖 DOM / 渲染）
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTrend, computeList } from "../src/stats.js";
import { recordCompletion, __resetForTest, todayKey } from "../src/storage.js";

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

test("computeTrend: 返回最近 7 天，今天排末位且高亮，计数正确", () => {
  __resetForTest();
  installLs();
  const now = new Date(2026, 10, 6, 12, 0, 0); // 2026-11-06
  recordCompletion("A", new Date(2026, 10, 4, 9, 0, 0)); // 11-04 →1
  recordCompletion("B", new Date(2026, 10, 6, 9, 0, 0)); // 11-06 →1
  recordCompletion("C", new Date(2026, 10, 6, 10, 0, 0)); // 11-06 →2

  const days = computeTrend(now);
  assert.equal(days.length, 7);
  // 末位为今天
  assert.equal(days[6].date, todayKey(now));
  assert.equal(days[6].highlight, true);
  assert.equal(days[6].count, 2);
  // 11-04 命中
  const d4 = days.find((d) => d.date === "2026-11-04");
  assert.equal(d4.count, 1);
  // 其余为 0
  const zeros = days.filter((d) => d.count === 0);
  assert.equal(zeros.length, 5);
  uninstallLs();
  __resetForTest();
});

test("computeList: 同一天多任务合并（、分隔），按日期倒序", () => {
  __resetForTest();
  installLs();
  const dayA = new Date(2026, 10, 5, 9, 0, 0); // 11-05 先发生
  const dayB = new Date(2026, 10, 6, 9, 0, 0); // 11-06 后发生
  recordCompletion("任务A", dayA);
  recordCompletion("任务B", dayB);
  recordCompletion("任务C", dayB);

  const rows = computeList(dayB);
  assert.equal(rows.length, 2);
  // 倒序：今天（11-06）在前
  assert.equal(rows[0].date, "2026-11-06");
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].taskName, "任务B、任务C"); // 同日期合并
  assert.equal(rows[1].date, "2026-11-05");
  assert.equal(rows[1].count, 1);
  assert.equal(rows[1].taskName, "任务A");
  uninstallLs();
  __resetForTest();
});

test("computeList: 同任务同日不重复合并", () => {
  __resetForTest();
  installLs();
  const dayB = new Date(2026, 10, 6, 9, 0, 0);
  recordCompletion("任务B", dayB);
  recordCompletion("任务B", dayB);
  const rows = computeList(dayB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].taskName, "任务B"); // 不出现「任务B、任务B」
  uninstallLs();
  __resetForTest();
});

test("computeList: 子串误判不丢任务名（Set 精确判重）", () => {
  __resetForTest();
  installLs();
  const day = new Date(2026, 10, 6, 9, 0, 0);
  // 「任务A」是「任务AB」的子串；旧 indexOf 判重会丢「任务A」。
  recordCompletion("任务AB", day);
  recordCompletion("任务A", day);
  recordCompletion("任务C", day);
  const rows = computeList(day);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 3);
  // 三个任务名都应保留，不能因为子串关系而丢失
  const names = rows[0].taskName.split("、").sort();
  assert.deepEqual(names, ["任务A", "任务AB", "任务C"]);
  uninstallLs();
  __resetForTest();
});

test("computeTrend / computeList: 无记录时趋势全 0、列表空", () => {
  __resetForTest();
  installLs();
  const now = new Date(2026, 10, 6);
  assert.equal(computeList(now).length, 0);
  const days = computeTrend(now);
  assert.equal(days.length, 7);
  assert.ok(days.every((d) => d.count === 0));
  uninstallLs();
  __resetForTest();
});
