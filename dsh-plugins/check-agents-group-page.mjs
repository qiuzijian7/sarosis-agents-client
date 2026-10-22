/*
 * check-agents-group-page.mjs ★ 群聊页（DSB v3 桌面版）+ agents 工作台接线 的契约守卫
 *
 * 为什么要有这条（两层）：
 *   1) poc/ 下的浏览器探针**不在版本控制里**（/poc/ 被 .gitignore）⇒ 出了这个工作区就没了；
 *   2) 「群聊页长什么样」是有明确规格的（DSB v3 桌面版 + agents-surfaces-v2 mockup 款 A/C/D），
 *      不该靠人记 ⇒ 把规格钉成断言。
 *
 * 覆盖：
 *   1  DOM 骨架（左栏 / 中间栏 / 岛屿 / 栈 / 胶囊 composer / 右栏 / 三个弹层）
 *   2  DSB 版式常量（栈宽 560、胶囊 radius 25、发送键 34×34、右栏 320、左栏 236）
 *   3  响应式（**优先牺牲左栏、保住右栏**：≤1080 左栏折叠 + 右栏 280；≤760 右栏才抽屉）
 *   4  右栏六个 tab（记忆 / 演化 / 版本 / 分支 / 成员 / 工作）+ 记忆签里的 Git 历史
 *   5  消息分组口径（DSB message-groups.ts：15s / 180s / 8 条 / at 不得倒流）
 *   6  主题化（--gp-* 指向 --vscode-*，不再自带写死浅色皮）
 *   7  工作台接线（群聊签 = iframe 承载群聊页、默认落点、焦点交接、旧面板已下线）
 *   8  活动 / 时间线两个签（mockup 款 C / 款 D）
 *   9  **页面内联脚本必须能解析**（拼接字符串里放注释会吃掉后续代码 ⇒ 整页交互静默失效）
 *  10  API 路径按**出现次数**钉（"出现过就算"会恒真）
 *
 * 跑法：node dsh-plugins/check-agents-group-page.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = join(ROOT, 'dsh-plugins/vssaros-agents/lib/groupPage.js');
const DETAIL = join(ROOT, 'dsh-plugins/vssaros-agents/lib/detail.js');
const src = readFileSync(SRC, 'utf8');
const mod = await import(pathToFileURL(SRC).href);

const html = mod.renderGroupPage({
	groups: { groups: [], keep: 200 },
	agents: [], activeId: '', openNew: false, keep: 200,
});
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const client = scripts[0] || '';

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

console.log('★ 群聊页 DSB v3 桌面版 + agents 工作台契约\n');

// ── 1 DOM 骨架 ─────────────────────────────────────────────────────────
const IDS = [
	'gpLeft', 'gpAgents', 'gpGroups', 'gpMid', 'gpCrumb', 'gpPill', 'gpStack',
	'gpIn', 'gpSend', 'gpRight', 'gpRBody', 'gpOvl', 'gpLeftBtn', 'gpRightBtn',
	'maskSettings', 'maskNew', 'maskInvite', 'gpModePick', 'gpSetName', 'gpSetSave',
	'gpSetDelete', 'gpWakeBox', 'gpWakeCount', 'gpWakeInt', 'gpApproval', 'gpSetAv',
	'gpAvFile', 'gpAvClear', 'gpAvHint', 'gpNewName', 'gpNewOk', 'gpPick',
	'gpInvitePick', 'gpInviteOk',
];
const missIds = IDS.filter(i => !html.includes(`id="${i}"`));
check('DOM 骨架 id 齐备（33 个）', missIds.length === 0, missIds.join(','));

// ── 2 DSB 版式常量（按选择器精确匹配，避免"整页包含"恒真）──────────────
check('消息栈宽 = min(560px, calc(100% - 84px))（DSB 口径，不是居中大列）',
	/\.gp-stack\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('composer 与消息栈同宽（同样 560）',
	/\.gp-comp\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('底部工具条同宽 560',
	/\.gp-foot\{[^}]*min\(560px,calc\(100% - 84px\)\)/.test(html), '');
check('composer 是胶囊（radius 25 / min-height 50）',
	/\.gp-box\{[^}]*border-radius:25px/.test(html) && /\.gp-box\{[^}]*min-height:50px/.test(html), '');
check('发送键 34×34 圆钮', /\.gp-send\{[^}]*width:34px;height:34px/.test(html), '');
check('气泡 radius 16（组内续接收到 4px）',
	/border-radius:16px/.test(html) && /border-top-left-radius:4px/.test(html), '');
check('右栏宽 320', /\.gp-right\{[^}]*width:320px/.test(html), '');
check('左栏宽 236', /\.gp-left\{[^}]*width:236px/.test(html), '');
check('header 是居中岛屿胶囊（绝对定位的浮层，不是实心条）',
	/\.gp-island\{[^}]*position:absolute/.test(html) && /class="gp-island"[\s\S]{0,80}class="gp-pill"/.test(html), '');

// ── 3 响应式：优先牺牲左栏、保住右栏 ──────────────────────────────────
check('响应式断点：≤1080 左栏让位/右栏收窄到 280，≤760 右栏才变抽屉',
	/max-width:1080px/.test(html) && /max-width:760px/.test(html)
	&& /\.gp-right\{width:280px/.test(html), '');
check('响应式：抽屉入口是文字「面板」而不是 emoji（缺字形 ⇒ 静默空白 ✗）',
	html.includes('id="gpRightBtn"') && html.includes('>面板</button>'), '');
check('响应式：JS 断点与 CSS 一致（抽屉判定 ≤760 / 左栏折叠判定 ≤1080）',
	/var narrow=\(window\.innerWidth\|\|1200\)<=760;/.test(client)
	&& /<=1080\)\{S\.leftOpen/.test(client), '');

// ── 4 右栏六 tab + 记忆签的 Git 历史 ──────────────────────────────────
const TABS = [['mem', '记忆'], ['evo', '演化'], ['ver', '版本'], ['br', '分支'], ['mem-members', '成员'], ['work', '工作']];
const missTabs = TABS.filter(([t, label]) => !new RegExp(`data-t="${t}"[^>]*>${label}<`).test(html));
check('右栏六个 tab 齐备且顺序固定（记忆/演化/版本/分支/成员/工作）', missTabs.length === 0,
	missTabs.map(x => x[0]).join(','));
check('群聊页：记忆签里就有 Git 历史（mockup 款 A 对齐）+ 常驻文件标记',
	/Git 历史/.test(src) && /gp-pin/.test(src) && /data-log/.test(src), '');

// ── 5 消息分组口径（DSB message-groups.ts）─────────────────────────────
check('分组：相邻 ≤15s', /gap<=15000/.test(client), '');
check('分组：整组跨度 ≤180s', /\(e\.at-groupAt\)<=180000/.test(client), '');
check('分组：每组 ≤8 条', /groupN<8/.test(client), '');
check('分组：at 不得倒流（gap>=0）', /gap>=0/.test(client), '');
check('分组：同作者 + 同天', /prev\.key===who/.test(client) && /dayKey\(/.test(client), '');
check('旧的"5 分钟合并"口径已下线', !/5 分钟/.test(html) && !/300000/.test(client), '');

// ── 6 主题化 ───────────────────────────────────────────────────────────
const groupCss = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check('群聊页：--gp-bg 指向宿主主题变量（不得写死浅色皮 #f7f7f8）',
	/--gp-bg:\s*var\(--vscode-editor-background/.test(groupCss) && !/--gp-bg:\s*#f7f7f8/.test(groupCss), '');
check('群聊页：背景/面板/前景/按钮/选中态都走 --vscode-*（至少 12 处）',
	(groupCss.match(/var\(--vscode-/g) ?? []).length >= 12, `命中 ${(groupCss.match(/var\(--vscode-/g) ?? []).length} 处`);
check('群聊页：fallback 分层（媒体查询只改 --gp-fb-*，不覆盖主题变量）',
	/--gp-fb-bg/.test(groupCss) && !/@media[^{]*\{[^}]*--gp-bg:/.test(groupCss), '');

// ── 7 工作台接线（detail.js）──────────────────────────────────────────
const detail = existsSync(DETAIL) ? readFileSync(DETAIL, 'utf8') : '';
check('工作台：群聊签用同源 iframe 承载群聊页（#gpFrame → /x/agents/group/…）',
	detail.includes('id="gpFrame"') && detail.includes('/x/agents/group/'), '');
check('工作台：默认落点 = 群聊签（有群时概览签收起）',
	detail.includes("id=\"tabGroup\"' + (groupFirst ? ' class=\"on\"' : '')"), '');
check('工作台：焦点交接 group:<id> 改为切 iframe 的 src',
	detail.includes('function selectGroupById') && detail.includes("fr.src = '/x/agents/group/'"), '');
check('工作台：旧的内联群面板已下线（不得复活 —— 同一群聊只留一套 UI）',
	!detail.includes('id="gList"') && !detail.includes('id="gName"') && !detail.includes('function groupSend')
	&& !detail.includes('function groupCreate'), '');
check('工作台：iframe 容器有确定高度（否则整页塌成 0 高 ⇒ 空白）',
	detail.includes('.gpframe') && detail.includes('height: calc(100vh'), '');
check('工作台：群聊签只收掉名册筛选框，hero 身份条保留（mockup 款 A 必备块）',
	detail.includes('body.gptab .search') && !detail.includes('body.gptab #hero')
	&& /heroEl\.hidden = which === 'create'/.test(detail), '');
check('工作台：iframe 主题同步真的被调用（watchFrameTheme + syncThemeToFrame 都要在）',
	/function syncThemeToFrame\s*\(/.test(detail) && detail.includes('watchFrameTheme();')
	&& /syncThemeToFrame\(\);/.test(detail), '');

// ── 8 活动 / 时间线（mockup 款 C / 款 D）────────────────────────────────
check('工作台：补齐「活动」「时间线」两个签（mockup 款 C / 款 D）',
	detail.includes('data-vssaros-activity-tab') && detail.includes('data-vssaros-timeline-tab')
	&& detail.includes('id="activity"') && detail.includes('id="timeline"'), '');
check('工作台：活动面板 = 此刻 feed + 待你处理；时间线 = 委派/会话/记忆快照',
	detail.includes('data-vssaros-activity-feed') && detail.includes('data-vssaros-activity-todo')
	&& detail.includes('data-vssaros-timeline') && detail.includes('data-vssaros-tl-kind'), '');
check('工作台：活动/时间线的数据构建是纯函数模块（lib/activity.js，可单测）',
	detail.includes("from './activity.js'") && existsSync(join(ROOT, 'dsh-plugins/vssaros-agents/lib/activity.js')), '');

// ── 9 ★ 页面内联脚本必须能解析 ──────────────────────────────────────
//  2026-10-21 踩到：把一条 `// 注释` 拼进了**页面脚本字符串** ⇒ 注释把同一行后面的代码吃掉
//  ⇒ 花括号不配平 ⇒ 整段脚本 `Unexpected token '}'` ⇒ **页面所有交互静默失效**（连报错都难看到）✗。
//  这类失误静态看源码看不出来（要等拼出来），所以这里**真的拼一次、真的解析一次**。
{
	const now = Date.now();
	const agents = [{
		id: 'researcher', name: 'researcher', description: '检索', icon: '🧭', model: 'hy4',
		tools: ['web'], persona: '人设', file: '/agents/researcher/.agent.md', role: '检索', skills: [],
	}];
	const detailMod = await import(pathToFileURL(DETAIL).href);
	const ed = detailMod.renderDetailPage({
		agents, summary: { count: 1, withModel: 1, withPersona: 1, withTools: 1 },
		root: '/agents', missing: null, diagnostics: [], roster: ['vssaros-researcher'], errors: [],
		liveRows: [{ agentId: 'researcher', sessions: 1, tokens: 10, turns: 1, lastActiveAt: now }],
		usage: null, assignments: null, templates: { tools: [], templates: [] },
		groups: { groups: [{ id: 'g1', name: '群', mode: 'mentions', members: ['researcher'] }], keep: 200 },
		outbox: { entries: [], keep: 0 },
	});
	const blocks = [...ed.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
	let bad = '';
	for (const [n, js] of blocks.entries()) {
		try { new Function(js); } catch (e) { bad = `块${n}: ${e.message}`; }
	}
	check('工作台：页面内联脚本可解析（拼接字符串里放注释会吃掉后面的代码 ⇒ 整页交互失效）', !bad, bad);
	// 反向断言：源码里不允许把 `//` 行注释拼进页面（它会吃掉后续拼接的代码）
	const chunkRe = /\+\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
	const dangerous = [];
	let cm;
	while ((cm = chunkRe.exec(detail)) !== null) {
		const raw = cm[1].slice(1, -1);
		const body = raw.replace(/\\n/g, '\n');
		const at = body.search(/(^|[^:])\/\//);
		if (at < 0) { continue; }
		if (body.endsWith('\n')) { continue; }   // 块自带换行 ⇒ 注释只吃自己那行 ⇒ 安全
		dangerous.push(raw.slice(0, 60));
	}
	check('工作台：源码里没有把 `//` 行注释拼进页面脚本（会吃掉后续代码 ⇒ 整页交互失效）',
		dangerous.length === 0, dangerous.slice(0, 2).join(' / '));
}

// ── 10 API 路径（按出现次数钉，避免"出现过就算"恒真）────────────────────
const countOf = (needle, hay) => hay.split(needle).length - 1;
check('群 API 两处调用都用 /x/agents/api/groups（写 + 读各一次）',
	countOf('/x/agents/api/groups', client) === 2, `实际 ${countOf('/x/agents/api/groups', client)} 次`);
check('记忆 API 三处调用都用 /x/agents/api/memory（列表 / diff / 写）',
	countOf('/x/agents/api/memory', client) === 3, `实际 ${countOf('/x/agents/api/memory', client)} 次`);
check('工作 API 用 /x/agents/api/assignments',
	countOf('/x/agents/api/assignments', client) === 1, `实际 ${countOf('/x/agents/api/assignments', client)} 次`);
check('没有拼错的 API 路径（groupz / api/group 单数 / assignment 单数）',
	!/groupz\b/.test(client) && !/api\/group["'?]/.test(client) && !/api\/assignment["'?]/.test(client), '');

console.log(`\n${pass}/${pass + fails.length} passed`);
if (fails.length) {
	console.log('失败：' + fails.join(' / '));
	process.exit(1);
}
