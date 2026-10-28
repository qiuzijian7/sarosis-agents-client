#!/usr/bin/env node
// check-assistant-collapse.mjs —— 「AI 助手栏」伸缩 + 「S2 一体条」一致性守卫
//
// 用户定的口径（2026-10-26）：
//   ① 助手栏收起 = `display:none`（不卸载、不收成 30px 窄条）
//   ② 展开入口（«）与「外开」（↗）合成 **S2 一体条**，只在**外壳**渲染一次 ⇒ 所有工作台自动都有
//   ③ 一体条整组可拖：<3px 算点击、落点夹在面板内且不高于 header 安全区、右键复位、位置持久化
//   ④ 工作台侧只写一个属性（`data-vssaros-assist-collapsed`）+ 监听 `vssaros:assist-expand`
//      ⇒ 不允许再各自造按钮（之前两份实现漂移过）
//
// 任何一条被改回去都必须变红。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHELL = 'dsh-plugins/vssaros-workbenches/lib/client.js';
const MARKETS = { name: '商城工作台', file: 'dsh-plugins/vssaros-marketplace/lib/workbench.js' };
const STUDIO = { name: '萨罗斯平台', file: 'dsh-plugins/vssaros-studio/lib/client.js' };

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
/** 去注释后再断言 —— 注释里写着"以前怎么做过"不该算实现。 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let failed = 0;
const fail = (msg) => { failed += 1; console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);
const ck = (msg, cond, detail) => (cond ? ok(msg) : fail(msg + (detail ? '  → ' + detail : '')));

console.log('[check-assistant-collapse] 助手栏伸缩 + S2 一体条');

// ── 1. 外壳：S2 一体条 + 拖拽 ────────────────────────────────────────
const shellSrc = read(SHELL);
const shell = strip(shellSrc);

console.log(`\n外壳  (${SHELL})`);
ck('渲染 S2 一体条容器（.vssWbActions）', /className: 'vssWbActions'/.test(shellSrc));
ck('S2 外形：3px 内边距 + 10px 圆角', /\.vssWbActions \{[^}]*padding:3px;[^}]*border-radius:10px/.test(shellSrc));
ck('S2 两段：AI 助手 + 外开', /data-vssaros-wb-assist/.test(shell) && /data-vssaros-wb-open-external/.test(shell));
ck('两段之间有分割线', /className: 'wbDivider'/.test(shell));
// ★ 2026-10-26 用户要求：助手展开后按钮变「» 收起」，不再整段消失。
//   三态：none（没有助手栏，只剩外开）/ 1（收起，« 展开）/ 0（展开，» 收起）
ck('没有助手栏时才隐藏切换按钮（data-assist="none"）',
	/\.vssWbActions\[data-assist="none"\] \.wbDivider, \.vssWbActions\[data-assist="none"\] \.wbWrapAssist \{ display:none/.test(shellSrc));
ck('展开态不再隐藏切换按钮',
	!/\.vssWbActions\[data-assist="0"\][^{]*\{ display:none/.test(shellSrc));
ck('按钮图标随状态切换（« / »）', /state === '1' \? '«' : '»'/.test(shell));
ck('hover 文案随状态切换（展开/收起）', /state === '1' \? '展开 AI 助手' : '收起 AI 助手'/.test(shell));
// ★ S4（用户要求 S2+S4 结合）：hover 时左侧滑出文字标签
ck('S4：两段各有一个文字标签', (shellSrc.match(/className: 'wbLabel'/g) || []).length === 2);
ck('S4：标签默认在左侧（right:34px）', /\.vssWbActions \.wbLabel \{[^}]*right:34px/.test(shellSrc));
ck('S4：hover 才显示（opacity 0 → 1）', /\.wbWrap:hover \.wbLabel \{ opacity:1/.test(shellSrc));
ck('S4：贴面板左边时翻到右侧', /data-label="right"\] \.wbLabel \{ right:auto; left:34px/.test(shellSrc));
ck('S4：位置变化后重算标签方向', /pointerenter/.test(shell) && /__vssSyncLabel/.test(shell));
// 一个按钮两种动作：收起时派发 expand、展开时派发 collapse
ck('按状态派发 expand / collapse 两种事件',
	/collapsedNow \? 'vssaros:assist-expand' : 'vssaros:assist-collapse'/.test(shell));
// ⚠ 2026-10-26 真机 bug：在 frame 上派发，子节点上的监听收不到（CustomEvent 只向上冒泡）
ck('事件派发到**面板根**（不是 frame）',
	/frameEl\.querySelector\('\[data-vssaros-assist-collapsed\]'\) \|\| frameEl/.test(shell));
ck('事件带 workbench id（避免多工作台串扰）', /detail: \{ workbench:/.test(shell));
ck('默认位置：右边缘垂直居中', /\.vssWbActions \{[^}]*right:12px;[^}]*top:50%/.test(shellSrc));
ck('拖拽实现唯一（attachActionsDrag）', /function attachActionsDrag\(el, frameEl\)/.test(shell));
ck('拖拽阈值 3px', /Math\.abs\(dx\) \+ Math\.abs\(dy\) < 3/.test(shell));
ck('header 安全区常量', /ACTIONS_SAFE_TOP = 30/.test(shell));
ck('落点不低于安全区', /Math\.max\(ACTIONS_SAFE_TOP/.test(shell));
ck('位置持久化（__vssarosWbActionsPos）', /ACTIONS_POS_KEY = '__vssarosWbActionsPos'/.test(shell));
ck('右键复位', /contextmenu[\s\S]{0,220}applyActionsPos\(el, null\)/.test(shell));
// ⚠ 只查 swallow 的**定义**不够：删掉它的 addEventListener 注册也算"没吞"（突变验证抓到过）
ck('拖动后吞掉那次 click（定义 + 注册）',
	/const swallow = \(e\) => \{ e\.stopPropagation\(\); e\.preventDefault\(\); \}/.test(shell)
	&& /el\.addEventListener\('click', swallow, true\)/.test(shell));
ck('跟随工作台的助手收起态（MutationObserver）', /attributeFilter: \['data-vssaros-assist-collapsed'\]/.test(shell));
ck('外开链接来自服务端现签 token', /ctx\.connection\.authenticatedUrl|requestWorkbenchLink/.test(read('dsh-plugins/vssaros-workbenches/lib/index.js') + shell));

// 禁止：外壳里不许再出现"孤立的旧外开按钮"样式
ck('没有遗留的旧外开类名（.vssWbOpenExternal）', !/vssWbOpenExternal/.test(shellSrc));

// ── 2. 工作台侧：只留属性 + 事件，不许自造按钮 ────────────────────────
for (const wb of [MARKETS, STUDIO]) {
	const src = read(wb.file);
	const code = strip(src);
	console.log(`\n${wb.name}  (${wb.file})`);
	ck('上报助手收起态（data-vssaros-assist-collapsed）', /'data-vssaros-assist-collapsed':\s*collapsed \? '1' : '0'/.test(code));
	// 必须挂在 window 上：挂在面板/子节点上收不到外壳派发的事件（真机 bug）
	// ★ 2026-10-26：外壳的按钮是"展开/收起"双态 ⇒ 工作台要同时监听两种事件
	ck('在 window 上监听 expand + collapse',
		/window\.addEventListener\('vssaros:assist-expand'/.test(code)
		&& /window\.addEventListener\('vssaros:assist-collapse'/.test(code));
	ck('按事件类型开合（!open）', /collapsedState\[1\]\(!open\)/.test(code));
	ck('校验事件里的 workbench id', /ev\.detail\.workbench/.test(code));
	/* ⚠ 2026-10-26 真机 bug「点展开没反应」：校验值写成了 `vssaros-studio`（连字符），
	   而真实 id 是 `vssaros/studio`（斜杠，由 DESCRIPTOR.repository 归一化而来）
	   ⇒ 永远不相等 ⇒ 事件被 return 丢掉。
	   所以不能只查"有没有校验"，必须**比对真实 id**。 */
	const repoMatch = src.match(/repository:\s*'(vssaros:[a-z0-9-]+)'/);
	ck('能读到 DESCRIPTOR.repository（id 的唯一来源）', !!repoMatch, repoMatch ? repoMatch[1] : '未找到');
	if (repoMatch) {
		const realId = repoMatch[1].replace(':', '/');
		ck(`监听的 id 与 repository 一致（应为 '${realId}'）`,
			code.includes(`'${realId}'`), `未出现 '${realId}'`);
		ck('id 不是连字符写法（vssaros-xxx 是错的）',
			!new RegExp(`vssaros-[a-z]+'`).test(code), '出现了 vssaros-xxx 形式的 id');
	}
	ck('不再自造展开按钮', !/data-vssaros-(studio|market)-expand/.test(code));
	ck('不再自造拖拽实现', !/function attachExpandDrag/.test(code));
	// 折叠契约（保持原样）
	ck('收起用 display:none（不卸载）', /display: collapsed \? 'none' : 'flex'/.test(code));
	ck('不收窄条：无 COLLAPSED_W 30px', !/COLLAPSED_W\s*=\s*'(28|30)px'/.test(code));
	ck('收起入口文案「» 收起」', /'» 收起'/.test(code));
	ck('宽度下限 CONV_MIN = 320', /CONV_MIN\s*=\s*320/.test(code));
	ck('拖拽条收起时隐藏', /display: collapsed \? 'none' : undefined/.test(code));
	ck('收起态不挂「＋新会话」', /if \(el && !collapsed\)/.test(code));
	// key 名两个工作台不完全一样（Studio 用 ConvCollapsed、Market 用 Collapsed），只要带工作台前缀即可
	ck('状态持久化（*Collapsed key）', /__vssaros(Studio|Market)(Conv)?Collapsed/.test(code));
}

