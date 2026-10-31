// @vssaros/dsh-scheduler — 定时任务模块（重构 2.1 试点）。
//
// ── 这个插件是什么 ──────────────────────────────────────────────────────────
// 官方 `@deepseek-ai/dsh-schedule`（经 experimental-schedule-bundle 进组合）的**薄壳**：
//   · ActivityBar 图标「定时任务」（清单驱动 ⇒ 壳侧零代码，1.1 已铺好）；
//   · `/x/scheduler/` 页面：跨会话任务清单（`schedule.catalog()`）+ 删除；
//   · legacy 迁移入口（`POST /x/scheduler/api/migrate`，见 lib/migrate.js）。
//
// ── 不做什么 ────────────────────────────────────────────────────────────────
// · 不注册工具：官方 `schedule_create` 已在模型工具表里（bundle 自带）；
// · ★ 2026-10-31 起**做**创建表单（用户：「点击新建自动化任务错误」——点了只开一个空白会话）：
//   官方 ui-schedule 页面确实没有创建表单，且 `ScheduleService.create` **没有 @Remote**
//   ⇒ 客户端调不到 ⇒ 由 `POST /x/scheduler/api/create` 中转，程序化 `ctx.schedule.create`
//   （与迁移同口径：不必经模型 ✓）；
// · 不管触发 / 投递 / 持久化：全是官方件的事。
//
// ── 服务的拿法 ──────────────────────────────────────────────────────────────
// `schedule` 服务**可选注入**：官方 bundle 没装上的组合里，页面如实显示"不可用"而不是
// 让插件永久 pending（与 sessions/dashboard 同口径：webServer/connection 也走可选注入 ⇒
// 静态 inject 留空，headless 组合也能加载）。

import { randomUUID } from 'node:crypto';

import { describeRule, officialToSelfRule } from './core/task.js';
import { createScheduleEngine, shouldProvideSchedule } from './engine.js';
import { registerScheduleTools } from './tools.js';
import { escapeHtml, renderShell } from './pageShell.js';
import { bindFoundation } from './foundationRef.js';
import { migrateLegacySchedules } from './migrate.js';

export const name = 'vssaros-scheduler';
/**
 * ★ **`tools` 必须写进静态 inject**（2026-10-31 真机事故）：
 *   自建引擎在 apply 里注册 `schedule_create / list / update / delete / history`，
 *   而 `ctx.tools` 是 cordis 服务 —— **没声明就直读会抛
 *   `cannot get property "tools" without inject`** ⇒ 整个 apply 失败 ⇒ 插件激活不了
 *   （页面路由也没注册，工作台打不开）。与 `vssaros-loop` 同款（`inject = ['tools']`）。
 *
 * 其余（webServer / connection / vssarosFoundation / vssarosWorkItems）仍走**可选注入**：
 *   它们只在特定 profile 存在，写进静态 inject 会让插件在缺它们的组合里**永久 pending**
 *   （连工具一起失效，kanban 实测过）。
 */
export const inject = ['tools'];

const ROUTE_PREFIX = '/x/scheduler';

/**
 * 自建引擎的引用（工具与 API 都从这里取；未就绪时两者都明确报错，不静默）。
 *
 * ★★ **必须是模块级**（2026-10-31 真机事故）：`listSchedules` / `createSchedule` / `updateSchedule`
 *    / `deleteSchedule` 都是**模块级**函数，取不到 `apply()` 里的局部变量。原先 `let engine` 写在
 *    apply 的块里 ⇒ 每个请求都抛 `ReferenceError: engine is not defined` ⇒ `dsh-host-webserver`
 *    把它兜成 **400 空响应** ⇒ 前端只能显示 "Unexpected end of JSON input"（工作台一片空白）。
 */
let engine = null;

/** `atMinute`（当日分钟数）→ 官方要的 `HH:mm:ss`。 */
function clockOf(atMinute) {
	const value = Number(atMinute);
	const minutes = Number.isFinite(value) ? Math.max(0, Math.min(24 * 60 - 1, Math.trunc(value))) : 0;
	const pad = (n) => String(n).padStart(2, '0');
	return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
}

