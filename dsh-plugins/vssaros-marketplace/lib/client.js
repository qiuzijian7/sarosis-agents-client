// ★ 2026-10-27 工作台标题统一（商城工作台页头 22px→14px，与共享层对齐）—— 触碰入口使产物 revision 更新
// @vssaros/dsh-marketplace — 商城工作台前端（★ 2026-10-22 用 React 重写）
//
// ★ 为什么重写（用户反馈）：
//   ① **文字看不清** —— 旧版把"描述/作者/版本"全用 grey（`--dsw-fg-muted` 的兜底 `#999`），
//      深色主题下对比度不足、12px 又小 ⇒ 整页发灰。新版口径：
//      **正文与描述用主前景色 + 降透明度**（跟着主题走），grey 只留给真正的次要信息（时间戳）。
//   ② **技术栈统一** —— 用 React（dsh 其它界面都是 React）。
//
// ★ React 从哪来（关键，别再绕一遍）：
//   本页是**自托管 SSR 页**（`vssaros.view.kind='page'`）⇒ **不在** dsh 的 chunk 装载器里
//   ⇒ **不能** `require("react")`（那是 chunk 形态的拿法 ✗）。
//   ⇒ 页面 `<script>` 顺序引入 **UMD 版 React 18.3.1**（`lib/vendor/`，共 139KB，仓内已有 ✓）
//     `react.js` → `react-dom.js` → 本文件（本文件用全局 `window.React` / `window.ReactDOM`）。
//   ⇒ 所以本文件是**普通 script**（不是 ESM）：没有 import/export，全部挂在 IIFE 里 ✓。
//
// ★ 纪律（沿用旧版，别退化）：
//   1. 权限只按服务端下发的 `permissions` 渲染（前端不判 admin/作者）✓
//   2. 失败如实显示（后端 `ok:false` 就显示错误，不假装成功）✓
//   3. 所有动作都经 `/x/marketplace/api/action`（认证/下载/落盘都在 Host 侧）✓

