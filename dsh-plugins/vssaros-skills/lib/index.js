// @vssaros/dsh-skills — host half：把 VsSaros 技能目录注册为 dsh 技能来源 + 只读目录页 + 技能**检索**工具。
//
// 分工（方案 6.6 skills 行）：dsh 侧**已经有**技能注册表（`ctx.skills`）与**加载**工具
// （`dsh-tool-skill` 的 `skill` 工具）。所以本模块**不注册任何"加载"类工具**——那会与原生能力重复、
// 甚至遮蔽它 ✗。本模块做 dsh 自己做不到的**两件**事：
//   ① 技能来源：把 VsSaros 的用户技能目录（`<数据根>/skills/<id>/SKILL.md`）变成 dsh 的一个来源；
//   ② 技能**检索**：`skill_search`（BM25）—— 原生 `skill` 工具只管"取"，技能一多模型就得在几十上百条
//      描述里盲挑 ✗；检索负责"找"，并告诉模型拿哪个 id 去取正文 ✓。它的口径与实现见
//      `lib/core/skillSearch.js`（含"为什么照搬一个退化的 BM25"这条说明）。
//   名字刻意**不叫** `skill` ⇒ 不遮蔽原生工具 ✓（p3-04 有断言钉住"注册的工具集合恰好是 {skill_search}"）。
//
// 不导出 `inject`：本模块没有**必需**依赖——`ctx.skills` / `ctx.tools` / `webServer` 都可能不存在
// （headless / 精简模板），三个注册都走 `ctx.inject` 可选依赖 ⇒ 插件在任何 profile 都能激活 ✓
// （对比 kanban：它必需 `tools`，因为工具是它唯一的存在理由）。**代价**：没装 `dsh-tools` 的 profile 里
// 技能检索会静默缺席 ⇒ 页面自诊断必须把"工具在不在"报出来 ✓（那一栏就是为此存在的）。
//
// 数据契约与覆盖缺口见 `lib/core/skills.js` 文件头（三层来源只覆盖中间那层；always 的自动注入语义无等价物）。

import { appendFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillFromFile, summarizeCatalog, toCandidate, toDefinition, VSAROS_SKILL_PROVIDER } from './core/skills.js';
import { bindFoundation } from './foundationRef.js';
import { rankSkills, SKILL_SEARCH_DEFAULT_LIMIT, SKILL_SEARCH_MAX_LIMIT } from './core/skillSearch.js';

import { MAX_SKILL_BYTES, SKILL_MANAGE_ACTIONS, skillManage } from './core/skillManage.js';

import { dataRootOf, readSkillFile, scanSkills, skillDirOf, skillIdOf, skillsRootOf } from './store.js';

// 跨进程写锁（协议 v2，与 workflow / kanban / IDE 同一套 ✓；**逐字复制的副本** —— 插件间不能互相
// import ✓，包各自独立 ✓）。互通性由 `dshWorkflowWriteLock.test.ts` 拿真文件互抢验证 ✓。
import { acquireFileLock, lockFileFor } from './lock.js';


/** 与 cordis.patch.yml 的行 id 一致（值来自 core 的单一真源，见那里的注释）。 */
export const name = VSAROS_SKILL_PROVIDER;

const ROUTE_PREFIX = '/x/skills';
/** 注册名：**必须**与候选里的 `provider` 一致（同源常量，避免漂移）。 */
const PROVIDER_NAME = VSAROS_SKILL_PROVIDER;
/** dsh 原生的技能加载工具名（`dsh-tool-skill`）：本模块的消费者，页面报告它在不在。 */
const NATIVE_SKILL_TOOL = 'skill';

/**
 * 每次挂载一份状态（**不是模块级** ✗）。
 *
 * 为什么必须这样（R13 的前置条件）：把工具行搬进 preset plane 之后，同一个包会在**每个会话作用域再挂一次** ✓
 * —— 那时模块级状态会让两个实例互相覆盖 ⇒ 各自页面渲染出**对方**的诊断 ✗。
 * `vssaros-agents` 早就因为同类坑改成"每次 apply 一份（闭包）" ✓（其文件头写着"实测踩过" ✓）；
 * 本模块 2026-10-12 由 `p3-04` 新加的"双挂载不串话"断言抓出来（**加断言时确实是红的** ✓：
 * A 的页面渲染出了 B 的工具表 ✓），一并改成同一口径 ✓。
 */
