// @vssaros/dsh-chat-surface — 聊天框「选择知识库文件夹根目录」工具卡（2026-11-10 用户要求）
//
// 两条触发 → **同一张卡**（同一份 `mountKbRootPicker` 纯 DOM 渲染 + 同一份模块级状态）：
//   A 模型触发：知识库专家调 `kb_setup_root` ⇒ 官方按 `tool.call.toolview` 的 key 渲染 ToolCardView；
//   B UI 触发：点消息底栏「导入到知识库」且根未配置 ⇒ `window.__vssarosOpenKbRootPicker('ui', …)`
//     ⇒ 在消息流末尾插入同形虚拟卡（DOM 注入 + MutationObserver 保持，与 client.msgImport.js 同款）。
//
// 口径（用户已拍板）：选中的根**直接当唯一库根**；两个顶层区是磁盘真名 `数据源/` 与 `知识库列表/`
// （后者每个文件夹 = 一个独立知识库）；配置**以 dsh 侧为准**（`/x/kb/api/root-config`），不碰 IDE。
//
// ⚠ 卡片只负责"选根 + 提交"，绝不自己 mkdir / 猜路径；服务端做绝对路径校验、只读接入已存在内容、
//   缺哪个区补哪个。取消要出声（不静默）。颜色一律 `var(--dsw-alias-*, …)`，切外观自动跟随。

