// @vssaros/dsh-dashboard — 页面侧交互（**浏览器脚本**）。
//
// ⚠ 这个文件**不是模块**、也**不该被 import**：它是纯浏览器脚本，由 `lib/index.js` 用
// `readFileSync` 读成文本、整段嵌进 `<script>` ✓。这样做的理由很实际——页面是模板字符串拼的，
// 客户端代码如果写在里面，**一个反引号就会把整页提前闭合**（本仓已因此踩过两次 ✗）；独立文件里
// 随便用模板字符串 / 反引号，且能被 `node --check` 单独语法校验 ✓。
//
// 交互范围（P3，刻意留白的地方都写清了）：
//   · **编辑模式**：点「编排」进入 ⇒ 卡片可拖、可缩放、可移除，并出现「添加组件」画廊；
//   · **拖拽换位**：Pointer Events + `setPointerCapture`（触屏同源）+ 落点前后半判定 + **FLIP** 动画
//     ⇒ 松手时把新顺序 POST 上去（不整页刷新，拖拽手感是连续的 ✓）；
//   · **缩放**：右下角手柄，宽按列步进、高按行步进（`h` = **最小高度**，见 `layout.js` 的注释）；
//   · **添加 / 移除**：POST 之后**整页重载**（新卡的服务端 HTML 只有服务端会渲染 —— 与其在客户端
//     复制一套组件渲染，不如刷新一次 ✓；拖拽/缩放**不**刷新，那条路径 DOM 已经在了 ✓）。
//
// 刻意**不做**：多选、撤销/重做、自由坐标（拖到任意像素）、自动保存（都是"看着想要、用起来添乱"的
// 那一类；调研里 R10 也是这个口径 ✓）。
(function () {
	'use strict';

	var grid = document.querySelector('[data-dash-grid]');
	if (!grid) {
		return;
	}
	var GRID_COLUMNS = 12;
	var MAX_ROWS = 30;
	var API = grid.getAttribute('data-dash-api') || 'api/layout';

	function readJson(selector) {
		var el = document.querySelector(selector);
		if (!el) {
			return undefined;
		}
		try {
			return JSON.parse(el.textContent);
		} catch (e) {
			return undefined;
		}
	}

	var state = {
		layout: readJson('[data-dash-layout-json]') || { items: [] },
		catalog: readJson('[data-dash-catalog-json]') || [],
		editing: false,
		saving: false
	};
	if (!Array.isArray(state.layout.items)) {
		state.layout.items = [];
	}

	function items() {
		return state.layout.items;
	}

	function cards() {
		return Array.prototype.slice.call(grid.querySelectorAll('.dash-w'));
	}

	function cardById(id) {
		return grid.querySelector('.dash-w[data-dash-id="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
	}

	function status(text) {
		var el = document.querySelector('[data-dash-status]');
		if (el) {
			el.textContent = text || '';
		}
	}

	// ── 落盘 ──────────────────────────────────────────────────────────────────
	// CAS：递上"我读到的 updatedAt"；服务端在锁内比对，不一致回 409 ⇒ 这里**整页重载**拿最新布局 ✓
	// （宁可让用户重来一次，也不静默覆盖别人的改动 ✗）。

	/** 正在跑的那次保存（`Promise<boolean>`；true = 服务端**确实接受**了 ✓）。 */
	var inFlight = null;
	/** 上一轮跑的时候又改过 ⇒ 跑完再存一次（下一轮读的是**最新** items ✓，所以合并是安全的 ✓）。 */
	var dirty = false;

	function doSave() {
		state.saving = true;
		status('保存中…');
		return fetch(API, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ updatedAt: state.layout.updatedAt || 0, items: items() })
		}).then(function (res) {
			return res.json().catch(function () { return {}; }).then(function (body) {
				if (res.status === 409) {
					status('布局已被其它窗口改过，正在重新载入…');
					setTimeout(function () { window.location.reload(); }, 700);
					return false;
				}
				if (!res.ok) {
					status('保存失败：' + (body.error || res.status));
					return false;
				}
				state.layout.updatedAt = body.updatedAt;
				// ★ 2026-10-13：采纳写口回传的**归一化 items**（= 真正落盘的那份 ✓）。不采纳的话，客户端
				//   手里那份（读盘时的）与盘上会错位 ⇒ 用户"删一个再存回去"时盘上却是另一份东西 ✗
				//   （现象：状态位显示"已保存"、卡片却还在 —— 就是本轮用户报的那个 ✓）。
				if (Array.isArray(body.items)) {
					state.layout.items = body.items;
				}
				var repaired = body.repaired && body.repaired.length ? '（' + body.repaired.length + ' 处被纠正）' : '';
				status('已保存 ' + new Date().toLocaleTimeString() + repaired);
				return true;
			});
		}).catch(function (e) {
			status('保存失败：' + (e && e.message ? e.message : e));
			return false;
		}).then(function (ok) {
			state.saving = false;
			return ok;
		});
	}

	/**
	 * 保存布局；**返回 `Promise<boolean>`：true = 真的写进去了** ✓。
	 *
	 * ⚠ 2026-10-13 用户报「删除按钮不生效」的**根因**（我在真浏览器里复现过 ✓）。旧实现三处叠加：
	 *   ① 已有保存在跑时 **静默丢弃** 这次调用（`return Promise.resolve()` ✗）—— 丢弃的那次**永远不会落盘**；
	 *   ② 失败路径被 `catch` 吞掉后**照样 resolve** ✗（调用方分不清成没成）；
	 *   ③ `addWidget` / `removeWidget` 写的是 `save().then(reload)` ⇒ **无条件刷新** ✗。
	 *   ⇒ 点 ✕ ：（丢弃 or 失败）⇒ 刷新 ⇒ 卡片原样回来 ⇒ 用户看到的就是"点了没反应" ✓。
	 * 现在：并发调用**合并**（跑完再补一次，读最新 items ✓ 不丢 ✗），并把"成没成"如实返回 ✓；
	 *   两个刷新点改成**由结果门控** ✓（失败就不刷新，页面上那条原因留在状态位里 ✓）。
	 */
	function save() {
		if (inFlight) {
			dirty = true;
			return inFlight.then(function () {
				dirty = false;
				return save();
			});
		}
		inFlight = doSave().then(function (ok) {
			inFlight = null;
			return ok;
		});
		return inFlight;
	}

	// ── 顺序：与服务端 `layout.js` 的 `moveBefore` **同语义**（含 `before > from` 要 -1 那个坑 ✓）──
	function moveBeforeLocal(id, beforeId) {
		var list = items();
		var from = -1;
		var before = beforeId === null ? list.length : -1;
		for (var i = 0; i < list.length; i++) {
			if (list[i].id === id) { from = i; }
			if (beforeId !== null && list[i].id === beforeId) { before = i; }
		}
		if (from < 0 || before < 0 || id === beforeId) {
			return false;
		}
		var to = before > from ? before - 1 : before;
		if (to === from) {
			return false;
		}
		var moved = list.splice(from, 1)[0];
		list.splice(to, 0, moved);
		return true;
	}

	/** 按 `items()` 的顺序重排 DOM，并对已有卡片做 **FLIP** 动画（新卡片没有"上一帧"⇒ 跳过 ✓）。 */
	function reorderDom() {
		var before = new Map();
		cards().forEach(function (card) { before.set(card, card.getBoundingClientRect()); });
		items().forEach(function (item) {
			var card = cardById(item.id);
			if (card) {
				grid.appendChild(card); // appendChild 会移动已存在的节点 ⇒ 一遍就把顺序摆好 ✓
			}
		});
		cards().forEach(function (card) {
			var first = before.get(card);
			if (!first) {
				return;
			}
			var last = card.getBoundingClientRect();
			var dx = first.left - last.left;
			var dy = first.top - last.top;
			if (!dx && !dy) {
				return;
			}
			card.animate(
				[{ transform: 'translate(' + dx + 'px, ' + dy + 'px)' }, { transform: 'none' }],
				{ duration: 160, easing: 'ease-out' }
			);
		});
	}

	/** 落点卡 + 前后半：先比纵向（网格是行优先），同高再比横向 ✓。 */
	function placementFor(x, y, dragged) {
		var best = null;
		var bestGap = Infinity;
		cards().forEach(function (card) {
			if (card === dragged) {
				return;
			}
			var rect = card.getBoundingClientRect();
			var outsideX = x < rect.left ? rect.left - x : (x > rect.right ? x - rect.right : 0);
			var outsideY = y < rect.top ? rect.top - y : (y > rect.bottom ? y - rect.bottom : 0);
			var gap = outsideX + outsideY; // 0 = 指针就落在这张卡里 ✓
			if (gap < bestGap) {
				bestGap = gap;
				best = { card: card, centerX: rect.left + rect.width / 2, centerY: rect.top + rect.height / 2 };
			}
		});
		if (!best) {
			return null;
		}
		var where;
		if (y < best.centerY) {
			where = 'before';
		} else if (y > best.centerY) {
			where = 'after';
		} else {
			where = x < best.centerX ? 'before' : 'after';
		}
		return { id: best.card.getAttribute('data-dash-id'), where: where };
	}

	function beforeIdFor(candidateId, where) {
		if (where === 'before') {
			return candidateId;
		}
		var order = cards().map(function (card) { return card.getAttribute('data-dash-id'); });
		var index = order.indexOf(candidateId);
		return index >= 0 && index + 1 < order.length ? order[index + 1] : null; // null = 放到末尾 ✓
	}

	// ── 拖拽换位 ──────────────────────────────────────────────────────────────
	function startDrag(event, card) {
		var id = card.getAttribute('data-dash-id');
		if (!id) {
			return;
		}
		event.preventDefault();
		// ⚠ 指针捕获只是**优化**（指针移出卡片后仍收得到事件）：合成事件、以及部分宿主里
		//   `setPointerCapture` 会抛 `NotFoundError` ⇒ **必须容错**，否则整个拖拽在第一步就断 ✗
		//   （2026-10-13 真浏览器验证时实测到的）。监听器一律挂 `document` ⇒ 没有捕获也能走完 ✓。
		try {
			card.setPointerCapture(event.pointerId);
		} catch (e) {
			/* 忽略：靠 document 上的监听器继续 */
		}
		card.classList.add('dash-dragging');
		var startX = event.clientX;
		var startY = event.clientY;
		var last = null;

		function clearMarks() {
			cards().forEach(function (other) { other.removeAttribute('data-dash-drop'); });
		}
		function onMove(moveEvent) {
			card.style.transform = 'translate(' + (moveEvent.clientX - startX) + 'px, ' + (moveEvent.clientY - startY) + 'px)';
			clearMarks();
			last = null;
			var placement = placementFor(moveEvent.clientX, moveEvent.clientY, card);
			if (placement) {
				var target = cardById(placement.id);
				if (target) {
					target.setAttribute('data-dash-drop', placement.where);
				}
				last = placement;
			}
		}
		function onUp() {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onUp);
			card.style.transform = '';
			card.classList.remove('dash-dragging');
			clearMarks();
			status('');
			if (!last) {
				return;
			}
			if (moveBeforeLocal(id, beforeIdFor(last.id, last.where))) {
				reorderDom();
				save();
			}
		}
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onUp);
	}

	// ── 缩放（宽按列、高按行）──────────────────────────────────────────────────
	function startResize(event, card) {
		var id = card.getAttribute('data-dash-id');
		var item = null;
		items().forEach(function (entry) { if (entry.id === id) { item = entry; } });
		if (!item) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		// ⚠ 不能用 `event.currentTarget`：本函数是从 **grid** 的 pointerdown 监听器里调的 ⇒ 那里
		//   `currentTarget` 是 grid、不是手柄 ✗（2026-10-13 复核时发现；改用 target 上找）。
		var handle = event.target.closest('[data-dash-resize]');
		try {
			handle.setPointerCapture(event.pointerId);
		} catch (e) {
			/* 同 startDrag：捕获是优化，不是前提 ✓ */
		}
		var startX = event.clientX;
		var startY = event.clientY;
		var startW = item.w;
		var startH = item.h;
		var gridRect = grid.getBoundingClientRect();
		var colPitch = gridRect.width / GRID_COLUMNS;
		var style = window.getComputedStyle(grid);
		var gap = parseFloat(style.gap) || 0;
		var row = parseFloat(style.getPropertyValue('--dash-row')) || 24;
		var rowPitch = row + gap;

		function apply(w, h) {
			item.w = w;
			item.h = h;
			card.style.gridColumn = 'span ' + w;
			card.style.minHeight = 'calc(' + h + ' * var(--dash-row) + ' + (h - 1) + ' * var(--dash-gap, 0px))';
			status(w + ' 列 × ' + h + ' 行');
		}
		function onMove(moveEvent) {
			var w = Math.max(1, Math.min(GRID_COLUMNS, startW + Math.round((moveEvent.clientX - startX) / colPitch)));
			var h = Math.max(1, Math.min(MAX_ROWS, startH + Math.round((moveEvent.clientY - startY) / rowPitch)));
			apply(w, h);
		}
		function onUp() {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onUp);
			var label = card.querySelector('[data-dash-size]');
			if (label) {
				label.textContent = item.w + '×' + item.h;
			}
			save();
		}
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onUp);
	}

	// ── 编辑模式 / 添加 / 移除 ────────────────────────────────────────────────
	function setEditing(on) {
		state.editing = !!on;
		document.body.classList.toggle('dash-editing', state.editing);
		// ★ 2026-10-13（用户："添加完组件，点击完成后，组件列表 UI 没有消失"）：退出编辑态**收起画廊** ✓
		//   —— 「＋ 添加组件」按钮本来就只在编辑态可见（CSS ✓），留着那个面板就是个"没有入口、也关不掉"的
		//   孤儿 ✗（用户的截图正是：已经回到「编排」，画廊面板还摊在网格上面 ✓）。
		if (!state.editing) {
			var galleryPanel = document.querySelector('[data-dash-gallery]');
			if (galleryPanel) {
				galleryPanel.setAttribute('hidden', '');
			}
		}
		// ★ 2026-10-13（用户："编辑过后，点击完成按钮没有反应"）：**必须按"稳定锚点"找这个按钮** ——
		//   旧写法是 `querySelector('[data-dash-action="edit"]')` ✗，而**进入编辑态时这个属性正好被改成
		//   `done`** ⇒ 退出时那次查找**永远找不到** ⇒ 按钮既回不到「编排」、属性也留在 `done` ⇒
		//   表现就是"点完成没反应"，而且**再也进不去编辑态**（单向卡死 ✗✓）。
		//   现在改用服务端就渲染好的 `data-dash-edit-toggle`，与 action 来回切换**解耦** ✓。
		var label = document.querySelector('[data-dash-edit-toggle]');
		if (label) {
			label.textContent = state.editing ? '完成' : '编排';
			label.setAttribute('data-dash-action', state.editing ? 'done' : 'edit');
		}
		status(state.editing ? '拖动卡片换位 · 右下角手柄缩放' : '');
	}

	function uniqueId(kind) {
		var used = {};
		items().forEach(function (item) { used[item.id] = true; });
		var base = 'w-' + kind;
		if (!used[base]) {
			return base;
		}
		var n = 2;
		while (used[base + '-' + n]) {
			n += 1;
		}
		return base + '-' + n;
	}

	function addWidget(kind) {
		var entry = null;
		state.catalog.forEach(function (item) { if (item.kind === kind) { entry = item; } });
		// ★ 2026-10-13（用户："不允许重复添加组件"）：同一 kind 只留一张 ✓。
		//   ⚠ 服务端 `layout.js` 的 `normalizeLayout` 才是**权威**（写口 / 渲染口都经过它 ✓）；这里补一次
		//   是为了**当场说清楚**，而不是"点了没反应、刷新后才发现" ✗（画廊上的「已添加」标记只管"看得见" ✓）。
		var already = items().some(function (item) { return item.kind === kind; });
		if (already) {
			status('「' + widgetName(kind) + '」已经在页面上了（不允许重复添加）');
			return;
		}
		var added = {
			id: uniqueId(kind),
			kind: kind,
			w: entry ? entry.w : GRID_COLUMNS,
			h: entry ? entry.h : 1,
			config: {}
		};
		items().push(added);
		// ★ 2026-10-13（用户第 4 条："添加组件，选择添加一个组件，没有刷新出来"）：HTML 仍然由**服务端**渲染 ✓，
		//   但**不再靠整页重载**去拿它 ✗ —— 宿主里的 `location.reload()` 不保证给出新渲染（与"删除不生效"同源 ✓）。
		//   改成：保存成功后**取回本页 HTML**（同一条路由 ⇒ 同一表面、同一范围 ✓）⇒ 挑出那张新卡片插进网格 ✓。
		//   ⚠ 需要客户端小件的组件（时钟 / 番茄：初始化只在页面加载时跑一次）⇒ 这一版**退化成整页重载** ✓
		//   （宁可慢一点，也不要插一张"不走"的时钟 ✗）。
		save().then(function (ok) {
			if (!ok) {
				return; // 没写进去 ⇒ 不动界面、不装作成功 ✓（原因在状态位上 ✓）
			}
			if (kind === 'clock' || kind === 'pomodoro') {
				window.location.reload();
				return;
			}
			insertCardFromServer(added.id, added.kind)['catch'](function (e) {
				// 取不回来（断网 / 路由出错 / 服务端没给出这张卡）⇒ 退化成整页重载 ✓（不静默吞掉 ✗）
				status('新卡片已保存，但取回渲染失败（' + (e && e.message ? e.message : e) + '）⇒ 正在整页重载');
				window.location.reload();
			});
		});
	}

	/**
	 * 从服务端取回**那张卡片的 HTML** 并插进网格（**不整页重载** ✓）。
	 *
	 * ★ 2026-10-13：与"删除就地删 DOM"同一条思路 —— 界面的更新不依赖整页重载 ✗。
	 *   ⚠ 仍然**不复制**组件渲染逻辑：HTML 由服务端出 ✓（只做"取回来、插进去"）。
	 *   ⚠ 取的是 `window.location.href` 本身 ⇒ 拿到的正是**同一表面 / 同一范围**的版本 ✓
	 *     （侧栏版没有网格、也不会走到这里 —— 它没有编排界面 ✓）。
	 */
	function insertCardFromServer(id, kind) {
		return fetch(window.location.href, { cache: 'no-store' }).then(function (res) {
			if (!res.ok) {
				throw new Error('HTTP ' + res.status);
			}
			return res.text();
		}).then(function (html) {
			var doc = new DOMParser().parseFromString(html, 'text/html');
			var fresh = doc.querySelector('.dash-w[data-dash-id="' + String(id).replace(/["\\]/g, '\\$&') + '"]');
			if (!fresh) {
				throw new Error('服务端返回的页面里没有这张卡片（' + id + '）');
			}
			grid.appendChild(fresh);
			// ⚠ `kind` 由调用方给：卡片的属性是 `data-dash-widget`（**不是** `data-dash-kind` ✗）——
			//   我第一版就是从卡片上读 `data-dash-kind` ⇒ 永远拿到 null ⇒ 画廊标记被静默跳过 ✓
			//   （真浏览器端到端测出来的：卡片插进来了、画廊那项却没变「已添加」✓）。
			markGallery(kind, true);
			grid.setAttribute('data-dash-count', String(items().length));
			return true;
		});
	}

	/** kind → 人类可读名（画廊目录里取；取不到就退回 kind 本身 ✓）。 */
	function widgetName(kind) {
		var name = null;
		state.catalog.forEach(function (item) { if (item.kind === kind) { name = item.name; } });
		return name || kind;
	}

	/**
	 * 删成功后**就地**从界面上抹掉那张卡（**不重载页面**）。
	 *
	 * ★ 2026-10-13 用户**第二次**报"删除按钮不生效"，现场与第一次不同 ✗：
	 *   第一次 = 保存失败/被丢弃却无条件刷新（已修 ✓）；这一次 = **盘上真的删掉了、状态位也显示"已保存"，
	 *   但页面没变** ✓ —— 也就是"界面更新"被寄托在整页重载上，而宿主里的 `location.reload()` 不保证
	 *   给出新渲染 ✗。这条路上再好的服务端也救不了 ⇒ 改成**就地更新** ✓（还不闪屏 ✓）。
	 *   ⚠ 只删**服务端渲染好的那个节点**本身，不复制组件渲染逻辑 ✓（"新增走重载、删除走就地"是同一条分工 ✓）。
	 *   ⚠ 拖拽/缩放/再保存读的都是 `state.layout.items`（内存 ✓，不是 DOM ✗）⇒ 删 DOM 的同时必须已经把
	 *     内存里那条删掉 ✓（调用方在 `removeWidget` 里先做 ✓），否则下一次拖拽会把它写回去 ✗。
	 */
	function removeCardFromDom(id, kind) {
		var card = cardById(id);
		if (card && card.parentNode) {
			card.parentNode.removeChild(card);
		}
		// 画廊里那一项**取消"已添加"标记**（否则刚删掉的组件会一直显示"已经在页面上"，想加也加不回来 ✗）
		markGallery(kind, false);
		grid.setAttribute('data-dash-count', String(items().length));
	}

	/**
	 * 画廊里某个组件的「已添加」标记开 / 关（**添加成功与删除成功都要同步** ✓）。
	 *
	 * ⚠ 这里必须同时改三样：`data-dash-added` 属性、`is-added` 类、说明文字 —— 少改一样就会出现
	 *   "看着能加、点了没反应"或"看着已添加、其实不在页面上"这类**错位** ✗（两边各写一份早晚漂移 ✓）。
	 */
	function markGallery(kind, on) {
		if (!kind) {
			return;
		}
		var entry = document.querySelector('[data-dash-kind="' + String(kind).replace(/["\\]/g, '\\$&') + '"]');
		if (!entry) {
			return;
		}
		var small = entry.querySelector('small');
		var spec = null;
		state.catalog.forEach(function (item) { if (item.kind === kind) { spec = item; } });
		if (on) {
			entry.setAttribute('data-dash-added', '1');
			entry.setAttribute('aria-disabled', 'true');
			entry.classList.add('is-added');
			if (small) {
				small.textContent = '已经在页面上（不允许重复添加）';
			}
			return;
		}
		entry.removeAttribute('data-dash-added');
		entry.removeAttribute('aria-disabled');
		entry.classList.remove('is-added');
		if (small && spec) {
			small.textContent = spec.description + ' · ' + spec.w + '×' + spec.h;
		}
	}

	function removeWidget(id) {
		var target = null;
		items().forEach(function (item) { if (item.id === id) { target = item; } });
		// ★ 诊断（第二次反馈时加的）：把"为什么没删掉"**明说**，别让它静默 ✗ ——
		//   ① 拿不到 id ⇒ 卡片的 `data-dash-id` 丢了（页面被谁改坏了）；
		//   ② id 不在布局里 ⇒ **页面与磁盘错位**（本页读到的 items 里没有它 ⇒ 过滤会变成空操作、
		//      还会把原样数据 POST 回去 ⇒ 表现正是"显示已保存、卡片却还在"✗）。这两种都必须说出来 ✓。
		if (!id) {
			status('没能定位这张卡（卡片上没有 id）—— 请刷新页面后重试');
			return;
		}
		if (!target) {
			status('这张卡不在当前布局里（' + id + '）—— 页面可能已过期，请刷新后重试');
			return;
		}
		state.layout.items = items().filter(function (item) { return item.id !== id; });
		save().then(function (ok) {
			if (!ok) {
				return; // 没写进去 ⇒ 不装作删掉了 ✓（原因留在状态位上 ✓）
			}
			removeCardFromDom(id, target.kind);
			status('已移除「' + widgetName(target.kind) + '」');
		});
	}

	// ── 2026-10-13 新增组件：时钟 / 番茄时钟 / 工作台动作 ───────────────────────────
	// ⚠ 本文件是**浏览器脚本**（由 index.js 读成文本整段嵌进页面 ✓，见文件头注释）。这里新增的东西
	//   一律**不落盘、不写任何文件** ✓（番茄/时钟是纯客户端状态；工作台动作只发桥命令 ✓）。
	var two = function (n) { return (n < 10 ? '0' : '') + n; };

	/** 页面那行状态位（`data-dash-status`，服务端渲染的 ✓）：给用户一句回执，别"点了没反应" ✗。 */
	function setStatus(text) {
		var el = document.querySelector('[data-dash-status]');
		if (el) { el.textContent = text; }
	}

	// 时钟：服务端已给初值 ⇒ 这里只让它走起来 ✓（页面上没这个组件时什么都不做 ✓）
	var clockTime = document.querySelector('[data-dash-clock-time]');
	var clockDate = document.querySelector('[data-dash-clock-date]');
	if (clockTime || clockDate) {
		var WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
		var tickClock = function () {
			var d = new Date();
			if (clockTime) { clockTime.textContent = two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds()); }
			if (clockDate) { clockDate.textContent = d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + WEEKDAY[d.getDay()]; }
		};
		tickClock();
		setInterval(tickClock, 1000);
	}

	// 番茄时钟：纯客户端（**刻意不落盘** —— 一旦要"关页面还继续计时"就得写文件 ⇒ 撞写入台账守卫 ✗）
	var pomo = document.querySelector('[data-dash-pomodoro]');
	var pomoApi;
	if (pomo) {
		var CIRC = 2 * Math.PI * 42;
		var FOCUS = (Number(pomo.getAttribute('data-dash-focus')) || 25) * 60;
		var BREAK = (Number(pomo.getAttribute('data-dash-break')) || 5) * 60;
		var left = FOCUS, running = false, onBreak = false, round = 1;
		var arc = pomo.querySelector('[data-dash-pomo-arc]');
		var timeEl = pomo.querySelector('[data-dash-pomo-time]');
		var phaseEl = pomo.querySelector('[data-dash-pomo-phase]');
		var toggleEl = pomo.querySelector('[data-dash-action="pomo-toggle"]');
		var renderPomo = function () {
			if (timeEl) { timeEl.textContent = two(Math.floor(left / 60)) + ':' + two(left % 60); }
			if (phaseEl) { phaseEl.textContent = (onBreak ? '休息' : '专注') + ' · 第 ' + round + ' 个'; }
			if (arc) {
				var total = onBreak ? BREAK : FOCUS;
				arc.setAttribute('stroke-dasharray', String(CIRC));
				arc.setAttribute('stroke-dashoffset', String(CIRC * (1 - left / total)));
				arc.setAttribute('stroke', onBreak ? '#89D185' : '#4EC9B0');
			}
			if (toggleEl) { toggleEl.textContent = running ? '暂停' : '开始'; }
		};
		setInterval(function () {
			if (!running) { return; }
			left -= 1;
			if (left <= 0) {
				if (!onBreak) { onBreak = true; left = BREAK; setStatus('专注结束 ⇒ 休息 ' + Math.round(BREAK / 60) + ' 分钟'); }
				else { onBreak = false; round = round >= 4 ? 1 : round + 1; left = FOCUS; setStatus(round === 1 ? '跑满 4 个 ⇒ 长休一会儿' : '休息结束 ⇒ 继续专注'); }
			}
			renderPomo();
		}, 1000);
		pomoApi = {
			toggle: function () { running = !running; renderPomo(); },
			reset: function () { running = false; onBreak = false; left = FOCUS; round = 1; renderPomo(); }
		};
		renderPomo();
	}

	/**
	 * 工作台动作：打开 / 固定到活动栏 / 从活动栏隐藏。
	 * ⚠ 后两个是**单向动作**：dsh 侧读不到 IDE 的 pin / 显隐状态（用户选 ③，零新通道）⇒ 卡片不回显状态 ✗，
	 *   所以文案是「固定到活动栏」而不是「已固定」✓。桥里没有该命令时**明说**，不装作成功 ✓。
	 */
	function workbenchAction(route, kind) {
		if (!route) { return; }
		var api = typeof window !== 'undefined' ? window.vssarosDsh : undefined;
		if (kind === 'open') {
			if (api && typeof api.openModulePage === 'function') { api.openModulePage(route); setStatus('已请求打开：' + route); return; }
			setStatus('这个 IDE 版本还不支持从页面打开模块页：' + route);
			return;
		}
		var fn = kind === 'pin' ? 'setWorkbenchPinned' : 'setWorkbenchHidden';
		var label = kind === 'pin' ? '固定到活动栏' : '从活动栏隐藏';
		if (api && typeof api[fn] === 'function') { api[fn](route, true); setStatus('已请求「' + label + '」：' + route); return; }
		setStatus('这个 IDE 版本还不支持「' + label + '」：' + route);
	}

	document.addEventListener('click', function (event) {
		var target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		var action = target.closest('[data-dash-action]');
		if (action) {
			event.preventDefault();
			var name = action.getAttribute('data-dash-action');
			if (name === 'pomo-toggle') {
				if (pomoApi) { pomoApi.toggle(); }
				return;
			} else if (name === 'pomo-reset') {
				if (pomoApi) { pomoApi.reset(); }
				return;
			} else if (name === 'open-module') {
				workbenchAction(action.getAttribute('data-dash-route') || '', 'open');
				return;
			} else if (name === 'pin-module') {
				workbenchAction(action.getAttribute('data-dash-route') || '', 'pin');
				return;
			} else if (name === 'hide-module') {
				workbenchAction(action.getAttribute('data-dash-route') || '', 'hide');
				return;
			}
			if (name === 'edit') {
				setEditing(true);
			} else if (name === 'done') {
				setEditing(false);
			} else if (name === 'gallery') {
				// ⚠ 2026-10-13 修复：这一支原先写在**下面那个 `return` 之后** ✗ —— 画廊按钮同样带
				//   `data-dash-action` ⇒ 一进上面那支就被 `return` 掉了 ⇒ 那段是**死代码**（表现：
				//   点「＋ 添加组件」没反应 ✗；而当时的探针只断言"画廊的 markup 在" ⇒ 抓不住 ✓）。
				//   ⇒ **所有 action 必须在同一处分派**（由 p3-46 的"第一次 return 之前必须分派完"钉住 ✓）。
				var panel = document.querySelector('[data-dash-gallery]');
				if (panel) {
					panel.toggleAttribute('hidden');
				}
			} else if (name === 'add') {
				addWidget(action.getAttribute('data-dash-kind'));
			} else if (name === 'remove') {
				var owner = action.closest('.dash-w');
				removeWidget(owner && owner.getAttribute('data-dash-id'));
			}
			return;
		}
	});

	grid.addEventListener('pointerdown', function (event) {
		if (event.button !== 0) {
			return;
		}
		var target = event.target;
		if (!(target instanceof Element)) {
			return;
		}
		// ★ 2026-10-13（用户："工作台的item缺少拖拽表现"）—— 真原因之一：条目**大部分面积是那三个操作按钮**
		//   ✗，而这一支原先排在 `[data-dash-action]` 判定**之后** ⇒ 在按钮上按下**根本不会开始拖** ✓
		//   （只有窄窄的名称/描述区能拖，看起来就像"拖不动" ✓）。
		//   ⇒ 现在**把工作台条目判在最前**（含按钮在内 ✓），由 `startWorkbenchDrag` 用"移动 ≥6px 才算拖"
		//   来区分"想拖条目"与"想点按钮" ✓，并在拖过之后吞掉那一次 click ✓（不会顺手触发按钮 ✗）。
		//   ⚠ 仍必须排在 `state.editing` 判定**之前**（非编辑态也允许 ✓）。
		var wbCard = target.closest('[data-dash-workbench] .wb-card');
		if (wbCard) {
			startWorkbenchDrag(event, wbCard);
			return;
		}
		if (target.closest('[data-dash-action]')) {
			return;
		}
		if (!state.editing) {
			return;
		}
		var handle = target.closest('[data-dash-resize]');
		if (handle) {
			startResize(event, handle.closest('.dash-w'));
			return;
		}
		var card = target.closest('.dash-w');
		if (card) {
			startDrag(event, card);
		}
	});

	// ── 工作台条目排序（★ 非编辑态也允许 ✓）───────────────────────────────────────────────
	/** 当前 DOM 里工作台条目的顺序（用 `data-dash-wb-route` ✓ —— 只认 DOM 事实，不猜别的 ✓）。 */
	function workbenchOrderInDom() {
		return Array.prototype.slice.call(document.querySelectorAll('[data-dash-workbench] .wb-card'))
			.map(function (card) { return card.getAttribute('data-dash-wb-route'); })
			.filter(function (route) { return !!route; });
	}

	/** 把拖后的顺序写进这张卡的 `config.order` 并落盘（复用布局写口 ✓，不新增通道 ✓）。 */
	function persistWorkbenchOrder() {
		var holder = document.querySelector('[data-dash-workbench]');
		var card = holder ? holder.closest('.dash-w') : null;
		var id = card ? card.getAttribute('data-dash-id') : null;
		var item = null;
		items().forEach(function (entry) { if (entry.id === id) { item = entry; } });
		if (!item) {
			// 与删除同款诊断：拿不到卡片/条目就**明说**（不静默 ✗）
			status('顺序拖好了，但这张卡不在当前布局里（' + id + '）—— 页面可能已过期，请刷新后重试');
			return;
		}
		item.config = item.config && typeof item.config === 'object' ? item.config : {};
		item.config.order = workbenchOrderInDom();
		save().then(function (ok) {
			if (ok) {
				status('工作台顺序已保存');
			}
		});
	}

	/**
	 * 造一个**浮层克隆**（跟着指针走的那条）—— **B 版「空槽跟手」＋ 方案 3 的跟手方式** ✓。
	 *
	 * ⚠ 四件事必须一起做，否则"跟手"必出问题：
	 *   ① `position: fixed`（CSS ✓）⇒ 相对视口定位 ✓；
	 *   ② 浮层**必须** `pointer-events: none`（CSS ✓）⇒ 否则它会把指针事件全吃掉、拖到一半就断 ✗；
	 *   ③ 挂在 `document.body` 上 ⇒ 不能留在 `.wb-grid` 里（那会参与布局、把落点算歪 ✗）；
	 *   ④ ★ 位置**只**由 `transform: translate3d()` 给（CSS 里 `left/top` 固定 0 ✓）⇒ 交给**合成层**、
	 *      不触发布局（最跟手 ✓）。⚠ **绝不要**再写 `left/top` ✗ —— 之前横向取"空槽的 left"，
	 *      空槽一换列就跟着跳，实测偏差 **283px** ✓（用户："非常不跟手" ✓）。
	 */
	function makeWorkbenchGhost(card, rect) {
		var ghost = card.cloneNode(true);
		ghost.classList.remove('wb-slot');
		ghost.classList.add('wb-ghost');
		// 只给尺寸；位置一律交给 translate3d（见 startWorkbenchDrag ✓）
		ghost.style.width = rect.width + 'px';
		ghost.style.height = rect.height + 'px';
		document.body.appendChild(ghost);
		return ghost;
	}

	/**
	 * 拖拽一个工作台条目 —— **B 版：空槽跟手** ✓（原条目留虚线空槽、浮层克隆跟指针 ✓），
	 * **松手才落盘** ✓；空槽实时挪到落点 ⇒ "会落在哪"由**空槽本身**回答 ✓（不再另画落点线 ✓）。
	 *
	 * ⚠ 与卡片"按下即拖"不同：这里**在按钮上按下也会进来** ✓（条目大部分面积是那三个按钮 ✗），
	 *   所以必须：① 6px 死区 —— 没移动就让 click **原样走完**（按钮照常能用 ✓）；
	 *   ② 拖过之后**吞掉那一次 click**（捕获阶段 `stopPropagation` ✓，否则松手会顺手触发按钮 ✗）；
	 *   ③ 监听器一律挂 `document`（指针捕获只是优化 ✓，与缩放手柄同款容错 ✓）。
	 */
	function startWorkbenchDrag(event, card) {
		var list = card.parentNode;
		var startX = event.clientX;
		var startY = event.clientY;
		// ★ 方案 3（2026-10-13 用户选定）：记**两轴**抓取偏移 —— 浮层按"指针 − 抓取偏移"定位
		//   ⇒ 抓起来不跳 ✓、且严格跟指针 ✓。
		//   ⚠ 旧写法只记纵向 ⇒ 横向跟着"空槽的 left"走 ⇒ 空槽一换列就横跳（实测偏差 283px ✗）。
		var grabRect = card.getBoundingClientRect();
		var grabDx = startX - grabRect.left;
		var grabDy = startY - grabRect.top;
		var moved = false;
		var swallowClick = false;
		var ghost = null;
		var onMove = function (e) {
			// ⚠ 死区必须**两轴**都判 ✗ —— 只判 `clientY` 的话，**左右拖动永远不触发** ✓
			//   （用户 2026-10-13 反馈："左右无法拖动" —— 他的工作台是 **2 列网格** ✓）。
			if (!moved && Math.abs(e.clientY - startY) < 6 && Math.abs(e.clientX - startX) < 6) {
				return;
			}
			if (!moved) {
				moved = true;
				swallowClick = true;
				ghost = makeWorkbenchGhost(card, card.getBoundingClientRect());
				card.classList.add('wb-slot');                 // 原位留**虚线空槽** ✓
				document.body.style.cursor = 'grabbing';        // 条目本体看不见了 ⇒ 光标落在 body 上 ✓
				status('正在拖动「工作台」条目 —— 松开即保存顺序');
			}
			if (ghost) {
				// ★ 方案 3：两轴都按**指针**算 ＋ 用 `translate3d` 写（合成层 ⇒ **不触发布局** ✓）。
				//   横向**不再**取空槽的 left ✗ —— 那正是"非常不跟手"（Δx 283px）的来源 ✓。
				ghost.style.transform = 'translate3d(' + (e.clientX - grabDx) + 'px,' + (e.clientY - grabDy) + 'px,0) scale(1.02)';
			}
			// 让**空槽**实时挪到落点 —— 它自己就是"会落在哪"的指示 ✓
			// ⚠ 落点必须按**行优先（先上下、再左右）**算 ✗ —— 网格是 `repeat(auto-fill, minmax(178px,1fr))`
			//   ⇒ 一屏可能有 2~6 列 ✓，只按 `clientY` 比中点的话**横向拖动完全不换位** ✓（同一个 bug ✓）。
			//   规则：取 DOM 顺序里**第一条"位于指针之后"**的条目 ——
			//     ① 它的整行在指针下方（`py < 中线` ✓），或
			//     ② 指针落在它这一行内 且 在它中点左侧 ✓。
			var siblings = Array.prototype.slice.call(list.querySelectorAll('.wb-card'));
			var before = null;
			var px = e.clientX;
			var py = e.clientY;
			for (var i = 0; i < siblings.length; i += 1) {
				if (siblings[i] === card) {
					continue;
				}
				var rect = siblings[i].getBoundingClientRect();
				var below = py < rect.top + rect.height / 2;
				var sameBandToTheLeft = py <= rect.bottom && px < rect.left + rect.width / 2;
				if (below || sameBandToTheLeft) {
					before = siblings[i];
					break;
				}
			}
			if (before) {
				list.insertBefore(card, before);
			} else {
				list.appendChild(card);
			}
		};
		var onClickCapture = function (e) {
			if (swallowClick) {
				e.stopPropagation();
				e.preventDefault();
				swallowClick = false;
			}
			document.removeEventListener('click', onClickCapture, true);
		};
		var onUp = function () {
			document.removeEventListener('pointermove', onMove);
			document.removeEventListener('pointerup', onUp);
			document.removeEventListener('pointercancel', onUp);
			card.classList.remove('wb-slot');
			document.body.style.cursor = '';
			if (ghost && ghost.parentNode) {
				ghost.parentNode.removeChild(ghost);
			}
			ghost = null;
			if (moved) {
				persistWorkbenchOrder();
			}
			// 兜底：万一这次没产生 click（指针移出等），别把捕获监听器留在 document 上 ✗
			setTimeout(function () {
				document.removeEventListener('click', onClickCapture, true);
			}, 0);
		};
		document.addEventListener('click', onClickCapture, true);
		document.addEventListener('pointermove', onMove);
		document.addEventListener('pointerup', onUp);
		document.addEventListener('pointercancel', onUp);
	}

	document.addEventListener('keydown', function (event) {
		if (event.key === 'Escape' && state.editing) {
			setEditing(false);
		}
	});
})();
