import { test } from "node:test";
import assert from "node:assert/strict";
import { createTimer, PHASE } from "../src/timer.js";

test("idle: 初始为专注阶段、未开始、剩余=专注时长", () => {
  const t = createTimer({}, 0);
  const s = t.snapshot();
  assert.equal(s.phase, PHASE.FOCUS);
  assert.equal(s.status, "idle");
  assert.equal(s.remainingMs, 25 * 60 * 1000);
});

test("start: 进入 running 且用 endAt=now+remaining 算剩余", () => {
  const t = createTimer({}, 1000);
  t.start(1000);
  let s = t.snapshot();
  assert.equal(s.status, "running");
  // now=1000，还没流逝，剩余=完整专注时长
  assert.equal(s.remainingMs, 25 * 60 * 1000);
  // tick 推进 1 秒
  t.tick(2000);
  s = t.snapshot();
  assert.equal(s.remainingMs, 25 * 60 * 1000 - 1000);
});

test("后台节流：只收到一次迟到 tick 也不少算（时间戳方案）", () => {
  // 用 60s 专注时长模拟；start 在 now=0，后台被节流，直到 60s 才收到一次 tick
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  t.start(0);
  // 中间从不 tick（模拟后台 1 分钟才跑一次）
  const res = t.tick(60000); // 回到前台这一刻
  assert.equal(res.finished, true);
  assert.equal(res.finishedPhase, PHASE.FOCUS);
  assert.equal(t._state().completedPomodoros, 1);
});

test("专注完成 → 第1~3个进入短休息，第4个进入长休息", () => {
  const t = createTimer({}, 0);
  const FOCUS = 25 * 60 * 1000;
  const SHORT = 5 * 60 * 1000;
  const phases = []; // 记录每个番茄结束后进入的阶段
  let clock = 0;
  for (let i = 0; i < 4; i++) {
    t.setPhase(PHASE.FOCUS, { status: "idle" });
    t.start(clock);
    const r = t.tick(clock + FOCUS); // 专注结束
    assert.equal(r.finishedPhase, PHASE.FOCUS);
    assert.equal(t._state().completedPomodoros, i + 1);
    phases.push(r.next.phase);
    clock += FOCUS;
    // 休息结束回到专注
    t.setPhase(r.next.phase, { status: "idle" });
    t.start(clock);
    const breakDur = r.next.phase === PHASE.LONG_BREAK ? 15 * 60 * 1000 : SHORT;
    const r2 = t.tick(clock + breakDur);
    assert.equal(r2.finishedPhase === PHASE.LONG_BREAK || r2.finishedPhase === PHASE.SHORT_BREAK, true);
    phases.push(r2.next.phase); // 应回到 focus
    clock += breakDur;
  }
  // 第1、2、3个番茄后是短休息；第4个后是长休息
  assert.equal(phases[0], PHASE.SHORT_BREAK); // 第1个后
  assert.equal(phases[2], PHASE.SHORT_BREAK); // 第2个后
  assert.equal(phases[4], PHASE.SHORT_BREAK); // 第3个后
  assert.equal(phases[6], PHASE.LONG_BREAK); // 第4个后
  assert.equal(phases[1], PHASE.FOCUS);
  assert.equal(phases[3], PHASE.FOCUS);
  assert.equal(phases[5], PHASE.FOCUS);
  assert.equal(phases[7], PHASE.FOCUS);
});

test("pause: 存的是剩余时长，不是结束时间；resume 不丢时间", () => {
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  t.start(0);
  t.tick(20000); // 过了 20s
  t.pause(20000);
  let s = t.snapshot();
  assert.equal(s.status, "paused");
  assert.equal(s.remainingMs, 40000); // 存的是剩余 40s
  // 暂停很久（比如 5 分钟），再 resume —— 剩余应仍是 40s，而非被当作结束时间错位
  t.start(20000); // resume，重算 endAt = now+40000
  s = t.snapshot();
  assert.equal(s.remainingMs, 40000);
  t.tick(60001); // 40s 后真正结束（20000 → 60000）
  assert.equal(t.snapshot().status, "finished");
  assert.equal(t._state().completedPomodoros, 1);
});

test("running 校准：回前台按真实 now 修正剩余（节流不丢时间）", () => {
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 1000);
  t.start(1000);
  // 后台 30s 后被节流，回前台用真实 now 校准
  const s = t.recalibrate(31000);
  assert.equal(s.status, "running");
  assert.equal(s.remainingMs, 30000);
});

test("后台跑完整段：回前台必须真的完成 + 今日计数触发（非仅读数归零）", () => {
  // 模拟 UI 的 visibilitychange：recalibrate(now) 紧接 tick(now)
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  t.start(0);
  // 标签页在后台被节流 60s 后才回前台
  t.recalibrate(60000);
  const s = t.snapshot();
  assert.equal(s.remainingMs, 0); // 读数已归零（节流期间已跑完）
  assert.equal(s.status, "running"); // 还没 tick，仍是 running
  // 回前台这一刻 tick —— 必须真正触发完成
  const res = t.tick(60000);
  assert.equal(res.finished, true);
  assert.equal(res.finishedPhase, PHASE.FOCUS);
  assert.equal(t._state().completedPomodoros, 1);
});

test("paused 校准：切后台再回前台，remaining 必须不变（只对 running 生效）", () => {
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  t.start(0);
  t.tick(20000); // 过 20s
  t.pause(20000); // 暂停，remaining=40000
  // 后台很久（切到 60000）再回前台：recalibrate + tick 都不应改变 paused 状态/remaining
  t.recalibrate(60000);
  assert.equal(t.snapshot().remainingMs, 40000);
  const res = t.tick(60000);
  assert.equal(res.finished, false); // paused 不漂移
  assert.equal(t.snapshot().status, "paused");
  assert.equal(t.snapshot().remainingMs, 40000);
});

test("isComplete 语义：真实流逝到 endAt 即视作完成（非自减、非夹断续跑）", () => {
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  assert.equal(t.snapshot().remainingMs > 0, true); // 初始未完成
  t.start(0);
  assert.equal(t.snapshot().remainingMs > 0, true);
  // 一次性流逝到结束点（模拟后台节流后回前台）
  const res = t.tick(60000);
  assert.equal(res.finished, true); // 越过 endAt → 真正完成，而非被夹断后继续 running
  assert.equal(t._state().status, "finished");
  assert.equal(t._state().completedPomodoros, 1);
});

test("reset: 回到 idle 且剩余归满", () => {
  const t = createTimer({ durations: { [PHASE.FOCUS]: 60000 } }, 0);
  t.start(0);
  t.tick(10000);
  t.reset();
  const s = t.snapshot();
  assert.equal(s.status, "idle");
  assert.equal(s.remainingMs, 60000);
});
