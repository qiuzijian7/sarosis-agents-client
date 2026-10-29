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
	if (!React || !ReactDOM) {
		if (root) {
			root.innerHTML = '<div class="vs-mp-empty">React 没有装载成功（vendor/react.js 或 react-dom.js 取不到）—— 请刷新；仍然不行就把这个提示发给我</div>';
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
		workflow: '工作流',
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
		workflow: '🔀',
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
		var pkg = props.pkg || {};
		var raw = String(pkg.icon || '').trim();
		var hue = hueOf(pkg.slug || pkg.name || '');
		var fallbackEmoji = KIND_EMOJI[pkg.kind] || '📦';
		var emojiState = useState(null);   // 图片失败后要显示的 emoji（null = 还没失败）
		var emoji = emojiState[0];
		var setEmoji = emojiState[1];
		var cls = 'vs-mp-icon' + (props.large ? ' vs-mp-icon-lg' : '');

		if (isImageIcon(raw) && !emoji) {
			return h('div', { className: cls, style: { background: iconBg(hue) }, title: raw },
				h('img', {
					src: raw,
					alt: '',
					// ★ 懒加载：原生 loading=lazy（视口外不请求）+ async 解码（不阻塞渲染）
					loading: 'lazy',
					decoding: 'async',
					referrerPolicy: 'no-referrer',
					onError: function () { setEmoji(fallbackEmoji); }
				})
			);
		}
		return h('div', { className: cls, style: { background: iconBg(hue) } },
			h('span', { className: 'vs-mp-icon-emoji' }, emoji || raw || fallbackEmoji));
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

	/** 分类页签（mcp / knowledge 不进页签，但接口支持）。 */
	var KIND_TABS = [
		{ id: '', label: '全部' },
		{ id: 'agent', label: 'Agent' },
		{ id: 'skill', label: 'Skill' },
		{ id: 'workbench', label: '工作台' },
		{ id: 'workflow', label: '工作流' }
	];

	/** 顶层页签。 */
	var MAIN_TABS = [
		{ id: 'market', label: '商城' },
		{ id: 'mine', label: '我的发布' },
		{ id: 'installed', label: '已安装' },
		{ id: 'admin', label: '管理' }
	];

	/** 商城动作统一入口（Host 侧自持认证/落盘/打包）。 */
	async function action(op, params) {
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
		var perm = pkg.permissions || {};
		var upgradable = pkg.upgradable === true;
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

		var actions = [
			h('button', { key: 'd', className: 'vs-mp-btn', onClick: function () { props.onDetail(pkg.slug); } }, '详情')
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
		} else if (perm.canPublish !== false) {
			actions.push(h('button', { key: 'i', className: 'vs-mp-btn primary', onClick: function () { props.onInstall(pkg); } }, '安装'));
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
		return h('div', { className: 'vs-mp-card' + (hasCover ? ' has-cover' : ''), 'data-slug': pkg.slug },
			h(PkgCover, { key: 'cover', pkg: pkg, onFail: coverState[1] }),
			h('div', { className: 'vs-mp-card-top' },
				hasCover ? null : h(PkgIcon, { key: 'icon', pkg: pkg }),
				h('div', { className: 'vs-mp-card-topbody' },
					h('div', { className: 'vs-mp-card-head' },
						h('span', { className: 'vs-mp-kindtag' }, KIND_LABEL[pkg.kind] || String(pkg.kind)),
						statusTag, distTag, instTag, upTag
					),
					h('div', { className: 'vs-mp-card-title' }, textOf(pkg.name) || textOf(pkg.slug))
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
			h('div', { className: 'vs-mp-card-actions' }, actions)
		);
	}

	/** 右滑抽屉（详情 / 发布 / 编辑共用外壳）。 */
	function Drawer(props) {
		return h(React.Fragment, null,
			h('div', { className: 'vs-mp-mask', onClick: props.onClose }),
			h('div', { className: 'vs-mp-drawer', role: 'dialog', 'aria-label': props.title },
				h('div', { className: 'vs-mp-drawer-head' },
					// ★ 2026-10-23：可选图标（详情抽屉用大号，与卡片上的视觉块呼应）
					props.icon || null,
					h('div', null,
						h('div', { className: 'vs-mp-drawer-title' }, props.title),
						props.subtitle ? h('div', { className: 'vs-mp-drawer-meta' }, props.subtitle) : null
					),
					h('button', { className: 'vs-mp-x', onClick: props.onClose, title: '关闭' }, '×')
				),
				props.children
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
		if (installed) {
			actions.push(h('button', {
				key: 'i',
				className: 'vs-mp-btn',
				disabled: true,
				title: '已安装' + (installedVer ? ' v' + installedVer : '') + '；要重装请先在「已安装」页签卸载'
			}, '已安装'));
		} else if (perm.canPublish !== false) {
			actions.push(h('button', { key: 'i', className: 'vs-mp-btn primary', onClick: props.onInstall }, '安装'));
		}
		if (perm.canEdit !== false) {
			actions.push(h('button', { key: 'e', className: 'vs-mp-btn', onClick: props.onEdit }, '编辑信息'));
		}
		if (perm.canDelete !== false) {
			actions.push(h('button', { key: 'u', className: 'vs-mp-btn danger', onClick: props.onUninstall }, '卸载'));
			actions.push(h('button', { key: 'd', className: 'vs-mp-btn danger', onClick: props.onDeletePackage }, '下架整个包'));
		}

		return h(Drawer, {
			// 有缩略图就显示大图（与卡片一致）；没有才用 emoji 图标
			icon: isImageIcon(d.cover) ? null : h(PkgIcon, { key: 'icon', pkg: d, large: true }),
			title: textOf(d.name) || textOf(d.slug),
			subtitle: [KIND_LABEL[d.kind] || String(d.kind || ''), textOf(d.author) || '暂无', d.version ? 'v' + String(d.version) : '']
				.filter(Boolean).join(' · '),
			onClose: props.onClose
		},
			// 详情里放一张较大的缩略图（与 colorskill 的商品页一致）
			h(PkgCover, { key: 'cover', pkg: d }),
			h('div', { className: 'vs-mp-tagrow' },
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
							perm.canDelete !== false
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
		var pickOptions = st.items.length === 0
			? [h('option', { key: 'none', value: '' }, '（本机没有可发布的 skill / workflow）')]
			: st.items.map(function (it) {
				var value = it.kind + '|' + it.localId;
				var label = (KIND_LABEL[it.kind] || it.kind) + ' · ' + it.localId + (it.version ? ' (v' + it.version + ')' : '');
				return h('option', { key: value, value: value }, label);
			});
		var kindOptions = ['skill', 'agent', 'mcp', 'workbench', 'workflow', 'knowledge'].map(function (k) {
			return h('option', { key: k, value: k }, KIND_LABEL[k] || k);
		});

		return h(Drawer, {
			title: '发布到商城',
			subtitle: github
				? '本体就是一个 GitHub 地址 —— 只登记来源，不打包上传（安装时从 GitHub 取）'
				: '从本机已装资源打包上传（skill / workflow 由 dsh 侧打包）',
			onClose: props.onClose
		},
			h('div', { className: 'vs-mp-form' },
				// ★ 2026-10-22（用户需求）：来源二选一 —— 打包上传 / GitHub 地址
				h('div', { className: 'vs-mp-srcseg' },
					h('button', {
						className: 'vs-mp-btn' + (github ? '' : ' primary'),
						onClick: function () { props.onChange({ mode: 'local', error: '' }); }
					}, '从本机打包'),
					h('button', {
						className: 'vs-mp-btn' + (github ? ' primary' : ''),
						onClick: function () { props.onChange({ mode: 'github', error: '' }); }
					}, 'GitHub 地址')
				),
				github ? [
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
				h('div', { className: 'vs-mp-drawer-actions' },
					h('button', { className: 'vs-mp-btn primary', disabled: st.busy, onClick: props.onSubmit }, st.busy ? '发布中…' : '发布'),
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

		var pageRef = useRef(1);

		/** 拉一页（append=true 时追加，不打断已看到的内容）。 */
		var fetchPage = useCallback(async function (pageToLoad, append) {
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

			var res = await action(op, params);
			setBusy(false);
			if (!res || res.ok === false) {
				if (!append) { setItems([]); setTotal(0); }
				setMsg({ kind: 'error', text: String((res && res.error) || '商城清单取不到') });
				return;
			}
			var got = Array.isArray(res.items) ? res.items : [];
			var paginated = op === 'list';
			setItems(function (prev) { return append && paginated ? prev.concat(got) : got; });
			setTotal(Number(res.total) || got.length);
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

		// 换页签 / 类型 / 分类 / 排序 / 搜索词 ⇒ 从第一页重来
		useEffect(function () {
			void fetchPage(1, false);
		}, [fetchPage]);

		/** 统一的动作执行（失败如实显示）。 */
		async function run(op, params, okText) {
			setBusy(true);
			var res = await action(op, params);
			setBusy(false);
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: String((res && res.error) || '操作失败') });
				return null;
			}
			if (okText) { setMsg({ kind: 'ok', text: okText }); }
			void fetchPage(1, false);
			return res;
		}

		async function openDetail(slug) {
			var res = await action('detail', { slug: slug });
			if (!res || res.ok === false) {
				setMsg({ kind: 'error', text: String((res && res.error) || '详情取不到') });
				return;
			}
			setDetail(res);
		}

		/**
		 * 从详情抽屉里安装：装完把抽屉自己也刷新一遍。
		 *
		 * ★ 2026-10-29：`run()` 只重拉列表 ⇒ 抽屉里那份 `detail` 还是旧的
		 *   ⇒ 点完「安装」按钮原地不动（用户会以为没装上，再点一次）✗
		 */
		async function installFromDetail() {
			if (!detail) { return; }
			var slug = detail.slug;
			var res = await onInstall(detail);
			if (res) { await openDetail(slug); }
		}

		/** 打开发布表单（先拿本机可发布资源）。 */
		async function openPublish() {
			setPub({
				mode: 'local', items: [], pick: '', version: '', changelog: '', busy: true, error: '',
				// GitHub 源模式专用（★ 2026-10-22）
				kind: 'skill', slug: '', source: '', name: '', description: '',
			});
			var res = await action('publishables', {});
			var list = (res && res.ok !== false && Array.isArray(res.items)) ? res.items : [];
			setPub({
				mode: 'local',
				items: list,
				pick: list.length ? (list[0].kind + '|' + list[0].localId) : '',
				version: list.length ? String(list[0].version || '') : '',
				changelog: '',
				busy: false,
				error: (res && res.ok === false) ? String(res.error || '列不出本机资源')
					: (list.length ? '' : '本机没有可发布的 skill / workflow —— 可以把「来源」切到 GitHub 地址'),
				kind: 'skill', slug: '', source: '', name: '', description: '',
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
				kind: r.kind || pub.kind || 'skill',
				inspectNote: '已识别 ' + r.repo + '（版本来自 ' + r.versionFrom + '）'
					+ (r.kind ? ' · 类型判定：' + r.kind : ' · 类型没判定出来，请手选')
					+ (Array.isArray(r.notes) && r.notes.length ? ' · ' + r.notes.join('；') : ''),
			}));
		}

		async function submitPublish() {
			if (!pub) { return; }
			var github = pub.mode === 'github';
			var k;
			var localId;
			if (github) {
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
			setPub(Object.assign({}, pub, { busy: true, error: '' }));
			var params = { kind: k, localId: localId, slug: localId, version: version, changelog: pub.changelog || '' };
			if (github) {
				// 本体就是一个 GitHub 地址 ⇒ 只登记来源，不打包上传
				params.source = String(pub.source || '').trim();
				if (textOf(pub.name).trim()) { params.name = textOf(pub.name).trim(); }
				if (textOf(pub.description).trim()) { params.description = textOf(pub.description).trim(); }
			}
			var res = await action('publish', params);
			if (!res || res.ok === false) {
				setPub(Object.assign({}, pub, { busy: false, error: String((res && res.error) || '发布失败') }));
				return;
			}
			setPub(null);
			setMsg({
				kind: 'ok',
				text: '已发布 ' + localId + ' v' + String(res.version || version) + (github ? '（外部源：安装时从 GitHub 取）' : ''),
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

		// 卡片/抽屉上的动作（集中一处，避免每个组件各拼一遍参数）
		// ⚠ 返回 promise：详情抽屉装完要据此刷新自己的状态（见 installFromDetail）
		var onInstall = function (pkg) { return run('install', { kind: pkg.kind, slug: pkg.slug }, '已安装（部分资源需要重启后才生效）'); };
		var onUpgrade = function (pkg) { return run('upgrade', { kind: pkg.kind, slug: pkg.slug }, '已升级（部分资源需要重启后才生效）'); };
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

		var more = items.length < total && tab !== 'admin' && tab !== 'installed';

		return h('div', { className: 'vs-mp-wrap' },
			// ── 页头 ──────────────────────────────────────────────
			h('header', { className: 'vs-mp-head' },
				h('div', null,
					h('h1', null, '商城工作台'),
					h('p', { className: 'vs-mp-sub' }, 'Agent / Skill / 工作台 / 工作流 —— 安装、升级、发布与维护')
				),
				h('div', { className: 'vs-mp-tools' },
					h('input', {
						className: 'vs-mp-input',
						placeholder: '搜索名称 / 介绍 / 标识',
						value: qInput,
						onChange: function (e) { setQInput(e.target.value); },
						onKeyDown: function (e) { if (e.key === 'Enter') { setQ(String(qInput).trim()); } }
					}),
					h('select', {
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
					h('div', { className: 'vs-mp-size', title: '卡片大小', role: 'group', 'aria-label': '卡片大小' },
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
					h('button', { className: 'vs-mp-btn', onClick: function () { setMsg(null); void fetchPage(1, false); } }, '刷新'),
					h('button', { className: 'vs-mp-btn primary', onClick: openPublish }, '发布')
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

			h('div', { className: 'vs-mp-count' },
				'已显示 ' + items.length + ' / 共 ' + total + ' 个商品',
				more ? h('button', { className: 'vs-mp-link', disabled: busy, onClick: function () { void fetchPage(pageRef.current + 1, true); } }, busy ? '加载中…' : '加载更多') : null
			),

			items.length === 0
				? h('div', { className: 'vs-mp-empty' }, busy ? '正在加载…' : '没有找到匹配的商品。')
				// ★ 2026-10-23：列数由 `--vs-mp-card-min` 决定（auto-fill ⇒ 档位一变自动重排）
				: h('div', { className: 'vs-mp-grid', style: { '--vs-mp-card-min': sizeMin + 'px' } }, items.map(function (pkg) {
					return h(Card, {
						key: (pkg.kind || '') + ':' + String(pkg.slug || pkg.id || ''),
						pkg: pkg,
						showUninstall: tab === 'installed',
						adminActions: tab === 'admin',
						onDetail: openDetail,
						onInstall: onInstall,
						onUpgrade: onUpgrade,
						onUninstall: onUninstall,
						onReview: onReview,
						onFeature: onFeature
					});
				})),

			// ── 抽屉 ──────────────────────────────────────────────
			detail ? h(DetailDrawer, {
				detail: detail,
				onClose: function () { setDetail(null); },
				onInstall: function () { void installFromDetail(); },
				onUninstall: function () { onUninstall(detail); },
				onEdit: function () {
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
					void run('deletePackage', { kind: detail.kind, slug: detail.slug }, '已下架');
					setDetail(null);
				},
				onDeleteVersion: function (version) {
					void run('deleteVersion', { kind: detail.kind, slug: detail.slug, version: version }, '已下架该版本');
				}
			}) : null,

			pub ? h(PublishDrawer, {
				state: pub,
				onClose: function () { setPub(null); },
				onChange: function (patch) { setPub(Object.assign({}, pub, patch, { error: '' })); },
				onSubmit: submitPublish,
				// ★ 2026-10-27：贴 GitHub 链接 ⇒ 自动识别并回填
				onInspect: inspectGithub
			}) : null,

			edit ? h(EditDrawer, {
				state: edit,
				onClose: function () { setEdit(null); },
				onChange: function (patch) { setEdit(Object.assign({}, edit, patch, { error: '' })); },
				onSubmit: submitEdit
			}) : null
		);
	}

	ReactDOM.createRoot(root).render(h(App));
})();
