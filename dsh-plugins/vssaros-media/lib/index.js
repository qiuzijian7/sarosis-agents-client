// @vssaros/dsh-media — host half：只读页面（`/x/media/`）+ 只读工具（media_list / media_stats）。
//
// 数据面在同目录的 `lib/store.js`（**只读**直连 VsSaros 主进程的 media.db —— 为什么"能直连"、
// 为什么"只读"，理由都写在那里）。本文件只管三件事：路由、页面渲染、工具定义。
//
// 页面形态照 `vssaros-codebase` / `vssaros-kanban` 的整页范式：静态 `inject = ['tools']`
// （别把 `webServer` / `connection` 写进去 —— 那会让插件在 headless / tui profile 里**永久
// pending**，连工具一起失效，kanban 实测过），页面路由走可选 `ctx.inject([...])` 动态挂。

import { escapeHtml, renderChips, renderShell } from './pageShell.js';
import { listAssets, mediaDbPathOf, mediaRootOf, statsOf } from './store.js';

export const name = 'vssaros-media';

/** 只依赖 tools：见文件头。 */
export const inject = ['tools'];

/** 页面前缀路由：不带尾斜杠（prefix 匹配 `p` 与 `p/<anything>`）。 */
const ROUTE_PREFIX = '/x/media';
/** 清单声明的整页路由（**精确匹配**）。 */
const PAGE_ROUTE = '/x/media/';
/** 本插件注册的工具名（页面自诊断用，探针据此断言）。 */
const TOOL_NAMES = ['media_list', 'media_stats'];
/** 页面默认列出的资产条数。 */
const PAGE_LIMIT = 30;
/** 支持的资产类型（与 VsSaros 侧 `MediaAsset.kind` 一致）。 */
const KINDS = ['image', 'video', 'audio', 'text'];

function formatBytes(value) {
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) { return '0 B'; }
	const units = ['B', 'KB', 'MB', 'GB'];
	let v = n;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function isoOf(ms) {
	return typeof ms === 'number' && Number.isFinite(ms)
		? new Date(ms).toISOString().replace('T', ' ').slice(0, 16)
		: '未知';
}

function shortRef(ref) {
	const text = String(ref ?? '');
	if (text.startsWith('data:')) { return '（内联 data URL）'; }
	if (!text.includes('/') && !text.includes('\\')) { return text; }
	const parts = text.split(/[\\/]/).filter(Boolean);
	return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : text;
}

/** 媒体库专属样式（外壳之外的那点：统计行 + 资产条目）。 */
const MEDIA_CSS = `
/* ★ 2026-10-15（统一 sideview 风格 ✓）：与 codebase / 记忆库 **同一套 token** —— 同一份圆角(9px)/间距(8px)/
   卡底色(editor-background)/大数字字号(19px)/主题变量（--vscode-*）✓。统计 = **仪表盘卡**：3 张主卡 + 一行分类格 ✓；
   页顶另有**置顶主操作**（.dsh-actbar ✓）。
   ⚠ 本块是**模板字符串**内容 ⇒ 注释里**不能出现反引号** ✗（会直接把字符串截断 —— 2026-10-15 现场踩到 ✓）。 */
.dsh-actbar { padding: 6px 10px 0; }
.dsh-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; padding: 5px 12px; text-decoration: none; font-weight: 600; font-size: 12px; }
.dsh-btn-primary { background: var(--vscode-button-background, var(--vscode-focusBorder, #007acc)); color: var(--vscode-button-foreground, #fff); }
.dsh-btn-primary:hover { filter: brightness(1.08); }
.dsh-cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 8px 10px 4px; }
.dsh-card { background: var(--vscode-editor-background, rgba(128,128,128,.06)); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 9px; padding: 10px 11px; }
.dsh-card b { display: block; font-size: 19px; font-weight: 700; line-height: 1.1; font-variant-numeric: tabular-nums; }
.dsh-card span { font-size: 10.5px; color: var(--vscode-descriptionForeground, #999); }
.dsh-kinds { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 2px 10px 6px; }
.dsh-kind { border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.35)); border-radius: 7px; padding: 6px 8px; text-align: center; }
.dsh-kind b { display: block; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-kind span { font-size: 10px; color: var(--vscode-descriptionForeground, #999); }
.dsh-asset { display: flex; gap: 8px; align-items: baseline; }
.dsh-asset-kind { flex-shrink: 0; font-size: 11px; width: 42px; color: var(--vscode-descriptionForeground, #999); }
.dsh-fav { color: #f59e0b; }
`;

