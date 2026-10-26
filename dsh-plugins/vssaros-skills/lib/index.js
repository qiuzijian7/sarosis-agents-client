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

import { appendFile, readFile, readdir } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, skillFromFile, summarizeCatalog, toCandidate, toDefinition, VSAROS_SKILL_PROVIDER } from './core/skills.js';
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
		// ★ 2026-10-24（用户：「开关插件后…莫名切换到了其他页签」）：把当前页签记下来，
		//   任何原因导致重渲染/刷新，回来还是同一个页签（而不是跳回默认的「技能」）。
		try { localStorage.setItem('vssaros.tools.tab', String(name)); } catch (e) { }
		tabs.forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-sk-tab') === name); });
		panes.forEach(function (p) { p.hidden = p.getAttribute('data-sk-pane') !== name; });
		// 搜索框已在页头（对所有页签生效）⇒ 不再随页签显隐
		applyFilter();
	}
	tabs.forEach(function (b) {
		b.addEventListener('click', function () { showTab(b.getAttribute('data-sk-tab')); });
	});
	// 恢复上次的页签（只认页面上真实存在的，避免旧值把内容全隐掉）
	try {
		var savedTab = localStorage.getItem('vssaros.tools.tab');
		if (savedTab && tabs.some(function (b) { return b.getAttribute('data-sk-tab') === savedTab; })) {
			showTab(savedTab);
		}
	} catch (e) { }

	/*
	 * 「加载更多」（2026-10-24 用户要求）：
	 * 服务端只渲染前 N 个（插件有 6704 个，全渲染会卡死）⇒ 点一次翻一页。
	 *
	 * ⚠ 卡片 HTML 由**服务端** /x/skills/api/plugins 返回（复用 renderMarketCard）——
	 *   不在浏览器里重写一遍模板，否则两份迟早漂移 ✗
	 */
	Array.prototype.forEach.call(root.querySelectorAll('[data-sk-more-pane]'), function (btn) {
		btn.addEventListener('click', function () {
			if (btn.disabled) { return; }
			var paneName = btn.getAttribute('data-sk-more-pane');
			var next = Number(btn.getAttribute('data-sk-more-page') || '1') + 1;
			var pane = root.querySelector('[data-sk-pane="' + paneName + '"]');
			var grid = pane ? pane.querySelector('ul.tk-market') : null;
			if (!grid) { return; }
			btn.disabled = true;
			var oldText = btn.textContent;
			btn.textContent = '加载中…';
			fetch('/x/skills/api/plugins?page=' + next, { credentials: 'same-origin' })
				.then(function (r) { return r.json(); })
				.then(function (j) {
					if (!j || j.ok !== true) { throw new Error(String((j || {}).error || '加载失败')); }
					if (j.html) { grid.insertAdjacentHTML('beforeend', j.html); }
					btn.setAttribute('data-sk-more-page', String(j.page));
					if (!j.hasMore) { btn.parentNode.removeChild(btn); return; }
					btn.disabled = false;
					btn.textContent = oldText;
				})
				.catch(function (e) {
					btn.disabled = false;
					btn.textContent = '加载失败，重试';
					console.error('[tools] 加载更多失败', e);
				});
		});
	});

	/* ── 筛选条（2026-10-23「每个页签都要能过滤」）─────────────────────────
	   每个 pane 一条 .tk-fbar：主 chips 单选 + 「更多筛选」多选 + 排序 + 清空。
	   判据全在服务端写好的 data-f-* 上（src / state / model / ver / act）⇒ 前端只切 hidden。 */
	var fbars = Array.prototype.slice.call(root.querySelectorAll('[data-tk-chips]'));

	function chipHit(node, key) {
		if (!key || key === 'all') { return true; }
		var i = key.indexOf(':');
		if (i < 0) { return true; }
		return (node.getAttribute('data-f-' + key.slice(0, i)) || '') === key.slice(i + 1);
	}

	function paneOf(el) {
		var n = el;
		while (n && !(n.hasAttribute && n.hasAttribute('data-sk-pane'))) { n = n.parentNode; }
		return n;
	}

	function applyBar(bar) {
		var pane = paneOf(bar);
		if (!pane) { return { shown: 0, total: 0 }; }
		var active = bar.getAttribute('data-tk-active') || 'all';
		var more = (bar.getAttribute('data-tk-more') || '').split(',').filter(Boolean);
		var q = (input && input.value ? input.value : '').trim().toLowerCase();
		// data-item-row = 已安装的 agent / 工作流 / 插件 / 工作台（与技能行同一种行，但不是技能）
		var nodes = Array.prototype.slice.call(pane.querySelectorAll('[data-skill-row], [data-item-row], [data-tk-card]'));
		var shown = 0;
		nodes.forEach(function (n) {
			var ok = chipHit(n, active);
			if (ok) {
				for (var i = 0; i < more.length; i++) {
					if (!chipHit(n, more[i])) { ok = false; break; }
				}
			}
			if (ok && q) { ok = (n.textContent || '').toLowerCase().indexOf(q) >= 0; }
			if (!ok && n.hasAttribute('data-skill-row')) { collapse(n); }
			n.hidden = !ok;
			if (ok) { shown++; }
		});
		var info = bar.querySelector('[data-tk-info]');
		if (info) { info.textContent = '筛选结果 ' + shown + ' / ' + nodes.length + ' 个'; }
		return { shown: shown, total: nodes.length };
	}

	fbars.forEach(function (bar) {
		var chips = Array.prototype.slice.call(bar.querySelectorAll('.tk-chip'));
		function paint() {
			var active = bar.getAttribute('data-tk-active') || 'all';
			chips.forEach(function (c) {
				c.classList.toggle('on', c.getAttribute('data-tk-filter') === active);
			});
		}
		paint();
		chips.forEach(function (c) {
			c.addEventListener('click', function () {
				var k = c.getAttribute('data-tk-filter');
				var curKey = bar.getAttribute('data-tk-active') || 'all';
				bar.setAttribute('data-tk-active', k === curKey ? 'all' : k);
				paint();
				applyFilter();
			});
		});

		var moreBtn = bar.querySelector('[data-tk-more]');
		var morePanel = bar.querySelector('.tk-more-panel');
		if (moreBtn && morePanel) {
			moreBtn.addEventListener('click', function () {
				morePanel.hidden = !morePanel.hidden;
				moreBtn.setAttribute('aria-expanded', morePanel.hidden ? 'false' : 'true');
			});
			Array.prototype.forEach.call(morePanel.querySelectorAll('input[data-tk-filter]'), function (cb) {
				cb.addEventListener('change', function () {
					var keys = (bar.getAttribute('data-tk-more') || '').split(',').filter(Boolean);
					var k = cb.getAttribute('data-tk-filter');
					var at = keys.indexOf(k);
					if (cb.checked && at < 0) { keys.push(k); }
					if (!cb.checked && at >= 0) { keys.splice(at, 1); }
					bar.setAttribute('data-tk-more', keys.join(','));
					applyFilter();
				});
			});
		}

		var clearBtn = bar.querySelector('[data-tk-clear]');
		if (clearBtn) {
			clearBtn.addEventListener('click', function () {
				bar.setAttribute('data-tk-active', 'all');
				bar.setAttribute('data-tk-more', '');
				Array.prototype.forEach.call(bar.querySelectorAll('.tk-more-panel input'), function (cb) { cb.checked = false; });
				paint();
				if (input) { input.value = ''; }
				applyFilter();
			});
		}

		var sortSel = bar.querySelector('[data-tk-sort]');
		if (sortSel) {
			sortSel.addEventListener('change', function () {
				var pane = paneOf(bar);
				if (!pane) { return; }
				Array.prototype.forEach.call(pane.querySelectorAll('.tk-grid'), function (grid) {
					var kids = Array.prototype.slice.call(grid.children);
					kids.sort(function (a, b) {
						if (sortSel.value === 'src') {
							var sa = a.getAttribute('data-f-src') || '';
							var sb = b.getAttribute('data-f-src') || '';
							if (sa !== sb) { return sa < sb ? -1 : 1; }
						}
						var na = a.querySelector('.tk-nm, .sk-nm');
						var nb = b.querySelector('.tk-nm, .sk-nm');
						return String(na ? na.textContent : '').localeCompare(String(nb ? nb.textContent : ''), 'zh');
					});
					kids.forEach(function (k) { grid.appendChild(k); });
				});
			});
		}
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
	/* 卡片是否该显示：**chips 条件 AND 搜索词**（两者不能互相覆盖）。
	   chips 的当前值记在 bar 的 data-tk-active 属性上（点 chip 只改这个属性，然后统一走 applyFilter）。 */
	
	function applyFilter() {
		var current = null;
		fbars.forEach(function (bar) {
			var r = applyBar(bar);
			var pane = paneOf(bar);
			if (pane && !pane.hidden) { current = r; }
		});
		if (counter && current) { counter.textContent = current.shown + '/' + current.total; }
	}

	if (input) { input.addEventListener('input', applyFilter); }

	/*
	 * ★ 2026-10-26（用户：「已安装的 skill item，点击后即会展开，又会弹出UI，希望仅弹出UI即可」）：
	 *   以前点一行会**同时**做两件事 —— 展开行内抽屉 + 打开详情弹层（两个独立的 click 监听器）。
	 *   抽屉里的内容（激活 / 技能 id / 商城商品 / 文件目录 / 正文）弹层里**全都有**，
	 *   而且弹层是后来统一过的"唯一详情入口"⇒ 行内抽屉在这里已经没有存在价值。
	 *
	 * 现在的口径：
	 *   · 点行 = 只开弹层（由页尾那段委派处理器统一处理，五类条目一致）；
	 *   · <li class="sk-drawer"> **保留在 DOM 里但永远不展开** —— 它是弹层的数据源
	 *     （openMkDlg 从这里取 文件/目录 与 pre[data-sk-body]），删掉弹层就没内容了；
	 *   · 键盘：Enter / 空格 → row.click()，同样只走弹层（<li> 不会自己触发 click，必须转一次）。
	 */
	rows.forEach(function (row) {
		row.setAttribute('tabindex', '0');
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

	/* 商城入口是普通链接（href=/x/marketplace/，2026-10-23 用户：改名「商城」并打开商城网页）
	   ⇒ 不再需要宿主桥 openSkillMarket；没装商城插件时是 404，而不是"按钮点了没反应"。 */

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

	/**
	 * 安装失败**必须看得见原因**（2026-10-23 用户截图：「安装技能失败」但界面上没有任何原因 ——
	 * 只写进按钮的 title 等于没写，鼠标不悬停就永远不知道）。
	 *
	 * 显示位置：卡片内、按钮下方一行红字；登录态相关的错误额外给一条提示。
	 * ⚠ 不把 error 吞掉、也不美化成"稍后重试"——商城返回什么就显示什么。
	 */
	function showInstallError(btn, message) {
		btn.disabled = false;
		btn.title = message;
		// 安装器在「目标已存在」时是**拒绝安装**（要求走升级，见 installers.js:15）⇒ 直接换成「改为升级」
		// 其余错误保持「重试安装」。这条分支不是猜测：那条拒绝逻辑在安装器里是明写的。
		if (/已存在|already exists/i.test(message)) {
			btn.textContent = '改为升级';
			btn.setAttribute('data-market-upgrade', '1');
		} else {
			btn.textContent = '重试安装';
		}
		var card = btn.closest ? btn.closest('.tk-card') : null;
		if (!card) { return; }
		var body = card.querySelector('.tk-body') || card;
		var box = body.querySelector('.tk-err');
		if (!box) {
			box = document.createElement('div');
			box.className = 'tk-err';
			body.appendChild(box);
		}
		var hint = '';
		if (/401|403|未登录|token|认证/i.test(message)) {
			hint = '（商城登录态可能已过期：去商城页重新登录后再试）';
		} else if (/sha256|校验/i.test(message)) {
			hint = '（下载的包没通过校验：多半是网络中断，重试即可）';
		} else if (/已存在|already exists/i.test(message)) {
			hint = '（本地已有同名目录，商城不认这个安装；点「改为升级」覆盖它）';
		}
		box.textContent = '安装失败：' + message + hint;
	}

	/**
	 * 拉一个商品的**完整介绍**（op=detail ⇒ detail_md 字段）。
	 *
	 * 为什么点开才拉：商品正文每条几 KB，上百条就是几百 KB —— 列表不该背着它；
	 * 而且大多数人只是扫一眼卡片。失败如实写在面板里（不回退成空白）。
	 */
	/**
	 * 极简 Markdown → HTML。
	 *
	 * 商城的 detail_md 是 markdown，以前直接当 HTML 塞进弹层 ⇒ 用户看到的是满屏 # 和 **。
	 * 只支持我们实际会用到的那点语法：标题 / 列表 / 代码块 / 行内代码 / 粗体 / 链接 / 分隔线 / 引用。
	 *
	 * ⚠ 本函数在**模板字符串**里：不能出现反引号，也不能写带 \r \n 的正则（会被模板吃掉，踩过 6 次）。
	 */
	function mdToHtml(src) {
		var BT = String.fromCharCode(96);
		var NL = String.fromCharCode(10);
		var CR = String.fromCharCode(13);
		var lines = String(src || '').split(CR).join('').split(NL);
		var html = '';
		var inCode = false;
		var inList = false;
		var para = [];

		function inlineMd(text) {
			var out = escapeHtmlClient(text);
			var bi = out.indexOf('**');
			while (bi >= 0) {
				var bj = out.indexOf('**', bi + 2);
				if (bj < 0) { break; }
				out = out.slice(0, bi) + '<strong>' + out.slice(bi + 2, bj) + '</strong>' + out.slice(bj + 2);
				bi = out.indexOf('**', bi + 8);
			}
			var ci = out.indexOf(BT);
			while (ci >= 0) {
				var cj = out.indexOf(BT, ci + 1);
				if (cj < 0) { break; }
				out = out.slice(0, ci) + '<code>' + out.slice(ci + 1, cj) + '</code>' + out.slice(cj + 1);
				ci = out.indexOf(BT, ci + 6);
			}
			var li = out.indexOf('[');
			while (li >= 0) {
				var lc = out.indexOf(']', li);
				var lp = lc >= 0 ? out.indexOf('(', lc) : -1;
				var lq = lp >= 0 ? out.indexOf(')', lp) : -1;
				if (lc < 0 || lp !== lc + 1 || lq < 0) { break; }
				var label = out.slice(li + 1, lc);
				var href = out.slice(lp + 1, lq);
				if (href.indexOf('http') !== 0) { break; }
				var anchor = '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
				out = out.slice(0, li) + anchor + out.slice(lq + 1);
				li = out.indexOf('[', li + anchor.length);
			}
			return out;
		}

		function flushPara() {
			if (!para.length) { return; }
			html += '<p>' + inlineMd(para.join(' ')) + '</p>';
			para = [];
		}

		function closeList() {
			if (inList) { html += '</ul>'; inList = false; }
		}

		function isNum(str) {
			if (!str) { return false; }
			for (var k = 0; k < str.length; k++) {
				var ch = str.charAt(k);
				if (ch < '0' || ch > '9') { return false; }
			}
			return true;
		}

		for (var i = 0; i < lines.length; i++) {
			var line = lines[i];
			var trimmed = line.trim();
			if (trimmed.indexOf(BT + BT + BT) === 0) {
				flushPara();
				if (inCode) { html += '</code></pre>'; inCode = false; }
				else { closeList(); html += '<pre class="mk-pre"><code>'; inCode = true; }
				continue;
			}
			if (inCode) { html += escapeHtmlClient(line) + NL; continue; }
			if (!trimmed) { flushPara(); closeList(); continue; }
			if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
				flushPara(); closeList(); html += '<hr>'; continue;
			}
			var h = 0;
			while (h < 6 && trimmed.charAt(h) === '#') { h++; }
			if (h > 0 && trimmed.charAt(h) === ' ') {
				flushPara(); closeList();
				var lv = h + 2 > 6 ? 6 : h + 2;
				html += '<h' + lv + '>' + inlineMd(trimmed.slice(h + 1).trim()) + '</h' + lv + '>';
				continue;
			}
			if (trimmed.charAt(0) === '>') {
				flushPara(); closeList();
				html += '<blockquote>' + inlineMd(trimmed.slice(1).trim()) + '</blockquote>';
				continue;
			}
			var isBullet = (trimmed.charAt(0) === '-' || trimmed.charAt(0) === '*' || trimmed.charAt(0) === '+')
				&& trimmed.charAt(1) === ' ';
			if (isBullet) {
				flushPara();
				if (!inList) { html += '<ul>'; inList = true; }
				html += '<li>' + inlineMd(trimmed.slice(2).trim()) + '</li>';
				continue;
			}
			var numEnd = trimmed.indexOf('. ');
			if (numEnd > 0 && numEnd <= 2 && isNum(trimmed.slice(0, numEnd))) {
				flushPara();
				if (!inList) { html += '<ul>'; inList = true; }
				html += '<li>' + inlineMd(trimmed.slice(numEnd + 2).trim()) + '</li>';
				continue;
			}
			para.push(trimmed);
		}
		flushPara();
		closeList();
		if (inCode) { html += '</code></pre>'; }
		return html;
	}

	function loadMarketDetail(slug, det) {
		var body = det.querySelector('.mk-detail-body');
		if (!body) { return; }
		if (body.getAttribute('data-loaded') === slug) { return; }
		body.setAttribute('data-loaded', slug);
		body.innerHTML = '<p class="mk-loading">正在加载完整介绍…</p>';
		fetch('/x/marketplace/api/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'detail', params: { slug: slug } }),
		}).then(function (r) { return r.json(); }).then(function (j) {
			var html = j && j.ok && j.package ? String(j.package.detail_md || '') : '';
			if (!html) {
				body.innerHTML = '<p class="mk-loading">这个商品还没有完整介绍'
					+ (j && j.error ? '（' + escapeHtmlClient(String(j.error)) + '）' : '') + '。</p>';
				return;
			}
			// ★ 2026-10-26：detail_md 是 markdown，以前直接当 HTML 塞 ⇒ 满屏 # 和 **
			body.innerHTML = '<div class="mk-detail">' + mdToHtml(html) + '</div>';
		}).catch(function (e) {
			body.innerHTML = '<p class="mk-loading">加载失败：' + escapeHtmlClient(String((e && e.message) || e)) + '</p>';
		});
	}

	/** 页面侧转义（服务端的 escapeHtml 在浏览器里没有）。 */
	function escapeHtmlClient(v) {
		return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	/* 商城里「安装」：走商城的 api/action（**它才是安装的真源**，本页不自己写盘）。
	   失败如实显示（200 + ok:false 也算失败）；成功后 reload —— 装完条目要重新从磁盘读。 */
	root.addEventListener('click', function (ev) {
		var btn = ev.target && ev.target.closest ? ev.target.closest('[data-market-install]') : null;
		if (!btn) { return; }
		ev.preventDefault();
		var key = String(btn.getAttribute('data-market-install') || '');
		var idx = key.indexOf(':');
		if (idx <= 0) { return; }
		var kind = key.slice(0, idx);
		var slug = key.slice(idx + 1);
		btn.disabled = true;
		btn.textContent = '安装中…';
		fetch('/x/marketplace/api/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: btn.hasAttribute('data-market-upgrade') ? 'upgrade' : 'install', params: { kind: kind, slug: slug } }),
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j && j.ok) { btn.textContent = '已安装'; location.reload(); return; }
			showInstallError(btn, String((j && j.error) || ('HTTP ' + (j ? 'ok=false' : '无响应'))));
		}).catch(function (e) {
			showInstallError(btn, String((e && e.message) || e));
		});
	});

	/* 删除已安装条目：先 confirm，再走商城 op 'trash'（移到回收站，可恢复）。
	   失败**就地显示原因**（与安装失败同一个原则：不许只在 tooltip 里）。 */
	root.addEventListener('click', function (ev) {
		var btn = ev.target && ev.target.closest ? ev.target.closest('[data-tk-del]') : null;
		if (!btn) { return; }
		ev.preventDefault();
		if (ev.stopPropagation) { ev.stopPropagation(); }
		var kind = String(btn.getAttribute('data-tk-kind') || '');
		var slug = String(btn.getAttribute('data-tk-del') || '');
		// ★ 2026-10-24：插件走 uninstall（profile 依赖移除），其它类型仍走 trash（移到回收站）
		var opName = String(btn.getAttribute('data-tk-op') || 'trash');
		var pkgName = String(btn.getAttribute('data-tk-pkg') || '');
		if (!kind || !slug) { return; }
		// ⚠ 这段在**模板字符串**里：反斜杠 n 会被模板解释成真换行，落到页面上就是「字符串里有裸换行」
		//   ⇒ Uncaught SyntaxError（这个坑本文件已经踩过 5 次）。用 String.fromCharCode(10) 绕开。
		var nl = String.fromCharCode(10);
		var confirmMsg = opName === 'uninstall'
			? '卸载「' + slug + '」？' + nl + '会从 dsh profile 的依赖里移除，重启或热重载后不再加载；'
				+ nl + '以后可以从商城重新安装。'
			: '删除「' + slug + '」？' + nl + '会移到 <数据根>/.trash-<时间戳>/ 下（可恢复）。';
		if (!window.confirm(confirmMsg)) { return; }
		btn.disabled = true;
		var label = btn.textContent;
		btn.textContent = opName === 'uninstall' ? '卸载中…' : '删除中…';
		fetch('/x/marketplace/api/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: opName, params: pkgName
				? { kind: kind, slug: slug, packageName: pkgName }
				: { kind: kind, slug: slug } }),
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j && j.ok) { location.reload(); return; }
			btn.disabled = false;
			btn.textContent = label;
			var card = btn.closest ? btn.closest('.tk-card') : null;
			var body = card ? (card.querySelector('.tk-body') || card) : null;
			if (body) {
				var box = body.querySelector('.tk-err');
				if (!box) { box = document.createElement('div'); box.className = 'tk-err'; body.appendChild(box); }
				box.textContent = (opName === 'uninstall' ? '卸载失败：' : '删除失败：') + String((j && j.error) || '商城没返回原因');
			}
		}).catch(function (e) {
			btn.disabled = false;
			btn.textContent = label;
			var card = btn.closest ? btn.closest('.tk-card') : null;
			var body = card ? (card.querySelector('.tk-body') || card) : null;
			if (body) {
				var box = body.querySelector('.tk-err');
				if (!box) { box = document.createElement('div'); box.className = 'tk-err'; body.appendChild(box); }
				box.textContent = (opName === 'uninstall' ? '卸载失败：' : '删除失败：') + String((e && e.message) || e);
			}
		});
	});

	/* 插件开关：POST setPluginEnabled（dsh 侧改 profile 的 bundles 选择）。
	   ⚠ 和删除按钮一样，必须 ev.preventDefault + stopPropagation，否则会连带打开详情弹层。 */
	root.addEventListener('click', function (ev) {
		var sw = ev.target && ev.target.closest ? ev.target.closest('[data-sk-sw]') : null;
		if (!sw) { return; }
		ev.preventDefault();
		if (ev.stopPropagation) { ev.stopPropagation(); }
		if (sw.disabled) { return; }
		var pkg = String(sw.getAttribute('data-sk-sw') || '');
		if (!pkg) { return; }
		var on = sw.getAttribute('data-sk-sw-on') === '1';
		sw.disabled = true;
		function fail(msg) {
			sw.disabled = false;
			var row = sw.closest ? sw.closest('.sk-row') : null;
			var box = row ? row.querySelector('.sk-main') : null;
			if (!box) { return; }
			var err = box.querySelector('.tk-err');
			if (!err) { err = document.createElement('div'); err.className = 'tk-err'; box.appendChild(err); }
			err.textContent = '开关失败：' + msg;
		}
		fetch('/x/marketplace/api/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'setPluginEnabled', params: { name: pkg, enabled: !on } }),
		}).then(function (r) { return r.json(); }).then(function (j) {
			if (j && j.ok) {
				// ★ 2026-10-24（用户：「开关插件后，不要全屏刷新UI，导致莫名切换到了其他页签」）：
				//   开关只改变 profile 的 bundles 选择，**本页的数据没有变** ⇒ 就地更新状态即可。
				//   之前用 location.reload()：整页重拉 → 页签回到默认的「技能」→ 用户以为"跳页了"。
				var nowOn = (j.enabled === undefined) ? !on : (j.enabled === true);
				sw.setAttribute('aria-checked', nowOn ? 'true' : 'false');
				sw.setAttribute('data-sk-sw-on', nowOn ? '1' : '0');
				sw.setAttribute('title', nowOn ? '已启用（点一下停用）' : '已停用（点一下启用）');
				sw.disabled = false;
				var rowEl = sw.closest ? sw.closest('.sk-row') : null;
				if (rowEl) { rowEl.classList.toggle('is-off', !nowOn); }
				// 需要重启才生效时给一句就地提示（仍然不刷新）
				if (j.restartRequired && rowEl) {
					var box2 = rowEl.querySelector('.sk-main');
					if (box2) {
						var note = box2.querySelector('.tk-err');
						if (!note) { note = document.createElement('div'); note.className = 'tk-err'; box2.appendChild(note); }
						note.textContent = '已保存：重启 Host 后生效（本页数据不变）';
					}
				}
				return;
			}
			fail(String((j && j.error) || '商城没返回原因'));
		}).catch(function (e) {
			fail(String((e && e.message) || e));
		});
	});

	/* 卡片详情的展开（只切 hidden，不重渲染 —— 避免丢焦点与闪烁）＋ 路径复制。 */
	root.addEventListener('click', function (ev) {
		var t = ev.target;
		var copy = t && t.closest ? t.closest('[data-sk-copy]') : null;
		if (copy) {
			ev.preventDefault();
			if (ev.stopPropagation) { ev.stopPropagation(); }
			var text = String(copy.getAttribute('data-sk-copy') || '');
			var back = function (ok) {
				copy.textContent = ok ? '已复制' : '复制失败';
				window.setTimeout(function () { copy.textContent = '复制'; }, 1200);
			};
			try {
				if (navigator.clipboard && navigator.clipboard.writeText) {
					navigator.clipboard.writeText(text).then(function () { back(true); }, function () { back(false); });
				} else { back(false); }
			} catch (e) { back(false); }
			return;
		}
		var more = t && t.closest ? t.closest('[data-tk-open]') : null;
		if (!more) { return; }
		if (t.closest('[data-market-install]')) { return; }   // 安装按钮不开详情
		// ★ 2026-10-23（用户：「每个 item 点击后用独立 UI 展示详情」）：
		//   详情不再在卡片里内联展开（那样每类条目长得都不一样），统一走独立弹层。
		var card = more.closest('.tk-card');
		if (!card) { return; }
		openMkDlg(card, more.getAttribute('data-market-detail') || card.getAttribute('data-market-open') || '');
	});

	/* ── 商城商品详情弹层（2026-10-23 用户：「点击 item 要求进入详情 UI，样式参考 colaskill 的详情页」）── */
	var mkDlg = root.querySelector('[data-mk-dlg]');

	function closeMkDlg() {
		if (!mkDlg) { return; }
		// 2026-10-26：发布表单是动态插进正文的，关的时候一并清掉
		var pub = mkDlg.querySelector('.mk-pub');
		if (pub && pub.parentNode) { pub.parentNode.removeChild(pub); }
		mkDlg.hidden = true;
	}

	/**
	 * 统一详情弹层（2026-10-23 用户：「每个 item 点击后用独立 UI 展示详情，包含升级、删除等按钮」）。
	 *
	 * 五类条目（技能行 / 工作流 / Agent / 工作台 / 商城商品）**共用同一个弹层**：
	 *   封面（卡片取 .tk-cover，技能行取 .sk-ico 小图）→ 标签行 → 标题 → 副行
	 *   → 正文（本地条目搬卡片里的 tk-detail / sk-drawer；商城条目按需拉 detail_md）
	 *   → 底部动作（安装 / 升级 / 删除 / 关闭，由卡片的 data-item-* 决定）。
	 *
	 * 名字保留 openMkDlg：p3-57 拿它做存在性断言，换名会让守卫红。
	 */
	/**
	 * 把技能的正文取回来填进 pre[data-sk-body]（弹层与抽屉共用同一段接口）。
	 *
	 * ★ 2026-10-26（用户：「技能内容 显示 读取中 不刷新」）：
	 *   行内抽屉是"点行时取一次"，弹层是"复制抽屉的 HTML" ⇒ 复制品永远不会被填。
	 *   这里给弹层补一次同样的请求；已经取好的（正文末尾带「N 字节 · 路径」）直接跳过。
	 */
	function fillSkillBody(scope, id) {
		if (!scope || !id) { return; }
		var pre = scope.querySelector('[data-sk-body]');
		if (!pre) { return; }
		var cur = String(pre.textContent || '');
		if (cur.indexOf('字节 ·') >= 0) { return; }   // 抽屉里已经取好了，复制过来的就是成品
		pre.textContent = '读取中…';
		window.fetch('/x/skills/api/skill?id=' + encodeURIComponent(id), { credentials: 'same-origin' })
			.then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
			.then(function (r) {
				if (!r.ok) { pre.textContent = '读不了：' + ((r.data && r.data.error) || '未知原因'); return; }
				pre.textContent = (r.data.content || '') + String.fromCharCode(10) + String.fromCharCode(10)
					+ '（' + (r.data.contentBytes || 0) + ' 字节 · ' + (r.data.path || '') + '）';
			})
			.catch(function (e) { pre.textContent = '读不了：' + e; });
	}

	function openMkDlg(card, marketSlug) {
		if (!mkDlg) { return; }
		var slug = String(marketSlug || card.getAttribute('data-market-open') || '');
		// ① 封面：卡片是大图，技能行是小图标（弹层里按小封面渲染）
		var cover = mkDlg.querySelector('[data-mk-cover]');
		var big = card.querySelector('.tk-cover');
		var small = card.querySelector('.sk-ico');
		if (cover) {
			cover.innerHTML = big ? big.innerHTML : (small ? small.innerHTML : '');
			cover.setAttribute('style', big ? (big.getAttribute('style') || '') : (small ? (small.getAttribute('style') || '') : ''));
			cover.classList.toggle('mk-dlg-cover-sm', !big);
		}
		// ② 标签行（卡片是 .tk-pills，技能行是 .sk-rowmeta）
		var pills = mkDlg.querySelector('[data-mk-pills]');
		var pillsSrc = card.querySelector('.tk-pills') || card.querySelector('.sk-rowmeta');
		if (pills) {
			// 技能行用的是 .sk-tag（10px，行内小标签）；弹层里统一成 .tk-pill（11px），
			// 否则同一个弹层里「卡片来的」和「行来的」标签长得不一样（实测差 1px + 配色不同）。
			// 注意：这里不写正则 —— 本段在模板字符串里，反斜杠会被模板吃掉（踩过）。
			var pillsHtml = pillsSrc ? String(pillsSrc.innerHTML) : '';
			pillsHtml = pillsHtml.split('class="sk-tag man"').join('class="tk-pill"')
				.split('class="sk-tag ver"').join('class="tk-pill"')
				.split('class="sk-tag auto"').join('class="tk-pill acc"')
				.split('class="sk-tag always"').join('class="tk-pill acc"');
			pills.innerHTML = pillsHtml;
			// 行里的隐藏 slug 不搬进弹层（标题下面已经有 slug 了，重复）
			var slugs = pills.querySelectorAll('.sk-slug');
			for (var si = 0; si < slugs.length; si++) { slugs[si].parentNode.removeChild(slugs[si]); }
		}
		// ③ 标题 / 副行
		var nm = card.querySelector('.tk-nm') || card.querySelector('.sk-nm');
		var title = mkDlg.querySelector('[data-mk-title]');
		if (title) { title.textContent = nm ? nm.textContent : (slug || '详情'); }
		var subEl = mkDlg.querySelector('[data-mk-sub]');
		if (subEl) {
			var sub = card.querySelector('.tk-sub') || card.querySelector('.sk-ds');
			subEl.textContent = sub ? sub.textContent : '';
		}
		// ④ 正文
		var body = mkDlg.querySelector('[data-mk-body]');
		var local = card.querySelector('.tk-detail');
		// 技能行的详情块是**兄弟节点**（li.sk-row + li.sk-drawer），不在行内部
		if (!local && card.hasAttribute('data-skill-row')) {
			var sib = card.nextElementSibling;
			if (sib && sib.hasAttribute('data-skill-detail')) { local = sib; }
		}
		if (body) {
			// ★ 2026-10-26（用户：「点击后的弹出页缺少该项的详细说明」）：
			//   以前正文只有两块之一：本地条目的「文件/目录」块，或者商城条目的 detail_md。
			//   ⇒ 插件点开只看到包名和路径（它原本的描述就是包名）；商城条目 detail_md 大多为空。
			//   现在固定四段：① 说明（完整描述）② 关键信息（类型/版本/来源…）③ 本地明细 ④ 商城长文
			var descText = String(card.getAttribute('data-item-desc') || '');
			if (!descText) {
				var dsEl = card.querySelector('.tk-ds') || card.querySelector('.sk-ds');
				descText = dsEl ? String(dsEl.textContent || '') : '';
			}
			var factList = [];
			try { factList = JSON.parse(String(card.getAttribute('data-item-facts') || '[]')); } catch (e) { factList = []; }
			if (!(factList instanceof Array)) { factList = []; }
			var outHtml = '';
			if (descText.trim()) {
				outHtml += '<div class="mk-sec"><h4>说明</h4><p>' + escapeHtmlClient(descText) + '</p></div>';
			}
			if (factList.length) {
				var dlHtml = '<dl class="mk-facts">';
				for (var fi = 0; fi < factList.length; fi++) {
					var pair = factList[fi] || [];
					var fk = String(pair[0] === undefined || pair[0] === null ? '' : pair[0]);
					var fv = String(pair[1] === undefined || pair[1] === null ? '' : pair[1]);
					if (!fk || !fv) { continue; }
					dlHtml += '<dt>' + escapeHtmlClient(fk) + '</dt><dd>' + escapeHtmlClient(fv) + '</dd>';
				}
				dlHtml += '</dl>';
				if (dlHtml.indexOf('<dt>') >= 0) { outHtml += dlHtml; }
			}
			// ⚠ 商城卡**自带**一个 .tk-detail（商品信息：标识/版本/作者），以前的条件是
			//   「没有本地块才拉 detail_md」⇒ 商城商品的完整介绍**从来没显示过**（老问题）。
			//   现在：只要有商城 slug 就一定拉，两块同时显示（长文在前，商品信息在后）。
			var needRemote = !!slug;
			if (needRemote) {
				outHtml += '<div class="mk-sec"><h4>完整介绍</h4><div class="mk-detail-body"></div></div>';
			}
			var localHtml = local && String(local.innerHTML).trim() ? String(local.innerHTML) : '';
			if (localHtml) {
				outHtml += '<div class="mk-detail mk-detail-local">' + localHtml + '</div>';
			}
			if (!outHtml) {
				outHtml = '<p class="mk-loading">这条没有更多信息（既没有描述，也没有落盘文件可读）。</p>';
			}
			body.innerHTML = outHtml;
			if (needRemote) { loadMarketDetail(slug, body); }
			// ★ 2026-10-26（用户：「技能内容 显示 读取中 不刷新」）：
			//   技能行里那块 pre[data-sk-body] 的正文是**点行时才异步取**的，而弹层只是把抽屉的
			//   HTML 复制了一份 ⇒ 复制品永远停在「读取中…」（取回的结果只填给了抽屉里那一份）。
			//   ⇒ 弹层自己也要取一次（已经取好的会带「字节 ·」后缀，见函数内的早退）。
			if (card.hasAttribute('data-skill-row')) {
				fillSkillBody(body, String(card.getAttribute('data-skill-id') || ''));
			}
		}

		// ⑤ 底部动作
		buildItemActions(card, slug);
		mkDlg.hidden = false;
	}

	/**
	 * 弹层底部动作 —— 只给**做得到**的按钮，不做假按钮。
	 *
	 * · 商城条目：有包体给「安装」，没包体如实写「仅浏览」；
	 * · 本地已装 + 商城有同名件 + 版本不同/未知 ⇒「升级到 x.y.z」（走商城 upgrade，旧目录先进回收站）；
	 * · 有落盘目录（技能/工作流/Agent）⇒「删除」（走商城 trash，移到 .trash-时间戳，可恢复）；
	 * · 内置条目（工作台）没有上述任何操作 ⇒ 说明一句，而不是摆三个灰按钮。
	 */
	/**
	 * 「上传到商城」表单（★ 2026-10-26：用户「本地新建的…没有上传UI入口」）。
	 *
	 * 两种通道，与后端 publish op 的两个分支一一对应：
	 *   · skill / workflow / agent ⇒ **打包上传**（publishVersion：把目录打成 tar.gz 传上去）
	 *   · workbench / plugin      ⇒ **登记外部来源**（publishExternal：本体在 npm / GitHub，只登记地址）
	 *
	 * 为什么不给 workbench/plugin 也做打包上传：它们的本体是 dsh 插件（在 profile 的
	 * node_modules 里，不在数据根），dsh 侧没有「打包一个已装插件」的能力；
	 * 而服务端 external 接口对任何 kind 都收 ⇒ 让它填 GitHub 地址才是诚实的路径。
	 */
	/**
	 * 把本地 id 压成服务端能接受的 slug（^[a-z0-9][a-z0-9_-]*$）。
	 *
	 * 为什么需要：插件行的 id 就是 npm 包名（@tt-a1i/archify-dsh），带 @ 和 /，
	 * 服务端会直接拒；而商城标识必须是小写字母开头。⇒ 表单里给一个**可编辑**的默认值。
	 */
	function slugifyId(raw) {
		var s = String(raw || '').toLowerCase();
		var out = '';
		for (var i = 0; i < s.length; i++) {
			var c = s.charAt(i);
			if ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '-') { out += c; }
			else { out += '-'; }
		}
		out = out.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
		if (!out) { out = 'item'; }
		if (!/^[a-z0-9]/.test(out)) { out = 'x' + out; }
		return out;
	}

	function isSlugOk(v) {
		if (!v) { return false; }
		if (!/^[a-z0-9][a-z0-9_-]*$/.test(v)) { return false; }
		return true;
	}

	function publishKeyOf(btn) {
		var key = String(btn.getAttribute('data-publish') || '');
		var idx = key.indexOf(':');
		if (idx <= 0) { return null; }
		return {
			kind: key.slice(0, idx),
			id: key.slice(idx + 1),
			external: btn.getAttribute('data-publish-external') === '1',
			name: String(btn.getAttribute('data-publish-name') || ''),
			ver: String(btn.getAttribute('data-publish-ver') || ''),
		};
	}

	function openPublishForm(btn) {
		var info = publishKeyOf(btn);
		if (!info) { return; }
		// ★ 行内的「上传/登记」按钮在**弹层外面**：先把弹层开起来（它会重写正文），再往里插表单。
		//   顺序反了就是"插进去又被 openMkDlg 冲掉"（实测这版真踩了）。
		if (mkDlg.hidden) {
			var host = btn.closest ? (btn.closest('[data-item-row]') || btn.closest('[data-skill-row]') || btn.closest('[data-tk-card]')) : null;
			if (host) { openMkDlg(host, host.getAttribute('data-market-open') || ''); }
		}
		var body = mkDlg.querySelector('[data-mk-body]');
		if (!body) { return; }
		var old = body.querySelector('.mk-pub');
		if (old && old.parentNode) { old.parentNode.removeChild(old); }
		var html = '<div class="mk-pub" data-pub-kind="' + escapeHtmlClient(info.kind)
			+ '" data-pub-id="' + escapeHtmlClient(info.id)
			+ '" data-pub-external="' + (info.external ? '1' : '0') + '">'
			+ '<h4>' + (info.external ? '登记到商城（本体在 npm / GitHub）' : '上传当前条目到商城') + '</h4>'
			+ '<div class="mk-pub-row"><label>标识</label><code>' + escapeHtmlClient(info.kind + ' · ' + info.id) + '</code></div>'
			+ '<div class="mk-pub-row"><label>商城标识</label><input data-pub-slug value="' + escapeHtmlClient(slugifyId(info.id)) + '" placeholder="小写字母/数字/-/_" title="商城里的唯一标识；插件包名带 @scope/ 会被压成 scope-包名，可自行改"></div>'
			+ '<div class="mk-pub-row"><label>名称</label><input data-pub-name value="' + escapeHtmlClient(info.name || info.id) + '"></div>'
			+ '<div class="mk-pub-row"><label>版本</label><input data-pub-ver value="' + escapeHtmlClient(info.ver || '1.0.0') + '" placeholder="1.0.0"></div>'
			+ (info.external
				? '<div class="mk-pub-row"><label>地址 / npm 名</label><input data-pub-source placeholder="https://github.com/owner/repo 或 @scope/pkg"></div>'
				: '')
			+ '<div class="mk-pub-row"><label>更新说明</label><textarea data-pub-changelog rows="2" placeholder="这一版改了什么（可空）"></textarea></div>'
			+ '<p class="mk-pub-note">' + (info.external
				? '只登记来源、不上传包体；别人从商城安装时会按这个地址拉取。'
				: '会把这个目录打包上传（自动排除 node_modules / .git / .upgrade-backup / 备份）。')
			+ '</p>'
			+ '<div class="mk-pub-ops"><button type="button" class="tk-btn primary" data-pub-submit>提交</button>'
			+ '<button type="button" class="tk-btn" data-pub-cancel>取消</button></div>'
			+ '<div class="mk-pre" data-pub-pre></div>'
			+ '<p class="mk-pub-err" data-pub-err></p>'
			+ '</div>';
		body.insertAdjacentHTML('afterbegin', html);
		var box = body.querySelector('.mk-pub');
		if (box && box.scrollIntoView) { try { box.scrollIntoView({ block: 'nearest' }); } catch (e) { } }
		var nameInput = body.querySelector('[data-pub-name]');
		if (nameInput && nameInput.focus) { try { nameInput.focus(); } catch (e) { } }
	}

	/** 用户填的「外部来源」是 npm 包名，还是 GitHub 地址。 */
	function looksLikeNpmName(v) {
		var s = String(v || '').trim();
		if (!s) { return false; }
		if (s.indexOf('github.com') >= 0) { return false; }
		// owner/repo 这种简写算 GitHub，不算 npm 名
		if (/^[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+$/.test(s)) { return false; }
		return /^(@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*$/i.test(s);
	}

	/** 把体检结果画进表单（pass / warn / error 三色，逐条列出）。 */
	function renderPreflight(box, result) {
		var host = box.querySelector('[data-pub-pre]');
		if (!host) { return; }
		var level = String((result && result.level) || 'error');
		var checks = (result && result.checks) || [];
		var head = level === 'error'
			? '体检未通过 —— 先按下面提示修，再提交'
			: (level === 'warn' ? '体检有提醒（可以继续提交）' : '体检通过');
		var html = '<div class="mk-pre-head mk-pre-' + level + '">' + escapeHtmlClient(head) + '</div>';
		if (checks.length) {
			html += '<ul class="mk-pre-list">';
			for (var i = 0; i < checks.length; i++) {
				var c = checks[i] || {};
				html += '<li class="mk-pre-item mk-pre-' + String(c.level || 'pass') + '">'
					+ '<b>' + escapeHtmlClient(String(c.title || '')) + '</b>'
					+ (c.detail ? '<span>' + escapeHtmlClient(String(c.detail)) + '</span>' : '')
					+ '</li>';
			}
			html += '</ul>';
		}
		if (result && result.suggestion) {
			html += '<button type="button" class="tk-btn" data-pub-apply="'
				+ escapeHtmlClient(encodeURIComponent(JSON.stringify(result.suggestion))) + '">按建议修正</button>';
		}
		host.innerHTML = html;
	}

	function submitPublish(btn) {
		var box = btn.closest ? btn.closest('.mk-pub') : null;
		if (!box) { return; }
		// 上下文记在表单元素上（行内按钮不在弹层里，querySelector 找不到它）
		var info = {
			kind: String(box.getAttribute('data-pub-kind') || ''),
			id: String(box.getAttribute('data-pub-id') || ''),
			external: box.getAttribute('data-pub-external') === '1',
		};
		if (!info.kind || !info.id) { return; }
		var val = function (sel) {
			var el = box.querySelector(sel);
			return el && typeof el.value === 'string' ? el.value.trim() : '';
		};
		var errEl = box.querySelector('[data-pub-err]');
		var fail = function (msg) {
			if (errEl) { errEl.textContent = msg; }
			btn.disabled = false;
			btn.textContent = '提交';
		};
		var version = val('[data-pub-ver]');
		var name = val('[data-pub-name]');
		var changelog = val('[data-pub-changelog]');
		var source = val('[data-pub-source]');
		var slug = val('[data-pub-slug]');
		if (!version) { fail('版本号不能为空'); return; }
		if (info.external && !source) { fail('登记外部来源需要填 GitHub 地址或 npm 包名'); return; }
		var isNpm = info.external && looksLikeNpmName(source);
		if (info.external && isNpm && !/^(@[a-z0-9][a-z0-9._-]*\\/)?[a-z0-9][a-z0-9._-]*$/i.test(source)) {
			fail('npm 包名不合法：' + source); return;
		}
		// 商城标识必须符合服务端规则（插件包名 @scope/x 不合法）⇒ 前端先拦一次，别白跑一趟
		if (!isSlugOk(slug)) { fail('商城标识不合法：只能小写字母开头，且仅含 a-z 0-9 _ -（当前：' + slug + '）'); return; }

		var params = { kind: info.kind, localId: slug, version: version };
		if (name) { params.name = name; }
		if (changelog) { params.changelog = changelog; }
		if (info.external) {
			// npm 源 → npmName；GitHub → source（两条通道都在 dsh 侧自持）
			if (isNpm) { params.npmName = source; } else { params.source = source; }
		}

		var doPublish = function () {
			btn.disabled = true;
			btn.textContent = '提交中…';
			window.fetch('/x/marketplace/api/action', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: 'publish', params: params }),
			}).then(function (r) { return r.json(); }).then(function (j) {
				if (!j || !j.ok) { fail('提交失败：' + String((j && j.error) || '商城没返回原因')); return; }
				var msg = (j.created ? '已新建商品' : '已新增版本') + ' · ' + String(j.version || version);
				if (j.bytes) { msg += ' · ' + Math.round(j.bytes / 1024) + 'KB'; }
				// ★ 2026-10-26：同一发布源被别的商品登记过 ⇒ 服务端回 duplicates（不阻断）
				var dup = (j && j.duplicates) || [];
				var dupHtml = '';
				if (dup.length) {
					var names = [];
					for (var di = 0; di < dup.length; di++) { names.push(String((dup[di] || {}).slug || '')); }
					dupHtml = '<p class="mk-pub-warn">⚠ 这个发布源已被这些商品登记：'
						+ escapeHtmlClient(names.join(' / '))
						+ '（可能是重复上架，建议删掉多余的那条）</p>';
				}
				box.innerHTML = '<h4>已提交：' + escapeHtmlClient(msg) + '</h4>'
					+ dupHtml
					+ '<p class="mk-pub-note">本地条目没有改动。刷新商城列表后就能看到这一件。</p>'
					+ '<div class="mk-pub-ops"><button type="button" class="tk-btn primary" data-pub-reload>刷新页面看结果</button></div>';
			}).catch(function (e) {
				fail('提交失败：' + String((e && e.message) || e));
			});
		};

		// ★ 2026-10-26（用户：「有没有校验机制，避免发布错误」）：
		//   提交前先跑一次体检：判断这个发布源**到底能不能装**（是不是 dsh 插件 / 版本对不对）。
		//   error ⇒ 拦下；warn ⇒ 让用户确认；pass ⇒ 直接发。
		btn.disabled = true;
		btn.textContent = '体检中…';
		var pre = { kind: info.kind, version: version };
		if (info.external) {
			if (isNpm) { pre.npmName = source; } else { pre.source = source; }
		}
		window.fetch('/x/marketplace/api/action', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ op: 'preflightPublish', params: pre }),
		}).then(function (r) { return r.json(); }).then(function (pf) {
			var result = pf && pf.level ? pf : {
				level: 'error',
				checks: [{ level: 'error', title: '体检没跑起来：' + String((pf && pf.error) || '商城没返回原因') }],
			};
			renderPreflight(box, result);
			btn.disabled = false;
			btn.textContent = '提交';
			if (result.level === 'error') { return; }
			if (result.level === 'warn') {
				var lines = [];
				var checks = result.checks || [];
				for (var i = 0; i < checks.length; i++) {
					if (checks[i].level === 'warn') { lines.push('· ' + String(checks[i].title || '')); }
				}
				var ask = '体检有 ' + lines.length + ' 条提醒：' + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
					+ String.fromCharCode(10) + String.fromCharCode(10) + '仍然提交？';
				if (!window.confirm(ask)) { return; }
			}
			doPublish();
		}).catch(function (e) {
			// 体检本身挂了（网络/桥）⇒ 不阻断发布，但要说清楚
			if (errEl) { errEl.textContent = '体检未完成：' + String((e && e.message) || e) + '（已跳过，直接提交）'; }
			btn.disabled = false;
			btn.textContent = '提交';
			doPublish();
		});
	}

	function handlePublishClick(t) {
		if (!t || !t.closest) { return false; }
		if (t.closest('[data-pub-cancel]')) {
			var box = t.closest('.mk-pub');
			if (box && box.parentNode) { box.parentNode.removeChild(box); }
			return true;
		}
		if (t.closest('[data-pub-reload]')) { location.reload(); return true; }
		if (t.closest('[data-pub-apply]')) {
			var raw = t.closest('[data-pub-apply]').getAttribute('data-pub-apply') || '';
			var sug = null;
			try { sug = JSON.parse(decodeURIComponent(raw)); } catch (e) { sug = null; }
			var box2 = t.closest('.mk-pub');
			if (sug && box2) {
				var src = box2.querySelector('[data-pub-source]');
				if (src && sug.name) { src.value = String(sug.name); }
				var ver = box2.querySelector('[data-pub-ver]');
				if (ver && sug.version) { ver.value = String(sug.version); }
				var e2 = box2.querySelector('[data-pub-err]');
				if (e2) { e2.textContent = '已按建议填写，请再点一次「提交」'; }
			}
			return true;
		}
		if (t.closest('[data-pub-submit]')) { submitPublish(t.closest('[data-pub-submit]')); return true; }
		if (t.closest('[data-publish]')) { openPublishForm(t.closest('[data-publish]')); return true; }
		return false;
	}

	function buildItemActions(card, marketSlug) {
		var foot = mkDlg.querySelector('[data-mk-foot]');
		if (!foot) { return; }
		var kind = String(card.getAttribute('data-item-kind') || '');
		var itemSlug = String(card.getAttribute('data-item-slug') || '');
		var store = String(card.getAttribute('data-item-store') || '');
		var upver = String(card.getAttribute('data-item-upver') || '');
		var lver = String(card.getAttribute('data-item-lver') || '');
		var del = String(card.getAttribute('data-item-del') || '');
		var html = '';
		if (marketSlug) {
			var inst = card.querySelector('[data-market-install]');
			if (inst) {
				html += '<button type="button" class="tk-btn primary" data-market-install="'
					+ escapeHtmlClient(String(inst.getAttribute('data-market-install') || '')) + '">安装</button>';
			} else {
				// 具体原因写在卡片那个「仅浏览」标签的 title 里（有版本但没包体 / 压根没版本，两种说法）
				var browseNote = card.querySelector('.tk-only-browse');
				var why = browseNote ? String(browseNote.getAttribute('title') || '') : '';
				html += '<span class="mk-note">' + escapeHtmlClient(why || '这个商品在商城里没有包体') + ' ⇒ 仅浏览</span>';
			}
		}
		var upKindOk = kind === 'skill' || kind === 'workflow' || kind === 'agent';
		if (!marketSlug && upKindOk && store && upver && (!lver || lver !== upver)) {
			html += '<button type="button" class="tk-btn primary" data-market-install="'
				+ escapeHtmlClient(kind + ':' + store) + '" data-market-upgrade title="用商城的 '
				+ escapeHtmlClient(upver) + ' 覆盖本地（旧目录先移到回收站）">升级到 ' + escapeHtmlClient(upver) + '</button>';
		}
		if (del && itemSlug) {
			var dOp = String(card.getAttribute('data-item-delop') || '');
			var dPkg = String(card.getAttribute('data-item-pkg') || '');
			html += '<button type="button" class="tk-btn tk-del" data-tk-del="' + escapeHtmlClient(itemSlug)
				+ '" data-tk-kind="' + escapeHtmlClient(del) + '"'
				+ (dOp ? ' data-tk-op="' + escapeHtmlClient(dOp) + '"' : '')
				+ (dPkg ? ' data-tk-pkg="' + escapeHtmlClient(dPkg) + '"' : '')
				+ '>' + (dOp === 'uninstall' ? '卸载' : '删除') + '</button>';
		}
		// ★ 2026-10-26（用户：「本地新建的技能/agent/工作流/工作台/插件，没有上传UI入口」）
		//   本地条目（不是商城卡）加发布入口，两种通道见 openPublishForm 的注释。
		//   内置的（随产品发布的 @vssaros/*）不给：它已经在商城里，重复登记只会冲突。
		var fSrc = String(card.getAttribute('data-f-src') || '');
		var bundleKind = kind === 'skill' || kind === 'workflow' || kind === 'agent';
		var externalKind = kind === 'workbench' || kind === 'plugin';
		if (!marketSlug && itemSlug && fSrc !== 'builtin' && (bundleKind || externalKind)) {
			var nmEl = card.querySelector('.sk-nm') || card.querySelector('.tk-nm');
			var pubName = nmEl ? String(nmEl.textContent || '') : itemSlug;
			html += '<button type="button" class="tk-btn" data-publish="'
				+ escapeHtmlClient(kind + ':' + itemSlug) + '"'
				+ ' data-publish-external="' + (externalKind ? '1' : '0') + '"'
				+ ' data-publish-name="' + escapeHtmlClient(pubName) + '"'
				+ ' data-publish-ver="' + escapeHtmlClient(lver) + '"'
				+ ' title="' + (externalKind
					? '登记到商城：本体在 npm / GitHub，只登记来源'
					: '打包上传到商城：生成新版本，别人可以从商城安装') + '">'
				+ (externalKind ? '登记到商城…' : '上传到商城…') + '</button>';
		}
		// 内置条目没有发布入口时**要说清为什么**，否则就是用户看到的那种「没有入口」。
		// 2026-10-26：工作台 13 个、插件 32 个都是随产品发布的 @vssaros/*，已在商城里。
		if (!marketSlug && itemSlug && fSrc === 'builtin' && (bundleKind || externalKind)) {
			html += '<span class="mk-note">内置条目（随产品发布）已在商城中，无需再上传。</span>';
		}

		if (!html) {
			html = '<span class="mk-note">内置条目：不涉及安装 / 升级 / 删除。</span>';
		}
		html += '<button type="button" class="tk-btn" data-mk-close>关闭</button>';
		foot.innerHTML = html;
	}
	root.addEventListener('click', function (ev) {
		var t = ev.target;
		if (t && t.closest && t.closest('[data-mk-close]')) { ev.preventDefault(); closeMkDlg(); return; }
		// ★ 发布表单走同一个委派入口（弹层内点击原本会被下面的 early-return 吃掉）
		if (handlePublishClick(t)) { if (ev.preventDefault) { ev.preventDefault(); } if (ev.stopPropagation) { ev.stopPropagation(); } return; }
		// 弹层内的按钮不回流到卡片逻辑（安装按钮由上面那个监听器处理）
		if (t && t.closest && t.closest('[data-mk-dlg]')) { return; }
		if (t && t.closest && (t.closest('[data-market-install]') || t.closest('[data-tk-open]'))) { return; }
		var card = t && t.closest ? t.closest('[data-market-open]') : null;
		if (!card) { return; }
		ev.preventDefault();
		openMkDlg(card, card.getAttribute('data-market-open'));
	});

	document.addEventListener('keydown', function (ev) {
		if (ev.key === 'Escape' && mkDlg && !mkDlg.hidden) { closeMkDlg(); }
	});

	/* 商城卡片的「详情」按钮：不再在卡片里内联展开，改为开弹层（与点卡片一致）。 */
	root.addEventListener('click', function (ev) {
		var t = ev.target;
		var btn = t && t.closest ? t.closest('[data-market-detail]') : null;
		if (!btn) { return; }
		var card = btn.closest('.tk-card');
		if (!card) { return; }
		ev.preventDefault();
		if (ev.stopPropagation) { ev.stopPropagation(); }
		openMkDlg(card, btn.getAttribute('data-market-detail'));
	}, true);

	/* 点卡片 / 技能行的空白处 → 打开同一个详情弹层。
	   按钮（安装/升级/删除/齿轮/复制）各有监听器，这里一律跳过，避免"点删除却弹详情"。 */
	root.addEventListener('click', function (ev) {
		var t = ev.target;
		if (!t || !t.closest) { return; }
		if (t.closest('[data-mk-dlg]') || t.closest('[data-market-install]') || t.closest('[data-tk-del]')
			|| t.closest('[data-publish]')   // ★ 2026-10-26：行内「上传」按钮，别同时把弹层也开起来
			|| t.closest('[data-sk-sw]')
			|| t.closest('[data-sk-settings]') || t.closest('[data-sk-copy]') || t.closest('.sk-gear')) { return; }
		var host = t.closest('[data-tk-card]') || t.closest('[data-skill-row]') || t.closest('[data-item-row]');
		if (!host) { return; }
		ev.preventDefault();
		openMkDlg(host, host.getAttribute('data-market-open') || '');
	});

	/* 已安装折叠组：开合状态记进 localStorage（刷新后保持用户上次的选择）。
	   ⚠ 只对 data-sk-fold 的 details 生效，别的 details（连接器的工具清单）不动。 */
	Array.prototype.slice.call(root.querySelectorAll('details[data-sk-fold]')).forEach(function (d) {
		var k = 'vssaros.tools.fold.' + String(d.getAttribute('data-sk-fold') || '');
		try { var v = localStorage.getItem(k); if (v === '0') { d.open = false; } else if (v === '1') { d.open = true; } } catch (e) { }
		d.addEventListener('toggle', function () {
			try { localStorage.setItem(k, d.open ? '1' : '0'); } catch (e) { }
		});
	});

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

