// timer.js —— 番茄钟计时核心（纯函数，无 DOM 依赖，便于自测）
//
// 设计口径（与 Code Reviewer / Designer 对齐）：
//  - 用「目标结束时间戳 endAt = Date.now() + remaining」算剩余，绝不用 setInterval 自减计数器。
//    原因：标签页切到后台会被浏览器节流（约 1 分钟才跑一次），自减会直接少算时间。
//  - 暂停存「剩余时长」(remainingMs)，恢复时重算 endAt，杜绝错位。
//  - 长休息：每完成 4 个番茄进入一次长休息，其余短休息。

export const PHASE = Object.freeze({
  FOCUS: "focus", // 专注（番茄）
  SHORT_BREAK: "short_break", // 短休息
  LONG_BREAK: "long_break", // 长休息
});

export const DEFAULT_DURATIONS = Object.freeze({
  [PHASE.FOCUS]: 25 * 60 * 1000,
  [PHASE.SHORT_BREAK]: 5 * 60 * 1000,
  [PHASE.LONG_BREAK]: 15 * 60 * 1000,
});

export const POMODOROS_PER_LONG_BREAK = 4;

/**
 * 创建一个计时器实例（纯状态机，不持有定时器）。
 * @param {object} [opts]
 * @param {number} [now] 注入的「当前时间」(ms)，用于确定性测试；缺省 = Date.now()
 */
export function createTimer(opts = {}, now = Date.now()) {
  const durations = { ...DEFAULT_DURATIONS, ...(opts.durations || {}) };
  const config = {
    durations,
    pomodorosPerLongBreak: opts.pomodorosPerLongBreak ?? POMODOROS_PER_LONG_BREAK,
  };

  let phase = PHASE.FOCUS;
  let status = "idle"; // idle | running | paused | finished
  let completedPomodoros = 0;
  let endAt = 0; // 目标结束时间戳(ms)，running 时有效
  let remainingMs = durations[phase]; // 暂停 / idle 时持有的剩余时长
  let lastNow = now;

  function clampRemaining(ms) {
    return Math.max(0, Math.min(ms, durations[phase]));
  }

  function snapshot() {
    return {
      phase,
      status,
      completedPomodoros,
      remainingMs: getRemainingMs(),
      totalMs: durations[phase],
      modeLabel: phaseLabel(phase),
    };
  }

  function getRemainingMs() {
    if (status === "running") {
      return clampRemaining(endAt - lastNow);
    }
    return remainingMs;
  }

  function start(now = Date.now()) {
    if (status === "running") return snapshot();
    // 从暂停恢复或首次开始：用持有的 remainingMs 重算 endAt
    lastNow = now;
    if (remainingMs <= 0) remainingMs = durations[phase];
    endAt = now + remainingMs;
    status = "running";
    return snapshot();
  }

  function pause(now = Date.now()) {
    if (status !== "running") return snapshot();
    lastNow = now;
    remainingMs = clampRemaining(endAt - now); // 存剩余时长
    status = "paused";
    return snapshot();
  }

  function reset() {
    status = "idle";
    remainingMs = durations[phase];
    endAt = 0;
    return snapshot();
  }

  /**
   * 推进时间（由外部 tick 调用）。idle/paused 不漂移。
   * @returns {object} 若本步跨越了结束点，返回 { finished:true, next }，否则 { finished:false }
   */
  function tick(tickNow = Date.now()) {
    lastNow = tickNow;
    if (status !== "running") return { finished: false };

    if (tickNow >= endAt) {
      remainingMs = 0;
      status = "finished";
      const finishedPhase = phase;
      if (finishedPhase === PHASE.FOCUS) {
        completedPomodoros += 1;
      }
      const next = advancePhase(finishedPhase);
      return { finished: true, finishedPhase, next };
    }
    return { finished: false };
  }

  // 内部：根据刚结束的阶段，决定下一个阶段与计数
  function advancePhase(finishedPhase) {
    if (finishedPhase === PHASE.FOCUS) {
      const isLong = completedPomodoros % config.pomodorosPerLongBreak === 0;
      phase = isLong ? PHASE.LONG_BREAK : PHASE.SHORT_BREAK;
    } else {
      phase = PHASE.FOCUS; // 休息结束回到专注
    }
    remainingMs = durations[phase];
    return snapshot();
  }

  /** 由外部（如 visibilitychange 回前台）重新校准时间基准。 */
  function recalibrate(tickNow = Date.now()) {
    lastNow = tickNow;
    // running 时 endAt 是绝对时间戳，不动它；剩余由 getRemainingMs 用 endAt-lastNow 算，
    // 并用 clampRemaining 夹到 [0, duration] —— 后台跑过头则 remaining 自然夹到 0，tick 即触发完成。
    // （不要 Math.max(endAt, now)，那会把结束点往后推、错误地延长计时。）
    return snapshot();
  }

  /** 强制切到某阶段（测试 / 重置整轮用）。 */
  function setPhase(next, opts = {}) {
    phase = next;
    status = opts.status ?? "idle";
    remainingMs = opts.remainingMs ?? durations[phase];
    endAt = opts.endAt ?? 0;
    return snapshot();
  }

  function phaseLabel(p) {
    if (p === PHASE.FOCUS) return "专注模式";
    if (p === PHASE.SHORT_BREAK) return "短休息";
    return "长休息";
  }

  return {
    start,
    pause,
    reset,
    tick,
    recalibrate,
    setPhase,
    snapshot,
    _state: () => ({ phase, status, completedPomodoros }),
  };
}