function renderPage({ stats, assets, kind, root, dbPath, toolsRegistered, error }) {
	const chips = [{ value: 'all', label: '全部', active: !kind }].concat(
		KINDS.map(k => ({ value: k, label: k, active: kind === k })));

	// ★ 2026-10-15（统一 sideview 风格 ✓）：统计从"一排小格"变成**仪表盘卡** ——
	//   3 张**主卡**（个资产 / 占用 / 回收站 ✓，与 codebase、记忆库同一套卡片 token）+ 一行**分类格**（image/video/… ✓）。
	//   ⚠ `data-vssaros-media-*` 锚点**原样保留**（`p3-37` 断的就是它们 ✓、不是类名 ✗）。
	const statsHtml = stats ? `<div class="dsh-cards">
	<div class="dsh-card"><b>${escapeHtml(String(stats.assetCount))}</b><span>个资产</span></div>
	<div class="dsh-card"><b>${escapeHtml(formatBytes(stats.totalBytes))}</b><span>占用</span></div>
	<div class="dsh-card"><b>${escapeHtml(String(stats.deletedCount))}</b><span>回收站</span></div>
</div>
<div class="dsh-kinds">
${KINDS.map(k => `<div class="dsh-kind"><b>${escapeHtml(String(stats.byKind[k] ?? 0))}</b><span>${escapeHtml(k)}</span></div>`).join('\n')}
</div>` : '';

	// ★ 2026-10-15："**按钮置顶**" ✓ —— 本页是**只读**的（同记忆库 ✓）⇒ 它唯一的主操作是**刷新** ✓。
	//   放在**统计卡之前**（第一眼就是它 ✓）；用 `<a>` 而不是表单/脚本 ⇒ 保持零脚本 ✓。
	//   ⚠ 带 `?kind=` 时**保住当前筛选**（刷新不该把用户的筛选悄悄丢掉 ✗）。
	const refreshHref = kind ? `./?kind=${encodeURIComponent(kind)}` : './';
	const actionHtml = `<div class="dsh-actbar"><a class="dsh-btn dsh-btn-primary" href="${refreshHref}" title="重新读取媒体库（只读）" aria-label="刷新媒体库">⟳ 刷新</a></div>`;

	const rows = assets.map(asset => {
		const meta = [
			asset.sizeBytes ? formatBytes(asset.sizeBytes) : '',
			isoOf(asset.createdAt),
			asset.board ? `分组 ${asset.board}` : '',
			asset.tags?.length ? asset.tags.map(t => `#${t}`).join(' ') : '',
		].filter(Boolean).join(' · ');
		return `<li class="dsh-item"><div class="dsh-item-content">
<div class="dsh-item-title dsh-asset"><span class="dsh-asset-kind">${escapeHtml(asset.kind)}</span>${asset.favorite ? '<span class="dsh-fav">★</span> ' : ''}${escapeHtml(asset.fileName ?? shortRef(asset.ref))}</div>
<div class="dsh-item-meta">${escapeHtml(meta)}</div>
</div></li>`;
	}).join('');

	const body = error
		? `<p class="dsh-empty">读取媒体库失败：${escapeHtml(error)}</p>`
		: `${actionHtml}${statsHtml}
<p class="dsh-diag" data-vssaros-media-assets="${escapeHtml(String(stats?.assetCount ?? ''))}"
	data-vssaros-media-deleted="${escapeHtml(String(stats?.deletedCount ?? ''))}"
	data-vssaros-media-bytes="${escapeHtml(String(stats?.totalBytes ?? ''))}"
	data-vssaros-media-kind="${escapeHtml(kind || 'all')}"
	data-vssaros-media-count="${escapeHtml(String(assets.length))}"
	data-vssaros-media-dir="${escapeHtml(dbPath)}"
	data-vssaros-media-tools="${escapeHtml(toolsRegistered)}">库文件 <code>${escapeHtml(dbPath)}</code> · 工具 <code>${escapeHtml(toolsRegistered)}</code> · 列表 ${escapeHtml(String(assets.length))} 条${kind ? `（过滤 ${escapeHtml(kind)}）` : ''}</p>
${assets.length ? `<ul class="dsh-scroll">${rows}</ul>` : '<p class="dsh-empty">暂无媒体资产（工作流产出图片后会出现在这里）。</p>'}`;

	const script = "document.querySelectorAll('.dsh-chip').forEach(function(b){b.addEventListener('click',function(){var v=b.getAttribute('data-chip');location.search=(v&&v!=='all')?('?kind='+encodeURIComponent(v)):'';});});";

	return renderShell({
		kind: 'media',
		title: '媒体库',
		subtitle: '只读 · 直连 media.db',
		chipsHtml: renderChips(chips),
		bodyHtml: body,
		attrs: `data-vssaros-media-root="${escapeHtml(root)}"`,
		extraCss: MEDIA_CSS,
		script,
	});
}