/**
 * 「工具」页的附加数据源（2026-10-23 合并页：技能 + 商城 + 连接器 + 工作流 + Agent + 工作台）。
 *
 * ⚠ 本页**只读聚合**：工作流真源 `<数据根>/workflows/<id>/workflow.json`（vssaros-workflow 负责读写），
 *   Agent 真源 `<数据根>/agents/<id>/.agent.md`（vssaros-agents 负责读写）。这里不写这两个目录 ——
 *   编辑 / 启停 / 删除仍然去各自模块页，避免两套写链路抢同一份文件。
 */
/**
 * 商城目录（**可选依赖** `vssaros-marketplace`）：同源 POST `/x/marketplace/api/action`，`{op:"list"}`，转发 Cookie。
 *
 * 契约（2026-10-23 核对 marketplace/lib/index.js + dispatch.js）：
 *   · 读：`{op:"list", params:{}}` ⇒ `{ok:true, total, items:[{kind,slug,name,version,description,author,tags,installedVersion}]}`
 *   · 装：`{op:"install", params:{kind, slug}}` ⇒ `{ok, error}`（**永远 200**，只认 ok）
 *   · kind：skill / workflow / agent / workbench / mcp（与五个页签一一对应）
 * 没装商城 / 未登录 / 网络失败 ⇒ `{ok:false, error}`，页面只显示本地条目（**不挡路**）。
 */
