// 清单接线测试：插件页（Installed 页签的 Configuration）里能看到什么，
// 完全由几处清单共同决定 —— 这里把它们钉在一起，防「改了状态仓库但没声明设置」
// 或「加了按钮但没注册命令」这类静默失效（按钮点了没反应 / 开关改了不生效）。
//
//   1. package.json  contributes.configuration.properties（插件页读的是**宿主扩展的这个**）
//   2. package.json  contributes.commands（x-action 指向的命令必须存在）
//   3. extension.js  registerCommand(...)（命令必须真被注册，否则按钮点了报错）
//   4. lib/state.mjs SETTING_DEFAULTS（开关类真源在设置里 ⇒ 每个键都必须声明）
//   5. plugin/plugin.json configuration（镜像，便于插件包自带说明）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const pkg = JSON.parse(read('package.json'));
const plugin = JSON.parse(read('plugin/plugin.json'));
const stateSrc = read('lib/state.mjs');
const extSrc = read('extension.js');

/**
 * `contributes.configuration` 支持两种合法形态：**单对象**，或**多个 section 的数组**
 * （每个 section 带 `title`）。本仓库用数组形态**声明分组** —— 插件详情页与原生设置页
 * 都会按 `title` 分组渲染；这里统一拍平后再做断言。
 */
function flattenConfiguration(configuration) {
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  return Object.assign({}, ...sections.map((s) => s?.properties ?? {}));
}

const props = flattenConfiguration(pkg.contributes.configuration);
const commands = new Set(pkg.contributes.commands.map((c) => c.command));
const actions = Object.entries(props).filter(([, v]) => v['x-action']);

/** 设置项类型必须是插件详情页真能渲染的（它只认 boolean/number/string/array）。 */
const RENDERABLE = new Set(['boolean', 'number', 'string', 'array']);

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---------- 分组声明 ----------

test('设置声明了分组（数组形态 + 每组标题唯一），详情页与原生设置页据此分组渲染', () => {
  const sections = pkg.contributes.configuration;
  assert.ok(Array.isArray(sections), 'configuration 应为数组形态（每个 section 一个分组）');
  assert.ok(sections.length >= 4, `分组太粗（${sections.length} 组），不利于在插件页里扫读`);
  const titles = sections.map((s) => s.title);
  assert.ok(titles.every((t) => typeof t === 'string' && t.length > 0), '每个 section 都要有标题');
  assert.equal(new Set(titles).size, titles.length, `分组标题不得重复（折叠状态以标题为键）：${titles.join(' / ')}`);
  for (const s of sections) {
    assert.ok(Object.keys(s.properties ?? {}).length > 0, `分组「${s.title}」是空的`);
  }
});

test('设置页设计元数据齐备（分组图标/说明 + 高级项 + 按钮分行与主次）', () => {
  const sections = pkg.contributes.configuration;
  for (const s of sections) {
    assert.ok(s['x-icon'], `分组「${s.title}」缺 x-icon（左栏导航图标）`);
    assert.ok(typeof s.description === 'string' && s.description.length > 6, `分组「${s.title}」缺 description（右侧副标题）`);
  }

  const all = Object.entries(props);
  const advanced = all.filter(([, v]) => v['x-advanced'] === true).map(([k]) => k);
  assert.equal(advanced.length, 8, `高级项应为 8 个（实际 ${advanced.length}）：${advanced.join(', ')}`);

  const rows = all.filter(([, v]) => v['x-actionRow']).map(([, v]) => v['x-actionRow']);
  assert.equal(rows.length, actions.length, `每个动作按钮都要声明所在行 x-actionRow（${rows.length}/${actions.length}）`);
  assert.ok(new Set(rows).size >= 3, `按钮分行太少（${new Set(rows).size} 行）——快捷操作卡靠它分行`);

  const primary = all.filter(([, v]) => v['x-actionPrimary'] === true).map(([k]) => k).sort();
  assert.deepEqual(primary, ['sarosPocket.openAppAction', 'sarosPocket.openPanelAction'], '主操作应只有「打开访问面板 / 打开随身 App」');
  const danger = all.filter(([, v]) => v['x-actionDanger'] === true).map(([k]) => k);
  assert.deepEqual(danger, ['sarosPocket.resetAction'], '危险操作应只有「恢复出厂设置」');
});