// ── 2.5 跨插件：媒体库与工作台的浮动区**同一套样式**（2026-10-27）─────────
//   用户要求「所有工作台中的 浮动 AI助手、外开 操作区的样式保持一致」⇒ 两个插件各自带样式
//   （不能共享文件）⇒ 只能靠**断言**把两边钉在一起。
{
	console.log('\n浮动区样式一致性  (media .m-fab  ⇄  workbenches .vssWbActions)');
	const mediaCss = read('dsh-plugins/vssaros-media/lib/mediaPage.js');
	const HIGHLIGHT = ['rgba(47,129,247,.55)', '0 0 16px rgba(47,129,247,.30)', '0 0 26px rgba(47,129,247,.45)', 'rgba(47,129,247,.75)', 'rgba(47,129,247,.45)', '0 0 12px rgba(47,129,247,.55)'];
	for (const token of HIGHLIGHT) {
		ck('两边都有同一处高亮：' + token, mediaCss.includes(token) && shellSrc.includes(token), 'media=' + mediaCss.includes(token) + ' shell=' + shellSrc.includes(token));
	}
	ck('两边都是 1px 品牌蓝描边（不是灰边）', mediaCss.includes('rgba(47,129,247,.55)') && shellSrc.includes('rgba(47,129,247,.55)'));
	ck('两边都是 26px 细竖胶囊（.m-fabAct / .wbAct 同宽）', mediaCss.includes('.m-fab .m-fabAct') && mediaCss.includes('26px') && shellSrc.includes('.wbAct') && shellSrc.includes('26px'));
	// ★ 2026-10-27（定稿「方案 A」后统一文案）：两个页面的助手按钮**同一套文案** ——
	//   折叠时「展开 AI 助手」、展开后「收起 AI 助手」（媒体库侧由客户端按状态切换文案）。
	const mediaApp = read('dsh-plugins/vssaros-media/lib/mediaApp.js');
	const mediaHasBoth = mediaCss.includes('展开 AI 助手') && (mediaCss + mediaApp).includes('收起 AI 助手');
	const shellHasBoth = shellSrc.includes('展开 AI 助手') && shellSrc.includes('收起 AI 助手');
	ck('两边的助手按钮文案一致（展开 AI 助手 / 收起 AI 助手）', mediaHasBoth && shellHasBoth,
		'media=' + mediaHasBoth + ' shell=' + shellHasBoth);
	// ★ 2026-10-27（用户：「商城、萨罗斯 工作台中的 浮动工具栏 样式与 媒体库中的不一致，要求全部统一」）：
	//   媒体库的 .m-fab 与工作台的 .vssWbActions 曾各用各的**中性色令牌**（--vscode-* vs --dsw-alias-*）
	//   ⇒ IDE 里别名已定义（跟主题走）、Host 里未定义（回落深色）⇒ 两边看起来不一样 ⇒ 现在**同名同 fallback**。
	const TOKENS = ['--dsw-alias-label-secondary', '--dsw-alias-interactive-bg-hover', '--dsw-alias-label-primary', '--dsw-alias-bg-layer-1', '--dsw-alias-state-warn-primary'];
	for (const token of TOKENS) {
		ck('两边用同一套中性色令牌：' + token, mediaCss.includes(token) && shellSrc.includes(token), 'media=' + mediaCss.includes(token) + ' shell=' + shellSrc.includes(token));
	}
	ck('两边都不再用 --vscode-*（那套在 Host 里没有定义 ⇒ 回落值不同）',
		!/--vscode-/.test(mediaCss.slice(mediaCss.indexOf('.m-fab {'), mediaCss.indexOf('.m-linkbar'))));
}