/** 资产行（页面与工具共用；`unknown` 一律写"未知"，不写 0）。 */
function assetRow(asset) {
	return {
		id: asset.id,
		kind: asset.kind,
		ref: asset.ref,
		fileName: asset.fileName,
		sizeBytes: asset.sizeBytes,
		createdAt: asset.createdAt,
		favorite: asset.favorite,
		board: asset.board,
		tags: asset.tags,
	};
}

function toolDefinitions(state, config) {
	const where = async (params) => {
		const kind = typeof params?.kind === 'string' ? params.kind.trim() : '';
		const limit = Number.isFinite(params?.limit) ? Math.floor(params.limit) : PAGE_LIMIT;
		return {
			kind: KINDS.includes(kind) ? kind : undefined,
			limit: Math.max(1, Math.min(200, limit)),
		};
	};

	return [{
		name: 'media_list',
		description: '列出 VsSaros 媒体库的资产（工作流产出的图片 / 视频 / 音频 / 文本）及其元数据（类型、大小、时间、收藏、分组、标签）。数据来自主进程 MediaStore 的 media.db（只读）。',
		parameters: {
			type: 'object',
			properties: {
				// dsh 的参数 schema 只接受受限子集（无 minimum/maximum）：范围写描述、由代码夹紧
				limit: { type: 'integer', description: '返回条数上限，1–200（默认 30；超出会被夹到边界）' },
				kind: { type: 'string', description: `按类型过滤：${KINDS.join(' / ')}（省略 = 全部）` },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					total: { type: 'integer', description: '库里该过滤条件下的资产总数（不含软删）' },
					dbPath: { type: 'string' },
					assets: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								id: { type: 'string' }, kind: { type: 'string' }, ref: { type: 'string' },
								fileName: { type: 'string' }, sizeBytes: { type: 'integer' },
								createdAt: { type: 'integer' }, favorite: { type: 'boolean' },
								board: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } },
							},
							required: ['id', 'kind'],
						},
					},
				},
				required: ['total', 'assets'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `媒体库 ${value.total} 个资产（本次返回 ${value.assets.length} 个）\n`
					+ (value.assets.length
						? value.assets.map(a => `- ${a.kind} ${a.fileName ?? shortRef(a.ref)}：${a.sizeBytes ? formatBytes(a.sizeBytes) : '大小未知'} · ${isoOf(a.createdAt)}${a.favorite ? ' · ★' : ''}${a.board ? ` · 分组 ${a.board}` : ''}`).join('\n')
						: '（没有资产）'),
			}],
		},
		isConcurrencySafe: () => true,
		execute: async (params) => {
			const filter = await where(params);
			const stats = await statsOf(config);
			const assets = await listAssets(config, { ...filter, limit: filter.limit });
			return {
				total: stats.assetCount,
				dbPath: mediaDbPathOf(config),
				assets: assets.map(assetRow).map(row => Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined))),
			};
		},
	}, {
		name: 'media_stats',
		description: '汇总 VsSaros 媒体库的统计（资产数 / 回收站数 / 占用字节 / 各类型计数）。数据来自主进程 MediaStore 的 media.db（只读）。',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					assetCount: { type: 'integer' }, deletedCount: { type: 'integer' },
					totalBytes: { type: 'integer' },
					byKind: { type: 'object', properties: Object.fromEntries(KINDS.map(k => [k, { type: 'integer' }])) },
					dbPath: { type: 'string' },
				},
				required: ['assetCount', 'totalBytes'],
			},
			render: (_args, value) => [{
				type: 'text',
				text: `媒体库：${value.assetCount} 个资产 · 占用 ${formatBytes(value.totalBytes)} · 回收站 ${value.deletedCount}`
					+ `\n分类：${KINDS.map(k => `${k} ${value.byKind?.[k] ?? 0}`).join(' · ')}\n库文件：${value.dbPath}`,
			}],
		},
		isConcurrencySafe: () => true,
		execute: async () => {
			const stats = await statsOf(config);
			return { ...stats, dbPath: mediaDbPathOf(config) };
		},
	}];
}

