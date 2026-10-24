// @vssaros/dsh-xhs-note — 工作台面板（React，宿主托管渲染 / A 类挂载）。
//
// 三条硬伤的落点（doc/xhs-workbench-fix-plan.md）：
//   1) 草稿走 `/x/xhs-note/api/drafts`（数据根），不再写 localStorage；旧数据一次性迁移；
//   2) 颜色只走 `--dsw-alias-*`，品牌色收敛到 `--wb-brand`（默认跟随宿主，`data-brand="xhs"` 才用粉）；
//   3) 开 AI 时把草稿**预填**进 composer（事件 `vssaros-composer-prefill`，由 chat-surface 落笔）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-xhs-note',
	chunk: 'client.xhs-note.js',
	factory: (require) => {
		const react = require('react');
		const h = react.createElement;
		const { useState, useEffect, useRef, useCallback } = react;

		const API = '/x/xhs-note/api/drafts';
		const LEGACY_KEY = 'dsh-xhs-note-workbench.drafts.v1';   // 商城旧包用的键（迁移源）
		const PREFILL_EVENT = 'vssaros-composer-prefill';
		const STYLES = { 真诚分享: '真诚分享', 实用攻略: '实用攻略', 轻松活泼: '轻松活泼', 简洁专业: '简洁专业' };

		// ── 预填文案（与服务端无关的纯逻辑；单测在 test/run-xhs-note-check.mjs）────────
		const PREFILL_HEAD = '这是我正在写的小红书笔记，请不要改变事实，只做润色与结构优化：';
		const PREFILL_TASK = '要求：保持第一人称与真实感；标题给 3 个更有点击欲的备选；正文控制在 600 字内；最后给出话题标签。';
		function buildPrefillPrompt(draft) {
			const body = String((draft && draft.body) || '').trim();
			const trimmed = body.length > 1200 ? body.slice(0, 600).trimEnd() + '…（后略，全文在工作台）' : body;
			return [PREFILL_HEAD, '', '【主题】' + ((draft && draft.topic) || '（未填）'), '【标题】' + ((draft && draft.title) || '（未填）'),
				'【正文】' + (trimmed || '（空）'), (draft && draft.tags) ? '【标签】' + draft.tags : '', '', PREFILL_TASK].filter((line) => line !== '').join('\n');
		}

		const injectStyles = () => {
			if (document.querySelector('style[data-vssaros-xhs-note]')) { return; }
			const node = document.createElement('style');
			node.dataset.vssarosXhsNote = '1';
			node.textContent = [
				// 颜色：一律 `var(--dsw-alias-*, 兜底)`；品牌色只从 `--wb-brand` 取
				'.xb{display:flex;flex-direction:column;min-height:0;height:100%;container-type:inline-size;',
				'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}',
				'.xb[data-brand="xhs"]{--xb-brand:var(--wb-brand-xhs,var(--dsw-alias-brand-primary,#ff2e55))}',
				'.xb{--xb-brand:var(--wb-brand,var(--dsw-alias-brand-primary,#4d9cf7))}',
				'.xb-body{display:grid;grid-template-columns:minmax(260px,.8fr) minmax(320px,1.2fr) 0;gap:14px;padding:14px;min-height:0;flex:1;overflow:auto}',
				'.xb-body[data-ai="open"]{grid-template-columns:minmax(240px,.75fr) minmax(300px,1.05fr) minmax(320px,1fr)}',
				'.xb-card{background:var(--dsw-alias-bg-layer-1,#f7f8fa);border:1px solid var(--dsw-alias-border-l1,#eceef2);border-radius:var(--wb-r-md,10px);padding:14px;min-width:0}',
				'.xb-stack{display:grid;gap:10px}',
				'.xb-label{font-size:var(--wb-f-sm,13px);font-weight:650;color:var(--dsw-alias-label-primary,#111)}',
				'.xb-hint{font-size:var(--wb-f-2xs,11px);color:var(--dsw-alias-label-caption,#8b929e)}',
				'.xb-input,.xb-area,.xb-select{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#d9dde4);',
				'border-radius:var(--wb-r-sm,6px);background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);',
				'padding:8px 10px;font:inherit;line-height:1.55}',
				'.xb-area{min-height:112px;resize:vertical}.xb-editor{min-height:220px}',
				'.xb-input:focus-visible,.xb-area:focus-visible,.xb-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#4d9cf7);outline-offset:1px}',
				'.xb-primary{background:var(--xb-brand);border-color:var(--xb-brand);color:var(--dsw-alias-label-on-brand,#fff)}',
				'.xb-titles{display:grid;gap:6px}',
				'.xb-title-choice{text-align:left;border:1px solid var(--dsw-alias-border-l1,#eceef2);border-radius:var(--wb-r-sm,6px);',
				'background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);padding:8px 10px;cursor:pointer}',
				'.xb-title-choice[data-on="1"]{border-color:var(--xb-brand);box-shadow:0 0 0 2px color-mix(in srgb, var(--xb-brand) 18%, transparent)}',
				'.xb-chat{display:none;min-width:0;border:1px solid var(--dsw-alias-border-l1,#eceef2);border-radius:var(--wb-r-md,10px);',
				'background:var(--dsw-alias-bg-layer-1,#f7f8fa);overflow:hidden;flex-direction:column}',
				'.xb-body[data-ai="open"] .xb-chat{display:flex}',
				'.xb-chat-hd{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#eceef2);font-size:var(--wb-f-xs,12px);',
				'color:var(--dsw-alias-label-secondary,#5a6270);display:flex;justify-content:space-between;align-items:center}',
				'.xb-chat-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column}',
				'.xb-toast{position:absolute;right:16px;bottom:14px;padding:8px 12px;border-radius:var(--wb-r-sm,6px);',
				'background:var(--dsw-alias-bg-overlay,#fff);border:1px solid var(--dsw-alias-border-l2,#d9dde4);',
				'color:var(--dsw-alias-label-primary,#111);font-size:var(--wb-f-xs,12px);box-shadow:0 6px 20px color-mix(in srgb, var(--dsw-alias-label-primary,#111) 14%, transparent)}',
				'@container (max-width:1100px){.xb-body[data-ai="open"]{grid-template-columns:minmax(240px,1fr) minmax(320px,1fr)}',
				'.xb-body[data-ai="open"] .xb-chat{grid-column:1 / -1;min-height:360px}}',
				'@container (max-width:860px){.xb-body{grid-template-columns:1fr}.xb-body[data-ai="open"]{grid-template-columns:1fr}}',
			].join('\n');
			document.head.appendChild(node);
		};

		const api = async (path, init) => {
			const res = await fetch(path, init);
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.ok === false) { throw new Error(body.error || ('HTTP ' + res.status)); }
			return body;
		};

		function Panel(props) {
			injectStyles();
			const conversationRef = useRef(null);
			const [topic, setTopic] = useState('');
			const [material, setMaterial] = useState('');
			const [style, setStyle] = useState(Object.keys(STYLES)[0]);
			const [draft, setDraft] = useState(null);          // { id, rev, title, body, tags, titles }
			const [saved, setSaved] = useState([]);            // [{ id, title, savedAt }]
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState('');
			const [toast, setToast] = useState('');
			const [aiOpen, setAiOpen] = useState(false);
			const [brand, setBrand] = useState('host');
			const lastPrefill = useRef('');

			const say = useCallback((text) => {
				setToast(text);
				window.setTimeout(() => setToast(''), 2000);
			}, []);

			const refresh = useCallback(async () => {
				try {
					const out = await api(API);
					setSaved(out.drafts || []);
				} catch (e) { setError(String((e && e.message) || e)); }
			}, []);

			// 首次：拉列表 + 迁移旧 localStorage（服务端幂等，换机也只导一次）
			useEffect(() => {
				let alive = true;
				(async () => {
					await refresh();
					try {
						const raw = window.localStorage && window.localStorage.getItem(LEGACY_KEY);
						if (raw) {
							const items = JSON.parse(raw);
							if (Array.isArray(items) && items.length) {
								const out = await api('/x/xhs-note/api/migrate', {
									method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }),
								});
								if (alive && out.imported) { say('已把 ' + out.imported + ' 篇旧草稿迁到数据目录'); await refresh(); }
							}
						}
					} catch { /* 旧数据坏了不影响新数据 */ }
				})();
				return () => { alive = false; };
			}, [refresh, say]);

			// 用模板生成（与商城版同口径：本机模板，不走模型；润色交给 AI 协助）
			const generate = () => {
				if (!topic.trim()) { setError('请先填写笔记主题。'); return; }
				setError('');
				const t = topic.trim();
				const m = material.trim();
				const seeds = m || ('围绕「' + t + '」分享真实体验、实用方法和个人感受。');
				const titles = {
					真诚分享: [t + '｜我的真实体验与感受', '关于' + t + '，这些细节值得说一说', '亲测分享：' + t + '到底怎么样？'],
					实用攻略: [t + '攻略｜新手也能直接照着做', '搞定' + t + '，我总结了这份实用清单', t + '避坑指南：关键步骤一次讲清'],
					轻松活泼: ['原来' + t + '还能这样！真的太惊喜了', t + '快乐指南｜轻松拿捏的小秘诀', '谁懂啊！这次' + t + '体验太上头了'],
					简洁专业: [t + '：方法、要点与实践建议', t + '实操复盘', '一篇讲清' + t + '的关键步骤'],
				}[style] || [t];
				const body = ['最近认真体验了一次' + t + '，把过程与感受整理下来，供同样在了解它的朋友参考。', '',
					'【我的素材】', seeds, '', '【建议这样做】', '1. 先明确自己的目标与实际需求，不盲目跟风。',
					'2. 按素材里的关键信息排顺序，让读者快速抓住重点。', '3. 补上真实感受、具体细节与适用人群，内容更有说服力。', '',
					'【最后想说】', '适合自己的方法才值得坚持。你对' + t + '还有哪些疑问？欢迎一起交流。'].join('\n');
				const tags = ['#' + t.replace(/\s/g, ''), '#小红书笔记', '#经验分享'].join(' ');
				setDraft((prev) => ({ id: prev && prev.id, rev: prev && prev.rev, topic: t, title: titles[0], titles, body, tags }));
			};

			const saveDraft = async () => {
				if (!draft) { return; }
				setBusy(true); setError('');
				try {
					const out = await api(API, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ id: draft.id, rev: draft.rev, topic: draft.topic || topic, title: draft.title, body: draft.body, tags: draft.tags, style }),
					});
					setDraft((prev) => ({ ...prev, id: out.id, rev: out.rev }));
					say('已保存到数据目录');
					await refresh();
				} catch (e) {
					const msg = String((e && e.message) || e);
					setError(/rev/.test(msg) ? '这篇已被别处修改，请重新载入后再存' : msg);
				} finally { setBusy(false); }
			};

			const loadDraft = async (id) => {
				try {
					const out = await api(API + '/' + encodeURIComponent(id));
					const d = out.draft || {};
					setTopic(d.topic || '');
					setDraft({ id: d.id, rev: d.rev, topic: d.topic, title: d.title, titles: [d.title], body: d.body, tags: d.tags });
					say('已载入草稿');
				} catch (e) { setError(String((e && e.message) || e)); }
			};

			const removeDraft = async (id) => {
				try { await api(API + '/' + encodeURIComponent(id), { method: 'DELETE' }); await refresh(); say('已删除'); }
				catch (e) { setError(String((e && e.message) || e)); }
			};

			const copyNote = async () => {
				if (!draft) { return; }
				const text = [draft.title, '', draft.body, '', draft.tags].join('\n');
				try { await navigator.clipboard.writeText(text); say('完整笔记已复制'); }
				catch { setError('复制失败，请手动选择内容复制。'); }
			};

			// 硬伤 3：把草稿预填进 composer（不自动发送）；chat-surface 落笔后回填 result
			const openAi = () => {
				setAiOpen(true);
				const text = buildPrefillPrompt(draft || { topic, body: material });
				const detail = { text, from: 'xhs-note', result: { applied: false, reason: 'pending' } };
				try { document.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail })); } catch { /* 老浏览器 */ }
				const result = detail.result || {};
				if (result.applied) { say('已把草稿预填进输入框，改完发送即可'); }
				else if (result.reason === 'busy' || result.reason === 'phase') { say('输入框里已有内容，草稿没有覆盖它'); }
				else { say('已打开 AI 协助；若输入框为空，可手动粘贴草稿'); }
			};

			const aiOpenHandler = () => { if (aiOpen) { setAiOpen(false); } else { openAi(); } };

			return h('div', { className: 'wb wb-xhs xb', 'data-vssaros-surface': 'workbench', 'data-vssaros-page': 'xhs-note', 'data-brand': brand },
				h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
					h('span', { className: 'wb-title' }, '小红书笔记'),
					h('span', { className: 'wb-badge', 'data-vssaros-xhs-count': String(saved.length) }, saved.length + ' 篇草稿'),
					h('span', { className: 'wb-spacer' }),
					h('button', { className: 'wb-btn is-ghost', 'data-vssaros-xhs-brand': brand, onClick: () => setBrand(brand === 'xhs' ? 'host' : 'xhs') }, brand === 'xhs' ? '品牌：小红书粉' : '品牌：跟随宿主'),
					h('button', { className: 'wb-btn is-primary', 'data-vssaros-xhs-ai': 'open', onClick: aiOpenHandler }, aiOpen ? '关闭 AI 协助' : 'AI 协助'),
				),
				error ? h('div', { className: 'wb-diag', role: 'alert', 'data-vssaros-xhs-error': '' }, error) : null,
				h('div', { className: 'xb-body', 'data-ai': aiOpen ? 'open' : 'closed' },
					// 左：创作输入
					h('section', { className: 'xb-card', 'aria-label': '创作输入' },
						h('div', { className: 'xb-stack' },
							h('label', { className: 'wb-field-row' }, h('span', { className: 'xb-label' }, '笔记主题 '), h('span', { className: 'xb-hint' }, '必填')),
							h('input', { className: 'xb-input', value: topic, maxLength: 80, placeholder: '例如：第一次独自去杭州旅行', 'data-vssaros-xhs-topic': '', onChange: (e) => setTopic(e.target.value) }),
							h('label', { className: 'wb-field-row' }, h('span', { className: 'xb-label' }, '素材与要点 '), h('span', { className: 'xb-hint' }, '经历、卖点、数据、感受')),
							h('textarea', { className: 'xb-area', value: material, maxLength: 4000, placeholder: '把零散素材粘进来……', onChange: (e) => setMaterial(e.target.value) }),
							h('label', { className: 'wb-field-row' }, h('span', { className: 'xb-label' }, '表达风格')),
							h('select', { className: 'xb-select', value: style, onChange: (e) => setStyle(e.target.value) },
								...Object.keys(STYLES).map((key) => h('option', { key, value: key }, key))),
							h('button', { className: 'wb-btn is-primary', 'data-vssaros-xhs-generate': '', onClick: generate }, draft ? '重新生成一版' : '生成笔记草稿'),
						),
						saved.length ? h('div', null,
							h('div', { className: 'wb-group-hd' }, '已保存定稿'),
							h('div', { className: 'wb-list' }, ...saved.slice(0, 8).map((item) => h('div', { className: 'wb-row', key: item.id, 'data-vssaros-xhs-draft': item.id },
								h('button', { className: 'wb-btn is-ghost', onClick: () => loadDraft(item.id), title: item.title }, h('span', { className: 'wb-row-name' }, item.title || item.topic || '（无标题）')),
								h('button', { className: 'wb-btn is-danger', 'data-vssaros-xhs-delete': item.id, onClick: () => removeDraft(item.id) }, '删除'),
							))),
						) : null,
					),
					// 中：编辑
					h('section', { className: 'xb-card', 'aria-label': '笔记编辑' }, draft
						? h('div', { className: 'xb-stack' },
							h('div', { className: 'wb-group-hd' }, '选择标题'),
							h('div', { className: 'xb-titles' }, ...(draft.titles || [draft.title]).filter(Boolean).map((item) => h('button', {
								key: item, className: 'xb-title-choice', 'data-on': draft.title === item ? '1' : '0',
								onClick: () => setDraft((prev) => ({ ...prev, title: item })),
							}, item))),
							h('input', { className: 'xb-input', 'data-vssaros-xhs-title': '', value: draft.title || '', maxLength: 100, onChange: (e) => setDraft((prev) => ({ ...prev, title: e.target.value })) }),
							h('textarea', { className: 'xb-area xb-editor', 'data-vssaros-xhs-body': '', value: draft.body || '', onChange: (e) => setDraft((prev) => ({ ...prev, body: e.target.value })) }),
							h('textarea', { className: 'xb-area', value: draft.tags || '', placeholder: '#话题标签', onChange: (e) => setDraft((prev) => ({ ...prev, tags: e.target.value })) }),
							h('div', { className: 'wb-acts' },
								h('button', { className: 'wb-btn is-primary', 'data-vssaros-xhs-save': '', disabled: busy, onClick: saveDraft }, busy ? '保存中…' : '保存定稿'),
								h('button', { className: 'wb-btn', 'data-vssaros-xhs-copy': '', onClick: copyNote }, '复制完整笔记'),
							),
						)
						: h('div', { className: 'wb-empty' }, h('strong', null, '从一个主题开始'), h('span', null, '填写左侧信息后，这里会生成标题、正文和话题标签。'))),
					// 右：对话停靠点（宿主 portal 官方对话进来）
					h('section', { className: 'xb-chat', 'aria-label': 'AI 协助' },
						h('div', { className: 'xb-chat-hd' }, h('span', null, 'AI 协助润色'), h('span', { className: 'xb-hint' }, aiOpen ? '已打开' : '')),
						h('div', { className: 'xb-chat-body', ref: conversationRef, 'data-vssaros-xhs-conversation': '' },
							props.conversation || h('div', { className: 'wb-empty' }, h('span', null, '点右上「AI 协助」把草稿带进对话。'))),
					),
				),
				toast ? h('div', { className: 'xb-toast', role: 'status', 'data-vssaros-xhs-toast': '' }, toast) : null,
			);
		}

		// ★ 注册放在**组件文件**里（不是入口）：`check-workbench-style.mjs` 把「含
		//   `desktopWorkbenches.register` 的文件」当作工作台组件去检查（surface 标记 / wb-* 数量 /
		//   工具栏唯一）⇒ 入口只有装载逻辑时会被误判成"没用共享层"。
		const DESCRIPTOR = {
			// ⚠ `repository` 是宿主 `normalize()` **必填**的（`identityOf()` 用它算 id）：
			//   缺了直接抛 `Invalid workbench repository`，工作台就进不了注册表（2026-10-24 真机踩到）。
			//   格式二选一：`vssaros:<模块名>`（自有）或 `https://github.com/<owner>/<repo>`（第三方）。
			repository: 'vssaros:xhs-note',
			id: 'vssaros/xhs-note',
			title: '小红书笔记',
			description: '主题与素材整理成小红书笔记：标题、正文、话题标签；草稿落本机数据目录，AI 协助可带上下文',
			icon: 'codicon:comment-discussion',
			route: '/x/xhs-note/',
			order: 42,
			customFrame: true,
		};

		function install(ctx) {
			// 入口已 `inject: ['desktopWorkbenches']` ⇒ 这里直接拿到服务就该注册；
			// 拿不到（宿主注入时机不同）再退回 `ctx.inject` 等一次（与 kb 同形的兜底）。
			if (ctx.desktopWorkbenches) {
				ctx.effect(() => ctx.desktopWorkbenches.register(DESCRIPTOR, Panel), 'vssaros-xhs-note: workbench');
				return undefined;
			}
			ctx.inject(['desktopWorkbenches'], (c) => {
				c.effect(() => c.desktopWorkbenches.register(DESCRIPTOR, Panel), 'vssaros-xhs-note: workbench');
			});
			return undefined;
		}

		return { Panel, install };
	},
});
