// @vssaros/dsh-agents — host half：把 VsSaros 的 `.agent.md` 注册成 dsh agent preset + 只读花名册页。
//
// **本包有三种挂载形态**（同一个包、三种 config；判据 = `config.persona` / `config.toolsOnly`）：
//   1. 顶层行（`cordis.patch.yml` 那一行）：扫 `~/.vssaros/agents/*/.agent.md` → `ctx.agentPresets.register()`
//      注册成 preset；提供只读页面 `/x/agents`；注册四个生命周期工具（`lib/tools.js`，带 `hostHalf` 闸）。
//      **不注册提示词 section**。
//   2. preset 内的行（本模块为每个 agent 合成的 preset 的 `plugins` 里那一行，`config.persona` = 该 agent
//      的 Markdown 正文）：只把这段人设注册成一条系统提示词 section。**不注册 preset、不开页面、不挂工具**。
//   3. preset 内的"只挂工具"行（`preset-vssaros.rows.yml` 里那一行，`config.toolsOnly: true`）：
//      只注册四个生命周期工具（无 hostHalf 闸——它管的是 host 面）。**不注册 preset、不开页面**。
//
// 状态是**每次 apply 一份**（闭包），不是模块级：同一个包里两次挂载（含 preset 内那次）不能互相看到对方
// 的注册表——模块级状态会让第二次挂载误判"已经注册过了"而整片不注册（实测踩过）。
//
// 静态 `inject` 只有 `tools`（见下方 export 的注释：可选注入会错过回合组装，真机实测 ✗）；
// 其余服务（`agentPresets` / `systemPrompt` / `webServer`+`connection` / `sessionController` /
// `sessionQuery` / `agents` / `sessionProjections`）仍是**可选注入**——写进静态 inject 会让插件
// 在缺该服务的组合里永久 pending（历史教训 ✓）。
//
// **会话内人格热切换**（2026-10-11，规范依据见 poc/dsh-p0/README.md 4.38）：
//   人格是提示词内容（会话内可变），preset 身份（工具/模型/skills）首回合后锁定——两者严格分开。
//   切换 = 往该会话的 durable inbox 注入一条 user 消息（`agent/inject` → 事件 `agent/inbox/spliced`），
//   投影 `vssaros-persona` 从该事件 fold 出"当前人格"，人设段的**函数形式**下一次装配时即取新值。
//   人格全文随消息落日志，所以历史可精确重放；工具/模型**不受影响**（要换能力只能新建会话，走 preset）。

import { randomUUID } from 'node:crypto';
import { avatarColorOf, presetIdOf, summarizeAgents, toPresetDefinition } from './core/agents.js';
import { aggregateByPreset, liveForAgents, usageByAgent } from './core/live.js';
import { PERSONA_PROJECTION_KEY, personaProjection, personaSwitchMessage, switchedPersonaText } from './core/persona.js';
import { readLiveSessions } from './live.js';
import { installRelay } from './relay.js';
import { agentsRootOf, scanAgents } from './store.js';
import { registerAgentTools } from './tools.js';

/** 与 cordis.patch.yml 的行 id 一致。 */
export const name = 'vssaros-agents';

// 静态 inject 只收 `tools`（kanban/dashboard 同口径 ✓——工具模块的既定写法：工具在任何能跑回合的
// 模板里都存在，缺它的 profile 本就跑不了回合 ✓）。其余服务仍是可选注入（见头注释）。
// ⚠ 订正一处曾经的错误归因（2026-10-13，p3-55）：本插件工具一度在真机"unknown tool"，当时猜是
//   "可选注入错过回合组装" ✗——真根因是**工具缺 `output.render`**，dsh-tools 的 register 强制校验
//   把 apply 整个抛掉 ✓（见 tools.js 的 textOutput 注释）。静态 inject 保留是因为它是对齐口径，
//   不是因为时序。
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/agents';
/** 人设 section 名（在 preset 自己的作用域内唯一即可）。 */
const PERSONA_SECTION_NAME = 'vssaros-agent-persona';
/** 人设 section 的位置：dsh 有中央 order 表，`DEPLOYMENT_PERSONA_PREFIX` 就是"部署级人设"该待的位置。 */
const PERSONA_ORDER_NAME = 'DEPLOYMENT_PERSONA_PREFIX';

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** dsh 的 section order 由中央表分配（`getSectionOrder`）；拿不到就退回 0。 */
function sectionOrderOf(child) {
	try {
		const order = child.systemPrompt.getSectionOrder(PERSONA_ORDER_NAME);
		return Number.isFinite(order) ? order : 0;
	} catch {
		return 0;
	}
}