export function apply(ctx, config = {}) {
	const state = { tools: null };

	// ① 工具
	ctx.effect(() => {
		// ── R13（preset plane）：同一个包会被挂**两次**（host plane + 我们的 preset）──
		// `hostHalf: true` ⇒ 这次只注册页面，不注册工具（工具交给 preset 里那次）；缺省 ⇒ 与从前一致。
		if (config.hostHalf === true) { return undefined; }
		const disposers = toolDefinitions(state, config).map(definition => ctx.tools.register(definition));
		state.tools = ctx.tools;
		return () => {
			state.tools = null;
			for (const dispose of disposers) {
				dispose();
			}
		};
	});

	// ② 页面路由（**可选**依赖：缺 webServer / connection 的模板里只是没有页面，工具照常可用）
	ctx.inject(['webServer', 'connection'], page => page.effect(() => page.webServer.register({
		kind: 'prefix',
		path: ROUTE_PREFIX,
		handler: async (req, res) => {
			const rejected = page.connection.requestRejection(req);
			if (rejected) {
				res.writeHead(rejected, { 'content-type': 'text/plain; charset=utf-8' });
				res.end(String(rejected));
				return;
			}
			try {
				const url = new URL(req.url ?? '/', 'http://127.0.0.1');
				if (url.pathname !== PAGE_ROUTE) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(`不是本插件的页面路由：${url.pathname}`);
					return;
				}
				const requested = url.searchParams.get('kind') ?? '';
				const kind = KINDS.includes(requested) ? requested : '';
				const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
				// 读失败不 500：把原因渲染进页面（"库还没建"/"node:sqlite 不可用"都是用户能自己处理的）
				let stats;
				let assets = [];
				let error;
				try {
					stats = await statsOf(config);
					assets = await listAssets(config, { kind: kind || undefined, limit: PAGE_LIMIT });
				} catch (e) {
					error = String(e?.message ?? e);
				}
				// 先渲染再 writeHead（渲染抛错还能干净回 500）
				const html = renderPage({
					stats, assets, kind,
					root: mediaRootOf(config), dbPath: mediaDbPathOf(config),
					toolsRegistered, error,
				});
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
				res.end(html);
			} catch (e) {
				const message = String(e?.message ?? e);
				if (res.headersSent) {
					res.end(message);
				} else {
					res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(message);
				}
			}
		},
	})));
}
