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
// · 不做创建表单：官方语义是"任务由模型在原会话里创建"（ui-schedule 页面也没有创建表单），
//   迁移与初始化走程序化 `schedule.create`（不必经模型 ✓）；
// · 不管触发 / 投递 / 持久化：全是官方件的事。
//
// ── 服务的拿法 ──────────────────────────────────────────────────────────────
// `schedule` 服务**可选注入**：官方 bundle 没装上的组合里，页面如实显示"不可用"而不是
// 让插件永久 pending（与 sessions/dashboard 同口径：webServer/connection 也走可选注入 ⇒
// 静态 inject 留空，headless 组合也能加载）。

import { escapeHtml, renderShell } from './pageShell.js';
import { bindFoundation } from './foundationRef.js';
import { migrateLegacySchedules } from './migrate.js';

export const name = 'vssaros-scheduler';
/** 没有硬依赖：webServer/connection/schedule 都走可选注入（见文件头）。 */
export const inject = [];

const ROUTE_PREFIX = '/x/scheduler';

/** 把一条 catalog 记录整理成页面要的一行（规则文本 + 下次运行 + 状态）。 */
function rowOf(entry) {
	const rule = entry?.rule ?? {};
	let ruleText = rule.kind ?? '?';
	if (rule.kind === 'cron') { ruleText = `cron ${rule.expression ?? ''}（${rule.time_zone ?? ''}）`; }
	else if (rule.kind === 'daily') { ruleText = `每天 ${rule.time ?? ''}（${rule.time_zone ?? ''}）`; }
	else if (rule.kind === 'weekly') { ruleText = `每周 ${JSON.stringify(rule.weekdays ?? [])} ${rule.time ?? ''}（${rule.time_zone ?? ''}）`; }
	else if (rule.kind === 'every') { ruleText = `每 ${rule.every_seconds ?? '?'} 秒`; }
	else if (rule.kind === 'at') { ruleText = `一次性 ${rule.at?.date ?? ''} ${rule.at?.time ?? ''}`; }
	else if (rule.kind === 'after') { ruleText = `一次性延迟 ${rule.after_seconds ?? '?'} 秒`; }
	return {
		id: String(entry?.id ?? ''),
		title: String(entry?.title ?? ''),
		status: entry?.status === 'active' ? 'active' : 'inactive',
		sessionId: String(entry?.sessionId ?? ''),
		ruleText,
		next: entry?.next?.target ?? '',
		lastDelivered: entry?.lastDelivery?.deliveredAt ?? '',
	};
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

export function apply(ctx) {
	// 委托层绑定（foundation 服务；页面壳的真源）。可选注入：缺了页面如实报错而不是 pending。
	{
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
			let svc = null;
			try { svc = child.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
			if (svc) { bindFoundation(svc); }
		});
	}

	// 页面路由（可选注入 webServer + connection：缺了就不开页面，不阻塞启动）。
	ctx.inject(['webServer', 'connection'], webCtx => webCtx.effect(() => webCtx.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
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
			if (url.pathname === `${ROUTE_PREFIX}/api/migrate` && req.method === 'POST') {
				try {
					json(200, await migrateLegacySchedules(ctx));
				} catch (e) {
					json(500, { ok: false, error: String(e?.message ?? e) });
				}
				return;
			}
			// 页面本体
			const schedule = scheduleOf(ctx);
			let entries = [];
			let available = !!schedule;
			if (schedule) {
				try {
					entries = (await schedule.catalog()).map(rowOf);
				} catch (e) {
					available = false;
					ctx.logger('vssaros-scheduler').warn(`catalog 读取失败：${String(e?.message ?? e)}`);
				}
			}
			res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
			res.end(renderPage(entries, available, ''));
		},
	})));
}

/** 可选拿 schedule 服务（官方 bundle 未装时为 undefined）。 */
function scheduleOf(ctx) {
	try {
		return ctx.get?.('schedule') ?? ctx.schedule ?? undefined;
	} catch {
		return undefined;
	}
}

async function deleteSchedule(ctx, body) {
	const schedule = scheduleOf(ctx);
	if (!schedule) { return { ok: false, error: '调度服务不可用（官方 bundle 未安装）' }; }
	const id = typeof body?.id === 'string' ? body.id.trim() : '';
	const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
	if (!id || !sessionId) { return { ok: false, error: '需要 id 与 sessionId' }; }
	const out = await schedule.delete({ sessionId, ids: [id] });
	return { ok: true, deleted: out?.deleted ?? 0 };
}

function readBody(req) {
	return new Promise((resolveBody, reject) => {
		let buf = '';
		req.on('data', c => { buf += c; if (buf.length > 64 * 1024) { req.destroy(); reject(new Error('body too large')); } });
		req.on('end', () => resolveBody(buf));
		req.on('error', reject);
	});
}
