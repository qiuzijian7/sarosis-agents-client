// Pocket App 真实浏览器 UI 测试（Playwright 驱动）
//
// 为什么需要它：test/*.test.mjs 只覆盖 lib/*.mjs 的纯逻辑，app/ 的 HTML/CSS/JS
// 此前零覆盖 —— 响应式改完只能对着源码"看"，无法证明它真的生效。
// 这里用真实浏览器量真实几何值：导航轨宽度、列表列数、是否横向溢出。
//
// 依赖从上游 sarosis-agents-client 借（那里已装 playwright），本项目不新增依赖；
// 浏览器用系统已装的 Chrome（环境变量 POCKET_UI_CHANNEL 可改 msedge）。
//
// 用法：node test/ui.test.mjs

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const CHANNEL = process.env.POCKET_UI_CHANNEL || 'chrome';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 等服务器就绪（轮询，避免固定 sleep 的偶发失败）。 */
async function waitForServer(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// Playwright 是可选依赖：本仓库坚持零运行时依赖，它不在 package.json 里。
// 开发机上跑本测试前，把上游（sarosis-agents-client）已装的 playwright 链过来即可：
//   ln -s <上游>/node_modules/playwright      node_modules/playwright
//   ln -s <上游>/node_modules/playwright-core node_modules/playwright-core
// 没链就跳过 —— CI / 别人 clone 下来跑 npm test 不该因此失败。
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP  UI 测试：未找到 playwright（可选依赖），跳过');
  console.log('      启用方法见 test/ui.test.mjs 顶部注释。');
  console.log('');
  console.log('RESULT: ALL PASS (0/0)');
  process.exit(0);
}

// `--no-screen`：本测试不校验画面内容，但**默认会真的抓屏**（Windows 下起 PowerShell 采集进程）。
// 跑测试不该顺带采集使用者的屏幕，所以显式关掉采集源；输入开关与全屏都与采集源无关。
const server = spawn(process.execPath, [join(here, 'serve-app.mjs'), '--port', String(PORT), '--no-screen'], {
  cwd: root,
  stdio: 'ignore',
});

// 第二个实例：主机端**已允许**远程操作（sarosPocket.allowDesktopInput=true 的等价物），
// 用来验证「开关可点 + 默认关 + 点开后说明变化」这条路径。mock 只记账，不会真操作电脑。
const INPUT_PORT = PORT + 1;
const INPUT_BASE = `http://127.0.0.1:${INPUT_PORT}`;
const inputServer = spawn(process.execPath, [join(here, 'serve-app.mjs'), '--port', String(INPUT_PORT), '--no-screen', '--allow-input'], {
  cwd: root,
  stdio: 'ignore',
});

