// qa-anime.mjs — 二次元番茄钟独立入口 端到端验收
// 自包含 Playwright + chromium（CDP）；复用已运行的 Vite dev server (:5173)
// 不启动新服务器、不修改任何生产代码（anime.html/anime.css/src/anime/anime.js）
//
// 验收点：
//  1) 默认显示：#app 存在且非错误态；#time==="25:00"；#phaseLabel 非空；#todayCount 非空
//  2) #errorBanner 真隐藏：hidden 属性 + getComputedStyle().display === "none"
//  3) 控制：空闲时 #pauseBtn 禁用；点开始后 running（start 禁用/pause 可用）；
//     点暂停后 paused（pause 重新禁用）
//  4) 回前台校准：后台计时完成真使 #todayCount / localStorage pomodoro:today 自增（非重置为 0）
//  5) 设计令牌对齐 anime-spec.html :root（getComputedStyle 序列化去空白再比）
//  6) .anime-mascot 为 <svg> 且含矢量子节点；应用文本无 emoji
//  7) 错误态（首页）：localStorage 写入失败 → #errorBanner 真显示
//  8) 统计页（#stats，复用 src/stats.js renderStats）：
//     - 默认显示任务视图、tabbar「任务」高亮；点「统计」切到 #view-stats 且 #view-task 隐藏
//     - 空态：无记录时 #statsEmpty 显示、「去专注」跳回 #task
//     - 错误态：写入失败 → #statsError 显示、「重试读取」真重探测
//     - #statsTodayCount 节点存在（供 renderStats 写入）
//  9) mascot 休息态闭眼变体：默认(idle)睁眼；#app.is-break 时切闭眼+Zzz（纯 CSS 切换）
//
// 运行：node qa-anime.mjs   （需全局 playwright 已装 chromium）

// 通过绝对 file:// 路径导入（本机 playwright 装在全局，ESM 不认 NODE_PATH）
import { chromium } from 'file:///C:/Users/qiuzijian/AppData/Roaming/npm/node_modules/@playwright/cli/node_modules/playwright/index.mjs';

const BASE = 'http://127.0.0.1:5173';
const URL = BASE + '/anime.html';
const SPEC = BASE + '/anime-spec.html';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 归一化：getComputedStyle 会把 CSS 函数序列化出逗号空格
//   clamp(56px, 22vw, 88px)  →  去空白后比较
const norm = (s) => String(s).replace(/\s+/g, '');

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok: !!ok, detail: detail ?? '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? '  —— ' + detail : ''}`);
};