const MARKET_ACTION_ROUTE = '/x/marketplace/api/action';
/** 页签 → 商城 kind（页面 tab 名与商城的商品分类不是同一套词）。 */
const MARKET_KIND_OF = { skills: 'skill', conn: 'mcp', workflows: 'workflow', agents: 'agent', workbenches: 'workbench', plugins: 'plugin' };

/**
 * 每个 kind 各拉一次要多少条。
 *
 * ⚠ 2026-10-24 血泪：原来是**一次拉 `pageSize: 200` 且不带 kind** ⇒
 *   商城只有 168 个包时够用，但当天新增 **6704 个 `plugin`** 后，
 *   这 200 条**全被 plugin 占满**（实测 200/200 都是 plugin）
 *   ⇒ 技能 / 连接器 / 工作流 / Agent / 工作台 5 个页签的**可安装商品全部消失** ✗✗
 * ⇒ 改成**按 kind 分别请求**，某种 kind 数量暴涨也挤不掉别人 ✓
 */
const MARKET_FETCH_PLAN = [
	{ kind: 'skill', pageSize: 200 },
	{ kind: 'mcp', pageSize: 200 },
	{ kind: 'workflow', pageSize: 200 },
	{ kind: 'agent', pageSize: 200 },
	{ kind: 'workbench', pageSize: 200 },
	// plugin 有 6704 个 ⇒ 页面只展示前 60 个，其余引导去商城
	{ kind: 'plugin', pageSize: 60 },
];

/** 当前页签最多渲染多少个商城商品（plugin 有 6704 个，全渲染会卡死）。 */
const MARKET_PAGE_SIZE = { plugin: 60 };

/**
 * 拉**某一页**某个 kind 的商城商品（「加载更多」用）。
 *
 * 与 `fetchMarketItems` 的区别：那个是首屏（各 kind 各一页），这个是**按需翻页**。
 * 都不带缓存（`cache-control: no-store` 由调用方写）。
 */
