// @vssaros/dsh-xhs-note — 服务端：草稿 CRUD + 页面壳。
//
// 数据全部落 `<数据根>/xhs-note/drafts/`（`lib/store.js`），页面与工作台读同一份 ⇒ 不会漂移。
// 路由风格与 `vssaros-scheduler` 一致：`webServer.register({ kind:'prefix' })` + `connection.requestRejection`。
import { listDrafts, readDraft, writeDraft, deleteDraft, migrateLegacy, dataRootOf, draftsDirOf, MAX_DRAFTS, DraftConflictError } from './store.js';
import { bindFoundation } from './foundationRef.js';

export const name = 'dsh-xhs-note';

const ROUTE_PREFIX = '/x/xhs-note';

const readBody = (req) => new Promise((resolve, reject) => {
	const chunks = [];
	let size = 0;
	req.on('data', (chunk) => {
		size += chunk.length;
		if (size > 256 * 1024) { reject(new Error('请求体太大')); req.destroy(); return; }
		chunks.push(chunk);
	});
	req.on('end', () => { try { resolve(Buffer.concat(chunks).toString('utf8')); } catch (e) { reject(e); } });
	req.on('error', reject);
});

const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** 页面壳：直开 `/x/xhs-note/` 也能用（工作台里由注册式 React 面板接管）。 */
export function renderShell({ drafts, dir, error }) {
	const rows = drafts.map((item) => `<li data-xhs-draft-id="${escapeHtml(item.id)}"><b>${escapeHtml(item.title || item.topic || '（无标题）')}</b><small>${escapeHtml(item.savedAt)}</small></li>`).join('');
	return [
		'<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>小红书笔记</title>',
		'<style>body{margin:0;padding:24px;font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
		'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111)}',
		'li{margin:6px 0}small{margin-left:8px;color:var(--dsw-alias-label-caption,#888)}</style></head>',
		`<body data-vssaros-page="xhs-note" data-xhs-drafts-count="${drafts.length}">`,
		'<h1>小红书笔记</h1>',
		`<p>草稿目录：<code>${escapeHtml(dir)}</code>（共 ${drafts.length} 篇，上限 ${MAX_DRAFTS}）</p>`,
		error ? `<p role="alert">读取失败：${escapeHtml(error)}</p>` : '',
		rows ? `<ul>${rows}</ul>` : '<p>还没有草稿。在 dsh 里打开「小红书笔记」工作台开始写。</p>',
		'</body></html>',
	].join('');
}

export function apply(ctx, config = {}) {
	// 数据根的唯一真源在 foundation（`lib/store.js` 只是委托）⇒ 先绑定再干活。
	{
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针假 ctx */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], (child) => {
			let svc = null;
			try { svc = child.vssarosFoundation ?? child.get?.('vssarosFoundation') ?? null; } catch { /* 探针假 ctx */ }
			if (svc) { bindFoundation(svc); }
		});
	}

	ctx.inject(['webServer', 'connection'], (webCtx) => webCtx.effect(() => webCtx.webServer.register({
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
				res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
				res.end(JSON.stringify(body));
			};
			const method = String(req.method || 'GET').toUpperCase();
			const path = url.pathname;

			try {
				// 列表（只要元数据）
				if (path === `${ROUTE_PREFIX}/api/drafts` && method === 'GET') {
					const out = await listDrafts(config);
					json(200, { ok: true, drafts: out.drafts, dir: out.dir, max: MAX_DRAFTS });
					return;
				}
				// 迁移（旧 localStorage，幂等）
				if (path === `${ROUTE_PREFIX}/api/migrate` && method === 'POST') {
					const body = JSON.parse(await readBody(req) || '{}');
					json(200, { ok: true, ...(await migrateLegacy(config, body.items)) });
					return;
				}
				// 单篇
				const one = path.startsWith(`${ROUTE_PREFIX}/api/drafts/`) ? decodeURIComponent(path.slice(`${ROUTE_PREFIX}/api/drafts/`.length)) : '';
				if (one && method === 'GET') {
					const draft = await readDraft(config, one);
					if (!draft) { json(404, { ok: false, error: '草稿不存在' }); return; }
					json(200, { ok: true, draft });
					return;
				}
				if (one && method === 'DELETE') {
					json(200, { ok: true, ...(await deleteDraft(config, one)) });
					return;
				}
				// 新建 / 更新（更新必须带 rev）
				if (path === `${ROUTE_PREFIX}/api/drafts` && method === 'POST') {
					const body = JSON.parse(await readBody(req) || '{}');
					json(200, { ok: true, ...(await writeDraft(config, body)) });
					return;
				}
				if (one && method === 'POST') {
					const body = JSON.parse(await readBody(req) || '{}');
					json(200, { ok: true, ...(await writeDraft(config, { ...body, id: one })) });
					return;
				}
				// 页面壳
				if (path === `${ROUTE_PREFIX}/` || path === ROUTE_PREFIX) {
					let drafts = [];
					let error = '';
					try { drafts = (await listDrafts(config)).drafts; } catch (e) { error = String(e?.message ?? e); }
					res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
					res.end(renderShell({ drafts, dir: draftsDirOf(config), error }));
					return;
				}
				json(404, { ok: false, error: '没有这条路由' });
			} catch (e) {
				const status = e instanceof DraftConflictError ? 409 : 500;
				json(status, { ok: false, error: String(e?.message ?? e), code: e?.code || '' });
			}
		},
	})));

	// 启动时打一行日志，确认数据根（探针与排障都靠它）
	try { ctx.logger?.info?.(`[xhs-note] 草稿目录：${draftsDirOf(config)}`); } catch { /* 没有 logger 就算了 */ }
	// 数据根常量导出给其它模块复用（避免各处各写一遍回落链）
	try { ctx.effect?.(() => { ctx.xhsNote = { dataRoot: dataRootOf(config), draftsDir: draftsDirOf(config) }; }); } catch { /* 可选 */ }
}
