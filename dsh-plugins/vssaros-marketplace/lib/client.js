// @vssaros/dsh-marketplace — 商城工作台的前端（2026-10-22）。
//
// ★ 为什么是**自托管页面**而不是 dsh 客户端的 React chunk：
//   本页走 `vssaros.view = { kind:'page', route:'/x/marketplace/' }` ⇒ IDE 直接开这个 URL ⇒
//   页面自带 HTML + JS（原生 DOM，无 React 依赖）✓ ⇒ 不进 dsh 的 chunk 装载器 ✓。
//
// ★ 纪律：
//   1. **权限只按服务端下发的 `permissions` 渲染**，前端不自行判断 admin/作者 ✓；
//   2. **失败如实显示**（后端回 ok:false 就显示错误，不假装成功）✓；
//   3. 所有动作都经 `/x/marketplace/api/action` 转发给 IDE（认证/下载/刷新都在那边）✓。
//
// ★ 页面脚本里的事件用 `addEventListener` 绑定（不用内联 onclick）⇒ 不必把函数挂 window ✓。

(function () {
	'use strict';

	/** 商城动作统一入口（转发给 IDE ⇒ 认证与副作用都在 IDE 侧 ✓）。 */
	async function action(op, params) {
		let res;
		try {
			res = await fetch('/x/marketplace/api/action', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op, params: params || {} }),
				credentials: 'same-origin',
				cache: 'no-store',
			});
		} catch (e) {
			return { ok: false, error: '连不上商城通道：' + String(e && e.message ? e.message : e) };
		}
		let data = null;
		try { data = await res.json(); } catch { data = null; }
		if (!data) { return { ok: false, error: '商城通道没有回执（HTTP ' + res.status + '）' }; }
		return data;
	}

	/** 商品类型的中文名（与服务端 kinds 同口径）。 */
	const KIND_LABEL = {
		agent: 'Agent', skill: 'Skill', mcp: 'MCP',
		knowledge: '知识库', workflow: '工作流', workbench: '工作台',
	};
	/** 页签只展示这几类（mcp/knowledge 暂不进页签，但接口支持 ✓）。 */
	const TABS = [
		{ id: '', label: '全部' },
		{ id: 'agent', label: 'Agent' },
		{ id: 'skill', label: 'Skill' },
		{ id: 'workbench', label: '工作台' },
		{ id: 'workflow', label: '工作流' },
	];

	/** 页面状态。 */
	const state = {
		tab: 'market',        // market | mine | installed | admin
		kind: '',             // 当前分类
		q: '',
		items: [],
		total: 0,
		detail: null,
		busy: false,
		msg: null,            // { text, kind }
	};

	const root = document.getElementById('vs-mp-root');
	if (!root) { return; }

	/** 顶部消息条。 */
	function showMsg(text, kind) {
		state.msg = { text: String(text || ''), kind: kind || 'info' };
		render();
	}

	/** 拉清单。 */
	async function load() {
		state.busy = true;
		render();
		const params = { limit: 60 };
		if (state.kind) { params.kind = state.kind; }
		if (state.q) { params.q = state.q; }
		if (state.tab === 'mine') { params.scope = 'mine'; }
		if (state.tab === 'admin') { params.scope = 'review'; }
		// ★ 「已安装」页签走**本地台账**（installed-packages.json）——
		//   服务端不知道谁装了 ⇒ 这个视图只能在客户端算 ✓。
		const op = state.tab === 'installed' ? 'installed' : 'list';
		const res = await action(op, params);
		state.busy = false;
		if (!res || res.ok === false) {
			state.items = [];
			state.total = 0;
			showMsg((res && res.error) || '商城清单取不到', 'error');
			return;
		}
		state.items = Array.isArray(res.items) ? res.items : [];
		state.total = Number(res.total) || state.items.length;
		render();
	}

	/** 打开详情。 */
	async function openDetail(slug) {
		const res = await action('detail', { slug });
		if (!res || res.ok === false) {
			showMsg((res && res.error) || '详情取不到', 'error');
			return;
		}
		state.detail = res;
		render();
	}

	/** 执行一个动作（安装/卸载/升级/发布/下架）。 */
	async function run(op, params, okText) {
		state.busy = true;
		render();
		const res = await action(op, params);
		state.busy = false;
		if (!res || res.ok === false) {
			showMsg((res && res.error) || '操作失败', 'error');
			return;
		}
		showMsg(okText || '完成', 'ok');
		await load();
		if (state.detail && state.detail.slug === params.slug) {
			await openDetail(params.slug);
		}
	}

	// ── 渲染 ──────────────────────────────────────────────
	function esc(s) {
		return String(s == null ? '' : s)
			.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
	}

	/** 顶部四个页签。 */
	function renderTabs() {
		const items = [
			{ id: 'market', label: '商城' },
			{ id: 'mine', label: '我的发布' },
			{ id: 'installed', label: '已安装' },
			{ id: 'admin', label: '管理' },
		];
		return items.map(it => (
			'<button class="vs-mp-tab' + (state.tab === it.id ? ' active' : '') + '" data-tab="' + it.id + '">' + esc(it.label) + '</button>'
		)).join('');
	}

	/** 分类子页签。 */
	function renderKindTabs() {
		if (state.tab === 'admin') { return ''; }
		return TABS.map(t => (
			'<button class="vs-mp-kind' + (state.kind === t.id ? ' active' : '') + '" data-kind="' + t.id + '">' + esc(t.label) + '</button>'
		)).join('');
	}

	/** 一张卡片。 */
	function renderCard(pkg) {
		const perm = pkg.permissions || {};
		const version = pkg.version ? 'v' + pkg.version : '';
		const statusTag = pkg.status && pkg.status !== 'active'
			? '<span class="vs-mp-tag warn">' + esc(pkg.status === 'pending_review' ? '待审核' : pkg.status) + '</span>'
			: '';
		const distTag = pkg.distributionType && pkg.distributionType !== 'bundle'
			? '<span class="vs-mp-tag">' + esc(pkg.distributionType) + '</span>'
			: '';
		// 「已安装」页签里可升级的条目 ⇒ 标出来 ✓
		const upgradableTag = pkg.upgradable
			? '<span class="vs-mp-tag warn">可升级 → v' + esc(pkg.latestVersion || '') + '</span>'
			: '';
		const actions = [];
		actions.push('<button class="vs-mp-btn" data-detail="' + esc(pkg.slug) + '">详情</button>');
		if (pkg.upgradable) {
			actions.push('<button class="vs-mp-btn primary" data-upgrade="' + esc(pkg.slug) + '">升级</button>');
		} else if (perm.canPublish !== false) {
			actions.push('<button class="vs-mp-btn primary" data-install="' + esc(pkg.slug) + '">安装</button>');
		}
		if (state.tab === 'installed') {
			actions.push('<button class="vs-mp-btn danger" data-uninstall="' + esc(pkg.slug) + '">卸载</button>');
		}
		return '' +
			'<div class="vs-mp-card" data-slug="' + esc(pkg.slug) + '">' +
				'<div class="vs-mp-card-head">' +
					'<span class="vs-mp-kindtag">' + esc(KIND_LABEL[pkg.kind] || pkg.kind) + '</span>' +
					statusTag + distTag + upgradableTag +
				'</div>' +
				'<div class="vs-mp-card-title">' + esc(pkg.name) + '</div>' +
				'<div class="vs-mp-card-meta">' + esc(pkg.author || '暂无') + (version ? ' · ' + esc(version) : '') + '</div>' +
				'<div class="vs-mp-card-desc">' + esc(pkg.description || '这个商品暂时还没有填写介绍。') + '</div>' +
				'<div class="vs-mp-card-actions">' + actions.join('') + '</div>' +
			'</div>';
	}

	/** 详情抽屉。 */
	function renderDetail() {
		const d = state.detail;
		if (!d) { return ''; }
		const perm = d.permissions || {};
		const versions = (d.versions || []).map(v => (
			'<li>' + esc(v.version) + (v.isLatest ? ' <span class="vs-mp-tag ok">最新</span>' : '') +
			'<div class="vs-mp-ver-note">' + esc(v.changelog || '') + '</div>' +
			((perm.canDelete !== false)
				? '<button class="vs-mp-link" data-delver="' + esc(v.version) + '">下架此版本</button>'
				: '') +
			'</li>'
		)).join('');
		const buttons = [];
		if (perm.canPublish !== false) {
			buttons.push('<button class="vs-mp-btn primary" data-install="' + esc(d.slug) + '">安装</button>');
		}
		if (perm.canDelete !== false) {
			buttons.push('<button class="vs-mp-btn danger" data-uninstall="' + esc(d.slug) + '">卸载</button>');
			buttons.push('<button class="vs-mp-btn danger" data-delpkg="' + esc(d.slug) + '">下架整个包</button>');
		}
		return '' +
			'<div class="vs-mp-mask" data-close="1"></div>' +
			'<div class="vs-mp-drawer">' +
				'<div class="vs-mp-drawer-head">' +
					'<div>' +
						'<div class="vs-mp-drawer-title">' + esc(d.name) + '</div>' +
						'<div class="vs-mp-drawer-meta">' + esc(KIND_LABEL[d.kind] || d.kind) +
							' · ' + esc(d.author || '暂无') +
							(d.version ? ' · v' + esc(d.version) : '') + '</div>' +
					'</div>' +
					'<button class="vs-mp-x" data-close="1">×</button>' +
				'</div>' +
				'<div class="vs-mp-drawer-desc">' + esc(d.description || '这个商品暂时还没有填写介绍。') + '</div>' +
				'<div class="vs-mp-drawer-actions">' + buttons.join('') + '</div>' +
				'<div class="vs-mp-drawer-versions"><h4>版本</h4><ul>' + (versions || '<li class="vs-mp-empty">还没有发布版本</li>') + '</ul></div>' +
			'</div>';
	}

	/** 主渲染。 */
	function render() {
		const msg = state.msg
			? '<div class="vs-mp-msg ' + esc(state.msg.kind) + '">' + esc(state.msg.text) +
				'<button class="vs-mp-x" data-closemsg="1">×</button></div>'
			: '';
		const cards = state.items.map(renderCard).join('');
		const empty = state.items.length === 0
			? '<div class="vs-mp-empty">' + (state.busy ? '正在加载…' : '没有找到匹配的商品。') + '</div>'
			: '<div class="vs-mp-grid">' + cards + '</div>';
		root.innerHTML = '' +
			'<div class="vs-mp-wrap">' +
				'<header class="vs-mp-head">' +
					'<div>' +
						'<h1>商城工作台</h1>' +
						'<p class="vs-mp-sub">Agent / Skill / 工作台 / 工作流 —— 安装、升级、发布与维护</p>' +
					'</div>' +
					'<div class="vs-mp-tools">' +
						'<input id="vs-mp-q" class="vs-mp-input" placeholder="搜索名称、作者或分类" value="' + esc(state.q) + '" />' +
						'<button class="vs-mp-btn" data-refresh="1">刷新</button>' +
					'</div>' +
				'</header>' +
				msg +
				'<nav class="vs-mp-tabs">' + renderTabs() + '</nav>' +
				'<nav class="vs-mp-kinds">' + renderKindTabs() + '</nav>' +
				'<div class="vs-mp-count">已显示 ' + state.items.length + ' / 共 ' + state.total + ' 个商品</div>' +
				empty +
			'</div>' +
			renderDetail();

		bindEvents();
	}

	/** 事件绑定（每次渲染后重绑；用 data-* 属性做事件委托 ⇒ 不用挂 window ✓）。 */
	function bindEvents() {
		const on = (sel, ev, fn) => {
			root.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
		};
		on('[data-tab]', 'click', e => {
			state.tab = e.currentTarget.getAttribute('data-tab');
			state.detail = null;
			state.msg = null;
			load();
		});
		on('[data-kind]', 'click', e => {
			state.kind = e.currentTarget.getAttribute('data-kind');
			load();
		});
		on('[data-refresh]', 'click', () => { state.msg = null; load(); });
		on('[data-closemsg]', 'click', () => { state.msg = null; render(); });
		on('[data-close]', 'click', () => { state.detail = null; render(); });
		on('[data-detail]', 'click', e => { openDetail(e.currentTarget.getAttribute('data-detail')); });
		on('[data-install]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-install');
			const pkg = state.items.find(p => p.slug === slug) || (state.detail && state.detail.slug === slug ? state.detail : null);
			const kind = pkg ? pkg.kind : 'skill';
			run('install', { kind: kind, slug: slug }, '已安装（部分资源需要重启后才生效）');
		});
		on('[data-upgrade]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-upgrade');
			const pkg = state.items.find(p => p.slug === slug);
			const kind = pkg ? pkg.kind : 'skill';
			run('upgrade', { kind: kind, slug: slug }, '已升级（部分资源需要重启后才生效）');
		});
		on('[data-uninstall]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-uninstall');
			// 卸载要带 kind：详情抽屉里有；卡片上（已安装页签）从列表项取 ✓
			const fromDetail = state.detail && state.detail.slug === slug ? state.detail : null;
			const fromList = state.items.find(p => p.slug === slug);
			const kind = (fromDetail && fromDetail.kind) || (fromList && fromList.kind) || 'skill';
			run('uninstall', { kind: kind, slug: slug }, '已卸载');
		});
		on('[data-delpkg]', 'click', e => {
			const slug = e.currentTarget.getAttribute('data-delpkg');
			const d = state.detail || {};
			run('deletePackage', { kind: d.kind, slug: slug }, '已下架');
		});
		on('[data-delver]', 'click', e => {
			const version = e.currentTarget.getAttribute('data-delver');
			const d = state.detail || {};
			run('deleteVersion', { kind: d.kind, slug: d.slug, version: version }, '已下架该版本');
		});

		const q = root.querySelector('#vs-mp-q');
		if (q) {
			q.addEventListener('keydown', e => {
				if (e.key !== 'Enter') { return; }
				state.q = e.currentTarget.value.trim();
				load();
			});
		}
	}

	// 首屏
	load();
})();