async function fetchMarketPage(req, kind, page, pageSize) {
	const host = req.headers?.host;
	if (!host) { return { ok: false, error: '取不到 Host 头', items: [] }; }
	try {
		const res = await fetch(`http://${host}${MARKET_ACTION_ROUTE}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(req.headers?.cookie ? { cookie: String(req.headers.cookie) } : {}),
			},
			body: JSON.stringify({ op: 'list', params: { kind, page, limit: pageSize } }),
			signal: AbortSignal.timeout(8000),
		});
		const j = await res.json().catch(() => null);
		if (!j || j.ok !== true) { return { ok: false, error: String(j?.error ?? `HTTP ${res.status}`), items: [] }; }
		return { ok: true, items: Array.isArray(j.items) ? j.items : [], total: Number(j.total) || 0 };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e), items: [] };
	}
}

async function fetchMarketItems(req) {
	const host = req.headers?.host;
	if (!host) { return { ok: false, error: '取不到 Host 头' }; }
	const cookie = req.headers?.cookie ? { cookie: String(req.headers.cookie) } : {};
	const one = async (kind, pageSize) => {
		const res = await fetch(`http://${host}${MARKET_ACTION_ROUTE}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...cookie },
			body: JSON.stringify({ op: 'list', params: { kind, limit: pageSize } }),
			signal: AbortSignal.timeout(5000),
		});
		const j = await res.json().catch(() => null);
		if (!j || j.ok !== true) { throw new Error(String(j?.error ?? `HTTP ${res.status}`)); }
		return { items: Array.isArray(j.items) ? j.items : [], total: Number(j.total) || 0 };
	};
	try {
		const results = await Promise.all(MARKET_FETCH_PLAN.map(p => one(p.kind, p.pageSize).catch(() => ({ items: [], total: 0 }))));
		const items = results.flatMap(r => r.items);
		if (items.length === 0) { return { ok: false, error: '商城没有返回任何商品（或未登录）' }; }
		// 各 kind 的总数（页面用来说明「共 N 个，展示前 M 个」）
		const totals = {};
		MARKET_FETCH_PLAN.forEach((p, i) => { totals[p.kind] = results[i].total; });
		return { ok: true, items, totals };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

/**
 * 读 dsh profile 里**实际装着的插件** —— 也就是「内置 / 已安装」这两个过滤档的数据源。
 *
 * 数据源是 `<数据根>/dsh-home/profiles/<profile>/package.json` 的 dependencies：
 *   · `@vssaros/*` / `@deepseek-ai/*` ⇒ **内置**（随产品或 dsh 官方发布，用户没装过也在）
 *   · 其余（@tt-a1i/… / dshmarket / dsh-xxx-workbench…）⇒ **已安装**（从商城装的）
 *
 * ⚠ 不要用「商城台账」当唯一判据：台账只记"本机通过商城装过什么"，
 *   而内置插件从来没走商城 ⇒ 台账里永远没有它们（这是"内置永远是 0"的老根因）。
 */
function readProfilePlugins(dataRoot) {
	const result = { profile: '', file: '', items: [], bundles: [], error: '' };
	if (!dataRoot) { result.error = '数据根未知'; return result; }
	const dir = join(dataRoot, 'dsh-home', 'profiles');
	let names = [];
	try {
		names = readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
	} catch { result.error = '没有 dsh-home/profiles 目录'; return result; }
	// 优先 vssaros（本产品的 profile），否则取第一个
	const pick = names.includes('vssaros') ? 'vssaros' : names[0];
	if (!pick) { result.error = 'profiles 目录是空的'; return result; }
	const file = join(dir, pick, 'package.json');
	if (!existsSync(file)) { result.error = 'profile 里没有 package.json'; return result; }
	result.profile = pick;
	result.file = file;
	let pkg = null;
	try { pkg = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { result.error = 'package.json 读不了：' + String(e && e.message || e); return result; }
	const deps = (pkg && pkg.dependencies) || {};
	// ⚠ dependencies 里的值可能是 `file:C:/…`（本地 link）或 `^1.2.3`，**不是**版本号 ⇒
	//   优先读 node_modules/<name>/package.json 的 version；读不到才退回依赖串（file: 显示为「本地链接」）。
	const versionOf = name => {
		try {
			const pj = join(dir, pick, 'node_modules', name, 'package.json');
			const j = JSON.parse(readFileSync(pj, 'utf8'));
			if (j && j.version) { return String(j.version); }
		} catch { /* 读不到就退回依赖串 */ }
		const raw = String(deps[name] || '');
		if (/^file:/.test(raw)) { return '本地链接'; }
		return raw.replace(/^[\^~]/, '') || '未声明';
	};
	// ★ 2026-10-24（用户：「插件 item 是允许有开关的」）：开关的**当前状态**看这里 ——
	//   profile 的 `dsh.profile.bundles` 就是"被选中的 bundle 层"；不在这个数组里 = 已停用。
	//   （`setBundleEnabled` 改的也正是这份选择，所以两边是同一份真源。）
	const profileNode = pkg && pkg.dsh && pkg.dsh.profile;
	result.bundles = (profileNode && Array.isArray(profileNode.bundles) ? profileNode.bundles : []).map(String);
	result.items = Object.keys(deps).map(name => ({
		name,
		version: versionOf(name),
		// 随产品 / 官方发布 ⇒ 内置（用户没做过任何操作它也在）
		builtin: /^@(vssaros|deepseek-ai)\//.test(name),
	}));
	return result;
}

/**
 * 某个页签下**尚未安装**的商城商品。
 * `installedVersion` 非空 = 已装（商城的台账给的）⇒ 不重复列出（本地那侧已经有一条了）。
 */
function marketItemsFor(market, tab) {
	if (!market || market.ok !== true) { return []; }
	const kind = MARKET_KIND_OF[tab];
	return (market.items || []).filter(it => it && it.kind === kind && !it.installedVersion && it.slug);
}

/** 商城卡片：**照商城的 item 观感**（标签 / 标题 / 描述 / 作者 / 安装按钮），并标 `data-tk-src="market"`。 */
/** 商城卡片：与本地卡片**同一套骨架**（封面 / pill / 标题 / 副行 / 描述 / 底部按钮）。 */
/**
 * 商城描述尾部带一段元信息（`---` 换行 + 来源/许可/作者…，是导入脚本拼进去的）⇒ 展示时只取正文首段。
 * ★ 2026-10-23：不裁的话，卡片上会露出「来源: Cola Skill（https://…）」这种给人看的信息 ✗
 */
function shortStoreDesc(d) {
	return String(d || '').split(/\n\s*---/)[0].replace(/\s+/g, ' ').trim();
}

/**
 * 商城商品的**上传日期**（★ 2026-10-26 用户：「为每个 item 加上上传日期」）。
 *
 * 服务端字段是 `created_at`（毫秒时间戳、蛇形命名）。
 * 口径与商城页面一致：7 天内「3 天前」，更早给 `YYYY-MM-DD`；读不到返回空串。
 */
function fmtUploadDate(ms) {
	const n = Number(ms);
	if (!Number.isFinite(n) || n <= 0) { return ''; }
	const d = new Date(n);
	if (Number.isNaN(d.getTime())) { return ''; }
	const diff = Date.now() - n;
	const day = 86400000;
	if (diff >= 0 && diff < day) { return '今天'; }
	if (diff >= day && diff < 7 * day) { return Math.floor(diff / day) + ' 天前'; }
	// 本地时区（不用 toISOString —— 那是 UTC，跨时区差一天）
	const mo = d.getMonth() + 1;
	const dd = d.getDate();
	return d.getFullYear() + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (dd < 10 ? '0' + dd : dd);
}

function renderMarketCard(it) {
	const name = String(it.name || it.slug);
	const key = String(it.kind) + ':' + String(it.slug);
	const kind = String(it.kind || '');
	const icon = String(it.icon || '').trim();
	const cover = String(it.cover || '').trim();
	// ★ 2026-10-24（用户：「工作台 item 中的图像丢失」）：卡片大图要看 **cover**，不能只看 icon。
	//   服务端这两者是分开的语义：cover = 大图（卡片/详情页），icon = 小图标（行首 28px）。
	//   工作台那批商品 icon 是空的、只有 cover ⇒ 以前这里退化成 emoji 字形，看着就是"图没了" ✗
	const bigImage = isImageIcon(cover) ? cover : (isImageIcon(icon) ? icon : '');
	const fallbackGlyph = escapeHtml(icon && icon.length <= 4 && !isImageIcon(icon) ? icon : (KIND_EMOJI[kind] || '\u{1F4E6}'));
	const glyph = '<span class="tk-cover-glyph" aria-hidden="true"' + (bigImage ? ' hidden' : '') + '>' + fallbackGlyph + '</span>';
	// 同本地卡片：外链失效时露字形，而不是留一块空白
	const coverInner = bigImage
		? '<img src="' + escapeHtml(bigImage) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="'
			+ COVER_ONERROR + '">' + glyph
		: glyph;
	// 详情抽屉/弹层也要这张图（openMkDlg 从卡片里取 img，取不到就退回字形）
	it.cover = bigImage || cover;
	return '<li class="tk-card tk-market-card" data-tk-card data-tk-src="market" data-tk-state="market" data-market-open="' + escapeHtml(String(it.slug)) + '"'
		+ fAttrs({ src: 'market', ver: it.version ? 'yes' : 'no' })
		// ★ 2026-10-26：弹层需要「说明 + 关键信息」，而商城 90% 的商品 detail_md 是空的
		// ⚠ 必须走 shortStoreDesc：商城描述末尾常带「来源: xxx」这类元信息，
		//   p3-57 有一条断言守着「尾巴不进页面」（藏进属性里也算进 ✗）
		+ ' data-item-desc="' + escapeHtml(shortStoreDesc(String(it.description || ''))) + '"'
		+ ' data-item-facts="' + escapeHtml(JSON.stringify([
			['类型', ({ skill: '技能', workflow: '工作流', agent: 'Agent', mcp: '连接器', workbench: '工作台', plugin: '插件' })[kind] || kind],
			['商城标识', key],
			['版本', String(it.version || '未声明')],
			['作者', String(it.author || '商城')],
			...(Array.isArray(it.tags) && it.tags.length ? [['标签', it.tags.join('、')]] : []),
		])) + '"'
		+ ' title="' + escapeHtml(key) + '">'
		+ '<div class="tk-cover" style="background:' + iconBgOf(String(it.slug || name)) + '">' + coverInner + '</div>'
		+ '<div class="tk-body">'
		+ '<div class="tk-pills"><span class="tk-pill acc">商城</span>'
		// 商城商品也把 slug 摆出来（可读名做标题，slug 弱化）——与本地条目口径一致
		+ '<span class="tk-pill dim" title="slug（技术 id）">' + escapeHtml(String(it.slug || '')) + '</span>'
		+ (it.version ? '<span class="tk-pill">' + escapeHtml(String(it.version)) + '</span>' : '') + '</div>'
		+ '<div class="tk-nm">' + escapeHtml(name) + '</div>'
		// ★ 2026-10-26：作者 · 上传日期（字段名是蛇形 `created_at`）
		+ '<div class="tk-sub">' + escapeHtml(String(it.author || '商城'))
		+ (fmtUploadDate(it.created_at) ? ' · ' + escapeHtml(fmtUploadDate(it.created_at)) : '') + '</div>'
		+ (it.description ? '<div class="tk-ds">' + escapeHtml(shortStoreDesc(it.description).slice(0, 140)) + '</div>' : '')
		// ★ 能不能装**由服务端说了算**（`installable` = 有包体 或 有外部发布源）。
		//   2026-10-24（用户：「安装插件失败 … HTTP 404」）：以前只判 `it.version`，
		//   而商城里 6704 个 plugin / 33 个 workbench 都是"有版本号、没包体" ⇒ 点了必然失败。
		//   服务端现在回传 installable，这里据此显示「安装」或「仅浏览」，不再留必然失败的按钮。
		+ '<div class="tk-ops"><button type="button" class="tk-btn" data-tk-open="1" aria-expanded="false" data-market-detail="' + escapeHtml(String(it.slug)) + '">详情</button>'
		+ (it.version && it.installable !== false
			? '<button type="button" class="tk-btn primary" data-market-install="' + escapeHtml(key) + '">安装</button>'
			: '<span class="tk-only-browse" title="' + (it.version
				? '商城只登记了元数据（没有包体，也没有 npm / GitHub 发布源）⇒ 装不了'
				: '这个商品在商城里没有包体（只有介绍）') + '">仅浏览</span>')
		+ '</div>'
		+ '<div class="tk-detail" hidden><div class="mk-detail-body"></div><div class="paths"><h4>商品信息</h4>'
		+ '<div class="path-row"><span class="pk">标识</span><span class="pv"><code>' + escapeHtml(key) + '</code></span></div>'
		+ '<div class="path-row"><span class="pk">版本</span><span class="pv"><code>' + escapeHtml(String(it.version || '未声明')) + '</code></span></div>'
		+ '<div class="path-row"><span class="pk">作者</span><span class="pv"><code>' + escapeHtml(String(it.author || '商城')) + '</code></span></div>'
		+ '</div><p class="sk-note">安装后落在数据根；装完本页会自动刷新。</p></div>'
		+ '</div></li>';
}
function marketGridHtml(market, tab) {
	const items = marketItemsFor(market, tab);
	if (!items.length) { return ''; }
	return '<div class="tk-market-hd">商城 · 可直接安装 <span>' + items.length + ' 个</span></div>'
		+ '<ul class="tk-grid tk-market">' + items.map(renderMarketCard).join('') + '</ul>';
}
async function scanWorkflowsOf(config) {
	const root = join(dataRootOf(config), 'workflows');
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return { root, items: [], errors: [] };
	}
	const items = [];
	const errors = [];
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith('.')) { continue; }
		const file = join(root, e.name, 'workflow.json');
		try {
			const j = JSON.parse(await readFile(file, 'utf8'));
			items.push({
				id: String(j.id || e.name),
				name: String(j.name || e.name),
				desc: String(j.description || ''),
				nodes: Array.isArray(j.nodes) ? j.nodes.length : 0,
				active: j.isActive !== false,
				path: file,
				updatedAt: Number(j.updatedAt) || 0,
			});
		} catch (err) {
			errors.push(e.name + "：" + String(err?.message ?? err));
		}
	}
	items.sort((a, b) => b.updatedAt - a.updatedAt);
	return { root, items, errors };
}

async function scanAgentsOf(config) {
	const root = join(dataRootOf(config), 'agents');
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return { root, items: [], errors: [] };
	}
	const items = [];
	const errors = [];
	for (const e of entries) {
		if (!e.isDirectory() || e.name.startsWith('.')) { continue; }
		const file = join(root, e.name, '.agent.md');
		let text;
		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue; // 没有 .agent.md 的子目录：正常（比如 .builtin-v2-migrated）
		}
		const { meta } = parseFrontmatter(text);
		const name = String(meta.name || '').trim();
		if (!name) {
			errors.push(e.name + "：缺 name（preset 的 id 与展示名都靠它）");
			continue;
		}
		items.push({
			id: String(meta.id || e.name),
			name,
			desc: String(meta.description || ''),
			model: String(meta.model || ''),
			role: String(meta.role || ''),
			path: file,
		});
	}
	items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
	return { root, items, errors };
}

/**
 * 工作台模块清单（dsh 侧只读镜像）。
 * ⚠ 真正的注册在宿主服务 `desktopWorkbenches`（IDE 活动栏管理），本插件读不到 ⇒ 维护 route 表，
 *   并如实标注只读，不假装能在这里开关。
 */
const TOOLS_WORKBENCHES = [
	{ name: '主页', desc: '会话遥测 / 用量与编排', route: '/x/dashboard/', provider: 'vssaros-dashboard' },
	{ name: '看板', desc: '看板存储与卡片工具', route: '/x/kanban/', provider: 'vssaros-kanban' },
	{ name: '知识库', desc: '知识库索引与检索', route: '/x/kb/', provider: 'vssaros-kb' },
	{ name: '代码库', desc: '代码图谱与符号检索', route: '/x/codebase/', provider: 'vssaros-codebase' },
	{ name: '历史会话', desc: '会话分组 / 人格标记 / 指示灯', route: '/x/sessions/', provider: 'vssaros-sessions' },
	{ name: '媒体库', desc: '只读 media.db 页面', route: '/x/media/', provider: 'vssaros-media' },
	{ name: '工具', desc: '技能 / 连接器 / 工作流 / Agent（本页）', route: '/x/skills/', provider: 'vssaros-skills' },
	{ name: 'MCP', desc: 'MCP 服务器与工具', route: '/x/mcp/', provider: 'vssaros-mcp' },
	{ name: '流程', desc: '工作流引擎与画布', route: '/x/workflow/', provider: 'vssaros-workflow' },
	{ name: 'Agent', desc: '.agent.md → dsh preset', route: '/x/agents/', provider: 'vssaros-agents' },
	{ name: '商城', desc: '技能 / 工作台 / 工作流的安装与发布', route: '/x/marketplace/', provider: 'vssaros-marketplace' },
	{ name: '记忆库', desc: '记忆条目与检索', route: '/x/memory/', provider: 'vssaros-memory' },
	{ name: '并行 TUI 工作台', desc: '并排编排多个并行 LLM 会话', route: '/x/parallel/', provider: 'vssaros-parallel' },
];

/** 路径显示：家目录缩成 `~`，否则整行会被截断。 */
function prettyPath(file) {
	const home = homedir();
	return String(file || '').startsWith(home) ? '~' + String(file).slice(home.length) : String(file || '');
}

/** 三个新页签的卡片：名称 + 标签 + 描述 + 脚注 + **真源路径**（合并页的核心诉求）。 */
/**
 * 「这个条目到底改哪个文件」—— 全部按真机约定给，不编路径。
 *
 * 为什么要有它：这页是**只读聚合**，用户看到一条技能/工作流/Agent 后最常问的是"它在哪、我要改它去哪"。
 * 光给个名字等于让他自己去翻文件系统。
 *
 * 口径：技能 `<数据根>/skills/<id>/SKILL.md` · 连接器 `<数据根>/mcp.json` 的一条 ·
 *   工作流 `<数据根>/workflows/<id>/workflow.json` + 同级 `sessions.json` · Agent `<数据根>/agents/<id>/.agent.md` ·
 *   工作台 = 宿主注册模块 ⇒ 给提供方插件与 route（它没有"用户可改的文件"）。
 * 未知/不存在的行**如实标 absent**（虚线 + 说明），不放一个点不动的复制按钮。
 */
/**
 * 图标块 —— **照商城工作台（marketplace 的 `PkgIcon`）那一套**：
 *   · `icon` 是图片地址 ⇒ `<img loading=lazy decoding=async referrerpolicy=no-referrer>`（原生懒加载）
 *   · `icon` 是 emoji / 短文本 ⇒ 直接显示
 *   · 都没有 ⇒ 按**类型**给默认 emoji（技能 ⚡ / 连接器 🔌 / 工作流 🔀 / Agent 🤖 / 工作台 🧰）
 * 底一律是**色相渐变**（色相 = 名称哈希，同一台机器上稳定）—— 纯灰底会让一屏卡片长得一模一样。
 * 图片挂了由 CSS 兜底（`.tk-ico-img` 的底仍在）⇒ 不会出现破图或空白格。
 */
function hueOf(text) {
	const str = String(text || '');
	let hv = 0;
	for (let i = 0; i < str.length; i++) { hv = (hv * 31 + str.charCodeAt(i)) % 360; }
	return hv;
}

function iconBgOf(seed) {
	const h = hueOf(seed);
	return 'linear-gradient(135deg, hsl(' + h + ',68%,58%,.34), hsl(' + ((h + 46) % 360) + ',72%,46%,.16))';
}

const KIND_EMOJI = { skill: '\u26A1', mcp: '\u{1F50C}', workflow: '\u{1F500}', agent: '\u{1F916}', workbench: '\u{1F9F0}', plugin: '\u{1F9E9}' };
const isImageIcon = raw => /^(https?:\/\/|data:image\/)/i.test(String(raw || '').trim());

/** @param {{ icon?: string, kind: string, seed?: string, cls?: string }} o */
function renderIcon(o) {
	const opts = o || {};
	const raw = String(opts.icon || '').trim();
	const cls = opts.cls || 'tk-ico';
	const bg = iconBgOf(opts.seed || raw || opts.kind || '');
	const style = ' style="background:' + bg + '"';
	if (isImageIcon(raw)) {
		return '<span class="' + cls + ' ' + cls + '-img"' + style + ' title="' + escapeHtml(raw) + '">'
			+ '<img src="' + escapeHtml(raw) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer"></span>';
	}
	// emoji 一般 1–2 个 UTF-16 单元（带变体选择符最多 4）；再长就不当图标用了
	const emoji = raw && raw.length <= 4 ? raw : (KIND_EMOJI[opts.kind] || '\u{1F4E6}');
	return '<span class="' + cls + '"' + style + ' aria-hidden="true">' + escapeHtml(emoji) + '</span>';
}

/** 卡片类型 → 商城商品类型（emoji 兜底按它选）。 */
const KIND_OF_TYPE = { flow: 'workflow', agent: 'agent', wb: 'workbench', skill: 'skill', conn: 'mcp', plugin: 'plugin' };
function pathsOf(type, cur, dataRoot) {
	const home = homedir();
	const t = file => {
		const v = String(file || '');
		return v.startsWith(home) ? '~' + v.slice(home.length) : v;
	};
	if (!cur) { return []; }
	if (type === 'skill') {
		return [{
			k: 'SKILL.md',
			v: t(cur.path),
			note: '正文 = 模型 skill 工具拿到的那段（改它立即生效）',
		}];
	}
	if (type === 'conn') {
		return [
			{ k: '配置', v: t(join(dataRoot, 'mcp.json')), note: 'mcpServers["' + String(cur.name || '') + '"] 这一条' },
			{ k: '工具', v: '（连接后由服务端返回）', note: '工具清单不落盘', absent: true },
		];
	}
	if (type === 'flow') {
		const base = join(dataRoot, 'workflows', String(cur.id || ''));
		return [
			{ k: '定义', v: t(join(base, 'workflow.json')), note: 'nodes = 画布上的节点' },
			{ k: '运行记录', v: t(join(base, 'sessions.json')), note: (cur.runs || 0) + ' 次运行' },
			{ k: '产物', v: t(base) + '/sessions/<sessionId>/', note: '每次运行的中间产物' },
		];
	}
	if (type === 'agent') {
		return [{
			k: 'AGENT.md',
			v: t(cur.path),
			note: 'frontmatter 就是这张卡的字段（改完重启生效）',
		}];
	}
	if (type === 'wb') {
		return [
			{ k: '提供方', v: 'dsh-plugins/' + String(cur.provider || '?') + '/lib/index.js', note: '模块由这个插件注册' },
			{ k: '入口', v: String(cur.route || '(未声明)'), note: '点卡片上的链接进这个 route', absent: !cur.route },
		];
	}
	return [];
}

/** 文件 / 目录区块（详情里的一段；没路径就返回空串，不留空标题）。 */
function renderPaths(type, cur, dataRoot) {
	const rows = pathsOf(type, cur, dataRoot);
	if (!rows.length) { return ''; }
	const body = rows.map(r => '<div class="path-row' + (r.absent ? ' absent' : '') + '">'
		+ '<span class="pk">' + escapeHtml(r.k) + '</span>'
		+ '<span class="pv"><code>' + escapeHtml(r.v) + '</code>'
		+ (r.note ? '<span class="pnote">' + escapeHtml(r.note) + '</span>' : '') + '</span>'
		+ (r.absent ? '' : '<button type="button" class="pcopy" data-sk-copy="' + escapeHtml(r.v) + '">复制</button>')
		+ '</div>').join('');
	return '<div class="paths"><h4>文件 / 目录 ' + rows.length + ' 项<span>数据根 ' + escapeHtml(prettyPath(String(dataRoot || ''))) + '</span></h4>' + body + '</div>';
}
/**
 * 卡片（2026-10-23 用户：「工具工作台的 item UI 仿商城中的 item ui 实现」）。
 *
 * 结构照商城工作台的 `.vs-mp-card`：
 *   封面（16:9，有图用图 / 没图用「类型 emoji + 色相渐变」）→ pill 行（状态/来源/规模）
 *   → 标题 → 副行（更新日期 / 模型 / 提供方）→ 两行描述 → 底部「详情」。
 * ⚠ 锚点没变：`data-tk-card` / `data-tk-src` / `data-tk-state`（chips 过滤靠它们）、
 *   `data-tk-open`（展开 `.tk-detail`，里面是「文件 / 目录」）。
 */