let browser;
try {
  if (!await waitForServer(`${BASE}/pocket/`)) throw new Error('调试服务器未能在 15s 内就绪');

  browser = await chromium.launch({ channel: CHANNEL, headless: true });

  // ---------- 形态①：竖屏手机 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // 注意：不能用 networkidle —— App 一进来就建立 SSE 长连接，
    // 网络永远不会空闲，goto 会一直等到超时。
    await page.goto(`${BASE}/pocket/`, { waitUntil: 'domcontentloaded' });

    check('竖屏：页面加载无 JS 错误', errors.length === 0, errors.join(' | '));
    check('竖屏：侧边导航轨隐藏', !(await page.locator('#sidenav').isVisible()));
    check('竖屏：底部页签可见', await page.locator('nav.tabs').isVisible());

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('竖屏：无横向溢出', overflow <= 1, `溢出 ${overflow}px`);

    await page.waitForSelector('.session', { timeout: 5000 });
    const count = await page.locator('.session').count();
    check('竖屏：收件箱渲染出会话卡片', count === 4, `实际 ${count} 张`);

    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.sessions')).gridTemplateColumns.split(' ').length);
    check('竖屏：会话列表为单列', cols === 1, `实际 ${cols} 列`);

    await ctx.close();
  }

  // ---------- 形态②：手机横放 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 844, height: 390 } });
    const page = await ctx.newPage();
    // 注意：不能用 networkidle —— App 一进来就建立 SSE 长连接，
    // 网络永远不会空闲，goto 会一直等到超时。
    await page.goto(`${BASE}/pocket/`, { waitUntil: 'domcontentloaded' });

    check('横屏：侧边导航轨显形', await page.locator('#sidenav').isVisible());
    check('横屏：底部页签隐藏', !(await page.locator('nav.tabs').isVisible()));

    const railWidth = (await page.locator('#sidenav').boundingBox()).width;
    check('横屏：导航轨为 44px 窄轨', Math.round(railWidth) === 44, `实际 ${Math.round(railWidth)}px`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('横屏：无横向溢出', overflow <= 1, `溢出 ${overflow}px`);

    const rail = await page.locator('#sidenav').boundingBox();
    const shell = await page.locator('.shell').boundingBox();
    check('横屏：导航轨位于内容区左侧', rail.x + rail.width <= shell.x + 1,
      `轨右缘 ${rail.x + rail.width} vs 内容左缘 ${shell.x}`);

    await ctx.close();
  }

  // ---------- 形态③：平板 / iPad 横屏 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const page = await ctx.newPage();
    // 注意：不能用 networkidle —— App 一进来就建立 SSE 长连接，
    // 网络永远不会空闲，goto 会一直等到超时。
    await page.goto(`${BASE}/pocket/`, { waitUntil: 'domcontentloaded' });

    const railWidth = (await page.locator('#sidenav').boundingBox()).width;
    check('平板：导航轨为 88px 宽轨', Math.round(railWidth) === 88, `实际 ${Math.round(railWidth)}px`);
    check('平板：导航轨显示文字标签', await page.locator('#sidenav .tab-text').first().isVisible());

    await page.waitForSelector('.session', { timeout: 5000 });
    const cols = await page.evaluate(() => getComputedStyle(document.querySelector('.sessions')).gridTemplateColumns.split(' ').length);
    check('平板：会话列表多列铺开', cols >= 2, `实际 ${cols} 列`);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('平板：无横向溢出', overflow <= 1, `溢出 ${overflow}px`);

    await ctx.close();
  }

  // ---------- 交互：页签切换 + 双导航同步 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 } });
    const page = await ctx.newPage();
    // 注意：不能用 networkidle —— App 一进来就建立 SSE 长连接，
    // 网络永远不会空闲，goto 会一直等到超时。
    await page.goto(`${BASE}/pocket/`, { waitUntil: 'domcontentloaded' });

    await page.locator('#sidenav .tab[data-view="status"]').click();
    await page.waitForTimeout(300);

    check('交互：点侧边轨「连接」→ 状态页显示', await page.locator('#view-status').isVisible());
    check('交互：收件箱随之隐藏', !(await page.locator('#view-inbox').isVisible()));

    const railActive = await page.locator('#sidenav .tab[data-view="status"]').getAttribute('class');
    const bottomActive = await page.locator('nav.tabs .tab[data-view="status"]').getAttribute('class');
    check('交互：底部页签同步高亮', railActive.includes('active') && bottomActive.includes('active'),
      `侧边=${railActive} 底部=${bottomActive}`);

    const cards = await page.locator('.cards').boundingBox();
    const events = await page.locator('#view-status .events').boundingBox();
    check('平板状态页：卡片区在事件流左侧', cards.x + cards.width <= events.x + 1,
      `卡片右缘 ${Math.round(cards.x + cards.width)} vs 事件左缘 ${Math.round(events.x)}`);

    const cardCount = await page.locator('.card').count();
    check('状态页：渲染出状态卡片', cardCount >= 8, `实际 ${cardCount} 张`);

    await page.locator('#sidenav .tab[data-view="changes"]').click();
    await page.waitForTimeout(600);
    const changeCount = await page.locator('.change').count();
    check('变更页：渲染出变更条目', changeCount === 4, `实际 ${changeCount} 条`);

    await ctx.close();
  }

  // ---------- 交互：SSE 实时事件 ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    // 注意：不能用 networkidle —— App 一进来就建立 SSE 长连接，
    // 网络永远不会空闲，goto 会一直等到超时。
    await page.goto(`${BASE}/pocket/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    const res = await fetch(`${BASE}/saros-pocket/rpc/notify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: { message: 'ui-test-事件' } }),
    });
    check('SSE：notify RPC 成功', res.ok, `HTTP ${res.status}`);

    await page.locator('nav.tabs .tab[data-view="status"]').click();
    await page.waitForTimeout(900);
    const text = await page.locator('#view-status .events').innerText();
    check('SSE：事件流收到推送', text.trim().length > 0, `事件区文本长度 ${text.length}`);

    await ctx.close();
  }
  // ---------- 屏幕页：远程操作开关（主机未允许 / 已允许） ----------
  // 用户反馈「远程操作无法开启（VsSaros 已经允许）」：旧实现把「主机是否允许」直接当成
  // 开关的选中态并据此 disabled ⇒ 主机没允许时开关点不动、也不说为什么。
  // 新语义：inputAllowed（主机）与 inputOptIn（本机本次）分开，且未允许时给出「去哪开」的指引。
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(`${BASE}/pocket/#screen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#screenInputBar:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(700); // 等一次 desktop.status 回来

    check('屏幕页：加载无 JS 错误', errors.length === 0, errors.join(' | '));
    check('远程操作（主机未允许）：开关禁用而不是静默失效', await page.locator('#screenInputOn').isDisabled());
    const note = await page.locator('#screenInputNote').innerText();
    check('远程操作（主机未允许）：写明去哪开（插件页 / Allow Desktop Input）',
      note.includes('Allow Desktop Input') && note.includes('插件页'), note);
    check('远程操作：有「重新检测」按钮', await page.locator('#screenInputRecheck').isVisible());

    await page.locator('#screenInputRecheck').click();
    await page.waitForTimeout(400);
    check('远程操作：重新检测不报错（仍提示未允许）',
      (await page.locator('#screenInputNote').innerText()).includes('Allow Desktop Input'));

    await ctx.close();
  }

  // ---------- 屏幕页：主机已允许 → 开关可点、默认关、打开后能把输入发出去 ----------
  {
    if (!await waitForServer(`${INPUT_BASE}/pocket/`)) throw new Error('第二个调试服务器未就绪');

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 记下真正发给主机的输入（mock 端只记账），用来证明「打开开关后点击真的发出去了」
    const inputs = [];
    await page.route('**/rpc/desktop.input', async (route) => {
      inputs.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, value: { ok: true, mock: true } }),
      });
    });

    await page.goto(`${INPUT_BASE}/pocket/#screen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#screenInputBar:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(700);

    check('远程操作（主机已允许）：开关可点（旧实现这里是死控件）', !(await page.locator('#screenInputOn').isDisabled()));
    check('远程操作（主机已允许）：本机默认仍是关（防误触，用户自己点开）', !(await page.locator('#screenInputOn').isChecked()));
    check('远程操作（主机已允许）：说明提示「已允许，打开开关后生效」',
      (await page.locator('#screenInputNote').innerText()).includes('打开上面的开关后'));

    // 未打开开关时点击画面 → 不该发出任何输入
    const clickImage = () => page.evaluate(() => {
      const img = document.getElementById('screenImg');
      const r = img.getBoundingClientRect();
      img.dispatchEvent(new MouseEvent('click', { clientX: r.left + 5, clientY: r.top + 5, bubbles: true }));
    });
    await clickImage();
    await page.waitForTimeout(300);
    check('远程操作：开关未开时点击画面不发输入', inputs.length === 0, `实际发了 ${inputs.length} 条`);

    await page.locator('#screenInputOn').check();
    await page.waitForTimeout(200);
    check('远程操作：点开后说明变为「已开启」',
      (await page.locator('#screenInputNote').innerText()).includes('已开启'));

    await clickImage();
    await page.waitForTimeout(400);
    check('远程操作：打开后点击画面发出 click 输入', inputs.length === 1 && inputs[0].payload.type === 'click',
      JSON.stringify(inputs));
    check('屏幕页：主机已允许路径无 JS 错误', errors.length === 0, errors.join(' | '));

    await ctx.close();
  }

  // ---------- 屏幕页：全屏（真全屏 API + WebView 兜底的伪全屏） ----------
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/pocket/#screen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#screenWrap', { timeout: 5000 });

    await page.locator('#screenFull').click();
    // 真全屏（Fullscreen API）或伪全屏（CSS 兜底）——两者都算「真的全屏了」
    await page.waitForFunction(() => {
      const w = document.getElementById('screenWrap');
      return document.fullscreenElement === w || w.classList.contains('pseudo-fullscreen');
    }, null, { timeout: 4000 });
    // 按钮文案在 fullscreenchange / verifyFullscreen(80ms) 之后才同步 ⇒ 等它，别抢跑
    await page.waitForFunction(() => document.getElementById('screenFull').textContent === '退出全屏', null, { timeout: 3000 });

    const st = await page.evaluate(() => {
      const w = document.getElementById('screenWrap');
      const r = w.getBoundingClientRect();
      return {
        apiFullscreen: document.fullscreenElement === w,
        pseudo: w.classList.contains('pseudo-fullscreen'),
        coversViewport: Math.round(r.width) >= window.innerWidth - 1 && Math.round(r.height) >= window.innerHeight - 1,
        buttonText: document.getElementById('screenFull').textContent,
        exitVisible: !document.getElementById('screenExit').classList.contains('hidden'),
      };
    });
    check('全屏：画面区铺满视口（不再是「看起来没全屏」）', st.coversViewport, JSON.stringify(st));
    check('全屏：走的是浏览器 Fullscreen API（桌面/手机浏览器路径）', st.apiFullscreen || st.pseudo, JSON.stringify(st));
    check('全屏：按钮变为「退出全屏」', st.buttonText === '退出全屏', st.buttonText);
    check('全屏：出现「退出全屏」浮动按钮', st.exitVisible);

    await page.locator('#screenExit').click();
    await page.waitForFunction(() => {
      const w = document.getElementById('screenWrap');
      return document.fullscreenElement !== w && !w.classList.contains('pseudo-fullscreen');
    }, null, { timeout: 4000 });
    await page.waitForFunction(() => document.getElementById('screenFull').textContent === '全屏', null, { timeout: 3000 });
    check('全屏：退出后恢复（按钮回到「全屏」）',
      (await page.locator('#screenFull').innerText()).trim() === '全屏');

    await ctx.close();
  }

  // ---------- 屏幕页：WebView 里没有 Fullscreen API → 必须自动兜底 ----------
  // 原生壳（Capacitor WebView）与 iOS Safari 对普通元素要么没这个 API、要么调了没反应；
  // 旧实现只调 API 且没有兜底 ⇒ 手机上点「全屏」毫无反应（用户反馈的第一条）。
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(() => {
      for (const proto of [Element.prototype, HTMLElement.prototype]) {
        Object.defineProperty(proto, 'requestFullscreen', { value: undefined, configurable: true });
        Object.defineProperty(proto, 'webkitRequestFullscreen', { value: undefined, configurable: true });
      }
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/pocket/#screen`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#screenWrap', { timeout: 5000 });

    check('WebView 模拟：确认页面里确实没有 Fullscreen API',
      await page.evaluate(() => typeof document.getElementById('screenWrap').requestFullscreen !== 'function'));

    await page.locator('#screenFull').click();
    await page.waitForFunction(() => document.getElementById('screenWrap').classList.contains('pseudo-fullscreen'), null, { timeout: 4000 });
    const st = await page.evaluate(() => {
      const w = document.getElementById('screenWrap');
      const r = w.getBoundingClientRect();
      return {
        coversViewport: Math.round(r.width) >= window.innerWidth - 1 && Math.round(r.height) >= window.innerHeight - 1,
        zIndex: getComputedStyle(w).zIndex,
        buttonText: document.getElementById('screenFull').textContent,
      };
    });
    check('WebView 兜底：伪全屏铺满视口', st.coversViewport, JSON.stringify(st));
    check('WebView 兜底：层级压过页签栏', Number(st.zIndex) >= 9999, st.zIndex);
    check('WebView 兜底：按钮可退出', st.buttonText === '退出全屏', st.buttonText);

    // Esc 也应能退出（伪全屏没有浏览器的 Esc 处理）
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('screenWrap').classList.contains('pseudo-fullscreen'), null, { timeout: 4000 });
    check('WebView 兜底：Esc 可退出全屏', true);

    await ctx.close();
  }
} catch (err) {
  failures.push('运行期异常');
  console.log(`FAIL  运行期异常 — ${err.message}`);
} finally {
  if (browser) await browser.close().catch(() => { });
  server.kill();
  inputServer.kill();
}

console.log('');
if (failures.length > 0) {
  console.log(`RESULT: ${failures.length} 项失败（共 ${passed + failures.length} 项）`);
  process.exit(1);
}
console.log(`RESULT: ALL PASS (${passed}/${passed})`);