// ── 3. 跨文件：文案一致 ───────────────────────────────────────────────
if (!failed) {
	const labels = [MARKETS, STUDIO].map((wb) => (read(wb.file).match(/'»\s*收起'/) || [''])[0].replace(/\s+/g, ''));
	if (new Set(labels).size !== 1) { fail(`收起文案不一致：${labels.join(' / ')}`); }
	else { console.log(`\n✓ 两个工作台文案一致：${labels[0]}`); }
}

// ── 4. 浮动区 CSS 结构（2026-10-27 真实事故）─────────────────────────────
//   事故：.vssWbActions:hover 少一个右花括号 ⇒ 其后所有后代规则被吞 ⇒ 外框新样式、子项裸 HTML（文字常显/被右边缘裁掉）。
{
	console.log('\n浮动区 CSS 结构（花括号配平）');
	const regions = [
		[shellSrc, 'const CSS = `', 'workbenches .vssWbActions'],
		[read('dsh-plugins/vssaros-media/lib/mediaPage.js'), 'export const MEDIA_CSS = `', 'media .m-fab'],
	];
	for (const r of regions) {
		const src = r[0], mark = r[1], label = r[2];
		const i = src.indexOf(mark);
		const j = i < 0 ? -1 : src.indexOf(String.fromCharCode(96) + ';', i + mark.length);
		if (i < 0 || j < 0) { ck(label + '：找得到 CSS 模板', false); continue; }
		const css = src.slice(i + mark.length, j);
		const open = (css.match(/{/g) || []).length, close = (css.match(/}/g) || []).length;
		ck(label + '：花括号配平（{ 数 = } 数）', open === close, '{ =' + open + ' } =' + close);
	}
}