/**
 * 筛选条（2026-10-23 用户：「每个页签中，要求增加过滤功能」）。
 * 口径见 doc/tools-filter-mockup.html：主 chips 单选+计数，「更多筛选」多选，计数按全量算。
 * 判据全在卡片 data-f-* 上（服务端写、前端只切 hidden ⇒ 不重渲染、不丢焦点）。
 */
function filterBarHtml(tab, descs, chips, more) {
	const hit = (d, key) => {
		if (key === 'all') { return true; }
		const i = key.indexOf(':');
		if (i < 0) { return true; }
		return String(d[key.slice(0, i)] ?? '') === key.slice(i + 1);
	};
	const chipHtml = (c, isMore) => {
		const n = descs.filter(d => hit(d, c.k)).length;
		if (isMore) {
			return '<label class="tk-more-item' + (n ? '' : ' off') + '"><input type="checkbox" data-tk-filter="' + c.k + '">'
				+ escapeHtml(c.t) + '<b>' + n + '</b></label>';
		}
		return '<button type="button" class="tk-chip" data-tk-filter="' + c.k + '">' + escapeHtml(c.t) + '<b>' + n + '</b></button>';
	};
	return '<div class="tk-fbar" data-tk-chips data-tk-for="' + escapeHtml(tab) + '">'
		+ '<div class="tk-fb-main">' + chips.map(c => chipHtml(c, false)).join('') + '</div>'
		+ '<div class="tk-fb-sub">'
		+ '<span class="tk-fbinfo" data-tk-info>筛选结果 ' + descs.length + ' / ' + descs.length + ' 个</span>'
		+ '<button type="button" class="tk-btn" data-tk-clear>清空筛选</button>'
		+ '<span class="tk-fbgap"></span>'
		+ '<select class="tk-sort" data-tk-sort aria-label="排序"><option value="name">名称</option><option value="src">来源</option></select>'
		+ (more.length
			? '<button type="button" class="tk-btn" data-tk-more aria-expanded="false">更多筛选 \u25BE</button>'
				+ '<div class="tk-more-panel" hidden>' + more.map(c => chipHtml(c, true)).join('') + '</div>'
			: '')
		+ '</div></div>';
}

/** 卡片上的 data-f-* 属性串。 */
function fAttrs(f) {
	if (!f) { return ''; }
	return Object.keys(f).filter(k => f[k] != null && f[k] !== '')
		.map(k => ' data-f-' + k + '="' + escapeHtml(String(f[k])) + '"').join('');
}

/** 技能路径 → 来源（插件包内 = builtin，数据根 = installed）。 */
function skillSrcOf(path) {
	return /[\\/]dsh-plugins[\\/]/.test(String(path || '')) ? 'builtin' : 'installed';
}
/**
 * 这个字符串看起来像"技术 id"吗（kebab / 蛇形、纯小写数字、带分隔符）。
 * 是的话它不该直接当标题显示 —— 需要转成可读名。
 */
function looksLikeSlug(v) {
	const t = String(v || '').trim();
	if (!t) { return true; }
	return /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(t) && /[-_.]/.test(t);
}