/** 角色 2：preset 内的人设注入 + 工具 allowlist（无状态、无页面）。 */
function applyPersona(ctx, config) {
	const staticPersona = String(config.persona);
	/** 会话投影服务（装配时读当前人格；未注入则退回 preset 自带人设）。 */
	let projections;
	// 人设段的动态文本要读投影，而 section 必须注册在 **preset 作用域**（作用域遮蔽才是 dsh 的覆盖机制），
	// 所以这里也注册一份投影：同 key + 同 stateVersion 的 register 是 ref-count 共享，不会建重复单元。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		projections = child.sessionProjections;
		child.sessionProjections.register(personaProjection());
		return () => {
			projections = undefined;
		};
	}));
	ctx.inject(['systemPrompt'], child => child.effect(() => child.systemPrompt.section({
		name: PERSONA_SECTION_NAME,
		order: sectionOrderOf(child),
		// **函数形式**：每次装配按 `context.agent` 取该会话的当前人格（会话内切换过就是新的）；
		// 没切换过 / 取不到 → 退回 preset 自带人设，行为与从前完全一致。
		text: (context) => switchedPersonaText(projections, context) ?? staticPersona,
	})));

	// 工具 allowlist：`.agent.md` 的 `tools` 是 VS Code 口径，dsh 侧未必同名。
	// **只保留 dsh 里真实存在的名字**，未知名字写 Host 日志（能看到、能改）——否则一个名字对不上就会把
	// 该 Agent 的工具**静默清空**（模型突然什么都不能用，且没人知道为什么）。
	ctx.inject(['tools'], child => child.effect(() => {
		const wanted = Array.isArray(config.tools) ? config.tools.filter(t => typeof t === 'string' && t.trim()) : [];
		if (!wanted.length) {
			return;
		}
		const known = new Set((child.tools.schemas?.() ?? []).map(schema => schema?.name).filter(Boolean));
		const allow = wanted.filter(name => known.has(name));
		const unknown = wanted.filter(name => !known.has(name));
		if (unknown.length) {
			console.warn(`[vssaros-agents] agent ${config.agentId ?? '(unknown)'} 的 tools 里有 dsh 不认识的名字，已忽略：${unknown.join(', ')}`);
		}
		if (allow.length) {
			return child.tools.restrict({ allow });
		}
	}));
}

/** 一次挂载的状态（顶层角色用；页面与注册共用同一份，免得两处看到两份数据）。 */
function createState() {
	return {
		/** agentId → { presetId, fingerprint, dispose } */
		registered: new Map(),
		/** 每个 agent 的注册结果与映射缺口（页面显示，用户可见） */
		diagnostics: [],
		/** `ctx.agentPresets.list()` 的快照（证明真的进了花名册） */
		roster: [],
		/** 本轮扫描的错误 */
		errors: [],
		/**
		 * `agentPresets` **服务对象**（页面请求时用它做增量同步）。
		 * 注意：不能存 `inject` 出来的子 ctx——**回调返回后那个 ctx 就 inactive**，事后访问会抛
		 * `cannot get required service … in inactive context`（memory 模块在真机上实测 500 后统一改成存服务对象）。
		 */
		presets: null,
		/** `sessionController` 服务对象（`agent_open_session` 用；同一"存服务对象"纪律）。 */
		sessionController: null,
		/** `sessionQuery` 服务对象（`agent_read_chat` 用；同一纪律）。 */
		sessionQuery: null,
	};
}

/** 撤销本次挂载注册的全部 preset（幂等）。 */
async function disposeAllPresets(state) {
	const entries = [...state.registered.values()];
	state.registered.clear();
	state.roster = [];
	for (const entry of entries) {
		try {
			await entry.dispose();
		} catch {
			/* 已失效即目标 */
		}
	}
}

/**
 * 扫 agent 目录 → 增量注册 preset。
 * 每个 agent **每次都会重算 notes**（哪怕这次不需要重新注册）——诊断是"当前映射情况"的快照，
 * 不是"本轮做了什么"的日志；只在注册时才记的话，页面第二次请求就空了（实测踩过）。
 */
async function syncPresets(state, presets, config) {
	const scan = await scanAgents(agentsRootOf(config), undefined);
	const provider = typeof config.defaultProvider === 'string' ? config.defaultProvider.trim() : '';
	const errors = [...scan.errors];
	const diagnostics = [];
	const seen = new Set();
	for (const agent of scan.agents) {
		seen.add(agent.id);
		const { definition, notes } = toPresetDefinition(agent, { provider });
		const fingerprint = `${agent.file}:${agent.name}:${agent.model ?? ''}:${agent.persona.length}:${agent.tools.length}`;
		const existing = state.registered.get(agent.id);
		if (existing && existing.fingerprint === fingerprint) {
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: false });
			continue;
		}
		if (existing) {
			// 定义变了：先撤旧的再注册（`register` 对重名会失败，不能直接覆盖）
			try {
				await existing.dispose();
			} catch (e) {
				errors.push(`撤销旧定义失败（${agent.id}）：${String(e?.message ?? e)}`);
			}
			state.registered.delete(agent.id);
		}
		try {
			const dispose = await presets.register(definition);
			state.registered.set(agent.id, { presetId: definition.id, fingerprint, dispose });
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes, changed: true });
		} catch (e) {
			// 注册失败要看得见（dsh 侧自己的花名册也会留一条带诊断的失败行，但那是它的口径）
			errors.push(`注册 preset 失败（${definition.id}）：${String(e?.message ?? e)}`);
			diagnostics.push({ agentId: agent.id, presetId: definition.id, rows: definition.plugins.length, notes: [...notes, '注册失败'], changed: true });
		}
	}
	// 源文件消失的 agent：撤掉（只增不删会让花名册里留幽灵）
	for (const [agentId, entry] of [...state.registered]) {
		if (seen.has(agentId)) {
			continue;
		}
		try {
			await entry.dispose();
		} catch {
			/* 已失效即目标 */
		}
		state.registered.delete(agentId);
		diagnostics.push({ agentId, presetId: entry.presetId, rows: 0, notes: ['源文件已消失 → 已注销该 preset'], changed: true });
	}
	try {
		const roster = await presets.list();
		state.roster = roster.map(p => p.id).filter(id => typeof id === 'string').sort();
	} catch (e) {
		errors.push(`读取花名册失败：${String(e?.message ?? e)}`);
	}
	state.diagnostics = diagnostics;
	state.errors = errors;
	return scan;
}

/** 用量/实况的展示格式化（页面与 mockup 同口径：四桶全算；时间精确到分）。 */
const fmtTokens = n => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));
const fmtTime = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : '—');

