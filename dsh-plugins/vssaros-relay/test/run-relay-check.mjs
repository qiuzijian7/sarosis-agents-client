// 中转站工作台自检（dsh-plugins/vssaros-relay/test/run-relay-check.mjs）。
//
// 覆盖：页面能渲染 / 内联脚本语法正确 / iframe 指向中转站 / 清单与宿主表三处登记 /
//      侧栏 route 白名单登记 / 扩展侧「登录后自动注册」的挂钩点还在。
//
// 跑法：node dsh-plugins/vssaros-relay/test/run-relay-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(HERE, '..');
const REPO = path.join(PKG, '..', '..');

let problems = 0;
const fail = (msg) => { problems++; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✔ ' + msg);

// ① 页面能渲染（默认地址 = 中转站的 devcloud 域名）
const { renderPage, DEFAULT_RELAY } = await import(pathToFileURL(path.join(PKG, 'lib', 'page.js')).href);
const html = renderPage({});
if (html.includes('relay-enroll')) {
	ok('页面有「注册本机到号池」按钮');
} else {
	fail('页面里没有「注册本机到号池」按钮（relay-enroll）');
}
if (html.includes('pool-body')) {
	ok('页面有号池（节点池）表格');
} else {
	fail('页面里没有号池表格容器（pool-body）');
}
if (html.includes('relay-site') || /<iframe/i.test(html)) {
	fail('页面还在内嵌中转站站点（iframe ⇒ 只会停在「密钥输入」登录页）');
} else {
	ok('页面不再内嵌中转站登录页（原生页）');
}

// ② 内联脚本语法（页面脚本被拼坏 ⇒ 整页交互静默失效）
const script = /<script>([\s\S]*?)<\/script>/.exec(html);
if (!script) {
	fail('页面里没有内联脚本');
} else {
	try {
		new Function(script[1]);
		ok('内联脚本语法正确');
	} catch (e) {
		fail('内联脚本语法错误：' + String((e && e.message) || e));
	}
}

// ③ 状态栏按钮 + 默认地址
if (!html.includes(DEFAULT_RELAY)) {
	fail('页面里没有中转站地址（DEFAULT_RELAY）');
} else {
	ok('页面显示中转站地址 ' + DEFAULT_RELAY);
}
if (!/^http:\/\/[^/]+\.devcloud\.woa\.com:8000\/?$/.test(DEFAULT_RELAY)) {
	fail('DEFAULT_RELAY 不是中转站的 devcloud 域名地址：' + DEFAULT_RELAY);
} else {
	ok('DEFAULT_RELAY 用的是 devcloud 域名');
}
if (!html.includes('relay-reload') || !html.includes('relay-open')) {
	fail('状态栏缺少「刷新 / 外开」按钮');
} else {
	ok('状态栏有「刷新 / 外开」按钮');
}

// ③' Host 侧：路由 + 两个动作 + 注册体不带模型目录
const hostSrc = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
for (const route of ['/api/ping', '/api/nodes', '/api/enroll', '/api/agent/logs']) {
	if (hostSrc.includes(`ROUTE_PREFIX + '${route}'`)) {
		ok(`Host 路由 ${route} 在位`);
	} else {
		fail(`Host 路由 ${route} 缺失`);
	}
}
if (hostSrc.includes('enrollLocal') && hostSrc.includes('listNodes')) {
	ok('Host 侧有「注册本机」与「读号池」两个动作');
} else {
	fail('Host 侧缺 enrollLocal / listNodes');
}
if (/catalog:\s*\{\s*models:\s*\[\]/.test(hostSrc)) {
	fail('注册体里带了 catalog.models=[] ⇒ 会把节点已有的模型目录清空（touch 是覆盖语义）');
} else {
	ok('注册体不带模型目录（不会清空节点已有能力）');
}

// ③'' 密钥与挂载方式：默认密钥写在代码里（loader 不把 patch 的 config 交给 init），
//      并且**不许**把管理员 auth-key 写进插件（那是全权凭据，只该留在服务端）。
const patchSrc = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
if (patchSrc.includes("id: vssaros-relay") && patchSrc.includes("name: '@vssaros/dsh-relay'")) {
	ok('bundle patch 有 vssaros-relay 挂载行');
} else {
	fail('bundle patch 缺 vssaros-relay 挂载行（⇒ 插件挂不上）');
}
if (hostSrc.includes('DEFAULT_ENROLL_KEY')) {
	ok('注册密钥的默认值写在代码里（DEFAULT_ENROLL_KEY）');
} else {
	fail('代码里没有 DEFAULT_ENROLL_KEY（⇒ loader 不给 config 时插件会退化成「未配置密钥」）');
}
if (hostSrc.includes('/api/nodes/pool') && hostSrc.includes('x-enroll-key')) {
	ok('号池走窄作用域接口 /api/nodes/pool（enroll key 认证）');
} else {
	fail('号池没有走 /api/nodes/pool + x-enroll-key');
}
// ⚠ 判据要精确：仓库目录名本身就叫 chatgpt2api（路径里会出现）⇒ 只认"被当成值写的"管理员密钥。
if (hostSrc.includes('adminKey') || /['"]chatgpt2api['"]/.test(hostSrc)) {
	fail('插件里出现了管理员 auth-key（全权凭据，只该留在服务端）');
} else {
	ok('插件里没有管理员 auth-key');
}

// ④ 插件清单
const pkg = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
if (pkg.vssaros?.module !== 'relay') {
	fail('清单的 vssaros.module 不是 relay');
} else {
	ok('清单 module = relay');
}
if (pkg.vssaros?.view?.route !== '/x/relay/') {
	fail('清单路由不是 /x/relay/');
} else {
	ok('清单路由 = /x/relay/');
}
if (pkg.vssaros?.activityBar?.containerId !== 'vssaros.dsh.relay') {
	fail('清单容器 id 不是 vssaros.dsh.relay');
} else {
	ok('清单容器 id = vssaros.dsh.relay');
}

// ⑤ 宿主侧：模块页表 + 容器表
const containers = fs.readFileSync(
	path.join(REPO, 'src', 'vs', 'sessions', 'contrib', 'dshHarness', 'common', 'dshModuleContainers.ts'),
	'utf8',
);
if (!containers.includes("{ module: 'relay', kind: 'page', route: '/x/relay/' }")) {
	fail('宿主模块页表没登记 relay（⇒ 从主页/侧栏点「打开」会静默拒掉）');
} else {
	ok('宿主模块页表已登记 relay');
}
if (!containers.includes("'vssaros.dsh.relay'")) {
	fail('宿主容器表没登记 vssaros.dsh.relay');
} else {
	ok('宿主容器表已登记 vssaros.dsh.relay');
}

// ⑥ 侧栏启动器 = route 白名单
const nav = fs.readFileSync(path.join(REPO, 'dsh-plugins', 'vssaros-chat-surface', 'lib', 'client.workbenchNav.js'), 'utf8');
if (!nav.includes('route: "/x/relay/"')) {
	fail('侧栏启动器没登记 /x/relay/（它同时是 route 白名单）');
} else {
	ok('侧栏启动器已登记 /x/relay/');
}

// ⑦ 扩展侧：**不做自动注册**（2026-10-27 用户要求：注册必须由人点按钮触发）
const relayTs = fs.readFileSync(path.join(REPO, 'extensions', 'codebuddy-provider', 'src', 'relay.ts'), 'utf8');
if (!relayTs.includes("'codebuddy.relay.node'")) {
	fail('扩展侧没写节点存储键（codebuddy.relay.node）');
} else {
	ok('扩展侧写了节点存储键');
}
if (/onDidChange[\s\S]{0,240}logged-in/.test(relayTs)) {
	fail('扩展侧还在「登录成功」时自动注册（用户要求改成手动）');
} else {
	ok('扩展侧不再在登录成功时自动注册');
}
if (/setInterval/.test(relayTs)) {
	fail('扩展侧还有周期心跳定时器（注册已是手动动作，不该再有后台自动行为）');
} else {
	ok('扩展侧没有周期心跳定时器');
}
if (!/api\/nodes\/auto-enroll/.test(relayTs)) {
	fail('扩展侧没调中转站的自动注册接口（手动命令要用）');
} else {
	ok('扩展侧保留了手动注册命令的调用');
}

// ⑧ 「移除注册」按钮（2026-10-28 用户要求：能把本机从号池里摘掉）
if (html.includes('relay-unregister')) {
	ok('页面有「🗑 移除注册」按钮');
} else {
	fail('页面缺「🗑 移除注册」按钮');
}
if (hostSrc.includes("ROUTE_PREFIX + '/api/unregister'") && hostSrc.includes('unregisterLocal')) {
	ok('Host 有 /api/unregister（节点自带令牌销号 ⇒ 不需要管理员密钥）');
} else {
	fail('Host 缺 /api/unregister 或 unregisterLocal');
}

// ⑨ 「注册按钮状态化」（2026-10-28 用户要求：已注册就别再让点注册）
if (html.includes('relay-reconnect')) {
	ok('页面有「↻ 重连通道」按钮（已注册时替代重复注册）');
} else {
	fail('页面缺「↻ 重连通道」按钮');
}
// ★ 三态：未注册 / 已注册且通道通 / 已注册但通道不通（此时必须允许「重新注册」否则卡死）
for (const label of ['注册本机到号池', '已注册 · 通道已连接', '重新注册并重连']) {
	if (html.includes(label)) {
		ok(`注册按钮有「${label}」文案`);
	} else {
		fail(`注册按钮缺「${label}」文案`);
	}
}
// ★ Agent 必须**启动即自动连**（2026-10-28 用户反馈「每次重启 app 都变 offline」）
//   根因：主进程那份 Agent 已删除，而插件侧 `agentEnabled` 仍是 false ⇒ 没有任何实例连通道。
//   ⇒ 守死这个开关，防止回归。
{
	const source = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
	if (/agentEnabled:\s*true/.test(source)) {
		ok('插件默认自己起 Agent（agentEnabled: true ⇒ 重启后自动连通道）');
	} else {
		fail('插件 agentEnabled 不是 true ⇒ 重启 app 后不会有实例连通道（页面会显示 offline）');
	}
	if (/ensureAgent\(\)/.test(source)) {
		ok('凭据就绪后会调用 ensureAgent()（有节点记录才连）');
	} else {
		fail('插件里找不到 ensureAgent() 自动启动调用');
	}
}
// ★★ 防"删 import 导致运行期 ReferenceError"（2026-10-28 真实事故）
//   删掉 `import os from 'node:os'` 后，`enrollLocal` 里的 `os.hostname()` 在**运行期**才炸
//   ⇒ handler 抛异常 ⇒ 响应体为空 ⇒ 页面报 "Unexpected end of JSON input"
//   ⇒ 而 `node --check` 查不出来（语法合法）⇒ 必须静态断言"用到的内置都已 import"。
{
	const relayIndex = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
	const needed = [
		[/[^.\w]os\./, "from 'node:os'", 'os'],
		[/[^.\w]fsp\./, "from 'node:fs'", 'fsp'],
		[/[^.\w]existsSync\(/, "from 'node:fs'", 'existsSync'],
		[/[^.\w]readFileSync\(/, "from 'node:fs'", 'readFileSync'],
		[/[^.\w]join\(/, "from 'node:path'", 'join'],
	];
	const missing = needed
		.filter(([re, imp]) => re.test(relayIndex) && !relayIndex.includes(imp))
		.map(([, , name]) => name);
	if (!missing.length) {
		ok('index.js 用到的 node 内置都已 import（不会运行期 ReferenceError）');
	} else {
		fail(`index.js 用了 ${missing.join('、')} 但缺少对应 import ⇒ 运行期会 ReferenceError（注册等接口返回空响应）`);
	}
}
// ★ Token 用量超链接（2026-10-28 用户要求）：指向 token.woa.com，个人额度/用量看板
if (html.includes('href="https://token.woa.com/"') && html.includes('Token 用量')) {
	ok('页面有「🔗 Token 用量」超链接（token.woa.com）');
} else {
	fail('页面缺「🔗 Token 用量」超链接（https://token.woa.com/）');
}
// ★ Tokens 用量（2026-10-28 改为**全自动**：走浏览器插件，零手工）
//   主路径 = dsh Host 通过 `vssaros-browser` 的 loginSession 读**真实浏览器**里的 woa 会话；
//   没有会话 ⇒ 自动在浏览器里打开登录页（企业 SSO 在真实浏览器里回执正常）。
//   ⇒ 页面**不再有**「粘贴 Cookie」（用户明确不要手工）。
for (const [needle, label] of [
	['quota-login', '「🌐 浏览器登录」按钮'],
	['/x/relay/api/quota/login', '触发浏览器登录的接口'],
	['/x/relay/api/quota/account', '读中转站快照（/api/quota/account）'],
	['/x/relay/api/quota', '读本机采集结果（/api/quota）'],
]) {
	if (html.includes(needle)) {
		ok(`Tokens 用量卡片有${label}`);
	} else {
		fail(`Tokens 用量卡片缺${label}（${needle}）`);
	}
}
if (!html.includes('粘贴 Cookie') && !html.includes('quota-paste')) {
	ok('Tokens 用量卡片已去掉「粘贴 Cookie」（全自动，不再需要手工）');
} else {
	fail('Tokens 用量卡片还留着「粘贴 Cookie」⇒ 违背"全程自动、不要手动操作"的要求');
}
// ★ 采集通道：浏览器插件接线 + 站点登记（缺一不可）
{
	const relayIndex = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8');
	const browserSession = fs.readFileSync(path.join(REPO, 'dsh-plugins', 'vssaros-browser', 'lib', 'core', 'loginSession.js'), 'utf8');
	if (/inject\?\.\(\['vssarosBrowser'\]/.test(relayIndex)) {
		ok('relay 插件动态注入了 vssarosBrowser（拿得到浏览器会话能力）');
	} else {
		fail('relay 插件没有 inject vssarosBrowser ⇒ 拿不到浏览器会话，额度采集不了');
	}
	if (fs.existsSync(path.join(PKG, 'lib', 'quotaBrowser.js'))
		&& /loginSession/.test(fs.readFileSync(path.join(PKG, 'lib', 'quotaBrowser.js'), 'utf8'))) {
		ok('relay 插件有 lib/quotaBrowser.js（经浏览器会话采集额度）');
	} else {
		fail('relay 插件缺 lib/quotaBrowser.js');
	}
	if (/woa:\s*Object\.freeze\(\{[\s\S]{0,400}hostSuffix:\s*'woa\.com'/.test(browserSession)) {
		ok('浏览器插件登记了 woa 站点（可读 token.woa.com 的会话 cookie）');
	} else {
		fail('浏览器插件的 LOGIN_PROFILES 里没有 woa 站点 ⇒ 读不到 woa 会话');
	}
}
if (hostSrc.includes("ROUTE_PREFIX + '/api/agent/reconnect'")) {
	ok('Host 有 /api/agent/reconnect（只重连、不轮换令牌）');
} else {
	fail('Host 缺 /api/agent/reconnect');
}

// ⑨ 各面板的「↻ 刷新」按钮（2026-10-28 加：号池 15s / 日志 4s 自动轮询之外，手动立即拉）
for (const btn of ['agent-refresh', 'pool-refresh', 'log-refresh']) {
	if (html.includes(btn)) {
		ok(`页面有「${btn}」刷新按钮`);
	} else {
		fail(`页面缺「${btn}」刷新按钮`);
	}
}
if (html.includes('agent-updated')) {
	ok('页面显示「更新于 …」时间戳（知道数据是不是新鲜的）');
} else {
	fail('页面缺「更新于 …」时间戳');
}

// ⑨ 「Agent 节点」面板 + 「执行日志」面板（2026-10-28 加）
const agentSrc = fs.readFileSync(path.join(PKG, 'lib', 'agent.js'), 'utf8');
if (agentSrc.includes('pushExec') && agentSrc.includes('execLog()')) {
	ok('Agent 有执行日志（invoke 开始/结束 + 通道开合）');
} else {
	fail('Agent 没有执行日志（pushExec / execLog 缺失）');
}
if (html.includes('agent-body') && html.includes('log-body')) {
	ok('页面有「Agent 节点」面板与「执行日志」面板');
} else {
	fail('页面缺「Agent 节点」/「执行日志」面板');
}
if (html.includes('channelConnected') || html.includes('agent-body')) {
	ok('Agent 节点面板读号池里的通道状态');
} else {
	fail('Agent 节点面板没读通道状态');
}

// ⑨ 主页卡片（dsh 侧清单，与宿主页表 / 侧栏白名单三处对账）
const catalog = fs.readFileSync(path.join(REPO, 'dsh-plugins', 'vssaros-dashboard', 'lib', 'catalog.js'), 'utf8');
if (catalog.includes("route: '/x/relay/'")) {
	ok('主页卡片清单已登记 /x/relay/');
} else {
	fail('主页卡片清单没登记 /x/relay/（主页上看不到这个工作台）');
}

console.log(problems === 0
	? '\n[relay-check] ✓ 中转站工作台自检通过'
	: `\n[relay-check] ✗ ${problems} 项问题`);
process.exit(problems === 0 ? 0 : 1);