// ── 5. 工作台面板契约（2026-10-28 媒体库 + 商城）──────────────────────────
//   ① 面板守卫**只由外壳一处负责**：业务插件不许再包 layout.selectPanel / uiWorkspace.openSession
//      （真机教训：业务插件那层「前台时 selectPanel(null) 直接 return」装在外壳守卫外面，
//        把 null 吞掉不往下传 ⇒ 外壳"拦下后停靠会话"永远执行不到 ⇒ 点会话 / 新建会话都没反应）
//   ② 外壳拦下 selectPanel(null) 时必须"接住"（showSession），且不能拿 sessionExists 做前置
//      （新建会话此刻还没进 sessions.list 快照 ⇒ 会被误判已不存在）
//   ③ newSession 必须**链式**包 —— 不允许再出现「已被包过就放弃」的守卫
{
	console.log('\n工作台面板契约');
	const mediaClient = read('dsh-plugins/vssaros-media/lib/client.js');
	const marketClient = read('dsh-plugins/vssaros-marketplace/lib/workbench.js');
	const patchesPanel = (src) => /layout\.selectPanel\s*=|ws\.openSession\s*=/.test(src);
	ck('媒体库：不再自己包 selectPanel / openSession（只由外壳负责）', !patchesPanel(mediaClient));
	ck('商城：不再自己包 selectPanel / openSession（只由外壳负责）', !patchesPanel(marketClient));
	ck('两边都不再用「已被包过就放弃」的 newSession 守卫',
		!/if \(dw\.newSession !== orig(NewSession)?\) \{ return; \}/.test(mediaClient + marketClient));
	ck('两边的 preset 补丁都受前台标志保护',
		mediaClient.includes('__vssarosMediaActive') && marketClient.includes('__vssarosMarketActive'));
	ck('外壳：拦下 selectPanel(null) 时必须把会话停靠进对话列（不能只拦不接）',
		/service\.showSession\(sid\)/.test(shellSrc));
	ck('外壳：目标会话优先取 uiWorkspace.mainReference（新建会话只有它有）',
		/uiWorkspace\.mainReference/.test(shellSrc));
	const guardStart = shellSrc.indexOf('const guarded = (panel) =>');
	const guardBody = guardStart < 0 ? '' : shellSrc.slice(guardStart, shellSrc.indexOf('guarded.__vssarosGuarded', guardStart));
	ck('外壳：selectPanel 守卫里不拿 sessionExists 做前置（会误杀新建会话）',
		guardBody.length > 0 && !/sessionExists\(/.test(guardBody));
}

	// ★ 2026-10-28：外壳 chunk 带**构建标记**（globalThis.__vssarosWorkbenchBuild），
	//   与 package.json 版本必须一致 ⇒ 用户在窗口 console 里输 __vssarosWorkbenchBuild
	//   就能 10 秒判断「窗口里跑的是不是新版」（undefined / 旧值 = 视图没重载）。
	const wbVersion = JSON.parse(read('dsh-plugins/vssaros-workbenches/package.json')).version;
	ck('外壳：构建标记与 package.json 版本一致（__vssarosWorkbenchBuild = ' + wbVersion + '）',
		shellSrc.includes('__vssarosWorkbenchBuild = \'' + wbVersion + '\''));
	// ★ 2026-10-28（用户：「打开商城工作台后点左侧栏顶部的新建会话，没有任何反应」）：
	//   侧栏新建会话 = startSession → openWorkspaceSession → replaceMain(…,'reveal') → selectPanel(null)，
	//   外壳守卫会把它停靠进对话列；但如果那一列当时是**收起**的，用户依然看不到任何变化。
	//   ⇒ 外壳必须在停靠后**自动展开**（派发 vssaros:assist-expand）。
	ck('外壳：停靠会话后自动展开收起的对话列（否则新建会话"没反应"）',
		/assist-expand/.test(shellSrc) && /data-vssaros-assist-collapsed=\"1\"/.test(shellSrc));
	// ★ 2026-10-28（用户：「点工作区左侧会话 item 时，要求切换到会话页进行展示」）：
	//   侧栏导航（openSession / startSession）必须**放行** selectPanel(null) ⇒ 中栏切到会话页；
	//   只有工作台**内部**的切会话（不走这两个入口）才拦下来停靠。
	ck('外壳：侧栏导航放行 selectPanel(null)（切到会话页）',
		/navIntentAt/.test(shellSrc) && /Date\.now\(\) - navIntentAt/.test(shellSrc));
	ck('外壳：openSession 与 startSession 都打上「用户导航」时间戳',
		/markUserNav\(\)/.test(shellSrc) && /startSession nav/.test(shellSrc));
	// ★ 2026-10-28（用户：「浮动工具栏仅可以在 app 最右侧上下移动」）：
	//   拖拽与夹取都必须把 x 钉在 maxL（最右），只有 y 变。
	ck('浮动条只能上下：拖拽与夹取都把 x 钉在最右（maxL - 12）',
		(shellSrc.match(/x: Math\.max\(0, maxL - ACTIONS_RIGHT_GAP\)/g) || []).length >= 2);
	// ★ 2026-10-28（用户：「知识库中的浮动工具栏中，缺少 ai 助手」）：
	//   没有页内对话列（页面型工作台）时也要显示 AI 助手按钮，且点击要能兜底开会话。
	ck('浮动条：无对话列时也显示 AI 助手按钮',
		/!host \? '1'/.test(shellSrc));
	ck('浮动条：无页面桥时用 startSession 兜底开助手会话',
		/startSession\(undefined, preset/.test(shellSrc));
	// ★ 2026-10-28（用户：「知识库的展开 AI 助手点不动，展开后应显示知识库专家」）：
	//   知识库是页面型工作台（面板无对话列）⇒ 点击只能靠外壳兜底开会话，兜底**必须带 preset**
	//   （空 preset 的 newChat 等于空转）。知识库专家 = 内置 agent knowledge-base-expert。
	ck('外壳：知识库 preset 映射到知识库专家（vssaros-knowledge-base-expert）',
		/vssaros\/kb': 'vssaros-knowledge-base-expert'/.test(shellSrc));
	// ★ 2026-10-28（用户第二次报「点展开没反应」）：兜底必须**优先用 startSession**
	//   （同步切到会话页，行为可预期）；页面桥只当退路 —— 它在桌面窗口里可能"成功但开在后台"。
	{
		const iStart = shellSrc.indexOf('ws.startSession(undefined, preset');
		const iBridge = shellSrc.indexOf('bridge.newChat(preset)', iStart);
		ck('外壳：点展开优先 startSession 开会话，页面桥只当退路',
			iStart >= 0 && iBridge > iStart);
	}
console.log(failed ? `\n[check-assistant-collapse] ✗ ${failed} 项不通过` : '\n[check-assistant-collapse] ✓ 通过');
process.exit(failed ? 1 : 0);