/* =====================================================================
 * 页面（A 款 · 紧凑行式）
 * 2026-10-14：用户从 4 款样式 mockup（doc/dsh-agents-sideview-styles-mockup.html）选定 A。
 * 相对旧版（平铺 <ul> + 标题下一长条 diag 行）的改动口径：
 *   ① 吸顶标题行 +「名册 / 用量」分段控件 + 筛选框；
 *   ② 每行 = 3px 状态条（琥珀 = 模型未映射）+ 圆角方头像（不再用圆形，沿用会话列表那次的口径）
 *      + 名称 / 副行（模型 · 工具 · 人设 · token）+ 右侧会话数；点行展开抽屉；
 *   ③ 花名册 / 目录那条长 diag 收进页脚 —— 四个探针锚点原样保留（p3-06 钉住）；
 *   ④ 「映射说明 / 问题」不再重复列一遍 presetId：每行就地琥珀标 + 页尾一条默认收起的 details；
 *   ⑤ 只读不变：本页自己不写盘（新建 / 编辑 / 开新会话仍未拍板）。
 *   ⑥ 2026-10-14 追加：每行右侧**常显**齿轮 + 抽屉里的「Agent 设置」按钮 —— 经页面桥 `openAgentSettings`
 *      （桥 `5 → 6`）请宿主打开该 bot 的 VsSaros Agent 设置编辑器页（页面自己开不了编辑器）；
 *      宿主版本旧（preload 没这个 key）时在头部提示一行，**不静默失败** ✓。
 * 探针锚点（p3-06 逐条钉住，别改名、别删）：
 *   data-vssaros-page / -agents-count / -presets-registered / -roster / -agents-root / data-live-sessions /
 *   data-vssaros-usage-tab / id="usage" / tr 上的 data-usage-agent 与 data-usage-tokens（两属性相邻、单空格、
 *   顺序不变）/ class="avatar" style="background:hsl(N 45% 42%)"（≥ 2 个）/ 头像正文 emoji 直接跟收尾标签 /
 *   'allowlist' / '映射说明'；且在「花名册里没有我们 preset」的场景里，「未注册」必须恰好出现 2 次。
 * 本段含模板串：注释里不许出现反引号（会提前闭合、整文件语法错 —— 本仓已踩 5 次）。
 * ===================================================================== */
const PAGE_CSS = `:root { color-scheme: light dark; }
body { margin: 0; padding: 0 0 10px; font: 13px/1.5 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
header { position: sticky; top: 0; z-index: 2; padding: 9px 10px 8px; background: var(--vscode-sideBar-background, #1e1e1e); border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
h1 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
h1 .n { margin-left: auto; font-weight: 400; color: var(--vscode-descriptionForeground, #999); letter-spacing: 0; }
.tag { font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); }
.tag.gray { background: transparent; border: 1px solid var(--vscode-panel-border, #555); color: var(--vscode-descriptionForeground, #999); }
.tag.off { background: #7a3d2b; color: #fff; }
.seg { display: flex; margin: 8px 0 7px; border: 1px solid var(--vscode-panel-border, #555); border-radius: 6px; overflow: hidden; }
.seg button { flex: 1; padding: 3px 0; font: inherit; font-size: 12px; color: var(--vscode-descriptionForeground, #999); background: transparent; border: 0; cursor: pointer; }
.seg button + button { border-left: 1px solid var(--vscode-panel-border, #555); }
.seg button.on { background: var(--vscode-button-background, #0e639c); color: #fff; }
.search { display: flex; align-items: center; gap: 5px; padding: 2px 6px; background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
.search input { flex: 1; min-width: 0; padding: 2px 0; font: inherit; font-size: 12px; color: inherit; background: transparent; border: 0; outline: 0; }
.search .mag, .search .n { color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
ul { margin: 0; padding: 0; list-style: none; }
li.item { border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
.row { display: flex; gap: 7px; padding: 5px 10px 5px 0; cursor: pointer; }
.row:hover, li.item.open > .row { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.bar { flex: 0 0 3px; align-self: stretch; background: transparent; }
li.warned .bar { background: #cca700; }
.avatar { flex: 0 0 18px; width: 18px; height: 18px; margin-top: 1px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; color: #fff; }
.main { flex: 1; min-width: 0; }
.l1 { display: flex; align-items: baseline; gap: 6px; }
.name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.l1 .sp { margin-left: auto; color: var(--vscode-textLink-foreground, #6aa9e8); font-size: 11px; white-space: nowrap; }
.l1 .sp.dim { color: var(--vscode-descriptionForeground, #999); }
.l2 { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chev { align-self: center; color: var(--vscode-descriptionForeground, #999); font-size: 10px; }
li.item.open .chev { transform: rotate(90deg); }
.drawer { display: none; padding: 5px 10px 8px 28px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); background: rgba(128,128,128,.08); color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; }
li.item.open > .drawer { display: block; }
.drawer dl { display: grid; grid-template-columns: 52px 1fr; gap: 3px 8px; margin: 0; }
.drawer dd { margin: 0; color: var(--vscode-foreground, #ccc); overflow-wrap: anywhere; }
.mono, code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.unmapped { color: #cca700; }
details.warn { margin: 10px; border: 1px solid rgba(204,167,0,.45); border-radius: 6px; background: rgba(204,167,0,.1); }
details.warn > summary { padding: 6px 9px; color: #cca700; font-size: 12px; cursor: pointer; list-style: none; }
details.warn > summary::-webkit-details-marker { display: none; }
details.warn .wbody { padding: 0 9px 2px; }
details.warn li { margin-bottom: 4px; padding: 3px 0 3px 8px; border-left: 2px solid rgba(204,167,0,.5); color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; }
section.pad { padding: 0 10px; }
h2 { margin: 8px 0 5px; font-size: 11px; font-weight: 400; letter-spacing: .04em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); }
h2 small { text-transform: none; letter-spacing: 0; }
table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
th, td { padding: 3px 6px 3px 0; text-align: left; vertical-align: top; }
tr.head th { color: var(--vscode-descriptionForeground, #999); font-weight: 400; }
tr td { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); }
tr.unknown td { color: var(--vscode-descriptionForeground, #999); }
.empty, .diag { color: var(--vscode-descriptionForeground, #999); }
.empty { padding: 28px 14px; text-align: center; }
.diag { margin: 6px 0 0; font-size: 11.5px; }
footer { margin-top: 10px; padding: 8px 10px 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); color: var(--vscode-descriptionForeground, #999); font-size: 11px; overflow-wrap: anywhere; }
.iconbtn { flex: 0 0 auto; align-self: center; padding: 1px 4px; font: inherit; font-size: 12px; line-height: 1; color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground, #999)); background: transparent; border: 0; border-radius: 4px; cursor: pointer; }
.iconbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.25)); color: var(--vscode-foreground, #ccc); }
.acts { margin: 6px 0 0; }
.act { padding: 2px 8px; font: inherit; font-size: 11.5px; color: inherit; background: var(--vscode-button-secondaryBackground, #3a3d41); border: 1px solid var(--vscode-panel-border, #555); border-radius: 4px; cursor: pointer; }
.act:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
.note { margin: 0; padding: 6px 10px; color: var(--vscode-editorWarning-foreground, #cca700); }`;