test('详情页「快速访问」：x-panel 只标在打开面板上，且内嵌面板的两条命令都注册了', () => {
  const panelActions = Object.entries(props).filter(([, v]) => v['x-panel'] === true).map(([k]) => k);
  assert.deepEqual(panelActions, ['sarosPocket.openPanelAction'],
    `x-panel（由内嵌面板承担的动作）应只有「打开访问面板」：${panelActions.join(', ')}`);
  for (const cmd of ['sarosPocket.panelHtml', 'sarosPocket.panel']) {
    assert.ok(extSrc.includes(`registerCommand('${cmd}'`), `extension.js 应注册 ${cmd}（详情页内嵌面板要用）`);
  }
  assert.ok(/function handlePanelCommand\(/.test(extSrc), '面板消息处理要抽成唯一实现');
  assert.ok(/handlePanelCommand\(msg\)/.test(extSrc), '独立面板必须复用 handlePanelCommand');
});

test('插件详情页状态条：sarosPocket.status 已注册，且不回传任何密码 / Token', () => {
  assert.ok(extSrc.includes("registerCommand('sarosPocket.status'"), 'extension.js 应注册 sarosPocket.status（详情页状态条的数据源）');
  const from = extSrc.indexOf("registerCommand('sarosPocket.status'");
  const next = extSrc.indexOf('vscode.commands.registerCommand(', from + 10);
  const block = extSrc.slice(from, next > 0 ? next : from + 1600);
  assert.ok(!/getLanToken|getAccessToken|lanPinAction|publicPinAction|token/i.test(block.replace(/desktopInputAllowed/g, '')),
    '状态命令不得回传密码 / Token（只回状态）');
  for (const key of ['lanUrl', 'tunnelUrl', 'upstreamOk', 'desktopInputAllowed', 'desktopInputSupported']) {
    assert.ok(block.includes(key), `status 应带上 ${key}（状态条据此渲染）`);
  }
});

// ---------- 动作按钮（x-action） ----------

test('每个按钮动作都有命令声明 + 真被 registerCommand 注册', () => {
  assert.ok(actions.length >= 10, `按钮太少（${actions.length}），面板里的动作应该都有入口`);
  const missingDecl = actions.filter(([, v]) => !commands.has(v['x-action'])).map(([, v]) => v['x-action']);
  assert.deepEqual(missingDecl, [], `package.json 里缺这些命令声明：${missingDecl.join(', ')}`);
  const missingReg = actions.filter(([, v]) => !extSrc.includes(`registerCommand('${v['x-action']}'`))
    .map(([, v]) => v['x-action']);
  assert.deepEqual(missingReg, [], `extension.js 里没注册这些命令（按钮点了会失败）：${missingReg.join(', ')}`);
});

test('每个按钮都有中文文案与说明（插件页用它当按钮文字）', () => {
  for (const [key, v] of actions) {
    assert.ok(typeof v['x-actionLabel'] === 'string' && v['x-actionLabel'].length > 0, `${key} 缺 x-actionLabel`);
    assert.ok(String(v.description || '').includes('点击即执行'), `${key} 的说明应写明「点击即执行」`);
  }
});

// ---------- 开关类设置（面板与插件页同源） ----------

test('state.mjs 的开关键必须逐个声明进 package.json（否则插件页看不到）', () => {
  const block = /const SETTING_DEFAULTS = \{([\s\S]*?)\n\};/.exec(stateSrc);
  assert.ok(block, 'state.mjs 里应有 SETTING_DEFAULTS');
  const keys = [...block[1].matchAll(/^\s*([A-Za-z]\w*):/gm)].map((m) => m[1]);
  assert.deepEqual(
    keys.sort(),
    ['lanAuthEnabled', 'lanEnabled', 'lanIpOverride', 'tunnelHostname', 'tunnelMode'],
    '开关类键集合变了 —— 记得同步 package.json / 面板 / 文档',
  );
  for (const k of keys) assert.ok(props[`sarosPocket.${k}`], `设置里缺少 sarosPocket.${k}`);
});

test('面板里的每个开关/输入都能在插件页找到对应项', () => {
  // 面板控件 → 设置项（一一对应，避免「面板有、插件页没有」的再次发生）
  const panelToSetting = {
    '局域网访问总开关': 'sarosPocket.lanEnabled',
    '局域网访问密码': 'sarosPocket.lanAuthEnabled',
    '局域网地址覆盖': 'sarosPocket.lanIpOverride',
    '隧道模式': 'sarosPocket.tunnelMode',
    '固定域名': 'sarosPocket.tunnelHostname',
  };
  const panel = read('panel/index.html');
  for (const [label, key] of Object.entries(panelToSetting)) {
    assert.ok(panel.includes(label), `面板里找不到「${label}」（面板改了？同步更新本表）`);
    assert.ok(props[key], `插件页缺少对应设置项 ${key}`);
  }
});

test('所有设置项的 type 都是插件页能渲染的类型', () => {
  const bad = Object.entries(props).filter(([, v]) => !RENDERABLE.has(String(v.type)));
  assert.deepEqual(bad.map(([k]) => k), [], `这些 type 插件页渲染不了（会退化成文本框）：${bad.map(([k]) => k).join(', ')}`);
});

// ---------- 凭据不进设置 ----------

test('密码 / 隧道 Token 不得出现在设置里（凭据只落 globalStorage）', () => {
  for (const key of ['sarosPocket.lanPin', 'sarosPocket.publicPin', 'sarosPocket.tunnelToken']) {
    assert.ok(!props[key], `${key} 不该是设置项 —— settings.json 会被同步/被读到`);
  }
  // 但必须有按钮入口，否则用户没法改
  for (const cmd of ['sarosPocket.setLanPin', 'sarosPocket.setPublicPin', 'sarosPocket.refreshLanPin', 'sarosPocket.setTunnelToken']) {
    assert.ok(actions.some(([, v]) => v['x-action'] === cmd), `缺按钮入口：${cmd}`);
  }
});

// ---------- 面板消息 ↔ 扩展处理（漏接 = 点了没反应） ----------

test('面板 post 的每个 command 在 extension.js 里都有 case 分支', () => {
  const panel = read('panel/index.html');
  const cmds = [...new Set([...panel.matchAll(/command:\s*'([A-Za-z]+)'/g)].map((m) => m[1]))];
  assert.ok(cmds.length >= 8, `面板消息太少（${cmds.length}），正则或面板结构变了？`);
  const missing = cmds.filter((c) => !extSrc.includes(`case '${c}'`));
  assert.deepEqual(missing, [], `扩展侧没处理这些面板消息（点了会静默无反应）：${missing.join(', ')}`);
});

test('面板里的「同屏 web 上游」状态元素齐备（面板据此提前说明，别等用户撞 502）', () => {
  const panel = read('panel/index.html');
  for (const id of ['upstreamBadge', 'probeUpstream', 'upstreamDownNote', 'webEntryLink']) {
    assert.ok(panel.includes(id), `面板缺少 ${id}`);
  }
  // 数据链路：service.status() 给出 upstreamOk → 扩展原样转发 → 面板渲染
  assert.ok(read('lib/service.mjs').includes('upstreamOk'), 'service.status() 应带出上游可用性');
  assert.ok(panel.includes('s.upstreamOk'), '面板应消费 upstreamOk');
  assert.ok(extSrc.includes('service.status()'), '扩展应把 status 原样转发给面板');
});

test('「局域网访问」卡有「在浏览器打开（自动填密码）」按钮，且走带 token 的地址', () => {
  const panel = read('panel/index.html');
  const lanCard = panel.slice(panel.indexOf('<div class="card" id="lanCard">'), panel.indexOf('<div class="card" id="pubCard">'));
  assert.ok(lanCard.includes('id="openLanBrowser"'), '局域网访问卡里要有这个按钮');
  assert.ok(/openLanBrowser'\)\.onclick\s*=\s*\(\)\s*=>\s*post\(\{command:'openApp'\}\)/.test(panel),
    '按钮要发 openApp（与「本机打开 App」同一个命令）');
  assert.ok(extSrc.includes('appBrowserUrl('), '扩展要有「带密码的浏览器地址」构造');
});

test('安全：带密码的地址只用于「打开浏览器」，复制出去的地址必须干净', () => {
  const src = read('lib/host.mjs');
  assert.ok(/export function appEntryUrl\(/.test(src), '地址构造要抽出成可测的纯函数');
  assert.ok(src.includes('?token=${encodeURIComponent(t)}'), '密码要 URL 编码');
  // 三个使用点：打开浏览器带 token；复制地址 / 日志 / 上游页链接必须不带
  assert.ok(extSrc.includes('appBrowserUrl(p)'), 'openApp 用带 token 的地址');
  assert.ok(/copyAppUrl[\s\S]{0,200}clipboard\.writeText\(appUrl\(p\)\)/.test(extSrc),
    '复制 App 地址**不能**带密码（这个地址是要发给别人的）');
  assert.ok(!/copyAppUrl[\s\S]{0,200}appBrowserUrl/.test(extSrc), '复制地址不得使用带 token 的版本');
  // App 侧：载入后把参数摘掉，别留在历史/截图里
  const appJs = read('app/app.js');
  assert.ok(appJs.includes('function stripTokenFromAddressBar'), 'App 要摘掉地址栏里的 token');
  assert.ok(/searchParams\.delete\('token'\)/.test(appJs) && /history\.replaceState/.test(appJs),
    '用 replaceState 摘（不留返回栈）');
  assert.ok(appJs.includes('stripTokenFromAddressBar();'), '启动时要真的调用');
});

test('远端键鼠默认开启（决策锁）：默认值必须是 true 且说明里写明风险与关闭办法', () => {
  const p = props['sarosPocket.allowDesktopInput'];
  assert.ok(p, '应有 allowDesktopInput 设置');
  assert.equal(p.default, true, '用户要求「允许远程操控默认开启」—— 改回 false 会让屏幕页一进去就是只读');
  const text = String(p.description || p.markdownDescription || '');
  assert.match(text, /默认开启/, '说明里要写清默认开启（否则用户不知道电脑可被操控）');
  assert.match(text, /关掉|关闭/, '要给出关闭办法');
});

test('除远端键鼠外，其余危险能力仍默认关闭（写文件 / 终端）', () => {
  for (const key of ['sarosPocket.allowFileWrite', 'sarosPocket.allowTerminal']) {
    assert.equal(props[key]?.default, false, `${key} 必须仍然默认关闭（用户只要求远程操控默认开）`);
  }
});

test('App 端「允许远程操作」默认开且记住用户选择（关掉后不再自动打开）', () => {
  const appJs = read('app/app.js');
  assert.ok(appJs.includes("var INPUT_OPTIN_KEY = 'sarosPocket.screenInputOptIn'"), '偏好要落到 localStorage 的固定键');
  assert.ok(/function readInputOptIn\(\)[\s\S]{0,220}v === null \? true : v === '1'/.test(appJs),
    '没存过就是 true（默认开）；存过就按用户选择');
  assert.ok(appJs.includes('inputOptIn: readInputOptIn()'), 'state 初值要走这个偏好');
  assert.ok(appJs.includes('writeInputOptIn(screenState.inputOptIn)'), '用户切换后要记住');
  // ★ 位置即正确性：`var` 不提升赋值 —— 键名若声明在 screenState 之后，读偏好时键名是 undefined，
  //   结果永远是"默认开"，用户关掉也白关（浏览器实测抓到的 bug）
  assert.ok(appJs.indexOf("var INPUT_OPTIN_KEY") < appJs.indexOf('var screenState = {'),
    'INPUT_OPTIN_KEY 必须声明在 screenState 之前');
  // 默认开 ⇒ 必须有常显标识，否则是"悄悄操控用户的电脑"
  assert.ok(read('app/index.html').includes('id="screenInputBadge"'), '画面要有「远程操作中」标识元素');
  assert.ok(appJs.includes("el.screenInputBadge.classList.toggle('hidden', !inputActive())"),
    '标识要跟着 inputActive() 显隐');
  const css = read('app/app.css');
  assert.ok(/\.screen-inputbadge \{[\s\S]{0,200}position: absolute/.test(css), '标识要贴在画面上（全屏时也在）');
});

test('「手机连不上」的排查元素齐备（换地址候选 + 本机自检），且都接在 status 上', () => {
  const panel = read('panel/index.html');
  for (const id of ['lanAltRow', 'lanAltChips', 'clearLanIpOverride', 'checkLan', 'lanCheckBadge', 'lanCheckDetail', 'lanHelp']) {
    assert.ok(panel.includes(id), `面板缺少 ${id}`);
  }
  // 数据来自 status（不再新增消息类型：自检结果放进 status.lanCheck，两种面板都会拿到）
  assert.ok(panel.includes('s.lanInterfaces'), '换地址要用候选网卡明细渲染');
  assert.ok(panel.includes('s.lanCheck'), '自检结果要从 status 渲染');
  assert.ok(/post\(\{command:'checkLan'\}\)/.test(panel), '「检测本机」要发 checkLan');
  assert.ok((panel.match(/setLanIpOverride/g) ?? []).length >= 2, '候选点击与「用自动检测」都要能写回覆盖值');
  // 说明文字必须短：这条排查链只允许「一行结论 + 一行建议」，别又铺成长文
  const helpBlock = panel.slice(panel.indexOf('const helpText'), panel.indexOf('help.textContent'));
  assert.ok(helpBlock.length > 0, '找不到 helpText 文案块');
  assert.ok(helpBlock.length < 420, `建议文案要短（当前 ${helpBlock.length} 字）`);
  for (const text of helpBlock.match(/'[^']{40,}'/g) ?? []) {
    assert.ok(text.length < 220, `单条建议别超过 220 字：${text.slice(0, 40)}…`);
  }
});

test('「局域网访问」卡的二维码必须是 App 入口（根路径的码桌面版扫了必然打不开）', () => {
  const panel = read('panel/index.html');
  const lanCard = panel.slice(panel.indexOf('<div class="card" id="lanCard">'), panel.indexOf('<div class="card" id="pubCard">'));
  assert.ok(lanCard.length > 0, '找不到「局域网访问」卡');

  // ① 卡里的二维码/地址渲染的是 **App 入口**（lanAppQr / lanAppUrl）
  assert.ok(lanCard.includes('id="lanAppQr"') && lanCard.includes('id="lanAppUrl"'),
    '本卡的二维码与地址应是 App 入口（lanAppQr / lanAppUrl）');
  assert.ok(panel.includes("getElementById('lanAppQr')") && panel.includes('s.lanAppQr'),
    '渲染函数要用 s.lanAppQr');

  // ② 不得再出现编码代理根路径的二维码（`lanQr` = 同屏 web 入口，桌面版必坏）
  assert.ok(!/\bs\.lanQr\b/.test(panel), '面板不得再消费 s.lanQr（根路径二维码：桌面版扫进去是错误页）');
  assert.ok(!panel.includes('id="lanQr"'), '不应再有根路径二维码元素');

  // ③ 同屏 web 入口只作为「状态 + 可用时才出现的链接」存在
  assert.ok(/up===true && s\.lanUrl\)\s*\{\s*link\.href=s\.lanUrl/.test(panel),
    '只有上游可用时才给「打开」链接');
  assert.ok(/upstreamDownNote'\)\.classList\.toggle\('hidden', up!==false\)/.test(panel),
    '不可达时才显示那一行说明');

  // ④ 说明文字要短（早期版本在这里铺了 6 行，把主要动作压到了警告下面）
  const note = lanCard.slice(lanCard.indexOf('id="upstreamDownNote"'));
  const noteText = note.slice(0, note.indexOf('</div>'));
  assert.ok(noteText.length < 260, `一行说明即可，别又铺成长文（当前 ${noteText.length} 字）`);
});

// ---------- plugin.json 镜像 ----------

test('plugin.json 镜像覆盖同一批开关与按钮', () => {
  const mirrored = (plugin.configuration && plugin.configuration.properties) || {};
  // 注意 key 已带 `sarosPocket.` 前缀（props 的键就是全名），别再拼一层
  for (const [key] of actions) assert.ok(mirrored[key], `plugin.json 缺按钮镜像：${key}`);
  for (const k of ['lanEnabled', 'lanAuthEnabled', 'lanIpOverride', 'tunnelMode', 'tunnelHostname']) {
    assert.ok(mirrored[`sarosPocket.${k}`], `plugin.json 缺设置镜像：${k}`);
  }
});

// ---------- 执行 ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message}`);
  }
}
console.log(`\nRESULT: ${failed === 0 ? 'ALL PASS' : `${failed} / ${tests.length} FAILED`}`);
if (failed > 0) process.exitCode = 1;
