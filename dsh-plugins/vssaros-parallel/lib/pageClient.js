// /x/parallel/client.js —— 并行 TUI 工作台的浏览器端（xterm 渲染）。
//
// 职责：
//   · 从 /api/state 拉格位列表；每格订阅 SSE `/api/cells/<id>/stream`；
//   · ★ **原始 ANSI 原样写进 xterm** ⇒ 颜色/光标/全屏都正确（服务端不解析、不剥色）；
//   · 键盘由 xterm 自己收（`term.onData`）⇒ 方向键/组合键的转义序列天然正确，不需要自造输入框；
//   · 容器尺寸变化 ⇒ FitAddon 算出 cols/rows ⇒ POST resize（让 TUI 的重排跟着走）。
//
// ⚠ 本文件经 `readFileSync` 原样返回（不经服务端模板串）⇒ 反引号可用。
// ⚠ 一切失败都要**看得见**（顶部 banner / 格头状态），不许静默。

(function () {
	'use strict';

	var API = '/x/parallel/api';
	var token = '';
	try { token = new URLSearchParams(location.search).get('token') || ''; } catch (e) { token = ''; }

	function withToken(path) {
		if (!token) { return path; }
		return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
	}

	/** 读一个 CSS 变量（拿不到就用 fallback）。xterm 要的是具体颜色值，不能吃 var()。 */
	function cssVar(name, fallback) {
		try {
			var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
			return v || fallback;
		} catch (e) { return fallback; }
	}

	var TERM_THEME = {
		background: cssVar('--dsw-alias-bg-base', cssVar('--vscode-editor-background', '#1b1b1b')),
		foreground: cssVar('--dsw-alias-label-primary', cssVar('--vscode-foreground', '#e8e8e8')),
		cursor: cssVar('--dsw-alias-brand-primary', '#4daafc'),
		selectionBackground: 'rgba(77,170,252,0.30)',
	};

	var els = { grid: null, banner: null, ptyPill: null, tuiPill: null, countPill: null, addBtn: null, closeAllBtn: null };
	/** id → { root, term, fit, sse, dot, tag, title, status, buffer } */
	var views = Object.create(null);
	var state = { ptyOk: false, error: '', maxCells: 0, cells: [] };

	/** banner 走 innerHTML（要放 <code>），所以外部文案必须先转义。 */
	function escapeText(s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
		});
	}

	function setBanner(html, bad) {
		if (!els.banner) { return; }
		els.banner.innerHTML = html;
		els.banner.className = 'banner' + (bad ? ' bad' : '');
	}

	// ── 动作反馈（toast）──────────────────────────────────────────────────
	// 分工：banner 是**常驻状态**（PTY / 运行时能不能用），toast 是**动作结果**（新增 / 关闭 / 失败）。
	// 两者都要：banner 不该被一次动作刷掉，动作也不该静默（旧版"点了没反应"就是这么来的）。
	var toastBox = null;
	function showToast(text, bad) {
		if (!toastBox || !document.body.contains(toastBox)) {
			toastBox = document.getElementById('toasts');
			if (!toastBox) {
				toastBox = document.createElement('div');
				toastBox.className = 'toasts';
				toastBox.id = 'toasts';
				document.body.appendChild(toastBox);
			}
		}
		var el = document.createElement('div');
		el.className = 'toast' + (bad ? ' bad' : '');
		el.textContent = String(text == null ? '' : text);
		toastBox.appendChild(el);
		// 失败的留久一点（要看清原因）
		setTimeout(function () { if (el.parentNode) { el.remove(); } }, bad ? 5000 : 3200);
	}

	/**
	 * 状态中文名。⚠ 只翻 PTY 层**真正知道**的东西：进程在不在、退没退。
	 * 「等待输入」这类要读 TUI 语义 ⇒ 现在给不出来，**不编**。
	 */
	function stateText(cell) {
		switch (cell && cell.state) {
			case 'starting': return '起格中';
			case 'running': return '在跑';
			case 'closing': return '关闭中';
			case 'exited': return '已结束';
			case 'failed': return '失败';
			default: return '空闲';
		}
	}

	/** 顶部计数：`n 格 · m 在跑 [· k 已结束] [· j 失败]`（由真实状态算，不写死）。 */
	function statsText() {
		var running = 0;
		var ended = 0;
		var failed = 0;
		for (var i = 0; i < state.cells.length; i += 1) {
			var s = state.cells[i].state;
			if (s === 'running' || s === 'starting') { running += 1; }
			else if (s === 'failed') { failed += 1; }
			else if (s === 'exited' || s === 'closing') { ended += 1; }
		}
		var bits = [state.cells.length + ' 格', running + ' 在跑'];
		if (ended) { bits.push(ended + ' 已结束'); }
		if (failed) { bits.push(failed + ' 失败'); }
		return bits.join(' · ');
	}

	function render() {
		if (!els.grid) { return; }
		var alive = Object.create(null);
		for (var i = 0; i < state.cells.length; i += 1) { alive[state.cells[i].id] = true; }
		Object.keys(views).forEach(function (id) {
			if (alive[id]) { return; }
			// 正在放大的格子被删掉 ⇒ 先把遮罩收掉，否则整页被一块黑罩盖住、点哪都没反应。
			if (id === maxId) { exitMax(); }
			disposeView(views[id]);
			delete views[id];
		});
		if (!state.cells.length) {
			if (!document.getElementById('empty-hint')) {
				var empty = document.createElement('div');
				empty.id = 'empty-hint';
				empty.className = 'empty';
				empty.textContent = state.ptyOk
					? '还没有格位。点右上「＋ 新增格位」起一个 TUI。'
					: '格位后端不可用（见上方说明）。';
				els.grid.appendChild(empty);
			}
			return;
		}
		var hint = document.getElementById('empty-hint');
		if (hint) { hint.remove(); }
		for (var j = 0; j < state.cells.length; j += 1) { upsertCell(state.cells[j]); }
		els.countPill.textContent = statsText();
	}

	function disposeView(view) {
		try { view.sse && view.sse.close(); } catch (e) { /* 已关 */ }
		try { view.term && view.term.dispose(); } catch (e) { /* 已释放 */ }
		try { view.root.remove(); } catch (e) { /* 已移除 */ }
	}

	function upsertCell(cell) {
		var view = views[cell.id];
		if (!view) { view = createCell(cell); views[cell.id] = view; }
		view.dot.className = 'dot ' + cell.state;
		view.tag.textContent = stateText(cell) + (cell.exitCode == null ? '' : '（' + cell.exitCode + '）');
		view.title.textContent = cell.title || cell.id;
		// 放大某格时其余格变暗：否则"放大"看起来只是位置变了，看不出焦点在哪。
		view.root.classList.toggle('dim', !!maxId && maxId !== cell.id);
		view.status.textContent = cell.state === 'exited' || cell.state === 'failed'
			? '已结束' + (cell.exitCode == null ? '' : '（exit ' + cell.exitCode + '）')
			: (cell.cols + '×' + cell.rows + (cell.pid ? ' · pid ' + cell.pid : ''));
	}

	function createCell(cell) {
		var root = document.createElement('section');
		root.className = 'cell';
		root.setAttribute('data-cell', cell.id);

		var head = document.createElement('header');
		head.className = 'chead';
		var dot = document.createElement('span');
		dot.className = 'dot ' + cell.state;
		var title = document.createElement('span');
		title.className = 'nm';
		title.textContent = cell.title || cell.id;
		var tag = document.createElement('span');
		tag.className = 'tag';
		tag.textContent = cell.state;
		var sp = document.createElement('span');
		sp.className = 'sp';
		var maxBtn = document.createElement('button');
		maxBtn.className = 'ibtn';
		maxBtn.title = '放大到全屏（Esc 退出）—— 窄格看不清时用';
		maxBtn.textContent = '⤢';
		maxBtn.addEventListener('click', function () { toggleMax(cell.id); });
		var menuBtn = document.createElement('button');
		menuBtn.className = 'ibtn';
		menuBtn.title = '这一格的模型 / preset / 工作区';
		menuBtn.textContent = '⚙';
		menuBtn.addEventListener('click', function () { openCellMenu(cell.id); });
		var closeBtn = document.createElement('button');
		closeBtn.className = 'ibtn';
		closeBtn.title = '关闭这一格（只走 PTY 句柄，不按 pid 杀）';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', function () { closeCell(cell.id); });
		head.appendChild(dot); head.appendChild(title); head.appendChild(tag);
		head.appendChild(sp);
		head.appendChild(menuBtn);
		head.appendChild(maxBtn);
		head.appendChild(closeBtn);

		var body = document.createElement('div');
		body.className = 'cbody';
		var termHost = document.createElement('div');
		termHost.className = 'termhost';
		body.appendChild(termHost);

		var foot = document.createElement('div');
		foot.className = 'cfoot';
		var status = document.createElement('span');
		status.className = 'cstat';
		status.textContent = cell.cols + '×' + cell.rows;
		var focusHint = document.createElement('span');
		focusHint.className = 'chint';
		focusHint.textContent = hintText(cell);
		foot.appendChild(status); foot.appendChild(focusHint);

		root.appendChild(head); root.appendChild(body); root.appendChild(foot);
		els.grid.appendChild(root);

		var view = { root: root, term: null, fit: null, sse: null, dot: dot, tag: tag, title: title, status: status, hint: focusHint, buffer: '' };

		// xterm 必须在元素进 DOM 且有尺寸后再 open（否则尺寸算成 0）。
		if (typeof window.Terminal === 'function') {
			var term = new window.Terminal({
				cols: cell.cols || 120,
				rows: cell.rows || 30,
				fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
				fontSize: 11,
				lineHeight: 1.2,
				cursorBlink: true,
				scrollback: 4000,
				theme: TERM_THEME,
				allowProposedApi: true,
			});
			var fit = null;
			try {
				if (window.FitAddon && window.FitAddon.FitAddon) {
					fit = new window.FitAddon.FitAddon();
					term.loadAddon(fit);
				}
			} catch (e) { fit = null; }
			term.open(termHost);
			view.term = term;
			view.fit = fit;
			// 键盘：xterm 自己收（含方向键的 CSI 序列）⇒ 原样送进 PTY
			term.onData(function (d) { sendInput(cell.id, d); });
			// 尺寸变了 ⇒ 告诉服务端，让 TUI 跟着重排
			term.onResize(function (size) {
				post(API + '/cells/' + encodeURIComponent(cell.id) + '/resize', { cols: size.cols, rows: size.rows })
					.then(function () { status.textContent = size.cols + '×' + size.rows; })
					.catch(function () { /* 尺寸同步失败不打扰用户 */ });
			});
			var lastC = 0;
			var lastR = 0;
			/**
			 * 让终端尺寸贴合容器。★ 尺寸一变就**必须清掉旧帧**：
			 *   格子进程起格时是默认 120×40，而格子实际宽度常常只有 ~73 列
			 *   ⇒ TUI 按 120 列画好的画面到 73 列的 xterm 里会被**逐行折行** ⇒ 新旧叠加成"阶梯碎片"
			 *   （实机截图就是这么花掉的）。所以：清屏 → 强制一次尺寸抖动让 TUI 整屏重绘。
			 */
			var doFit = function () {
				if (!view.fit || !view.term) { return; }
				try { view.fit.fit(); } catch (e) { return; /* 容器还没尺寸 */ }
				var c = view.term.cols;
				var r = view.term.rows;
				if (c === lastC && r === lastR) { return; }
				lastC = c;
				lastR = r;
				try { view.term.write('\u001b[2J\u001b[H'); } catch (e) { /* 已释放 */ }
				forceRedraw(cell.id, c, r);
			};
			setTimeout(doFit, 0);
			if (typeof ResizeObserver === 'function') {
				try { new ResizeObserver(doFit).observe(body); } catch (e) { /* 不支持就算了 */ }
			}
			termHost.addEventListener('click', function () { try { term.focus(); } catch (e) { /* */ } });
		} else {
			// xterm 没加载上 ⇒ 如实退化成纯文本（不假装有终端）
			var pre = document.createElement('pre');
			pre.className = 'fallback';
			pre.textContent = '（xterm.js 未加载，退化为纯文本）\n';
			termHost.appendChild(pre);
			view.pre = pre;
			setBanner('xterm.js 未加载：<code>/x/parallel/vendor/xterm.js</code> 没取到 ⇒ 现在是纯文本退化显示。', true);
		}

		subscribeStream(cell.id, view);
		return view;
	}

	/**
	 * 格子底部那句提示 —— **按状态说真话**。
	 *
	 * 用户 2026-10-23 报「tui 中无法输入」：其实是进程已经 exit（格头写着「已结束（1）」），
	 * 但底部还写着「点一下格子再打字」⇒ 用户以为键盘坏了。已结束时必须直说不能输入、怎么重开。
	 */
	function hintText(cell) {
		if (!cell) { return '点一下格子再打字'; }
		if (cell.state === 'exited') {
			return '已结束（exit ' + (cell.exitCode == null ? '?' : cell.exitCode) + '）⇒ 不能输入；点底部 ⟳ 重绘，或用格头 ⚙ 换目录/preset 重开';
		}
		if (cell.state === 'closing') { return '正在关闭…'; }
		if (cell.state === 'starting') { return '正在启动…（起来后点一下格子再打字）'; }
		return '点一下格子再打字';
	}

	function subscribeStream(id, view) {
		if (typeof EventSource !== 'function') { return; }
		var es = new EventSource(withToken(API + '/cells/' + encodeURIComponent(id) + '/stream'));
		view.sse = es;
		es.addEventListener('replay', function (ev) { writeOut(view, payload(ev).data); });
		es.addEventListener('data', function (ev) { writeOut(view, payload(ev).data); });
		es.addEventListener('state', function (ev) {
			var p = payload(ev);
			view.dot.className = 'dot ' + p.state;
			view.tag.textContent = p.state + (p.exitCode == null ? '' : ' (' + p.exitCode + ')');
			// 底部提示跟着状态走（已结束就不能再说"点一下再打字"）
			if (view.hint) {
				view.hint.textContent = hintText({ state: p.state, exitCode: p.exitCode });
			}
		});
	}

	function payload(ev) {
		try { return JSON.parse(ev.data); } catch (e) { return {}; }
	}

	/** ★ 原样写进 xterm（**不剥 ANSI**）—— 服务端已保证是 PTY 的原始字节。 */
	function writeOut(view, data) {
		if (typeof data !== 'string' || !data) { return; }
		if (view.term) {
			view.term.write(data);
			return;
		}
		if (view.pre) {
			// 退化路径：这里才需要剥 ANSI（纯文本 <pre> 显示不了控制序列）
			view.buffer += stripAnsi(data);
			var LIMIT = 64 * 1024;
			if (view.buffer.length > LIMIT) { view.buffer = view.buffer.slice(view.buffer.length - LIMIT); }
			view.pre.textContent = view.buffer;
		}
	}

	/**
	 * 表单内的就地错误行（失败时**不关弹层**，用户一定看得到原因）。
	 *
	 * 为什么需要：用户报过"点起格没反应" —— 只靠右上角 toast 时，请求挂住/失败在
	 * 弹层背后的注意力盲区里。这里把错误贴在按钮上方，并把原因写清楚。
	 */
	function showFormError(body, text) {
		if (!body) { return; }
		var el = body.querySelector('.form-err');
		if (!el) {
			el = document.createElement('p');
			el.className = 'hint form-err';
			body.appendChild(el);
		}
		el.textContent = String(text || '');
		el.style.color = 'var(--err)';
	}

	/** 仅退化路径用：去 ANSI / 控制序列。 */
	function stripAnsi(s) {
		return String(s == null ? '' : s)
			.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
			.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
			.replace(/\u001b[()][A-Za-z0-9]/g, '')
			.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
	}

	function post(path, body) {
		// ★ 15s 超时：Host 已退出 / 连接断了时 fetch 会**一直挂着** ⇒ 用户看到的就是"点了没反应"
		//   （这是"起格没反应"最可能的形态之一）。超时后给一条能看懂的话，而不是无限转圈。
		var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
		var timer = ctl ? setTimeout(function () { ctl.abort(); }, 15000) : null;
		var opts = {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body || {}),
		};
		if (ctl) { opts.signal = ctl.signal; }
		function done() { if (timer) { clearTimeout(timer); timer = null; } }
		return fetch(withToken(path), opts).then(function (r) {
			return r.text().then(function (t) {
				if (!r.ok) {
					// 后端的失败体是 `{ok:false,error:"..."}` ⇒ 优先显示那句人话，别把整段 JSON 糊给用户
					var msg = t;
					try { var j = JSON.parse(t); if (j && j.error) { msg = String(j.error); } } catch (e) { /* 非 JSON 就原样 */ }
					throw new Error('HTTP ' + r.status + (msg ? '：' + String(msg).slice(0, 220) : ''));
				}
				try { return JSON.parse(t); } catch (e) { return null; }
			});
		}).then(function (v) { done(); return v; }, function (e) {
			done();
			if (ctl && e && e.name === 'AbortError') {
				throw new Error('请求超时（15 秒）：Host 可能已退出或连接断开');
			}
			throw e;
		});
	}

	/**
	 * 把按键送进 PTY。
	 *
	 * ★ 已结束/正在关闭的格子**不再发**（后端只会回 409/404）：用户 2026-10-23 报"tui 中无法输入"，
	 *   实际是进程已 exit 1 —— 继续静默发请求只会让人以为键盘坏了。这里给一条能看懂的话。
	 */
	function sendInput(id, data) {
		var c = null;
		for (var i = 0; i < state.cells.length; i += 1) {
			if (state.cells[i].id === id) { c = state.cells[i]; break; }
		}
		if (c && c.state !== 'running' && c.state !== 'starting') {
			var why = c.state === 'exited'
				? ('已结束（exit ' + (c.exitCode == null ? '?' : c.exitCode) + '）')
				: (stateText(c) || c.state);
			showToast('格位 ' + id + ' ' + why + ' ⇒ 不能输入；用格头 ⚙ 换目录/preset 重开', true);
			return;
		}
		post(API + '/cells/' + encodeURIComponent(id) + '/input', { data: data })
			.catch(function (e) { setBanner('输入失败：' + String((e && e.message) || e), true); });
	}

	function closeCell(id) {
		fetch(withToken(API + '/cells/' + encodeURIComponent(id)), { method: 'DELETE', credentials: 'same-origin' })
			.then(function (r) { return r.text().then(function (t) { if (!r.ok) { throw new Error('HTTP ' + r.status + '：' + t.slice(0, 160)); } return t; }); })
			.then(function () {
				// ⚠ 真关格 = PTY 结束 + 进程回收 ⇒ **不可撤销**（mockup 里那个"撤销"只为演示交互）。
				showToast('已关闭格位 ' + id + '：PTY 已结束、进程已回收（不可恢复）');
				return refresh();
			})
			.catch(function (e) {
				var msg = '关闭失败：' + String((e && e.message) || e);
				showToast(msg, true);
				setBanner(msg, true);
			});
	}

	/**
	 * 强制让 TUI **整屏重绘**：先把 PTY 缩 1 列再复原 ⇒ 两次 SIGWINCH。
	 *
	 * ⚠ 不能只发"同尺寸"的 resize：宿主侧 `resize` 对尺寸没变的请求直接返回 `unchanged`，
	 *   不会调 `pty.resize` ⇒ 没有 SIGWINCH ⇒ TUI 不会重绘（清屏之后就白屏了）。
	 */
	function forceRedraw(id, cols, rows) {
		var url = API + '/cells/' + encodeURIComponent(id) + '/resize';
		post(url, { cols: Math.max(20, cols - 1), rows: rows })
			.then(function () { return post(url, { cols: cols, rows: rows }); })
			.catch(function () { /* 重绘失败不打扰用户：下次尺寸变化会再试 */ });
	}

	// ── 弹层（新增格位 / 单格菜单）──────────────────────────────────────────
	// ⚠ 一律挂到 body + position:fixed：格子的 .cell 有 overflow:hidden，自绘下拉会被裁掉（踩过两次）。
	var openModals = [];

	/**
	 * 通用弹层。
	 * @param {{title: string, sub?: string, build?: (host: HTMLElement, close: Function) => void,
	 *          actions?: Array<{label: string, primary?: boolean, run: (close: Function, host: HTMLElement) => void}>}} spec
	 */
	function showModal(spec) {
		var mask = document.createElement('div');
		mask.className = 'modal-mask';
		var box = document.createElement('div');
		box.className = 'modal';
		var head = document.createElement('div');
		head.className = 'modal-h';
		head.textContent = spec.title || '';
		if (spec.sub) {
			var sub = document.createElement('span');
			sub.className = 'sub';
			sub.textContent = spec.sub;
			head.appendChild(sub);
		}
		var body = document.createElement('div');
		body.className = 'modal-b';
		var foot = document.createElement('div');
		foot.className = 'modal-f';

		function close() {
			var i = openModals.indexOf(close);
			if (i >= 0) { openModals.splice(i, 1); }
			if (mask.parentNode) { mask.remove(); }
		}
		openModals.push(close);

		if (typeof spec.build === 'function') { spec.build(body, close); }
		(spec.actions || []).forEach(function (a) {
			var btn = document.createElement('button');
			btn.className = 'btn' + (a.primary ? ' primary' : '');
			btn.textContent = a.label;
			// ★ 第三个参数把按钮本身给 run：动作可以显示"进行中"并在失败后恢复
			//   （用户报过"点起格没反应" —— 至少要能看出它正在跑 / 跑挂了）
			btn.addEventListener('click', function () { a.run(close, body, btn); });
			foot.appendChild(btn);
		});
		mask.addEventListener('click', function (ev) { if (ev.target === mask) { close(); } });

		box.appendChild(head);
		box.appendChild(body);
		box.appendChild(foot);
		mask.appendChild(box);
		document.body.appendChild(mask);
		return close;
	}

	// ⚠ 这里**不再有**本地的 preset 名字表：显示名 / 说明 / 分组全部由后端
	//   `presetMenuItems` 按 chat-surface「模式」chip 的同一口径给出（含「不显示内部 id」）——
	//   两处各写一张表正是最容易漂移的地方（守卫会与 chip 逐字比对）。

	/** 起格候选（工作区目录 / preset）：来自 Host 侧扫磁盘的真实结果。 */
	function fetchOptions() {
		return fetch(withToken(API + '/options'), { credentials: 'same-origin' })
			.then(function (r) { return r.ok ? r.json() : null; })
			.catch(function () { return null; });
	}

	/**
	 * 起一格（可带 cwd / preset）。
	 * ⚠ 这两项都是**进程启动参数**：cwd 是 spawn 的选项、preset 是 `--agent-preset` ⇒ 只能开进程时定。
	 */
	function createCellReq(cwd, preset) {
		if (els.addBtn) { els.addBtn.disabled = true; }
		var payload = {};
		if (cwd) { payload.cwd = cwd; }
		if (preset) { payload.preset = preset; }
		// ★ 返回 Promise：调用方（起格表单）要能在失败时**保持弹层打开**并就地显示原因；
		//   成功才关（见 openAddCell 的 action）。成功/失败都要把顶部按钮恢复，不能永久 disabled。
		return post(API + '/cells', payload).then(function (created) {
			var id = created && created.cell && created.cell.id;
			showToast((id ? ('已新增格位 ' + id) : '已新增格位')
				+ (cwd ? ' · cwd=' + cwd : '') + (preset ? ' · preset=' + preset : ''));
			if (els.addBtn) { els.addBtn.disabled = false; }
			// resolve 出格位 id：调用方可能要在起格成功后往那格发命令（如打开 /model 面板）
			return refresh().then(function () { return id || ''; });
		}, function (e) {
			if (els.addBtn) { els.addBtn.disabled = false; }
			throw e;
		});
	}

	/**
	 * 关掉旧格、按新参数重起一个（换 cwd / preset 的唯一办法）。
	 * ★ 返回 Promise（失败向上抛）：调用方要在表单里就地显示失败原因、并恢复按钮。
	 */
	function reopenCell(id, cwd, preset) {
		var cur = state.cells.filter(function (c) { return c.id === id; })[0];
		var title = cur && cur.title ? cur.title : id;
		return fetch(withToken(API + '/cells/' + encodeURIComponent(id)), { method: 'DELETE', credentials: 'same-origin' })
			.then(function (r) {
				if (!r.ok) { throw new Error('关旧格失败：HTTP ' + r.status); }
				var payload = { title: title };
				if (cwd) { payload.cwd = cwd; }
				if (preset) { payload.preset = preset; }
				return post(API + '/cells', payload);
			})
			.then(function (created) {
				var nid = created && created.cell && created.cell.id;
				showToast('已按新参数重开：' + (nid || '?')
					+ (cwd ? ' · cwd=' + cwd : '') + (preset ? ' · preset=' + preset : '')
					+ '（原会话可用 /resume 接回）');
				return refresh();
			});
	}

	/** 路径比较（Windows 大小写不敏感 + `\`/`/` 等价 + 忽略尾斜杠），与后端 pathKey 同口径。 */
	function sameWsPath(a, b) {
		var norm = function (v) {
			return String(v || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
		};
		var x = norm(a);
		return !!x && x === norm(b);
	}

	/**
	 * 把自绘浮层挂到 `body` 并接管定位 / 关闭（工作区、preset 两个选择器共用）。
	 *
	 * ⚠ `position:fixed` + 挂 body：弹层与格子的祖先都有 `overflow:hidden`，浮层会被裁掉（踩过两次）。
	 * ⚠ 定位按视口夹取，下方空间不够就向上翻。
	 * ⚠ Esc 用 **capture + stopPropagation**：否则一次 Esc 会顺手把外层 modal 也关掉。
	 *
	 * @param {HTMLElement} anchor 触发器（取其 rect 定位）。
	 * @param {HTMLElement} pop 已经填好内容的浮层。
	 * @returns {() => void} 关闭函数（幂等）。
	 */
	function mountPop(anchor, pop) {
		pop.classList.add('wspop');
		var r = anchor.getBoundingClientRect();
		var vw = window.innerWidth || document.documentElement.clientWidth;
		var vh = window.innerHeight || document.documentElement.clientHeight;
		var width = Math.max(280, Math.min(r.width, vw - 16));
		pop.style.width = width + 'px';
		pop.style.left = Math.max(8, Math.min(r.left, vw - width - 8)) + 'px';
		pop.style.visibility = 'hidden';
		document.body.appendChild(pop);
		var below = vh - r.bottom - 10;
		var above = r.top - 10;
		var openUp = pop.offsetHeight > below && above > below;
		pop.style.maxHeight = Math.max(160, Math.min(openUp ? above : below, vh - 24)) + 'px';
		if (openUp) { pop.style.bottom = (vh - r.top + 6) + 'px'; }
		else { pop.style.top = (r.bottom + 6) + 'px'; }
		pop.style.visibility = '';

		var closed = false;
		function close() {
			if (closed) { return; }
			closed = true;
			document.removeEventListener('pointerdown', onDown, true);
			document.removeEventListener('keydown', onKey, true);
			window.removeEventListener('resize', close);
			window.removeEventListener('scroll', close, true);
			if (pop.parentNode) { pop.remove(); }
		}
		function onDown(ev) {
			if (pop.contains(ev.target) || anchor.contains(ev.target)) { return; }
			close();
		}
		function onKey(ev) {
			if (ev.key !== 'Escape') { return; }
			ev.stopPropagation();
			close();
		}
		document.addEventListener('pointerdown', onDown, true);
		document.addEventListener('keydown', onKey, true);
		window.addEventListener('resize', close);
		window.addEventListener('scroll', close, true);
		return close;
	}

	/**
	 * 造一个「触发器 + 说明小字 + 隐藏 input」的选择字段（模式 / Bot 共用，工作区那套同款 DOM）。
	 *
	 * ★ **真值只有一个**：隐藏 input 的 value ⇒ 提交时只读它（不会出现"看着 A、提交 B"）。
	 *
	 * @param {{id?: string, pickId?: string, ariaLabel?: string}} opts
	 * @returns {{field: HTMLElement, input: HTMLInputElement, pick: HTMLButtonElement, set: Function}}
	 */
	function createPickField(opts) {
		var o = opts || {};
		var field = document.createElement('div');
		field.className = 'wsfield';
		var pick = document.createElement('button');
		pick.type = 'button';
		pick.className = 'wspick';
		if (o.pickId) { pick.id = o.pickId; }
		// 触发器包在 <label> 里 ⇒ 不给 aria-label 会把整句字段说明当可访问名
		if (o.ariaLabel) { pick.setAttribute('aria-label', o.ariaLabel); }
		pick.setAttribute('aria-haspopup', 'true');
		var main = document.createElement('span');
		main.className = 'wsp-main';
		var name = document.createElement('span');
		name.className = 'wsp-name';
		main.appendChild(name);
		var arr = document.createElement('span');
		arr.className = 'wsp-arr';
		arr.textContent = '▾';
		var cur = document.createElement('div');
		cur.className = 'wsp-cur';
		var input = document.createElement('input');
		input.type = 'hidden';
		if (o.id) { input.id = o.id; }
		pick.appendChild(main);
		pick.appendChild(arr);
		field.appendChild(pick);
		field.appendChild(cur);
		field.appendChild(input);
		return {
			field: field,
			input: input,
			pick: pick,
			/** 写当前值：value 为空 = "未指定"，label/说明由调用方给。 */
			set: function (value, label, sub, title) {
				input.value = value || '';
				name.textContent = label || '';
				cur.textContent = sub || '';
				cur.style.display = sub ? '' : 'none';
				pick.title = title || label || '';
			},
		};
	}

	/**
	 * 工作区选择浮层（自绘）。
	 *
	 * 形态对齐左侧「工作区」栏：一条记录一组（`VsSaros_S1Game` + `2 个根` 徽标），组内各根缩进展示。
	 *
	 * ★ **可选单元 = 工作区（组头），不是根**（用户口径 2026-10-23 第二次截图：
	 *   「工作区（多根）的 item 才允许点击选择」）⇒ 点组头 = 选这个工作区（cwd 取**主根**），
	 *   根行只是**只读展示**（用来交代"这个工作区由哪几个目录组成"），点了没有任何反应。
	 *   想开在非主根目录 ⇒ 用底部的「＋ 自定义路径」。
	 *
	 * 数据：`spec.groups` = IDE `workspaces.json` 的记录（与左侧栏、会话 chip 分组同一份）；
	 * 没有它（读不到记录 / 老宿主）⇒ 平铺 `spec.cwds`（dsh 已登记的工作区，回落）。
	 *
	 * ⚠ 浮层固定挂 `body` + `position:fixed`：弹层与格子的祖先都有 `overflow:hidden`，
	 *   自绘下拉会被裁掉（这个坑踩过两次）；同时按视口夹取，必要时向上翻。
	 *
	 * @param {HTMLElement} anchor 触发器（取其 rect 定位）。
	 * @param {{groups: Array|null, cwds: Array, value: string}} spec 候选 + 当前值。
	 * @param {(choice: {path: string, name: string, rootName: string}) => void} onPick 选中回调。
	 */
	function openWorkspacePop(anchor, spec, onPick) {
		var pop = document.createElement('div');
		pop.className = 'wspop';
		// ⚠ 不要设 `role="listbox"`：a11y 规定 listbox 只认 option 子元素，组头会被
		//   整段丢弃（快照里看不到「VsSaros_S1Game / 2 个根」）⇒ 反而比不加 role 更差。

		/** 可选行（工作区 / 自定义路径）——**只有这类行能点**。 */
		function makeRow(label, sub, isSel, onClick) {
			var row = document.createElement('button');
			row.type = 'button';
			row.className = 'wsrow' + (isSel ? ' is-sel' : '');
			var nm = document.createElement('span');
			nm.className = 'wsr-name';
			nm.textContent = label;
			row.appendChild(nm);
			if (sub) {
				var sp = document.createElement('span');
				sp.className = 'wsr-path';
				sp.textContent = sub;
				sp.title = sub;
				row.appendChild(sp);
			}
			if (onClick) { row.addEventListener('click', function () { close(); onClick(); }); }
			return row;
		}

		/** 只读的根行：只用来展示工作区由哪些目录组成（不可点、不参与选择）。 */
		function makeRootRow(root, isCur) {
			var row = document.createElement('div');
			row.className = 'wsrow is-ro' + (isCur ? ' is-cur' : '');
			var nm = document.createElement('span');
			nm.className = 'wsr-name';
			nm.textContent = root.name;
			row.appendChild(nm);
			if (root.isPrimary) {
				var pri = document.createElement('span');
				pri.className = 'wsr-pri';
				pri.textContent = '主';
				row.appendChild(pri);
			}
			var sp = document.createElement('span');
			sp.className = 'wsr-path';
			sp.textContent = root.path;
			sp.title = root.path;
			row.appendChild(sp);
			return row;
		}

		function sep() {
			var d = document.createElement('div');
			d.className = 'wssep';
			return d;
		}

		var groups = spec && spec.groups;
		if (groups && groups.length) {
			groups.forEach(function (g, gi) {
				var primary = g.roots[0] || { path: '', name: g.name };
				// 组头 = 可选工作区：高亮判据是"当前值落在这个组的任意根里"（远端可能选的是非主根）
				var isCur = g.roots.some(function (r) { return sameWsPath(r.path, spec.value); });
				if (gi > 0) { pop.appendChild(sep()); }
				// 组头不重复主根路径（路径就在下面根行里；与左侧工作区栏同款只显示名称 + 根数）
				var head = makeRow(g.name, '', isCur, function () {
					// 选工作区 ⇒ cwd = **主根**（与会话 chip 的"整组默认 cwd"同一口径）
					onPick({ path: primary.path, name: g.name, rootName: primary.name });
				});
				head.className += ' wsg';
				head.title = g.name + '（主根 ' + primary.path + '）';
				if (g.roots.length > 1) {
					var badge = document.createElement('span');
					badge.className = 'wsg-badge';
					badge.textContent = g.roots.length + ' 个根';
					head.appendChild(badge);
				}
				pop.appendChild(head);
				// 各根只读展示（主根也列出来，让「主」标记可见）
				g.roots.forEach(function (r) { pop.appendChild(makeRootRow(r, sameWsPath(r.path, spec.value))); });
			});
			pop.appendChild(sep());
		} else {
			// 回落：dsh 已登记的工作区（单目录，一条一行）—— 如实平铺，不假装有分组
			(spec && spec.cwds ? spec.cwds : []).forEach(function (c) {
				var label = c.label && c.label !== c.path ? c.label : c.path;
				pop.appendChild(makeRow(label, c.label && c.label !== c.path ? c.path : '', sameWsPath(c.path, spec.value), function () {
					onPick({ path: c.path, name: c.label || c.path, rootName: '' });
				}));
			});
			if (!spec || !spec.cwds || !spec.cwds.length) {
				var none = document.createElement('div');
				none.className = 'wsg-empty';
				none.textContent = '没有可选的工作区（请用下面的「自定义路径」）';
				pop.appendChild(none);
			}
			pop.appendChild(sep());
		}
		pop.appendChild(makeRow('＋ 自定义路径…', '', false, function () {
			onPick({ path: '', name: '', rootName: '' });
		}));

		return mountPop(anchor, pop);
	}

	/**
	 * preset（模式）选择浮层。
	 *
	 * ★ **与 chat-surface 的「模式」chip 同一口径**（用户 2026-10-23 要求）：
	 *   同白名单（VsSaros 两个档 + dsh 原生 minimal/cordis）、同分组标题、同文案
	 *   （名称 + 一句说明）、**不显示内部 id**；多出来的一项只有「（不指定，用部署默认）」——
	 *   那是并行格子特有的（不传 `--agent-preset` 的语义），chip 里没有对应项。
	 *
	 * @param {HTMLElement} anchor 触发器。
	 * @param {{items: Array, value: string}} spec `items` = `/api/options.presets`（后端已整理）。
	 * @param {(ch: {id: string, name: string}) => void} onPick 选中回调（id 为空 = 不指定）。
	 */
	function openPresetPop(anchor, spec, onPick) {
		var pop = document.createElement('div');
		var close = null;

		function sep() {
			var d = document.createElement('div');
			d.className = 'wssep';
			return d;
		}

		/** 可选行：名称（第一行）+ 说明（第二行，与 chip 一样截 48 字） */
		function itemRow(id, name, desc, isSel, onClick) {
			var row = document.createElement('button');
			row.type = 'button';
			row.className = 'wsrow' + (isSel ? ' is-sel' : '') + (desc ? ' has-desc' : '');
			var nm = document.createElement('span');
			nm.className = 'wsr-name';
			nm.textContent = name;
			row.appendChild(nm);
			if (desc) {
				var d = document.createElement('span');
				d.className = 'wsr-desc';
				d.textContent = desc.slice(0, 48);
				row.appendChild(d);
			}
			row.title = desc ? (name + '：' + desc) : name;
			row.addEventListener('click', function () { if (close) { close(); } onClick(); });
			return row;
		}

		// ① 不指定（= 不传 --agent-preset，用部署默认）—— 并行格子特有的一项
		pop.appendChild(itemRow('', '（不指定，用部署默认）', '', spec.value === '', function () {
			onPick({ id: '', name: '' });
		}));

		// ② 分组：组标题与 chip 的菜单组标题逐字相同
		var items = spec.items || [];
		var lastGroup = '';
		items.forEach(function (it) {
			if (it.group !== lastGroup) {
				// 没有组标题的列表（Bot / 平铺候选）不画分隔与空标题 ⇒ 同一个浮层可以复用
				if (it.groupTitle) {
					pop.appendChild(sep());
					var head = document.createElement('div');
					head.className = 'pgrp';
					head.textContent = it.groupTitle;
					pop.appendChild(head);
				}
				lastGroup = it.group;
			}
			pop.appendChild(itemRow(it.id, it.name || it.id, it.desc || '', spec.value === it.id, function () {
				onPick({ id: it.id, name: it.name || it.id });
			}));
		});
		if (!items.length) {
			var none = document.createElement('div');
			none.className = 'wsg-empty';
			none.textContent = '这个 profile 里没找到模式定义（只影响预设选择，不影响起格）';
			pop.appendChild(none);
		}

		close = mountPop(anchor, pop);
		return close;
	}

	/**
	 * 起格表单：工作区目录 + preset。
	 * @param {{cellId?: string, cwd?: string, preset?: string}} [prefill] 带 `cellId` 表示"重开这一格"。
	 */
	function openAddCell(prefill) {
		var p = prefill || {};
		fetchOptions().then(function (opt) {
			var cwds = ((opt && opt.cwds) || []).slice();
			var presets = (opt && opt.presets) || [];
			// Bot / Agent（roster 里除模式以外的行）；null = 这个 Host 没有 agentPresets 服务
			var agents = (opt && opt.agents) || null;
			// 候选补上「现有格位正在用的目录」—— 这些一定真实存在（否则起不来）
			var seenCwd = {};
			cwds.forEach(function (c) { seenCwd[c.path] = 1; });
			state.cells.forEach(function (c) {
				if (!c.cwd || seenCwd[c.cwd]) { return; }
				seenCwd[c.cwd] = 1;
				cwds.push({ path: c.cwd, label: '已开的格位在用的目录' });
			});
			// 默认值优先级：显式传入 → 现有格位的目录 → Host 侧默认
			var firstCellCwd = '';
			for (var ci = 0; ci < state.cells.length; ci += 1) {
				if (state.cells[ci].cwd) { firstCellCwd = state.cells[ci].cwd; break; }
			}
			var defCwd = p.cwd || firstCellCwd || (opt && opt.defaults && opt.defaults.cwd) || '';

			showModal({
				title: p.cellId ? ('重开格位 ' + p.cellId) : '新增格位',
				sub: '工作区 / preset 只在起格时生效',
				build: function (host) {
					// ── 工作区：自绘选择器（分组 = IDE 工作区记录，组内多根）────────────
					// ★ 与左侧「工作区」栏同款：一条记录一行组头（`名称` + `N 个根`），组内按根缩进。
					//   数据来自 Host 的 `/api/options.workspaces`（IDE 的 workspaces.json）——
					//   它就是左侧栏和会话 chip 用来分组的同一份记录（原生 select 做不出分组/多根）。
					var groups = (opt && opt.workspaces) || null;
					var cwdLabel = document.createElement('label');
					cwdLabel.textContent = '工作区（与左侧工作区栏 / 会话里的工作区 chip 同一份记录；TUI 的 cwd = 启动目录，运行中改不了）';

					var cwdInput = document.createElement('input');
					cwdInput.type = 'text';
					cwdInput.id = 'f-cwd';
					cwdInput.placeholder = '输入绝对路径，例如 F:\\my\\project';

					var field = document.createElement('div');
					field.className = 'wsfield';
					var pick = document.createElement('button');
					pick.type = 'button';
					pick.className = 'wspick';
					pick.id = 'f-ws-pick';
					// 触发器包在 <label> 里 ⇒ 不给 aria-label 的话可访问名会变成整句字段说明 + 路径
					pick.setAttribute('aria-label', '选择工作区');
					pick.setAttribute('aria-haspopup', 'true');
					var pickMain = document.createElement('span');
					pickMain.className = 'wsp-main';
					var pickName = document.createElement('span');
					pickName.className = 'wsp-name';
					var pickRoot = document.createElement('span');
					pickRoot.className = 'wsp-root';
					pickMain.appendChild(pickName);
					pickMain.appendChild(pickRoot);
					var pickArr = document.createElement('span');
					pickArr.className = 'wsp-arr';
					pickArr.textContent = '▾';
					pick.appendChild(pickMain);
					pick.appendChild(pickArr);
					var curPath = document.createElement('div');
					curPath.className = 'wsp-cur';
					field.appendChild(pick);
					field.appendChild(curPath);
					field.appendChild(cwdInput);

					/**
					 * 写当前值。**真值只有一个**：隐藏 input 的 value（提交时只读它 ⇒
					 * 不会出现"看着选了 A、实际提交 B"）。path 为空 = 「自定义路径」态。
					 */
					function applyValue(path, name, rootName) {
						cwdInput.value = path || '';
						cwdInput.style.display = path ? 'none' : '';
						curPath.textContent = path || '';
						curPath.style.display = path ? '' : 'none';
						pickName.textContent = path ? (name || '自定义路径') : '＋ 自定义路径';
						pickRoot.textContent = (path && rootName) ? ('· ' + rootName) : '';
						pick.title = path ? ((name || '') + (rootName ? ' · ' + rootName : '') + '\n' + path) : '自定义路径';
					}
					// 初始值：显式传入 → 已有格位 → Host 默认；能在工作区记录里认领就显示「组名 · 根名」
					(function () {
						var hitGroup = null;
						var hitRoot = null;
						if (groups) {
							groups.forEach(function (g) {
								g.roots.forEach(function (r) {
									if (!hitRoot && sameWsPath(r.path, defCwd)) { hitGroup = g; hitRoot = r; }
								});
							});
						}
						if (hitGroup) { applyValue(hitRoot.path, hitGroup.name, hitRoot.name); return; }
						var hitCwd = null;
						cwds.forEach(function (c) { if (!hitCwd && sameWsPath(c.path, defCwd)) { hitCwd = c; } });
						if (hitCwd) { applyValue(hitCwd.path, hitCwd.label || hitCwd.path, ''); return; }
						applyValue(defCwd || '', defCwd ? '自定义路径' : '', '');
					})();

					pick.addEventListener('click', function () {
						openWorkspacePop(pick, { groups: groups, cwds: cwds, value: cwdInput.value }, function (ch) {
							applyValue(ch.path, ch.name, ch.rootName);
							if (!ch.path) { try { cwdInput.focus(); } catch (e) { /* */ } }
						});
					});

					cwdLabel.appendChild(field);
					host.appendChild(cwdLabel);
					// 清单来源如实说明：只有"和工作区栏一样"时才不提示
					var cwdNoteText = '';
					if (opt && opt.workspaceSource === 'workspace') {
						cwdNoteText = '没读到 IDE 的工作区记录（workspaces.json）⇒ 下面是 dsh 已登记的单目录工作区，没有多根分组。';
					} else if (!opt || opt.workspaceSource === 'fallback') {
						cwdNoteText = 'dsh 工作区注册表不可用 ⇒ 上面是兜底候选（config.tuiCwd / Host cwd / 最近用过的目录），不是会话里那份工作区清单。';
					}
					if (cwdNoteText) {
						var cwdNote = document.createElement('p');
						cwdNote.className = 'hint';
						cwdNote.textContent = cwdNoteText;
						host.appendChild(cwdNote);
					}

					// ── 模式（preset）：与 chat-surface 的「模式」chip 同款自绘浮层 ──────────
					// ★ 同白名单 / 同分组标题 / 同文案 / 不显示内部 id（后端 `presetMenuItems` 已整理好）。
					var pLabel = document.createElement('label');
					pLabel.textContent = '模式（agent preset；与聊天框的模式 chip 同一份菜单，仅新会话生效）';
					var presetField = createPickField({ id: 'f-preset', pickId: 'f-preset-pick', ariaLabel: '选择模式' });

					/**
					 * 写当前模式。⚠ 老格位可能挂着**不在菜单里**的 preset（如已退役的 vssaros-full）
					 * ⇒ 原样保留并注明，不能悄悄清空（那等于"重开一次就把模式换了"）。
					 */
					function applyPreset(id) {
						var cur = String(id || '');
						var hit = null;
						presets.forEach(function (x) { if (!hit && x.id === cur) { hit = x; } });
						if (hit) {
							presetField.set(hit.id, hit.name || hit.id, hit.desc || '',
								(hit.name || hit.id) + (hit.desc ? '\n' + hit.desc : '') + '\n' + hit.id);
						} else if (cur) {
							presetField.set(cur, cur + '（不在菜单里，按原值保留）', '', cur);
						} else {
							presetField.set('', '（不指定，用部署默认）', '', '不传 --agent-preset，用部署默认模式');
						}
					}

					// ── Bot（Agent）：与「模式」互斥的另一个 --agent-preset 入口 ──────────
					// ★ dsh 内部 **agent 也是以 preset 存在的**（chat-surface 的模式菜单就是这么区分的：
					//   白名单里的算模式，其余 roster 行是 Bot）⇒ 选 bot 就是传 `--agent-preset <botId>`。
					var aLabel = document.createElement('label');
					aLabel.textContent = 'Bot（agent preset；与「模式」二选一，仅新会话生效）';
					var agentField = createPickField({ id: 'f-agent', pickId: 'f-agent-pick', ariaLabel: '选择 Bot' });
					var agentItems = (agents || []).map(function (a) {
						return { id: a.id, name: a.name || a.id, desc: a.desc || '', group: '', groupTitle: '' };
					});
					function applyAgent(id) {
						var cur = String(id || '');
						var hit = null;
						agentItems.forEach(function (x) { if (!hit && x.id === cur) { hit = x; } });
						if (hit) {
							agentField.set(hit.id, hit.name, hit.desc, hit.name + (hit.desc ? '\n' + hit.desc : '') + '\n' + hit.id);
						} else if (cur) {
							agentField.set(cur, cur + '（不在 roster 里，按原值保留）', '', cur);
						} else {
							agentField.set('', '（不指定，用模式 / 部署默认）', '',
								agents ? '不指定 Bot：按「模式」或部署默认起格' : '这个 Host 没有 agentPresets 服务，无法选择 Bot');
						}
					}

					// 互斥：两者最终都是 `--agent-preset`，同时选会打架 ⇒ 选一个就清掉另一个
					presetField.pick.addEventListener('click', function () {
						openPresetPop(presetField.pick, { items: presets, value: presetField.input.value }, function (ch) {
							applyPreset(ch.id);
							if (ch.id) { applyAgent(''); }
						});
					});
					agentField.pick.addEventListener('click', function () {
						openPresetPop(agentField.pick, { items: agentItems, value: agentField.input.value }, function (ch) {
							applyAgent(ch.id);
							if (ch.id) { applyPreset(''); }
						});
					});

					// 初值：一个格位只可能挂着"模式"或"Bot"之一（提交时合并到同一个 preset 字段）⇒ 认领到对应那一栏
					(function initModeAndAgent() {
						// ★ 没有 prefill 时用 Host 给的默认模式（= 「标准模式（VsSaros）」，用户 2026-10-23 要求）
						var cur = String(p.preset || (opt && opt.defaults && opt.defaults.preset) || '');
						var isBot = !!cur && agentItems.some(function (x) { return x.id === cur; });
						if (isBot) { applyAgent(cur); applyPreset(''); }
						else { applyPreset(cur); applyAgent(p.agent || ''); }
					})();

					pLabel.appendChild(presetField.field);
					host.appendChild(pLabel);
					aLabel.appendChild(agentField.field);
					host.appendChild(aLabel);
					if (agents === null) {
						var aNote = document.createElement('p');
						aNote.className = 'hint';
						aNote.textContent = '这个 Host 没有 agentPresets 服务（老版本 / 非 web profile）⇒ Bot 列表拿不到，只能按「模式」起格。';
						host.appendChild(aNote);
					}

					// ── 模型：**起格后立即打开 /model 面板**（用户 2026-10-23 第二次要模型入口）──────
					// 为什么不是下拉：社区 TUI 的 CLI 只有 --resume / --agent-preset，**没有 --model**
					// （`lib/index.js:807` 的 agentOptions 取自 profile 的 agent-default-model）⇒ 起格时
					// 指定模型无法保证生效。真正能改模型的是 TUI 自己的 /model 面板（还能「设为默认」）
					// ⇒ 这里给一个开关：起格成功后**自动把那格的面板叫出来**，用户选完即生效。
					var mLabel = document.createElement('label');
					mLabel.className = 'check';
					var mCheck = document.createElement('input');
					mCheck.type = 'checkbox';
					mCheck.id = 'f-open-model';
					var mText = document.createElement('span');
					mText.textContent = '起格后打开模型面板（/model）';
					mLabel.appendChild(mCheck);
					mLabel.appendChild(mText);
					host.appendChild(mLabel);

					var mNote = document.createElement('p');
					mNote.className = 'hint';
					mNote.textContent = '模型由 tui profile 的默认模型决定（TUI 的 CLI 没有 --model）⇒ 勾上这一项，'
						+ '起格后会在该格里自动打开 /model 面板：选一个模型点「设为默认」，之后所有新格都用它。';
					host.appendChild(mNote);

					var hint = document.createElement('p');
					hint.className = 'hint';
					hint.innerHTML = '⚠ 这两项都<b>只能开进程时定</b>：TUI 没有切换工作区的命令；'
						+ 'preset 也只有 <code>--agent-preset</code>（而且带 <code>--resume</code> 时会被忽略）。'
						+ '<br>要改已经在跑的格子 ⇒ 用该格格头的 <b>⚙</b> →「换目录 / preset 重开」。';
					host.appendChild(hint);
				},
				actions: [
					{ label: '取消', run: function (close) { close(); } },
					{
						label: p.cellId ? '关掉并按此重开' : '起格',
						primary: true,
						/**
						 * ★ 用户报过"点起格没反应"。现在：
						 *   ① 点击立刻变成「起格中…」并禁用（能看出它在跑）；
						 *   ② 失败**不关弹层**，原因就地写在按钮上方（不指望用户看到右上角 toast）；
						 *   ③ 成功才关。
						 */
						run: function (close, body, btn) {
							// 工作区的**唯一真值**就是隐藏 input（选择器与自定义输入都写它）✓
							var cwdInp = body.querySelector('#f-cwd');
							var presetEl = body.querySelector('#f-preset');
							var agentEl = body.querySelector('#f-agent');
							var cwd = cwdInp ? String(cwdInp.value || '').trim() : '';
							// Bot 与模式互斥（UI 已保证），这里再取一次"谁非空"，Bot 优先
							var agent = agentEl ? String(agentEl.value || '').trim() : '';
							var mode = presetEl ? String(presetEl.value || '').trim() : '';
							var preset = agent || mode;
							if (!cwd) {
								showFormError(body, '请先选择工作区（或在「自定义路径」里填一个绝对路径）。');
								return;
							}
							var idleLabel = btn ? btn.textContent : '';
							if (btn) { btn.disabled = true; btn.textContent = '起格中…'; }
							function fail(e) {
								if (btn) { btn.disabled = false; btn.textContent = idleLabel; }
								showFormError(body, (p.cellId ? '重开失败：' : '起格失败：') + String((e && e.message) || e));
							}
							var modelCheck = body.querySelector('#f-open-model');
							var openModel = !!(modelCheck && modelCheck.checked);
							if (p.cellId) {
								reopenCell(p.cellId, cwd, preset).then(function () { close(); }, fail);
							} else {
								createCellReq(cwd, preset).then(function (id) {
									close();
									// 勾了「起格后打开模型面板」⇒ 等 TUI 起来再把 /model 送进去
									if (openModel && id) {
										setTimeout(function () { sendInput(id, '/model\r'); }, 1800);
										showToast('已向 ' + id + ' 发送 /model（选完可在面板里「设为默认」）');
									}
								}, fail);
							}
						}
					}
				]
			});
		});
	}

	/** 单格菜单：模型面板 / preset 面板 / 换目录重开。 */
	function openCellMenu(id) {
		var cur = state.cells.filter(function (c) { return c.id === id; })[0];
		if (!cur) { return; }
		showModal({
			title: '格位 ' + id,
			// 格子的 title 默认就是 id ⇒ 相同时不要再显示一遍（否则标题读作"格位 A1A1"）
			sub: cur.title && cur.title !== id ? cur.title : '',
			build: function (host) {
				var ro = document.createElement('div');
				ro.className = 'ro';
				ro.textContent = 'cwd: ' + (cur.cwd || '(未知)')
					+ '\npreset: ' + (cur.preset || '(部署默认)')
					+ '\nstate: ' + stateText(cur);
				host.appendChild(ro);

				var hint = document.createElement('p');
				hint.className = 'hint';
				hint.textContent = '工作区与 preset 是进程启动参数 ⇒ 运行中改不了。下面前两项是把 TUI 自己的面板叫出来。';
				host.appendChild(hint);

				var acts = [
					{
						i: '⌘', n: '打开模型面板（/model）',
						d: '在格子里输入 /model 并回车 —— 改的是默认模型，新会话才生效',
						run: function (close) {
							close();
							sendInput(id, '/model\r');
							showToast('已向 ' + id + ' 发送 /model（改完要 /clear 起新会话才生效）');
						}
					},
					{
						i: '◈', n: '打开 preset 面板（/presets）',
						d: '仅空白会话可用；已有消息的会话要先 /clear',
						run: function (close) {
							close();
							sendInput(id, '/presets\r');
							showToast('已向 ' + id + ' 发送 /presets（空白会话才可选）');
						}
					},
					{
						i: '📁', n: '换目录 / preset 重开…',
						d: '关掉本格并用新参数重起（会中断当前会话；会话已落盘，新格里可用 /resume 接回）',
						run: function (close) {
							close();
							openAddCell({ cellId: id, cwd: cur.cwd, preset: cur.preset });
						}
					}
				];
				acts.forEach(function (a) {
					var btn = document.createElement('button');
					btn.className = 'act';
					btn.innerHTML = '<span class="ai">' + a.i + '</span>'
						+ '<span class="am"><span class="an">' + escapeText(a.n) + '</span>'
						+ '<span class="ad">' + escapeText(a.d) + '</span></span>';
					btn.addEventListener('click', function () { a.run(close); });
					host.appendChild(btn);
				});
			},
			actions: [{ label: '关闭', run: function (close) { close(); } }]
		});
	}

	// ── 列数（1/2/3/自动）──────────────────────────────────────────────────
	// ⚠ 自动模式**不是**"尽量多塞"：CSS 里给的是 minmax(min(460px,100%),1fr) ⇒ 每格至少 460px
	//   （约 60 列，TUI 才排得开）。窄了宁可换行，也不把格子压扁（上一版就是这么挤爆的）。
	var COLS_KEY = 'vssaros.parallel.cols';
	function applyCols(mode) {
		var m = mode === '1' || mode === '2' || mode === '3' ? mode : 'auto';
		if (els.grid) { els.grid.setAttribute('data-cols', m); }
		var seg = document.getElementById('cols-seg');
		if (seg) {
			[].slice.call(seg.querySelectorAll('button')).forEach(function (b) {
				b.setAttribute('aria-pressed', b.getAttribute('data-cols') === m ? 'true' : 'false');
			});
		}
		try { localStorage.setItem(COLS_KEY, m); } catch (e) { /* 私密模式 */ }
		refitAll();
	}
	function loadCols() {
		try { return localStorage.getItem(COLS_KEY) || 'auto'; } catch (e) { return 'auto'; }
	}

	/** 重排所有终端的行列（列数变了 / 字体加载完 / 放大还原后都要）。 */
	function refitAll() {
		Object.keys(views).forEach(function (id) { refit(views[id]); });
	}
	function refit(view) {
		if (!view || !view.fit) { return; }
		// 布局刚变 ⇒ 等浏览器把尺寸算完再 fit（否则还是旧宽度）
		window.requestAnimationFrame(function () {
			try { view.fit.fit(); } catch (e) { /* 容器还没尺寸 */ }
		});
	}

	// ── 放大单格（用 class 提升为 fixed 全屏，不改 DOM 结构 ⇒ xterm 重新 fit 就能拿到宽屏列数）──
	var maxId = null;
	function toggleMax(id) {
		if (maxId === id) { return exitMax(); }
		exitMax();
		var view = views[id];
		if (!view) { return; }
		maxId = id;
		view.root.classList.add('is-max');
		var mask = document.createElement('div');
		mask.className = 'maxmask';
		mask.id = 'max-mask';
		mask.addEventListener('click', exitMax);
		document.body.appendChild(mask);
		document.body.classList.add('has-max');
		applyDim();
		refit(view);
		try { view.term && view.term.focus(); } catch (e) { /* */ }
	}
	function exitMax() {
		if (!maxId) { return; }
		var view = views[maxId];
		if (view) { view.root.classList.remove('is-max'); }
		var mask = document.getElementById('max-mask');
		if (mask) { mask.remove(); }
		document.body.classList.remove('has-max');
		maxId = null;
		applyDim();
		if (view) { refit(view); }
	}
	/** 放大态下给其余格加/去 dim（只切 class，不重排 DOM ⇒ xterm 不受影响）。 */
	function applyDim() {
		Object.keys(views).forEach(function (id) {
			views[id].root.classList.toggle('dim', !!maxId && maxId !== id);
		});
	}

	function refresh() {
		return fetch(withToken(API + '/state'), { credentials: 'same-origin' })
			.then(function (r) { return r.json(); })
			.then(function (j) {
				state.ptyOk = !!(j && j.ok);
				state.error = (j && j.error) || '';
				state.maxCells = (j && j.maxCells) || 0;
				state.cells = (j && j.cells) || [];
				if (els.ptyPill) {
					els.ptyPill.setAttribute('data-pty', state.ptyOk ? 'ok' : 'bad');
					els.ptyPill.textContent = state.ptyOk
						? 'PTY 就绪' + (j.pty && j.pty.via ? ' · ' + j.pty.via : '')
						: 'PTY 不可用';
				}
				if (els.addBtn) { els.addBtn.disabled = !state.ptyOk; }
				// ★ TUI 运行时（runtime 版本 / 是否满足社区 TUI 的 peer / tui profile 状态）
				var tui = (j && j.tui) || {};
				if (els.tuiPill) {
					els.tuiPill.setAttribute('data-tui', tui.satisfies ? 'ok' : 'bad');
					els.tuiPill.textContent = 'TUI 运行时 ' + (tui.dshVersion || '未找到') + (tui.satisfies ? ' ✓' : ' ✗');
					var probs = (tui.problems || []).filter(Boolean);
					els.tuiPill.title = probs.length ? probs.join('\n') : ('要求 dsh >= ' + (tui.minDsh || '?'));
				}
				if (!state.ptyOk) {
					var why = (state.error || '未知原因');
					var tips = (tui.problems || []).filter(Boolean);
					setBanner('格位后端不可用：' + why
						+ (tips.length ? '<br>待解决：<br>· ' + tips.map(escapeText).join('<br>· ') : '')
						+ '<br>格位进程要 <code>node-pty</code>；插件在 profile、它在 runtime ⇒ 自动探测失败时可设 <code>DSH_RUNTIME_DIR</code>。', true);
				} else if (state.error) {
					setBanner('格位后端部分可用：' + state.error, true);
				} else if ((tui.problems || []).length) {
					setBanner('可以起格，但有注意事项：<br>·' + tui.problems.map(escapeText).join('<br>·'), false);
				}
				render();
			})
			.catch(function (e) { setBanner('读取状态失败：' + String((e && e.message) || e), true); });
	}

	function init() {
		els.grid = document.getElementById('grid');
		els.banner = document.getElementById('banner');
		els.ptyPill = document.getElementById('pty-pill');
		els.tuiPill = document.getElementById('tui-pill');
		els.countPill = document.getElementById('count-pill');
		els.addBtn = document.getElementById('add-btn');
		els.closeAllBtn = document.getElementById('close-all-btn');

		// 顶部补一个「⟳ 重绘」：画面被错位残留弄花时一键修复（DOM 里没有，这里动态插入 ⇒ 不用改服务端模板）
		var bar = document.querySelector('.bar');
		if (bar && !document.getElementById('redraw-btn')) {
			var redrawBtn = document.createElement('button');
			redrawBtn.className = 'btn';
			redrawBtn.id = 'redraw-btn';
			redrawBtn.title = '清掉错位残留，并让各格 TUI 整屏重绘（画面花掉时点这个）';
			redrawBtn.textContent = '⟳ 重绘';
			redrawBtn.addEventListener('click', function () {
				var n = 0;
				Object.keys(views).forEach(function (id) {
					var v = views[id];
					if (!v.term) { return; }
					try { v.term.write('\u001b[2J\u001b[H'); } catch (e) { /* 已释放 */ }
					forceRedraw(id, v.term.cols, v.term.rows);
					n += 1;
				});
				showToast(n ? ('已请求 ' + n + ' 格重绘（清屏 + 让 TUI 整屏重画）') : '现在没有格位可重绘');
			});
			bar.appendChild(redrawBtn);
		}

		if (els.addBtn) {
			// ★ 起格前先给一个表单：工作区目录 + preset（这两项只能开进程时定，见 openAddCell 的说明）
			els.addBtn.addEventListener('click', function () { openAddCell(); });
		}
		if (els.closeAllBtn) {
			els.closeAllBtn.addEventListener('click', function () {
				var ids = state.cells.map(function (c) { return c.id; });
				if (!ids.length) { showToast('现在没有格位可关'); return; }
				Promise.all(ids.map(function (id) {
					return fetch(withToken(API + '/cells/' + encodeURIComponent(id)), { method: 'DELETE', credentials: 'same-origin' });
				})).then(function () {
					showToast('已关闭 ' + ids.length + ' 格：各自的 PTY 都已结束（不可恢复）');
					return refresh();
				}, function (e) {
					var msg = '关闭失败：' + String((e && e.message) || e);
					showToast(msg, true);
					setBanner(msg, true);
				});
			});
		}
		// 列数：先按记忆的偏好铺好，再绑切换
		applyCols(loadCols());
		var seg = document.getElementById('cols-seg');
		if (seg) {
			seg.addEventListener('click', function (ev) {
				var b = ev.target && ev.target.closest ? ev.target.closest('button[data-cols]') : null;
				if (b) { applyCols(b.getAttribute('data-cols')); }
			});
		}
		// Esc：**先关最上层的弹层**，没有弹层才退出放大（否则弹层开着按 Esc 会连带退出放大，很怪）
		document.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Escape') { return; }
			if (openModals.length) { openModals[openModals.length - 1](); return; }
			if (state.maxId) { exitMax(); }
		});
		// 字体加载完再 fit 一次：否则列数按回退字宽算，会偏（等宽字体尤其明显）
		if (document.fonts && document.fonts.ready && typeof document.fonts.ready.then === 'function') {
			document.fonts.ready.then(function () { refitAll(); }, function () { /* 拿不到就算了 */ });
		}

		refresh();
		// 慢轮询兜底（SSE 管输出，这里只管"格的增删与状态"）
		setInterval(refresh, 5000);

		/**
		 * 只读诊断出口（排障用）：能把某格 xterm 缓冲区里的**真实文本**读出来。
		 * ⚠ 为什么需要：TUI 花屏/错位时，光看尺寸和截图判断不了"是 PTY 尺寸不对、还是旧帧没清"，
		 *   读到缓冲区内容就能一眼分辨（内容折行错位 = 宽度不匹配；内容空白 = 清了但没重绘）。
		 * ⚠ 只读：不暴露 views / term 本体 ⇒ 外部无法 dispose 或写坏终端。
		 */
		window.__vssarosParallel = {
			stats: function () {
				return {
					ptyOk: state.ptyOk, error: state.error, maxCells: state.maxCells,
					countText: els.countPill ? els.countPill.textContent : '',
					cells: state.cells.map(function (c) {
						var v = views[c.id];
						return {
							id: c.id, state: c.state, cols: c.cols, rows: c.rows,
							termCols: v && v.term ? v.term.cols : null,
							termRows: v && v.term ? v.term.rows : null,
						};
					}),
				};
			},
			/** 读某格当前屏幕（截图不可判时用它）。 */
			screen: function (id) {
				var v = views[id];
				if (!v || !v.term) { return null; }
				var b = v.term.buffer.active;
				var lines = [];
				for (var i = 0; i < b.length; i += 1) {
					var line = b.getLine(i);
					lines.push(line ? line.translateToString(true) : '');
				}
				return { cols: v.term.cols, rows: v.term.rows, baseY: b.baseY, lines: lines };
			},
			redraw: function (id) {
				var v = views[id];
				if (!v || !v.term) { return false; }
				try { v.term.write('\u001b[2J\u001b[H'); } catch (e) { /* 已释放 */ }
				forceRedraw(id, v.term.cols, v.term.rows);
				return true;
			},
		};
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
