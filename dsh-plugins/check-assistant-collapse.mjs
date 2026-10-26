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

// ── 3. 跨文件：文案一致 ───────────────────────────────────────────────
if (!failed) {
	const labels = [MARKETS, STUDIO].map((wb) => (read(wb.file).match(/'»\s*收起'/) || [''])[0].replace(/\s+/g, ''));
	if (new Set(labels).size !== 1) { fail(`收起文案不一致：${labels.join(' / ')}`); }
	else { console.log(`\n✓ 两个工作台文案一致：${labels[0]}`); }
}

console.log(failed ? `\n[check-assistant-collapse] ✗ ${failed} 项不通过` : '\n[check-assistant-collapse] ✓ 通过');
process.exit(failed ? 1 : 0);