window.__ModuleLoader__.load({
	id: '@vssaros/dsh-chat-surface',
	chunk: 'client.kbRootPicker.js',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require('react');

		const TOOL_KEY = 'kb_setup_root';
		const TOOL_SLOT = 'tool.call.toolview';
		const CANDIDATES_API = '/x/kb/api/root-candidates';
		const CONFIG_API = '/x/kb/api/root-config';
		const HOST_ATTR = 'data-vssaros-kb-root-picker-host';
		const STYLE_ID = 'vssaros-kb-root-picker-style';

		let ctx = null;
		let hostEl = null;
		let observer = null;
		const state = {
			open: false, source: 'model', phase: 'idle', candidates: [], selected: '',
			configured: '', defaultRoot: '', error: '', result: null, retry: null,
		};

		function injectStyle() {
			// ⚠ 守卫/探针里的假 document 只实现了部分方法（check-chat-surface-chunks.mjs 的
			//   `install()` 冒烟就因此抛过 `document.getElementById is not a function`）⇒ 逐项判型，
			//   样式注入失败**不影响**槽注册这一主要功能。
			try {
				if (typeof document === 'undefined' || typeof document.getElementById !== 'function'
					|| typeof document.createElement !== 'function' || !document.head
					|| typeof document.head.appendChild !== 'function') { return; }
				if (document.getElementById(STYLE_ID)) { return; }
			} catch { return; }
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = [
				'.kbrp{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border-radius:6px;font-size:11.5px;line-height:1.6;',
				'background:var(--dsw-alias-bg-layer-1,var(--vscode-editor-background,transparent));',
				'border:1px solid var(--dsw-alias-border-l1,var(--vscode-panel-border,transparent));',
				'color:var(--dsw-alias-label-primary,var(--vscode-foreground,inherit));}',
				'.kbrp-hd{display:flex;align-items:center;gap:8px;font-size:11px;}',
				'.kbrp-nm{font-family:ui-monospace,Consolas,monospace;}',
				'.kbrp-sp{flex:1;}',
				'.kbrp-tag{font-size:10px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-state-warn-primary,var(--vscode-inputValidation-warningBorder,transparent));',
				'color:var(--dsw-alias-state-warn-primary,var(--vscode-inputValidation-warningForeground,inherit));}',
				'.kbrp-card[data-phase="done"] .kbrp-tag{border-color:var(--dsw-alias-state-success-primary,transparent);color:var(--dsw-alias-state-success-primary,inherit);}',
				'.kbrp-card[data-phase="err"] .kbrp-tag{border-color:var(--dsw-alias-state-error-primary,transparent);color:var(--dsw-alias-state-error-primary,inherit);}',
				'.kbrp-t{font-size:13px;font-weight:600;}',
				'.kbrp-d{font-size:11px;color:var(--dsw-alias-label-secondary,var(--vscode-descriptionForeground,inherit));}',
				'.kbrp-tree{font:11px/1.7 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all;padding:7px 9px;border-radius:5px;',
				'background:var(--dsw-alias-bg-layer-2,var(--vscode-editor-background,transparent));',
				'border:1px solid var(--dsw-alias-border-l1,transparent);}',
				'.kbrp-lab{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);}',
				'.kbrp-cands{display:flex;flex-direction:column;gap:5px;}',
				'.kbrp-cand{display:flex;gap:7px;align-items:flex-start;text-align:left;font:inherit;font-size:11px;padding:6px 8px;border-radius:5px;cursor:pointer;',
				'background:transparent;color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l2,transparent);}',
				'.kbrp-cand:hover{background:var(--dsw-alias-interactive-bg-hover,transparent);}',
				'.kbrp-cand[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary,transparent);background:var(--dsw-alias-interactive-bg-active,transparent);}',
				'.kbrp-cand .p{font-family:ui-monospace,Consolas,monospace;word-break:break-all;}',
				'.kbrp-cand .n{font-size:10px;color:var(--dsw-alias-label-secondary,inherit);}',
				'.kbrp-rec{font-size:10px;color:var(--dsw-alias-state-warn-primary,inherit);margin-left:5px;}',
				'.kbrp-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
				'.kbrp-in{flex:1 1 220px;min-width:140px;font:inherit;font-size:11px;padding:4px 7px;border-radius:4px;',
				'background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);',
				'border:1px solid var(--dsw-alias-border-l2,transparent);}',
				'.kbrp-btn{font:inherit;font-size:11px;padding:3px 10px;border-radius:4px;cursor:pointer;',
				'background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-label-primary,inherit);',
				'border:1px solid var(--dsw-alias-border-l2,transparent);}',
				'.kbrp-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--vscode-button-background,transparent));',
				'color:var(--dsw-alias-label-primary-inverted,var(--vscode-button-foreground,inherit));',
				'border-color:var(--dsw-alias-button-primary-fill,transparent);}',
				'.kbrp-btn[disabled]{opacity:.55;cursor:default;}',
				'.kbrp-prev{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);word-break:break-all;}',
				'.kbrp-err{font-size:11px;color:var(--dsw-alias-state-error-primary,var(--vscode-errorForeground,inherit));}',
				'.kbrp-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,inherit);}',
				'.kbrp-note{font-size:10.5px;color:var(--dsw-alias-label-secondary,inherit);}',
			].join('');
			document.head.appendChild(el);
		}

		function say(text) {
			try {
				const el = document.createElement('div');
				el.setAttribute('data-vssaros-kb-toast', '1');
				el.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:9999;max-width:70%;'
					+ 'padding:8px 14px;border-radius:6px;font-size:12px;pointer-events:none;'
					+ 'color:var(--dsw-alias-label-primary,var(--vscode-foreground,inherit));'
					+ 'background:var(--dsw-alias-bg-overlay,var(--vscode-editor-background,rgba(30,30,30,.95)));'
					+ 'border:1px solid var(--dsw-alias-border-l2,transparent);';
				el.textContent = text;
				document.body.appendChild(el);
				setTimeout(() => { try { el.remove(); } catch { /* ignore */ } }, 3200);
			} catch { /* ignore */ }
		}

		function isAbsolute(p) {
			return /^[A-Za-z]:[\\/]/.test(p) || p.charAt(0) === '/' || p.slice(0, 2) === '\\\\';
		}
		function validate(p) {
			if (!p || !p.trim()) { return '请先选一个候选，或填写根目录的绝对路径'; }
			if (!isAbsolute(p.trim())) { return '请填写绝对路径（例如 E:\\我的知识库）；相对路径会落到宿主进程的当前目录'; }
			if (/[?*"<>|]/.test(p.replace(/^[A-Za-z]:/, ''))) { return '路径里含有非法字符 ? * " < > |'; }
			return '';
		}

		async function loadCandidates() {
			try {
				const r = await fetch(CANDIDATES_API, { credentials: 'same-origin' });
				const j = await r.json();
				if (j && j.ok) {
					state.candidates = Array.isArray(j.candidates) ? j.candidates : [];
					state.configured = String(j.configured || '');
					state.defaultRoot = String(j.defaultRoot || '');
					if (!state.selected) { state.selected = state.configured || state.defaultRoot || ''; }
				}
			} catch (e) { state.error = '候选目录读取失败：' + String((e && e.message) || e); }
		}

		async function submit() {
			const p = String(state.selected || '').trim();
			const bad = validate(p);
			if (bad) { state.error = bad; render(); return; }
			state.phase = 'busy'; state.error = ''; render();
			try {
				const r = await fetch(CONFIG_API, {
					method: 'POST', credentials: 'same-origin',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ path: p }),
				});
				const j = await r.json();
				if (!j || j.ok === false) { throw new Error(String((j && j.error) || ('HTTP ' + r.status))); }
				state.result = j;
				state.phase = 'done';
			} catch (e) {
				state.phase = 'err';
				state.error = '配置失败：' + String((e && e.message) || e) + '（可换一个位置或重试）';
			}
			render();
		}

		function browse() {
			try {
				const uw = ctx && ctx.uiWorkspace;
				if (!uw || typeof uw.pickDirectory !== 'function') {
					state.error = '宿主没有目录选择器（uiWorkspace.pickDirectory 不可用），请手动输入绝对路径';
					render(); return;
				}
				void Promise.resolve(uw.pickDirectory()).then((picked) => {
					if (typeof picked !== 'string' || !picked) {
						say('已取消选择目录（未配置根目录）');
						return;
					}
					state.selected = picked; state.error = '';
					render();
				}).catch((e) => {
					state.error = '选择目录失败：' + String((e && e.message) || e);
					render();
				});
			} catch (e) {
				state.error = '选择目录失败：' + String((e && e.message) || e);
				render();
			}
		}

		function buildDom() {
			const el = document.createElement('div');
			el.className = 'kbrp kbrp-card';
			el.setAttribute('data-vssaros-kb-root-picker', '1');
			el.setAttribute('data-phase', state.phase);
			el.setAttribute('data-source', state.source);
			const h = (tag, attrs, text) => {
				const n = document.createElement(tag);
				for (const k of Object.keys(attrs || {})) {
					if (attrs[k] === null || attrs[k] === undefined) { continue; }
					if (k === 'class') { n.className = attrs[k]; }
					else if (k === 'onclick') { n.addEventListener('click', attrs[k]); }
					else if (k === 'oninput') { n.addEventListener('input', attrs[k]); }
					else { n.setAttribute(k, String(attrs[k])); }
				}
				if (text !== undefined && text !== null) { n.textContent = String(text); }
				return n;
			};
			const phaseText = state.phase === 'busy' ? '配置中…' : state.phase === 'done' ? '已配置'
				: state.phase === 'err' ? '配置失败' : '等待你选择';
			el.appendChild(h('div', { class: 'kbrp-hd' }, null));
			const hd = el.firstChild;
			hd.appendChild(h('span', {}, '▾'));
			hd.appendChild(h('span', { class: 'kbrp-nm' }, TOOL_KEY));
			hd.appendChild(h('span', { class: 'kbrp-sp' }));
			hd.appendChild(h('span', { class: 'kbrp-note' }, state.source === 'ui' ? '触发：导入到知识库' : '触发：模型工具调用'));
			hd.appendChild(h('span', { class: 'kbrp-tag' }, phaseText));

			if (state.phase === 'done' && state.result) {
				const box = h('div', {});
				box.appendChild(h('div', { class: 'kbrp-ok' }, '✓ 已配置知识库文件夹根目录（= 唯一库根）'));
				box.appendChild(h('div', { class: 'kbrp-tree' },
					state.result.root + '  ← 唯一库根\n'
					+ '├── 数据源/     原始文件\n'
					+ '└── 知识库列表/ 每个文件夹 = 一个独立知识库（当前 ' + Number(state.result.knowledgeBases || 0) + ' 个）'));
				box.appendChild(h('div', { class: 'kbrp-note' },
					'已存在的内容只读接入；缺的区：' + ((state.result.created || []).join('、') || '无（两个区都已存在）')));
				const acts = h('div', { class: 'kbrp-row' });
				if (typeof state.retry === 'function') {
					acts.appendChild(h('button', { class: 'kbrp-btn primary', type: 'button', onclick: () => {
						const fn = state.retry; state.retry = null; fn();
					} }, state.source === 'ui' ? '继续导入这条消息' : '继续刚才的任务'));
				}
				acts.appendChild(h('button', { class: 'kbrp-btn', type: 'button', onclick: () => {
					state.open = false; render();
				} }, '收起'));
				box.appendChild(acts);
				el.appendChild(box);
				return el;
			}

			el.appendChild(h('div', { class: 'kbrp-t' }, '选择知识库文件夹根目录'));
			el.appendChild(h('div', { class: 'kbrp-d' },
				'还没配置根目录。你选的文件夹直接当唯一库根，下面固定两个顶层区；已存在的内容不会被移动、复制或改名。'));
			el.appendChild(h('div', { class: 'kbrp-tree' },
				'<你选的根>\\  ← 唯一库根\n'
				+ '├── 数据源/      原始文件（PDF / 图片 / 文章…）\n'
				+ '└── 知识库列表/  每个文件夹 = 一个独立知识库'));
			el.appendChild(h('div', { class: 'kbrp-lab' }, '推荐位置'));
			const cands = h('div', { class: 'kbrp-cands' });
			for (const c of state.candidates) {
				const on = String(c.path || '').toLowerCase() === String(state.selected || '').toLowerCase();
				const b = h('button', { class: 'kbrp-cand', type: 'button', 'aria-pressed': on ? 'true' : 'false',
					'data-vssaros-kb-root-candidate': String(c.path || ''), onclick: () => {
						state.selected = String(c.path || ''); state.error = ''; render();
					} });
				const main = h('span', {});
				const p = h('span', { class: 'p' }, c.path);
				main.appendChild(p);
				if (c.recommended) { main.appendChild(h('span', { class: 'kbrp-rec' }, '推荐')); }
				if (c.label && !c.recommended) { main.appendChild(h('span', { class: 'kbrp-rec' }, c.label)); }
				main.appendChild(h('div', { class: 'n' }, c.note || ''));
				b.appendChild(main);
				cands.appendChild(b);
			}
			el.appendChild(cands);
			el.appendChild(h('div', { class: 'kbrp-lab' }, '或用系统选择器 / 手动输入根目录的绝对路径'));
			const row = h('div', { class: 'kbrp-row' });
			row.appendChild(h('button', { class: 'kbrp-btn', type: 'button', 'data-vssaros-kb-root-browse': '1',
				onclick: browse }, '浏览…'));
			const input = h('input', { class: 'kbrp-in', type: 'text', spellcheck: 'false',
				placeholder: '例如 E:\\我的知识库', 'data-vssaros-kb-root-input': '1' });
			input.value = state.selected || '';
			input.addEventListener('input', (e) => { state.selected = e.target.value; state.error = ''; });
			row.appendChild(input);
			el.appendChild(row);
			el.appendChild(h('div', { class: 'kbrp-prev' }, '将配置为根目录：' + (state.selected || '（未选择）')
				+ ' · 结构 数据源/ + 知识库列表/'));
			if (state.error) { el.appendChild(h('div', { class: 'kbrp-err', 'data-vssaros-kb-root-error': '1' }, state.error)); }
			const acts = h('div', { class: 'kbrp-row' });
			acts.appendChild(h('span', { class: 'kbrp-note' }, '选完才写配置；取消不产生副作用'));
			acts.appendChild(h('button', { class: 'kbrp-btn', type: 'button', onclick: () => {
				state.open = false; say('已暂不配置；下次点「导入到知识库」还会再问'); render();
			} }, '暂不配置'));
			acts.appendChild(h('button', { class: 'kbrp-btn primary', type: 'button', disabled: state.phase === 'busy' ? 'disabled' : null,
				'data-vssaros-kb-root-submit': '1', onclick: submit }, state.phase === 'busy' ? '配置中…' : '使用这个根目录'));
			el.appendChild(acts);
			return el;
		}

		/** 所有挂载点共用：清空容器 → 重绘同一张卡。 */
		function renderInto(container) {
			if (!container) { return; }
			container.innerHTML = '';
			if (!state.open) { return; }
			container.appendChild(buildDom());
		}

		/** 收集当前所有挂载点（工具卡里的 ref 容器 + 消息流里的虚拟卡 host）。 */
		function render() {
			renderInto(hostEl);
			try {
				for (const node of document.querySelectorAll('[data-vssaros-kb-root-toolview]')) { renderInto(node); }
			} catch { /* ignore */ }
		}

		/** 找消息流里最后一条消息，作为虚拟卡的插入锚点（与 msgImport 的 endInfo 判据同源）。 */
		function lastMessageRow() {
			try {
				const rows = [...document.querySelectorAll('[class*="endInfo"]')];
				const row = rows.length ? rows[rows.length - 1] : null;
				if (!row) { return null; }
				let el = row.parentElement;
				for (let i = 0; i < 3 && el && el.parentElement; i++) { el = el.parentElement; }
				return el || null;
			} catch { return null; }
		}

		function ensureHost() {
			if (hostEl && hostEl.isConnected) { return hostEl; }
			const anchor = lastMessageRow();
			if (!anchor || !anchor.parentElement) { return null; }
			const el = document.createElement('div');
			el.setAttribute(HOST_ATTR, '1');
			anchor.parentElement.insertBefore(el, anchor.nextSibling);
			hostEl = el;
			return el;
		}

		/** B：UI 触发 —— 在消息流里插入一张同形虚拟卡（不进会话历史）。 */
		async function openVirtual(source, opts) {
			state.open = true;
			state.source = source || 'ui';
			state.phase = 'idle';
			state.error = '';
			state.result = null;
			state.retry = opts && typeof opts.retry === 'function' ? opts.retry : null;
			state.selected = '';
			state.candidates = [];
			await loadCandidates();
			injectStyle();
			ensureObserver();
			render();
			return true;
		}

		function ensureObserver() {
			if (observer || typeof MutationObserver === 'undefined') { return; }
			try {
				observer = new MutationObserver(() => {
					if (!state.open) { return; }
					if (hostEl && hostEl.isConnected) { return; }
					hostEl = null;
					ensureHost();
					render();
				});
				observer.observe(document.body, { childList: true, subtree: true });
			} catch { /* ignore */ }
		}

		/** A：模型触发 —— 官方工具卡按 key 渲染同一个组件。 */
		function ToolCardView(props) {
			const ref = react.useRef(null);
			react.useEffect(() => {
				const node = ref.current;
				if (!node) { return undefined; }
				node.setAttribute('data-vssaros-kb-root-toolview', '1');
				injectStyle();
				// phase=result 且工具说"已配置" ⇒ 不必再让用户选；未配置 ⇒ 打开卡片。
				const result = props && props.phase === 'result' ? parseResult(props.block) : null;
				if (result && result.configured === true) {
					state.open = false;
				} else if (!state.open) {
					state.open = true;
					state.source = 'model';
					state.phase = 'idle';
					state.error = '';
					state.result = null;
					state.retry = null;
					state.selected = '';
					void loadCandidates().then(() => renderInto(node));
				}
				renderInto(node);
				return () => { /* 容器由官方卸载；模块状态保留以便重绘 */ };
			}, [props && props.phase, props && props.block]);
			return react.createElement('div', { ref });
		}

		function parseResult(block) {
			try {
				const parts = Array.isArray(block && block.content) ? block.content : [];
				const text = parts.filter(p => p && typeof p.text === 'string').map(p => p.text).join('\n');
				const at = text.indexOf('{');
				return at >= 0 ? JSON.parse(text.slice(at)) : null;
			} catch { return null; }
		}

		function install(hostCtx) {
			ctx = hostCtx;
			if (typeof document === 'undefined') { return; }
			injectStyle();
			try {
				// ⚠ `id` 必须显式：check-chat-surface-chunks.mjs 把 tool.call.toolview 当非 keyed 槽做
				//   「同槽 id 不重复」对账，而 conversationViews.js 的 group_relay 省略了 id（=undefined）
				//   ⇒ 我们也省略会与它撞成 "id undefined 被两个 chunk 重复注册" ✗。
				ctx.slots.inject(TOOL_SLOT, () => ctx.slots.register(
					{ name: TOOL_SLOT, key: TOOL_KEY, id: 'vssaros-kb-root-picker' }, ToolCardView));
			} catch (e) {
				try { console.warn('[vssaros-kb-root-picker] tool view 注册失败：' + String((e && e.message) || e)); } catch { /* ignore */ }
			}
			// 跨插件入口：client.msgImport.js 在「未配置」时调它打开同一张卡。
			try {
				window.__vssarosOpenKbRootPicker = (source, opts) => openVirtual(source, opts);
				window.__vssarosKbRootPickerOpen = () => !!state.open;
			} catch { /* ignore */ }
		}

		exports.install = install;
		exports.__test = { validate, parseResult, TOOL_KEY, CANDIDATES_API, CONFIG_API };
		return module.exports;
	}
});