function renderPage({ agents, summary, root, missing, diagnostics, roster, errors, liveRows, usage }) {
	const liveOf = new Map((liveRows ?? []).map(row => [row.agentId, row]));
	// 「模型未映射」的琥珀标来自宿主给的诊断（不由页面猜）：diagnostics 每项是 { agentId, presetId, notes, ... }
	const notesOf = new Map((diagnostics ?? []).map(d => [d.agentId, d.notes ?? []]));
	const rows = agents.map(a => {
		const presetId = presetIdOf(a.id);
		const registered = roster.includes(presetId);
		const live = liveOf.get(a.id);
		const unmapped = (notesOf.get(a.id) ?? []).some(n => n.startsWith('模型未映射'));
		// 副行：模型 · 工具 · 人设 · token（token 只在有会话时出现 —— 没有会话就不显示 0）
		const sub = [
			a.model ? (unmapped ? '模型未映射' : 'model ' + escapeHtml(a.model)) : 'model 未设',
			a.tools.length ? a.tools.length + ' tools' : '无 tools',
			a.persona ? '人设 ' + a.persona.length + ' 字' : '无人设正文',
		];
		if (live && live.sessions > 0) {
			sub.push('token ' + fmtTokens(live.tokens));
		}
		// 头像：icon 是 emoji 原样显示；没写 icon 就退到名字首字（底色按 id 哈希恒定）。圆角方块，不用圆形。
		const avatar = '<span class="avatar" style="background:' + avatarColorOf(a.id) + '" data-agent-icon="' + escapeHtml(a.icon ?? '') + '">' + escapeHtml(a.icon ?? a.name.slice(0, 1)) + '</span>';
		const facts = '<dl>'
			+ '<dt>preset</dt><dd class="mono">' + escapeHtml(presetId) + '</dd>'
			+ '<dt>定义</dt><dd class="mono">' + escapeHtml(a.file ?? '(未知)') + '</dd>'
			+ '<dt>模型</dt><dd>' + (a.model
				? escapeHtml(a.model) + (unmapped ? ' <span class="unmapped">未映射 → 跟随默认模型</span>' : '')
				: '未设（跟随默认模型）') + '</dd>'
			+ '<dt>工具</dt><dd>' + (a.tools.length ? escapeHtml(a.tools.join('、')) : '无（该 agent 不限制工具）') + '</dd>'
			+ '<dt>人设</dt><dd>' + (a.persona ? a.persona.length + ' 字' : '无人设正文') + '</dd>'
			+ (live && live.sessions > 0
				? '<dt>实况</dt><dd>' + live.sessions + ' 会话 · ' + fmtTokens(live.tokens) + ' token · ' + live.turns + ' 回合 · 最近 ' + escapeHtml(fmtTime(live.lastActiveAt)) + '</dd>'
				: '')
			+ '</dl>'
			// 2026-10-14：抽屉里的显式入口（行上的齿轮是快路径，这里不依赖悬停/小图标能被看见）
			+ '<p class="acts"><button class="act" onclick="openAgentSettingsFrom(this)" title="打开该 bot 在 VsSaros 里的 Agent 设置页">Agent 设置</button></p>';
		// data-search：筛选框的匹配面（id / 名称 / 描述），在服务端算好，页面只做子串匹配
		return '<li class="item' + (unmapped ? ' warned' : '') + '" data-agent-id="' + escapeHtml(a.id) + '" data-live-sessions="' + (live?.sessions ?? 0) + '" data-search="' + escapeHtml((a.id + ' ' + a.name + ' ' + (a.description ?? '')).toLowerCase()) + '">'
			+ '<div class="row" onclick="toggleRow(this)"><span class="bar"></span>' + avatar
			+ '<div class="main"><div class="l1"><span class="name">' + escapeHtml(a.name) + '</span>'
			+ (registered ? '' : '<span class="tag off">未注册</span>')
			+ '<span class="sp' + (live && live.sessions > 0 ? '' : ' dim') + '">' + (live && live.sessions > 0 ? '会话 ' + live.sessions : '—') + '</span></div>'
			+ '<div class="l2">' + sub.join(' · ') + '</div></div>'
			+ '<button class="iconbtn" title="Agent 设置" aria-label="Agent 设置" onclick="openAgentSettingsFrom(this)">⚙</button>'
			+ '<span class="chev">›</span></div>'
			+ '<div class="drawer">' + facts + '</div></li>';
	}).join('');
	const body = missing
		? '<p class="empty">agent 目录还不存在：<code>' + escapeHtml(missing) + '</code><br>在 VsSaros 里建过自定义 agent 后这里会出现。</p>'
		: (rows ? '<ul>' + rows + '</ul>' : '<p class="empty">还没有可用的 agent（每个子目录需要一个带 name 的 .agent.md）。</p>');
	const notes = diagnostics.flatMap(d => (d.notes ?? []).map(n => d.presetId + '：' + n));
	// 映射说明 / 问题：默认收起（原生 details，不依赖脚本）；有 errors 时默认展开（那是真出事了）
	const problems = (notes.length || errors.length)
		? '<details class="warn"' + (errors.length ? ' open' : '') + '><summary>映射说明 / 问题 ' + (notes.length + errors.length) + '</summary><div class="wbody"><ul>'
			+ [...notes, ...errors].map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div></details>'
		: '';
	const ours = roster.filter(id => id.startsWith('vssaros-'));
	// 页脚：把旧版标题下那长条 diag 行收进来（四个探针锚点挂在这里）
	const footer = '<footer data-vssaros-agents-count="' + summary.count + '" data-vssaros-presets-registered="' + ours.length
		+ '" data-vssaros-roster="' + escapeHtml(roster.join(',')) + '" data-vssaros-agents-root="' + escapeHtml(root) + '">'
		+ '已注册 preset ' + ours.length + ' / 花名册 ' + roster.length + ' · <code>' + escapeHtml(root) + '</code></footer>';

	// 用量页签（P5）：按 agent / 按模型；名册外会话单列「未归属」。口径注释与 mockup 一致。
	const usageRows = (usage?.agents ?? []).map(u => {
		const agent = agents.find(a => a.id === u.agentId);
		const models = u.models.length ? u.models.map(m => escapeHtml(m.ref) + '（' + fmtTokens(m.tokens) + '）').join('<br>') : '—';
		const avatar = agent ? '<span class="avatar" style="background:' + avatarColorOf(agent.id) + '">' + escapeHtml(agent.icon ?? agent.name.slice(0, 1)) + '</span>' : '';
		return '<tr data-usage-agent="' + escapeHtml(u.agentId) + '" data-usage-tokens="' + u.tokens + '"><td>' + avatar + '<b>' + escapeHtml(agent?.name ?? u.agentId) + '</b></td><td>' + u.sessions + '</td><td>' + fmtTokens(u.tokens) + '</td><td>' + u.turns + '</td><td>' + escapeHtml(fmtTime(u.lastActiveAt)) + '</td><td>' + models + '</td></tr>';
	}).join('');
	const unknown = usage?.unknown;
	const unknownRow = unknown && unknown.sessions > 0
		? '<tr class="unknown"><td>未归属（standard / 已删 agent 的残留）</td><td>' + unknown.sessions + '</td><td>' + fmtTokens(unknown.tokens) + '</td><td>' + unknown.turns + '</td><td>—</td><td>—</td></tr>'
		: '';
	const usageSection = usage
		? '<div id="usage" hidden><section class="pad"><h2>用量 <small>按 agent / 按模型 · 只读（projcache）</small></h2>'
			+ '<table><tr class="head"><th>Agent</th><th>会话</th><th>token</th><th>回合</th><th>最近活跃</th><th>按模型</th></tr>' + usageRows + unknownRow + '</table>'
			+ '<p class="diag">token = 输入+输出+读缓存+写缓存；「最近活跃」= 最后一条用户输入。按时间的趋势视图在 Dashboard 页。</p></section></div>'
		: '';
	// 页签（与旧版同一套 id/锚点，只是换成 A 款的分段控件形态）
	const tabNav = usage
		? '<nav class="seg"><button id="tabRoster" class="on" onclick="showTab(\'roster\')">名册 ' + summary.count + '</button>'
			+ '<button id="tabUsage" data-vssaros-usage-tab onclick="showTab(\'usage\')" data-usage-sessions="' + usage.totals.sessions + '" data-usage-tokens="' + usage.totals.tokens + '">用量 ' + usage.totals.sessions + '</button></nav>'
		: '';
	// 页面脚本：页签 + 行展开 + 筛选。都是纯前端增强，关掉 JS 也读得到全部内容。
	const script = '<script>'
		// 打开该 bot 的 VsSaros「Agent 设置」编辑器页（桥 `5 → 6`）。页面开不了编辑器 ⇒ 只能请宿主开。
		// 宿主版本旧（preload 没暴露这个 key）时给一行提示 —— **不静默失败**（点了没反应最难查 ✗）。
		+ 'function openAgentSettings(id, name) {'
		+ 'var bridge = window.vssarosDsh;'
		+ "if (!bridge || typeof bridge.openAgentSettings !== 'function') { note('当前宿主不支持从这里打开 Agent 设置（需要桥版本 6 的宿主）'); return; }"
		+ "try { bridge.openAgentSettings(id, name); note(''); } catch (e) { note('打开 Agent 设置失败：' + e); }"
		+ '}'
		// 从行上的齿轮 / 抽屉按钮取 id（`li.item[data-agent-id]` 是行的身份锚点 ✓），顺便把显示名带上
		+ 'function openAgentSettingsFrom(el) {'
		+ "var li = el && el.closest ? el.closest('li.item') : null;"
		+ 'if (!li) { return; }'
		+ "var n = li.querySelector('.name');"
		+ "openAgentSettings(li.getAttribute('data-agent-id'), n ? n.textContent : undefined);"
		+ '}'
		+ 'function note(text) {'
		+ "var el = document.getElementById('pageNote');"
		+ 'if (!el) { return; }'
		+ "if (!text) { el.hidden = true; el.textContent = ''; return; }"
		+ 'el.textContent = text;'
		+ 'el.hidden = false;'
		+ '}'
		+ 'function showTab(which) {'
		+ "var r = document.getElementById('roster');"
		+ "var u = document.getElementById('usage');"
		+ "if (r) { r.hidden = which !== 'roster'; }"
		+ "if (u) { u.hidden = which !== 'usage'; }"
		+ "var a = document.getElementById('tabRoster');"
		+ "var b = document.getElementById('tabUsage');"
		+ "if (a) { a.classList.toggle('on', which === 'roster'); }"
		+ "if (b) { b.classList.toggle('on', which === 'usage'); }"
		+ '}'
		+ 'function toggleRow(el) { var li = el.parentElement; if (li) { li.classList.toggle(\'open\'); } }'
		+ 'function filterRows() {'
		+ "var box = document.getElementById('q');"
		+ "var out = document.getElementById('qCount');"
		+ 'var q = box ? String(box.value || \'\').trim().toLowerCase() : \'\';'
		+ "var all = document.querySelectorAll('#roster li.item');"
		+ 'var hit = 0;'
		+ 'for (var i = 0; i < all.length; i++) {'
		+ "var t = all[i].getAttribute('data-search') || '';"
		+ 'var show = !q || t.indexOf(q) >= 0;'
		+ 'all[i].hidden = !show;'
		+ 'if (show) { hit++; }'
		+ '}'
		+ 'if (out) { out.textContent = q ? hit + \'/\' + all.length : String(all.length); }'
		+ '}'
		+ '</script>';

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Agents · VsSaros</title>
<style>
${PAGE_CSS}
</style>
</head>
<body data-vssaros-page="agents">
<header>
	<h1>Agents <span class="tag gray">只读</span><span class="n">${summary.count}</span></h1>
	${tabNav}
	<label class="search"><span class="mag">⌕</span><input id="q" placeholder="筛选 name / id / 描述" oninput="filterRows()"><span class="n" id="qCount">${summary.count}</span></label>
</header>
<p class="diag note" id="pageNote" hidden></p>
<div id="roster">${body}</div>
${usageSection}
${problems}
${footer}
${script}
</body>
</html>`;
}

/** 读请求体并解析 JSON（空体 → `{}`）。 */
async function readJsonBody(req) {
	const chunks = [];
	for await (const chunk of req) {
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8').trim();
	return text ? JSON.parse(text) : {};
}

/** `@deepseek-ai/dsh-llm` 的消息工厂；拿不到就由核心模块自组消息（运行期无校验，安全）。 */
async function loadCreateUserMessage() {
	try {
		const mod = await import('@deepseek-ai/dsh-llm');
		return typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : undefined;
	} catch {
		return undefined;
	}
}

/** 人设段此刻渲染出的文本（只留头部与字节数，别把整段人设塞进响应）。 */
async function renderedPersona(state, agent) {
	try {
		const systemPrompt = state.systemPrompt;
		if (!systemPrompt?.assemble) {
			return undefined;
		}
		// 手工装配是**纯读**：不写任何会话事件（loop 才写）。作用域给 agent（与 loop 的 assembleContextFor 同形）。
		const assembly = await systemPrompt.assemble({ agent, scope: agent });
		const section = assembly?.sections?.find(s => s.name === PERSONA_SECTION_NAME);
		if (typeof section?.text !== 'string') {
			return undefined;
		}
		return { bytes: Buffer.byteLength(section.text, 'utf8'), head: section.text.slice(0, 120) };
	} catch (e) {
		return { error: String(e?.message ?? e) };
	}
}

/** 读某会话当前生效的人格（没切换过 → personaId=null）；顺带回读人设段此刻渲染的文本。 */
async function readPersona(state, sessionId) {
	const id = String(sessionId ?? '').trim();
	if (!id) {
		throw new Error('需要 sessionId');
	}
	const agent = state.agents?.get?.(id);
	if (!agent) {
		throw new Error(`会话不在运行：${id}`);
	}
	const current = state.projections?.stateOf?.(agent.session, PERSONA_PROJECTION_KEY);
	return {
		sessionId: id,
		personaId: current?.personaId ?? null,
		name: current?.name ?? null,
		atSeq: current?.atSeq ?? -1,
		rendered: await renderedPersona(state, agent),
	};
}

/**
 * 会话内切换人格：把"切换指令"注入该会话的 durable inbox。
 *
 * `agent.inject` = 投进 next-step 队列、**不唤醒**：会话空闲时它与用户下一条消息同批被 claim（模型只
 * 回答用户，不会对切换指令自说自话起一轮）；正在跑的回合则落在其下一个 step。切换事实落成 dsh 已登记的
 * `agent/inbox/spliced` 事件（不新增事件类型），投影据此更新 → 下一步装配的 system prompt 即新人格。
 * @param state 顶层角色状态（含 `agents` / `projections`）
 * @param config 本行 config（取 agentsRoot）
 * @param body `{ sessionId, personaId }` 切换；`{ sessionId, clear: true }`（或 personaId 为空）= 切回
 *             preset 自带人设（同样落一条事件，所以"清除"也可重放）
 */
async function switchPersona(state, config, body) {
	const sessionId = String(body?.sessionId ?? '').trim();
	const personaId = String(body?.personaId ?? '').trim();
	// `presetId`：chat-surface 只知道 **preset id**（`vssaros-<slug>` —— 它列的是 dsh 花名册里的 id），
	// 而这里要的是 agent id。映射真源是 `presetIdOf`（id 经过 slug 化 ⇒ 页面侧反推不可靠 ✗），
	// 所以把"preset id → agent id"的解析放在宿主侧（2026-10-11，Commands「Agent」行接进来的）。
	const presetId = String(body?.presetId ?? '').trim();
	const clear = body?.clear === true || (!personaId && !presetId);
	if (!sessionId) {
		throw new Error('需要 sessionId');
	}
	const agent = state.agents?.get?.(sessionId);
	if (!agent) {
		throw new Error(`会话不在运行，无法热切换：${sessionId}`);
	}
	if (typeof agent.inject !== 'function') {
		throw new Error('该会话的 agent 不支持 inject（dsh 版本不匹配？）');
	}
	const createUserMessage = await loadCreateUserMessage();
	if (clear) {
		agent.inject(personaSwitchMessage(null, { clear: true, createUserMessage, uuid: () => randomUUID() }));
		return { sessionId, personaId: null, name: null, cleared: true };
	}
	const scan = await scanAgents(agentsRootOf(config));
	// 两种指定方式：`personaId`（= agent id，直接命中）/ `presetId`（= 花名册 id，经 `presetIdOf` 反查）。
	const target = personaId
		? scan.agents.find(a => a.id === personaId)
		: scan.agents.find(a => presetIdOf(a.id) === presetId);
	if (!target) {
		throw new Error(personaId ? `未知人格：${personaId}` : `未知 preset：${presetId}`);
	}
	if (!target.persona) {
		throw new Error(`该人格没有正文，无法切换：${personaId}`);
	}
	agent.inject(personaSwitchMessage(target, { createUserMessage, uuid: () => randomUUID() }));
	return {
		sessionId,
		personaId: target.id,
		name: target.name,
		personaBytes: Buffer.byteLength(target.persona, 'utf8'),
	};
}

/** 角色 1：顶层（注册 preset + 页面）。 */
function applyTopLevel(ctx, config) {
	const state = createState();

	// 会话投影（顶层再注册一份，与 preset 作用域那份共享同一个单元）——切换后 UI/诊断按 sessionId 读它。
	ctx.inject(['sessionProjections'], child => child.effect(() => {
		state.projections = child.sessionProjections;
		child.sessionProjections.register(personaProjection());
		return () => {
			state.projections = undefined;
		};
	}));

	// 人格热切换要按 sessionId 找到**活的 agent**：dsh 的 `agents.get(id)` 用的就是 agent/session 共享 id。
	// `systemPrompt` 一起注入，用来回读人设段此刻渲染出的文本（诊断与 e2e 断言用）。
	ctx.inject(['agents', 'systemPrompt'], child => child.effect(() => {
		state.agents = child.agents;
		state.systemPrompt = child.systemPrompt;
		return () => {
			state.agents = undefined;
			state.systemPrompt = undefined;
		};
	}));

	// `agent_open_session` 的会话创建入口（`sessionController.create` 收 `agentPreset`，契约见
	// `dsh-api-session-controller` 的 `SessionCreateRequest`）；`agent_read_chat` 的历史检索入口
	// （`sessionQuery.filterEvents` 的字面子句，`dsh-session-query` ✓）。
	ctx.inject(['sessionController'], child => child.effect(() => {
		state.sessionController = child.sessionController;
		return () => {
			state.sessionController = undefined;
		};
	}));
	ctx.inject(['sessionQuery'], child => child.effect(() => {
		state.sessionQuery = child.sessionQuery;
		return () => {
			state.sessionQuery = undefined;
		};
	}));

	// 生命周期工具（2026-10-13，P2）。`hostHalf`：B1 ② 就绪后由 host 行携带 ⇒ host 面让出工具，
	// preset 里的 toolsOnly 行继续提供（缺省 = 注册，零行为改变）。
	ctx.effect(() => {
		if (config.hostHalf === true) {
			return undefined;
		}
		return registerAgentTools(ctx, config, state);
	});

	// 回复自动回传（2026-10-13，P3.2）：宿主面监听全部会话的 turn-stopping（与 memory 自动沉淀
	// 同一钩子 ✓）。只装顶层角色——toolsOnly（preset 内）的事件视野未证，不装 ✓。
	ctx.effect(() => installRelay(ctx, config, state));

	ctx.inject(['agentPresets'], child => child.effect(() => {
		state.presets = child.agentPresets; // ← 回调内取服务对象（子 ctx 事后就 inactive 了）
		// 注册是异步的（`register` 返回 Promise<disposer>）：登记 in-flight，卸载时先等它落地再撤销，
		// 否则会出现"卸载后又注册回来"的泄漏。
		const inflight = (async () => {
			try {
				await syncPresets(state, state.presets, config);
			} catch (e) {
				state.errors = [...state.errors, `扫描 agent 目录失败：${String(e?.message ?? e)}`];
			}
		})();
		return async () => {
			state.presets = null;
			await inflight.catch(() => undefined);
			await disposeAllPresets(state);
		};
	}));

	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://127.0.0.1');
			const pathname = url.pathname;
			const root = agentsRootOf(config);
			// 会话内人格热切换（GET 读当前人格 / POST 切换）：与只读花名册页同前缀，聊天页同源可直接 fetch，
			// 不必绕 IDE——切换只依赖 Host 侧（agents + 投影 + durable inbox），不新建会话、不新建视图。
			if (pathname === `${ROUTE_PREFIX}/api/persona`) {
				try {
					if (req.method === 'GET') {
						const current = await readPersona(state, url.searchParams.get('sessionId'));
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(current));
					} else if (req.method === 'POST') {
						const switched = await switchPersona(state, config, await readJsonBody(req));
						res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify(switched));
					} else {
						res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, POST' });
						res.end('GET or POST');
					}
				} catch (e) {
					res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(String(e?.message ?? e));
				}
				return;
			}
			try {
				// 每次请求都做增量同步（新加/改动/删掉 agent 不必重启 Host）。同步失败不影响读页面。
				const scan = state.presets
					? await syncPresets(state, state.presets, config).catch(e => {
						state.errors = [...state.errors, `同步 preset 失败：${String(e?.message ?? e)}`];
						return scanAgents(root, undefined);
					})
					: await scanAgents(root, undefined);
				const summary = summarizeAgents(scan.agents);
				// 用量 API（2026-10-13，P5）：按 agent（含按模型拆分）的会话/token/回合聚合，
			// 数据源 = projcache（只读）。时间口径如实说：只有"最近活跃"（lastPromptAt），
			// 没有按天分桶——按时间的视图在 Dashboard 页（那边有完整的量）。
			if (pathname === `${ROUTE_PREFIX}/api/usage`) {
				const live = await readLiveSessions(config)
					.catch(e => ({ rows: [], errors: [`用量读取失败：${String(e?.message ?? e)}`], dir: undefined, truncated: false }));
				const usage = usageByAgent(scan.agents, live.rows);
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify({
					agents: usage.agents,
					unknown: usage.unknown,
					totals: usage.totals,
					sessions: live.rows.length,
					truncated: live.truncated === true,
					errors: live.errors,
					...(live.missing ? { missing: live.missing } : {}),
				}));
				return;
			}
			if (pathname === `${ROUTE_PREFIX}/api/agents`) {
					// 实况（2026-10-13）：会话归属与用量**不另建状态文件**——projcache 里 `agentPreset` /
					// `tokenUsage` / `sessionStats` 都是现成的（ds-bot 的 state.json 名册在我们这里不需要）。
					// 读失败只进 errors，不影响花名册本体。
					const live = await readLiveSessions(config)
						.catch(e => ({ rows: [], errors: [`实况读取失败：${String(e?.message ?? e)}`], dir: undefined, truncated: false }));
					const { rows: liveRows, unmatched } = liveForAgents(scan.agents, aggregateByPreset(live.rows));
					const liveOf = new Map(liveRows.map(row => [row.agentId, row]));
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						root,
						count: summary.count,
						summary,
						// 与 dsh 的花名册对齐：每个 agent 是否真的注册成功
						agents: scan.agents.map(a => ({
							id: a.id,
							name: a.name,
							description: a.description,
							icon: a.icon,
							model: a.model,
							tools: a.tools,
							personaBytes: Buffer.byteLength(a.persona, 'utf8'),
							presetId: presetIdOf(a.id),
							registered: state.roster.includes(presetIdOf(a.id)),
							live: liveOf.get(a.id) ?? null,
						})),
						live: {
							dir: live.dir,
							sessions: live.rows.length,
							truncated: live.truncated === true,
							unmatchedPresets: unmatched,
							errors: live.errors,
							...(live.missing ? { missing: live.missing } : {}),
						},
						roster: state.roster,
						diagnostics: state.diagnostics,
						errors: [...scan.errors, ...state.errors],
						...(scan.missing ? { missing: scan.missing } : {}),
					}));
					return;
				}
				// 实况 + 用量（P1/P5）：projcache 读不到就降级为"没有这两块"（页面主体不受影响 ✓）
				const live = await readLiveSessions(config).catch(() => null);
				const liveRows = live ? liveForAgents(scan.agents, aggregateByPreset(live.rows)).rows : [];
				const usage = live ? usageByAgent(scan.agents, live.rows) : null;
				// 渲染先于 writeHead：渲染抛错还能干净回 500（教训：顺序反了会切断 socket）
				const html = renderPage({
					agents: scan.agents,
					summary,
					root,
					missing: scan.missing,
					diagnostics: state.diagnostics,
					roster: state.roster,
					errors: [...scan.errors, ...state.errors],
					liveRows,
					usage,
				});
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}

/** 角色 3：preset 内的"只挂工具"行（`config.toolsOnly: true`）。
 *  不注册 preset、不开页面、不注册人设段——只把四个生命周期工具挂进该 preset 作用域，
 *  这样 B1 ②（host 行让出工具）之后，选中我们 preset 的会话仍有这套工具。
 *  ⚠ 不读 `config.hostHalf`：hostHalf 管的是 host 面那一半，preset 面必须始终有工具。 */
function applyToolsOnly(ctx, config) {
	const state = { agents: undefined, sessionController: undefined, sessionQuery: undefined };
	ctx.inject(['agents'], child => child.effect(() => {
		state.agents = child.agents;
		return () => {
			state.agents = undefined;
		};
	}));
	ctx.inject(['sessionController'], child => child.effect(() => {
		state.sessionController = child.sessionController;
		return () => {
			state.sessionController = undefined;
		};
	}));
	ctx.inject(['sessionQuery'], child => child.effect(() => {
		state.sessionQuery = child.sessionQuery;
		return () => {
			state.sessionQuery = undefined;
		};
	}));
	ctx.effect(() => registerAgentTools(ctx, config, state));
}

export function apply(ctx, config = {}) {
	// 角色判定：`config.persona` 非空 = 本包被某个 preset 再挂了一次（只做人设注入）
	if (typeof config?.persona === 'string' && config.persona.trim()) {
		applyPersona(ctx, config);
		return;
	}
	// `config.toolsOnly` = preset 内的工具行（只挂工具）
	if (config?.toolsOnly === true) {
		applyToolsOnly(ctx, config);
		return;
	}
	applyTopLevel(ctx, config);
}