/**
 * 把一条任务整理成页面要的一行。
 *
 * ★★ 2026-10-31（用户要求「UI 复刻 dsh 官方」）：工作台用的是官方 `TaskManagerPage`，
 *   它按**官方扁平形状**取字段 —— `{id,title,prompt,kind,scheduledAt,sessionId,status}`
 *   加上规则自己的字段（`daily`⇒`time`+`timeZone`、`weekly`⇒+`weekdays`、`every`⇒`everySeconds`、
 *   `cron`⇒`expression`+`timeZone`）。写成自建形状（`rule:{kind,atMinute}`）官方组件**读不到**
 *   ⇒ 规则文本、时间编辑器全是空白。
 *   ⇒ 这里统一输出官方形状；`ruleText/next/lastDelivered` 作为**兼容字段**留给 SSR 页与探针。
 */
export function rowOf(task) {
	const rule = task?.rule ?? {};
	const zone = String(rule.timeZone || 'UTC');
	const atMs = Number(task?.next?.target);
	const scheduledAt = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString();
	const base = {
		id: String(task?.id ?? ''),
		title: String(task?.title ?? ''),
		prompt: String(task?.prompt ?? ''),
		kind: String(rule.kind ?? 'daily'),
		scheduledAt,
		sessionId: String(task?.sessionId ?? ''),
		status: task?.status === 'active' ? 'active' : 'inactive',
		// 兼容字段（SSR 页 / 旧探针在读；官方 UI 不认这些）
		ruleText: describeRule(rule),
		next: Number.isFinite(atMs) ? new Date(atMs).toISOString().slice(0, 16).replace('T', ' ') : '',
		lastDelivered: task?.lastRun?.at ? new Date(task.lastRun.at).toISOString().slice(0, 16).replace('T', ' ') : '',
		// ★ 2026-10-31（编辑弹窗）：有效期与消息推送（卡片开关与下拉的回填源）。
		expiresAt: String(task?.expiresAt ?? ''),
		notify: task?.notify === true,
	};
	switch (rule.kind) {
		case 'daily':
			return { ...base, time: clockOf(rule.atMinute), timeZone: zone };
		case 'weekly':
			// 自建用 JS 约定（0=周日），官方用 ISO（1=周一…7=周日）⇒ 0 → 7。
			return {
				...base,
				time: clockOf(rule.atMinute),
				timeZone: zone,
				weekdays: (Array.isArray(rule.weekdays) ? rule.weekdays : []).map((d) => (Number(d) === 0 ? 7 : Number(d))),
			};
		case 'every':
			return { ...base, everySeconds: Number(rule.everySeconds ?? 3600) };
		case 'at':
			return { ...base, time: clockOf(rule.atMinute), timeZone: zone };
		case 'cron':
			return { ...base, expression: String(rule.expression ?? ''), timeZone: zone };
		default:
			return base;
	}
}

