// CLIENT_BUILD_STAMP: 2026-11-02 loop workbench (0.2.0: 循环任务工作台 —— 列表/详情/干跑/跑一轮/放回 blocked) —— 改了这个文件就把这一行也动一下（?rev 随入口 mtime 变）
// @vssaros/dsh-loop — 客户端入口：把「循环任务」注册成一个 dsh 工作台。
//
// 为什么要有它（2026-11-02 用户：「缺少 UI 入口」）：这个插件原来只有 5 个工具，IDE 与 dsh 里都看不到它
// —— 想干跑一次、想知道某条为什么被跳过、想放回一个 blocked 条目，都得先跟模型说话。
// 现在给一个纯管理面：列表（调度/账本计数/下次到期/熔断）+ 详情（护栏参数 + 账本条目）+ 三个动作
// （干跑 / 跑一轮 / 放回 blocked）。
//
// 取数与判定**全部复用 Host 侧**：`/x/loop/api/*` 直接调 runner 与 store，
// 不在这边重算"该不该跑"（两份判定必然漂）。
window.__ModuleLoader__.load({
	id: '@vssaros/dsh-loop',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const react = require('react');
		const h = react.createElement;

		const WB_TITLE = '循环任务';
		/** 与 package.json 的 `vssaros.workbench` 逐字同值（守卫钉住：改一处必须改两处）。 */
		const WB_DESCRIPTOR = {
			// ⚠ 这里写**字面量**而不是 `title: WB_TITLE`：守卫从描述符字面量取值，"常量回查"只是
			//   兜底路径（2026-11-02 实测它对 loop 这条取不到 ⇒ 报"title 未写"的假红）。
			title: '循环任务',
			description: '循环任务（无人值守）：定时采集 → 账本挑单 → 每条独立会话执行，含重试、熔断与干跑。',
			repository: 'vssaros:loop',
			icon: 'codicon:sync',
			customFrame: false,
			headerLayout: 'default',
			// 纯管理页：不要宿主那条「AI 助手 / 外开」浮动胶囊。
			floatingActions: false,
		};

		const API_LIST = '/x/loop/api/list';
		const API_SHOW = '/x/loop/api/show';
		const API_DRY = '/x/loop/api/dry-run';
		const API_RUN = '/x/loop/api/run';
		const API_ANSWER = '/x/loop/api/answer';

		const STYLE_ID = 'vssaros-loop-host';
		const CSS = `
.vssLoopRoot { container-type:inline-size; display:flex; flex-direction:column; flex:1; min-height:0; min-width:0; position:relative; }
.vssLoopSplit { flex:1 1 auto; min-height:0; display:flex; gap: var(--wb-s3, 12px); padding: var(--wb-s2, 8px) var(--wb-s3, 12px); }
.vssLoopLeft { flex:0 0 300px; min-width:0; display:flex; flex-direction:column; gap: var(--wb-s2, 8px); }
.vssLoopRight { flex:1 1 auto; min-width:0; overflow:auto; border-left:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-left: var(--wb-s3, 12px); }
.vssLoopMeta { display:flex; align-items:center; gap: var(--wb-s2, 8px); font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssLoopDue { color: var(--dsw-alias-brand-text, #4c9aff); white-space:nowrap; }
.vssLoopHint { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssLoopField { display:flex; flex-direction:column; gap: var(--wb-s1, 4px); min-width:0; margin-bottom: var(--wb-s2, 8px); }
.vssLoopField > label { font-size: var(--wb-f-xs, 11px); color: var(--dsw-alias-label-tertiary, rgba(230,230,230,.6)); }
.vssLoopOverlay { position:absolute; inset:0; z-index:20; display:flex; align-items:center; justify-content:center; padding: var(--wb-s4, 16px); background: var(--dsw-alias-bg-overlay, rgba(0,0,0,.42)); }
.vssLoopCard { display:flex; flex-direction:column; gap: var(--wb-s2, 8px); width:min(460px, 100%); max-height:100%; overflow:auto; padding: var(--wb-s4, 16px); border-radius: var(--wb-r-md, 10px); border:1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3)); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); font-size: var(--wb-f-sm, 12px); }
.vssLoopCardTitle { margin:0; font-size: var(--wb-f-md, 13px); font-weight:600; }
.vssLoopCardActs { display:flex; justify-content:flex-end; gap: var(--wb-s2, 8px); }
@container (max-width: 760px) {
	.vssLoopSplit { flex-direction:column; }
	.vssLoopLeft { flex:0 0 auto; }
	.vssLoopRight { border-left:0; padding-left:0; border-top:1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.18)); padding-top: var(--wb-s2, 8px); }
}
`;

		function maintainStyles() {
			if (document.getElementById(STYLE_ID)) { return undefined; }
			const el = document.createElement('style');
			el.id = STYLE_ID;
			el.textContent = CSS;
			document.head.appendChild(el);
			return () => el.remove();
		}

		/** 同源取数：no-store + 解析容错（空响应 ⇒ 可读错误，而不是裸的 JSON 异常）。 */
		async function getJson(url, options) {
			const res = await fetch(url, { cache: 'no-store', ...options });
			const text = await res.text();
			try {
				return JSON.parse(text);
			} catch (error) {
				return { ok: false, error: `HTTP ${res.status}，响应不是 JSON（${text ? '开头: ' + text.slice(0, 80) : '空响应'}）` };
			}
		}
		const post = (url, body) => getJson(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body ?? {}),
		});

		/** 「还有 12 分钟」/「已过期」。 */
		function dueText(loop) {
			const dueInS = loop?.state?.dueInS;
			if (typeof dueInS !== 'number') { return '手动'; }
			if (dueInS <= 0) { return '已到期'; }
			if (dueInS < 3600) { return `${Math.round(dueInS / 60)} 分钟后`; }
			if (dueInS < 86400) { return `${Math.round(dueInS / 3600)} 小时后`; }
			return `${Math.round(dueInS / 86400)} 天后`;
		}
		const ledgerCounts = loop => loop?.ledger ?? { total: 0, done: 0, failed: 0, blocked: 0, running: 0 };
		const STATUS_CLASS = { done: 'is-ok', failed: 'is-error', blocked: 'is-warn', running: 'is-brand' };

		function Loops() {
			const [state, setState] = react.useState({ loading: true, ok: false, loops: [], warnings: [], runsService: false, loopsDir: '', error: '' });
			const [selected, setSelected] = react.useState('');
			const [detail, setDetail] = react.useState(null);
			const [err, setErr] = react.useState('');
			const [busy, setBusy] = react.useState('');
			const [answering, setAnswering] = react.useState(''); // 账本 key
			const [answerText, setAnswerText] = react.useState('');

			const reload = react.useCallback(() => {
				getJson(API_LIST).then((data) => {
					setState({
						loading: false,
						ok: data?.ok === true,
						loops: data?.loops ?? [],
						warnings: data?.warnings ?? [],
						runsService: data?.runsService === true,
						loopsDir: data?.loopsDir ?? '',
						error: data?.error ?? '',
					});
				}).catch((error) => {
					setState({ loading: false, ok: false, loops: [], warnings: [], runsService: false, loopsDir: '', error: String(error?.message ?? error) });
				});
			}, []);
			react.useEffect(() => { reload(); }, [reload]);

			const current = (state.loops ?? []).find(l => l.name === selected) ?? (state.loops ?? [])[0] ?? null;

			const loadDetail = react.useCallback((name) => {
				if (!name) { setDetail(null); return; }
				getJson(`${API_SHOW}?name=${encodeURIComponent(name)}`).then((data) => {
					setDetail(data?.ok ? data : null);
				}).catch(() => setDetail(null));
			}, []);
			react.useEffect(() => { loadDetail(current?.name ?? ''); }, [current?.name, loadDetail]);

			async function actDry(name) {
				setBusy('dry');
				setErr('');
				const out = await post(API_DRY, { name });
				setBusy('');
				if (!out?.ok) { setErr(out?.error ?? '干跑失败'); return; }
				const r = out.result ?? {};
				const willRun = Array.isArray(r.willRun) ? r.willRun.length : 0;
				const excluded = Array.isArray(r.excluded) ? r.excluded.length : 0;
				setErr(`${name}：采到 ${r.total ?? 0} 条，会跑 ${willRun} 条，排除 ${excluded} 条${r.harvestError ? `（采集问题：${r.harvestError}）` : ''}`);
				loadDetail(name);
			}
			async function actRun(name) {
				setBusy('run');
				setErr('');
				const out = await post(API_RUN, { name });
				setBusy('');
				if (!out?.ok) { setErr(out?.error ?? '运行失败'); return; }
				const r = out.result ?? {};
				if (r.skipped) { setErr(`${name}：${r.skipped}`); }
				else { setErr(`${name}：已跑一轮（${(r.results ?? []).length} 条）`); }
				reload();
				loadDetail(name);
			}
			async function submitAnswer() {
				if (!current || !answering) { return; }
				const out = await post(API_ANSWER, { name: current.name, key: answering, answer: answerText });
				setAnswering('');
				setAnswerText('');
				if (!out?.ok) { setErr(out?.error ?? '放回失败'); return; }
				setErr(`已放回 ${out.released?.length ?? 0} 条：${(out.released ?? []).join(', ')}`);
				loadDetail(current.name);
				reload();
			}

			const toolbar = h('div', { className: 'wb-toolbar', 'data-dsh-workbench-toolbar': '' },
				h('h1', { className: 'wb-title' }, WB_TITLE),
				h('span', { className: 'wb-sub', 'data-loop-count': String((state.loops ?? []).length) }, `${(state.loops ?? []).length} 个`),
				h('span', { className: 'wb-spacer' }),
				h('div', { className: 'wb-links' },
					h('button', { type: 'button', className: 'wb-btn is-ghost', onClick: reload }, '刷新')));

			// ── 左：loop 列表 ──
			let list = null;
			if (state.loading) {
				list = h('div', { className: 'wb-empty' }, '载入中…');
			} else if (!state.ok) {
				list = h('div', { className: 'wb-empty' }, `读不到循环列表：${state.error || '未知原因'}`);
			} else if ((state.loops ?? []).length === 0) {
				list = h('div', { className: 'wb-empty' },
					h('div', null, '还没有循环。'),
					h('div', { className: 'vssLoopHint' }, '在下面这个目录里建一个 loop.json 就会出现在这里：'),
					h('code', { className: 'wb-code' }, state.loopsDir || '<数据根>/loops/<名字>/loop.json'));
			} else {
				list = h('ul', { className: 'wb-list', 'data-loop-list': '' }, (state.loops ?? []).map((loop) => {
					const counts = ledgerCounts(loop);
					const open = current && current.name === loop.name;
					return h('li', {
						key: loop.name,
						className: 'wb-row' + (open ? ' is-selected' : '') + (loop.state?.circuitOpen ? ' is-warn' : ''),
						'data-loop-id': loop.name,
						onClick: () => { setSelected(loop.name); setErr(''); },
					},
						h('div', { className: 'wb-row-l1' },
							h('span', { className: 'wb-row-name' }, loop.title || loop.name),
							loop.state?.circuitOpen ? h('span', { className: 'wb-badge is-warn' }, '已熔断') : null,
							loop.error ? h('span', { className: 'wb-badge is-error' }, '配置错误') : null),
						h('div', { className: 'wb-row-l2' },
							h('span', null, loop.schedule || 'manual'),
							h('span', { className: 'vssLoopDue' }, dueText(loop)),
							h('span', null, `账本 ${counts.done}/${counts.total}`),
							counts.blocked ? h('span', null, `阻塞 ${counts.blocked}`) : null));
				}));
			}

			// ── 右：详情 ──
			let right = null;
			if (!current) {
				right = h('div', { className: 'wb-empty' }, '选中一个循环看详情。');
			} else {
				const spec = detail?.spec ?? null;
				const entries = detail?.entries ?? [];
				right = h('div', { className: 'wb-pane', 'data-loop-detail': current.name },
					h('div', { className: 'wb-pane-hd' },
						h('span', { className: 'wb-pane-title' }, current.title || current.name),
						h('span', { className: 'wb-pane-id' }, current.name),
						h('span', { className: 'wb-spacer' }),
						h('button', {
							type: 'button', className: 'wb-btn is-ghost', 'data-loop-act': 'dry',
							disabled: busy !== '', onClick: () => actDry(current.name),
						}, busy === 'dry' ? '干跑中…' : '干跑'),
						h('button', {
							type: 'button', className: 'wb-btn is-primary', 'data-loop-act': 'run',
							disabled: busy !== '', onClick: () => actRun(current.name),
						}, busy === 'run' ? '运行中…' : '跑一轮')),
					err ? h('div', { className: 'wb-diag' }, err) : null,
					!state.runsService ? h('div', { className: 'wb-diag' }, 'runs 服务不可用 ⇒ ticker 没启动（只能干跑与查看）') : null,
					current.error ? h('div', { className: 'wb-diag' }, `配置错误：${current.error}`) : null,
					(state.warnings ?? []).length ? h('div', { className: 'wb-diag' }, `提示：${(state.warnings ?? []).join('；')}`) : null,
					h('div', { className: 'vssLoopMeta' },
						h('span', null, `调度 ${spec?.schedule ?? current.schedule ?? '—'}`),
						h('span', null, `安静时段 ${spec?.quietHours || '关'}`),
						h('span', null, `每轮最多 ${spec?.maxItemsPerRound ?? '—'} 条`),
						h('span', null, `阻塞策略 ${spec?.onAsk ?? '—'}`),
						h('span', null, `交接 ${spec?.handoff?.require ? `要求（≤${spec.handoff.maxChars}）` : '不要求'}`)),
					h('div', { className: 'vssLoopField' },
						h('label', null, `账本条目（${entries.length}）`),
						entries.length === 0
							? h('div', { className: 'vssLoopHint' }, '还没有条目。跑一轮或干跑后这里会有记录。')
							: h('table', { className: 'wb-table', 'data-loop-records': '' },
								h('thead', null, h('tr', null,
									h('th', null, '键'), h('th', null, '状态'), h('th', null, '尝试'), h('th', null, '原因'))),
								h('tbody', null, entries.map((entry) => h('tr', { key: entry.key },
									h('td', null, h('code', { className: 'wb-code' }, entry.key)),
									h('td', null, h('span', { className: `wb-badge ${STATUS_CLASS[entry.status] ?? ''}` }, entry.status ?? '—')),
									h('td', null, String(entry.attempts ?? 0)),
									h('td', null,
										h('div', { className: 'vssLoopMeta' },
											h('span', null, String(entry.lastError ?? '').slice(0, 120)),
											entry.status === 'blocked'
												? h('button', {
													type: 'button', className: 'wb-btn is-ghost', 'data-loop-act': 'answer',
													onClick: () => { setAnswering(entry.key); setAnswerText(''); },
												}, '回答')
												: null))))))))
			}

			const children = [toolbar, h('div', { className: 'vssLoopSplit' },
				h('div', { className: 'vssLoopLeft' }, list),
				h('div', { className: 'vssLoopRight' }, right))];
			if (answering) {
				children.push(h('div', { className: 'vssLoopOverlay', 'data-loop-dialog': answering },
					h('div', { className: 'vssLoopCard' },
						h('h2', { className: 'vssLoopCardTitle' }, `回答这条被阻塞的条目：${answering}`),
						h('div', { className: 'vssLoopHint' }, '你的回答会写进账本，下一轮带着它重跑（blocked → 待重试）。'),
						h('textarea', {
							className: 'wb-input', value: answerText, 'aria-label': '回答',
							onChange: (ev) => setAnswerText(ev.target.value),
							placeholder: '例如：用方案 B，不要动老接口',
						}),
						h('div', { className: 'vssLoopCardActs' },
							h('button', { type: 'button', className: 'wb-btn', onClick: () => setAnswering('') }, '取消'),
							h('button', { type: 'button', className: 'wb-btn is-primary', onClick: submitAnswer }, '放回队列')))));
			}

			return h('div', {
				className: 'wb vssLoopRoot',
				'data-vssaros-page': 'loop',
				'data-vssaros-surface': 'workbench',
				'data-loop-state': state.loading ? 'loading' : (state.ok ? 'ready' : 'unavailable'),
			}, children);
		}

		function apply(ctx) {
			ctx.effect(maintainStyles, 'vssaros-loop: styles');
			// 只依赖 desktopWorkbenches ⇒ 工作台一定注册；数据面是同源 fetch。
			ctx.inject(['desktopWorkbenches'], (wb) => {
				wb.effect(() => wb.desktopWorkbenches.register(WB_DESCRIPTOR, Loops), 'vssaros-loop: workbench');
			});
			return undefined;
		}

		module.exports.apply = apply;
		// 没有硬依赖（服务走可选注入：缺了不出现界面，而不是让 web boot pending）。
		module.exports.inject = [];
		return module.exports;
	},
});