function createState() {
	return {
		/** 注册状态：页面与日志据此说明"为什么技能没生效"。 */
		provider: { registered: false, reason: '尚未注册（等待 ctx.skills）' },
		/** 上次扫描的目录指纹：变化时调 `control.invalidate()` 让消费者重取目录。 */
		lastFingerprint: '',
		/**
		 * dsh 原生 skill 工具在不在（本模块的消费者）。
		 * ⚠️ 不能直接写 `ctx.tools.xxx`：**未在 `inject` 里声明的服务，被访问时会抛错**（实测：在页面处理器里
		 * 访问它导致连接被切断）。本模块刻意不声明 `inject = ['tools']`（没这需求，声明了会让插件在没装
		 * dsh-tools 的 profile 里 pending），所以这里走可选注入 + `tools/change` 跟踪，避免读未声明服务。
		 */
		nativeSkillToolPresent: false,
		/**
		 * 实测**看到的、含 "skill" 字样的工具名**（最多 4 个）——纯诊断 ✓。
		 *
		 * 为什么要它：真机上这一栏长期是 `absent` ✗，而 `@deepseek-ai/dsh-tool-skill` **就在这个 runtime 里** ✓、
		 * profile 也**确实启用了它** ✓（`dsh --profile vssaros --dump-config` 可查 ✓）、它注册的工具名也**就是**
		 * `"skill"` ✓ ⇒ "absent" 就有两种可能：它没注册 ✓，或者名字被**命名空间化**了 ✗（mcp 的工具名就是
		 * `mcp__probe__probe_ping` 那种形式 ✓）。把看到的名字报出来，就不用猜 ✓。
		 */
		skillishTools: [],
		// 重构 4（2026-10-17）：skill_market_list 要经桥回 IDE 拉远端清单（远端认证在壳侧 ✓）。
		// 可选注入：vssarosBridge 不在 ⇒ 市场工具如实报"桥不在" ✓，其余照常 ✓。
		bridge: null,
	};
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** MCP 区块的片段路由（`@vssaros/dsh-mcp` 声明的那个；本页内嵌它，与 kb 内嵌 memory 同法）。 */
const MCP_SECTION_ROUTE = '/x/mcp/section';

/** 服务端取 MCP 片段（同源 + 转发 Cookie）。失败不抛：返回带原因的说明（未装该模块是常态）。 */
async function fetchMcpSection(req) {
	const host = req.headers?.host;
	if (!host) {
		return { state: 'absent', html: '<p class="diag">取不到 Host 头，无法内嵌 MCP 区块。</p>' };
	}
	try {
		const res = await fetch(`http://${host}${MCP_SECTION_ROUTE}`, {
			headers: req.headers?.cookie ? { cookie: String(req.headers.cookie) } : {},
			signal: AbortSignal.timeout(5000),
		});
		const body = await res.text();
		if (!res.ok) {
			return { state: 'absent', html: `<p class="diag">MCP 区块未内嵌：<code>${escapeHtml(MCP_SECTION_ROUTE)}</code> 返回 HTTP ${res.status}（@vssaros/dsh-mcp 未安装或未激活，属正常）。</p>` };
		}
		return { state: 'embedded', html: body };
	} catch (e) {
		return { state: 'absent', html: `<p class="diag">MCP 区块未内嵌：${escapeHtml(String(e?.message ?? e))}</p>` };
	}
}

/**
 * 预览面板的内嵌脚本 —— **照 kb 页（5.68）那一套**：服务端渲染 + 一小段原生 JS，不引框架、不加构建步骤 ✓。
 * 两页同一套交互，用户不用学两遍 ✓（也意味着**改交互要两处一起改**，所以两边都留了 `data-*-preview` 钩子 ✓）。
 */
const SKILL_PREVIEW_SCRIPT = `
(function () {
	var root = document.querySelector('[data-vssaros-page="skills"]');
	if (!root || !window.fetch) { return; }

	/* 分段控件（技能 / MCP / 问题）：只切 pane 的显隐，内容全是服务端渲染好的。 */
	var tabs = Array.prototype.slice.call(root.querySelectorAll('[data-sk-tab]'));
	var panes = Array.prototype.slice.call(root.querySelectorAll('[data-sk-pane]'));
	var searchWrap = root.querySelector('[data-sk-search-wrap]');
	function showTab(name) {
		tabs.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sk-tab') === name); });
		panes.forEach(function (p) { p.hidden = p.getAttribute('data-sk-pane') !== name; });
		if (searchWrap) { searchWrap.hidden = name !== 'skills'; }
	}
	tabs.forEach(function (b) {
		b.addEventListener('click', function () { showTab(b.getAttribute('data-sk-tab')); });
	});

	/* 搜索：纯客户端过滤（技能一多时不必让服务端重排）。 */
	var rows = Array.prototype.slice.call(root.querySelectorAll('[data-skill-row]'));
	var input = root.querySelector('[data-sk-search]');
	var counter = root.querySelector('[data-sk-count]');
	function detailOf(row) {
		var next = row.nextElementSibling;
		return next && next.hasAttribute('data-skill-detail') ? next : null;
	}
	function collapse(row) {
		var d = detailOf(row);
		if (d) { d.hidden = true; }
		row.classList.remove('open');
		row.setAttribute('aria-expanded', 'false');
	}
	function applyFilter() {
		var q = (input && input.value ? input.value : '').trim().toLowerCase();
		var shown = 0;
		rows.forEach(function (row) {
			var hit = !q || (row.textContent || '').toLowerCase().indexOf(q) >= 0;
			if (hit) { shown++; } else { collapse(row); }
			row.hidden = !hit;
		});
		if (counter) { counter.textContent = shown + '/' + rows.length; }
	}
	if (input) { input.addEventListener('input', applyFilter); }

	/* 行内抽屉：点一行就地展开正文（取代原来钉在底部的预览面板 —— 那个面板在窄栏里抢纵向空间）。 */
	rows.forEach(function (row) {
		row.setAttribute('aria-expanded', 'false');
		row.setAttribute('tabindex', '0');
		row.addEventListener('click', function () {
			var id = row.getAttribute('data-skill-id');
			var panel = detailOf(row);
			if (!id || !panel) { return; }
			if (!panel.hidden) { collapse(row); return; }
			rows.forEach(collapse);
			row.classList.add('open');
			row.setAttribute('aria-expanded', 'true');
			panel.hidden = false;
			var body = panel.querySelector('[data-sk-body]');
			if (!body || panel.getAttribute('data-loaded') === '1') { return; }
			body.textContent = '读取中…';
			window.fetch('/x/skills/api/skill?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
				.then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
				.then(function (r) {
					if (!r.ok) { body.textContent = '读不了：' + ((r.data && r.data.error) || '未知原因'); return; }
					panel.setAttribute('data-loaded', '1');
					body.textContent = (r.data.content || '') + '\\n\\n（' + (r.data.contentBytes || 0) + ' 字节 · ' + (r.data.path || '') + '）';
				})
				.catch(function (e) { body.textContent = '读不了：' + e; });
		});
		row.addEventListener('keydown', function (ev) {
			if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); row.click(); }
		});
	});

	/* 底部「详情」：那一长条来源诊断默认收起（它原来横在标题下，占掉窄栏里 4 行）。 */
	var more = root.querySelector('[data-sk-more]');
	var detail = root.querySelector('[data-sk-detail]');
	if (more && detail) {
		more.addEventListener('click', function () {
			detail.hidden = !detail.hidden;
			more.setAttribute('aria-expanded', detail.hidden ? 'false' : 'true');
		});
	}

	/* 重载按钮（标题栏那一个）。 */
	var refresh = root.querySelector('[data-sk-refresh]');
	if (refresh) { refresh.addEventListener('click', function () { location.reload(); }); }

	/* 页面桥（宿主注入的 vssarosDsh）。
	   ⚠ 变量名**必须**叫 bridge：接线守卫（dshPageCommandWiring.test.ts 的 ③）按 bridge.<方法名>( 这个
	   **字面形态**采集本页的调用点 —— 换个名字，本页的所有桥调用就落进守卫盲区（点了没反应也没人拦 ✗）。
	   ⚠⚠ 本段整体是 JS 模板字符串：注释里**不许出现反引号**（会提前闭合整页 —— 这一刀我又踩了一次 ✗）。 */
	var bridge = window.vssarosDsh;

	/* 标题栏那个 ↗：把**本页**在编辑区打开（宿主按模块页表核对 /x/skills/）。
	   用法与主页 / codebase 的 sideview 同款：有桥用桥，桥抛错（老桥没这条命令）退化成整页跳转，
	   完全没桥（纯浏览器）则新标签页打开 ✓。 */
	function openFullFrom(btn) {
		// 点下去先给反馈：原生宿主打开编辑器有一拍延迟，不给反馈就还是"点了没反应" ✗
		if (btn.classList) { btn.classList.add('busy'); }
		var label = btn.querySelector('.sk-hero-t');
		if (label) { label.textContent = '正在编辑区打开…'; }
		if (bridge && typeof bridge.openModulePage === 'function') {
			try { bridge.openModulePage(location.pathname); return; } catch (e) { /* 回落见上 */ }
		}
		if (bridge) { location.href = location.pathname; return; }
		window.open(location.pathname, '_blank', 'noopener');
	}
	Array.prototype.slice.call(root.querySelectorAll('[data-sk-open-full]')).forEach(function (btn) {
		btn.addEventListener('click', function () { openFullFrom(btn); });
	});

	/* 置顶主入口：打开 VsSaros 的**技能商城**（编辑区页 SkillMarketEditorInput）。页面自己开不了
	   编辑器 ⇒ 请宿主代劳（桥 openSkillMarket，2026-10-15 新增，协议 8 → 9）。
	   退化链是刻意的：桥里没这条命令（老宿主）⇒ 退成「把本页在编辑区打开」，**至少不是死按钮** ✓。 */
	var market = root.querySelector('[data-sk-skill-market]');
	if (market) {
		market.addEventListener('click', function () {
			market.classList.add('busy');
			var label = market.querySelector('.sk-hero-t');
			if (label) { label.textContent = '正在打开技能商城…'; }
			if (bridge && typeof bridge.openSkillMarket === 'function') {
				try { bridge.openSkillMarket(); return; } catch (e) { /* 落回下面那两级 */ }
			}
			if (bridge && typeof bridge.openModulePage === 'function') {
				try { bridge.openModulePage(location.pathname); return; } catch (e) { /* 再落一级 */ }
			}
			location.href = location.pathname;
		});
	}

	/* 设置齿轮（2026-10-15，桥 9 → 10）：**技能行**与**MCP 段的服务器/工具行**都带 [data-sk-settings]
	   ⇒ 在这里**一处**处理（MCP 段由另一个插件渲染，它没有自己的页内 JS，只能由本页代劳 ✓）。
	   用**捕获阶段 + stopPropagation**：技能行自己有个"点开抽屉"的 click（挂在那行上），不拦的话点齿轮
	   会顺带把抽屉展开 ✗（捕获先于行自己的监听器 ⇒ 拦得住 ✓）。
	   退化链与上面两条同款：老宿主没有 openResourceSettings ⇒ 如实提示"宿主版本旧"，不做无意义的跳转 ✓。 */
	root.addEventListener('click', function (ev) {
		var t = ev.target;
		var btn = t && t.closest ? t.closest('[data-sk-settings]') : null;
		if (!btn) { return; }
		ev.preventDefault();
		if (ev.stopPropagation) { ev.stopPropagation(); }
		var kind = btn.getAttribute('data-sk-kind') === 'mcp' ? 'mcp' : 'skill';
		var id = btn.getAttribute('data-sk-id') || '';
		if (!id) { return; }
		if (bridge && typeof bridge.openResourceSettings === 'function') {
			btn.classList.add('busy');
			try { bridge.openResourceSettings(kind, id); return; } catch (e) { /* 落到下面的提示 */ }
		}
		var tip = btn.getAttribute('title') || '';
		btn.setAttribute('title', (bridge && bridge.openResourceSettings ? '打开设置失败' : '宿主版本较旧，不支持"打开设置"') + (tip ? '（' + tip + '）' : ''));
	}, true);

	applyFilter();
})();
`;

/** 激活方式 → 行内小标签（三档与 `core/skills.js` 的 ACTIVATION_POLICY 一一对应）。 */
function activationTag(activation) {
	if (activation === 'auto') { return '<span class="sk-tag auto">auto</span>'; }
	if (activation === 'always') { return '<span class="sk-tag always">always</span>'; }
	return '<span class="sk-tag man">manual</span>';
}

/** 激活方式 → 一句人话（抽屉里用；manual 必须说清"模型不会自己取"）。 */
function activationWord(activation) {
	if (activation === 'auto') { return '模型可挑（也会出现在模型视野里）'; }
	if (activation === 'always') { return '每轮注入（dsh 侧只保证可取，不自动注入）'; }
	return '手动调用（只有 /skill <id> 能取）';
}

function renderPage({ skills, errors, missing, root, nativeSkillTool, provider, skillishTools, mcpSection }) {
	const summary = summarizeCatalog(skills);
	const rows = skills.map(s => {
		const id = skillIdOf(s.path);
		const extra = [s.metadata?.category, s.metadata?.version].filter(Boolean).join(' · ');
		// `data-skill-row` / `data-skill-id` 是**脚本与探针共同的抓手** ⇒ 不许改名，也不许把别的属性插到
		// `data-skill-row ` 前面（p3-04 数的是 /<li data-skill-row / 这个字面前缀 ✓）。
		return `<li data-skill-row data-skill-id="${escapeHtml(id)}" data-act="${escapeHtml(s.activation)}" class="sk-row" title="${escapeHtml(s.description)}">`
			+ '<i class="sk-bar"></i>'
			+ `<div class="sk-main"><div class="sk-l1"><span class="sk-nm">${escapeHtml(s.name)}</span>`
			+ `<span class="sp">${activationTag(s.activation)}${extra ? ` <span class="sk-tag ver">${escapeHtml(extra)}</span>` : ''}</span></div>`
			+ `<div class="sk-ds">${escapeHtml(s.description)}</div></div>`
			// 设置齿轮（2026-10-15，桥 `9 → 10`）：点了请宿主打开**资源管理详情页**（改 SKILL.md / 启停 / 卸载）。
			// ⚠ 它是 `.sk-row` 内部的按钮 ⇒ 点击必须 `stopPropagation`（否则会同时把抽屉展开 ✓）。
			// 触发逻辑在页尾那段**委派**处理器里（`[data-sk-settings]`）—— MCP 段（另一插件渲染的行）也带同样的
			// 属性 ⇒ 一处处理两类 ✓（那边没有自己的页内 JS，只能由本页代劳 ✓）。
			+ `<button type="button" class="sk-gear" data-sk-settings data-sk-kind="skill" data-sk-id="${escapeHtml(id)}" title="设置（在编辑区修改这个技能）">\u2699</button>`
			+ '<span class="sk-arrow">\u203A</span></li>'
			+ `<li class="sk-drawer" data-skill-detail hidden><dl><dt>激活</dt><dd>${activationWord(s.activation)}</dd>`
			+ `<dt>技能 id</dt><dd><code>${escapeHtml(id)}</code></dd></dl>`
			+ '<pre class="sk-pre" data-sk-body>展开时按 id 取正文（与模型 skill 工具拿到的是同一段）。</pre></li>';
	}).join('');
	const list = missing
		? `<p class="sk-empty">技能目录还不存在：<code>${escapeHtml(missing)}</code><br>在 VsSaros 里装过技能后这里会出现。</p>`
		: (rows ? `<ul class="sk-list">${rows}</ul>` : '<p class="sk-empty">技能目录里还没有可用的技能（每个子目录需要一个带 name / description 的 SKILL.md）。</p>');

	// 跳过的条目：**原文照列**（用户与探针都靠它看"为什么没生效"）—— 收在底部「详情」块里
	//（2026-10-14 按要求撤掉了「问题」页签；探针读的是 HTML 文本、不看可见性 ⇒ 放隐藏块里照样成立 ✓）。
	const problems = `<h2 class="sk-h">跳过的条目 <small>${errors.length}</small></h2>`
		+ (errors.length
			? `<ul class="sk-errors">${errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>`
			: '<p class="sk-empty">没有被跳过的条目 —— 目录里每一条都被 dsh 接收了。</p>');

	// 诊断原文（**逐字保留**：探针读的就是这几句）—— 现在默认收在底部「详情」里，不再横在标题下。
	// ⚠ 未注册时**直接印 reason**：它自己就写着"尚未注册（等待 ctx.skills）"，外面再套一层"未注册（）"会叠成双括号。
	const diag = `技能来源：<code>${escapeHtml(PROVIDER_NAME)}</code> ${provider.registered ? '已注册到 ctx.skills' : escapeHtml(provider.reason)}`
		+ ` · 原生 skill 工具（取正文）：${nativeSkillTool ? '在' : `不在（注册表里含 skill 的工具名：${skillishTools.length ? escapeHtml(skillishTools.join(' / ')) : '一个都没有'}）`}`
		+ ` · 检索工具 skill_search：${skillishTools.includes('skill_search') ? '在' : '不在（未装 dsh-tools，或本模块的 tools 注入没生效）'}`
		+ ` · 目录：<code>${escapeHtml(root)}</code>`;
	const searchToolOk = skillishTools.includes('skill_search');

	return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>工具 · VsSaros</title>
<style>
	/* ⚠ 本段在模板字符串里：注释与文案里都不能出现反引号（会提前闭合整页）。 */
	:root { color-scheme: light dark; }
	html, body { height: 100%; }
	body { margin: 0; display: flex; flex-direction: column; overflow: hidden; font: 13px/1.55 system-ui, "Segoe UI", sans-serif; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #1e1e1e); }
	[hidden] { display: none !important; }
	/* ── 视图外壳（2026-10-15 用户选「仪表盘卡」方案：骨架照 codebase / 记忆库 sideview 那一族 —
	   标题栏 35px + 面板栏 30px + 内容滚动区；本插件没有 pageShell.js，所以这一小段在这里就地实现 ✓）── */
	.sk-view { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; }
	.sk-header { display: flex; align-items: center; gap: 4px; padding: 0 4px 0 10px; height: 35px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
	.sk-title { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; opacity: .8; }
	.sk-spacer { flex: 1; }
	.sk-hbtn { width: 26px; height: 26px; display: flex; align-items: center; justify-content: center; font: inherit; font-size: 14px; line-height: 1; color: inherit; background: none; border: 1px solid transparent; border-radius: 4px; cursor: pointer; padding: 0; }
	.sk-hbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
	.sk-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
	.sk-panel-bar { display: flex; align-items: center; gap: 4px; padding: 0 10px; height: 30px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; opacity: .8; }
	.sk-note { font-weight: 400; text-transform: none; letter-spacing: 0; }
	.sk-panel-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 0 12px; }
	/* ── 仪表盘统计卡（「数字优先」的那三格；零值灰显，照 kbView.css 的 statCell 口径）── */
	.sk-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 8px 10px 4px; }
	.sk-stat { min-width: 0; padding: 9px 10px; border-radius: 8px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
	.sk-stat.zero { opacity: .55; }
	.sk-stat-v { font-size: 19px; font-weight: 700; line-height: 1.1; }
	.sk-stat-k { margin-top: 2px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	/* ── 主入口（仪表盘的置顶高亮入口：在编辑区打开完整版）── */
	.sk-hero { display: flex; align-items: center; gap: 10px; width: calc(100% - 20px); margin: 6px 10px 8px; padding: 10px 12px; font: inherit; text-align: left; color: inherit; cursor: pointer; background: var(--vscode-editorWidget-background, rgba(128,128,128,.08)); border: 1px solid var(--vscode-focusBorder, #007acc); border-radius: 8px; }
	.sk-hero:hover { filter: brightness(1.08); }
	.sk-hero.busy { opacity: .6; pointer-events: none; }
	.sk-hero-ico { flex: 0 0 auto; font-size: 15px; }
	.sk-hero-tx { flex: 1; min-width: 0; }
	.sk-hero-t { display: block; font-weight: 600; }
	.sk-hero-m { display: block; margin-top: 1px; font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
	.sk-hero-arrow { flex: 0 0 auto; color: var(--vscode-focusBorder, #007acc); }
	.sk-seg { display: flex; margin: 0 10px 6px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 6px; overflow: hidden; }
	.sk-seg button { flex: 1; font: inherit; font-size: 12px; padding: 3px 0; background: transparent; color: var(--vscode-descriptionForeground, #999); border: 0; cursor: pointer; }
	.sk-seg button + button { border-left: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
	.sk-seg button.on { background: var(--vscode-button-background, #0e639c); color: var(--vscode-button-foreground, #fff); }
	.sk-search { display: flex; align-items: center; gap: 5px; margin: 0 10px 6px; background: var(--vscode-input-background, #313131); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 4px; padding: 2px 6px; }
	.sk-search input { flex: 1; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; padding: 2px 0; min-width: 0; }
	.sk-search span { color: var(--vscode-descriptionForeground, #999); font-size: 11px; flex: 0 0 auto; }
	/* ── 技能行：卡片质感（仪表盘骨架下的「一卡一条」；色条仍在最左表激活方式）──
	   ⚠ .sk-nm / .sk-ds 这两条的声明**必须**与 MCP 侧的 .sk-pane-mcp li .id / li small 逐字相等
	   （p3-04 有一条断言逐项比对字号/字体/截断 —— 改一边就要改另一边 ✗）。
	   ⚠⚠ 注释里**不许出现反引号**：本段整体是 JS 模板字符串，一个反引号就会提前闭合它
	   （这一刀我正好踩了：写了四个反引号 ⇒ node --check 报 Unexpected identifier ✗）。 */
	.sk-list { list-style: none; margin: 0; padding: 0 8px; display: flex; flex-direction: column; gap: 4px; }
	.sk-row { display: flex; gap: 8px; align-items: center; padding: 7px 10px 7px 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.05)); cursor: pointer; overflow: hidden; }
	.sk-row:hover, .sk-row.open { border-color: var(--vscode-focusBorder, #007acc); }
	/* 设置齿轮（2026-10-15）：平时半隐（行内不抢戏），行 hover / 键盘聚焦时显出来；点击不触发行的抽屉 ✓ */
	.sk-gear { flex: 0 0 auto; width: 22px; height: 22px; margin-left: 2px; display: flex; align-items: center; justify-content: center; font: inherit; font-size: 13px; line-height: 1; color: var(--vscode-descriptionForeground, #999); background: none; border: 0; border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity .12s ease; }
	.sk-row:hover .sk-gear, .sk-row:focus-within .sk-gear, .sk-gear:focus { opacity: 1; }
	.sk-gear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); color: var(--vscode-foreground, #ccc); }
	.sk-gear.busy { opacity: 1; }
	.sk-bar { flex: 0 0 3px; align-self: stretch; background: var(--vscode-panel-border, rgba(128,128,128,.45)); }
	.sk-row[data-act="auto"] .sk-bar { background: var(--vscode-charts-green, #3fb950); }
	.sk-row[data-act="always"] .sk-bar { background: var(--vscode-charts-purple, #b180d7); }
	.sk-main { flex: 1; min-width: 0; }
	.sk-l1 { display: flex; align-items: baseline; gap: 6px; }
	.sk-nm { font-weight: 600; font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-l1 .sp { margin-left: auto; flex: 0 0 auto; }
	.sk-ds { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-arrow { flex: 0 0 auto; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	/* 抽屉与上面的行**贴合成一张卡**：负 margin 吃掉 gap，顶边不描（用行的下边）✓ */
	.sk-drawer { margin: -4px 8px 0; padding: 8px 10px 9px 21px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-top: 0; border-radius: 0 0 6px 6px; background: rgba(128,128,128,.06); }
	.sk-drawer dl { display: grid; grid-template-columns: 52px 1fr; gap: 2px 8px; margin: 0 0 4px; }
	.sk-drawer dt { color: var(--vscode-descriptionForeground, #999); }
	.sk-drawer dd { margin: 0; color: var(--vscode-foreground, #ccc); overflow-wrap: anywhere; }
	.sk-pre { margin: 4px 0 0; padding: 7px 8px; background: var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 190px; overflow: auto; color: var(--vscode-foreground, #ccc); }
	.sk-h { font-size: 11px; margin: 8px 10px 6px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground, #999); }
	.sk-h small { color: var(--vscode-foreground, #ccc); }
	.sk-errors { list-style: none; margin: 0; padding: 0; }
	.sk-errors li { padding: 4px 10px; border-bottom: 1px solid rgba(128,128,128,.15); font-size: 11.5px; overflow-wrap: anywhere; }
	/* ── MCP 片段（由 @vssaros/dsh-mcp 提供，本页只做内嵌）────────────────────────────────
	   ⚠ 这里**不解析**它的 HTML（解析别人的结构 = 它一改我们就静默走样 ✗），只用**作用域 CSS** 把它排成
	   与技能行同款的 item 列表。片段结构万一变了，最坏是回到"没排版的文档样"，不会报错。
	   ⚠ 共用语义槽（片段侧与这里约定）：ul = 列表 · li = 一行 · .id = 名称 · small = 描述 · code = 端点。
	   ⚠⚠ 2026-10-15（用户**第二次**要求"MCP 的 item 与技能 item 一致"）：上一轮只把**字体/截断**六项进了
	   p3-04 的对账 ⇒ 技能行后来改成**卡片**（边框 / 圆角 / 背景）时 MCP 仍是无边框的普通行、**静默走样** ✗。
	   本轮把 li 的外壳做成同一套卡片，并把**壳声明**（border-radius / background / overflow）也加进对账 ✓ ——
	   以后改一边就红，不再靠人眼看。技能行的色条是独立元素（i.sk-bar）而片段里没有那个元素 ⇒ 这里用
	   border-left 画一条**同宽同灰**的条，保证"卡片形态"一致（灰色是中性的，不冒充任何激活语义 ✓）。 */
	.sk-pane-mcp { padding: 0 0 6px; }
	.sk-pane-mcp ul { list-style: none; margin: 0; padding: 0 8px; display: flex; flex-direction: column; gap: 4px; }
	.sk-pane-mcp li { display: flex; flex-direction: column; gap: 1px; padding: 7px 10px 7px 8px; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-left: 3px solid var(--vscode-panel-border, rgba(128,128,128,.45)); border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.05)); overflow: hidden; }
	.sk-pane-mcp li:hover { border-color: var(--vscode-focusBorder, #007acc); border-left-color: var(--vscode-panel-border, rgba(128,128,128,.45)); }
	.sk-pane-mcp li .id { font-weight: 600; font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-pane-mcp li small { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-pane-mcp li code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-pane-mcp h2 { font-size: 11px; font-weight: 600; margin: 8px 10px 6px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground, #999); }
	.sk-pane-mcp h2 small { color: var(--vscode-foreground, #ccc); font-weight: 400; }
	.sk-pane-mcp .diag { color: var(--vscode-descriptionForeground, #999); font-size: 11px; margin: 0 10px 4px; overflow-wrap: anywhere; }
	.sk-pane-mcp section { margin: 0; padding: 0; border: 0; }
	.sk-pane-mcp .empty { color: var(--vscode-descriptionForeground, #999); font-size: 12px; margin: 0; padding: 14px 10px; }
	/* 设置齿轮（2026-10-15，桥 9 → 10）：MCP 段的服务器行 / 工具行也带 [data-sk-settings]，
	   交互由本页那段**委派**处理器负责 ✓（片段来自另一个插件、没有自己的 JS）—— 观感与技能行一致：平时半隐、
	   hover/focus 显出来 ✓。 */
	.sk-pane-mcp li .sk-gear { flex: 0 0 auto; margin-left: auto; }
	.sk-pane-mcp li:hover .sk-gear, .sk-pane-mcp li:focus-within .sk-gear { opacity: 1; }
	.sk-empty { color: var(--vscode-descriptionForeground, #999); padding: 14px 10px; font-size: 12px; margin: 0; }
	.sk-meta { margin-top: 8px; padding: 8px 10px 4px; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.sk-ln { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
	.sk-ln + .sk-ln { margin-top: 3px; }
	.sk-dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto; background: var(--vscode-charts-green, #3fb950); }
	.sk-dot.warn { background: var(--vscode-charts-yellow, #cca700); }
	.sk-more-wrap { padding: 0 10px; }
	.sk-more { font: inherit; font-size: 11px; color: var(--vscode-textLink-foreground, #4daafc); background: none; border: 0; padding: 3px 0 0; cursor: pointer; }
	.sk-detail { margin-top: 4px; }
	.sk-detail .diag { color: var(--vscode-descriptionForeground, #999); font-size: 11px; margin: 0; overflow-wrap: anywhere; }
	.sk-tag { display: inline-block; font-size: 10px; line-height: 15px; padding: 0 5px; border-radius: 3px; background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff); vertical-align: 1px; white-space: nowrap; }
	.sk-tag.man { background: transparent; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); color: var(--vscode-descriptionForeground, #999); }
	.sk-tag.auto { background: var(--vscode-charts-green, #3fb950); color: #fff; }
	.sk-tag.always { background: var(--vscode-charts-purple, #b180d7); color: #fff; }
	.sk-tag.ver { background: transparent; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); color: var(--vscode-descriptionForeground, #999); }
	code { font-family: ui-monospace, Consolas, monospace; }
</style>
</head>
<body data-vssaros-page="skills" data-vssaros-skills-mcp-section="${mcpSection.state}" data-vssaros-skills-preview="enabled">
<div class="sk-view">
	<div class="sk-header">
		<span class="sk-title"><span>\u{1F9E9}</span><span>工具</span></span>
		<span class="sk-spacer"></span>
		<button type="button" class="sk-hbtn" data-sk-refresh title="重新加载">\u21BB</button>
		<button type="button" class="sk-hbtn" data-sk-open-full title="在编辑区打开本页">\u2197</button>
	</div>
	<div class="sk-panel">
		<div class="sk-panel-bar"><span>工具</span><span class="sk-spacer"></span><span class="sk-note">只读 · ${escapeHtml(PROVIDER_NAME)}</span></div>
		<div class="sk-panel-content">
			<div class="sk-stats">
				<div class="sk-stat${summary.count ? '' : ' zero'}"><div class="sk-stat-v">${summary.count}</div><div class="sk-stat-k">技能</div></div>
				<div class="sk-stat${summary.byActivation.manual ? '' : ' zero'}"><div class="sk-stat-v">${summary.byActivation.manual ?? 0}</div><div class="sk-stat-k">手动调用</div></div>
				<div class="sk-stat${errors.length ? '' : ' zero'}"><div class="sk-stat-v">${errors.length}</div><div class="sk-stat-k">被跳过</div></div>
			</div>
			<button type="button" class="sk-hero" data-sk-skill-market>
				<span class="sk-hero-ico">\u{1F6D2}</span>
				<span class="sk-hero-tx"><span class="sk-hero-t">技能商城</span><span class="sk-hero-m">浏览 / 安装技能 · 在编辑区打开 VsSaros 技能市场</span></span>
				<span class="sk-hero-arrow">\u203A</span>
			</button>
			<div class="sk-seg">
				<button type="button" data-sk-tab="skills" class="on">技能 ${summary.count}</button>
				<button type="button" data-sk-tab="mcp">MCP</button>
			</div>
			<div class="sk-search" data-sk-search-wrap><span>\u{1F50D}</span><input data-sk-search placeholder="按名称 / 描述筛选" aria-label="筛选技能"><span data-sk-count>${summary.count}/${summary.count}</span></div>
			<div data-sk-pane="skills">${list}</div>
			<div data-sk-pane="mcp" hidden><div class="sk-pane-mcp">${mcpSection.html}</div></div>
			<div class="sk-meta">
				<div class="sk-ln"><i class="sk-dot${provider.registered ? '' : ' warn'}"></i><span>来源 ${escapeHtml(PROVIDER_NAME)}${provider.registered ? ' 已注册' : ' 未注册'}</span><span>· ${errors.length ? `${errors.length} 条被跳过` : '没有被跳过'}</span><span>· 检索工具 ${searchToolOk ? '在' : '不在'}</span></div>
				<div class="sk-ln"><span>Skills ${summary.count} 个（manual ${summary.byActivation.manual ?? 0} / auto ${summary.byActivation.auto ?? 0} / always ${summary.byActivation.always ?? 0}）· 只读</span></div>
			</div>
			<div class="sk-more-wrap"><button type="button" class="sk-more" data-sk-more aria-expanded="false">详情</button></div>
			<div class="sk-detail" data-sk-detail hidden><p class="diag">${diag}</p>${problems}</div>
		</div>
	</div>
</div>
<div hidden data-vssaros-skills-provider="${provider.registered ? 'registered' : 'absent'}" data-vssaros-skill-count="${summary.count}" data-vssaros-skills-root="${escapeHtml(root)}" data-vssaros-native-skill-tool="${nativeSkillTool ? 'present' : 'absent'}" data-vssaros-skill-search="${searchToolOk ? 'present' : 'absent'}" data-vssaros-skill-tools="${escapeHtml(skillishTools.join(','))}"></div>
<script data-vssaros-skills-preview-script="">${SKILL_PREVIEW_SCRIPT}</script>
</body>
</html>`;
}


/** 自动加载注入消息的 `source.kind`（自定义值；**不新增会话事件类型**，与 `vssaros/persona` 同一做法）。 */
export const SKILL_AUTOLOAD_SOURCE_KIND = 'vssaros/skill-autoload';

/** 单次注入的正文上限（防御：正文异常大时别一次把上下文打满）。 */
const SKILL_AUTOLOAD_MAX_BODY = 60_000;

/**
 * 动态加载 dsh 官方的 `createUserMessage`。
 * ⚠ 必须**裸包名**：插件是独立安装的包，profile 里没有跨包解析路径 ⇒ 不能 import 别的插件的文件，
 *   但 dsh 官方包可以（运行时由 dsh 的 node_modules 解析）—— `vssaros-agents` 的 `loadCreateUserMessage` 同做法。
 */
async function loadCreateUserMessage() {
	try {
		const mod = await import('@deepseek-ai/dsh-llm');
		return typeof mod?.createUserMessage === 'function' ? mod.createUserMessage : undefined;
	} catch {
		return undefined;
	}
}

/** 从一条 message 取文本（content 可能是 string 或块数组）。 */
function skillAutoloadTextOf(message) {
	const content = message?.content;
	if (typeof content === 'string') { return content; }
	if (Array.isArray(content)) {
		return content.map(part => (typeof part === 'string' ? part : (part?.text ?? ''))).join('\n');
	}
	return '';
}

/**
 * 「技能自动加载」（`config.skillAutoload`，缺省 = 空 = **完全不介入**）。
 *
 * 做法与 dsh 官方 catalog 完全同一条路：`agent/pre-step` 往 `decision.messages` 追加一条 **user** 消息。
 * 为什么不能在 systemPrompt：见本函数上方的注释与 `vssaros-agents/lib/core/persona.js` 头注释（dsh 规范硬约束）。
 */
/**
 * 把「自动加载发生了」**落盘**。
 *
 * 为什么必须落盘（2026-10-19 实测）：dsh 的**会话正文不落盘**（`session_projcache` 只有 rows 摘要），
 * 插件的 `ctx.logger.info` 也**不进 main.log** ⇒ 不加这一行，"到底注入没注入"在生产上**永远查不到** ✗
 * （本轮就是这样：配置链确认就位，但日志里零命中，无法判断是"没生效"还是"没记录"）。
 *
 * 落点 `<dataRoot>/skill-autoload.log`（与 `.agentmemory/gateway.log` 同一层）。
 * ⚠ 失败不影响注入本身。
 */
async function logAutoload(config, line, deps = {}) {
	try {
		const writer = deps.appendLog ?? appendFile;
		await writer(join(autoloadLogRoot(config), 'skill-autoload.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
	} catch { /* 日志失败不能影响注入 */ }
}

/**
 * 日志落点根目录 —— **不能直接用 `dataRootOf(config)`**。
 *
 * ★★ 2026-10-19 真机踩到：`dataRootOf()` 是 `foundation().dataRootOf(config)`，
 *   而 `foundation()` 在**服务未绑定**时是 **抛错**（不是返回默认值 ✓ 见 foundationRef.js:24-31）。
 *   绑定的时机是 `ctx.inject(['vssarosFoundation'], …)` —— **异步**，比 `apply()` 里的同步调用晚
 *   ⇒ 于是"注入时的日志"永远抛错、被 catch 吞掉 ⇒ **`skill-autoload.log` 一次都没生成过** ✗
 *   （我一度因此误判成"注入没发生"，其实只是没留痕 ✓）。
 *
 * 兜底顺序：`config.dataRoot` → `dataRootOf()` → `~/.vssaros-dev`。
 * ⚠ 这里只用于**日志**：解析失败退回 home 下的默认根，不影响真正的数据根选择 ✓。
 */
function autoloadLogRoot(config) {
	const configured = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : '';
	if (configured) { return configured; }
	try {
		return dataRootOf(config);
	} catch { /* foundation 尚未绑定（apply 阶段正常现象）⇒ 退回默认根 */ }
	return join(homedir(), '.vssaros-dev');
}

/**
 * 从**本包自己的 `cordis.patch.yml`** 里读出 `skillAutoload` 列表。
 *
 * ★★ 2026-10-20 真机（用户反复问「为什么没使用 understand 技能」）：
 *   `skill-autoload.log` 里只有 10-19 的两条 `boot`，新 Host（10:36 启动、已装 0.7.3）**一条都没有**
 *   ⇒ 因为 `installSkillAutoload` 在 `always.length === 0` 处直接 `return`，
 *     连 boot 日志都打不出来 ✗（所以看起来像"插件没加载"，其实是"配置是空的"）。
 *
 *   空的原因：`cordis.presets.yml` 里已经声明了 `- id: vssaros-skills`（**无 config**），
 *   于是 `cordis.patch.yml` 的 `insert`（带 `config.skillAutoload`）因 **id 已存在被跳过**
 *   ⇒ `apply(ctx, {})` ⇒ `config.skillAutoload` 是 undefined
 *   （`vssaros-kb` 的 `kb_list keys=[]` 是同一个根因 ✓）。
 *
 *   ⇒ 不跟 dsh 的 patch 语义较劲：**读自己包里的 patch 文件**拿默认值。
 *     配置哪天真能传进来时，`config.skillAutoload` 依然优先 ✓。
 *   ⚠ patch 文件里这段很小（`skillAutoload:` + 若干 `- name`），用手写小解析就够，
 *     不值得为它引一个 YAML 依赖。
 */
function skillAutoloadFromOwnPatch() {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const text = readFileSync(join(here, '..', 'cordis.patch.yml'), 'utf8');
		const lines = text.split(/\r?\n/);
		const start = lines.findIndex(line => /^\s*skillAutoload:\s*$/.test(line));
		if (start < 0) { return []; }
		const out = [];
		for (let i = start + 1; i < lines.length; i++) {
			const item = /^\s*-\s+([A-Za-z0-9_.-]+)\s*(?:#.*)?$/.exec(lines[i]);
			if (!item) { break; }   // 列表到此结束（下一条配置/空行）
			out.push(item[1]);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * 本进程内**已注入过技能正文的 agent**。
 *
 * ★★ 2026-10-20（真机日志：同一 session 在 08:58:02 / 05 / 10 / 33 连续 `inject` 了 4 次，每次 3301 字节）：
 *   幂等判据（扫消息里有没有 `<skill_content name="x"`）**在这里失效** —— `enter` 日志显示
 *   `messages=0`，即 pre-step 的入参里根本没有历史消息 ⇒ 每次都当成"首次" ⇒ 重复注入 ✗
 *   ⇒ 后果是上下文随轮次线性膨胀（10 轮对话 = 33 KB 同样的正文重复），既费 token 也让模型困惑。
 *   ⇒ 用 agent 对象本身做键，**每个会话只注一次**。
 *   ⚠ 用 `WeakSet` 而不是 `Set`：Host 长跑时会话对象会被回收，`Set` 会一直持有它们（内存泄漏）。
 *   ⚠ Host 重启后标记消失 ⇒ 同一会话会**重新注入一次** —— 这是可接受的：进程都换了，
 *     模型本来也需要重新拿到正文 ✓。
 */
const injectedAgents = new WeakSet();

export function installSkillAutoload(ctx, config, deps = {}) {
	const fromConfig = Array.isArray(config?.skillAutoload)
		? config.skillAutoload.filter(name => typeof name === 'string' && name.trim()).map(name => name.trim())
		: [];
	// config 优先（将来 dsh 修好、或用户在 overlay 里显式配置都走这里）；空则读自己包里的 patch。
	// ⚠ `deps.autoloadFallback` 只为可测性：smoke 里那些"空配置 ⇒ 不注入"的用例，
	//   若走真实兜底会读到包里的 patch 而意外注入 ⇒ 必须能替换成 `() => []` ✓。
	const fallback = deps.autoloadFallback ?? skillAutoloadFromOwnPatch;
	const always = fromConfig.length > 0 ? fromConfig : fallback();
	if (always.length === 0) { return; }

	// ★ 2026-10-19：**boot 日志**。没有它就只能看到"没有 inject 日志"，无法区分
	//   「插件根本没加载 / skillAutoload 没传进来」和「加载了但 pre-step 没触发」✗
	//   （真机就是这么卡住的：日志一条都没有，只能靠猜 ✓）。
	//   ⚠ 落点见 autoloadLogRoot：**绕开 foundation**（apply 阶段它还没绑定 ✓）。
	void logAutoload(config, `boot skills=${always.join(',')}`, deps);

	const warned = new Set();
	const warn = (key, text) => {
		if (warned.has(key)) { return; }
		warned.add(key);
		try { ctx.logger?.warn?.(`[skill-autoload] ${text}`); } catch { /* logger 不可用 ⇒ 静默 */ }
	};

	ctx.effect(() => {
		// ★★ 2026-10-20（真机：boot 有 50 行、enter 一行都没有）：`boot` 能写说明执行流**过了**
		//   `if (always.length === 0) return;` 那道闸 ⇒ 下面这行注册代码**一定被执行到**。
		//   但如果连这行 `registered` 都没出现，就说明 `ctx.effect` 的回调**没被调用**
		//   （作用域/生命周期问题，而不是事件没触发）。
		//   三行日志因此能精确分段：boot（apply 到了）→ registered（effect 回调跑了）→ enter（事件到了）。
		//
		// ★★★ 2026-10-20 **真根因（命中）**：`agent/pre-step` 是 **agent 作用域**的事件
		//   （dsh 声明是 `this: Scoped<Agent>`）。对照内置 `time-context` 插件 ——
		//   它写的是 `export const inject = ['agents']`，即在**有 agents 服务的作用域**里注册；
		//   而本插件此前**没有把 `ctx.on` 架到那个作用域**（直接挂在根 ctx 上）
		//   ⇒ `apply()` 跑得通（boot 有日志），但 **pre-step 事件到不了这里**（enter 永远不来）✓
		//   ⇒ 用 `ctx.inject(['agents'], scope => …)` 把监听挂进去。
		//   ⚠ 为什么不用顶层 `export const inject = ['agents']`：那会让**整个插件**依赖 agents 服务
		//     ⇒ 无 agent 的 profile（headless / 精简模板）里本插件不再激活，而它还要注册技能目录/工具
		//     （见文件头注释：三个注册都走可选依赖 ⇒ 任何 profile 都能激活 ✓）。
		//     用 `ctx.inject` 只在**有该服务时**挂这段，其余功能不受影响 ✓。
		ctx.inject(['agents'], scope => scope.effect(() => {
			void logAutoload(config, `registered skills=${always.join(',')}`, deps);
			const autoloadHandler = async ({ agent, messages, signal }, next) => {
		// ★★ 2026-10-20 真机：`skill-autoload.log` 里**只有 boot、没有 inject** ⇒
		//   无法区分"pre-step 压根没触发"和"触发了但被幂等跳过/注入失败" ✗。
		//   这里**进入 handler 就落一行**（每轮一行，量很小）⇒ 下一次就能定性：
		//     · 连 enter 都没有 ⇒ 事件名/注册时机不对（插件层解决不了，要看 dsh 侧）
		//     · 有 enter 没有 inject ⇒ 是幂等判据或技能读取的问题（本文件内可修）
		void logAutoload(config, `enter session=${agent?.session?.id ?? agent?.id ?? '(unknown)'} messages=${Array.isArray(messages) ? messages.length : '?'}`, deps);
		// ★ 2026-10-20：**本进程已注入过这个 agent ⇒ 直接放行**（见 injectedAgents 的注释）。
		//   放在最前面短路：省掉后续的幂等扫描与技能读取（`next()` 仍要调，否则链路断）。
		if (agent && injectedAgents.has(agent)) {
			void logAutoload(config, `skip session=${agent?.session?.id ?? agent?.id ?? '(unknown)'}（本进程已注入过）`, deps);
			return next();
		}
		const decision = await next();
		if (decision.kind === 'reject') { return decision; }

		const current = Array.isArray(decision.messages) ? decision.messages : [];
		// 幂等：已有该技能的 `<skill_content name="x"` ⇒ 跳过（本插件注入的 / 模型自己用 `skill` 加载的都算）
		const present = new Set();
		for (const message of current) {
			const text = skillAutoloadTextOf(message);
			if (!text.includes('<skill_content')) { continue; }
			for (const name of always) {
				if (!present.has(name) && text.includes(`<skill_content name="${name}"`)) { present.add(name); }
			}
			if (present.size === always.length) { break; }
		}
		const todo = always.filter(name => !present.has(name));
		if (todo.length === 0) { return decision; }

		// `deps.createUserMessage` 只为可测性（离线 smoke 在仓库根跑，解析不到 dsh 的包 ⇒ 动态 import 会失败）
		const createUserMessage = deps.createUserMessage ?? await loadCreateUserMessage();
		if (!createUserMessage) {
			warn('factory', '拿不到 createUserMessage（@deepseek-ai/dsh-llm 不可解析）⇒ 本轮不注入');
			return decision;
		}
		// ★★ 2026-10-20（真机：`cannot get property "skills" without inject`）：
		//   这里原先直接读 **`ctx.skills`** —— 而 `installSkillAutoload` 是在 apply 里
		//   **裸调**的（不在 `ctx.inject(['skills'], …)` 内）⇒ cordis 对"未声明的服务"
		//   一律抛错（见 memory: cordis 里读未声明服务一定抛 ✗）。
		//   之前没暴露，纯粹是因为 handler 一次都没被调用过（作用域不对 ⇒ 走不到这里）；
		//   0.7.6 把监听挂进 agent 作用域后**第一次真的执行到这行**，于是当场炸 ✓
		//   ⇒ 改成从 `deps.skills` 取（由调用点的 `ctx.inject(['skills'], …)` 传进来）。
		let registry = deps.skills;
		if (!registry) {
			// ⚠ 这一段**只为测试/兼容**：真机上未声明 inject 时 `ctx.skills` 会**抛**
			//   （不是返回 undefined）⇒ 必须 try。生产路径恒先拿到 `deps.skills`
			//   （由调用点 `ctx.inject(['skills'], …)` 传入 ✓）。
			try { registry = ctx.skills; } catch { registry = undefined; }
		}
		if (!registry || typeof registry.get !== 'function') {
			warn('registry', 'skills 注册表不可用（deps.skills 缺失）⇒ 本轮不注入');
			return decision;
		}

		const lookup = { cwd: agent?.session?.header?.cwd, signal, scope: agent };
		const blocks = [];
		const injectedNames = [];
		for (const name of todo) {
			let skill;
			try {
				skill = await registry.get(name, lookup);
			} catch (e) {
				warn(`get:${name}`, `读取技能失败 ${name}：${String(e?.message ?? e)}`);
				continue;
			}
			if (!skill || typeof skill.content !== 'string' || skill.content.length === 0) {
				// 名字写错 / 目录没挂上 —— 必须说出来（否则又是"配了没反应"那种最难查的形态 ✗）
				warn(`missing:${name}`, `技能不存在或没有正文：${name}（检查 skillAutoload 的拼写与技能目录挂载）`);
				continue;
			}
			const body = skill.content.length > SKILL_AUTOLOAD_MAX_BODY
				? `${skill.content.slice(0, SKILL_AUTOLOAD_MAX_BODY)}\n…（正文过长，已截断）`
				: skill.content;
			blocks.push(`<skill_content name="${skill.name}">\n${body}\n</skill_content>`);
			injectedNames.push(skill.name);
		}
		if (blocks.length === 0) { return decision; }

		const message = createUserMessage({
			content: [{
				type: 'text',
				text: [
					'<system-reminder>',
					'以下技能的完整正文已按配置**自动加载**（vssaros-skill-autoload）。请直接遵循其中的指令；',
					'不要再用 `skill` 工具重复加载同名技能（重复加载只会白烧上下文）。',
					'',
					...blocks,
					'</system-reminder>',
				].join('\n'),
			}],
			source: { kind: SKILL_AUTOLOAD_SOURCE_KIND, form: 'instructions' },
		});
		// ★ 落盘（唯一可查的证据链：会话正文不落盘、logger 不进 main.log）
		const sessionId = agent?.session?.id ?? agent?.id ?? '(unknown)';
		const bytes = blocks.reduce((sum, b) => sum + b.length, 0);
		void logAutoload(config, `inject session=${sessionId} skills=${injectedNames.join(',')} bytes=${bytes}`, deps);
		// 注入成功 ⇒ 记下这个 agent（下次 pre-step 直接短路，不再重复注入）
		if (agent) { injectedAgents.add(agent); }
		try { ctx.logger?.info?.(`[skill-autoload] 注入 ${blocks.length} 个技能：${injectedNames.join(', ')}`); } catch { /* 忽略 */ }
			return { ...decision, messages: [...current, message] };
			};   // ← 闭合 autoloadHandler
			// ★★ 2026-10-20：**handler 内全局捕获**。背景：`enter` 出现过、`inject` 从未出现，
			//   而 UI 报 `cannot get property "skills" without inject` 却**没有任何栈落盘**
			//   （main.log / harness-*.log / renderer.log 三处都查过，全无）。
			//   handler 里抛的异常此前完全不可见 ⇒ 只能靠猜「是哪一行」✗。
			//   这里把**任何**未捕获异常连同栈写进 `skill-autoload.log`，然后**原样再抛**
			//   （不掩盖失败：dsh 仍需知道本轮失败 ✓）。
			return scope.on('agent/pre-step', async (payload, next) => {
				try {
					return await autoloadHandler(payload, next);
				} catch (e) {
					void logAutoload(config, `ERROR ${e?.stack ?? e?.message ?? String(e)}`, deps);
					throw e;
				}
			});
		}));           // ← 闭合 scope.effect(() => …) 与 ctx.inject(['agents'], …)
	});                // ← 闭合最外层 ctx.effect(() => …)
}

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	// ⚠ 状态**每次挂载一份**（见 `createState` 注释：preset plane 下同一个包会被多次挂载 ✓）
	const state = createState();
	// 桥（可选注入：vssarosBridge 不在 ⇒ 市场工具如实报"桥不在" ✓，其余照常 ✓）。
	ctx.inject(['vssarosBridge'], scope => {
		let svc = null;
		try { svc = scope.vssarosBridge ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (svc && typeof svc.callIDE === 'function') {
			state.bridge = svc;
			return () => { state.bridge = null; };
		}
		return undefined;
	});
	// ── R13（preset plane）第 ① 类：分半边注册 ────────────────────────────────────────────────
	// 同一个包会被挂**两次**（host plane 一行 + 我们的 preset 里一行 ✓）。`hostHalf: true` ⇒
	// 这一次**只**注册页面/技能来源，**不注册工具**（`skill_search` 交给 preset 里那次 ✓）；
	// 缺省（不写）⇒ **与从前完全一样** ✓（零行为改变）。可选的 `skills` provider 注入**不受影响** ✓：
	// 那是"技能来源"，两次挂载注册的是**同一个来源名**（幂等 ✓），而工具重复注册是**静默顶掉** ✓。
	const hostHalf = config.hostHalf === true;

	// ── 技能**自动加载**（★ 2026-10-19）──────────────────────────────────────────────
	// dsh 原生只有「`<available_skills>` 目录 + 按需 `skill` 工具」，是否加载**全靠模型自觉**
	// （实测几百个会话：`skill` 从未被主动调用；A 类"讲懂"请求 recall@1 只有 33%）。
	// 官方没有 `activation: always` / 预加载配置 ⇒ 在插件层补：会话首轮把配置的技能**完整正文**注入上下文。
	// ⚠ 只能 **user 角色**：`developer` 会被 `withoutDeveloperMessages()` 静默剔除，
	//   `system` 对应的 `system/message` 事件必须在打开的 step 内 ⇒ 插件写不进去（见 vssaros-agents/core/persona.js）。
	// ⚠ 幂等：消息里已出现 `<skill_content name="x"` 就跳过（我们注入的、模型自己 `skill` 加载的都算）。
	// ★ 2026-10-20：**在 `skills` 作用域里调用** —— 内部要用 `skills.get()` 读技能正文，
	//   而 cordis 不允许在未声明该服务的作用域里访问它（否则抛 `cannot get property "skills" without inject`）。
	//   传 `scope.skills` 进 deps，`installSkillAutoload` 内部就不再碰 `ctx.skills` ✓。
	//   ⚠ 没有 skills 服务的 profile 里这段不会执行（可选依赖语义 ⇒ 其余功能照常 ✓）。
	ctx.inject(['skills'], scope => installSkillAutoload(ctx, config, { skills: scope.skills }));

	// ★ 写入类工具的**审批闸**（报告 §R.7 第 ① 项 / README 5.103 同一把 ✓）：
	// 官方派发前决策钩子 `tools/pre-execute`（waterfall ✓）返回 `{ kind: 'ask' }` ＝"先问用户" ✓；
	// 契约：只有审批服务回 `allowed-once` 才执行 ✓、**没有审批支持的部署 degrade to deny** ✓。
	// 为什么技能写操作必须有闸：`skill_manage` 是**跨会话的程序性记忆** —— 模型可以不经确认就把
	// 一套"以后都这么做"的流程固化进用户的技能库 ✗，而它之后**每轮都会出现在目录里、被检索到** ✓
	//（"越写越多、越检索越相信自己"那类污染，与 `memory_remember` 同一性质 ✓）。
	// 参数无关：四种 action（create/edit/patch/delete）**全是写** ⇒ 只要调用就拦 ✓（不像 kb 那样带条件 ✓）。
	ctx.effect(() => ctx.on('tools/pre-execute', (exec, next) => {
		if (exec && exec.name === 'skill_manage') {
			// ⚠ 参数在 **`exec.arguments`**（官方 `ToolExecutionInput.arguments`，
			// `@deepseek-ai/dsh-tools` 的 `lib/types/index.d.ts:226-227`），**不是旧字段名 `args`** ✗
			// —— 2026-10-12 由 p3-26 抓出（旧写法让 reason 一直渲染成 `skill_manage(?)`，用户看不到
			// 究竟是哪种写操作 ✓）；本工具的判据**参数无关**，所以那条路只是文案失真、闸本身没漏 ✓。
			return {
				kind: 'ask',
				reason: `skill_manage(${String(exec.arguments?.action ?? '?')}) 会写入用户的技能库（跨会话持久，之后每轮都可能被检索到）`,
				displayReason: { en: 'Allow skill_manage to write into your skill library?', zh: '允许 skill_manage 写入技能库？' },
			};
		}
		return next(); // 只读工具（skill_search）⇒ 默认 allow ✓
	}));

	// 消费者探测（可选注入）：只在 `ctx.tools` 真的存在时才访问它，并跟着 `tools/change` 实时更新。
	ctx.inject(['tools'], tools => {
		// ⚠ 判定用 `schemas()`，**不用** `get('skill')` —— 后者在这个 Host 上**永远是 undefined** ✗
		// （2026-10-12 实测：profile 明明启用了 `@deepseek-ai/dsh-tool-skill`（`dsh --dump-config` 可查 ✓）、
		// 它注册的工具名也确实就是 `"skill"`（runtime 源码 `ctx.tools.register(skillTool)` ✓），可 `get('skill')`
		// 一直空 ✓）；而 `schemas()` 是**已被真机证明能用**的那条路 ✓（mcp 页正是靠它数出 `mcp__probe__probe_ping` ✓）。
		// 两个模块对"工具在不在"必须走**同一条 API** ✓，否则就是"这页说在、那页说不在" ✗。
		const namesOf = () => {
			let value;
			try {
				value = tools.tools.schemas?.();
			} catch {
				return []; // 问不动就如实说"不知道"（⇒ absent），不假装在 ✓
			}
			const list = Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.values(value) : []);
			return list.map(item => (typeof item === 'string' ? item : item?.name)).filter(name => typeof name === 'string');
		};
		const sync = () => {
			// 记下**实际看到的名字**（含 "skill" 字样的那几个）—— 不只为断言，更是为**说得出为什么** ✓：
			// 真机读数长时间是 absent ⇒ 要么它真没注册 ✓，要么名字被**命名空间化**了 ✗（mcp 的工具名就是
			// `mcp__probe__probe_ping` 那种形式 ✓）。没有这一栏，只能猜 ✓。
			state.skillishTools = namesOf().filter(name => /skill/i.test(name)).slice(0, 4);
			state.nativeSkillToolPresent = namesOf().includes(NATIVE_SKILL_TOOL);
		};
		sync();
		tools.on('tools/change', sync);

		// ── 技能检索工具（② ）────────────────────────────────────────────────────────────────
		// 契约对齐 IDE 真源（`browser/providers/tool/skillTools.ts` 的 `skill_search`）：同样"BM25 排序 +
		// 返回 id/name/description/score"，`limit` 同样缺省 3、夹到 1–10。措辞不同是因为**下游**不同：
		// IDE 有 `read_skill`，dsh 侧取正文靠**原生 `skill` 工具** ⇒ 描述里必须点名那个工具，否则模型拿到
		// id 也不知道怎么把正文取出来 ✗（"半截工具"最常见的坏法）。
		//
		// ⚠️ `output.render` 是**必填**：只写 schema 会抛 `tool "x" must declare output { schema, render… }`，
		//    而它的表现是**整个插件不挂载**、真机 404 ✗（memory 插件里记过这个坑，探针会盯"注册成功"✓）。
		//
		// ⚠ 本模块**两个**工具分属两类 ✓（p3-26 的类级判据按这个分）：
	//   · `skill_search` 只读 ⇒ **不拦**（每次都弹窗只会造成审批疲劳 ✓）；
	//   · `skill_manage` **写** ⇒ 已由上面那把闸拦 ✓（类级判据：写数据的工具必须有闸 ✓）。
		const definitions = [{
			name: 'skill_search',
			description: '按任务描述检索已安装的技能（BM25 排序），返回最相关的几条及其 skill id。任务是"可能已有专门流程"时**先检索**，再用原生 `skill` 工具按 id 取完整正文——不要凭描述猜。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '任务描述，自然语言即可（如"代码评审"、"写用户文档"）' },
					// dsh 的参数 schema 只接受受限子集（无 minimum/maximum）：范围写进描述、由代码夹紧 ✓
					limit: { type: 'integer', description: `返回条数上限，1–${SKILL_SEARCH_MAX_LIMIT}（默认 ${SKILL_SEARCH_DEFAULT_LIMIT}；超出会被夹到边界）` },
				},
				required: ['query'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						count: { type: 'integer' },
						items: {
							type: 'array',
							items: {
								type: 'object',
								properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, score: { type: 'number' }, skillDir: { type: 'string' } },
								required: ['id', 'name', 'score'],
							},
						},
					},
					required: ['count', 'items'],
				},
				// ★ 2026-10-13：命中时**连技能目录的绝对路径一起给**，并把"绝对路径纪律"写在脸上。
				//   为什么（实测事故）：技能内的脚本是模型用 bash/pwsh 去跑的，而进程 cwd 是**会话工作区**、
				//   不是技能目录 ⇒ SKILL.md 里那句 `node bin/archify.mjs doctor`（相对路径）在工作区根下
				//   直接 `Cannot find module '<workspace>\bin\archify.mjs'` ✗✗（archify 现场）。
				//   IDE 侧早就定了这条纪律（`skillTools.ts` 注入 skillDir + scriptPaths，2026-08-03 决策），
				//   dsh 侧此前**只有原生 `skill` 工具的 `resourceBase.directory`**，没有这层提醒 ✗ ⇒ 补上 ✓。
				//   ⚠ 只改 render/输出、**不动 description**：工具快照抓的是 `descriptionHash`，
				//   动它就要重生成快照（而快照当前正被别的改动弄漂移 ✗，不该混进来）。
				render: (_args, value) => {
					if (!value.count) {
						return [{ type: 'text', text: '技能目录里没有与查询相关的技能（可用原生 skill 工具查看全部）。' }];
					}
					const lines = value.items.map(item => `- ${item.id}（${item.score.toFixed(2)}）skillDir: ${item.skillDir || '(未知)'}`);
					return [{
						type: 'text',
						text: `命中 ${value.count} 条（按 id 用原生 skill 工具取正文）：\n${lines.join('\n')}\n`
							+ '技能内的脚本一律用上面 skillDir 的**绝对路径**调用：进程 cwd 是会话工作区、不是技能目录，'
							+ '照 SKILL.md 里的相对路径（如 `node bin/x.mjs`）直接跑会报"找不到模块"✗。',
					}];
				},
			},
			isConcurrencySafe: () => true,
			execute: async (params) => {
				const query = typeof params?.query === 'string' ? params.query.trim() : '';
				if (!query) {
					// 空查询**明确报错**（与 IDE 真源的 "query is required" 一致 ✓）：静默返回空列表会让
					// 模型以为"没有这个技能"，而真实原因是自己没给查询词 ✗ —— 这两件事必须区分开。
					throw new Error('query 不能为空：把任务描述写进来（如"代码评审"），检索才有依据。');
				}
				const scan = await scanSkills(skillsRootOf(config), undefined);
				const skills = scan.skills.map(skill => ({
					id: skillIdOf(skill.path), name: skill.name, description: skill.description ?? '',
					// 技能目录（= SKILL.md 所在目录，**绝对路径**）：模型据此展开技能内脚本的路径 ✓
					//（推导与边界见 `store.js` 的 `skillDirOf`，那里有事故缘由 ✓）。
					skillDir: skillDirOf(skill.path),
				}));
				const items = rankSkills(skills, query, typeof params?.limit === 'number' ? params.limit : SKILL_SEARCH_DEFAULT_LIMIT);
				return { count: items.length, items };
			},
		}, {
			// ── 技能写入（③）：`skill_manage` ────────────────────────────────────────────────
			// 契约对齐 IDE 真源（`skillTools.ts` 的 `skill_manage` ✓，四种 action 与**参数名逐字相同** ✓）：
			// create / edit / patch / delete ✓；`old_string` 默认要求**唯一** ✓、`replace_all: true` 才全替换 ✓。
			// ⚠ 这里**故意用下划线参数名** ✓（dsh 自家工具是驼峰 ✓）：同一个动作在两个引擎里若参数名不同，
			//   模型就得记住两套习惯 ✗ —— 契约共享优先于风格统一 ✓。
			// ⚠ 写操作**必过审批闸** ✓（见 apply 顶部那把 ✓），所以描述里明说"需要用户确认" ✓，
			//   免得模型以为写失败了反复重试 ✗。
			name: 'skill_manage',
			description: [
				`管理技能库（create / edit / patch / delete，写在 <数据根>/skills/<name>/SKILL.md ✓）。技能是你的程序性记忆——可复用的做事方式。`,
				'create: 新建一个 SKILL.md（**已存在则失败** ✓，不覆盖）。',
				'edit: 用新内容整份替换已有 SKILL.md（用来改掉过时/写错的指引）。',
				'patch: 精确替换已有 SKILL.md 里的一段文本（小改用这个更安全；old_string 默认必须唯一，replace_all=true 才全替换）。',
				'delete: 整个删除一个技能。',
				`⚠ 四种 action **都会写盘** ⇒ 每次调用都需要**用户在审批里确认** ✓（被拒绝是正常的，不要反复重试 ✗）。单个技能正文上限 ${MAX_SKILL_BYTES} 字节。`,
				'⚠ 新建/删除后，本模块的页面会立即看到 ✓，但 dsh 的**技能目录**（<available_skills>）要等 Host 重新扫描才会更新 ✓。',
			].join(' '),
			parameters: {
				type: 'object',
				properties: {
					action: { type: 'string', enum: SKILL_MANAGE_ACTIONS, description: 'create=新建, edit=整份重写, patch=精确替换一段, delete=删除。' },
					name: { type: 'string', description: '技能名（小写字母/数字开头，可含 - 与 _，≤64 字符；目录名与 frontmatter 的 name 都用它）' },
					content: { type: 'string', description: '完整 SKILL.md 内容（YAML frontmatter + markdown 正文；frontmatter 至少要有 name 与 description）。create / edit 必填。' },
					old_string: { type: 'string', description: '要替换的原文（patch 必填；**逐字匹配**，含空白与换行；默认要求全文唯一）' },
					new_string: { type: 'string', description: '替换成的文本（patch 必填；可为空 = 删掉那段）' },
					replace_all: { type: 'boolean', description: 'patch 时是否替换全部出现（默认 false ⇒ 出现多次会报错）' },
					category: { type: 'string', description: '可选分类（如 devops / data-science），会写进 frontmatter 的 category 一行' },
				},
				required: ['action', 'name'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						action: { type: 'string' },
						id: { type: 'string' },
						path: { type: 'string' },
						bytes: { type: 'integer' },
						replaced: { type: 'integer' },
					},
					required: ['action', 'id', 'bytes'],
				},
				render: (_args, value) => [{
					type: 'text',
					text: `${value.action} 完成：${value.id}（${value.bytes} 字节${value.replaced ? `，替换 ${value.replaced} 处` : ''}）— ${value.path}`,
				}],
			},
			// 写盘 ⇒ **不声明**可并行（与 kanban 的写工具同口径：仅 `true` 表示可并行 ✓）
			execute: async (params) => {
				// ★ 跨进程写锁（README 5.114）：`skill_manage` 是"**读—改—写**"（`patch` 先读原文再写回 ✓）
				// ✗ ⇒ 与另一个 dsh 写者并发会**丢更新** ✓（读旧 → 写回 → 把别人刚写的改动整段覆盖 ✗）。
				// 锁目标是**技能根**（`<skillsRoot>.lock` ✓，兄弟文件 ✓）：这里**刻意**不用 `params.name`
				// 拼路径 ✗ —— 未净化的输入不进文件系统 ✓（细粒度到单个技能需要先过 `skillManage` 里的
				// 净化器 ✓，本次不引入那份耦合 ✓）。写操作是用户驱动的低频动作 ⇒ 粗粒度不会挡路 ✓。
				// ⚠ 如实记边界 ✗：**IDE 侧的技能写入不加锁**（`skillInstaller` / `skillInstallService`
				// 直接 `fileService.writeFile` ✓，`agentStudio/**` 里查不到技能路径的锁用法 ✓）
				// ⇒ 这把锁只与"另一个 dsh 写者"互斥 ✓，**挡不住 IDE 同时写** ✗（要彻底互斥得 IDE 侧也上锁 ✓）。
				const release = await acquireFileLock(lockFileFor(skillsRootOf(config)), { label: '技能目录' });
				try {
					return skillManage({
						action: params?.action,
						name: params?.name,
						content: params?.content,
						oldString: params?.old_string,
						newString: params?.new_string,
						replaceAll: params?.replace_all,
						category: params?.category,
					}, skillsRootOf(config));
				} finally {
					await release();
				}
			},
		}, {
			// 重构 4（2026-10-17）：`skill_market_list`——浏览技能市场（只读：经桥回 IDE 拉远端清单，
			// 远端服务在壳侧的 marketplaceService ✓）。安装入口是 skill_manage（草稿区 ✓——本工具
			// 只浏览 ✓，不安装 ✗）。
			name: 'skill_market_list',
			description: '浏览技能市场：列出远端可装的技能（名称 / 描述 / 版本 / 作者）。只读（不安装——安装用 skill_manage 的 create，写草稿区后手动提升才生效）。远端服务要登录（经 IDE 侧的 marketplaceService）。',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: '搜索关键词（可选）' },
					limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						count: { type: 'integer' },
						items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, version: { type: 'string' }, author: { type: 'string' } } } },
						error: { type: 'string' },
					},
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.error
						? `市场不可用：${value.error}`
						: (value.count ? `${value.count} 个技能：\n${value.items.map(i => `  • ${i.name}@${i.version ?? '?'} — ${i.description ?? ''}`).join('\n')}` : '没有匹配的技能'),
				}],
			},
			isConcurrencySafe: () => true,  // 只读 ✓
			execute: async (params) => {
				// 经桥回 IDE（远端清单要认证——壳侧的 marketplaceService 有 token ✓）
				if (!state.bridge || typeof state.bridge.callIDE !== 'function') {
					return { count: 0, items: [], error: '市场要经桥回 IDE（远端清单的认证在壳侧），但 vssarosBridge 不在（bridge 插件没装/没连）' };
				}
				const reply = await state.bridge.callIDE('ide.request', {
					capability: 'skills',
					pluginId: 'vssaros-skills',
					params: { op: 'marketList', query: String(params?.query ?? '').trim() || undefined, limit: Number.isFinite(params?.limit) ? Math.min(100, Math.max(1, Math.floor(params.limit))) : 20 },
				}, { timeoutMs: 30 * 1000 });
				const items = Array.isArray(reply?.items) ? reply.items : [];
				return { count: items.length, items, ...(reply?.error ? { error: String(reply.error) } : {}) };
			},
		}, {
			// 重构 4（2026-10-17）：`read_skill`——读技能全文（SKILL.md 正文 + 可选的支持文件）。
			// 与 legacy `skillTools.ts` 同语义（读文件系统——dsh 侧的 skills 是文件扫描 ✓，
			//   不是壳侧的 skillRegistry 服务 ✓）。只读 ⇒ 不挂审批闸（与 skill_search 同口径 ✓）。
			name: 'read_skill',
			description: '按 id 读一个已安装技能的完整指引（SKILL.md 正文）。要读技能的支持文件（references/scripts/assets/templates）时传 path（相对路径，如 "references/api.md"）。',
			parameters: {
				type: 'object',
				properties: {
					skill_id: { type: 'string', description: '技能 id（目录名 / frontmatter 的 name）' },
					path: { type: 'string', description: '可选：技能内的支持文件相对路径（如 "references/api.md"）——给了就读那个文件而不是 SKILL.md' },
				},
				required: ['skill_id'],
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						ok: { type: 'boolean' },
						id: { type: 'string' },
						name: { type: 'string' },
						path: { type: 'string' },
						content: { type: 'string' },
						skillDir: { type: 'string' },
						supportFiles: { type: 'array', items: { type: 'string' } },
						error: { type: 'string' },
					},
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.ok
						? `# ${value.name}（${value.id}）\n\n${String(value.content ?? '').slice(0, 2000)}${String(value.content ?? '').length > 2000 ? '\n\n…（截断）' : ''}`
						: `读技能失败：${value.error ?? '未知原因'}`,
				}],
			},
			isConcurrencySafe: () => true,  // 只读 ✓
			execute: async (params) => {
				const skillId = String(params?.skill_id ?? '').trim();
				if (!skillId) { throw new Error('skill_id 必填（技能 id——目录名 / frontmatter 的 name）'); }
				const supportPath = String(params?.path ?? '').trim();
				const scan = await scanSkills(skillsRootOf(config));
				// 按 id（目录名）或 name（frontmatter）找
				const skill = scan.skills.find(s => s.id === skillId || s.name === skillId);
				if (!skill) {
					return { ok: false, error: `技能没找到：${skillId}（用 list_skills 看可用的 id）` };
				}
				// 读支持文件（references/scripts/assets/templates——相对路径，围栏 ✓）
				if (supportPath) {
					const { readFile } = await import('node:fs/promises');
					const { resolve, sep } = await import('node:path');
					const skillDir = resolve(skillsRootOf(config), skill.id);
					const target = resolve(skillDir, supportPath);
					if (target !== skillDir && !target.startsWith(skillDir + sep)) {
						throw new Error(`路径越界：${supportPath} 解析后不在技能目录之内（已拒绝）。`);
					}
					try {
						const content = await readFile(target, 'utf8');
						return { ok: true, id: skill.id, name: skill.name, path: supportPath, content };
					} catch (e) {
						return { ok: false, error: `读支持文件失败：${supportPath}（${String(e?.message ?? e)}）`, supportFiles: [] };
					}
				}
				return { ok: true, id: skill.id, name: skill.name, content: skill.content ?? '', skillDir: skill.path, supportFiles: [] };
			},
		}, {
			// 重构 4（2026-10-17）：`list_skills`——列所有已安装技能（id / name / description / activation）。
			// 与 legacy `skillTools.ts` 同语义（读文件系统 ✓）。只读 ⇒ 不挂审批闸 ✓。
			name: 'list_skills',
			description: '列出所有已安装的技能（id / 名称 / 描述 / 激活方式）。要浏览或搜索可用技能时用它。',
			parameters: {
				type: 'object',
				properties: {
					filter: { type: 'string', description: '可选：按名称或描述过滤（大小写不敏感）' },
					category: { type: 'string', description: '可选：按分类过滤' },
				},
			},
			output: {
				schema: {
					type: 'object',
					properties: {
						count: { type: 'integer' },
						skills: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, activation: { type: 'string' } } } },
					},
				},
				render: (_args, value) => [{
					type: 'text',
					text: value.count ? `${value.count} 个技能：\n${value.skills.map(s => `  • ${s.id} — ${s.description ?? ''}`).join('\n')}` : '没有匹配的技能',
				}],
			},
			isConcurrencySafe: () => true,  // 只读 ✓
			execute: async (params) => {
				const filter = String(params?.filter ?? '').toLowerCase().trim();
				const category = String(params?.category ?? '').toLowerCase().trim();
				const scan = await scanSkills(skillsRootOf(config));
				let skills = scan.skills;
				if (filter) {
					skills = skills.filter(s =>
						(s.name ?? '').toLowerCase().includes(filter)
						|| (s.description ?? '').toLowerCase().includes(filter)
						|| (s.metadata?.match ?? []).some(m => String(m).toLowerCase().includes(filter))
					);
				}
				if (category) {
					skills = skills.filter(s => String(s.metadata?.category ?? '').toLowerCase() === category);
				}
				return {
					count: skills.length,
					skills: skills.map(s => ({ id: s.id, name: s.name, description: s.description ?? '', activation: s.activation ?? 'manual' })),
				};
			},
		}];
		// ⚠ 只闸**注册**这一步 ✓：上面的消费者探测（`nativeSkillToolPresent` / `skillishTools`）必须照跑 ✓ ——
		// 页面那两栏全靠它，而 `ctx.tools.schemas()` 是**全局**注册表视图 ⇒ preset 那次挂载注册的工具
		// 在这里同样看得见 ✓（真机读数 `skill_search,skill` 就是这么来的 ✓）。
		const registered = hostHalf ? [] : definitions.map(definition => tools.tools.register(definition));

		return () => {
			state.nativeSkillToolPresent = false;
			state.skillishTools = [];
			for (const dispose of registered) {
				dispose();
			}
		};
	});

	// 技能来源（可选依赖）：`ctx.skills` 存在时注册一个 provider；它的 disposer 就是 Cordis effect 的
	// 返回值，插件停用即自动注销（方案 6.2："注册即 effect"）。
	ctx.inject(['skills'], child => child.effect(() => child.skills.registerProvider(control => {
		state.provider = { registered: true, reason: '' };
		return {
			name: PROVIDER_NAME,
			async list(options) {
				if (options?.signal?.aborted) {
					return [];
				}
				const scan = await scanSkills(skillsRootOf(config), options?.signal);
				// 目录增删时通知消费者重取（先更新指纹再通知，避免自激循环）
				if (scan.fingerprint !== state.lastFingerprint) {
					state.lastFingerprint = scan.fingerprint;
					control.invalidate();
				}
				return scan.skills.map(toCandidate);
			},
			async get(candidate) {
				// locator 由我们自己的 list() 产出（不透传外部值），但仍按"可能已不可加载"处理
				const file = typeof candidate?.locator?.path === 'string' ? candidate.locator.path : undefined;
				const path = file ?? (typeof candidate?.path === 'string' ? candidate.path : undefined);
				if (!path) {
					return undefined;
				}
				const text = await readSkillFile(path);
				if (text === undefined) {
					return undefined;
				}
				const parsed = skillFromFile(text, { id: skillIdOf(path), file: path });
				return parsed.error ? undefined : toDefinition(parsed.skill);
			},
		};
	})));

	// 只读目录页：Host 自己的鉴权栅栏 + 同源同 partition 的 Cookie（VsSaros 侧 WebContentsView 加载）。
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
			const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
			const root = skillsRootOf(config);
			try {
				const scan = await scanSkills(root, undefined);
				// ── 单技能正文（页面预览面板用 ✓，也是"不用模型也能读 SKILL.md"的最短路径）────────────────
				// ⚠ 解析**复用** `skillFromFile`（与 dsh `provider.get()` 走的是同一份 ✓）：另写一份 frontmatter
				// 解析，两份迟早漂移 ✗，而"预览看到的和模型看到的不是一回事"是最难被发现的一类错 ✓。
				if (pathname === `${ROUTE_PREFIX}/api/skill`) {
					// 只用 `req.url`（不依赖上面的 `pathname` 变量已经解出来的 URL 对象 ✓，本分支自足 ✓）
					const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? '';
					const entry = scan.skills.find(s => skillIdOf(s.path) === id);
					const fail = (status, error) => {
						res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ error, id, count: scan.skills.length }));
					};
					if (!entry) {
						// 未知 id 必须**明确失败**（404 + 原因）：返回空正文当成功会让"技能点不开"变成静默故障 ✗
						fail(404, `没有这个技能：${id || '(缺 id 参数)'}（目录 ${root}，共 ${scan.skills.length} 个）`);
						return;
					}
					const text = await readSkillFile(entry.path);
					if (text === undefined) {
						fail(404, `读不了这个技能的文件：${entry.path}`);
						return;
					}
					const parsed = skillFromFile(text, { id, file: entry.path });
					if (parsed.error) {
						fail(404, `这个技能用不了：${parsed.error}`);
						return;
					}
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						id: skillIdOf(entry.path),
						name: parsed.skill.name,
						description: parsed.skill.description,
						activation: parsed.skill.activation,
						metadata: parsed.skill.metadata,
						path: parsed.skill.path,
						// 正文（frontmatter 已剥离）＋ 字节数：页面直接显示，模型侧 `get()` 拿的也是这一段 ✓
						content: parsed.skill.content,
						contentBytes: Buffer.byteLength(parsed.skill.content, 'utf8'),
					}));
					return;
				}
				if (pathname === `${ROUTE_PREFIX}/api/skills`) {
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({
						root,
						provider: state.provider,
						count: scan.skills.length,
						summary: summarizeCatalog(scan.skills),
						// 与 dsh 目录同形（不含正文）：正文只在 get() 里按需读
						skills: scan.skills.map(s => ({ name: s.name, description: s.description, activation: s.activation, path: s.path, metadata: s.metadata })),
						errors: scan.errors,
						...(scan.missing ? { missing: scan.missing } : {}),
					}));
					return;
				}
				// 渲染放到 writeHead 之前：渲染抛错时还能干净地回 500（顺序反了会变成"头已发出→再写头又抛
				// →socket 被切断"，实测吃过这个亏）。200 之后真的发生异常，catch 里只 end 不再写头。
				const html = renderPage({
					skills: scan.skills,
					errors: scan.errors,
					missing: scan.missing,
					root,
					nativeSkillTool: state.nativeSkillToolPresent,
					provider: state.provider,
					// 这两个诊断栏属于**本次挂载**（preset plane 下同一个包会被多次挂载 ⇒ 不许用模块级 ✗）
					skillishTools: state.skillishTools,
					// MCP 区块（`@vssaros/dsh-mcp` 的片段）：同源转发 Cookie 取回；没装/没激活都只是"未内嵌"。
					mcpSection: await fetchMcpSection(req),
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