function renderPage(entries, scheduleAvailable, migrateNote) {
	const rows = entries.map(e => `<tr data-id="${escapeHtml(e.id)}">
	<td>${escapeHtml(e.title)}</td>
	<td>${escapeHtml(e.ruleText)}</td>
	<td>${escapeHtml(e.status === 'active' ? '已开启' : '未运行')}</td>
	<td>${escapeHtml(e.next)}</td>
	<td>${escapeHtml(e.lastDelivered)}</td>
	<td><button data-delete="${escapeHtml(e.id)}" data-session="${escapeHtml(e.sessionId)}">删除</button></td>
</tr>`).join('');
	const body = !scheduleAvailable
		? `<p class="empty">调度服务不可用：官方 <code>@deepseek-ai/dsh-experimental-schedule-bundle</code> 没装上（宿主安装链负责；装不上不影响启动，只是没有定时任务能力）。</p>`
		: entries.length === 0
			? '<p class="empty">还没有定时任务。在聊天框里让 Agent 帮你建一个（官方 <code>schedule_create</code> 工具），或跑一次 legacy 迁移。</p>'
			: `<table><thead><tr><th>名称</th><th>规则</th><th>状态</th><th>下次运行（UTC）</th><th>最近投递</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
	// renderShell 的件区是 headerHtml / bodyHtml / script（不是 body ✗ —— 参数名写错会被静默丢掉，
	// p3-98 的"迁移按钮在场"断言就是抓这个的 ✓）。
	return renderShell({
		kind: 'scheduler',
		title: '定时任务',
		headerHtml: `<div class="dsh-header"><h1>定时任务</h1><div class="dsh-ops" style="padding:4px 10px;display:flex;gap:8px">
	<button id="refresh">刷新</button>
	<button id="migrate">迁移 legacy 定义</button>
</div></div>`,
		bodyHtml: `${migrateNote ? `<p class="note">${escapeHtml(migrateNote)}</p>` : ''}
<main id="list">${body}</main>`,
		script: `
async function call(path, body) {
	const res = await fetch('${ROUTE_PREFIX}' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
	return res.json();
}
document.getElementById('refresh').addEventListener('click', () => location.reload());
document.getElementById('migrate').addEventListener('click', async () => {
	const r = await call('/api/migrate');
	alert(r.ok ? '迁移完成：新建 ' + r.created + ' 条，跳过 ' + r.skipped + ' 条，失败 ' + r.failed.length + ' 条' + (r.failed.length ? '\\n' + r.failed.join('\\n') : '') : ('迁移失败：' + (r.error ?? '未知原因')));
	location.reload();
});
document.querySelectorAll('[data-delete]').forEach(btn => btn.addEventListener('click', async () => {
	if (!confirm('删除这个定时任务？')) { return; }
	const r = await call('/api/delete', { id: btn.dataset.delete, sessionId: btn.dataset.session });
	if (!r.ok) { alert('删除失败：' + (r.error ?? '未知原因')); }
	location.reload();
}));
`,
	});
}

// ★ 2026-10-31：apply 开始接收 `config`（此前一直丢着没接）—— 编辑弹窗的企微推送需要
//   `config.notifyWebhook`；不接的话引用就是 ReferenceError（0.5.6 首次真机就炸过）。
export function apply(ctx, config = {}) {
	// ══ 引擎状态：**必须在任何调用之前声明完毕** ════════════════════════════════
	// ★ 2026-10-31 真机事故（根因）：`ctx.inject` 的回调在服务**已就绪**时会**同步**执行。
	//   原先把 `let engineInstalled` 与 `function installScheduleEngine` 写在这个 inject 调用
	//   **之后** ⇒ 回调里访问 `engineInstalled` 命中 TDZ：
	//   `Cannot access 'engineInstalled' before initialization` ⇒ apply 中断
	//   ⇒ **页面路由根本没注册** ⇒ 自绘工作台 fetch `/x/scheduler/api/*` 全是 400。
	//   `function` 声明会提升，但 `let` 不会 ⇒ 声明一律提到 apply 顶部。
	// `engine` 是**模块级**（见上方声明）—— 这里只留幂等开关。
	let engineInstalled = false;

	/**
	 * ★ 2026-10-31：自建调度引擎，**占用 `schedule` 服务键**。
	 *
	 * ⚠ 真机事实（纠正先前的误判）：官方 `@deepseek-ai/dsh-schedule` **确实在组合里**并会尝试
	 *   注册同名服务 —— 启动日志里就有
	 *   `schedule (@deepseek-ai/dsh-schedule): Error: service "schedule" has been registered at <vssaros-scheduler>`
	 *   + `dsh: warning: 1 entry did not activate`。
	 *   ⇒ 我们**抢先**注册 ⇒ 官方那一个激活失败（这正是"停用官方"的落地形态，代价是启动日志里
	 *     多一条 warning）。若哪天官方改回先注册，我们的 `shouldProvideSchedule` 会让步（不抢）。
	 *
	 * ⚠ 必须等 foundation 就绪：`start()` 会读任务库，而数据根来自 foundation。
	 */
	function installScheduleEngine() {
		if (engineInstalled) { return; }
		const verdict = shouldProvideSchedule(ctx);
		if (!verdict.ok) {
			console.warn('[vssaros-scheduler] 组合里已存在 schedule 服务 ⇒ 自建引擎不注册（避免撞键）。');
			engineInstalled = true;
			return;
		}
		engineInstalled = true;
		/**
		 * ⚠ `ctx.logger(name)` 返回的是**对象**（`{ info, warn, error }`），不是函数
		 * （kanban / media 都按对象用）。原先把 `log` 直接当函数调用：`log: line => log(line)`
		 * —— 只有引擎真写日志时才炸，所以一直潜伏着（真机没触发过）。
		 * ⇒ 这里统一包一层：两种形态都能用。
		 */
		const logger = typeof ctx.logger === 'function' ? ctx.logger('vssaros-scheduler') : null;
		const log = (...args) => {
			if (typeof logger === 'function') { logger(...args); return; }
			if (logger && typeof logger.info === 'function') { logger.info(String(args[0])); return; }
			console.log('[vssaros-scheduler]', ...args);
		};
		engine = createScheduleEngine({
			config: {},
			log: line => log(line),
			setIntervalFn: (fn, ms) => setInterval(fn, ms),
			clearIntervalFn: handle => clearInterval(handle),
			// ★ 2026-10-31：企微推送 webhook（插件 config.notifyWebhook；没配 ⇒ 推送只记日志）。
			notifyWebhook: typeof config?.notifyWebhook === 'string' ? config.notifyWebhook.trim() : '',
		});
		ctx.provide('schedule', engine);
		engine.start();
		ctx.effect?.(() => () => engine.stop());
		// 模型侧工具（schedule_create / list / update / delete / history）—— 官方同名工具的接管。
		registerScheduleTools(ctx, { getEngine: () => engine });
		log('自建调度引擎已就绪：占用 schedule 服务键，配 5 个工具');
	}

	// 委托层绑定（foundation 服务；页面壳的真源）。可选注入：缺了页面如实报错而不是 pending。
	{
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
		if (ready) {
			bindFoundation(ready);
			installScheduleEngine();
		}
		ctx.inject(['vssarosFoundation'], child => {
			let svc = null;
			try { svc = child.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
			if (svc) { bindFoundation(svc); }
			installScheduleEngine();
		});
	}

	// 页面路由（可选注入 webServer + connection：缺了就不开页面，不阻塞启动）。
	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		// ★ 2026-10-31（真机：`/x/scheduler/` 前缀下的路径一律 400 + 空 body）：
		//   ⚠ 别在注释里写"路径 + 星号"：包内自检的 strip() 会把 `/*` 当成块注释起点，
		//      一直吃到下一个 `*/` ⇒ 中间的真实代码被当成注释删掉 ⇒ 断言集体假红。
		//   `dsh-host-webserver` 的兜底是 `handle(...).catch(err => { logger.warn(err); res.writeHead(400); res.end(); })`
		//   ⇒ handler 里**任何**异常都会变成"400 空响应"，前端 `res.json()` 只能报
		//   "Unexpected end of JSON input"，真实原因完全看不见。
		//   ⇒ 这里自己兜住：一律回 500 + JSON 错误（前端已容错 ⇒ 页面显示真实堆栈）。
		handler: async (req, res) => {
			try {
			const rejected = webCtx.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain' });
				res.end(String(rejected));
				return;
			}
			const url = new URL(req.url ?? '/', 'http://localhost');
			const json = (status, body) => {
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify(body));
			};
			if (url.pathname === `${ROUTE_PREFIX}/api/delete` && req.method === 'POST') {
				try {
					const body = JSON.parse(await readBody(req));
					const out = await deleteSchedule(ctx, body);
					json(out.ok ? 200 : 500, out);
				} catch (e) {
					json(500, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			// ★ 2026-10-31（用户：「点击新建自动化任务错误」——点了只开一个空白会话）：
			//   官方 `schedule` 服务只把 list/catalog/history/delete/update 标了 `@Remote`，
			//   **create 没标** ⇒ 客户端 `remote.schedule.create` 根本不存在，工作台表单创建不了。
			//   ⇒ 由 Host 侧这条接口中转：`ctx.schedule.create(sessionId, request)`。
			if (url.pathname === `${ROUTE_PREFIX}/api/create` && req.method === 'POST') {
				try {
					const body = JSON.parse(await readBody(req));
					const out = await createSchedule(ctx, body);
					json(out.ok ? 200 : 400, out);
				} catch (e) {
					json(500, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			// 自建引擎新增：改任务（暂停/恢复/改规则）与投递历史。官方的 update 虽然标了 @Remote，
			// 但那是官方服务的方法；这里统一走我们自己的引擎，避免两套语义。
			if (url.pathname === `${ROUTE_PREFIX}/api/update` && req.method === 'POST') {
				try {
					const body = JSON.parse(await readBody(req));
					const out = await updateSchedule(body);
					json(out.ok ? 200 : 400, out);
				} catch (e) {
					json(400, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			// ★ 2026-10-31（卡片 hover 的「▶ 立即运行一次」）：引擎本来就有 `fireNow`
			//   （派发一次、写历史、并把下次时间推进一格），只是没暴露成路由 ⇒ 这里开一个。
			//   ⚠ 它是**真派发**（会按任务内容触发一次）⇒ 只允许手动点击调用，不放进引擎 tick。
			if (url.pathname === `${ROUTE_PREFIX}/api/run` && req.method === 'POST') {
				try {
					const body = JSON.parse(await readBody(req));
					const id = typeof body?.id === 'string' ? body.id.trim() : '';
					if (!id) { json(400, { ok: false, error: '需要 id' }); return; }
					if (!engine) { json(400, { ok: false, error: '调度引擎未就绪' }); return; }
					const fired = engine.fireNow(id);
					json(fired ? 200 : 400, { ok: fired === true, ...(fired ? {} : { error: '找不到这条任务（或已结束）' }) });
				} catch (e) {
					json(400, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			if (url.pathname === `${ROUTE_PREFIX}/api/history` && req.method === 'GET') {
				const id = url.searchParams.get('id') ?? '';
				json(200, { ok: true, records: engine ? engine.history({ id, limit: 50 }) : [] });
				return;
			}
			if (url.pathname === `${ROUTE_PREFIX}/api/migrate` && req.method === 'POST') {
				try {
					json(200, await migrateLegacySchedules(ctx));
				} catch (e) {
					json(500, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			// ★ 2026-10-22（工作台重构 P1，方案 §5 步骤 1）：业务数据接口 —— React 工作台（lib/client.js）与
			//   SSR 页同源取数。`available=false` = 官方调度 bundle 没装上（与 SSR 页同口径，不报 500）。
			if (url.pathname === `${ROUTE_PREFIX}/api/list` && req.method === 'GET') {
				const out = await listSchedules(ctx);
				res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(out));
				return;
			}
			// 页面本体
			const { entries, available } = await listSchedules(ctx);
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(renderPage(entries, available, ''));
			} catch (e) {
				if (res.headersSent) { try { res.end(); } catch { /* 已发送就到此为止 */ } return; }
				try {
					res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
					res.end(JSON.stringify({ ok: false, available: false, entries: [], error: String(e?.stack ?? e?.message ?? e) }));
				} catch { /* 响应已经不可写 */ }
			}
		},
	})));
}

/**
 * 任务清单（SSR 页与 `/api/list` 共用）。
 * 数据源是**自建引擎**（不再是官方 `schedule.catalog()`）；引擎未就绪 ⇒ `available=false`
 * 并说清原因，绝不报 500（与从前同口径：调度缺席不影响其它功能）。
 */
async function listSchedules(ctx) {
	if (!engine) {
		return { ok: true, available: false, entries: [], error: '调度引擎未就绪（foundation 未注入，或组合里已有别的 schedule 服务）' };
	}
	try {
		return { ok: true, available: true, entries: engine.catalog({ limit: 200 }).map(rowOf) };
	} catch (e) {
		const error = String(e?.message ?? e);
		ctx.logger('vssaros-scheduler').warn(`任务清单读取失败：${error}`);
		return { ok: true, available: false, entries: [], error };
	}
}

/**
 * 改一条任务（暂停/恢复/改名称/改规则）。规则若给的是官方形状 ⇒ 同样经 `officialToSelfRule` 转换。
 */
async function updateSchedule(body) {
	if (!engine) { return { ok: false, error: '调度引擎未就绪' }; }
	const id = typeof body?.id === 'string' ? body.id.trim() : '';
	if (!id) { return { ok: false, error: '需要 id' }; }
	const patch = {};
	if (body.status) { patch.status = String(body.status); }
	if (body.title) { patch.title = String(body.title); }
	// ★ 2026-10-31：编辑弹窗会改任务内容（prompt）—— `/api/list` 也把它带出去给卡片显示。
	if (typeof body?.prompt === 'string') { patch.prompt = body.prompt.trim(); }
	// ★ 编辑弹窗的「有效期 / 消息推送」：expiresAt 传空串 = 清掉（回到长期有效）。
	if (typeof body?.expiresAt === 'string') { patch.expiresAt = body.expiresAt.trim(); }
	if (typeof body?.notify === 'boolean') { patch.notify = body.notify; }
	if (body.rule) { patch.rule = body.rule.kind ? body.rule : (officialToSelfRule(body.rule) ?? body.rule); }
	try {
		const task = engine.update(id, patch);
		return task ? { ok: true, id: task.id, status: task.status } : { ok: false, error: `找不到任务：${id}` };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

// `officialToSelfRule` 已移到 `core/task.js`（index.js 与 migrate.js 共用，避免两处各写一份）。

/**
 * 新建一条定时任务（工作台「新建自动化任务」表单的唯一落点）。
 *
 * 为什么必须走 Host：官方 `ScheduleService.create` **没有** `@Remote` 装饰（只有
 * list/catalog/history/delete/update 有）⇒ 客户端 `remote.schedule.create` 不存在，
 * 浏览器侧拿不到创建能力（官方语义是"开会话让模型用 schedule_create 建"）。
 * 这里用程序化 `ctx.schedule.create` 中转，跳过模型也能建（与 migrate 同口径）。
 * @returns `{ ok, id, title }` 或 `{ ok:false, code?, error }`（错误一律不抛，交给表单显示）。
 */
// ⚠ 旧的 `createSchedule`（调官方 `ScheduleService.create(sessionId, request)`）已删除：
//   官方 bundle 不再安装，那条路根本走不通；新实现在上面（走自建引擎，见 `createSchedule`）。

/**
 * 表单的规则部分 → 官方 `ScheduleCreateRequest` 的规则字段（六种择一）。
 * @returns `{ request }` 或 `{ error }`。
 */
export function buildCreateRule(body) {
	const zone = typeof body?.timeZone === 'string' && body.timeZone.trim() ? body.timeZone.trim() : 'UTC';
	const kind = String(body?.kind ?? 'daily');
	if (kind === 'daily' || kind === 'weekly') {
		const time = normalizeClock(body?.time);
		if (!time) { return { error: '需要时间（HH:mm）' }; }
		if (kind === 'daily') { return { request: { daily: { time, time_zone: zone } } }; }
		const weekdays = normalizeWeekdays(body?.weekdays);
		if (!weekdays.length) { return { error: '每周任务至少要选择一个星期' }; }
		return { request: { weekly: { time, time_zone: zone, weekdays } } };
	}
	if (kind === 'every') {
		const seconds = Number(body?.everySeconds);
		if (!Number.isFinite(seconds) || seconds < 60) { return { error: '间隔至少 60 秒' }; }
		return { request: { every_seconds: Math.floor(seconds) } };
	}
	if (kind === 'once') {
		const date = String(body?.date ?? '').trim();
		const time = normalizeClock(body?.time);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { return { error: '需要日期（YYYY-MM-DD）' }; }
		if (!time) { return { error: '需要时间（HH:mm）' }; }
		return { request: { at: { date, time, time_zone: zone } } };
	}
	if (kind === 'cron') {
		const expression = String(body?.expression ?? '').trim();
		if (!expression) { return { error: '需要 cron 表达式' }; }
		return { request: { cron: { expression, time_zone: zone } } };
	}
	return { error: `不支持的规则类型：${kind}` };
}

/** `HH:mm` / `HH:mm:ss` → 官方要的 `HH:mm:ss`；认不出来返回空串。 */
function normalizeClock(value) {
	const raw = String(value ?? '').trim();
	if (!/^\d{2}:\d{2}(:\d{2})?$/.test(raw)) { return ''; }
	return raw.length === 5 ? `${raw}:00` : raw;
}

/** 去重排序的 ISO 星期集合（周一 1 … 周日 7），越界值丢弃。 */
function normalizeWeekdays(value) {
	const list = Array.isArray(value) ? value : [];
	const set = new Set();
	for (const item of list) {
		const day = Number(item);
		if (Number.isInteger(day) && day >= 1 && day <= 7) { set.add(day); }
	}
	return Array.from(set).sort((a, b) => a - b);
}

/**
 * 删除一条任务（自建引擎：**不需要** sessionId —— 任务不寄生会话，这是与官方的关键差别）。
 * @returns `{ ok, deleted }` —— 没找到也给 `ok:true, deleted:0`（幂等，页面按"已不在列表里"处理）。
 */
async function deleteSchedule(ctx, body) {
	if (!engine) { return { ok: false, error: '调度引擎未就绪' }; }
	const id = typeof body?.id === 'string' ? body.id.trim() : '';
	if (!id) { return { ok: false, error: '需要 id' }; }
	const deleted = engine.remove(id);
	return { ok: true, deleted: deleted ? 1 : 0 };
}

/**
 * 创建一条任务。
 *
 * ⚠ 兼容两种入参形状：
 *   ① 新 UI/工具直接给 `rule`（自建形状）⇒ 透传；
 *   ② 旧表单给扁平字段（`kind/time/weekdays/...`，见 `buildCreateRule`）⇒ 转成自建 rule。
 *   过渡期两套并存；UI 换成自建之后 ② 可删（连同 `buildCreateRule` 一起）。
 */
async function createSchedule(ctx, body) {
	if (!engine) { return { ok: false, error: '调度引擎未就绪（foundation 未注入，或组合里已有别的 schedule 服务）' }; }
	try {
		const request = body?.rule
			? { rule: body.rule }
			: (() => {
				const built = buildCreateRule(body);
				return built.error ? { error: built.error } : { rule: officialToSelfRule(built.request) };
			})();
		if (request.error) { return { ok: false, error: request.error }; }
		if (!request.rule) { return { ok: false, error: '规则无法识别' }; }
		const task = engine.create({
			id: `t-${randomUUID().slice(0, 8)}`,
			title: typeof body?.title === 'string' ? body.title.trim() || '未命名任务' : '未命名任务',
			kind: typeof body?.kind === 'string' && ['prompt', 'loop', 'action'].includes(body.kind) ? body.kind : 'prompt',
			...(request.rule ? { rule: request.rule } : {}),
			...(body?.prompt ? { prompt: String(body.prompt).trim() } : {}),
			...(body?.sessionId ? { sessionId: String(body.sessionId).trim() } : {}),
			...(body?.loopName ? { loopName: String(body.loopName).trim() } : {}),
			...(body?.workItem ? { workItem: body.workItem } : {}),
			// ★ 2026-10-31（编辑弹窗）：有效期与消息推送。
			...(typeof body?.expiresAt === 'string' && body.expiresAt.trim() ? { expiresAt: body.expiresAt.trim() } : {}),
			...(body?.notify === true ? { notify: true } : {}),
		});
		return { ok: true, id: task.id, title: task.title };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let buf = '';
		req.on('data', c => { buf += c; if (buf.length > 64 * 1024) { req.destroy(); reject(new Error('body too large')); } });
		req.on('end', () => resolveBody(buf));
		req.on('error', reject);
	});
}