/** slug → 可读名：`cpu-usage-analysis` → `Cpu Usage Analysis`（含中文的词原样）。 */
function humanizeSlug(slug) {
	return String(slug || '').split(/[-_.]+/).filter(Boolean)
		.map(w => (/[\u4e00-\u9fa5]/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(' ');
}

/**
 * 统一口径取「可读名」（2026-10-23 用户：「每个技能/mcp/agents/工作流/工作台，都应该有
 * slug 名字和 name(可阅读) 的名字，在 UI 上都应该展示这个可阅读的名字」）。
 *
 * 优先级：显式 displayName → 商城商品名 → 原本就可读的 name → 由 slug 人类化兜底。
 * **永远不把 kebab 串当标题**（那就是 slug，放旁边的 dim 小标签里）。
 */
function readableName({ slug, displayName, name, storeName }) {
	// ① 人显式写的 displayName 最可信
	const d = String(displayName || '').trim();
	if (d) { return d; }
	// ② 从商城装的 ⇒ 用商城商品名（用户是从那个名字点进来的）
	if (storeName) { return String(storeName); }
	// ③ 原本就可读的 name（含中文/空格/大写开头）
	const n = String(name || '').trim();
	if (n && n !== slug && !looksLikeSlug(n)) { return n; }
	// ④ 兜底：slug 人类化（永远不把 kebab 串当标题）
	return humanizeSlug(slug);
}

/**
 * 封面图加载失败时的兜底（2026-10-23 用户：「女娲 skill 图像崩坏」）。
 *
 * 根因是数据：那两张 `icon` 还指向 Cola Skill 的 OSS，对方现在 400/403 ⇒ `<img>` 拉不到，
 * 卡片只剩渐变底 = 一块空白（看着像"崩坏"）。数据已修（改成自持 + 仓库图），
 * 但**前端必须自己有兜底**：以后任何外链失效都不能变成空白块。
 *
 * 做法：有图时同时渲染一个 `hidden` 的类型字形，onerror 里藏流程图、露出字形。
 */
const COVER_ONERROR = "this.style.display='none';var g=this.parentNode?this.parentNode.querySelector('.tk-cover-glyph'):null;if(g){g.hidden=false;}";
/**
 * 已安装条目 → **和技能行同一种行**（.sk-row）。
 *
 * 2026-10-24（用户：「已安装的 agent、工作流、插件、工作台 item ui 样式和技能页中的已安装的技能一样」）：
 * 之前这四类是卡片网格（.tk-card，图片封面 + 220px 高），技能却是紧凑行（两行文字 + 标签）。
 * 同一个页面里两种密度，看起来像两个产品 ⇒ 统一成行。
 *
 * ⚠ 用 `data-item-row` 而**不是** `data-skill-row`：p3-04 / p3-57 按 `[data-skill-row]` 数技能行，
 *   复用那个属性会让探针把别的东西当技能（探针本身就是判据，不能为了省事去动它）。
 */
function renderItemRow({ kind, slug, name, desc, icon, src, f, store, localVer, tags, delKind, delOp, delPkg, delLabel, delTitle, paths,
	// 插件开关（2026-10-24）：toggleOn 是**当前**状态（从 profile 的 bundles 选择读出来的）
	togglePkg, toggleOn, toggleLocked, toggleTitle,
	// ★ 2026-10-26（用户：「点击后的弹出页缺少该项的详细说明」）：
	//   行上只放一行描述（CSS 会截断），**完整说明**与「关键信息」要带给弹层，
	//   否则点开只有一串文件路径（插件尤其明显：描述就是包名）。
	fullDesc, facts }) {
	const storeSlug = store ? String(store.slug || '') : '';
	const storeVer = store ? String(store.version || '') : '';
	// ★ 2026-10-26（用户：已安装的 item 要显示版本号；与商城不一致给「升级」；本地自建给「上传」）：
	//   三个判据都只看**已有数据**（本地版本 / 商城对应件与它的版本 / 是否内置）。
	const lv = String(localVer || '');
	const isBuiltinRow = String(src || 'installed') === 'builtin';
	// 内置（@vssaros/*）不在这里升级：它们走 dshUpgrade 那条通道，走商城 install 会打架
	const canUp = !!storeSlug && !!storeVer && (!lv || lv !== storeVer) && !isBuiltinRow;
	const canPublish = !storeSlug && String(src || 'installed') !== 'builtin';
	const itemAttrs = ' data-item-kind="' + escapeHtml(String(kind || '')) + '" data-item-slug="' + escapeHtml(String(slug || '')) + '"'
		+ (storeSlug ? ' data-item-store="' + escapeHtml(storeSlug) + '" data-item-upver="' + escapeHtml(storeVer) + '"' : '')
		+ ' data-item-lver="' + escapeHtml(String(localVer || '')) + '"'
		+ (delKind ? ' data-item-del="' + escapeHtml(delKind) + '"' : '')
		+ (delKind && delOp ? ' data-item-delop="' + escapeHtml(delOp) + '"' : '')
		+ (delKind && delPkg ? ' data-item-pkg="' + escapeHtml(delPkg) + '"' : '')
		// ★ 2026-10-26：弹层的「说明」与「关键信息」从这里取（行上只显示一行，会被截断）
		+ ' data-item-desc="' + escapeHtml(String(fullDesc || desc || '')) + '"'
		+ (facts && facts.length ? ' data-item-facts="' + escapeHtml(JSON.stringify(facts)) + '"' : '');
	const swBtn = togglePkg
		? '<button type="button" class="sk-sw" role="switch" aria-checked="' + (toggleOn ? 'true' : 'false') + '"'
			+ ' data-sk-sw="' + escapeHtml(String(togglePkg)) + '" data-sk-sw-on="' + (toggleOn ? '1' : '0') + '"'
			+ (toggleLocked ? ' disabled' : '')
			+ ' title="' + escapeHtml(toggleTitle || (toggleOn ? '已启用（点一下停用）' : '已停用（点一下启用）')) + '">'
			+ '<i></i></button>'
		: '';
	const upBtn = canUp
		? '<button type="button" class="sk-act sk-act-up" data-market-install="'
			+ escapeHtml(String(delKind || kind) + ':' + storeSlug) + '" data-market-upgrade title="用商城的 '
			+ escapeHtml(storeVer) + ' 覆盖本地（旧目录先进回收站）">升级</button>'
		: '';
	const pubBtn = canPublish && slug
		? '<button type="button" class="sk-act sk-act-pub" data-publish="'
			+ escapeHtml(String(kind) + ':' + String(slug)) + '" data-publish-external="'
			+ ((kind === 'workbench' || kind === 'plugin') ? '1' : '0') + '"'
			+ ' data-publish-name="' + escapeHtml(String(name)) + '"'
			+ ' data-publish-ver="' + escapeHtml(lv) + '"'
			+ ' title="' + ((kind === 'workbench' || kind === 'plugin')
				? '登记到商城：本体在 npm / GitHub，只登记来源' : '打包上传到商城，别人可以从商城安装') + '">'
			+ ((kind === 'workbench' || kind === 'plugin') ? '登记' : '上传') + '</button>'
		: '';
	const delBtn = delKind && slug
		? '<button type="button" class="sk-act tk-del" data-tk-del="' + escapeHtml(String(slug)) + '"'
			+ ' data-tk-kind="' + escapeHtml(delKind) + '"'
			+ (delOp ? ' data-tk-op="' + escapeHtml(delOp) + '"' : '')
			+ (delPkg ? ' data-tk-pkg="' + escapeHtml(delPkg) + '"' : '')
			+ ' title="' + escapeHtml(delTitle || '移到回收站（.trash-时间戳，可恢复）') + '">'
			+ escapeHtml(delLabel || '删除') + '</button>'
		: '';
	return '<li class="sk-row' + (togglePkg && !toggleOn ? ' is-off' : '') + '" data-item-row' + itemAttrs + ' data-f-src="' + escapeHtml(String(src || 'installed')) + '"'
		+ fAttrs(f) + ' data-slug="' + escapeHtml(String(slug || '')) + '" title="'
		+ escapeHtml(String(name) + ' — ' + String(desc || '') + '（' + String(slug || '') + '）') + '">'
		+ '<i class="sk-bar"></i>'
		+ renderIcon({ icon, kind: KIND_OF_TYPE[({ flow: 'workflow', agent: 'agent', wb: 'workbench', plugin: 'plugin' })[kind] || kind], seed: slug || name, cls: 'sk-ico' })
		+ '<div class="sk-main"><div class="sk-l1"><span class="sk-nm">' + escapeHtml(String(name)) + '</span></div>'
		+ '<div class="sk-ds">' + escapeHtml(String(desc || '')) + '</div>'
		+ '<div class="sk-rowmeta">'
		// 版本号放最前（用户要求：已安装的 item 都要显示版本）
		+ (lv ? '<span class="sk-tag ver">v' + escapeHtml(lv) + '</span>' : '<span class="sk-tag ver">v?</span>')
		+ (canUp ? '<span class="sk-tag up" title="商城已有 ' + escapeHtml(storeVer) + '">可升级 v' + escapeHtml(storeVer) + '</span>' : '')
		+ (tags || []).map(t =>
			'<span class="sk-tag' + (t.acc ? ' acc' : '') + '">' + escapeHtml(String(t.text)) + '</span>').join('') + '</div></div>'
		+ swBtn
		+ upBtn
		+ pubBtn
		+ delBtn
		+ (paths ? '<div class="tk-detail" hidden>' + paths + '</div>' : '')
		+ '</li>';
}

/**
 * 已安装折叠组：<details> 原生折叠（不引 JS 状态机）。
 * 折叠状态会记在 localStorage（下次进来还是收起的），key 按页签区分。
 */
function foldHtml(key, count, innerHtml, emptyHtml) {
	if (!innerHtml) { return emptyHtml || ''; }
	return '<details class="sk-fold" data-sk-fold="' + escapeHtml(key) + '" open>'
		+ '<summary>已安装 <span class="sk-fold-n">' + String(count) + '</span></summary>'
		+ innerHtml
		+ '</details>';
}

function renderToolCard({ name, desc, tags, foot, path, src, state, type, cur, paths, f, slug, delKind, store,
	// ★ 2026-10-24（用户：「插件 item 缺少卸载按钮」）：插件的删除**不是** trash ——
	//   插件装在 profile 的 node_modules 里，只能走 marketplace 的 uninstall（dsh 侧 removeBundle）。
	//   所以按钮要能带 op / 包名 / 文案；默认仍是 删除 + trash，不影响其它类型。
	delSlug, itemSlug, delOp, delPkg, delLabel, delTitle, fullDesc, facts }) {
	const kind = KIND_OF_TYPE[type] || '';
	// ★ 2026-10-23（用户：「每个 item 点击后用独立 UI 展示详情，包含升级、删除等按钮」）：
	//   详情弹层是**统一的**，它靠这几个 data-item-* 自己决定底部给哪些按钮：
	//   data-item-kind/slug（自己的身份）、data-item-store/upver（商城对应件与它的版本）、
	//   data-item-lver（本地版本，用来判断"要不要升级"）、data-item-del（可按 kind 删除）。
	const storeSlug = store ? String(store.slug || '') : '';
	const storeVer = store ? String(store.version || '') : '';
	const localVer = String((cur && (cur.version || (cur.metadata && cur.metadata.version))) || '');
	// 只有"本地已装 + 商城有同名件 + 商城有版本 + 版本不同/未知"才给升级（不做无意义的按钮）
	const canUp = !!delKind && !!storeSlug && !!storeVer && (!localVer || localVer !== storeVer);
	const identitySlug = String(itemSlug || slug || '');
	const itemAttrs = ' data-item-kind="' + escapeHtml(kind) + '" data-item-slug="' + escapeHtml(identitySlug) + '"'
		+ (storeSlug ? ' data-item-store="' + escapeHtml(storeSlug) + '" data-item-upver="' + escapeHtml(storeVer) + '"' : '')
		+ ' data-item-lver="' + escapeHtml(localVer) + '"'
		+ (delKind ? ' data-item-del="' + escapeHtml(delKind) + '"' : '')
		+ (delKind && delOp ? ' data-item-delop="' + escapeHtml(delOp) + '"' : '')
		+ (delKind && delPkg ? ' data-item-pkg="' + escapeHtml(delPkg) + '"' : '')
		// ★ 2026-10-26：弹层的「说明」与「关键信息」
		+ ' data-item-desc="' + escapeHtml(String(fullDesc || desc || '')) + '"'
		+ (facts && facts.length ? ' data-item-facts="' + escapeHtml(JSON.stringify(facts)) + '"' : '');
	const icon = (cur && (cur.icon || (cur.metadata && cur.metadata.icon))) || '';
	// slug 放最前、视觉弱化：两样信息都在（可读名做标题、slug 做标签）
	const pills = (slug ? '<span class="tk-pill dim" title="slug（技术 id）">' + escapeHtml(String(slug)) + '</span>' : '')
		+ (tags || []).slice(0, 3).map(t =>
		'<span class="tk-pill' + (t.acc ? ' acc' : '') + '">' + escapeHtml(t.text) + '</span>').join('');
	const glyph = '<span class="tk-cover-glyph" aria-hidden="true"' + (isImageIcon(icon) ? ' hidden' : '') + '>'
		+ escapeHtml(KIND_EMOJI[kind] || '\u{1F4E6}') + '</span>';
	// 有图就渲染 <img>（同时留一个隐藏的字形，onerror 时露出来）
	const coverInner = isImageIcon(icon)
		? '<img src="' + escapeHtml(icon) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="'
			+ COVER_ONERROR + '">' + glyph
		: glyph;
	return '<li class="tk-card" data-tk-card data-tk-src="' + escapeHtml(src) + '" data-tk-state="' + escapeHtml(state || '')
		+ '"' + fAttrs(f) + itemAttrs + ' title="' + escapeHtml(prettyPath(path)) + '">'
		+ '<div class="tk-cover" style="background:' + iconBgOf(name) + '">' + coverInner + '</div>'
		+ '<div class="tk-body">'
		+ '<div class="tk-pills">' + pills + '</div>'
		+ '<div class="tk-nm">' + escapeHtml(name) + '</div>'
		+ (foot ? '<div class="tk-sub">' + foot + '</div>' : '')
		+ (desc ? '<div class="tk-ds">' + escapeHtml(desc) + '</div>' : '')
		// 升级：直接复用商城的 upgrade（本地装过同名件时才出现）
		+ '<div class="tk-ops">'
		+ (canUp ? '<button type="button" class="tk-btn primary" data-market-install="'
			+ escapeHtml(String(delKind) + ':' + storeSlug) + '" data-market-upgrade title="用商城的 '
			+ escapeHtml(storeVer) + ' 覆盖本地（先移到回收站）">升级</button>' : '')
		+ '<button type="button" class="tk-btn" data-tk-open="1" aria-expanded="false">详情</button>'
		// ★ 2026-10-23（用户：「已安装的工作流 item ui 没有删除按钮」）：
		//   删除走商城插件的新 op `trash`（移到 <数据根>/.trash-<时间戳>/，可恢复），本页不自己写盘。
		+ (delKind && identitySlug
			? '<button type="button" class="tk-btn tk-del" data-tk-del="' + escapeHtml(identitySlug) + '" data-tk-kind="' + escapeHtml(delKind) + '"'
				+ (delOp ? ' data-tk-op="' + escapeHtml(delOp) + '"' : '')
				+ (delPkg ? ' data-tk-pkg="' + escapeHtml(delPkg) + '"' : '')
				+ ' title="' + escapeHtml(delTitle || '移到回收站（.trash-时间戳，可恢复）') + '">'
				+ escapeHtml(delLabel || '删除') + '</button>'
			: '')
		+ '</div>'
		+ '</div>'
		+ (paths ? '<div class="tk-detail" hidden>' + paths + '</div>' : '')
		+ '</li>';
}
/**
 * 连接器行（由 `vssaros-mcp` 渲染的只读片段）补「可读名 + slug」。
 *
 * 为什么不动那个插件：它的归一化结果被 p3-18 与 `src/vs` 那份逐条差分看守，改解析风险大。
 * 这里只对**已渲染 HTML** 里形状固定的那段做定点替换
 * （`<li data-mcp-server-row data-mcp-server="X"><span class="id">X</span>`）。
 * 名字来源：商城同名商品（`knot-mcp-iwiki-3` → 「iWiki」）→ 否则把 serverName 人类化。
 */
/** 本机已装的 MCP 包版本：`<数据根>/mcp/<id>/config.json` 的 `version`（读不到就当空）。 */
function readInstalledMcpVersions(dataRoot) {
	const out = {};
	if (!dataRoot) { return out; }
	try {
		for (const name of readdirSync(join(dataRoot, 'mcp'))) {
			try {
				const cfg = JSON.parse(readFileSync(join(dataRoot, 'mcp', name, 'config.json'), 'utf8'));
				out[name] = String(cfg.version || '');
			} catch { out[name] = ''; }
		}
	} catch { /* 没有 mcp 目录 = 一个都没装 */ }
	return out;
}

function decorateMcpHtml(html, lookup, metaOf) {
	// ⚠ 2026-10-23：服务器行改成了「<li><div class="mcp-l1"><span class="id">…」两层结构，
	//   所以 .id 不再**紧贴** <li> 开头 —— 正则必须容忍中间那层包裹（原来的写法会静默不匹配，
	//   表现就是"可读名没生效、界面上还是 comfy-mcp"）。
	return String(html || '').replace(
		/(<li data-mcp-server-row[^>]*data-mcp-server="([^"]+)"[^>]*>\s*(?:<div class="mcp-l1">)?\s*)<span class="id">([^<]*)<\/span>/g,
		(all, prefix, server, shown) => {
			// ★ 2026-10-26（用户：已安装的 mcp 也要显示版本 / 升级 / 上传）：
			//   行是**另一个插件**渲染的（vssaros-mcp），我们只在它渲染好的 HTML 上做定点补充。
			const info = (metaOf && metaOf(server)) || {};
			const lv = String(info.lv || '');
			const sv = String(info.sv || '');
			const canUp = !!sv && (!lv || lv !== sv);
			let extra = '<span class="sk-tag ver">v' + escapeHtml(lv || '?') + '</span>';
			if (canUp) {
				extra += '<span class="sk-tag up" title="商城已有 ' + escapeHtml(sv) + '">可升级 v' + escapeHtml(sv) + '</span>';
				extra += '<button type="button" class="sk-act sk-act-up" data-market-install="mcp:' + escapeHtml(server)
					+ '" data-market-upgrade title="用商城的 ' + escapeHtml(sv) + ' 覆盖本地安装">升级</button>';
			} else if (!sv) {
				extra += '<button type="button" class="sk-act sk-act-pub" data-publish="mcp:' + escapeHtml(server)
					+ '" data-publish-external="0" data-publish-name="' + escapeHtml(server)
					+ '" data-publish-ver="' + escapeHtml(lv) + '" title="把这个连接器打包上传到商城">上传</button>';
			}
			return prefix + '<span class="id">'
				+ escapeHtml(readableName({ slug: server, name: shown, storeName: lookup(server) })) + '</span>' + extra;
		},
	);
}

function renderPage({ skills, errors, missing, root, nativeSkillTool, provider, skillishTools, mcpSection, workflows, agents, market, mcpInstalled }) {
	// `totals` 是各 kind 的总数（页面用它说「共 N 个，展示前 M 个」）
	const mk = market || { ok: false, items: [], totals: {} };
	// slug → 商城商品（用于"装前装后同一个名字"）
	const mkBySlug = new Map((mk.items || []).map(i => [String(i.slug || ''), i]));
	// 描述清洗统一走模块级 shortStoreDesc（商城卡与本地行共用一份实现，避免漂移）
	// 工作流 / Agent 装完后目录名就是商城 slug ⇒ 直接按 id 关联
	//（连接器没有落盘目录、工作台是插件形态，均不适用）
	const storeOfId = id => mkBySlug.get(String(id || '')) || null;
	// 数据根 = 技能根的上一级（`<数据根>/skills`）⇒ 详情里能给出 mcp.json / workflows / agents 的真实位置
	const dataRoot = root ? dirname(root) : '';
	const P = (type, cur) => renderPaths(type, cur, dataRoot);
	const wf = workflows || { root: '', items: [], errors: [] };
	const ag = agents || { root: '', items: [], errors: [] };
	const summary = summarizeCatalog(skills);
	// 插件页签的三档数据源：内置（随包）/ 已安装（商城装的）/ 可安装（商城还没装）
	const profilePlugins = readProfilePlugins(dataRoot);
	const builtinPlugins = profilePlugins.items.filter(x => x.builtin);
	const installedPlugins = profilePlugins.items.filter(x => !x.builtin);
	// 启用状态：profile 的 bundles 选择（与 setBundleEnabled 同一份真源）
	const enabledBundles = new Set(profilePlugins.bundles || []);
	// 本页/商城接口所在插件：开关锁住（关掉页面就没了），与后端 SELF_PLUGIN_NAME 一致
	const SELF_LOCKED_PLUGINS = ['@vssaros/dsh-skills', '@vssaros/dsh-marketplace'];
	// ★ 2026-10-26（用户：工作台也要显示版本）：工作台 = 某个 dsh 插件（provider 是短名），
	//   所以版本从 profile 里那个插件的 package.json 版本取：vssaros-dashboard ⇒ @vssaros/dsh-dashboard。
	const pluginVersionOfProvider = provider => {
		const short = String(provider || '').replace(/^@vssaros\/dsh-/, '').replace(/^vssaros-/, '');
		if (!short) { return ''; }
		const hit = profilePlugins.items.find(x => {
			const bare = String(x.name || '').replace(/^@[^/]+\//, '').replace(/^dsh-/, '');
			return bare === short;
		});
		return hit && hit.version ? String(hit.version) : '';
	};
	// 包名 → 可读名：@vssaros/dsh-skills ⇒ Skills；archify-dsh ⇒ Archify；
	// dsh-experimental-voice-input-bundle ⇒ Experimental Voice Input Bundle
	// （直接用包名当标题会 35 字符换 3 行，卡片被顶到 284px ✗）
	const pluginTitleOf = name => {
		const short = String(name).split('/').pop().replace(/^dsh-/, '').replace(/-dsh$/, '');
		return short.split('-').filter(Boolean)
			.map(w => w.charAt(0).toUpperCase() + w.slice(1))
			.join(' ') || String(name);
	};

	// 插件卡片：名字用包名末段（@vssaros/dsh-skills ⇒ dsh-skills），完整包名放描述里
	// 插件行首图标：包名 → 商城商品。三档匹配（越往后越松，但都要求**精确**名字，不做模糊）：
	//   ① slug 扁平化：@zyfgood/dsh-whale-girl ⇒ zyfgood-dsh-whale-girl（商城 slug 就是这么生成的）
	//   ② npm 包名：商城 item 的 distribution.name 与包名一致（unscoped 的 dsh-cold-boot 走这条对不上，走 ③）
	//   ③ 仓库名：distribution 是 github-source 时，repo 的末段 == 包名（dsh-cold-boot ⇒ zzbkl/dsh-cold-boot）
	// 三条都落空（本地自己装的 / 内置 @vssaros）⇒ 退回类型字形 🧩，不猜。
	const mkByNpm = new Map();
	const mkByRepoBase = new Map();
	// ⚠ 列表接口回传的 distribution 可能是**字符串**（distribution_meta 原文），不是对象 ⇒ 必须先 parse，
	//   否则 d.type 恒 undefined、三条匹配全落空（这个坑第一次就是这样静默失效的）。
	const parseDist = raw => {
		if (!raw) { return null; }
		if (typeof raw === 'object') { return raw; }
		try { return JSON.parse(String(raw)); } catch { return null; }
	};
	for (const it of (mk.items || [])) {
		const d = it ? parseDist(it.distribution) : null;
		if (d && d.type === 'npm' && d.name) { mkByNpm.set(String(d.name).toLowerCase(), it); }
		if (d && (d.type === 'github-source') && d.name) {
			const base = String(d.name).split('/').pop();
			if (base && !mkByRepoBase.has(base.toLowerCase())) { mkByRepoBase.set(base.toLowerCase(), it); }
		}
	}
	const pluginStoreOf = name => {
		const raw = String(name || '');
		if (!raw) { return null; }
		return mkBySlug.get(raw.replace(/^@/, '').replace(/\//g, '-').toLowerCase())
			|| mkByNpm.get(raw.toLowerCase())
			|| mkByRepoBase.get(raw.split('/').pop().toLowerCase())
			|| null;
	};
	const pluginIconOf = name => {
		const st = pluginStoreOf(name);
		return (st && (st.icon || st.cover)) || '';
	};
	// ★ 2026-10-26（用户：「弹出页缺少该项的详细说明」）：插件的行描述只有包名，
	//   弹层里必须有一段真说明 —— 商城有同款商品就用它的描述，没有才说清它是什么。
	const pluginDescOf = (name, isBuiltin) => {
		const st = pluginStoreOf(name);
		const d = st && st.description ? shortStoreDesc(String(st.description)) : '';
		if (d) { return d; }
		return isBuiltin
			? '随产品发布的内置插件（@vssaros / @deepseek-ai 范围），不需要安装，随 Host 启动加载；在这里可以临时停用。'
			: '从商城安装的第三方 dsh 插件：运行在 Host 进程里，装/卸/启停都在本页完成。';
	};

	// 插件详情块（行与弹层共用；卡片已改成行，这里只剩这一份）
	const pluginPathsHtml = (it, isBuiltin) => '<div class="paths"><h4>插件信息</h4>'
		+ '<div class="path-row"><span class="pk">包名</span><span class="pv"><code>' + escapeHtml(it.name) + '</code></span></div>'
		+ '<div class="path-row"><span class="pk">版本</span><span class="pv"><code>' + escapeHtml(it.version || '未声明') + '</code></span></div>'
		+ '<div class="path-row"><span class="pk">清单</span><span class="pv"><code>' + escapeHtml(prettyPath(profilePlugins.file)) + '</code></span></div>'
		+ '<p class="sk-note">' + (isBuiltin
			? '随产品发布，不用安装、也不该卸载。'
			: '已从商城安装 ⇒ 点「卸载」会从 dsh profile 的依赖里移除（dsh 侧执行，不用开 IDE）。') + '</p>'
		+ '</div>';

	const rows = skills.map(s => {
		const id = skillIdOf(s.path);
		// ★ 2026-10-23（用户：装前装后名字/描述对不上）：
		//   商城卡片显示我们整理的 name/description；安装后本地读的是 SKILL.md 里仓库自带的
		//   name/description（多为英文）⇒ 同一个技能两个名字。有 storeId 且商城有该 slug 时
		//   **以商城身份为准**（用户是从那里点进来的），技术 id 仍留在抽屉里可查。
		const store = s.metadata?.storeId ? mkBySlug.get(String(s.metadata.storeId)) : null;
		// 标题必须是**可读名**（slug 放旁边的小标签里，两样都在）
		const shownName = readableName({ slug: id, displayName: s.metadata?.displayName, name: s.name, storeName: store && store.name });
		const shownDesc = store ? (shortStoreDesc(store.description).slice(0, 140) || s.description) : s.description;
		const extra = [store ? '商城' : null, s.metadata?.category, s.metadata?.version].filter(Boolean).join(' · ');
		// `data-skill-row` / `data-skill-id` 是**脚本与探针共同的抓手** ⇒ 不许改名，也不许把别的属性插到
		// `data-skill-row ` 前面（p3-04 数的是 /<li data-skill-row / 这个字面前缀 ✓）。
		// 统一详情弹层的元信息（与卡片口径一致）：技能也能在详情里升级/删除
		const skLocalVer = String((s.metadata && s.metadata.version) || '');
		// ★ 2026-10-26（用户：已安装都要显示版本；与商城不一致给升级；本地自建给上传）
		const skStoreVer = String((store && store.version) || '');
		const skBuiltin = String(skillSrcOf(s.path)) === 'builtin';
		const skCanUp = !!store && !!skStoreVer && (!skLocalVer || skLocalVer !== skStoreVer) && !skBuiltin;
		const skCanPub = !store && !skBuiltin;
		const skItemAttrs = ' data-item-kind="skill" data-item-slug="' + escapeHtml(id) + '"'
			+ (store ? ' data-item-store="' + escapeHtml(String(store.slug)) + '" data-item-upver="' + escapeHtml(String(store.version || '')) + '"' : '')
			+ ' data-item-lver="' + escapeHtml(skLocalVer) + '" data-item-del="skill"'
			// 弹层里的「说明」用完整描述（行上的 .sk-ds 只有一行）
			+ ' data-item-desc="' + escapeHtml(shownDesc || '') + '"'
			+ ' data-item-facts="' + escapeHtml(JSON.stringify([
				['类型', '技能（skill）'],
				['技能 id', id],
				['激活方式', activationWord(s.activation)],
				['来源', String(skillSrcOf(s.path)) === 'builtin' ? '随产品发布（内置）' : '本地 / 商城安装'],
				...(s.metadata && s.metadata.version ? [['本地版本', String(s.metadata.version)]] : []),
				...(store ? [['商城商品', String(store.slug)], ['商城版本', String(store.version || '未声明')]] : []),
			])) + '"';

		return `<li data-skill-row data-skill-id="${escapeHtml(id)}" data-act="${escapeHtml(s.activation)}" data-f-src="${skillSrcOf(s.path)}" data-f-act="${escapeHtml(s.activation)}" class="sk-row" data-slug="${escapeHtml(id)}"${skItemAttrs} title="${escapeHtml(shownName)} — ${escapeHtml(shownDesc)}（${escapeHtml(id)}）">`
			+ '<i class="sk-bar"></i>'
			+ renderIcon({ icon: s.metadata && s.metadata.icon, kind: 'skill', seed: store ? String(store.slug) : s.name, cls: 'sk-ico' })
			// 2026-10-23（用户：「已安装的技能 item 名字显示不全」）：
			//   原来 标题 + 激活标签 + slug + 版本 全挤在 .sk-l1 一行 ⇒ 窄卡（268px）里标题被
			//   flex 挤到只剩一两个字，而 .sk-nm 没有 min-width:0 ⇒ ellipsis 不生效，
			//   被 .sk-row 的 overflow:hidden 从中间切断（看着像"字叠在一起"）。
			//   现在分层：① 标题 ② 描述 ③ 标签（标签可换行，不再抢标题的宽度）。
			+ `<div class="sk-main"><div class="sk-l1"><span class="sk-nm">${escapeHtml(shownName)}</span></div>`
			+ `<div class="sk-ds">${escapeHtml(shownDesc)}</div>`
			// slug 太长的（cola-orange-line-illustration）在 268px 卡里会一个字一行 ⇒ 放 tooltip 里，
			// 界面上只留可读名（用户的要求就是"UI 展示可读名"），技术 id 仍可在详情抽屉里看到。
			// 版本号打头（此前它混在 extra 里，和分类挤成一段文字，看不出版本是多少）
			+ `<div class="sk-rowmeta"><span class="sk-tag ver">v${escapeHtml(skLocalVer || '?')}</span>`
			+ (skCanUp ? `<span class="sk-tag up" title="商城已有 ${escapeHtml(skStoreVer)}">可升级 v${escapeHtml(skStoreVer)}</span>` : '')
			+ `${activationTag(s.activation)}${extra ? `<span class="sk-tag ver">${escapeHtml(extra)}</span>` : ''}<span class="sk-slug" hidden>${escapeHtml(id)}</span></div></div>`
			// 设置齿轮（2026-10-15，桥 `9 → 10`）：点了请宿主打开**资源管理详情页**（改 SKILL.md / 启停 / 卸载）。
			// ⚠ 它是 .sk-row 内部的按钮 ⇒ 点击必须 `stopPropagation`（否则会同时把抽屉展开 ✓）。
			// 触发逻辑在页尾那段**委派**处理器里（`[data-sk-settings]`）—— MCP 段（另一插件渲染的行）也带同样的
			// 属性 ⇒ 一处处理两类 ✓（那边没有自己的页内 JS，只能由本页代劳 ✓）。
			// 升级 / 上传（与其它行同一套属性，复用页尾那两个委派处理器）
			+ (skCanUp
				? `<button type="button" class="sk-act sk-act-up" data-market-install="skill:${escapeHtml(String(store.slug))}" data-market-upgrade title="用商城的 ${escapeHtml(skStoreVer)} 覆盖本地（旧目录先进回收站）">升级</button>`
				: '')
			+ (skCanPub
				? `<button type="button" class="sk-act sk-act-pub" data-publish="skill:${escapeHtml(id)}" data-publish-external="0" data-publish-name="${escapeHtml(shownName)}" data-publish-ver="${escapeHtml(skLocalVer)}" title="打包上传到商城">上传</button>`
				: '')
			+ `<button type="button" class="sk-gear" data-sk-settings data-sk-kind="skill" data-sk-id="${escapeHtml(id)}" title="设置（在编辑区修改这个技能）">\u2699</button>`
			+ '<span class="sk-arrow">\u203A</span></li>'
			+ `<li class="sk-drawer" data-skill-detail hidden><dl><dt>激活</dt><dd>${activationWord(s.activation)}</dd>`
			+ `<dt>技能 id</dt><dd><code>${escapeHtml(id)}</code></dd>`
			// ★ 2026-10-23：装前装后的名字对不上时，用户至少要能看到"这个本地技能是商城的哪一件"
			+ (store ? `<dt>商城商品</dt><dd><code>${escapeHtml(String(store.slug))}</code> · ${escapeHtml(shownName)}</dd>` : '')
			+ `</dl>${P('skill', { path: s.path, name: s.name })}`
			+ '<pre class="sk-pre" data-sk-body>展开时按 id 取正文（与模型 skill 工具拿到的是同一段）。</pre></li>';
	}).join('');
	// ★ 2026-10-23（用户：创建资源必须配 displayName）：老数据没有的一律**照常显示**（否则页面突然空掉），
	//   但明确告诉用户有几条不合规、怎么补 —— 不静默。
	const noDisplayName = skills.filter(s => !(s.metadata && s.metadata.displayName)).length;
	const dnNote = noDisplayName
		? `<p class="sk-note sk-warn">${noDisplayName} 个技能还没有 <code>displayName</code> —— 界面会退化显示 kebab 名。`
			+ `在 SKILL.md 的 frontmatter 加一行 <code>displayName: 中文名</code> 即可（新建的技能必须填）。</p>`
		: '';
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
	/* 页头（2026-10-23 对齐 mockup）：一行 = 标题 + 计数 + 搜索 + 按钮；不再有 3 个大数字块与商城横幅。 */
.sk-header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; height: auto; min-height: 44px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.sk-count { font-size: 12px; color: var(--vscode-descriptionForeground, #999); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 搜索：胶囊，占可用宽度的上限，窄了自动缩 */
.sk-search-h { display: flex; align-items: center; gap: 6px; min-width: 0; max-width: 320px; flex: 0 1 320px; background: var(--vscode-input-background, rgba(128,128,128,.12)); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.35)); border-radius: 14px; padding: 3px 10px; }
.sk-search-h input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: inherit; font: inherit; font-size: 12px; }
.sk-search-h span { flex: 0 0 auto; font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
	.sk-title { font-size: 15px; font-weight: 600; letter-spacing: 0; }
	.sk-spacer { flex: 1; }
	.sk-hbtn { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 8px; font: inherit; font-size: 12.5px; line-height: 1; color: inherit; background: none; border: 1px solid transparent; border-radius: 6px; cursor: pointer; white-space: nowrap; }
	.sk-hbtn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.sk-hbtn-link { text-decoration: none; color: inherit; }
.sk-hbtn-link:hover { text-decoration: none; }
	.sk-panel { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
	/* 商品/页面栏与页头重复（mockup 没有）⇒ 收起，只留数据标记 */
.sk-panel-bar[hidden], .sk-panel-bar { display: none; }
.sk-panel-bar-x { display: flex; align-items: center; gap: 4px; padding: 0 10px; height: 30px; flex-shrink: 0; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); font-size: 11px; font-weight: 600; letter-spacing: .5px; text-transform: uppercase; opacity: .8; }
	.sk-note { font-weight: 400; text-transform: none; letter-spacing: 0; }
	.sk-panel-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 2px 0 12px; }
	/* ── 仪表盘统计卡（「数字优先」的那三格；零值灰显，照 kbView.css 的 statCell 口径）── */
	/* 三个大数字块已删（信息并入页头计数）。 */
/* 商城横幅已收成页头按钮；页签改成下划线式（与 mockup 一致）。 */
.sk-seg { display: flex; align-items: center; gap: 22px; margin: 0 12px; border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); }
.sk-seg button { position: relative; font: inherit; font-size: 13px; padding: 8px 0 9px; background: none; border: 0; cursor: pointer; color: var(--vscode-descriptionForeground, #999); }
.sk-seg button:hover { color: inherit; }
.sk-seg button.on { color: inherit; font-weight: 600; }
.sk-seg button.on::after { content: ''; position: absolute; left: 0; right: 0; bottom: -1px; height: 2px; background: var(--vscode-focusBorder, #4C9AFF); border-radius: 2px; }
/* （面板内搜索框已搬进页头） */
	/* ── 技能行：卡片质感（仪表盘骨架下的「一卡一条」；色条仍在最左表激活方式）──
	   ⚠ .sk-nm / .sk-ds 这两条的声明**必须**与 MCP 侧的 .sk-pane-mcp li .id / li small 逐字相等
	   （p3-04 有一条断言逐项比对字号/字体/截断 —— 改一边就要改另一边 ✗）。
	   ⚠⚠ 注释里**不许出现反引号**：本段整体是 JS 模板字符串，一个反引号就会提前闭合它
	   （这一刀我正好踩了：写了四个反引号 ⇒ node --check 报 Unexpected identifier ✗）。 */
	/* 技能列表 = 卡片网格（2026-10-23 对齐 mockup：之前是单列列表，和另外三个页签的卡片不是一套语言）。
   ⚠ .sk-row 的边框/圆角/背景没动 —— p3-04 拿它和 MCP 行对账；这里只换容器布局。 */
.sk-list { list-style: none; margin: 0; padding: 0 10px; display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 8px; align-items: start; }
/* 行内抽屉跨整行（它是每个技能行的兄弟节点） */
.sk-drawer { grid-column: 1 / -1; }
	.sk-row { display: flex; gap: 8px; align-items: flex-start; padding: 7px 10px 7px 0; border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.05)); cursor: pointer; overflow: hidden; }
	.sk-row:hover, .sk-row.open { border-color: var(--vscode-focusBorder, #007acc); }
	/* 设置齿轮（2026-10-15）：平时半隐（行内不抢戏），行 hover / 键盘聚焦时显出来；点击不触发行的抽屉 ✓ */
	.sk-gear { flex: 0 0 auto; width: 22px; height: 22px; margin-left: 2px; display: flex; align-items: center; justify-content: center; font: inherit; font-size: 13px; line-height: 1; color: var(--vscode-descriptionForeground, #999); background: none; border: 0; border-radius: 4px; cursor: pointer; opacity: 0; transition: opacity .12s ease; }
	.sk-row:hover .sk-gear, .sk-row:focus-within .sk-gear, .sk-gear:focus { opacity: 1; }
	.sk-gear:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); color: var(--vscode-foreground, #ccc); }
	.sk-gear.busy { opacity: 1; }
	.sk-bar { flex: 0 0 3px; align-self: stretch; background: var(--vscode-panel-border, rgba(128,128,128,.45)); }
	.sk-row[data-act="auto"] .sk-bar { background: var(--vscode-charts-green, #3fb950); }
	.sk-row[data-act="always"] .sk-bar { background: var(--vscode-charts-purple, #b180d7); }
	.sk-ico { display: flex; align-items: center; justify-content: center; width: 28px; height: 28px; flex: 0 0 28px; margin-top: 1px; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); font-size: 14px; line-height: 1; user-select: none; }
.sk-ico img { width: 100%; height: 100%; object-fit: cover; display: block; }
.sk-ico-img { padding: 0; }
.sk-main { flex: 1; min-width: 0; }
/* 标签单独一行（激活 / 版本）：可换行、不抢标题宽度。
   ⚠ 类名不能叫 .sk-meta —— 那是页面底部状态条（带 border-top），复用会在标签上方多一条横线。 */
.sk-rowmeta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; margin-top: 3px; }
	.sk-l1 { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
	/* min-width:0 是让 ellipsis 真的生效的关键（flex 子项默认 min-width:auto = 不收缩）。
   p3-04 只对账 font-weight/family/size/overflow/text-overflow/white-space 六项 ⇒ 加这条不违约 ✓ */
.sk-nm { font-weight: 600; font-family: ui-monospace, Consolas, monospace; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
	.sk-l1 .sp { margin-left: auto; flex: 0 0 auto; }
	.sk-ds { color: var(--vscode-descriptionForeground, #999); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.sk-arrow { flex: 0 0 auto; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
	/* 抽屉与上面的行**贴合成一张卡**：负 margin 吃掉 gap，顶边不描（用行的下边）✓ */
	.sk-drawer { margin: 0 !important; padding: 8px 10px; padding: 8px 10px 9px 21px; font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); border-top: 0; border-radius: 0 0 6px 6px; background: rgba(128,128,128,.06); }
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

/* ── 「工具」页新增三个页签（工作流 / Agent / 工作台）──────────────────────
   卡片网格 + 来源 chips；每张卡底部给**真源路径** —— 合并页的核心诉求就是"改哪个文件一眼可见"。 */
.tk-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 12px; }
.tk-chips button {
	font: inherit; font-size: 12px; line-height: 20px; padding: 2px 11px; border-radius: 12px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
	background: transparent; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer;
}
.tk-chips button.on {
	background: var(--dsw-alias-brand-primary, #4C9AFF); border-color: var(--dsw-alias-brand-primary, #4C9AFF);
	color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 600;
}
.tk-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.tk-card {
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35)); border-radius: 8px;
	padding: 9px 11px; min-width: 0;
}
.tk-l1 { display: flex; align-items: center; gap: 9px; min-width: 0; }
/* 图标块（2026-10-23 用户：「item 缺少图标，参考商城工作台中的 item ui」）：
   照 marketplace 的 .vs-mp-icon —— 圆角方格 + 色相渐变底（由名称哈希决定）+ 图片按格裁剪。
   ⚠ 不再用「名称首字」：一屏全是同形灰块，等于没有图像信息（商城那侧也踩过：icon 全是同一个 emoji）。 */
.tk-ico { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; flex: 0 0 32px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,.08); font-size: 15px; line-height: 1; user-select: none; }
.tk-ico img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tk-ico-img { padding: 0; }
.tk-nm { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-tags { display: flex; gap: 4px; margin-left: auto; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.tk-tag { font-size: 11px; line-height: 16px; padding: 0 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); color: var(--dsw-alias-label-secondary, inherit); }
.tk-tag.acc { color: var(--dsw-alias-brand-primary, #4C9AFF); border-color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-tag.dim { border-color: transparent; opacity: .8; }
.tk-ds { margin-top: 5px; font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tk-ft { margin-top: 6px; font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); display: flex; gap: 8px; flex-wrap: wrap; }
.tk-path { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.3)); }
.tk-path code { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sk-note { margin: 8px 0 0; font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); }
.tk-card[hidden] { display: none; }

/* 商城卡片（2026-10-23 用户：「item 样式与商城工作台保持一致，且可直接安装」）。
   观感对齐商城的 .vs-mp-card：标题 → 描述两行 → 作者/标识 → 动作按钮贴底。 */
.tk-market-card { border-style: dashed; }
.tk-market-card .tk-actions { margin-top: 8px; display: flex; gap: 8px; }
.tk-install {
	font: inherit; font-size: 12px; line-height: 20px; padding: 2px 12px; border-radius: 12px;
	border: 1px solid var(--dsw-alias-brand-primary, #4C9AFF);
	background: transparent; color: var(--dsw-alias-brand-primary, #4C9AFF); cursor: pointer;
}
.tk-install:hover { background: var(--dsw-alias-brand-primary, #4C9AFF); color: var(--dsw-alias-label-primary-inverted, #fff); }
.tk-install[disabled] { opacity: .6; cursor: default; }
.tk-market-hd { margin: 14px 0 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, inherit); }
.tk-market-hd span { opacity: .7; margin-left: 6px; }
.tk-market { margin-top: 0 !important; }

/* 文件 / 目录（2026-10-23 用户：「每个 item 的详情 UI 中，要求显示文件目录等信息」）。
   每行 = 标签 + 等宽路径（超长省略、title 全文）+ 复制；absent 行用虚线且不给复制按钮。 */
.paths { margin: 10px 0 4px; }
.paths h4 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, inherit); }
.paths h4 span { margin-left: 8px; font-weight: 400; opacity: .7; }
.path-row {
	display: grid; grid-template-columns: 74px minmax(0, 1fr) auto; gap: 10px; align-items: center;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32)); border-radius: 7px;
	padding: 5px 9px; margin-bottom: 6px;
}
.path-row.absent { border-style: dashed; }
.path-row .pk { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
.path-row .pv { min-width: 0; }
.path-row .pv code {
	display: block; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	color: var(--dsw-alias-label-primary, inherit);
}
.path-row .pnote { display: block; font-size: 11px; opacity: .7; margin-top: 1px; }
.path-row.absent .pv code { opacity: .7; }
.pcopy {
	font: inherit; font-size: 11px; line-height: 18px; padding: 0 8px; border-radius: 9px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
	background: transparent; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer; flex: none;
}
.pcopy:hover { border-color: var(--dsw-alias-brand-primary, #4C9AFF); color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-more {
	font: inherit; font-size: 11px; line-height: 18px; padding: 0 8px; margin-top: 6px; border-radius: 9px;
	border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.45)); background: transparent;
	color: var(--dsw-alias-label-tertiary, inherit); cursor: pointer;
}
.tk-more:hover { color: var(--dsw-alias-brand-primary, #4C9AFF); border-color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-detail { margin-top: 2px; }
.tk-card.open .tk-more { display: none; }

/* 商城式 item 卡片（v2，2026-10-23 用户：「工具工作台的 item UI 仿商城中的 item ui 实现」）。
   骨架照商城工作台的 .vs-mp-card：封面 16:9（有图用图 / 没图用类型 emoji + 色相渐变）
   → pill 行 → 标题 → 副行 → 两行描述 → 底部按钮。
   ⚠ 这一段**显式覆盖**上面旧的 .tk-card/.tk-l1/.tk-path 规则（那些是"行内小图标 + 路径常在"的旧形态）。 */
.tk-grid { grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)) !important; gap: 14px !important; }
.tk-card {
	display: flex; flex-direction: column; padding: 0; border-radius: 10px; overflow: hidden;
	background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06));
}
.tk-card:hover { border-color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-cover {
	display: flex; align-items: center; justify-content: center; overflow: hidden;
	aspect-ratio: 16 / 9; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.25));
}
.tk-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.tk-cover-glyph { font-size: 34px; line-height: 1; }
.tk-body { display: flex; flex-direction: column; gap: 3px; padding: 9px 11px 11px; flex: 1; min-width: 0; }
.tk-pills { display: flex; gap: 4px; flex-wrap: wrap; }
.tk-pill {
	font-size: 10.5px; line-height: 16px; padding: 0 6px; border-radius: 4px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45));
	color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap;
}
.tk-pill.acc { color: var(--dsw-alias-brand-primary, #4C9AFF); border-color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-nm { font-size: 14px; font-weight: 600; line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, inherit); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-ds {
	font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); min-height: 31px;
	display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.tk-ops { margin-top: auto; padding-top: 7px; display: flex; gap: 6px; }
.tk-btn {
	font: inherit; font-size: 12px; line-height: 22px; padding: 0 12px; border-radius: 5px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.5));
	background: transparent; color: inherit; cursor: pointer;
}
.tk-btn:hover { border-color: var(--dsw-alias-brand-primary, #4C9AFF); color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-btn.primary {
	background: var(--dsw-alias-brand-primary, #4C9AFF); border-color: var(--dsw-alias-brand-primary, #4C9AFF);
	color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 600;
}
.tk-market-card .tk-ds { min-height: 31px; }

/* 安装失败的红字（卡片内、按钮下方）：失败原因必须看得见，不能只塞进 title。 */
.tk-err {
	margin-top: 6px; font-size: 11.5px; line-height: 1.45;
	color: var(--dsw-alias-label-error, #F14C4C);
	word-break: break-word;
	border-left: 2px solid var(--dsw-alias-label-error, #F14C4C);
	padding-left: 6px;
}

/* 商城商品的完整介绍（从 colaskill 抓下来存进 packages.detail_md）。
   上游已把 class/style 洗掉 ⇒ 这里用标签选择器统一接管排版。 */
/* 正文最长 169KB（cola-wondelai-skills）⇒ 限高 + 内部滚动，别把卡片撑成好几屏 */
.mk-detail { margin: 8px 0 10px; font-size: 12.5px; line-height: 1.65; max-height: 420px; overflow: auto; padding-right: 4px; }
.mk-detail h1, .mk-detail h2, .mk-detail h3, .mk-detail h4 {
	margin: 12px 0 6px; font-size: 13px; font-weight: 600; line-height: 1.4;
	color: var(--dsw-alias-label-primary, inherit);
}
.mk-detail p { margin: 6px 0; }
.mk-detail ul, .mk-detail ol { margin: 6px 0 6px 18px; padding: 0; }
.mk-detail li { margin: 2px 0; }
.mk-detail code {
	font-family: ui-monospace, Consolas, monospace; font-size: 12px;
	background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.16)); border-radius: 3px; padding: 0 4px;
}
.mk-detail pre { margin: 8px 0; padding: 8px 10px; overflow: auto; border-radius: 6px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12)); }
.mk-detail pre code { background: transparent; padding: 0; }
.mk-detail img { max-width: 100%; height: auto; border-radius: 6px; margin: 8px 0; display: block; }
.mk-detail a { color: var(--dsw-alias-brand-primary, #4C9AFF); }
/* ── 「上传/登记到商城」表单（2026-10-26）── */
.mk-pub { margin: 0 0 14px; padding: 12px; border-radius: 6px; border: 1px solid var(--vscode-focusBorder, #007acc); background: var(--vscode-editorWidget-background, rgba(0,122,204,.06)); }
.mk-pub h4 { margin: 0 0 10px; font-size: 12.5px; font-weight: 600; }
.mk-pub-row { display: grid; grid-template-columns: 72px minmax(0, 1fr); align-items: center; gap: 8px; margin-bottom: 8px; }
.mk-pub-row label { font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); }
.mk-pub-row input, .mk-pub-row textarea { width: 100%; box-sizing: border-box; font: inherit; font-size: 12px; padding: 4px 6px; border-radius: 4px; color: var(--vscode-input-foreground, #ddd); background: var(--vscode-input-background, rgba(128,128,128,.12)); border: 1px solid var(--vscode-input-border, rgba(128,128,128,.4)); }
.mk-pub-row textarea { resize: vertical; min-height: 40px; }
.mk-pub-note { margin: 0 0 10px; font-size: 11.5px; line-height: 1.5; color: var(--vscode-descriptionForeground, #999); }
.mk-pub-ops { display: flex; gap: 8px; }
/* ── 发布前体检结果（2026-10-26）── */
/* 重复发布源提醒（2026-10-26）*/
.mk-pub-warn { margin: 6px 0 0; font-size: 11.5px; line-height: 1.5;
	color: var(--vscode-charts-yellow, #d29922); }
.mk-pre { margin: 10px 0 0; }
.mk-pre-head { font-size: 12px; font-weight: 600; margin-bottom: 6px; }
.mk-pre-head.mk-pre-pass { color: var(--vscode-charts-green, #3fb950); }
.mk-pre-head.mk-pre-warn { color: var(--vscode-charts-yellow, #d29922); }
.mk-pre-head.mk-pre-error { color: var(--vscode-errorForeground, #f48771); }
.mk-pre-list { margin: 0 0 8px; padding-left: 16px; }
.mk-pre-item { font-size: 11.5px; line-height: 1.55; margin-bottom: 3px; }
.mk-pre-item b { font-weight: 600; }
.mk-pre-item span { display: block; opacity: .85; margin-top: 1px; }
.mk-pre-item.mk-pre-pass { color: var(--vscode-charts-green, #3fb950); }
.mk-pre-item.mk-pre-warn { color: var(--vscode-charts-yellow, #d29922); }
.mk-pre-item.mk-pre-error { color: var(--vscode-errorForeground, #f48771); }
.mk-pub-err { margin: 8px 0 0; font-size: 11.5px; color: var(--vscode-errorForeground, #f48771); min-height: 14px; }
.mk-detail blockquote { margin: 8px 0; padding-left: 10px; border-left: 2px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4)); }
.mk-detail table { border-collapse: collapse; width: 100%; margin: 8px 0; }
.mk-detail th, .mk-detail td { border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); padding: 4px 8px; text-align: left; }
.mk-loading { margin: 8px 0; font-size: 12px; opacity: .75; }

/* 商城商品详情弹层（仿 colaskill 商品页）：大封面 → 标签 → 标题 → 副行 → 正文 → 底部动作。
   为什么做成弹层而不是页内展开：colaskill 那页的信息量（分节正文 + 图片）在卡片里塞不下。 */
.mk-dlg { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; }
.mk-dlg[hidden] { display: none; }
.mk-dlg-mask { position: absolute; inset: 0; background: rgba(0,0,0,.5); }
.mk-dlg-box {
	position: relative; width: min(860px, 92vw); max-height: 88vh; display: flex; flex-direction: column;
	background: var(--dsw-alias-bg-layer-1, #1f1f1f); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
	border-radius: 12px; overflow: hidden; box-shadow: 0 18px 48px rgba(0,0,0,.45);
}
.mk-dlg-x {
	position: absolute; top: 10px; right: 10px; z-index: 2; width: 26px; height: 26px; border-radius: 13px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45)); background: rgba(0,0,0,.35);
	color: inherit; font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
}
.mk-dlg-x:hover { border-color: var(--dsw-alias-brand-primary, #4C9AFF); color: var(--dsw-alias-brand-primary, #4C9AFF); }
.mk-dlg-cover { flex: none; aspect-ratio: 16 / 6.2; max-height: 240px; overflow: hidden; display: flex; align-items: center; justify-content: center; }
.mk-dlg-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mk-dlg-cover .tk-cover-glyph { font-size: 56px; }
.mk-dlg-head { padding: 14px 20px 10px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22)); }
.mk-dlg-pills { display: flex; gap: 5px; flex-wrap: wrap; margin-bottom: 8px; }
.mk-dlg-title { margin: 0 0 6px; font-size: 19px; font-weight: 600; line-height: 1.35; }
.mk-dlg-sub { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
.mk-dlg-body { padding: 4px 20px 12px; overflow: auto; flex: 1; }
.mk-dlg-body .mk-detail { max-height: none; overflow: visible; font-size: 13px; line-height: 1.7; }
.mk-dlg-foot {
	flex: none; display: flex; align-items: center; gap: 8px; padding: 10px 20px;
	border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.22));
	background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06));
}
.mk-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
.tk-only-browse {
	font-size: 11px; line-height: 22px; padding: 0 10px; border-radius: 11px;
	border: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.45));
	color: var(--dsw-alias-label-tertiary, inherit);
}

/* 筛选条（2026-10-23「每个页签都要能过滤」）：主 chips 单选 + 更多筛选多选 + 排序 + 清空。
   口径照 doc/tools-filter-mockup.html；计数由服务端算好写进 <b>，前端只切 hidden。 */
.tk-fbar {
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.32)); border-radius: 10px;
	background: var(--dsw-alias-bg-layer-1, rgba(127,127,127,.06)); padding: 8px 10px; margin: 0 0 10px;
}
.tk-fb-main { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.tk-fb-sub {
	display: flex; gap: 6px; align-items: center; flex-wrap: wrap; position: relative;
	margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,.28));
}
.tk-chip {
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45)); border-radius: 14px;
	background: transparent; color: var(--dsw-alias-label-secondary, inherit); cursor: pointer;
	font: inherit; font-size: 12px; line-height: 20px; padding: 0 10px;
}
.tk-chip b { margin-left: 5px; font-weight: 400; opacity: .7; }
.tk-chip:hover { border-color: var(--dsw-alias-brand-primary, #4C9AFF); color: var(--dsw-alias-label-primary, inherit); }
.tk-chip.on {
	background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4C9AFF) 18%, transparent);
	border-color: var(--dsw-alias-brand-primary, #4C9AFF); font-weight: 600;
	color: var(--dsw-alias-label-primary, inherit);
}
.tk-chip.on b { opacity: .85; }
.tk-fbinfo { font-size: 12px; color: var(--dsw-alias-label-tertiary, inherit); }
.tk-fbgap { flex: 1 1 auto; }
.tk-sort {
	font: inherit; font-size: 12px; height: 22px; padding: 0 4px; border-radius: 6px;
	border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.45));
	background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.10)); color: inherit;
}
.tk-more-panel {
	position: absolute; right: 0; top: 32px; z-index: 30; width: 240px; padding: 8px 10px;
	background: var(--dsw-alias-bg-layer-1, #232326); border: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.4));
	border-radius: 9px; box-shadow: 0 12px 28px rgba(0,0,0,.35);
}
.tk-more-item { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 0; cursor: pointer; }
.tk-more-item input { accent-color: var(--dsw-alias-brand-primary, #4C9AFF); }
.tk-more-item b { margin-left: auto; font-weight: 400; opacity: .65; }
.tk-more-item.off { opacity: .5; }
/* 连接器行的 slug（可读名在 .id 里，slug 弱化在右边）。 */
.sk-note.sk-warn {
	border-left: 2px solid var(--dsw-alias-label-warning, #E3A008);
	padding-left: 8px; opacity: 1;
}
/* 服务器卡片的第一行（名字 + 传输/工具数 + 齿轮横排）。 */
.sk-pane-mcp li .mcp-l1 { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.sk-pane-mcp li .mcp-l1 .id { flex: 0 1 auto; min-width: 0; }
.sk-pane-mcp li .mcp-l1 small { flex: 0 0 auto; }
.sk-pane-mcp li .slug {
	margin-left: 6px; font-size: 11px; opacity: .5;
	font-family: ui-monospace, Consolas, monospace;
}

/* slug 小标签（2026-10-23）：可读名做主标题，slug 以弱化的等宽小标签同屏展示。 */
.tk-pill.dim, .sk-tag.slug {
	max-width: 100%; overflow: hidden; text-overflow: ellipsis;
	font-family: ui-monospace, Consolas, monospace;
	opacity: .5; border-style: dashed;
	letter-spacing: -.2px;
	/* slug 可能很长（cola-orange-line-illustration）⇒ 自己截断，别把卡片顶破 */
	max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
.sk-tag.slug { margin-left: 6px; }

/* MCP 工具清单（2026-10-23：工具不再作为 item 显示 ⇒ 折叠成纯名字列表）。
   刻意不用 li —— .sk-pane-mcp li 是"连接器卡片"的样式，工具不是条目。 */
.sk-pane-mcp details.mcp-tools { margin: 8px 0 4px; }
.sk-pane-mcp details.mcp-tools > summary {
	cursor: pointer; font-size: 11.5px; line-height: 18px;
	color: var(--vscode-descriptionForeground, #999); user-select: none;
}
.sk-pane-mcp details.mcp-tools > summary b { font-weight: 600; }
.sk-pane-mcp .mcp-tool-names {
	display: flex; flex-wrap: wrap; gap: 4px 10px;
	margin: 6px 0 0; padding: 8px 10px; border-radius: 6px;
	background: var(--vscode-editorWidget-background, rgba(128,128,128,.05));
	border: 1px dashed var(--vscode-panel-border, rgba(128,128,128,.3));
}
.sk-pane-mcp .mcp-tool-names code {
	font-size: 10.5px; opacity: .75;
	font-family: ui-monospace, Consolas, monospace;
}

/* ── 统一详情弹层（2026-10-23）：底部动作 + 本地详情块 ── */
.mk-dlg-foot { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.mk-dlg-cover-sm { height: 96px; display: flex; align-items: center; justify-content: center; font-size: 40px; }
.mk-detail-local dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 12px; margin: 0 0 12px; }
.mk-detail-local dt { font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); }
.mk-detail-local dd { margin: 0; font-size: 12px; min-width: 0; word-break: break-all; }
.mk-detail-local code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; }
.mk-detail-local .sk-pre { white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; font-size: 11.5px; }
/* ── 已安装折叠组 + 行内动作（2026-10-24 用户：已安装的 agent/工作流/插件/工作台
   要和技能页的行一样，并且能折叠）── */
.sk-fold { margin: 0 10px 10px; }
.sk-fold > summary {
	display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none;
	list-style: none; padding: 6px 4px; font-size: 11.5px; font-weight: 600;
	color: var(--vscode-descriptionForeground, #999);
}
.sk-fold > summary::-webkit-details-marker { display: none; }
.sk-fold > summary::before { content: '\u25B8'; font-size: 10px; transition: transform .12s ease; }
.sk-fold[open] > summary::before { transform: rotate(90deg); }
.sk-fold > summary:hover { color: var(--vscode-foreground, #ccc); }
.sk-fold > summary .sk-fold-n { font-weight: 600; color: var(--vscode-foreground, #ccc); }
.sk-fold > .sk-list { padding: 0; }
.sk-fold > .sk-empty { margin: 4px 2px 0; }
/* 行内动作（删除 / 卸载）：和齿轮一样悬停才出现，避免每行都杵个按钮 */
.sk-act {
	flex: 0 0 auto; align-self: center; margin-right: 8px; padding: 0 8px; height: 22px;
	border-radius: 11px; font: inherit; font-size: 11px; line-height: 20px; cursor: pointer;
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.45));
	background: none; color: var(--vscode-descriptionForeground, #999);
	opacity: 0; transition: opacity .12s ease, color .12s ease, border-color .12s ease;
}
.sk-row:hover .sk-act, .sk-row:focus-within .sk-act, .sk-act:focus { opacity: 1; }
.sk-act:hover { color: var(--vscode-errorForeground, #f14c4c); border-color: currentColor; }
.sk-act[disabled] { opacity: .6; cursor: default; }
/* 插件开关（2026-10-24 用户：「插件 item 是允许有开关的」）：30×16 的滑动开关 */
.sk-sw {
	flex: 0 0 auto; align-self: center; margin-right: 8px; padding: 0;
	width: 30px; height: 16px; border-radius: 8px; position: relative; cursor: pointer;
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.5));
	background: rgba(128,128,128,.28);
	transition: background .12s ease, border-color .12s ease;
}
.sk-sw i {
	position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%;
	background: var(--vscode-foreground, #ccc); transition: transform .12s ease, background .12s ease;
}
.sk-sw[aria-checked="true"] { background: var(--vscode-charts-green, #3fb950); border-color: transparent; }
.sk-sw[aria-checked="true"] i { transform: translateX(14px); background: #fff; }
.sk-sw:hover:not([disabled]) { border-color: var(--vscode-focusBorder, #007acc); }
.sk-sw[disabled] { opacity: .4; cursor: not-allowed; }
/* ── 版本 / 可升级 / 升级·上传（2026-10-26）── */
.sk-tag.ver { font-variant-numeric: tabular-nums; opacity: .9; }
.sk-tag.up { color: var(--vscode-charts-yellow, #d7ba7d); border: 1px solid currentColor; border-radius: 999px; padding: 0 6px; }
/* 行内动作：升级 / 上传 与删除同一套悬停出现，但升级用主色区分 */
.sk-act-up { color: var(--vscode-textLink-foreground, #3794ff); }
.sk-act-pub { color: var(--vscode-descriptionForeground, #999); }
/* 连接器行是别的插件渲染的：没有 .sk-row 的悬停机制 ⇒ 这两个按钮常显，并排进第一行 */
.sk-pane-mcp .sk-act { opacity: 1; margin-left: 6px; font-size: 11px; padding: 1px 6px; border-radius: 4px;
	border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.4)); background: transparent; cursor: pointer; }
.sk-pane-mcp .sk-tag { margin-left: 6px; }
.sk-row.is-off { opacity: .62; }
.sk-row.is-off .sk-nm { text-decoration: line-through; text-decoration-thickness: 1px; }
/* ── 详情弹层的正文（2026-10-26 用户：「弹出页缺少该项的详细说明」）── */
.mk-sec { margin: 0 0 14px; }
.mk-sec h4 { margin: 0 0 6px; font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); }
.mk-sec p { margin: 0; font-size: 12.5px; line-height: 1.62; color: var(--vscode-foreground, #ddd); white-space: pre-wrap; word-break: break-word; }
.mk-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 6px 14px; margin: 0 0 14px; padding: 10px 12px; border-radius: 6px; background: var(--vscode-editorWidget-background, rgba(128,128,128,.06)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); }
.mk-facts dt { font-size: 11.5px; color: var(--vscode-descriptionForeground, #999); }
.mk-facts dd { margin: 0; font-size: 12px; min-width: 0; word-break: break-all; }
.mk-detail h5, .mk-detail h6 { margin: 14px 0 6px; font-size: 12.5px; font-weight: 600; }
.mk-detail p { margin: 0 0 8px; font-size: 12.5px; line-height: 1.62; }
.mk-detail ul { margin: 0 0 8px; padding-left: 18px; }
.mk-detail li { font-size: 12.5px; line-height: 1.6; }
.mk-detail code { font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; padding: 1px 4px; border-radius: 3px; background: rgba(128,128,128,.16); }
.mk-detail pre.mk-pre { margin: 0 0 10px; padding: 10px 12px; border-radius: 6px; overflow: auto; background: rgba(128,128,128,.12); }
.mk-detail pre.mk-pre code { padding: 0; background: none; white-space: pre; }
.mk-detail hr { border: 0; border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,.3)); margin: 12px 0; }
.mk-detail a { color: var(--vscode-textLink-foreground, #3794ff); }
.mk-detail blockquote { margin: 0 0 8px; padding-left: 10px; border-left: 2px solid var(--vscode-panel-border, rgba(128,128,128,.4)); color: var(--vscode-descriptionForeground, #999); }
</style>
</head>
<body data-vssaros-page="skills" data-vssaros-skills-mcp-section="${mcpSection.state}" data-vssaros-skills-preview="enabled">
<div class="sk-view">
		<div class="sk-header">
		<span class="sk-title">工具</span>
		<span class="sk-count" data-sk-hcount>${summary.count} 技能 · ${wf.items.length} 工作流 · ${ag.items.length} Agent · ${TOOLS_WORKBENCHES.length} 工作台</span>
		<span class="sk-spacer"></span>
		<label class="sk-search-h"><input data-sk-search placeholder="搜索名称 / 描述 / 路径" aria-label="搜索"><span data-sk-count>${summary.count}/${summary.count}</span></label>
		<a class="sk-hbtn sk-hbtn-link" href="http://21.6.92.5:3040/" target="_blank" rel="noopener" data-sk-market-link title="在浏览器打开商城：http://21.6.92.5:3040/">商城 \u203A</a>
		<button type="button" class="sk-hbtn" data-sk-refresh title="重新加载">\u21BB</button>
		<button type="button" class="sk-hbtn" data-sk-open-full title="在编辑区打开本页">\u2197</button>
	</div>
<div class="sk-panel">
		<div class="sk-panel-bar"><span>工具</span><span class="sk-spacer"></span><span class="sk-note">只读 · ${escapeHtml(PROVIDER_NAME)}</span></div>
		<div class="sk-panel-content">
			<div class="sk-seg">
				<button type="button" data-sk-tab="skills" class="on">技能 ${summary.count}</button>
				<button type="button" data-sk-tab="mcp">连接器</button>
				<button type="button" data-sk-tab="workflows">工作流 ${wf.items.length}</button>
				<button type="button" data-sk-tab="agents">Agent ${ag.items.length}</button>
				<button type="button" data-sk-tab="workbenches">工作台 ${TOOLS_WORKBENCHES.length}</button>
				<button type="button" data-sk-tab="plugins">插件 ${builtinPlugins.length + installedPlugins.length + (mk.totals?.plugin ?? 0)}</button>
			</div>
			<div data-sk-pane="skills">
				${filterBarHtml('skills',
					skills.map(x => ({ src: skillSrcOf(x.path), act: x.activation })).concat(marketItemsFor(mk, 'skills').map(i => ({ src: 'market', ver: i.version ? 'yes' : 'no' }))),
					[{ k: 'all', t: '全部' }, { k: 'src:market', t: '可安装' }, { k: 'src:installed', t: '已安装' },
						{ k: 'src:builtin', t: '内置' }, { k: 'act:auto', t: '自动调用' }],
					[{ k: 'ver:yes', t: '有可安装版本' }, { k: 'ver:no', t: '仅浏览（无包体）' }],
				)}
				${dnNote}${foldHtml('skills', skills.length, list)}${marketGridHtml(mk, 'skills')}</div>
			<div data-sk-pane="mcp" hidden><div class="sk-pane-mcp">${decorateMcpHtml(mcpSection.html, id => (mkBySlug.get(String(id)) || {}).name, (name) => {
				// 本地版本来自 <数据根>/mcp/<name>/config.json；商城版本来自同名商品
				const lv = (mcpInstalled && mcpInstalled[name]) || '';
				const st = mkBySlug.get(String(name));
				return { lv, sv: st ? String(st.version || '') : '' };
			})}</div>${marketGridHtml(mk, 'conn')}</div>

			<div data-sk-pane="workflows" hidden>
				${filterBarHtml('workflows',
					wf.items.map(w => ({ src: 'installed', state: w.active ? 'on' : 'off' })).concat(marketItemsFor(mk, 'workflows').map(i => ({ src: 'market', ver: i.version ? 'yes' : 'no' }))),
					[{ k: 'all', t: '全部' }, { k: 'state:on', t: '已启用' }, { k: 'state:off', t: '已停用' }, { k: 'src:market', t: '可安装' }],
					[],
				)}
				${foldHtml('workflows', wf.items.length,
					wf.items.length ? '<ul class="sk-list">' + wf.items.map(w => renderItemRow({
						kind: 'workflow',
						slug: w.id,
						store: storeOfId(w.id),
						name: readableName({ slug: w.id, name: w.name, storeName: storeOfId(w.id)?.name }),
						desc: (storeOfId(w.id) ? (shortStoreDesc(storeOfId(w.id).description).slice(0, 140) || w.desc) : w.desc),
						localVer: w.version,
						fullDesc: (storeOfId(w.id) ? (shortStoreDesc(String(storeOfId(w.id).description || '')) || w.desc) : w.desc),
						facts: [
							['类型', '工作流'],
							['状态', w.active ? '已启用' : '已停用'],
							['节点', String(w.nodes) + ' 个'],
							['更新时间', w.updatedAt ? new Date(w.updatedAt).toISOString().slice(0, 10) : '未知'],
							['工作流 id', w.id],
						].concat(storeOfId(w.id) ? [['商城商品', String(storeOfId(w.id).slug)]] : []),
						src: 'installed',
						f: { src: 'installed', state: w.active ? 'on' : 'off' },
						tags: [{ text: w.active ? '已启用' : '已停用', acc: w.active }, { text: '已安装' }, { text: w.nodes + ' 个节点' }],
						delKind: 'workflow',
						delLabel: '删除',
						paths: P('flow', w),
					})).join('') + '</ul>' : '',
					'<p class="sk-empty">工作流目录里还没有条目：<code>' + escapeHtml(prettyPath(wf.root)) + '</code></p>',
				)}
				${wf.errors.length ? '<p class="sk-empty">' + wf.errors.length + ' 个文件读不了：' + escapeHtml(wf.errors.join('；')) + '</p>' : ''}
				<p class="sk-note">「内置」恒为 0：本插件没有随包提供工作流模板，真源全部在数据根（已安装）。</p>
				${marketGridHtml(mk, 'workflows')}
			</div>

			<div data-sk-pane="agents" hidden>
				${filterBarHtml('agents',
					ag.items.map(a => ({ src: 'installed', model: a.model ? 'yes' : 'no' })).concat(marketItemsFor(mk, 'agents').map(i => ({ src: 'market', ver: i.version ? 'yes' : 'no' }))),
					[{ k: 'all', t: '全部' }, { k: 'model:yes', t: '有模型' }, { k: 'src:market', t: '可安装' }],
					[],
				)}
				${foldHtml('agents', ag.items.length,
					ag.items.length ? '<ul class="sk-list">' + ag.items.map(a => renderItemRow({
						kind: 'agent',
						slug: a.id,
						store: storeOfId(a.id),
						name: readableName({ slug: a.id, name: a.name, storeName: storeOfId(a.id)?.name }),
						desc: (storeOfId(a.id) ? (shortStoreDesc(storeOfId(a.id).description).slice(0, 140) || a.desc) : a.desc),
						localVer: a.version,
						fullDesc: (storeOfId(a.id) ? (shortStoreDesc(String(storeOfId(a.id).description || '')) || a.desc) : a.desc),
						facts: [
							['类型', 'Agent'],
							['Agent id', a.id],
						].concat(a.role ? [['角色', a.role]] : [])
							.concat(a.model ? [['模型', a.model]] : [])
							.concat(storeOfId(a.id) ? [['商城商品', String(storeOfId(a.id).slug)]] : []),
						src: 'installed',
						f: { src: 'installed', model: a.model ? 'yes' : 'no' },
						tags: [{ text: '已安装' }].concat(a.role ? [{ text: a.role }] : []).concat(a.model ? [{ text: a.model }] : []),
						delKind: 'agent',
						delLabel: '删除',
						paths: P('agent', a),
					})).join('') + '</ul>' : '',
					'<p class="sk-empty">Agent 目录里还没有条目：<code>' + escapeHtml(prettyPath(ag.root)) + '</code></p>',
				)}
				${ag.errors.length ? '<p class="sk-empty">' + ag.errors.length + ' 个文件读不了：' + escapeHtml(ag.errors.join('；')) + '</p>' : ''}
				<p class="sk-note">「内置」Agent 由 IDE 代码真源生成副本后经 agents 插件交付，本页读不到那份目录 ⇒ 恒为 0，不伪造。</p>
				${marketGridHtml(mk, 'agents')}
			</div>

			<div data-sk-pane="plugins" hidden>
				<!-- ★ 2026-10-24（用户：「插件页签下增加 全部、内置、已安装 的过滤」）：
				     三档都是**真的**：内置 = profile 里随产品发布的 @vssaros/@deepseek-ai；
				     已安装 = profile 里第三方（从商城装的）；其余是商城目录（还没装）。 -->
				${filterBarHtml('plugins',
					builtinPlugins.map(() => ({ src: 'builtin' }))
						.concat(installedPlugins.map(() => ({ src: 'installed' })))
						.concat(marketItemsFor(mk, 'plugins').map(i => ({ src: 'market', ver: i.version ? 'yes' : 'no' }))),
					[{ k: 'all', t: '全部' }, { k: 'src:builtin', t: '内置' }, { k: 'src:installed', t: '已安装' }],
					[],
				)}
				${foldHtml('plugins', builtinPlugins.length + installedPlugins.length,
					(builtinPlugins.length + installedPlugins.length)
						? '<ul class="sk-list">'
							+ builtinPlugins.map(x => renderItemRow({
								kind: 'plugin', slug: x.name,
								name: pluginTitleOf(x.name),
								desc: x.name + ' · ' + (x.version || '版本未知'),
								src: 'builtin', f: { src: 'builtin' },
								icon: pluginIconOf(x.name),
								store: pluginStoreOf(x.name),
								localVer: x.version,
								togglePkg: x.name,
								toggleOn: enabledBundles.has(x.name),
								toggleLocked: SELF_LOCKED_PLUGINS.includes(x.name),
								toggleTitle: SELF_LOCKED_PLUGINS.includes(x.name)
									? '这是当前页面/商城接口所在的插件，不能在这里关闭'
									: (enabledBundles.has(x.name) ? '已启用（点一下停用）' : '已停用（点一下启用）'),
								fullDesc: pluginDescOf(x.name, true),
								facts: [
									['类型', '插件（dsh plugin）'],
									['包名', x.name],
									['版本', x.version || '未声明'],
									['来源', '随产品发布（内置）'],
									['启用状态', enabledBundles.has(x.name) ? '已启用' : '已停用'],
								],
								tags: [{ text: '内置' }, { text: '随包' }],
								paths: pluginPathsHtml(x, true),
							})).join('')
							+ installedPlugins.map(x => renderItemRow({
								kind: 'plugin', slug: x.name,
								name: pluginTitleOf(x.name),
								desc: x.name + ' · ' + (x.version || '版本未知'),
								src: 'installed', f: { src: 'installed' },
								icon: pluginIconOf(x.name),
								store: pluginStoreOf(x.name),
								localVer: x.version,
								togglePkg: x.name,
								toggleOn: enabledBundles.has(x.name),
								toggleTitle: enabledBundles.has(x.name) ? '已启用（点一下停用）' : '已停用（点一下启用）',
								fullDesc: pluginDescOf(x.name, false),
								facts: [
									['类型', '插件（dsh plugin）'],
									['包名', x.name],
									['版本', x.version || '未声明'],
									['来源', '从商城安装'],
									['启用状态', enabledBundles.has(x.name) ? '已启用' : '已停用'],
								],
								tags: [{ text: '已安装' }, { text: '商城安装' }],
								delKind: 'plugin', delOp: 'uninstall', delPkg: x.name,
								delLabel: '卸载',
								delTitle: '从 dsh profile 移除这个插件（之后可从商城重装）',
								paths: pluginPathsHtml(x, false),
							})).join('')
							+ '</ul>'
						: ''
				)}
				${profilePlugins.error ? '<p class="sk-note">读不到 profile 的插件清单（' + escapeHtml(profilePlugins.error) + '）⇒ 内置 / 已安装 两档为空，可安装那部分照常。</p>' : ''}
				${mk.totals?.plugin > MARKET_PAGE_SIZE.plugin
					? '<p class="sk-note">商城共 ' + mk.totals.plugin + ' 个插件，这里展示前 ' + MARKET_PAGE_SIZE.plugin + ' 个；完整列表见 <a href="/x/marketplace/" target="_blank" rel="noopener">商城</a>。</p>'
					: ''}
				${marketGridHtml(mk, 'plugins')}
				${marketItemsFor(mk, 'plugins').length && (mk.totals?.plugin ?? 0) > MARKET_PAGE_SIZE.plugin
					? '<div class="sk-more-wrap"><button type="button" class="sk-hbtn sk-more-btn" data-sk-more-pane="plugins" data-sk-more-page="1">加载更多（还有 ' + ((mk.totals?.plugin ?? 0) - MARKET_PAGE_SIZE.plugin) + ' 个）</button></div>'
					: ''}
				${builtinPlugins.length || installedPlugins.length || marketItemsFor(mk, 'plugins').length ? '' : '<p class="sk-empty">本机没有装任何插件，商城里的插件也还没同步过来（跑 tools/sync-dsh-plugins.mjs 即可）。</p>'}
			</div>

			<div data-sk-pane="workbenches" hidden>
				${filterBarHtml('workbenches',
					TOOLS_WORKBENCHES.map(() => ({ src: 'builtin' })).concat(marketItemsFor(mk, 'workbenches').map(i => ({ src: 'market', ver: i.version ? 'yes' : 'no' }))),
					[{ k: 'all', t: '全部' }, { k: 'src:builtin', t: '内置' }, { k: 'src:market', t: '可安装' }],
					[],
				)}
				${foldHtml('workbenches', TOOLS_WORKBENCHES.length,
					'<ul class="sk-list">' + TOOLS_WORKBENCHES.map(w => {
						const id = w.route.replace(/^\/x\//, '').replace(/\/$/, '');
						return renderItemRow({
							kind: 'workbench', slug: id,
							name: readableName({ slug: id, name: w.name }),
							desc: w.desc,
							// 工作台没有自己的版本号 —— 它就是那个 dsh 插件（provider = vssaros-xxx ⇒ @vssaros/dsh-xxx）
							localVer: pluginVersionOfProvider(w.provider),
							fullDesc: w.desc,
							facts: [
								['类型', '工作台'],
								['路由', w.route],
								['提供方', w.provider],
								['内置', '是（随产品发布，注册在宿主服务里）'],
							],
							src: 'builtin', f: { src: 'builtin' },
							tags: [{ text: '内置' }, { text: w.route }],
							paths: P('wb', w),
						});
					}).join('') + '</ul>',
				)}
				<p class="sk-note">工作台注册在宿主服务里（IDE 活动栏管理）⇒ 本页只读镜像，不提供开关。</p>
				${marketGridHtml(mk, 'workbenches')}
			</div>
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
<!-- 商城商品详情（�� colaskill 的商品页）：大封面 → 标签 → 标题 → 作者/许可 → 正文 → 底部动作。
     点卡片任意位置或「详情」都会打开它；正文按需从 /x/marketplace/api/action 的 detail 拉。 -->
<div class="mk-dlg" data-mk-dlg hidden>
	<div class="mk-dlg-mask" data-mk-close></div>
	<div class="mk-dlg-box" role="dialog" aria-modal="true" aria-label="商品详情">
		<button type="button" class="mk-dlg-x" data-mk-close aria-label="关闭">\u2715</button>
		<div class="mk-dlg-cover" data-mk-cover></div>
		<div class="mk-dlg-head">
			<div class="mk-dlg-pills" data-mk-pills></div>
			<h2 class="mk-dlg-title" data-mk-title></h2>
			<div class="mk-dlg-sub" data-mk-sub></div>
		</div>
		<div class="mk-dlg-body" data-mk-body></div>
		<div class="mk-dlg-foot" data-mk-foot></div>
	</div>
</div>
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
				// 「加载更多」：返回**已渲染好的卡片 HTML**（客户端只需 insertAdjacentHTML）
				// ⇒ 不必在浏览器里再实现一遍卡片模板（两份迟早漂移 ✗）
				if (pathname === `${ROUTE_PREFIX}/api/plugins`) {
					const u = new URL(req.url ?? '/', 'http://127.0.0.1');
					const page = Math.max(2, Number(u.searchParams.get('page')) || 2);
					const pageSize = MARKET_PAGE_SIZE.plugin;
					const m = await fetchMarketPage(req, 'plugin', page, pageSize);
					if (!m.ok) {
						res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
						res.end(JSON.stringify({ ok: false, error: m.error }));
						return;
					}
					const html = m.items.filter(it => it && it.kind === 'plugin' && it.slug).map(renderMarketCard).join('');
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: true, page, pageSize, html, total: m.total, hasMore: page * pageSize < m.total }));
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
					workflows: await scanWorkflowsOf(config),
					agents: await scanAgentsOf(config),
					// 商城目录（可选依赖）：失败只是没有可装项，不影响本页
					market: await fetchMarketItems(req),
					errors: scan.errors,
					missing: scan.missing,
					root,
					nativeSkillTool: state.nativeSkillToolPresent,
					provider: state.provider,
					// 这两个诊断栏属于**本次挂载**（preset plane 下同一个包会被多次挂载 ⇒ 不许用模块级 ✗）
					skillishTools: state.skillishTools,
					// MCP 区块（`@vssaros/dsh-mcp` 的片段）：同源转发 Cookie 取回；没装/没激活都只是"未内嵌"。
					mcpSection: await fetchMcpSection(req),
					// 已装 MCP 包的版本（详情里的「版本 / 升级 / 上传」靠它）
					mcpInstalled: readInstalledMcpVersions(root ? dirname(root) : ''),
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