(function () {
	'use strict';

	var React = window.React;
	var ReactDOM = window.ReactDOM;
	var root = document.getElementById('vs-mp-root');

	/** React 缺失就如实报（**不要静默白屏**：白屏是最难查的形态）✗ */
	if (!React || !ReactDOM || !window.MarketplaceState || !window.MarketplaceUI) {
		if (root) {
			root.innerHTML = '<div class="vs-mp-empty">商城模块没有装载成功（React / 状态 / UI 资源缺失）—— 请刷新；仍然不行请检查插件更新是否完整。</div>';
		}
		return;
	}

	var h = React.createElement;
	var useState = React.useState;
	var useEffect = React.useEffect;
	var useCallback = React.useCallback;
	var useMemo = React.useMemo;
	var useRef = React.useRef;

	/** 每页条数（商城里单类 500+ 条 ⇒ 必须分页）。 */
	var PAGE_SIZE = 60;

	/** 商品类型中文名（与服务端 kinds 同口径）。 */
	var KIND_LABEL = {
		agent: 'Agent',
		skill: 'Skill',
		mcp: 'MCP',
		knowledge: '知识库',
		workbench: '工作台'
	};

	/**
	 * 各类型没有图标时的默认 emoji（★ 2026-10-23 用户："商城中的 item 希望也有图像显示"）。
	 *
	 * 为什么需要兜底：实测 168 个商品里 `icon` **全是同一个默认值**（`🥤`），
	 * 服务端也没有 `cover` / `thumbnail` 字段 ⇒ 光显示 icon 会整页一个样，等于没有图像信息 ✗
	 * ⇒ 用「图标 + 按 slug 稳定的渐变色底」做出可辨识的视觉块（同一商品颜色恒定）✓
	 */
	var KIND_EMOJI = {
		agent: '🤖',
		skill: '⚡',
		mcp: '🔌',
		knowledge: '📚',
		workbench: '🧰'
	};

	/**
	 * 文案兜底：把"可能不是字符串"的字段变成字符串。
	 *
	 * ★ 2026-10-23 真机踩到：公开市场同步来的商品 `description` 是 `{zh, en}` 对象
	 *   ⇒ `String(obj)` 直接渲染成 **`[object Object]`** ✗
	 *   Host 侧已在 `shape.js` 的 `textOf` 里归一；这里再兜一层（页面还吃 mock / 旧缓存）✓
	 *
	 * @param {unknown} v
	 * @returns {string}
	 */
	function textOf(v) {
		if (v === null || v === undefined) { return ''; }
		if (typeof v === 'string') { return v; }
		if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
		if (Array.isArray(v)) { return v.map(textOf).filter(Boolean).join(' / '); }
		if (typeof v === 'object') {
			var keys = ['zh', 'zh-CN', 'zhCn', 'cn', 'en', 'default'];
			for (var i = 0; i < keys.length; i++) {
				var hit = v[keys[i]];
				if (typeof hit === 'string' && hit.trim()) { return hit; }
			}
			var own = Object.keys(v);
			for (var j = 0; j < own.length; j++) {
				if (typeof v[own[j]] === 'string' && v[own[j]].trim()) { return v[own[j]]; }
			}
			return '';
		}
		return String(v);
	}

	/** 字符串 → 稳定色相（同一 slug 永远同色，刷新不会跳）。 */
	function hueOf(text) {
		var s = String(text || '');
		var hv = 0;
		for (var i = 0; i < s.length; i++) {
			hv = (hv * 31 + s.charCodeAt(i)) % 360;
		}
		return hv;
	}

	/** 图标块底：两段同色系渐变（深色主题下也不刺眼）。 */
	function iconBg(hue) {
		return 'linear-gradient(135deg, hsl(' + hue + ',68%,58%,0.34), hsl(' + ((hue + 46) % 360) + ',72%,46%,0.16))';
	}

	/** 这个 icon 是不是图片地址（而不是 emoji / 短文本）。 */
	function isImageIcon(raw) {
		return /^(https?:\/\/|data:image\/)/i.test(String(raw || '').trim());
	}

	/**
	 * 商品图标块（卡片 / 详情共用）。
	 *
	 * 三态：
	 *   · `icon` 是**图片地址** ⇒ `<img loading="lazy" decoding="async">`
	 *     （浏览器原生懒加载：只加载视口内的，168 个卡片也不会一次拉 168 个请求 ✓）
	 *     · 加载失败 ⇒ 自动退回 emoji（不让格子空着，也不显示破图 ✗）
	 *   · `icon` 是 emoji / 短文本 ⇒ 直接显示
	 *   · 空 ⇒ 按类型给默认 emoji
	 *
	 * @param {{ pkg: object, large?: boolean }} props
	 */
	function PkgIcon(props) {
		var pkg = props.pkg || {}, raw = String(pkg.icon || '').trim(), failed = useState(false);
		useEffect(function () { failed[1](false); }, [raw]);
		var cls = 'vs-mp-icon' + (props.large ? ' vs-mp-icon-lg' : '');
		if (isImageIcon(raw) && !failed[0]) {
			return h('div', { className: cls + ' image', title: raw }, h('img', {
				src: raw, alt: textOf(pkg.name) + ' Logo', loading: 'lazy', decoding: 'async', referrerPolicy: 'no-referrer',
				onError: function () { failed[1](true); }
			}));
		}
		return h('div', { className: cls, title: failed[0] ? '原始图标加载失败' : raw || '商城未提供图标' },
			h('span', { className: raw && !failed[0] ? 'vs-mp-icon-emoji' : 'vs-mp-asset-missing' }, failed[0] ? '图标失败' : raw || '无图标'));
	}

	/**
	 * 商品**缩略图**（★ 2026-10-23 用户："参考 colorskill 平台，使用缩略图展示"）。
	 *
	 * 数据来源：`tools/fetch-covers.mjs` 从 Cola Skill 的 `og:image` 抓来写进 `icon`
	 * （131 个商品已回填）。所以这里只认"`icon` 是图片地址"这一种情况 ——
	 * 没有图时**不渲染这个块**（卡片沿用 emoji + 渐变兜底，不留空白 ✗）。
	 *
	 * 懒加载：`loading="lazy"` + `decoding="async"`（一页几十张首屏图，必须懒加载）
	 * 失败兜底：图片挂了就**整块隐藏**（父级渐变底顶上来，不留破图）
	 *
	 * @param {{ pkg: object }} props
	 */
	function PkgCover(props) {
		// ★ 2026-10-24：大图只认 `cover`（`icon` 是小图标语义，两者不互相顶替）
		var raw = String((props.pkg || {}).cover || '').trim();
		var failedState = useState(false);
		if (!isImageIcon(raw) || failedState[0]) { return null; }
		return h('div', { className: 'vs-mp-cover' },
			h('img', {
				src: raw,
				alt: '',
				loading: 'lazy',
				decoding: 'async',
				referrerPolicy: 'no-referrer',
				// ⚠ 失败要**通知父级**：父级据此把布局从"大图"回退成"小图标"，
				//   否则 `hasCover ? null : PkgIcon` 会让卡片顶部**整块空白** ✗
				//   （真机踩到：2 个商品的源图在 CDN 侧就 400，卡片顶部只剩 kindtag）
				onError: function () {
					failedState[1](true);
					if (typeof props.onFail === 'function') { props.onFail(); }
				}
			})
		);
	}

	/**
	 * 卡片的"有没有封面"状态 + 失败回退。
	 *
	 * 为什么要 state：封面 `onError` 之后必须能把布局**切回小图标**，
	 * 否则大图消失、小图标又被跳过 ⇒ 卡片顶部空白 ✗（真机踩到）
	 *
	 * @param {string} icon
	 * @returns {[boolean, () => void]} `[hasCover, onCoverFail]`
	 */
	function useCoverFallback(icon) {
		// 换商品不需要手动重置：`Card` 的 key 是 `kind:slug` ⇒ React 会重建组件、state 自动归位 ✓
		var state = useState(isImageIcon(icon));
		var onFail = useCallback(function () { state[1](false); }, []);
		return [state[0], onFail];
	}

	/**
	 * 卡片尺寸档（★ 2026-10-23 用户："增加 item 大小调整按钮"）。
	 *
	 * 实现方式是给网格一个 CSS 变量 `--vs-mp-card-min`（`minmax()` 的最小宽度）：
	 *   `grid-template-columns: repeat(auto-fill, minmax(var(--vs-mp-card-min), 1fr))`
	 * ⇒ 档位一变，**列数自动重排**（不用写死 3 列 + 媒体查询）✓
	 *
	 * 尺寸挑的是"缩略图还看得清"的区间：小档 260px 一屏能放 5 列，
	 * 大档 520px 一屏 2 列（看截图更清楚）。
	 */
	var SIZES = [
		{ id: 's', label: '小', min: 250 },
		{ id: 'm', label: '中', min: 340 },
		{ id: 'l', label: '大', min: 520 },
	];
	/** 记住上次选择（localStorage；dsh 页面同源，隐私模式下读不到就回落默认）。 */
	var SIZE_KEY = 'vs-mp-card-size';

	/**
	 * 商城商品的上传日期（★ 2026-10-26 用户：「为每个 item 加上上传日期」）。
	 *
	 * 服务端字段是 **`created_at`**（毫秒时间戳、蛇形命名），不是 `createdAt`。
	 * 展示口径：7 天内 ⇒「3 天前」；更早 ⇒ `2026-10-26`。
	 * 解析失败/无值 ⇒ 返回空串（**绝不显示 `Invalid Date`**）。
	 */
	function fmtUploadDate(ms) {
		var n = Number(ms);
		if (!isFinite(n) || n <= 0) { return ''; }
		var d = new Date(n);
		if (isNaN(d.getTime())) { return ''; }
		var diff = Date.now() - n;
		var day = 86400000;
		if (diff >= 0 && diff < day) { return '今天'; }
		if (diff >= day && diff < 7 * day) { return Math.floor(diff / day) + ' 天前'; }
		// 本地时区 YYYY-MM-DD（不用 toISOString —— 那是 UTC，跨时区会差一天）
		var mo = d.getMonth() + 1;
		var dd = d.getDate();
		return d.getFullYear() + '-' + (mo < 10 ? '0' + mo : mo) + '-' + (dd < 10 ? '0' + dd : dd);
	}
	function loadSizeId() {
		try {
			var saved = localStorage.getItem(SIZE_KEY);
			if (saved && SIZES.some(function (s) { return s.id === saved; })) { return saved; }
		} catch { /* 读不到就用默认 */ }
		return 'm';
	}
	function saveSizeId(id) {
		try { localStorage.setItem(SIZE_KEY, id); } catch { /* 存不了也不影响本次 */ }
	}



	/**
	 * 分类页签（顺序 = 界面顺序）。
	 * ★ 2026-10-31：加「知识库」—— 服务端早已支持 knowledge，客户端现在也能打能装
	 *   ⇒ 再藏起来就是"上架了却找不到"。
	 * ★ 2026-11-10：在 Skill 与工作台之间加「MCP」。服务端 kinds 早含 mcp、
	 *   安装链（LOCAL_WRITE_KINDS → 落 <数据根>/mcp → 注册 mcp.json）也齐，
	 *   只是页签把它藏了起来 ⇒ MCP 商品只能在「全部」里翻，且被大量 plugin 挤掉。
	 *   id 必须与服务端 kind 一致（'mcp'），页签筛选靠 `params.kind` 一路传到服务端。
	 */
	var KIND_TABS = [
		{ id: '', label: '全部' },
		{ id: 'agent', label: 'Agent' },
		{ id: 'skill', label: 'Skill' },
		{ id: 'mcp', label: 'MCP' },
		{ id: 'workbench', label: '工作台' },
		{ id: 'knowledge', label: '知识库' },
		{ id: 'plugin', label: '插件' }
	];

	/** 顶层页签。 */
	var MAIN_TABS = [
		{ id: 'installed', label: '已安装' },
		{ id: 'market', label: '发现' },
		{ id: 'favorites', label: '收藏' },
		{ id: 'mine', label: '我的发布' },
		{ id: 'admin', label: '管理' }
	];

	/** 商城动作统一入口（Host 侧自持认证/落盘/打包）。 */
	var readClient = window.MarketplaceState.createReadClient();
	async function action(op, params, options) {
		if (['list', 'detail', 'installed', 'mcpConfig', 'preferencesRead', 'reviewList'].indexOf(op) >= 0) { return readClient.read(op, params, options); }
		readClient.invalidate();
		var res;
		try {
			res = await fetch('/x/marketplace/api/action', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ op: op, params: params || {} }),
				credentials: 'same-origin',
				cache: 'no-store'
			});
		} catch (e) {
			return { ok: false, error: '连不上商城通道：' + String(e && e.message ? e.message : e) };
		}
		var data = null;
		try { data = await res.json(); } catch (e2) { data = null; }
		if (!data) { return { ok: false, error: '商城通道没有回执（HTTP ' + res.status + '）' }; }
		return data;
	}

	// ── 小组件 ────────────────────────────────────────────────────

	/** 消息条（成功/失败都如实显示）。 */
	function MsgBar(props) {
		if (!props.msg) { return null; }
		return h('div', { className: 'vs-mp-msg ' + (props.msg.kind || 'info') },
			h('span', { className: 'vs-mp-msg-text' }, props.msg.text),
			h('button', { className: 'vs-mp-x', onClick: props.onClose, title: '关闭' }, '×')
		);
	}

	/** 页签行。 */
	function Tabs(props) {
		return h('nav', { className: 'vs-mp-tabs' },
			props.items.map(function (it) {
				return h('button', {
					key: it.id,
					className: 'vs-mp-tab' + (props.active === it.id ? ' active' : ''),
					onClick: function () { props.onPick(it.id); }
				}, it.label);
			})
		);
	}

	/** 小圆角 chip 行（类型 / 分类共用）。 */
	function Chips(props) {
		if (!props.items || props.items.length === 0) { return null; }
		return h('nav', { className: 'vs-mp-kinds' + (props.small ? ' vs-mp-cats' : '') },
			props.items.map(function (it) {
				return h('button', {
					key: 'chip-' + it.id,
					className: 'vs-mp-kind' + (props.active === it.id ? ' active' : ''),
					onClick: function () { props.onPick(it.id); }
				}, it.label);
			})
		);
	}

	/** 一张商品卡片。 */
	function Card(props) {
		var pkg = props.pkg;
		var opState = props.operations ? props.operations.get(window.MarketplaceState.itemKey(pkg)) : { pending: false, error: '' };
		var upgradable = pkg.upgradable === true || Boolean(pkg.installedVersion && pkg.version && pkg.installedVersion !== pkg.version && props.upgrades && props.upgrades[pkg.kind + ':' + pkg.slug]);
		// ★ 2026-10-29（用户：「已经安装的 item，状态要更新 安装→已安装」）：
		//   Host 早就在 list/detail 里带了 `installedVersion`（按**磁盘落地物**核对过），
		//   但这里一直没用 ⇒ 装完的卡片仍然显示「安装」按钮（点了会覆盖重装）✗
		var installedVer = typeof pkg.installedVersion === 'string' ? pkg.installedVersion : '';
		var installed = installedVer !== '';
		var statusTag = pkg.status && pkg.status !== 'active'
			? h('span', { className: 'vs-mp-tag warn' }, pkg.status === 'pending_review' ? '待审核' : String(pkg.status))
			: null;
		var distTag = pkg.distributionType && pkg.distributionType !== 'bundle'
			? h('span', { className: 'vs-mp-tag' }, String(pkg.distributionType))
			: null;
		var instTag = installed
			? h('span', { className: 'vs-mp-tag ok' }, '已安装' + (installedVer ? ' v' + installedVer : ''))
			: null;
		var upTag = upgradable
			? h('span', { className: 'vs-mp-tag warn' }, '可升级 → v' + String(pkg.latestVersion || ''))
			: null;
		// ★ 2026-11-09：Bot 组合包的组件摘要。
		//   bot.json → 发布端写进 manifest.bot → shape.js 透传到列表 pkg.bot；
		//   详情页还能从 versions[].manifest.bot 取。只存 manifest 不渲染 ⇒ 用户看不出这个包带什么。
		function botSummaryText(p) {
			var b = null;
			if (p && p.bot) { b = p.bot; }
			else if (p && p.manifest && p.manifest.bot) { b = p.manifest.bot; }
			else if (p && Array.isArray(p.versions) && p.versions[0] && p.versions[0].manifest) {
				b = p.versions[0].manifest.bot;
			}
			if (!b || typeof b !== 'object') { return null; }
			var parts = [];
			if (b.skills) { parts.push('技能 ' + b.skills); }
			if (b.tools) { parts.push('工具 ' + b.tools); }
			if (b.mcpServers) { parts.push('MCP ' + b.mcpServers); }
			return parts.length ? '组件摘要：含 ' + parts.join(' · ') : null;
		}
		var botLine = botSummaryText(pkg);

		var actions = [
			h('button', { key: 'd', className: 'vs-mp-btn', onClick: function () { props.onDetail(pkg.slug, pkg.kind); } }, '详情')
		];
		if (upgradable) {
			actions.push(h('button', { key: 'u', className: 'vs-mp-btn primary', onClick: function () { props.onUpgrade(pkg); } }, '升级'));
		} else if (installed) {
			// 已装且没有新版本 ⇒ 按钮就地变成「已安装」（禁用：避免误点成覆盖重装）
			actions.push(h('button', {
				key: 'i',
				className: 'vs-mp-btn',
				disabled: true,
				title: '已安装' + (installedVer ? ' v' + installedVer : '') + '；要重装请先在「已安装」页签卸载'
			}, '已安装'));
		} else {
			// ★ 2026-11-10：安装按钮**只由「是否已安装」决定**。
			//   原先拿服务端的"发布权限"做门控 ⇒ 普通用户浏览别人的包一律被判无权
			//   ⇒ 所有类别的卡片都看不到「安装」按钮 ✗
			//   安装面向所有登录用户；能否安装由 Host/服务端裁决，失败在消息条如实显示。
			actions.push(h('button', { key: 'i', className: 'vs-mp-btn primary', disabled: pkg.installable === false, title: pkg.installable === false ? '商城未提供可安装包体或分发来源' : '安装前检查', onClick: function () { props.onInstall(pkg); } }, '安装'));
		}
		if (props.showUninstall) {
			actions.push(h('button', { key: 'x', className: 'vs-mp-btn danger', onClick: function () { props.onUninstall(pkg); } }, '卸载'));
		}
		// 管理页签：审核三件套（服务端判权）
		if (props.adminActions) {
			actions.push(h('button', { key: 'ok', className: 'vs-mp-btn primary', onClick: function () { props.onReview(pkg, 'active'); } }, '通过'));
			actions.push(h('button', { key: 'no', className: 'vs-mp-btn danger', onClick: function () { props.onReview(pkg, 'removed'); } }, '拒绝下架'));
			actions.push(h('button', {
				key: 'fe',
				className: 'vs-mp-btn',
				onClick: function () { props.onFeature(pkg); }
			}, pkg.featured ? '取消推荐' : '设为推荐'));
		}

		// ★ 2026-10-23：有缩略图 ⇒ 顶部大图 + 不再显示小图标（重复且占位）；
		//   没缩略图 ⇒ 沿用「小图标 + 渐变」的紧凑布局 ✓
		//   ⚠ 用 state 而不是直接判断：封面**加载失败时**要能回退到小图标布局
		//     （否则大图没了、小图标又被 `hasCover ? null` 跳过 ⇒ 顶部空白 ✗）
		var coverState = useCoverFallback(pkg.cover);
		var hasCover = coverState[0];
		if (props.onFavorite && !pkg.isLocal) { actions.unshift(h('button', { key: 'fav', className: 'vs-mp-btn vs-mp-favorite', disabled: props.savingPreferences, 'aria-pressed': props.favorite, 'aria-label': props.favorite ? '取消收藏 ' + pkg.name : '收藏 ' + pkg.name, onClick: function () { props.onFavorite(pkg); }, title: props.favorite ? '取消收藏' : '收藏到当前分组' }, h(window.MarketplaceUI.Icon, { name: 'star' }))); }
		actions = actions.map(function (element) { return React.cloneElement(element, { disabled: Boolean(element.props.disabled || opState.pending), 'aria-busy': opState.pending || undefined }); });
		return h('div', { className: 'vs-mp-card' + (hasCover ? ' has-cover' : ''), 'data-slug': pkg.slug },
			h(PkgCover, { key: 'cover', pkg: pkg, onFail: coverState[1] }),
			h('div', { className: 'vs-mp-card-top' },
				h(PkgIcon, { key: 'icon', pkg: pkg }),
				h('div', { className: 'vs-mp-card-topbody' },
					h('div', { className: 'vs-mp-card-head' },
						h('span', { className: 'vs-mp-kindtag' }, KIND_LABEL[pkg.kind] || String(pkg.kind)),
						statusTag, distTag, instTag, upTag
					),
					h('button', { className: 'vs-mp-card-title vs-mp-title-btn', onClick: function () { props.onDetail(pkg.slug, pkg.kind); }, title: textOf(pkg.name) || pkg.slug }, textOf(pkg.name) || textOf(pkg.slug))
				)
			),
			h('div', { className: 'vs-mp-card-meta' },
				textOf(pkg.author) || '暂无',
				pkg.version ? ' · v' + String(pkg.version) : '',
				// ★ 2026-10-26：上传日期（字段名是蛇形 `created_at`）
				fmtUploadDate(pkg.created_at) ? ' · ' + fmtUploadDate(pkg.created_at) : ''
			),
			h('div', { className: 'vs-mp-card-desc' },
				textOf(pkg.description) || '这个商品暂时还没有填写介绍。'
			),
			botLine ? h('div', { className: 'vs-mp-card-bot', 'data-mp-bot-summary': '1' }, botLine) : null,
			h('small', { className: 'vs-mp-preferences-status' }, Number.isFinite(pkg.downloads) ? pkg.downloads.toLocaleString() + ' 次下载' : '下载数未提供'),
			opState.pending ? h('p', { role: 'status' }, '操作进行中…') : null,
			opState.error ? h('p', { role: 'alert', className: 'vs-mp-error' }, opState.error) : null,
			h('div', { className: 'vs-mp-card-actions' }, actions)
		);
	}

	function Drawer(props) { return h(window.MarketplaceUI.Drawer, props, props.children); }

	var SAFE_MODE_KEY = 'vs-mp-safe-mode-backup';

	/** 安装前预览抽屉（★ 2026-11-10 P0）：两步确认的第一步，只读不落盘。 */
	function PreviewDrawer(props) {
		var p = props.preview;
		var warns = Array.isArray(p.warnings) ? p.warnings : [];
		var danger = warns.filter(function (w) { return w.level === 'danger'; });
		var fields = (p.distribution && Array.isArray(p.distribution.fields)) ? p.distribution.fields : [];
		var files = Array.isArray(p.files) ? p.files : [];
		return h(Drawer, {
			title: (p.upgrade ? '升级前检查 · ' : '安装前检查 · ') + (textOf(p.name) || p.slug),
			subtitle: [KIND_LABEL[p.kind] || p.kind, 'v' + String(p.version || ''), p.distribution ? p.distribution.label : '']
				.filter(Boolean).join(' · '),
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-prev-meta' },
				h('div', null, '完整性：' + (p.sha256 ? 'sha256 ' + String(p.sha256).slice(0, 16) + '…' : '服务端未登记 sha256（安装时按包内容校验）')),
				fields.map(function (f) {
					return h('div', { key: 'f-' + f.k }, String(f.k) + '：' + String(f.v));
				}),
				p.filesNote ? h('div', { className: 'vs-mp-prev-note' }, String(p.filesNote)) : null
			),
			p.blocked
				? h('div', { className: 'vs-mp-prev-blocked' },
					'已阻止安装：发现 ' + danger.length + ' 项高危内容。请让作者修正后重新发版。')
				: null,
			warns.length
				? h('div', { className: 'vs-mp-prev-warns' },
					h('h4', null, '风险提示（' + warns.length + '）'),
					h('ul', null, warns.map(function (w, i) {
						return h('li', { key: 'w-' + i, className: w.level === 'danger' ? 'danger' : '' },
							(w.level === 'danger' ? '⛔ ' : '⚠ ') + String(w.text) + (w.file ? '（' + String(w.file) + '）' : ''));
					}))
				)
				: h('div', { className: 'vs-mp-prev-ok' }, '✓ 未发现密钥、绝对路径或未锁定的来源'),
			files.length
				? h('div', { className: 'vs-mp-prev-files' },
					h('h4', null, '包内文件（' + files.length + (files.length >= 200 ? '+' : '') + '，扫描文本 ' + (p.scanned || 0) + ' 个）'),
					h('ul', null, files.slice(0, 12).map(function (f) {
						return h('li', { key: 'p-' + f.path }, String(f.path) + ' · ' + Math.round(Number(f.size || 0) / 1024) + ' KB');
					})),
					files.length > 12 ? h('div', { className: 'vs-mp-prev-note' }, '…其余 ' + (files.length - 12) + ' 个文件略') : null
				)
				: null,
			h('div', { className: 'vs-mp-drawer-actions' },
				h('button', { className: 'vs-mp-btn', onClick: props.onClose }, '取消'),
				h('button', {
					className: 'vs-mp-btn primary',
					disabled: !!p.blocked,
					title: p.blocked ? '存在高危内容，已阻止安装' : '',
					onClick: props.onConfirm
				}, p.upgrade ? '确认升级' : '确认安装')
			)
		);
	}

	/** 安全模式抽屉（★ 2026-11-10 P0）：非破坏式停用第三方插件 + 按记录恢复。 */
	function SafeModeDrawer(props) {
		var s = props.state;
		var plugins = Array.isArray(s.plugins) ? s.plugins : [];
		var on = plugins.filter(function (p) { return p.enabled; }).length;
		return h(Drawer, {
			title: '安全模式',
			subtitle: '运行时停用第三方插件，不删除任何数据',
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-prev-note' },
				'这是「运行时批量停用」，不等价官方 dsh-desktop 的启动期隔离 Profile：已加载的代码要重启 Host 才真正卸载。内置插件与本页所在插件不会被停用。'),
			s.error ? h('div', { className: 'vs-mp-msg error' }, String(s.error)) : null,
			plugins.length
				? h('ul', { className: 'vs-mp-safe-list' }, plugins.map(function (p) {
					return h('li', { key: 's-' + p.name },
						h('span', null, String(p.name) + (p.fromMarket ? ' · 商城安装' : '') + (p.version ? ' · v' + p.version : '')),
						h('span', { className: p.enabled ? 'on' : 'off' }, p.enabled ? '启用' : '已停用')
					);
				}))
				: h('div', { className: 'vs-mp-empty small' }, '没有可停用的第三方插件。'),
			h('div', { className: 'vs-mp-drawer-actions' },
				h('button', { className: 'vs-mp-btn', disabled: !!s.busy || on === 0, onClick: props.onEnter },
					s.busy ? '处理中…' : '停用 ' + on + ' 个第三方插件'),
				h('button', { className: 'vs-mp-btn', disabled: !!s.busy || !s.hasBackup, onClick: props.onRestore }, '按记录恢复'),
				h('button', { className: 'vs-mp-btn primary', onClick: props.onClose }, '关闭')
			),
			s.note ? h('div', { className: 'vs-mp-prev-ok' }, String(s.note)) : null
		);
	}

	/** ★ 2026-11-23：升级备份 / 回滚抽屉（投影真源在 Host 侧 upgradeBackup.js）。 */
	function RollbackDrawer(props) {
		var s = props.state || {};
		var data = window.MarketplaceState.groupRollbackPoints(s.items);
		return h(Drawer, {
			title: '可回滚版本',
			subtitle: '升级前的旧版本备份（恢复时当前版本会先留档）',
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-prev-note' },
				'这里列的是 .upgrade-backup 里的备份点；恢复不会删除备份，可重复回滚。恢复内容可能需要刷新页面或重启 Host 才完全生效。'),
			s.error ? h('div', { className: 'vs-mp-msg error' }, String(s.error)) : null,
			data.groups.length
				? h('ul', { className: 'vs-mp-safe-list' }, data.groups.map(function (g) {
					return h('li', { key: 'rb-' + g.key },
						h('span', null, String(g.id) + (g.kind ? ' · ' + g.kind : '') + ' · ' + g.points.length + ' 个备份点 · 最近 ' + String(g.latest.ts)),
						h('button', {
							className: 'vs-mp-btn', disabled: !!s.busy,
							onClick: function () { props.onRestore(g.key, g.latest.ts); }
						}, s.busy ? '处理中…' : '恢复最近版本')
					);
				}))
				: h('div', { className: 'vs-mp-empty small' }, '暂无可回滚版本（升级过的商品才会出现在这里）。'),
			s.note ? h('div', { className: 'vs-mp-prev-ok' }, String(s.note)) : null,
			h('div', { className: 'vs-mp-drawer-actions' },
				h('button', { className: 'vs-mp-btn primary', onClick: props.onClose }, '关闭'))
		);
	}

	/** 把 base64 包体落成浏览器下载（JSON 通道内完成，不新增 Host 路由）。 */
	function downloadPortable(base64, filename) {
		var bin = atob(String(base64 || ''));
		var arr = new Uint8Array(bin.length);
		for (var i = 0; i < bin.length; i++) { arr[i] = bin.charCodeAt(i); }
		var url = URL.createObjectURL(new Blob([arr], { type: 'application/gzip' }));
		var a = document.createElement('a');
		a.href = url; a.download = filename;
		document.body.appendChild(a); a.click(); document.body.removeChild(a);
		setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
	}

	/** 离线便携包抽屉（★ 2026-11-10 P2）：勾选导出 + 两步导入（预览 → 确认）。 */
	function PortableDrawer(props) {
		var s = props.state;
		var installedItems = Array.isArray(s.items) ? s.items : [];
		var selected = s.selected || {};
		var renames = s.renames || {};
		var pv = s.preview;
		var keyOf = function (it) { return it.kind + ':' + String(it.storeId || it.slug || it.id || ''); };
		var count = installedItems.filter(function (it) { return !!selected[keyOf(it)]; }).length;
		var conflicts = (pv && Array.isArray(pv.conflicts)) ? pv.conflicts : [];
		return h(Drawer, {
			title: '便携包',
			subtitle: '导出本机资源到文件，或从文件导入到本机（不经商城服务端）',
			onClose: props.onClose
		},
			h('h4', { className: 'vs-mp-portable-h' }, '导出（勾选已安装的资源）'),
			installedItems.length
				? h('div', { className: 'vs-mp-portable-list' }, installedItems.map(function (it) {
					return h('label', { key: keyOf(it), className: 'vs-mp-portable-row' },
						h('input', { type: 'checkbox', checked: !!selected[keyOf(it)], onChange: function () { props.onToggle(keyOf(it)); } }),
						h('span', null, (KIND_LABEL[it.kind] || it.kind) + ' · ' + textOf(it.name || it.storeId || it.slug || it.id)
							+ (it.version ? ' · v' + String(it.version) : ''))
					);
				}))
				: h('div', { className: 'vs-mp-prev-note' }, '本机没有可导出的资源。'),
			h('button', { className: 'vs-mp-btn', disabled: !!s.busy || count === 0, onClick: props.onExport }, '导出选中（' + count + '）'),
			h('h4', { className: 'vs-mp-portable-h' }, '导入（先预览，确认后才落盘）'),
			h('input', { type: 'file', accept: '.sarospack,application/gzip', className: 'vs-mp-input', onChange: props.onPick }),
			pv ? h('div', { className: 'vs-mp-prev-meta' },
				h('div', null, '来源：' + (pv.exportedAt || '未知') + ' · ' + pv.items.length + ' 个资源 · ' + Math.round(pv.bytes / 1024) + ' KB'),
				pv.items.map(function (it) {
					return h('div', { key: 'pi-' + it.kind + '-' + it.id },
						(KIND_LABEL[it.kind] || it.kind) + ' · ' + it.id + ' · ' + it.files + ' 文件' + (it.exists ? ' · 本机已存在' : ''));
				})
			) : null,
			conflicts.length ? h('div', { className: 'vs-mp-prev-warns' },
				h('h4', null, '命名冲突（' + conflicts.length + '）—— 填新名字才能导入，不覆盖本机资源'),
				conflicts.map(function (key) {
					return h('label', { key: 'rn-' + key, className: 'vs-mp-field' },
						h('span', { className: 'vs-mp-field-label' }, key + ' 改为'),
						h('input', {
							className: 'vs-mp-input', value: String(renames[key] || ''), placeholder: '新的 id',
							onChange: function (e) { props.onRename(key, e.target.value); }
						})
					);
				})
			) : null,
			pv ? h('button', { className: 'vs-mp-btn primary', disabled: !!s.busy, onClick: props.onImport }, '确认导入') : null,
			s.error ? h('div', { className: 'vs-mp-msg error' }, String(s.error)) : null,
			s.note ? h('div', { className: 'vs-mp-prev-ok' }, String(s.note)) : null,
			h('div', { className: 'vs-mp-drawer-actions' },
				h('button', { className: 'vs-mp-btn', onClick: props.onClose }, '关闭')
			)
		);
	}

	/** ★ 2026-11-10：MCP 配置弹层 —— 单独一页展示/编辑整份 mcp.json（所有服务器）。 */
	function McpConfigModal(props) {
		var s = props.state;
		var servers = Array.isArray(s.servers) ? s.servers : [];
		return h('div', { className: 'vs-mp-mcp-modal', onClick: props.onClose },
			h('div', { className: 'vs-mp-mcp-box', role: 'dialog', 'aria-label': 'MCP 配置',
				onClick: function (e) { e.stopPropagation(); } },
				h('div', { className: 'vs-mp-mcp-head' },
					h('div', null,
						h('div', { className: 'vs-mp-mcp-title' }, 'MCP 配置'),
						h('div', { className: 'vs-mp-mcp-path' }, '文件 ' + textOf(s.path) + ' · ' + servers.length + ' 个服务器')
					),
					h('button', { className: 'vs-mp-x', title: '关闭', onClick: props.onClose }, '×')
				),
				servers.length ? h('div', { className: 'vs-mp-mcp-summary' },
					servers.map(function (x) {
						return h('span', { key: x.id, className: 'vs-mp-mcp-chip' + (x.disabled ? ' off' : '') },
							x.id + (x.type ? ' · ' + x.type : '') + (x.disabled ? ' · 已停用' : ''));
					})
				) : h('div', { className: 'vs-mp-prev-note' }, 'mcp.json 里还没有服务器。'),
				h('textarea', {
					className: 'vs-mp-mcp-ta', spellCheck: false, autoComplete: 'off', value: s.draft,
					'data-vs-mp-mcp-text': '1',
					onChange: function (e) { props.onDraft(e.target.value); }
				}),
				s.error ? h('div', { className: 'vs-mp-msg error' }, String(s.error)) : null,
				h('div', { className: 'vs-mp-mcp-foot' },
					h('span', { className: 'vs-mp-mcp-hint' }, '保存前自动备份；保存后下方「已安装」的 MCP 状态会即时同步。'),
					h('button', { className: 'vs-mp-btn', onClick: props.onClose }, '关闭'),
					h('button', { className: 'vs-mp-btn primary', disabled: !!s.busy, onClick: props.onSave },
						s.busy ? '保存中…' : '保存')
				)
			)
		);
	}

	/** 字段行（label + 控件）。 */
	function Field(props) {
		return h('label', { className: 'vs-mp-field' },
			h('span', { className: 'vs-mp-field-label' }, props.label),
			props.children
		);
	}

	// ── 详情抽屉 ──────────────────────────────────────────────────

	function DetailDrawer(props) {
		var d = props.detail;
		var perm = d.permissions || {};
		var versions = Array.isArray(d.versions) ? d.versions : [];
		// ★ 2026-10-29：详情抽屉与卡片同一口径（都来自 Host 的磁盘核对结果）
		var installedVer = typeof d.installedVersion === 'string' ? d.installedVersion : '';
		var installed = installedVer !== '';

		var actions = [];
		if (d.isLocal) {
			// ★ 2026-11-10：本地新建资源在商城里没有商品 ⇒ 安装/卸载/下架都无意义，
			//   只给一个直达发布的入口。不按发布权限判权，失败由消息条如实显示。
			actions.push(h('button', { key: 'pub', className: 'vs-mp-btn primary', onClick: props.onPublish }, '发布到商城'));
		} else if (installed && d.upgradable) {
			actions.push(h('button', { key: 'up', className: 'vs-mp-btn primary', onClick: props.onUpgrade }, '升级'));
		} else if (installed) {
			actions.push(h('button', {
				key: 'i',
				className: 'vs-mp-btn',
				disabled: true,
				title: '已安装' + (installedVer ? ' v' + installedVer : '') + '；要重装请先在「已安装」页签卸载'
			}, '已安装'));
		} else {
			// ★ 2026-11-10：与卡片同一口径 —— 详情里的「安装」也不受发布权限门控。
			//   编辑 / 卸载 / 下架仍按服务端 permissions 判权（下面三行不动）。
			actions.push(h('button', { key: 'i', className: 'vs-mp-btn primary', disabled: d.installable === false, onClick: props.onInstall }, '安装'));
		}
		if (!d.isLocal && props.onFavorite) { actions.push(h('button', { key: 'fav', className: 'vs-mp-btn', disabled: props.savingPreferences, onClick: function () { props.onFavorite(d); }, 'aria-pressed': props.favorite }, props.favorite ? '取消收藏' : '收藏')); }
		if (!d.isLocal && perm.canEdit === true) {
			actions.push(h('button', { key: 'e', className: 'vs-mp-btn', onClick: props.onEdit }, '编辑信息'));
		}
		if (!d.isLocal && installed) { actions.push(h('button', { key: 'u', className: 'vs-mp-btn danger', onClick: props.onUninstall }, '卸载')); }
		if (!d.isLocal && perm.canDelete === true) {
			actions.push(h('button', { key: 'd', className: 'vs-mp-btn danger', onClick: props.onDeletePackage }, '下架整个包'));
		}
		var opState = props.operations.get(window.MarketplaceState.itemKey(d));
		actions = actions.map(function (element) { return React.cloneElement(element, { disabled: Boolean(element.props.disabled || opState.pending) }); });
		return h(Drawer, {
			wide: true,
			icon: h(PkgIcon, { key: 'icon', pkg: d, large: true }),
			title: textOf(d.name) || textOf(d.slug),
			subtitle: [KIND_LABEL[d.kind] || String(d.kind || ''), textOf(d.author) || '暂无', d.version ? 'v' + String(d.version) : '']
				.filter(Boolean).join(' · '),
			onClose: props.onClose
		},
			// 详情里放一张较大的缩略图（与 colorskill 的商品页一致）
			h(PkgCover, { key: 'cover', pkg: d }),
			h('div', { className: 'vs-mp-tagrow' },
				d.isLocal ? h('span', { className: 'vs-mp-tag warn' }, '本机新建 · 未上架') : null,
				d.isLocal && d.sourceDir ? h('span', { className: 'vs-mp-tag' }, '目录 ' + String(d.sourceDir)) : null,
				installed ? h('span', { className: 'vs-mp-tag ok' }, '已安装' + (installedVer ? ' v' + installedVer : '')) : null,
				d.visibility === 'private' ? h('span', { className: 'vs-mp-tag' }, '私有') : null,
				d.featured ? h('span', { className: 'vs-mp-tag ok' }, '推荐') : null,
				d.category ? h('span', { className: 'vs-mp-tag' }, textOf(d.category)) : null
			),
			h('div', { className: 'vs-mp-drawer-desc' }, textOf(d.description) || '这个商品暂时还没有填写介绍。'),
			h('div', { className: 'vs-mp-drawer-actions' }, actions),
			h('div', { className: 'vs-mp-drawer-versions' },
				h('h4', null, '版本'),
				versions.length === 0
					? h('div', { className: 'vs-mp-empty small' }, '还没有发布版本')
					: h('ul', null, versions.map(function (v) {
						return h('li', { key: 'v-' + v.version },
							h('div', { className: 'vs-mp-ver-head' },
								h('span', { className: 'vs-mp-ver-num' }, String(v.version)),
								v.isLatest ? h('span', { className: 'vs-mp-tag ok' }, '最新') : null,
								v.size ? h('span', { className: 'vs-mp-ver-size' }, Math.round(Number(v.size) / 1024) + ' KB') : null
							),
							v.changelog ? h('div', { className: 'vs-mp-ver-note' }, String(v.changelog)) : null,
							perm.canDelete === true
								? h('button', { className: 'vs-mp-link', onClick: function () { props.onDeleteVersion(v.version); } }, '下架此版本')
								: null
						);
					}))
			)
		);
	}

	// ── 发布 / 编辑表单 ────────────────────────────────────────────

	function PublishDrawer(props) {
		var st = props.state;
		var github = st.mode === 'github';
		var pluginPackage = st.mode === 'package';
		var pickOptions = st.items.length === 0
			? [h('option', { key: 'none', value: '' }, '（本机没有可发布的资源）')]
			: st.items.map(function (it) {
				var value = it.kind + '|' + it.localId;
				var label = (KIND_LABEL[it.kind] || it.kind) + ' · ' + it.localId + (it.version ? ' (v' + it.version + ')' : '');
				return h('option', { key: value, value: value }, label);
			});
		var kindOptions = ['skill', 'agent', 'mcp', 'workbench', 'knowledge'].map(function (k) {
			return h('option', { key: k, value: k }, KIND_LABEL[k] || k);
		});

		return h(Drawer, {
			title: '发布到商城',
			subtitle: github
				? '本体就是一个 GitHub 地址 —— 只登记来源，不打包上传（安装时从 GitHub 取）'
				: '从本机已装资源打包上传（skill / agent 由 dsh 侧打包）',
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-form' },
				// ★ 2026-10-22（用户需求）：来源二选一 —— 打包上传 / GitHub 地址
				h('div', { className: 'vs-mp-srcseg' },
					h('button', {
						className: 'vs-mp-btn' + (!github && !pluginPackage ? ' primary' : ''),
						onClick: function () { props.onChange({ mode: 'local', error: '' }); }
					}, '从本机打包'),
					h('button', {
						className: 'vs-mp-btn' + (github ? ' primary' : ''),
						onClick: function () { props.onChange({ mode: 'github', error: '' }); }
					}, 'GitHub 地址'),
					h('button', { className: 'vs-mp-btn' + (pluginPackage ? ' primary' : ''),
						onClick: function () { props.onChange({ mode: 'package', kind: 'workbench', error: '' }); }
					}, '上传插件包')
				),
				pluginPackage ? [
					h(Field, { key: 'package-kind', label: '插件类型' },
						h('select', { className: 'vs-mp-input', value: st.kind || 'workbench', disabled: st.busy,
							onChange: function (e) { props.onChange({ kind: e.target.value, error: '' }); } },
							h('option', { value: 'workbench' }, '工作台插件（页面必需）'),
							h('option', { value: 'agent' }, 'Bot 插件（无需页面）'))),
					h(Field, { key: 'package-file', label: '标准插件 .tgz（最大 8 MiB；技能、工具、MCP 可选）' },
						h('input', { className: 'vs-mp-input', type: 'file', accept: '.tgz,.tar.gz', disabled: st.busy,
							onChange: function (e) {
								var file = e.target.files && e.target.files[0];
								if (!file) { props.onChange({ pluginBase64: '' }); return; }
								if (file.size > 8 * 1024 * 1024) { props.onChange({ pluginBase64: '', error: '插件包超过 8 MiB' }); return; }
								var reader = new FileReader();
								reader.onload = function () { props.onChange({ pluginBase64: String(reader.result).split(',')[1], packageFile: file.name }); };
								reader.onerror = function () { props.onChange({ pluginBase64: '', error: '读取插件包失败' }); };
								reader.readAsDataURL(file);
							}
						})),
					h(Field, { key: 'package-slug', label: '商城标识（与插件包名分开，小写字母/数字/-/_）' },
						h('input', { className: 'vs-mp-input', value: st.slug || '', onChange: function (e) { props.onChange({ slug: e.target.value }); } })),
					h('div', { key: 'package-hint', className: 'vs-mp-msg' }, '上传前会校验包内入口与资源清单；不上传个人凭据。其他用户安装后使用自己的配置。')
				] : github ? [
					h(Field, { key: 'k', label: '类型' },
						h('select', {
							className: 'vs-mp-input',
							value: st.kind,
							onChange: function (e) { props.onChange({ kind: e.target.value }); }
						}, kindOptions)
					),
					h(Field, { key: 's', label: '标识（商城里的唯一 id，小写字母开头，可含 -_）' },
						h('input', {
							className: 'vs-mp-input',
							placeholder: 'my-skill',
							value: st.slug,
							onChange: function (e) { props.onChange({ slug: e.target.value }); }
						})
					),
					h(Field, { key: 'src', label: 'GitHub 地址（owner/repo 或 https://github.com/...）' },
						// ★ 2026-10-27（用户：贴链接自动填写并发布）：填完点一下就把
						//   名称/描述/版本/图标/类型 都从 GitHub 抓回来回填 ✓
						h('div', { className: 'vs-mp-inspect-row' },
							h('input', {
								className: 'vs-mp-input',
								placeholder: 'owner/repo 或 https://github.com/owner/repo/tree/main',
								value: st.source,
								onChange: function (e) { props.onChange({ source: e.target.value }); },
								// 回车也触发识别（少点一次鼠标）
								onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); props.onInspect && props.onInspect(); } },
							}),
							h('button', {
								className: 'vs-mp-btn',
								type: 'button',
								disabled: st.busy,
								title: '从 GitHub 自动识别名称 / 介绍 / 版本 / 图标 / 类型并填写',
								onClick: function () { props.onInspect && props.onInspect(); },
							}, st.busy ? '识别中…' : '✨ 自动填写')
						)
					),
					h(Field, { key: 'n', label: '名称（可空，默认用标识）' },
						h('input', {
							className: 'vs-mp-input',
							value: st.name,
							onChange: function (e) { props.onChange({ name: e.target.value }); }
						})
					),
					h(Field, { key: 'd', label: '介绍（可空）' },
						h('textarea', {
							className: 'vs-mp-input',
							rows: 2,
							value: st.description,
							onChange: function (e) { props.onChange({ description: e.target.value }); }
						})
					)
				] : h(Field, { label: '资源' },
					h('select', {
						className: 'vs-mp-input',
						value: st.pick,
						onChange: function (e) { props.onChange({ pick: e.target.value }); }
					}, pickOptions)
				),
				// ★ 2026-11-10：图标 / 缩略图设置（两种来源模式通用；留空走自动兜底）
				h(Field, { label: '小图标 URL（可空；留空由商城取仓库 owner 头像）' },
					h('input', {
						className: 'vs-mp-input',
						placeholder: 'https://…/icon.png',
						value: st.icon || '',
						onChange: function (e) { props.onChange({ icon: e.target.value }); }
					})
				),
				h(Field, { label: '缩略图 URL（16:9 大图；可空，留空只显示小图标）' },
					h('input', {
						className: 'vs-mp-input',
						placeholder: 'https://…/cover.png',
						value: st.cover || '',
						onChange: function (e) { props.onChange({ cover: e.target.value }); }
					})
				),
				h(Field, { label: '版本（语义化版本，如 1.0.0）' },
					h('input', {
						className: 'vs-mp-input',
						placeholder: '1.0.0',
						value: st.version,
						onChange: function (e) { props.onChange({ version: e.target.value }); }
					})
				),
				h(Field, { label: '更新说明（可空）' },
					h('textarea', {
						className: 'vs-mp-input',
						rows: 3,
						placeholder: '这次改了什么',
						value: st.changelog,
						onChange: function (e) { props.onChange({ changelog: e.target.value }); }
					})
				),
				st.error ? h('div', { className: 'vs-mp-msg error' }, st.error) : null,
				// ★ 识别结果（版本从哪来、有没有需要手改的地方）—— 成功也要看得见，
				//   否则用户不知道"自动填写"到底填了什么 ✗
				st.inspectNote ? h('div', { className: 'vs-mp-msg' }, st.inspectNote) : null,
				st.privacyBlock ? h('div', { className: 'vs-mp-msg' }, '上面的内容命中隐私体检；确认可以公开后点「确认公开并发布」重发。') : null,
				h('div', { className: 'vs-mp-drawer-actions' },
					st.privacyBlock
						? h('button', { className: 'vs-mp-btn danger', disabled: st.busy, onClick: props.onForcePublish }, '确认公开并发布')
						: h('button', { className: 'vs-mp-btn primary', disabled: st.busy, onClick: props.onSubmit }, st.busy ? '发布中…' : '发布'),
					h('button', { className: 'vs-mp-btn', onClick: props.onClose }, '取消')
				)
			)
		);
	}

	function EditDrawer(props) {
		var st = props.state;
		return h(Drawer, {
			title: '编辑「' + st.slug + '」的信息',
			subtitle: '类型与标识不可改；版本请用「发布」',
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-form' },
				h(Field, { label: '名称' },
					h('input', {
						className: 'vs-mp-input',
						value: st.name,
						onChange: function (e) { props.onChange({ name: e.target.value }); }
					})
				),
				h(Field, { label: '介绍' },
					h('textarea', {
						className: 'vs-mp-input',
						rows: 3,
						value: st.description,
						onChange: function (e) { props.onChange({ description: e.target.value }); }
					})
				),
				h(Field, { label: '分类' },
					h('input', {
						className: 'vs-mp-input',
						value: st.category,
						onChange: function (e) { props.onChange({ category: e.target.value }); }
					})
				),
				h(Field, { label: '图标（emoji）' },
					h('input', {
						className: 'vs-mp-input',
						value: st.icon,
						onChange: function (e) { props.onChange({ icon: e.target.value }); }
					})
				),
				h(Field, { label: '可见性' },
					h('select', {
						className: 'vs-mp-input',
						value: st.visibility,
						onChange: function (e) { props.onChange({ visibility: e.target.value }); }
					},
						h('option', { value: 'public' }, '公开'),
						h('option', { value: 'private' }, '私有（仅自己可见）')
					)
				),
				st.error ? h('div', { className: 'vs-mp-msg error' }, st.error) : null,
				h('div', { className: 'vs-mp-drawer-actions' },
					h('button', { className: 'vs-mp-btn primary', disabled: st.busy, onClick: props.onSubmit }, st.busy ? '保存中…' : '保存'),
					h('button', { className: 'vs-mp-btn', onClick: props.onClose }, '取消')
				)
			)
		);
	}

	// ── 主界面 ────────────────────────────────────────────────────

	function App() {
		var _tab = useState('market'); var tab = _tab[0]; var setTab = _tab[1];
		var _kind = useState(''); var kind = _kind[0]; var setKind = _kind[1];
		var _cat = useState(''); var category = _cat[0]; var setCategory = _cat[1];
		var _sort = useState('recent'); var sort = _sort[0]; var setSort = _sort[1];
		var _qInput = useState(''); var qInput = _qInput[0]; var setQInput = _qInput[1];
		var _q = useState(''); var q = _q[0]; var setQ = _q[1];

		var _items = useState([]); var items = _items[0]; var setItems = _items[1];
		var _total = useState(0); var total = _total[0]; var setTotal = _total[1];
		var _cats = useState([]); var cats = _cats[0]; var setCats = _cats[1];
		var _busy = useState(false); var busy = _busy[0]; var setBusy = _busy[1];
		// 卡片尺寸（★ 2026-10-23 用户要求）：惰性初始化读 localStorage，改了就存
		var _size = useState(loadSizeId); var sizeId = _size[0];
		var setSizeId = function (id) { _size[1](id); saveSizeId(id); };
		var sizeMin = (SIZES.filter(function (s) { return s.id === sizeId; })[0] || SIZES[1]).min;
		var _msg = useState(null); var msg = _msg[0]; var setMsg = _msg[1];

		var _detail = useState(null); var detail = _detail[0]; var setDetail = _detail[1];
		var _pub = useState(null); var pub = _pub[0]; var setPub = _pub[1];
		var _edit = useState(null); var edit = _edit[0]; var setEdit = _edit[1];
		// ★ 2026-11-10 P0：安装预览与安全模式
		var _preview = useState(null); var preview = _preview[0]; var setPreview = _preview[1];
		var _safeMode = useState(null); var safeMode = _safeMode[0]; var setSafeMode = _safeMode[1];
		// ★ 2026-11-23：升级备份 / 可回滚版本抽屉
		var _rollback = useState(null); var rollback = _rollback[0]; var setRollback = _rollback[1];
		// ★ 2026-11-10 P2：离线便携包
		var _portable = useState(null); var portable = _portable[0]; var setPortable = _portable[1];
		// ★ 2026-11-10：商城页签下的「已安装」折叠组数据（与商品列表分开取）
		var _instItems = useState([]); var installedItems = _instItems[0]; var setInstalledItems = _instItems[1];
		// ★ 2026-11-10：MCP 实时状态（mcp.json 的 servers）+ 配置弹层
		var _mcpState = useState(null); var mcpState = _mcpState[0]; var setMcpState = _mcpState[1];
		var _mcpModal = useState(null); var mcpModal = _mcpModal[0]; var setMcpModal = _mcpModal[1];
		var mcpDigestRef = useRef('');

		var pageRef = useRef(1);
		var currentFetch = useRef(null), currentRankingFetch = useRef(null);
		var gates = useRef(window.MarketplaceState.createGate()).current;
		var operations = useRef(window.MarketplaceState.createOperations()).current;
		var operationTick = useState(0);
		var _prefs = useState({ revision: 0, skin: 'native', groups: [{ id: 'default', name: '默认收藏', items: [] }] });
		var preferences = _prefs[0], setPreferences = _prefs[1], prefsRef = useRef(preferences);
		var _prefStatus = useState('正在读取收藏与设置…'), preferenceStatus = _prefStatus[0], setPreferenceStatus = _prefStatus[1];
		var _saving = useState(false), savingPreferences = _saving[0];
		var preferenceQueue = useRef(Promise.resolve());
		var _group = useState('all'), favoriteGroup = _group[0];
		var _records = useState({}), favoriteRecords = _records[0];
		var _ranking = useState({ items: [], busy: true, error: '' }), ranking = _ranking[0];
		var catalogMetadata = useRef({});
		var _installedBusy = useState(true), installedBusy = _installedBusy[0];
		var _installedKnown = useState(false), installedKnown = _installedKnown[0];
		var _restartReceipts = useState({}), restartReceipts = _restartReceipts[0];
		var loadInstalledMetadata = useCallback(function (pkg, signal) { return action('detail', { kind: pkg.kind, slug: pkg.slug }, { signal: signal }); }, []);
		var discovery = tab === 'market' && !q && !category && sort === 'recent' && pageRef.current === 1;
		useEffect(function () { return operations.subscribe(function () { operationTick[1](function (n) { return n + 1; }); }); }, [operations]);
		useEffect(function () {
			var active = true;
			void action('preferencesRead', {}).then(function (r) {
				if (!active) { return; }
				if (r.ok && r.preferences) { if (r.preferences.revision >= prefsRef.current.revision) { prefsRef.current = r.preferences; setPreferences(r.preferences); setPreferenceStatus('收藏与设置已读取'); } }
				else { setPreferenceStatus('收藏与设置读取失败：' + String(r.error || '无回执')); }
			});
			return function () { active = false; gates.dispose(); };
		}, []);
		function changePreferences(change) {
			var promise = preferenceQueue.current.then(async function () {
				_saving[1](true); setPreferenceStatus('正在保存…');
				var res = await action('preferencesUpdate', { expectedRevision: prefsRef.current.revision, change: change });
				_saving[1](false);
				if (!res || !res.ok) {
					if (res && res.code === 'revision-conflict' && res.current) { prefsRef.current = res.current; setPreferences(res.current); }
					setPreferenceStatus('暂未保存：' + String(res && res.error || '无回执') + '；请重试'); return false;
				}
				prefsRef.current = res.preferences; setPreferences(res.preferences); setPreferenceStatus('已保存'); return true;
			});
			preferenceQueue.current = promise.catch(function () { _saving[1](false); setPreferenceStatus('暂未保存，连接已中断'); return false; });
			return preferenceQueue.current;
		}
		function isFavorite(pkg) { return preferences.groups.some(function (g) { return g.items.indexOf(window.MarketplaceState.itemKey(pkg)) >= 0; }); }
		function removeFavorite(id) {
			preferences.groups.filter(function (g) { return g.items.indexOf(id) >= 0; }).forEach(function (g) { void changePreferences({ type: 'favorite', groupId: g.id, item: id, saved: false }); });
		}
		function toggleFavorite(pkg) {
			var id = window.MarketplaceState.itemKey(pkg);
			if (isFavorite(pkg)) { removeFavorite(id); return; }
			void changePreferences({ type: 'favorite', groupId: favoriteGroup === 'all' ? 'default' : favoriteGroup, item: id, saved: true });
		}
		async function refreshInstalled() {
			var token = gates.begin('installed');
			_installedBusy[1](true);
			var results = await Promise.all([action('installed', {}, { signal: token.signal }), action('mcpConfig', {}, { signal: token.signal })]);
			if (!token.current()) { return; }
			_installedBusy[1](false);
			if (results[0].ok) { setInstalledItems(results[0].items || []); _installedKnown[1](true); }
			else { setMsg({ kind: 'error', text: '本机清单读取失败，保留上次记录：' + String(results[0].error || '') }); }
			if (results[1].ok) { setMcpState(results[1]); mcpDigestRef.current = String(results[1].digest || ''); }
			else { setMcpState(null); setMsg({ kind: 'error', text: 'MCP 状态未读取：' + String(results[1].error || '') }); }
		}
		useEffect(function () { void refreshInstalled(); }, []);
		useEffect(function () { if (tab === 'installed') { void refreshInstalled(); } }, [tab]);

		/** 拉一页（append=true 时追加，不打断已看到的内容）。 */
		var fetchPage = useCallback(async function (pageToLoad, append) {
			var token = gates.begin('page');
			if (tab === 'favorites' || tab === 'installed') { setBusy(false); return; }
			setBusy(true);
			var op = 'list';
			if (tab === 'installed') { op = 'installed'; }
			if (tab === 'admin') { op = 'reviewList'; }
			var params = { limit: PAGE_SIZE, page: pageToLoad };
			if (kind) { params.kind = kind; }
			if (q) { params.q = q; }
			if (category) { params.category = category; }
			if (sort) { params.sort = sort; }
			if (tab === 'mine') { params.scope = 'mine'; }

			var res = await action(op, params, { signal: token.signal });
			if (!token.current()) { return; }
			setBusy(false);
			if (!res || res.ok === false) {
				if (!append) { setItems([]); setTotal(0); }
				setMsg({ kind: 'error', text: String((res && res.error) || '商城清单取不到') });
				return;
			}
			var got = Array.isArray(res.items) ? res.items : [];
			var paginated = op === 'list';
			if (paginated && tab === 'market') {
				got.forEach(function (p) { catalogMetadata.current[window.MarketplaceState.itemKey(p)] = { name: p.name, description: p.description, icon: p.icon, cover: p.cover }; });
				Object.keys(catalogMetadata.current).slice(0, Math.max(0, Object.keys(catalogMetadata.current).length - 180)).forEach(function (key) { delete catalogMetadata.current[key]; });
			}
			setItems(function (prev) { return append && paginated ? window.MarketplaceState.mergePage(prev, got).slice(-180) : got; });
			setTotal(typeof res.total === 'number' ? res.total : got.length);
			pageRef.current = pageToLoad;
			// 分类清单：从已加载列表**累积**提取（加载更多后下拉项不跳变）
			if (paginated) {
				setCats(function (prev) {
					var known = {};
					prev.forEach(function (c) { known[c] = true; });
					var all = append && paginated ? prev.concat(got) : got;
					all.forEach(function (it) {
						var c = String(it.category || '').trim();
						if (c) { known[c] = true; }
					});
					return Object.keys(known).sort();
				});
			}
		}, [tab, kind, category, sort, q]);
		currentFetch.current = fetchPage;

		// 换页签 / 类型 / 分类 / 排序 / 搜索词 ⇒ 从第一页重来
		useEffect(function () {
			setItems([]); setTotal(0); setCats([]);
			void fetchPage(1, false);
			return function () { gates.cancel('page'); };
		}, [fetchPage]);
		var fetchRanking = useCallback(async function () {
			var token = gates.begin('ranking');
			if (!discovery) { return; }
			_ranking[1]({ items: [], busy: true, error: '' });
			var res = await action('list', { kind: kind, sort: 'popular', limit: 5, page: 1 }, { signal: token.signal });
			if (!token.current()) { return; }
			_ranking[1]({ items: res.ok ? res.items || [] : [], busy: false, error: res.ok ? '' : String(res.error || '下载榜读取失败') });
		}, [kind, discovery]);
		currentRankingFetch.current = fetchRanking;
		useEffect(function () { void fetchRanking(); return function () { gates.cancel('ranking'); }; }, [fetchRanking]);
		useEffect(function () {
			var token = gates.begin('favorites');
			if (tab !== 'favorites') { return; }
			var ids = Array.from(new Set(preferences.groups.flatMap(function (g) { return g.items; })));
			void (async function () {
				var records = {};
				for (var offset = 0; offset < ids.length; offset += 6) {
					await Promise.all(ids.slice(offset, offset + 6).map(async function (id) {
						var parts = id.split(':'), res = await action('detail', { kind: parts[0], slug: parts[1] }, { signal: token.signal });
						if (res.ok && res.kind === parts[0] && res.slug === parts[1]) { records[id] = { pkg: res }; }
						else { records[id] = { error: String(res.error || '商品不可访问或已下架') }; }
					}));
					if (!token.current()) { return; }
					_records[1](Object.assign({}, records));
				}
				if (!ids.length && token.current()) { _records[1]({}); }
			})();
			return function () { gates.cancel('favorites'); };
		}, [tab, preferences.groups]);

		// ★ 2026-11-10：2s 轮询 mcp.json 的 mtime —— 弹层保存、行内开关、甚至用户在别处
		//   手改配置，都会让「已安装」折叠组里对应的 item 状态自动更新（不用手动刷新）。
		//   ⚠ 弹层打开时只更新 mcpState，不动 draft ⇒ 不会覆盖用户正在编辑的内容。
		useEffect(function () {
			if (tab !== 'market' && tab !== 'installed') { return undefined; }
			var inFlight = false, active = true;
			var timer = setInterval(function () {
				if (document.visibilityState !== 'visible' || inFlight) { return; }
				inFlight = true;
				void (async function () {
					try {
						var d = await action('mcpConfig', { digestOnly: true });
						if (!active || !d || d.ok === false || String(d.digest || '') === mcpDigestRef.current) { return; }
						mcpDigestRef.current = String(d.digest || '');
						await refreshInstalled();
					} finally { inFlight = false; }
				})();
			}, 2000);
			return function () { active = false; clearInterval(timer); };
		}, [tab]);

		// ★ 2026-11-10：MCP 配置弹层 + 「已安装」状态的实时数据源
		async function openMcpConfig() {
			var res = await action('mcpConfig', {});
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: String((res && res.error) || '读不到 mcp.json') });
				return;
			}
			setMcpState(res);
			mcpDigestRef.current = String(res.digest || '');
			setMcpModal({ path: res.path, draft: String(res.text || ''), busy: false, error: '' });
		}
		function patchMcpModal(patch) {
			setMcpModal(function (prev) { return Object.assign({}, prev || {}, patch); });
		}
		async function saveMcpConfigNow() {
			if (!mcpModal) { return; }
			var text = String(mcpModal.draft || '');
			try { JSON.parse(text); } catch (e) {
				patchMcpModal({ error: 'JSON 语法错误（未保存）：' + String((e && e.message) || e) });
				return;
			}
			patchMcpModal({ busy: true, error: '' });
			var res = await run('saveMcpConfig', { text: text }, '');
			if (!res || res.ok === false) {
				patchMcpModal({ busy: false, error: String((res && res.error) || '保存失败') });
				return;
			}
			patchMcpModal({ busy: false, error: '' });
			// run() 内部已 fetchPage(1,false) ⇒ 会重取 mcpConfig + installed ⇒ item 状态即时同步
			setMsg({ kind: 'ok', text: 'MCP 配置已保存，「已安装」状态已同步' + (res.backup ? '（旧文件已备份）' : '') });
		}
		async function toggleMcpEnabled(id, wantEnabled) {
			await run('setMcpEnabled', { kind: 'mcp', slug: id, enabled: Boolean(wantEnabled) }, '');
		}

		/** 统一的动作执行（失败如实显示）。 */

		async function run(op, params, okText) {
			var operationKey = String(params.kind || '') + ':' + String(params.slug || params.localId || op);
			var finish = operations.begin(operationKey, op);
			if (!finish) { return null; }
			var res = await action(op, params);
			finish(res && res.ok ? '' : String(res && res.error || '操作失败'));
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: String((res && res.error) || '操作失败') });
				return null;
			}
			if (res.restartRequired === true || op === 'uninstall') { _restartReceipts[1](function (old) { var next = Object.assign({}, old); if (op === 'uninstall') { delete next[operationKey]; } else { next[operationKey] = true; } return next; }); }
			if (okText) {
			var text = okText;
			// ★ 2026-11-09：Bot 组合包按 Host 的**分项回执**如实说明生效状态，
			//   不再用泛化的「部分资源需要重启」糊过去（MCP 还要用户填环境变量）。
			if (res.bot && res.bot.note) {
				text = 'Bot 已安装：' + res.bot.note;
				// ★ 依赖查不到版本 ≠ 已满足 ⇒ 逐项列出来，不静默略过。
				var unknownDeps = (res.botRequires && Array.isArray(res.botRequires.results))
					? res.botRequires.results.filter(function (r) { return r.state === 'unknown'; })
						.map(function (r) { return String(r.name) + '(' + String(r.range) + ')'; })
					: [];
				if (unknownDeps.length) { text += ' 依赖未在本机校验：' + unknownDeps.join('、'); }
			} else if (res.combo && Array.isArray(res.comboComponents)) {
				text = '已安装组合包（' + res.comboComponents.length + ' 个组件）：技能 / Agent 需重启 Harness 后生效';
			}
			// ★ P3：登记失败等警告如实拼在成功文案后，不吞
			if (res.vaultWarning) { text += ' ⚠ ' + String(res.vaultWarning); }
			if (res.packageName && res.resources) {
				var botPlugin = res.profile === 'bot';
				text = (botPlugin ? 'Bot 插件已安装：' : '工作台插件已安装：') + res.packageName
					+ (res.restartRequired ? (botPlugin ? '；请重启应用后从 Bots 侧栏选择' : '；请重启应用后从工作台启动器打开')
						: (botPlugin ? '；请从 Bots 侧栏选择并验证会话' : '；请打开工作台验证页面'));
				text += '。技能 / 工具 / MCP 为可选能力；需要凭据的服务仍需使用者配置，安装不代表全部能力已就绪。';
			}
			setMsg({ kind: 'ok', text: text });
		}
			readClient.invalidate();
			void refreshInstalled(); void currentRankingFetch.current(); void currentFetch.current(1, false);
			return res;
		}

		async function openDetail(slug, kind) {
			var token = gates.begin('detail');
			var res = await action('detail', { slug: slug, kind: kind || '' }, { signal: token.signal });
			if (!token.current()) { return; }
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: String((res && res.error) || '详情取不到') });
				return;
			}
			setDetail(res);
		}

		/** ★ 2026-11-10 P0：详情里点安装也先走预览（确认后由 confirmInstall 刷新抽屉）。 */
		async function installFromDetail() {
			if (!detail) { return; }
			await openPreview(detail, false);
		}

		/** 打开发布表单（先拿本机可发布资源）。 */
		/** preset = { kind, localId } 或空；从本地资源详情进来时预填 pick 与版本。 */
		async function openPublish(preset) {
			var pre = preset && typeof preset === 'object' ? preset : {};
			setPub({
				mode: 'local', items: [], pick: '', version: '', changelog: '', busy: true, error: '',
				// GitHub 源模式专用（★ 2026-10-22）
				kind: 'skill', slug: '', source: '', name: '', description: '', icon: '', cover: '',
			});
			var res = await action('publishables', {});
			var list = (res && res.ok !== false && Array.isArray(res.items)) ? res.items : [];
			var hit = (pre.kind && pre.localId)
				? list.filter(function (it) { return it.kind === pre.kind && it.localId === pre.localId; })[0]
				: null;
			setPub({
				mode: 'local',
				items: list,
				pick: hit ? (hit.kind + '|' + hit.localId) : (list.length ? (list[0].kind + '|' + list[0].localId) : ''),
				version: hit ? String(hit.version || '') : (list.length ? String(list[0].version || '') : ''),
				changelog: '',
				busy: false,
				error: (res && res.ok === false) ? String(res.error || '列不出本机资源')
					: (pre.localId && !hit ? '这个本机资源不在可发布清单里（可能缺入口文件）'
					: (list.length ? '' : '本机没有可发布的资源（skill / agent / 知识库）—— 可以把「来源」切到 GitHub 地址')),
				kind: pre.kind || 'skill', slug: pre.localId || '',
				source: '', name: pre.name || '', description: '', icon: '', cover: '',
			});
		}

		/**
		 * 从 GitHub 链接**自动识别并回填**（★ 2026-10-27 用户需求）。
		 *
		 * 只填**还空着**的字段 ⇒ 用户手改过的不覆盖（自动填写不能抢人的输入 ✗）。
		 * 识别走 `inspectGithub` op（Host 侧全程用不占 GitHub API 额度的通道）。
		 */
		async function inspectGithub() {
			if (!pub) { return; }
			var repo = String(pub.source || '').trim();
			if (!repo) {
				setPub(Object.assign({}, pub, { error: '请先填 GitHub 地址' }));
				return;
			}
			setPub(Object.assign({}, pub, { busy: true, error: '', inspectNote: '正在识别 ' + repo + ' …' }));
			var r = await action('inspectGithub', { repo: repo });
			if (!r || r.ok === false) {
				setPub(Object.assign({}, pub, { busy: false, inspectNote: '', error: String((r && r.error) || '识别失败') }));
				return;
			}
			setPub(Object.assign({}, pub, {
				busy: false,
				error: '',
				slug: String(pub.slug || '').trim() || r.slug || '',
				name: String(pub.name || '').trim() || r.name || '',
				description: String(pub.description || '').trim() || r.description || '',
				version: String(pub.version || '').trim() || r.version || '',
				// ★ 2026-11-10：自动填写的图标 = inspect 拿到的 owner 头像（不覆盖用户手填）
				icon: String(pub.icon || '').trim() || r.logo || '',
				kind: r.kind || pub.kind || 'skill',
				inspectNote: '已识别 ' + r.repo + '（版本来自 ' + r.versionFrom + '）'
					+ (r.kind ? ' · 类型判定：' + r.kind : ' · 类型没判定出来，请手选')
					+ (r.logo ? ' · 图标已回填 owner 头像' : '')
					+ (Array.isArray(r.notes) && r.notes.length ? ' · ' + r.notes.join('；') : ''),
			}));
		}

		async function submitPublish(force) {
			if (!pub) { return; }
			var github = pub.mode === 'github';
			var pluginPackage = pub.mode === 'package';
			var k;
			var localId;
			if (pluginPackage) {
				k = String(pub.kind || 'workbench'); localId = String(pub.slug || '').trim();
				if (k !== 'workbench' && k !== 'agent') { setPub(Object.assign({}, pub, { error: '插件类型必须为 Bot 或工作台' })); return; }
				if (!localId || !pub.pluginBase64) { setPub(Object.assign({}, pub, { error: '请选择插件 .tgz 并填写商城标识' })); return; }
			} else if (github) {
				k = String(pub.kind || '').trim();
				localId = String(pub.slug || '').trim();
				if (!localId) {
					setPub(Object.assign({}, pub, { error: '请填标识（商城里的唯一 id，如 my-skill）' }));
					return;
				}
				if (!String(pub.source || '').trim()) {
					setPub(Object.assign({}, pub, { error: '请填 GitHub 地址（owner/repo 或 https://github.com/...）' }));
					return;
				}
			} else {
				var parts = String(pub.pick || '').split('|');
				k = parts[0];
				localId = parts[1];
				if (!localId) {
					setPub(Object.assign({}, pub, { error: '请选择要发布的资源（或把来源切到 GitHub 地址）' }));
					return;
				}
			}
			var version = String(pub.version || '').trim();
			if (!version) {
				setPub(Object.assign({}, pub, { error: '请填版本号（语义化版本，如 1.0.0）' }));
				return;
			}
			// ★ 2026-11-10：图标 / 缩略图只收图片 URL（与 PkgIcon / PkgCover 的 isImageIcon 同口径）
			var icon = String(pub.icon || '').trim();
			var cover = String(pub.cover || '').trim();
			var imgOk = function (v) { return !v || /^(https?:\/\/|data:image\/)/i.test(v); };
			if (!imgOk(icon) || !imgOk(cover)) {
				setPub(Object.assign({}, pub, { error: '图标 / 缩略图只收 http(s):// 或 data:image/ 开头的图片 URL；本地文件请先上传成公开地址' }));
				return;
			}
			setPub(Object.assign({}, pub, { busy: true, error: '' }));
			var params = { kind: k, localId: localId, slug: localId, version: version, changelog: pub.changelog || '' };
			if (pluginPackage) { params.pluginBase64 = pub.pluginBase64; }
			if (icon) { params.icon = icon; }
			if (cover) { params.cover = cover; }
			// ★ 2026-10-31：知识库的本体在**用户选的那个库目录**里（不在数据根下）⇒ 必须带上
			if (!github) {
				var picked = (pub.items || []).filter(function (it) { return it.kind === k && it.localId === localId; })[0];
				if (picked && picked.sourceDir) { params.sourceDir = picked.sourceDir; }
			}
			// ★ 隐私体检被拦 ⇒ 用户确认后重发
			if (pub.ackPrivacy || force === true) { params.acknowledgePrivacy = true; }
			// 本地打包模式也能带商品名与介绍（以前只在 GitHub 模式传）
			if (textOf(pub.name).trim()) { params.name = textOf(pub.name).trim(); }
			if (textOf(pub.description).trim()) { params.description = textOf(pub.description).trim(); }
			if (github) {
				// 本体就是一个 GitHub 地址 ⇒ 只登记来源，不打包上传
				params.source = String(pub.source || '').trim();
			}
			var res = await action('publish', params);
			if (!res || res.ok === false) {
				var errText = String((res && res.error) || '发布失败');
				// ★ 2026-10-31：隐私体检拦下 ⇒ 明确告知 + 给"确认公开并发布"的出口（否则用户无从继续）
				if (/隐私体检/.test(errText)) {
					setPub(Object.assign({}, pub, { busy: false, error: errText, privacyBlock: true }));
					return;
				}
				setPub(Object.assign({}, pub, { busy: false, error: errText }));
				return;
			}
			setPub(null);
			setMsg({
				kind: 'ok',
				// ★ 2026-11-10 P0：把 Host 锁到的 commit 回执出来（pin commit 可见，
				//   否则作者不知道自己发的版本到底钉在哪一次提交上）
				text: '已发布 ' + localId + ' v' + String(res.version || version)
					+ (github ? '（外部源：安装时从 GitHub 取）' : '')
					+ (res.shaNote ? ' · ' + String(res.shaNote) : ''),
			});
			void fetchPage(1, false);
		}

		async function submitEdit() {
			if (!edit) { return; }
			if (!String(edit.name || '').trim()) {
				setEdit(Object.assign({}, edit, { error: '名称不能为空' }));
				return;
			}
			setEdit(Object.assign({}, edit, { busy: true, error: '' }));
			var res = await action('updatePackage', {
				slug: edit.slug,
				name: edit.name,
				description: edit.description,
				category: edit.category,
				icon: edit.icon,
				visibility: edit.visibility
			});
			if (!res || res.ok === false) {
				setEdit(Object.assign({}, edit, { busy: false, error: String((res && res.error) || '保存失败') }));
				return;
			}
			var slug = edit.slug;
			setEdit(null);
			setMsg({ kind: 'ok', text: '已保存' });
			void fetchPage(1, false);
			if (detail && detail.slug === slug) { void openDetail(slug); }
		}

		// ★ 2026-11-10 P0：安装 / 升级改为两步（预览 → 确认）。
		async function openPreview(pkg, upgrade) {
			if (!pkg || !pkg.slug || pkg.installable === false) { return; }
			var token = gates.begin('preview');
			gates.cancel('detail'); setDetail(null); setMsg(null);
			var res = await action('previewInstall', { slug: pkg.slug });
			if (!token.current()) { return; }
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: '预览取不到：' + String((res && res.error) || '未知错误') });
				return;
			}
			setPreview(Object.assign({}, res, { upgrade: !!upgrade }));
		}

		async function confirmInstall() {
			if (!preview) { return; }
			var p = preview;
			setPreview(null);
			var res = await run(p.upgrade ? 'upgrade' : 'install',
				{ kind: p.kind, slug: p.slug, version: p.version },
				p.upgrade ? '已升级（部分资源需要重启后才生效）' : '已安装（部分资源需要重启后才生效）');
			if (res && detail && detail.slug === p.slug) { await openDetail(p.slug); }
		}

		function safeBackup() {
			try {
				var raw = localStorage.getItem(SAFE_MODE_KEY);
				var arr = raw ? JSON.parse(raw) : [];
				return Array.isArray(arr) ? arr : [];
			} catch { return []; }
		}
		function saveSafeBackup(arr) {
			try { localStorage.setItem(SAFE_MODE_KEY, JSON.stringify(arr)); } catch { /* 存不了不影响本次 */ }
		}
		function clearSafeBackup() {
			try { localStorage.removeItem(SAFE_MODE_KEY); } catch { /* 同上 */ }
		}
		async function setEach(names, enabled) {
			var failed = [];
			for (var i = 0; i < names.length; i++) {
				var r = await action('setPluginEnabled', { name: names[i], enabled: enabled });
				if (!r || r.ok === false) { failed.push(names[i] + '：' + String((r && r.error) || '失败')); }
			}
			return failed;
		}
		async function openSafeMode() {
			var res = await action('safeModePlan', {});
			if (!res || res.ok === false) {
				setSafeMode({ plugins: [], error: String((res && res.error) || '列不出插件'), hasBackup: safeBackup().length > 0 });
				return;
			}
			setSafeMode({ plugins: Array.isArray(res.plugins) ? res.plugins : [], hasBackup: safeBackup().length > 0, busy: false });
		}
		async function enterSafeMode() {
			if (!safeMode) { return; }
			var names = safeMode.plugins.filter(function (p) { return p.enabled; }).map(function (p) { return p.name; });
			if (!names.length) { return; }
			setSafeMode(Object.assign({}, safeMode, { busy: true, note: '' }));
			var failed = await setEach(names, false);
			saveSafeBackup(names);
			var res = await action('safeModePlan', {});
			setSafeMode({
				plugins: (res && Array.isArray(res.plugins)) ? res.plugins : safeMode.plugins,
				hasBackup: true, busy: false,
				note: '已停用 ' + names.length + ' 个插件' + (failed.length ? '（失败：' + failed.join('、') + '）' : '') + '；重启 Host 后生效',
				error: failed.length ? failed.join('、') : ''
			});
		}
		async function restoreSafeMode() {
			if (!safeMode) { return; }
			var names = safeBackup();
			if (!names.length) { return; }
			setSafeMode(Object.assign({}, safeMode, { busy: true, note: '' }));
			var failed = await setEach(names, true);
			if (!failed.length) { clearSafeBackup(); }
			var res = await action('safeModePlan', {});
			setSafeMode({
				plugins: (res && Array.isArray(res.plugins)) ? res.plugins : safeMode.plugins,
				hasBackup: failed.length > 0, busy: false,
				note: failed.length ? '部分恢复失败，记录已保留：' + failed.join('、') : '已恢复 ' + names.length + ' 个插件；重启 Host 后生效',
				error: ''
				});
				}

				// ★ 2026-11-23：升级备份 / 回滚（同源直调 Host 的 marketplace op，不经过 IDE 桥）
				async function openRollback() {
				var res = await action('rollbackList', {});
				if (!res || res.ok === false) {
				setRollback({ items: [], busy: false, error: String((res && res.error) || '列不出可回滚版本') });
				return;
				}
				setRollback({ items: Array.isArray(res.items) ? res.items : [], busy: false, error: '' });
				}
				async function restoreRollbackPoint(key, ts) {
				if (!rollback || rollback.busy) { return; }
				var grouped = window.MarketplaceState.groupRollbackPoints(rollback.items);
				var point = window.MarketplaceState.pickRollbackPoint(grouped.groups, key, ts);
				if (!point) { return; }
				setRollback(Object.assign({}, rollback, { busy: true, note: '', error: '' }));
				var res = await action('rollbackRestore', { kind: point.kind, storeId: point.id, ts: point.ts });
				if (!res || res.ok === false) {
				setRollback(Object.assign({}, rollback, { busy: false, error: String((res && res.error) || '恢复失败') }));
				return;
				}
				var fresh = await action('rollbackList', {});
				setRollback({
				items: (fresh && Array.isArray(fresh.items)) ? fresh.items : rollback.items,
				busy: false, error: '',
				note: '已把 ' + point.id + ' 恢复到 ' + point.ts + ' 的备份；当前版本已留档，可再次回滚'
				});
				}

				// ★ 2026-11-10 P2：离线便携包（导出 / 两步导入）
		function patchPortable(patch) {
			setPortable(function (prev) { return Object.assign({}, prev || {}, patch); });
		}
		async function openPortable() {
			var res = await action('installed', {});
			var items = (res && Array.isArray(res.items)) ? res.items : [];
			// 只导出「磁盘上真的还在」的那几类；plugin/workbench 在 profile 里，不在数据根
			setPortable({
				items: items.filter(function (it) { return ['skill', 'agent', 'mcp', 'knowledge'].indexOf(it.kind) >= 0; }),
				selected: {}, preview: null, base64: '', renames: {}, busy: false, error: '', note: ''
			});
		}
		async function exportSelectedPortable() {
			if (!portable) { return; }
			var chosen = portable.items.filter(function (it) {
				return !!portable.selected[it.kind + ':' + String(it.storeId || it.slug || it.id || '')];
			}).map(function (it) {
				return { kind: it.kind, storeId: String(it.storeId || it.slug || it.id || ''), version: String(it.version || '') };
			});
			patchPortable({ busy: true, error: '', note: '' });
			var res = await action('exportPortable', { entries: chosen });
			if (!res || res.ok === false) {
				patchPortable({ busy: false, error: String((res && res.error) || '导出失败') });
				return;
			}
			downloadPortable(res.base64, 'vssaros-portable-' + Date.now() + '.sarospack');
			patchPortable({ busy: false, note: '已导出 ' + chosen.length + ' 个资源（' + Math.round(res.bytes / 1024) + ' KB）' });
		}
		function pickPortableFile(e) {
			var file = e.target.files && e.target.files[0];
			if (!file) { return; }
			var reader = new FileReader();
			reader.onload = function () {
				var dataUrl = String(reader.result || '');
				var b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
				patchPortable({ busy: true, error: '', note: '', preview: null, base64: b64, renames: {} });
				void (async function () {
					var res = await action('previewPortable', { base64: b64 });
					if (!res || res.ok === false) {
						patchPortable({ busy: false, error: String((res && res.error) || '预览失败') });
						return;
					}
					patchPortable({ busy: false, preview: res, renames: {} });
				})();
			};
			reader.readAsDataURL(file);
		}
		async function confirmPortableImport() {
			if (!portable || !portable.preview) { return; }
			var conflicts = portable.preview.conflicts || [];
			var renames = portable.renames || {};
			var missing = conflicts.filter(function (k) { return !String(renames[k] || '').trim(); });
			if (missing.length) {
				patchPortable({ busy: false, error: '以下资源本机已存在，请填新名字：' + missing.join('、') });
				return;
			}
			patchPortable({ busy: true, error: '', note: '' });
			var res = await action('importPortable', { base64: portable.base64, renames: renames });
			if (!res || res.ok === false) {
				patchPortable({ busy: false, error: String((res && res.error) || '导入失败') });
				return;
			}
			patchPortable({ busy: false, preview: null, base64: '', renames: {}, note: '已导入 ' + (res.imported || []).length + ' 个资源' });
			void fetchPage(1, false);
		}

		// 卡片/抽屉上的动作（集中一处；★ 安装/升级先走预览抽屉）
		var onInstall = function (pkg) { void openPreview(pkg, false); };
		var onUpgrade = function (pkg) { void openPreview(pkg, true); };

		var onUninstall = function (pkg) { return run('uninstall', { kind: pkg.kind, slug: pkg.slug }, '已卸载'); };
		var onReview = function (pkg, status) {
			void run('reviewStatus', { slug: pkg.slug, status: status }, status === 'active' ? '已通过审核' : '已拒绝并下架');
		};
		var onFeature = function (pkg) {
			void run('reviewFeature', { slug: pkg.slug, featured: !pkg.featured }, pkg.featured ? '已取消推荐' : '已设为推荐');
		};

		// ⚠ 2026-10-23 移除：「同步本机工作台」按钮。
		//   用户明确"内置的工作台不用在商城中展示，我们会随版本更新" ⇒
		//   本机 `kind=page` 插件是**内置能力**，不属于商城商品；
		//   商城的 workbench 只放**第三方**（由 `tools/sync-market-workbenches.mjs` 从公开市场同步）。
		//   曾经同步进去的 14 个内置工作台已从数据库删除 ✓

		var kindChips = KIND_TABS.map(function (t) { return { id: t.id, label: t.label }; });
		var catChips = useMemo(function () {
			if (tab === 'admin' || tab === 'installed' || tab === 'mine') { return []; }
			if (cats.length < 2 && !category) { return []; }
			return [{ id: '', label: '全部分类' }].concat(cats.map(function (c) { return { id: c, label: c }; }));
		}, [cats, category, tab]);

		var shownItems = tab === 'installed' ? installedItems.filter(function (it) {
			return (!kind || it.kind === kind) && (!q || [it.name, it.slug, it.description].join(' ').toLowerCase().includes(q.toLowerCase()));
		}).map(function (p) { return restartReceipts[window.MarketplaceState.itemKey(p)] ? Object.assign({}, p, { restartRequired: true }) : p; }) : items;
		var upgradeMap = {}, installationMap = {};
		installedItems.forEach(function (p) { var id = window.MarketplaceState.itemKey(p); installationMap[id] = p.installedVersion || p.version; if (p.upgradable) { upgradeMap[id] = p; } });
		function renderCard(pkg) {
			if (installedKnown && !pkg.isLocal) { pkg = Object.assign({}, pkg, { installedVersion: installationMap[window.MarketplaceState.itemKey(pkg)] || '' }); }
			return h(Card, { key: window.MarketplaceState.itemKey(pkg), pkg: pkg, operations: operations, upgrades: upgradeMap,
				favorite: isFavorite(pkg), onFavorite: toggleFavorite, savingPreferences: savingPreferences,
				adminActions: tab === 'admin' && pkg.permissions && pkg.permissions.canReview === true,
				onDetail: openDetail, onInstall: onInstall, onUpgrade: onUpgrade, onUninstall: onUninstall, onReview: onReview, onFeature: onFeature });
		}
		var mcpServerMap = {};
		if (mcpState && Array.isArray(mcpState.servers)) {
			mcpState.servers.forEach(function (x) { mcpServerMap[String(x.id)] = { disabled: x.disabled, approved: x.approved, type: x.type }; });
		}
		var more = pageRef.current * PAGE_SIZE < total && tab !== 'admin' && tab !== 'installed' && tab !== 'favorites';
		return h('div', { className: 'vs-mp-wrap', 'data-skin': preferences.skin, 'data-view': tab, 'data-vssaros-surface': 'workbench' },
			h('div', { id: 'vs-mp-main' },
			// ── 页头 ──────────────────────────────────────────────
			h('header', { className: 'vs-mp-head' },
				h('div', null,
					h('h1', null, '商城工作台'),
					h('p', { className: 'vs-mp-sub' }, 'Agent / Skill / MCP / 工作台 / 知识库 —— 安装、升级、发布与维护')
				),
				h('div', { className: 'vs-mp-tools' },
					h('input', {
						className: 'vs-mp-input',
						placeholder: tab === 'installed' ? '搜索已安装资源名称 / 标识 / 介绍' : '搜索名称 / 介绍 / 标识', type: 'search', 'aria-label': tab === 'installed' ? '搜索已安装资源' : '搜索商城商品',
						onSearch: function (e) { if (!e.target.value) { setQ(''); } },
						value: qInput,
						onChange: function (e) { setQInput(e.target.value); },
						onKeyDown: function (e) { if (e.key === 'Enter') { setQ(String(qInput).trim()); } }
					}),
					tab === 'installed' ? null : h('select', {
						className: 'vs-mp-input vs-mp-select',
						value: sort,
						title: '排序',
						onChange: function (e) { setSort(e.target.value); }
					},
						h('option', { value: 'recent' }, '最近更新'),
						h('option', { value: 'popular' }, '最热'),
						h('option', { value: 'name' }, '按名称')
					),
					// ★ 2026-10-23：卡片大小调整（小 / 中 / 大，选择会被记住）
					tab === 'installed' ? null : h('div', { className: 'vs-mp-size', title: '卡片大小', role: 'group', 'aria-label': '卡片大小' },
						SIZES.map(function (s) {
							return h('button', {
								key: s.id,
								className: 'vs-mp-size-btn' + (sizeId === s.id ? ' on' : ''),
								title: s.label + '卡片',
								'aria-pressed': sizeId === s.id,
								onClick: function () { setSizeId(s.id); }
							}, s.label);
						})
					),
					h('select', { className: 'vs-mp-input vs-mp-select', 'aria-label': '商城皮肤', value: preferences.skin, disabled: savingPreferences, onChange: function (e) { void changePreferences({ type: 'setSkin', skin: e.target.value }); } }, h('option', { value: 'native' }, '原生'), h('option', { value: 'decorative' }, '装饰')),
					h('details', { className: 'vs-mp-more' }, h('summary', { className: 'vs-mp-btn' }, '更多'), h('div', { className: 'vs-mp-more-menu' },
						h('button', { className: 'vs-mp-btn', onClick: function () { void openMcpConfig(); } }, 'MCP 配置'),
						h('button', { className: 'vs-mp-btn', onClick: function () { void openSafeMode(); } }, '安全模式'),
					h('button', { className: 'vs-mp-btn', onClick: function () { void openRollback(); } }, '可回滚版本'),
						h('button', { className: 'vs-mp-btn', onClick: function () { void openPortable(); } }, '便携包'),
						h('button', { className: 'vs-mp-btn', onClick: function () { readClient.invalidate(); setMsg(null); void refreshInstalled(); void fetchRanking(); void fetchPage(1, false); } }, '刷新'))),
					h('button', { className: 'vs-mp-btn primary', onClick: function () { void openPublish(); } }, '发布')
				)
			),

			h(MsgBar, { msg: msg, onClose: function () { setMsg(null); } }),

			h(Tabs, {
				items: MAIN_TABS,
				active: tab,
				onPick: function (id) { setTab(id); setDetail(null); setMsg(null); setCategory(''); setCats([]); }
			}),
			tab === 'admin' ? null : h(Chips, { items: kindChips, active: kind, onPick: function (id) { setKind(id); setCategory(''); setCats([]); } }),
			h(Chips, { items: catChips, active: category, onPick: function (id) { setCategory(id); }, small: true }),

			tab !== 'favorites' && tab !== 'installed' ? h('div', { className: 'vs-mp-count' },
				'匹配 ' + total + ' 个 · 当前保留 ' + items.length + ' 个 · 展示 ' + shownItems.length + ' 个（最多保留最近 180 项）',
				more ? h('button', { className: 'vs-mp-link', disabled: busy, onClick: function () { void fetchPage(pageRef.current + 1, true); } }, busy ? '加载中…' : '加载更多') : null
			) : null,
			discovery ? h(window.MarketplaceUI.Discovery, { items: items, ranking: ranking.items, busy: ranking.busy, error: ranking.error,
				onRetry: function () { readClient.invalidate(); void fetchRanking(); }, renderCard: renderCard, PkgIcon: PkgIcon, onDetail: openDetail }) : null,

			tab === 'favorites' ? h(window.MarketplaceUI.Favorites, { preferences: preferences, group: favoriteGroup,
				onGroup: _group[1], records: favoriteRecords, kind: kind, query: q, renderCard: renderCard, onChange: changePreferences, onRemove: removeFavorite,
				saving: savingPreferences, status: preferenceStatus }) : tab === 'installed'
				? h(window.MarketplaceUI.InstalledManager, { items: shownItems, metadata: catalogMetadata.current, busy: installedBusy,
					servers: mcpServerMap, serversKnown: Boolean(mcpState), operations: operations, PkgIcon: PkgIcon, PkgCover: PkgCover,
					loadMetadata: loadInstalledMetadata, onDetail: openDetail, onUpgrade: onUpgrade, onUninstall: onUninstall,
					onMcpConfig: openMcpConfig, onToggleMcp: toggleMcpEnabled, onRefresh: refreshInstalled,
					onPublishLocal: function (it) { void openPublish({ kind: it.kind, localId: it.localId || it.slug, name: textOf(it.name) }); } })
				: h(React.Fragment, null, discovery ? h('div', { className: 'vs-mp-section-head' }, h('h2', null, '浏览全部资源')) : null,
					shownItems.length === 0 ? h('div', { className: 'vs-mp-empty', role: 'status' }, busy ? '正在加载…' : '没有匹配的商品，可调整筛选或刷新。')
					: h('div', { className: 'vs-mp-grid', style: { '--vs-mp-card-min': sizeMin + 'px' } }, shownItems.map(renderCard))),
			h('p', { className: 'vs-mp-preferences-status', role: 'status' }, preferenceStatus)
			),
			h('div', { id: 'vs-mp-overlays' }),

			// ── 抽屉 ──────────────────────────────────────────────
			detail ? h(DetailDrawer, {
				detail: Object.assign({}, detail, { upgradable: Boolean(upgradeMap[window.MarketplaceState.itemKey(detail)]) }), operations: operations, favorite: isFavorite(detail), onFavorite: toggleFavorite, savingPreferences: savingPreferences,
				onClose: function () { gates.cancel('detail'); setDetail(null); },
				onPublish: function () {
					setDetail(null);
					void openPublish({ kind: detail.kind, localId: detail.localId || detail.slug, name: textOf(detail.name) });
				},
				onInstall: function () { void installFromDetail(); },
				onUpgrade: function () { void openPreview(detail, true); },
				onUninstall: function () { void onUninstall(detail).then(function (r) { if (r) { void openDetail(detail.slug, detail.kind); } }); },
				onEdit: function () {
					setDetail(null);
					setEdit({
						slug: detail.slug,
						name: textOf(detail.name),
						description: textOf(detail.description),
						category: textOf(detail.category),
						icon: String(detail.icon || ''),
						visibility: detail.visibility === 'private' ? 'private' : 'public',
						busy: false,
						error: ''
					});
				},
				onDeletePackage: function () {
					void run('deletePackage', { kind: detail.kind, slug: detail.slug }, '已下架').then(function (r) { if (r) { setDetail(null); } });
				},
				onDeleteVersion: function (version) {
					void run('deleteVersion', { kind: detail.kind, slug: detail.slug, version: version }, '已下架该版本');
				}
			}) : null,

			pub ? h(PublishDrawer, {
				state: pub,
				onClose: function () { setPub(null); },
				onChange: function (patch) { setPub(Object.assign({}, pub, patch, { error: '' })); },
				onSubmit: function () { void submitPublish(); },
				onForcePublish: function () { void submitPublish(true); },
				// ★ 2026-10-27：贴 GitHub 链接 ⇒ 自动识别并回填
				onInspect: inspectGithub
			}) : null,

			edit ? h(EditDrawer, {
				state: edit,
				onClose: function () { setEdit(null); },
				onChange: function (patch) { setEdit(Object.assign({}, edit, patch, { error: '' })); },
				onSubmit: submitEdit
			}) : null,

			preview ? h(PreviewDrawer, {
				preview: preview,
				onClose: function () { setPreview(null); },
				onConfirm: function () { void confirmInstall(); }
			}) : null,

			safeMode ? h(SafeModeDrawer, {
				state: safeMode,
				onClose: function () { setSafeMode(null); },
				onEnter: function () { void enterSafeMode(); },
				onRestore: function () { void restoreSafeMode(); }
			}) : null,

			rollback ? h(RollbackDrawer, {
				state: rollback,
				onClose: function () { setRollback(null); },
				onRestore: function (key, ts) { void restoreRollbackPoint(key, ts); }
			}) : null,

			portable ? h(PortableDrawer, {
				state: portable,
				onClose: function () { setPortable(null); },
				onToggle: function (key) {
					setPortable(function (prev) {
						var next = Object.assign({}, prev.selected || {});
						next[key] = !next[key];
						return Object.assign({}, prev, { selected: next });
					});
				},
				onExport: function () { void exportSelectedPortable(); },
				onPick: pickPortableFile,
				onRename: function (key, value) {
					setPortable(function (prev) {
						var next = Object.assign({}, prev.renames || {});
						next[key] = value;
						return Object.assign({}, prev, { renames: next });
					});
				},
				onImport: function () { void confirmPortableImport(); }
			}) : null,

			mcpModal ? h(McpConfigModal, {
				state: Object.assign({}, mcpModal, {
					path: (mcpState && mcpState.path) || mcpModal.path,
					servers: (mcpState && mcpState.servers) || []
				}),
				onClose: function () { setMcpModal(null); },
				onDraft: function (v) { patchMcpModal({ draft: v, error: '' }); },
				onSave: function () { void saveMcpConfigNow(); }
			}) : null
		);
	}

	ReactDOM.createRoot(root).render(h(App));
})();
