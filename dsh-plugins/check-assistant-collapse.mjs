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
// ★ 2026-11-02（用户报「知识库 工作台未显示浮动工具栏」）：
//   位置存的是**绝对像素**且全局共用一个 key，只在挂载时夹一次 ⇒ 窗口 / 分栏尺寸一变就飘到面板外，
//   表现就是"工具栏凭空消失"。三条必须同时在场，缺一条这个 bug 就会回来。
ck('位置恢复：面板还没尺寸（页签未激活）时先不恢复',
	/fr\.width <= 0 \|\| fr\.height <= 0/.test(shellSrc) && /function restoreActionsPos\(/.test(shellSrc));
ck('位置恢复：尺寸变化后重新夹回面板内（ResizeObserver）',
	/new ResizeObserver\(/.test(shellSrc) && /applyActionsPos\(el, clampActions\(el, frameEl, el\.__vssPos\)\)/.test(shellSrc));
ck('复位逃生门：__vssarosResetWorkbenchActions（位置飘走后可一键拉回）',
	/window\.__vssarosResetWorkbenchActions = resetAllActions/.test(shellSrc));
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
	// ★ 2026-11-02（用户：「AI 助手侧边栏左上角不要有收起按钮」「右上角加 +新会话」）：
	//   对话栏顶部的两个按钮**不再由各工作台自画**：「＋ 新会话」由宿主对话栏统一提供，收起/展开走右侧浮动工具栏。
	ck('左上角不再自画「» 收起」（收起统一走浮动工具栏）', !/'» 收起'/.test(code) && !/data-vssaros-(studio|market)-collapse/.test(code));
	ck('不再自画「＋ 新会话」（宿主对话栏统一提供）', !/mountNewButton/.test(code) && !/＋ ?新会话/.test(code) && !/neww/.test(code));
	ck('宽度下限 CONV_MIN = 320', /CONV_MIN\s*=\s*320/.test(code));
	ck('拖拽条收起时隐藏', /display: collapsed \? 'none' : undefined/.test(code));
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

// ── 2.6 媒体库工具条：窄窗口不许把按钮挤成竖排（2026-11-02）─────────────────────
//   用户报「窗口大小不足时 UI 布局不合理」：4 个动作按钮和筛选 chips 抢同一条 overflow-x:auto 的行，
//   而 .m-btn 没有 flex:0 0 auto / nowrap ⇒ 被压到 41~45px 宽、中文逐字换行，堆成 65~94px 高的竖排文字。
//   实测容器 1100（中栏只有 ~608px）就有 182px 溢出 ⇒ 这不是"极小窗口"才有的问题。
//   口径：筛选区自己换行 / 动作组不收缩（窄了只留图标）/ 顶栏只有面包屑当弹性项。
{
	console.log('\n媒体库工具条（窄窗口不许把按钮挤成竖排）');
	const page = read('dsh-plugins/vssaros-media/lib/mediaPage.js');
	const css = strip(page);
	ck('.m-btn 不折行（white-space: nowrap）', /\.m-btn \{[^}]*white-space:\s*nowrap/.test(css));
	ck('筛选行允许换行（.m-chips flex-wrap: wrap）', /\.m-chips \{[^}]*flex-wrap:\s*wrap/.test(css));
	ck('筛选区自己去换行（.m-filters display:flex + flex-wrap）', /\.m-filters \{[^}]*flex-wrap:\s*wrap/.test(css));
	ck('动作组不参与收缩（.m-actions flex: 0 0 auto）', /\.m-actions \{[^}]*flex:\s*0 0 auto/.test(css));
	ck('动作组里的按钮不参与收缩（flex: 0 0 auto）', /\.m-actions \.m-btn \{[^}]*flex:\s*0 0 auto/.test(css));
	ck('顶栏只有面包屑可收缩（.m-top .m-crumb flex: 1 1 0）', /\.m-top \.m-crumb \{[^}]*flex:\s*1 1 0/.test(css));
	ck('状态栏左右两段各自成组（放不下整体换行）', /\.m-stat-left, \.m-stat-right \{/.test(css));
	ck('≤900 动作按钮只留图标 + title（.lbl 隐藏）',
		/@media \(max-width: 900px\) \{\s*\/\*[^*]*\*\/\s*\.m-actions \.m-btn \.lbl \{ display: none; \}/.test(css)
		|| /@media \(max-width: 900px\) \{[\s\S]{0,260}\.m-actions \.m-btn \.lbl \{ display: none;/.test(css));
	ck('≤760 类型 chip 只留字形（.m-chip .lbl 隐藏）', /@media \(max-width: 760px\) \{[\s\S]{0,200}\.m-chips \.m-chip \.lbl \{ display: none/.test(css));
	ck('「在编辑区打开」宽了收起（≥620 隐藏，锚点仍在）',
		/@media \(min-width: 620px\) \{[\s\S]{0,120}\[data-vssaros-media-open\] \{ display: none/.test(css)
		&& /data-vssaros-media-open/.test(page));
	// 抽出来的小节要被 mockup 生成器找到（否则 doc/media-library-responsive 立刻失效）
	ck('「窄窗口：工具条两段式」小节标记还在（mockup 抽它当 B 档）', /\/\* ── 窄窗口：工具条两段式/.test(page));
	ck('markup 里两个分组容器都在（.m-filters / .m-actions）', /class="m-filters"/.test(page) && /class="m-actions"/.test(page));
	ck('分隔线类名是 .m-vsep（2026-11-02 修掉的 .vsep 笔误）', /class="m-vsep"/.test(page) && !/class="vsep"/.test(page));
}

// ── 3. AI 助手栏顶部：**统一由宿主提供**（2026-11-02）────────────────────────────
// 用户要求：所有工作台的 AI 助手栏 ① 右上角有「＋ 新会话」② 左上角没有收起按钮 ③ 聊天框默认就是该工作台对应的 agent。
// 之前商城、萨罗斯各自画了一套（还各带一个左上角「» 收起」），其余工作台一个都没有 ⇒ 口径不一、并行改一处漏一处。
// 现在只有宿主对话栏（ConversationMount / SplitConversationPane）这**一份**实现，守卫钉住它、也钉住「别处不许再画」。
{
	console.log('\nAI 助手栏顶部（宿主统一：右上角「＋ 新会话」、左上角无收起、默认 agent）');
	const sliceAfter = (marker, len) => { const i = shellSrc.indexOf(marker); return i < 0 ? '' : shellSrc.slice(i, i + len); };
	ck('宿主有 NewSessionButton，文案「＋ 新会话」',
		/function NewSessionButton\(/.test(shellSrc) && /'＋ 新会话'/.test(shell));
	ck('整页工作台的对话栏（ConversationMount）挂了它',
		/h\(NewSessionButton, \{ service, entry \}\)/.test(sliceAfter('function ConversationMount(', 900)));
	ck('标准分栏的对话栏（SplitConversationPane）也挂了它',
		/h\(NewSessionButton, \{ service, entry \}\)/.test(sliceAfter('function SplitConversationPane(', 900)));
	ck('按钮在对话栏**右上角**（right + top，没有 left）',
		/\.vssWbNewSession \{[^}]*position:absolute;[^}]*right:10px;[^}]*top:5px/.test(shellSrc) && !/\.vssWbNewSession \{[^}]*[;{ ]left:/.test(shellSrc));
	ck('对话栏是定位上下文（否则按钮以更外层为基准飘走）',
		/\.vssWbDockHost \{ position:relative;/.test(shellSrc) && /\.vssWbSplitConversation \{ position:relative;/.test(shellSrc));
	ck('宿主不在对话栏里放收起按钮（收起统一走浮动工具栏）', !/vssWbCollapse|data-vssaros-wb-collapse/.test(shellSrc));
	// 大型工作台首次打开慢（2026-11-02 用户要求）：外框给一层加载态，且不能盖住浮动胶囊
	ck('工作台有加载态（方案 D），且层级低于浮动胶囊',
		/function PanelLoadingGate\(/.test(shell) && /data-vssaros-wb-loading/.test(shellSrc)
		&& /\.vssWbLoading \{ position:absolute; inset:0; z-index:6;/.test(shellSrc)
		&& /\.vssWbActions \{[^}]*z-index:2147482000/.test(shellSrc)
		&& /正在加载 · /.test(shellSrc));
	ck('加载态有最短显示时长（缓存命中时不闪）', /Math\.max\(0, 120 -/.test(shell));
	// 用户 2026-11-02：「记忆库不应该有浮动工具栏」⇒ 与 scheduler / loop 同一机制（描述符 + 清单都要声明）
	{
		const memSrc = read('dsh-plugins/vssaros-memory/lib/client.memory.js');
		const memPkg = JSON.parse(read('dsh-plugins/vssaros-memory/package.json'));
		ck('记忆库声明 floatingActions:false（描述符与清单同值）',
			/floatingActions: false/.test(memSrc) && memPkg.vssaros.workbench.floatingActions === false);
	}
	// 真机「未生效」：同 id 的 <style> 已存在时旧实现直接 return ⇒ 新规则永远写不进去，加载态退化成裸文字
	ck('样式注入会**更新**已有 <style>（不是见到同 id 就跳过）',
		/if \(el\.textContent !== CSS\)/.test(shell) && !/if \(document\.getElementById\(STYLE_ID\)\) \{ return undefined; \}/.test(shell));
	// ★★ 2026-11-02 根治（用户：「不同工作台中聊天框的 agent 使用不当，多轮修复始终反复出错」）：
	//   五个叠加根因：①5 个写入者（宿主 + kb/商城/媒体库/萨罗斯各自 select、各自包 newSession、萨罗斯还劫持官方「新会话」）
	//   ②插件改的是**全局当前会话**，页签条同时挂着多个工作台 ⇒ 互相改对方的 ③vssaros-agents 是 lazy 注册，开机 ~15s 里
	//   自定义 preset 不存在 ④connectBlank(ws,{agentPreset}) 复用工作区里现成的空会话 ⇒ 多个工作台抢同一条（又逼出"借用"）
	//   ⑤select 不存在的 id 会把会话弄坏（之后 resume 报 Unknown agent preset）。下面逐条钉死。
	ck('新会话 = 建一条**自己的**会话（sessions.create），**不走** connectBlank（它会复用别人的空会话）',
		/async createOwnSession\(workspace, preset\)/.test(shell) && /this\.createOwnSession\(workspace, preset\)/.test(shell)
		&& !/\.connectBlank\(/.test(shell));
	ck('不再有「借用」别的工作台的会话（每个工作台独占自己的会话）',
		!/borrowSession|this\.borrowed\b/.test(shell));
	ck('会话归属不可改（服务端 validateState 会拒；空会话也不例外）',
		/prev !== owner\) \{ throw new Error\('此会话已属于另一个工作台/.test(shell) && !/isBlankSession/.test(shell));
	// ⚠ 要匹配**调用点**：只写 `diagnoseDock\(…\)` 会连方法定义本身一起匹配，把调用删掉也照样绿（反向突变当场抓到的）。
	ck('停靠时诊断「会话不属于任何工作区」，并带上**是哪个工作台**（不读全局前台）',
		/service\.diagnoseDock\(presetOwner, sessionId\)/.test(shellSrc) && /停靠会话不属于任何工作区/.test(shellSrc));
	ck('自愈：给**传入的那个工作台**建自己的新会话（只救空会话、每工作台只救一次、不读 this.active）',
		/this\.healDock\(owner, state\.summary\)/.test(shell) && /healDock\(owner, summary\) \{/.test(shell)
		&& /summary\.blank !== true\) \{ return; \}/.test(shell) && /this\.dockHealed\.has\(owner\)/.test(shell)
		&& !/healDock\([^)]*\) \{\s*const owner = this\.active/.test(shell));
	// 真机截图：商城 chip 写 Saros-agents-pocket，用户当前工作区是 sarosis-agents-client ⇒ 名字与根目录对不上
	ck('新会话默认建在**用户当前工作区**（主视图会话所在工作区优先）',
		/\.mainView \|\| 0\) > 0/.test(shell) && /fromMain/.test(shell) && /if \(fromMain\) \{ return fromMain; \}/.test(shell));
	// 默认 agent
	ck('新会话出生就带 agentPreset（比事后 select 可靠）', /sessions\.create\(\{ workspaceId: workspace, agentPreset: preset \}\)/.test(shell));
	ck('preset 被拒时退回不带 preset 的建法（不能因此建不出会话）', /退回默认/.test(shellSrc) && /sessions\.create\(\{ workspaceId: workspace \}\)/.test(shell));
	ck('**绝不猜** preset：只用 agentPresets.list() 里真实存在的；读不到列表 ⇒ 不指定',
		/candidates\.find\(c => roster\.has\(c\)\)/.test(shell) && /if \(!svc \|\| typeof svc\.list !== 'function'\) \{ return null; \}/.test(shell)
		&& !/碰运气|candidates\[0\];/.test(shell));
	ck('**等注册**（lazy 窗口）：readyPreset 带 waitMs 轮询，事后补套时用 presetWaitMs',
		/async readyPreset\(id, \{ waitMs = 0 \} = \{\}\)/.test(shell) && /this\.readyPreset\(owner, \{ waitMs: this\.presetWaitMs \}\)/.test(shell)
		&& /this\.presetWaitMs = 30000;/.test(shell));
	ck('事后套用**只改这个工作台此刻显示**的那条（不是全局当前会话）',
		/const stillOurs = \(\) => this\.sessionShownIn\(owner\) === sessionId && !!this\.state && this\.state\.sessionBindings\[sessionId\] === owner;/.test(shell)
		&& /if \(!stillOurs\(\)\) \{ return; \}/.test(shell));
	ck('事后套用只动 blank、每条只套一次、等待期间被改过就尊重',
		/if \(!summary \|\| summary\.blank !== true\) \{ return; \}/.test(shell) && /presetApplied\.has\(key\)/.test(shell)
		&& /presetApplied\.add\(key\)/.test(shell) && /if \(current !== before\) \{ return; \}/.test(shell));
	ck('select 失败看 ok（官方失败返回 {ok:false}，不抛）', /result && result\.ok === false/.test(shell) && /套用默认 agent 被拒/.test(shellSrc));
	ck('默认 agent 服务走 ctx.inject 可选注入（不是硬依赖）',
		/ctx\.inject\(\['remote\.agentPresets'\]/.test(shell) && !/module\.exports\.inject = \[[^\]]*agentPresets/.test(shell));
	ck('页面型兜底开助手会话也只用真实存在的 preset（readyPreset）',
		/Promise\.resolve\(service\.readyPreset\(entry\.id\)\)/.test(shell) && !/assistantPresetOf\(/.test(shell));
	// 工作台 → agent 的对应表（内置，全仓唯一）
	const PRESETS = [['vssaros/marketplace', 'vssaros-marketplace-bot'], ['vssaros/media', 'vssaros-media-librarian'], ['vssaros/studio', 'vssaros-saroasis-studio']];
	for (const [wb, preset] of PRESETS) {
		ck(`${wb} 默认 agent = ${preset}`, new RegExp(`'${wb}':\\s*'${preset}'`).test(shellSrc));
	}
	ck('vssaros/kb 默认 agent 是候选列表（kb-expert / knowledge-base-expert，同名「知识库专家」在不同环境 id 不同）',
		/'vssaros\/kb':\s*\[\s*'vssaros-kb-expert',\s*'vssaros-knowledge-base-expert'\s*\]/.test(shellSrc));
	// 别处不许再画（扫所有插件的客户端代码；宿主自己除外）
	const walk = (dir, out = []) => {
		for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'test') { continue; }
			const rel = `${dir}/${entry.name}`;
			if (entry.isDirectory()) { walk(rel, out); }
			else if (/^(?:client.*|workbench|mediaApp)\.js$/.test(entry.name)) { out.push(rel); }
		}
		return out;
	};
	const offenders = [];
	for (const rel of walk('dsh-plugins')) {
		if (rel === SHELL) { continue; }
		const code = strip(read(rel));
		if (/['"`]＋ ?新会话['"`]/.test(code)) { offenders.push(`${rel}（自画「＋ 新会话」）`); }
		if (/['"`]» 收起['"`]/.test(code)) { offenders.push(`${rel}（自画「» 收起」）`); }
	}
	ck('除宿主外，没有任何工作台自画「＋ 新会话」/「» 收起」', offenders.length === 0, offenders.join('、'));

	// ★★ 唯一写入者（2026-11-02 根治）：除宿主外，插件客户端代码里**不许**有改 agent 的写入点。
	//   以前 kb / 商城 / 媒体库 / 萨罗斯各写一套，对全局当前会话 select、各自包 newSession、萨罗斯还劫持官方「新会话」，
	//   每轮只修一个，其余照跑 ⇒「修好又坏」。下面的白名单只放**用户显式意图**的入口（不碰工作台会话），新增必须写理由。
	const WRITER_ALLOW = {
		'dsh-plugins/vssaros-chat-surface/lib/client.preset.js': '用户在模式选择器里**手动**切 agent（用户意图，本来就该改）',
		'dsh-plugins/vssaros-chat-surface/lib/client.workspaces.js': 'Bots 侧栏：用户点某个 bot ⇒ 新建一条和它聊的主视图会话（不碰工作台会话）',
		'dsh-plugins/vssaros-agents/lib/client.agents.js': 'Bots 工作台：用户点某个 bot ⇒ 新建一条和它聊的会话（不碰工作台会话）',
	};
	const WRITER_PATS = [
		[/agentPresets[\s\S]{0,4}\.select\(|\.select\(\s*(sid|sessionId)\s*,|svc\[name\]\(/, 'select(会话, preset)'],
		[/dw\.newSession\s*=|\.newSession\s*=\s*(patched|function)/, '包 dw.newSession'],
		[/!==\s*'新会话'|===\s*'新会话'/, '劫持官方「新会话」按钮'],
		[/[{,]\s*agentPreset\s*:/, '带 agentPreset 建会话'],
		[/__vssaros(Kb|Market|Media|Studio)Preset\b/, '自己的 preset 诊断（= 自己在设 preset）'],
	];
	const writers = [];
	for (const rel of walk('dsh-plugins')) {
		if (rel === SHELL || WRITER_ALLOW[rel]) { continue; }
		const lines = strip(read(rel)).split(/\r?\n/);
		lines.forEach((line, i) => {
			for (const [re, label] of WRITER_PATS) { if (re.test(line)) { writers.push(`${rel}:${i + 1}（${label}）`); } }
		});
	}
	ck('除宿主外，没有任何插件在改工作台会话的 agent（select / 包 newSession / 劫持「新会话」/ 带 preset 建会话）',
		writers.length === 0, writers.slice(0, 6).join('、'));
	for (const rel of Object.keys(WRITER_ALLOW)) {
		ck(`白名单条目仍然存在（${rel.split('/').slice(-3).join('/')}）——不存在就删掉这条，别让白名单过期`, fs.existsSync(path.join(ROOT, rel)));
	}
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
	// ★ 2026-11-02 根治：两边的 preset 补丁（和它们用的前台标志）已整体删除 —— 默认 agent 只由宿主设。
	ck('两边都不再有自己的 preset 补丁 / 前台标志（默认 agent 只由宿主设）',
		!/__vssarosMediaActive|__vssarosMarketActive|MEDIA_PRESET|MARKET_PRESET/.test(strip(mediaClient) + strip(marketClient)));
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
	// ★ 2026-11-02：知识库现在是**候选列表**（['vssaros-kb-expert', 'vssaros-knowledge-base-expert']）——
	//   同一个「知识库专家」在内置目录里叫 knowledge-base-expert、在用户数据根里叫 kb-expert。
	//   两个都要在，实际用哪个由 agentPresets.list() 决定。
	ck('外壳：知识库 preset 映射到知识库专家（候选含 vssaros-knowledge-base-expert 与 vssaros-kb-expert）',
		/vssaros\/kb': \[[^\]]*'vssaros-knowledge-base-expert'[^\]]*\]/.test(shellSrc) && /vssaros\/kb': \[[^\]]*'vssaros-kb-expert'[^\]]*\]/.test(shellSrc));
	// ★ 2026-10-28（用户第二次报「点展开没反应」）：兜底必须**优先用 startSession**
	//   （同步切到会话页，行为可预期）；页面桥只当退路 —— 它在桌面窗口里可能"成功但开在后台"。
	{
		const iStart = shellSrc.indexOf('ws.startSession(undefined, preset');
		const iBridge = shellSrc.indexOf('bridge.newChat(preset)', iStart);
		ck('外壳：点展开优先 startSession 开会话，页面桥只当退路',
			iStart >= 0 && iBridge > iStart);
	}
// ── 5. 类名所有权：`.vssWbActions` **只属于宿主**（2026-11-02 用户报「浮动工具栏功能丢失」）──
// 事故：商城把卡片底部按钮行也写成 `className: "vssWbActions"` ⇒ 宿主的
//   `.vssWbActions { position:absolute; right:12px; top:50%; z-index:2147482000; … }` 把它命中，
//   每张卡片的按钮行变成绝对定位的浮动块，并与真正的胶囊**同名同位**互相覆盖
//   ⇒ 用户看到的是「浮动工具栏没了 / 点了没反应」。
// 媒体库早前也踩过同类（两条浮动区重叠），可见这类撞名会反复发生 ⇒ 用守卫钉住所有权。
{
	console.log('\n类名所有权  (.vssWbActions 只许宿主定义)');
	const HOST = 'dsh-plugins/vssaros-workbenches/lib/client.js';
	/**
	 * 允许出现的例外：**现在没有，也不该有**。
	 *
	 * ★ 2026-11-02 事故：这里曾给 `vssaros-agents` 开过白名单（用户要求 Bots 不要浮动工具栏，
	 *   它用一条全局 `.vssWbActions { display:none !important }` 实现）。那条规则作用于**整个 document**
	 *   （所有插件的客户端 chunk 启动即加载，不是「只在 Bots 页面加载」）⇒ 所有工作台的浮动工具栏都被藏掉，
	 *   用户连报「知识库 / 商城 / 媒体库都没有」。白名单就是放行它的口子。
	 *   「某个工作台不要浮动工具栏」只有一条正路：描述符声明 `floatingActions: false`。
	 */
	const ALLOW = {};
	const walk = (dir, out = []) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === 'node_modules' || entry.name === 'vendor') { continue; }
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) { walk(full, out); }
			else if (/\.(?:m|c)?js$/.test(entry.name)) { out.push(full); }
		}
		return out;
	};
	const offenders = [];
	for (const file of walk(path.join(ROOT, 'dsh-plugins'))) {
		const rel = path.relative(ROOT, file).replace(/\\/g, '/');
		// 守卫脚本自身会提到这个类名（断言文本），跳过
		if (/^dsh-plugins\/(check-|test\/)/.test(rel) || /\/test\//.test(rel)) { continue; }
		if (rel === HOST || ALLOW[rel]) { continue; }
		const code = strip(read(rel));
		// 「定义样式」或「用作自己的 className」都算侵占（只提到类名做断言/注释不算）
		const defines = /\.vssWbActions\s*\{/.test(code);
		const uses = /className:\s*["']vssWbActions["']/.test(code);
		if (defines || uses) { offenders.push(rel + (defines ? '（定义了样式）' : '（用了这个 className）')); }
	}
	ck('除宿主外没有任何插件定义/使用 .vssWbActions', offenders.length === 0, offenders.join('、'));
	// 商城改用了独立类名 ⇒ 钉住，防止改回去
	const marketSrc = read('dsh-plugins/vssaros-chat-surface/lib/client.market.js');
	ck('商城卡片按钮行用独立类名 vssWbCardActions（不复用宿主胶囊类名）',
		/\.vssWbCardActions\s*\{/.test(marketSrc) && /className:\s*"vssWbCardActions"/.test(marketSrc));
}

console.log(failed ? `\n[check-assistant-collapse] ✗ ${failed} 项不通过` : '\n[check-assistant-collapse] ✓ 通过');
process.exit(failed ? 1 : 0);