async function readComputedTokens(page) {
  return page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const keys = [
      '--bg-1', '--bg-2', '--panel', '--surface-2', '--ink', '--muted',
      '--primary', '--primary-d', '--break', '--break-d', '--error',
      '--time-ink', '--focus', '--radius', '--radius-lg', '--shadow', '--tap', '--fs-time',
    ];
    const out = {};
    for (const k of keys) out[k] = cs.getPropertyValue(k).trim();
    return out;
  });
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  // ── 1+2+3) 默认显示 / 错误横幅隐藏 / 控制禁用 ─────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });

    const snap = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const eb = q('#errorBanner');
      const cs = eb ? getComputedStyle(eb) : null;
      const csApp = getComputedStyle(q('#app'));
      return {
        appExists: !!q('#app'),
        appDisplay: csApp.display,
        time: q('#time')?.textContent,
        phase: q('#phaseLabel')?.textContent ?? '',
        today: q('#todayCount')?.textContent ?? '',
        pauseDisabledIdle: q('#pauseBtn')?.disabled,
        startDisabledIdle: q('#startBtn')?.disabled,
        bannerHidden: eb ? eb.hasAttribute('hidden') : null,
        bannerDisplay: cs ? cs.display : null,
      };
    });

    check('1 默认#app 存在且显示', snap.appExists && snap.appDisplay !== 'none', `display=${snap.appDisplay}`);
    check('1 #time 默认 25:00', snap.time === '25:00', `time=${snap.time}`);
    check('1 #phaseLabel 非空', snap.phase.trim().length > 0, `phase="${snap.phase}"`);
    check('1 #todayCount 非空', snap.today.trim().length > 0, `today="${snap.today}"`);

    check('2 #errorBanner 带 hidden 属性', snap.bannerHidden === true, `hidden=${snap.bannerHidden}`);
    check('2 #errorBanner display===none', snap.bannerDisplay === 'none', `display=${snap.bannerDisplay}`);

    check('3 空闲态 #pauseBtn 禁用', snap.pauseDisabledIdle === true, `disabled=${snap.pauseDisabledIdle}`);
    check('3 空闲态 #startBtn 可用', snap.startDisabledIdle === false, `disabled=${snap.startDisabledIdle}`);

    // 点开始 → running
    await page.click('#startBtn');
    await page.waitForFunction(() => document.querySelector('#startBtn')?.disabled === true, null, { timeout: 4000 });
    const running = await page.evaluate(() => ({
      startDisabled: document.querySelector('#startBtn')?.disabled,
      pauseDisabled: document.querySelector('#pauseBtn')?.disabled,
      state: document.querySelector('#stateLabel')?.textContent,
    }));
    check('3 开始后 #startBtn 禁用', running.startDisabled === true, `disabled=${running.startDisabled}`);
    check('3 开始后 #pauseBtn 可用', running.pauseDisabled === false, `disabled=${running.pauseDisabled}`);

    // 点暂停 → paused（pause 重新禁用）
    await page.click('#pauseBtn');
    await page.waitForFunction(() => document.querySelector('#pauseBtn')?.disabled === true, null, { timeout: 4000 });
    const paused = await page.evaluate(() => ({
      pauseDisabled: document.querySelector('#pauseBtn')?.disabled,
      startDisabled: document.querySelector('#startBtn')?.disabled,
      state: document.querySelector('#stateLabel')?.textContent,
    }));
    check('3 暂停后 #pauseBtn 重新禁用', paused.pauseDisabled === true, `disabled=${paused.pauseDisabled}`);
    check('3 暂停后 #startBtn 恢复可用', paused.startDisabled === false, `disabled=${paused.startDisabled}`);

    await page.screenshot({ path: 'qa-anime-shot-default.png' });
    await ctx.close();
  }

  // ── 4) 回前台校准：后台完成真使计数自增 ───────────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // 清空计数，确保从 0 起步
    await page.goto(URL, { waitUntil: 'load' });
    await page.evaluate(() => {
      localStorage.removeItem('pomodoro:today');
      localStorage.removeItem('pomodoro:history');
    });
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });

    const before = await page.evaluate(() => ({
      today: document.querySelector('#todayCount')?.textContent,
      ls: JSON.parse(localStorage.getItem('pomodoro:today') || 'null'),
    }));

    // 开始计时，再把 Date.now 前移 26 分钟，使 endAt 落入过去
    await page.click('#startBtn');
    await page.waitForFunction(() => document.querySelector('#startBtn')?.disabled === true, null, { timeout: 4000 });

    await page.evaluate(() => {
      const real = Date.now.bind(Date);
      const jump = real() + 26 * 60 * 1000;
      window.Date.now = () => jump;
    });

    // 模拟回前台：visibilityState 置为 visible，派发 visibilitychange
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // 等动画帧把 onPhaseFinished 结果渲染出来
    await page.waitForFunction(() => {
      const t = document.querySelector('#todayCount')?.textContent;
      return t && t !== '0';
    }, null, { timeout: 5000 }).catch(() => {});

    const after = await page.evaluate(() => ({
      today: document.querySelector('#todayCount')?.textContent,
      ls: JSON.parse(localStorage.getItem('pomodoro:today') || 'null'),
      state: document.querySelector('#stateLabel')?.textContent,
    }));

    check('4 回前台后台完成 #todayCount 自增', after.today === '1', `before=${before.today} after=${after.today}`);
    check('4 localStorage pomodoro:today 自增=1',
      after.ls && after.ls.count === 1, `ls=${JSON.stringify(after.ls)}`);
    check('4 完成后已重置回空闲态', /准备|开始|专注/.test(after.state || ''), `state="${after.state}"`);

    await page.screenshot({ path: 'qa-anime-shot-calibrate.png' });
    await ctx.close();
  }

  // ── 5) 设计令牌对齐 anime-spec.html :root ────────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });
    const appTokens = await readComputedTokens(page);

    // 读 spec 的 :root 文本，提取声明
    const specText = await (await page.context().request.get(SPEC)).text();
    const specTokens = {};
    const m = specText.match(/:root\s*\{([\s\S]*?)\}/);
    if (m) {
      for (const line of m[1].split(';')) {
        const kv = line.match(/(--[\w-]+)\s*:\s*([^;]+)$/);
        if (kv) specTokens[kv[1].trim()] = kv[2].trim();
      }
    }

    const compareKeys = Object.keys(appTokens).filter((k) => k in specTokens);
    let allOk = true;
    const mismatches = [];
    for (const k of compareKeys) {
      const a = norm(appTokens[k]);
      const s = norm(specTokens[k]);
      if (a !== s) {
        allOk = false;
        mismatches.push(`${k}: app=${appTokens[k]} spec=${specTokens[k]}`);
      }
    }
    check('5 设计令牌逐字对齐 anime-spec.html :root', allOk,
      allOk ? `${compareKeys.length} 个令牌一致` : mismatches.join(' | '));

    // 显式核对关键令牌（含 --muted 实色 #6F5A68）
    const expectSolid = {
      '--muted': '#6F5A68',
      '--primary': '#D6336C',
      '--ink': '#43303B',
      '--bg-1': '#FFF1F8',
    };
    let solidOk = true;
    const solidMiss = [];
    for (const [k, v] of Object.entries(expectSolid)) {
      if (norm(appTokens[k]) !== norm(v)) {
        solidOk = false;
        solidMiss.push(`${k}: app=${appTokens[k]} expect=${v}`);
      }
    }
    check('5 关键令牌为规范实色(--muted #6F5A68 等)', solidOk,
      solidOk ? 'ok' : solidMiss.join(' | '));

    await ctx.close();
  }

  // ── 6) mascot 为 SVG 且无 emoji ───────────────────────────────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });
    const m = await page.evaluate(() => {
      const el = document.querySelector('.anime-mascot');
      const tag = el ? el.tagName.toLowerCase() : null;
      const hasVectorChild = el
        ? !!el.querySelector('path, ellipse, circle, rect, polygon')
        : false;
      // 取可见应用文本（去掉 script/style），做 emoji 检测
      const clone = document.querySelector('.anime-app')?.cloneNode(true);
      clone?.querySelectorAll('script,style').forEach((n) => n.remove());
      const text = clone ? clone.textContent || '' : '';
      const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/u;
      return { tag, hasVectorChild, hasEmoji: emojiRe.test(text), textSample: text.slice(0, 40) };
    });
    check('6 .anime-mascot 为 <svg>', m.tag === 'svg', `tag=${m.tag}`);
    check('6 .anime-mascot 含矢量子节点', m.hasVectorChild === true, `hasVectorChild=${m.hasVectorChild}`);
    check('6 应用文本无 emoji', m.hasEmoji === false, `sample="${m.textSample}"`);

    await ctx.close();
  }

  // ── 7) 错误态：localStorage 写入失败 → 横幅真显示（独立 context，隔离不污染）──
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });

    // 注入写入失败（在页面加载后注入；reload 会清空注入，故不 reload）
    await page.evaluate(() => {
      window.localStorage.setItem = () => { throw new Error('blocked'); };
    });
    // 点击开始：start 处理器内 isStorageAvailable() 会探测写入并失败 → storageOk=false → 横幅显示
    await page.click('#startBtn');
    await page.waitForFunction(() => {
      const eb = document.querySelector('#errorBanner');
      return eb && !eb.hasAttribute('hidden');
    }, null, { timeout: 4000 }).catch(() => {});

    const err = await page.evaluate(() => {
      const eb = document.querySelector('#errorBanner');
      const cs = eb ? getComputedStyle(eb) : null;
      return {
        hidden: eb ? eb.hasAttribute('hidden') : null,
        display: cs ? cs.display : null,
      };
    });
    check('7 写入失败 #errorBanner 显示(hidden=false)', err.hidden === false, `hidden=${err.hidden}`);
    check('7 写入失败 #errorBanner display≠none', err.display !== 'none', `display=${err.display}`);

    await ctx.close();
  }

  // ── 8) 统计页（#stats，复用 src/stats.js renderStats 三态）───────────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });

    // 8a) 默认显示任务视图、tabbar「任务」高亮
    const def = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vt = q('#view-task'), vs = q('#view-stats');
      return {
        taskHidden: vt ? vt.hasAttribute('hidden') : null,
        statsHidden: vs ? vs.hasAttribute('hidden') : null,
        navTaskActive: q('#navTask')?.classList.contains('active'),
        navStatActive: q('#navStat')?.classList.contains('active'),
        todayCountNode: !!q('#statsTodayCount'),
      };
    });
    check('8 默认 #view-task 显示且 #view-stats 隐藏', def.taskHidden === false && def.statsHidden === true,
      `taskHidden=${def.taskHidden} statsHidden=${def.statsHidden}`);
    check('8 默认 tabbar「任务」高亮', def.navTaskActive === true && def.navStatActive === false,
      `task=${def.navTaskActive} stat=${def.navStatActive}`);
    check('8 #statsTodayCount 节点存在(供 renderStats)', def.todayCountNode === true, `todayCountNode=${def.todayCountNode}`);

    // 8b) 点「统计」切到统计视图（不叠加：task 隐藏）
    await page.click('#navStat');
    await page.waitForFunction(() => {
      const vs = document.querySelector('#view-stats');
      return vs && !vs.hasAttribute('hidden');
    }, null, { timeout: 4000 });
    const onStats = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const vt = q('#view-task'), vs = q('#view-stats');
      return {
        taskHidden: vt ? vt.hasAttribute('hidden') : null,
        statsHidden: vs ? vs.hasAttribute('hidden') : null,
        navTaskActive: q('#navTask')?.classList.contains('active'),
        navStatActive: q('#navStat')?.classList.contains('active'),
        hash: location.hash,
      };
    });
    check('8 点统计：#view-stats 显示且 #view-task 隐藏(不叠加)',
      onStats.statsHidden === false && onStats.taskHidden === true,
      `statsHidden=${onStats.statsHidden} taskHidden=${onStats.taskHidden}`);
    check('8 点统计：tabbar「统计」高亮', onStats.navStatActive === true && onStats.navTaskActive === false,
      `stat=${onStats.navStatActive} task=${onStats.navTaskActive}`);
    check('8 路由：location.hash===#stats', onStats.hash === '#stats', `hash=${onStats.hash}`);

    // 8c) 空态：清空历史、刷新后进入统计 → #statsEmpty 显示，点「去专注」回 #task
    await page.evaluate(() => {
      localStorage.removeItem('pomodoro:today');
      localStorage.removeItem('pomodoro:history');
    });
    await page.reload({ waitUntil: 'load' });
    await page.goto(URL + '#stats', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const se = document.querySelector('#statsEmpty');
      return se && !se.hasAttribute('hidden');
    }, null, { timeout: 4000 }).catch(() => {});
    const empty = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const se = q('#statsEmpty'), sn = q('#statsNormal'), sv = q('#view-stats');
      return {
        emptyShown: se ? !se.hasAttribute('hidden') : null,
        normalHidden: sn ? sn.hasAttribute('hidden') : null,
        statsVisible: sv ? !sv.hasAttribute('hidden') : null,
        goFocusExists: !!q('#statsGoFocus'),
      };
    });
    check('8 空态：#statsEmpty 显示且 #statsNormal 隐藏', empty.emptyShown === true && empty.normalHidden === true,
      `emptyShown=${empty.emptyShown} normalHidden=${empty.normalHidden}`);
    check('8 空态：统计页可见且「去专注」存在', empty.statsVisible === true && empty.goFocusExists === true,
      `statsVisible=${empty.statsVisible} goFocus=${empty.goFocusExists}`);

    await page.click('#statsGoFocus');
    // 等 hashchange→showView 真正把 #view-task 显示（hash 同步变、DOM 异步切，需等侧效）
    await page.waitForFunction(() => {
      const vt = document.querySelector('#view-task');
      return location.hash === '#task' && vt && !vt.hasAttribute('hidden');
    }, null, { timeout: 4000 }).catch(() => {});
    const backToTask = await page.evaluate(() => {
      const vt = document.querySelector('#view-task');
      return { hash: location.hash, taskHidden: vt ? vt.hasAttribute('hidden') : null };
    });
    check('8 空态「去专注」跳回 #task', backToTask.hash === '#task' && backToTask.taskHidden === false,
      `hash=${backToTask.hash} taskHidden=${backToTask.taskHidden}`);

    // 8d) 错误态：写入失败 → #statsError 显示；点「重试读取」真重探测
    await page.evaluate(() => {
      window.localStorage.setItem = () => { throw new Error('blocked'); };
    });
    await page.goto(URL + '#stats', { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const sv = document.querySelector('#statsError');
      return sv && !sv.hasAttribute('hidden');
    }, null, { timeout: 4000 }).catch(() => {});
    const errStats = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const se = q('#statsError'), sn = q('#statsNormal'), sv = q('#view-stats');
      return {
        errShown: se ? !se.hasAttribute('hidden') : null,
        normalHidden: sn ? sn.hasAttribute('hidden') : null,
        statsVisible: sv ? !sv.hasAttribute('hidden') : null,
        retryExists: !!q('#statsRetry'),
      };
    });
    check('8 错误态：#statsError 显示且 #statsNormal 隐藏', errStats.errShown === true && errStats.normalHidden === true,
      `errShown=${errStats.errShown} normalHidden=${errStats.normalHidden}`);
    check('8 错误态：统计页可见且「重试读取」存在', errStats.statsVisible === true && errStats.retryExists === true,
      `statsVisible=${errStats.statsVisible} retry=${errStats.retryExists}`);

    // 恢复写入 → 点重试：storageUnavailable 复位、错误态消除（renderStats 重渲染三态）
    await page.evaluate(() => {
      delete window.localStorage.setItem; // 还原原生实现
    });
    await page.click('#statsRetry');
    await page.waitForFunction(() => {
      const se = document.querySelector('#statsError');
      return se && se.hasAttribute('hidden');
    }, null, { timeout: 4000 }).catch(() => {});
    const recovered = await page.evaluate(() => {
      const se = document.querySelector('#statsError');
      return { errHidden: se ? se.hasAttribute('hidden') : null };
    });
    check('8 错误态「重试读取」真恢复(storageUnavailable 复位→错误横幅隐藏)',
      recovered.errHidden === true, `errHidden=${recovered.errHidden}`);

    await ctx.close();
  }

  // ── 9) mascot 休息态闭眼变体（.anime-app.is-break 切换，纯 CSS）───────────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#time')?.textContent === '25:00', null, { timeout: 8000 });

    const idle = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const open = q('.mascot-eyes-open'), closed = q('.mascot-eyes-closed'), zzz = q('.mascot-zzz');
      const vis = (el) => el ? getComputedStyle(el).display !== 'none' : null;
      return {
        appHasBreak: q('#app')?.classList.contains('is-break'),
        openVis: vis(open), closedVis: vis(closed), zzzVis: vis(zzz),
      };
    });
    check('9 空闲态：睁眼显示、闭眼隐藏、无 Zzz',
      idle.appHasBreak === false && idle.openVis === true && idle.closedVis === false && idle.zzzVis === false,
      `break=${idle.appHasBreak} open=${idle.openVis} closed=${idle.closedVis} zzz=${idle.zzzVis}`);

    // 手动加 is-break，验证 CSS 切换（与 anime.js 在休息阶段行为一致）
    await page.evaluate(() => document.querySelector('#app')?.classList.add('is-break'));
    const brk = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const open = q('.mascot-eyes-open'), closed = q('.mascot-eyes-closed'), zzz = q('.mascot-zzz');
      const vis = (el) => el ? getComputedStyle(el).display !== 'none' : null;
      return { openVis: vis(open), closedVis: vis(closed), zzzVis: vis(zzz) };
    });
    check('9 休息态：闭眼显示、睁眼隐藏、显示 Zzz',
      brk.openVis === false && brk.closedVis === true && brk.zzzVis === true,
      `open=${brk.openVis} closed=${brk.closedVis} zzz=${brk.zzzVis}`);

    await ctx.close();
  }

  // ── 已知限制声明 ──────────────────────────────────────────────────────────
  console.log('\n=== 已知限制（未在脚本内机器断言，需人工/真机复核）===');
  console.log('- 移动端 360/390px 真实视口回流：脚本仅桌面 chromium 默认视口；真机 360×740、390×844 排版未自动验证（已存桌面截图 qa-anime-shot-default.png）。');
  console.log('- 后台节流（真实手机切后台 25 分钟）的计时保真：脚本以 Date.now 前移模拟，未测真实 OS 后台节流。');
  console.log('- 跨零点日期边界（localStorage 按 YYYY-MM-DD 存）：未构造跨天场景。');
  console.log('- 错误态「写入失败→点#retryBtn 真重写恢复」：check 7 已验证写入失败时横幅显示(display=flex)；但恢复路径（撤销注入后点重试使 storageUnavailable 复位、横幅隐藏）未在本脚本自动复验，建议单独跑 qa-round-05 同款注入+恢复脚本确认。');

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log(`${failed.length} 条失败`);
    process.exit(1);
  }
  console.log('ALL GREEN');
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e);
  process.exit(2);
});
