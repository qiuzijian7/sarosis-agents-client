// @vssaros/dsh-media — host half：只读页面（`/x/media/`）+ 只读工具（media_list / media_stats）。
//
// 数据面在同目录的 `lib/store.js`（**只读**直连 VsSaros 主进程的 media.db —— 为什么"能直连"、
// 为什么"只读"，理由都写在那里）。本文件只管三件事：路由、页面渲染、工具定义。
//
// 页面形态照 `vssaros-codebase` / `vssaros-kanban` 的整页范式：静态 `inject = ['tools']`
// （别把 `webServer` / `connection` 写进去 —— 那会让插件在 headless / tui profile 里**永久
// pending**，连工具一起失效，kanban 实测过），页面路由走可选 `ctx.inject([...])` 动态挂。

import { escapeHtml, renderChips, renderShell } from './pageShell.js';
import { bindFoundation } from './foundationRef.js';
import { lastReadModeOf, listAssets, mediaDbPathOf, mediaRootOf, statsOf } from './store.js';


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

/**
 * 「打开媒体库」按钮的点击行为（2026-10-19；用户要求"媒体库统一成一个 editor pane"）。
 *
 * 退化链（逐级，最后一级一定"真能用"，不留死按钮 ✗）：
 *   ① 有页面桥 ⇒ `bridge.openMediaGallery()`：宿主在**编辑区**打开 VsSaros 原生媒体库
 *      （`MediaGalleryEditorPane`：缩略图网格 / 收藏 / 分组 / 标签 / 本地化 / 清理）—— 与工作流
 *      工具栏「🖼 媒体库」、IDE「媒体库」工作台是**同一个**页 ✓；
 *   ② 老宿主没这条命令（桥 < 15）⇒ 退回 `bridge.openModulePage(location.pathname)`：把本页
 *      （纯文本列表）放大到编辑区 —— 比"没反应"好，但**不是**同一份样式，属降级 ✓；
 *   ③ 桥在但两条都没有 ⇒ 整页跳转；
 *   ④ 完全没桥（纯浏览器打开这页）⇒ 新标签页打开。
 *
 * ⚠ 已经在**编辑区**表面（`?surface=editor`）里 ⇒ 把按钮摘掉：那里点它不会有任何变化（不是"点了没反应"的死链）✓。
 * ⚠ 桥对象变量名**必须**叫 `bridge`：`dshPageCommandWiring.test.ts` ③ 按 `bridge.<方法>(` 的**字面形态**
 *   采集本页的调用点，改名 = 这次接线落进守卫盲区 ✗。
 * ⚠ 本段是页面脚本的字符串（不是模板串）⇒ 里面别写反引号，也别写 `$` 花括号 ✓。
 */
const OPEN_PAGE_JS = '(function(){'
	+ "var btn=document.querySelector('[data-vssaros-media-open]');if(!btn){return;}"
	+ 'if(/(?:^|[?&])surface=editor(?:&|$)/.test(location.search)){btn.remove();return;}'
	+ "btn.addEventListener('click',function(ev){"
	+ 'if(ev&&ev.preventDefault){ev.preventDefault();}'
	+ "btn.classList.add('busy');btn.textContent='正在打开媒体库…';"
	+ 'var bridge=window.vssarosDsh;'
	+ "if(bridge&&typeof bridge.openMediaGallery==='function'){try{bridge.openMediaGallery();return;}catch(e){}}"
	+ "if(bridge&&typeof bridge.openModulePage==='function'){try{bridge.openModulePage(location.pathname);return;}catch(e){}}"
	+ 'if(bridge){location.href=location.pathname;return;}'
	+ "window.open(location.pathname,'_blank','noopener');"
	+ '});})();';

/** 媒体库专属样式（外壳之外的那点：统计行 + 资产条目）。 */
const MEDIA_CSS = `
/* ★ 2026-10-15（统一 sideview 风格 ✓）：与 codebase / 记忆库 **同一套 token** —— 同一份圆角(9px)/间距(8px)/
   卡底色(editor-background)/大数字字号(19px)/主题变量（--vscode-*）✓。统计 = **仪表盘卡**：3 张主卡 + 一行分类格 ✓；
   页顶另有**置顶主操作**（.dsh-actbar ✓）。
   ⚠ 本块是**模板字符串**内容 ⇒ 注释里**不能出现反引号** ✗（会直接把字符串截断 —— 2026-10-15 现场踩到 ✓）。 */
.dsh-actbar { display: flex; gap: 8px; align-items: center; padding: 6px 10px 0; }
.dsh-btn { display: inline-flex; align-items: center; gap: 6px; border-radius: 6px; padding: 5px 12px; text-decoration: none; font-weight: 600; font-size: 12px; font-family: inherit; cursor: pointer; }
.dsh-btn-primary { background: var(--vscode-button-background, var(--vscode-focusBorder, #007acc)); color: var(--vscode-button-foreground, #fff); border: 1px solid transparent; }
.dsh-btn-primary:hover { filter: brightness(1.08); }
/* 「打开媒体库」= 次要动作（2026-10-19）：描边按钮，不跟「刷新」抢主色。 */
.dsh-btn-secondary { background: transparent; color: var(--vscode-foreground, inherit); border: 1px solid var(--vscode-panel-border, rgba(128,128,128,.5)); }
.dsh-btn-secondary:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
.dsh-btn-secondary.busy { opacity: .6; cursor: default; }
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

function renderPage({ stats, assets, kind, root, dbPath, toolsRegistered, via, error }) {
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

	// ★ 2026-10-15："**按钮置顶**" ✓ —— 本页是**只读**的（同记忆库 ✓）⇒ 主操作是**刷新** ✓。
	//   放在**统计卡之前**（第一眼就是它 ✓）；用 `<a>` 而不是表单/脚本 ⇒ 刷新这一步保持零脚本 ✓。
	//   ⚠ 带 `?kind=` 时**保住当前筛选**（刷新不该把用户的筛选悄悄丢掉 ✗）。
	// ★ 2026-10-19（用户报「媒体库 sideview 缺少打开页面按钮」→ 后改为"统一成同一个编辑区页"）：
	//   置顶给一枚「打开媒体库」—— 侧栏只有三百来像素，**完整版是 VsSaros 原生媒体库页**
	//   （`MediaGalleryEditorPane`，与工作流工具栏「🖼 媒体库」同一个界面），页面自己开不了编辑器
	//   ⇒ 交宿主（桥 `openMediaGallery`；老宿主降级到 `openModulePage`）。
	//   ⚠ 桥对象名必须叫 bridge —— 接线守卫（`dshPageCommandWiring.test.ts` ③）按
	//     `bridge.<方法>(` 这个**字面形态**采集本页的调用点，改名 = 落进盲区（点了没反应也没人拦 ✗）。
	const refreshHref = kind ? `./?kind=${encodeURIComponent(kind)}` : './';
	const actionHtml = `<div class="dsh-actbar"><a class="dsh-btn dsh-btn-primary" href="${refreshHref}" title="重新读取媒体库（只读）" aria-label="刷新媒体库">⟳ 刷新</a><button type="button" class="dsh-btn dsh-btn-secondary" data-vssaros-media-open title="在编辑区打开媒体库（缩略图 / 收藏 / 分组 / 标签 / 清理）">↗ 打开媒体库</button></div>`;

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
	data-vssaros-media-via="${escapeHtml(via)}"
	data-vssaros-media-tools="${escapeHtml(toolsRegistered)}">库文件 <code>${escapeHtml(dbPath)}</code> · 读取 <code>${escapeHtml(via)}</code> · 工具 <code>${escapeHtml(toolsRegistered)}</code> · 列表 ${escapeHtml(String(assets.length))} 条${kind ? `（过滤 ${escapeHtml(kind)}）` : ''}</p>
${assets.length ? `<ul class="dsh-scroll">${rows}</ul>` : '<p class="dsh-empty">暂无媒体资产（工作流产出图片后会出现在这里）。</p>'}`;

	const script = "document.querySelectorAll('.dsh-chip').forEach(function(b){b.addEventListener('click',function(){var v=b.getAttribute('data-chip');location.search=(v&&v!=='all')?('?kind='+encodeURIComponent(v)):'';});});"
		+ OPEN_PAGE_JS;

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

/**
 * 本插件注册的工具定义（`apply` 里逐个 `ctx.tools.register`）。
 *
 * ⚠⚠ **数组里每一项都必须是完整的工具定义**（有 `name` + `output.schema` + `output.render`）——
 * 留一个**空壳 `{}`** 就会让 dsh 在装载 preset 时抛
 * `tool "undefined" must declare output { schema, render, presentationMeta? }`
 * ⇒ 整个 preset 失效（`agent-preset/invalid`）⇒ **用户连新建会话都做不了** ✗✗。
 * （2026-10-21 真机事故：`image_generate` 迁到 `@vssaros/dsh-imagegen` 时只删了定义体，
 *   忘了删对象壳 ⇒ 整个 dsh 插件组起不来。）
 * ⇒ 改这个数组时**只删整项**（`}, {` 一起），别留空壳；守卫见 `dsh-plugins/check-tool-definitions.mjs` ✓。
 *
 * 📌 `image_generate`（生图）已于 2026-10-21 迁到 `@vssaros/dsh-imagegen`（同名 ⇒ 技能文档与
 * agent 配置里的旧名字继续有效；且新家会把图真的显示在对话里）。
 * 迁走的两个原因：① IDE 侧没有实现 `capability:'media'`（`dshIdeCapabilities.ts` 里没这个 case）；
 * ② 它填的桥 `pluginId` 是**入口 id**（'vssaros-media'）而授权表按**包名**建
 * （`dshHarnessChannel._readIdeDeclarations`）⇒ 授权永远判「插件未安装或没有可读清单」。
 * 留在原地只有一个后果：模型看到 `image_generate` 就调它，然后拿到一句失败。
 */
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
	}, {
		// 重构 4（2026-10-16）：`video_generate`——视频生成。与 image_generate 同构（经桥回 IDE）。
		// 必填面与 legacy 一致：prompt 或 image_url 至少一个（图生图只要参考图 ✓）。
		name: 'video_generate',
		description: '生成视频：按提示词（或参考图）调 IDE 侧的视频模型（provider.generateVideo），返回视频 URL。模型选择优先级：调用参数 → agent 配置 → 第一个声明 supportsVideoGen 的 provider。',
		parameters: {
			type: 'object',
			properties: {
				prompt: { type: 'string', description: '视频内容描述（图生图时可省）' },
				image_url: { type: 'string', description: '首帧/参考图 URL（图生视频；与 prompt 至少一个）' },
				duration: { type: 'number', description: '时长秒（provider 就近取档）' },
				resolution: { type: 'string', description: '分辨率档（如 "768P" / "2K"，provider 定）' },
				ratio: { type: 'string', description: '画幅比（如 "16:9"）' },
				provider_id: { type: 'string', description: '显式指定 provider id（可选）' },
				model_id: { type: 'string', description: '显式指定模型 id（可选）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					videos: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? `生成了 ${value.videos?.length ?? 0} 个视频` : `生成失败：${value.error ?? '未知原因'}`,
			}],
		},
		execute: async (params) => {
			const prompt = String(params?.prompt ?? '').trim();
			const imageUrl = String(params?.image_url ?? '').trim();
			if (!prompt && !imageUrl) { throw new Error('prompt 或 image_url 至少一个（视频生成提示词 / 参考图）'); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('视频生成要经桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: 'vssaros-media',
				params: { op: 'generateVideo', ...params },
			}, { timeoutMs: 10 * 60 * 1000 });  // 视频生成更慢（与 legacy VIDEO_TIMEOUT_HINT_MS 同量级）
			return reply ?? { ok: false, error: 'IDE 没回（provider 没实现 generateVideo？）' };
		},
	}, {
		// 重构 4（2026-10-16）：`text_to_speech`——语音合成。与 image_generate 同构（经桥回 IDE）。
		name: 'text_to_speech',
		description: '语音合成：按文本调 IDE 侧的音频模型（provider.generateAudio），返回音频 URL。模型选择优先级：调用参数 → 第一个声明 supportsAudioGen 的 provider。',
		parameters: {
			type: 'object',
			properties: {
				text: { type: 'string', description: '要合成的文本（音乐 provider 是风格/情绪提示词）' },
				voice: { type: 'string', description: '音色 id（provider 定；省略 = 默认音色）' },
				speed: { type: 'number', description: '语速（1 = 正常；provider 范围不一）' },
				emotion: { type: 'string', description: '情绪提示（provider 定，如 happy/sad/angry）' },
				lyrics: { type: 'string', description: '歌词（音乐 provider；空 = 纯音乐）' },
				provider_id: { type: 'string', description: '显式指定 provider id（可选）' },
				model_id: { type: 'string', description: '显式指定模型 id（可选）' },
			},
			required: ['text'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					audios: { type: 'array', items: { type: 'object', properties: { url: { type: 'string' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? `合成了 ${value.audios?.length ?? 0} 段音频` : `合成失败：${value.error ?? '未知原因'}`,
			}],
		},
		execute: async (params) => {
			const text = String(params?.text ?? '').trim();
			if (!text) { throw new Error('text 必填（要合成的文本）'); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('语音合成要经桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: 'vssaros-media',
				params: { op: 'generateAudio', ...params },
			}, { timeoutMs: 10 * 60 * 1000 });  // 音频生成也可能慢（与 legacy 同量级）
			return reply ?? { ok: false, error: 'IDE 没回（provider 没实现 generateAudio？）' };
		},
	}, {
		// 重构 4（2026-10-16）：`vision_analyze`——视觉分析（"读图"，不是生成）。与生成三件套同构
		// （经桥回 IDE：视觉模型在壳侧 ✓）。**只读**（不生成、不写盘）⇒ 不挂审批闸（与 session_search
		// 同口径：只读 ⇒ 没有可拦的写入 ✓）。
		name: 'vision_analyze',
		description: '分析图片：按问题调 IDE 侧的视觉模型，返回对图片的文本回答。这是看图片的唯一途径（file_read 拒绝二进制）。image 可以是本地路径（相对工作区）、data URL、纯 base64、或 http(s) URL。mode：auto（默认，当前模型支持图就附带自己答，否则辅助视觉模型答）/ text（总是辅助模型答文本，省上下文）/ attach（强制附带，模型不支持图就报错）。',
		parameters: {
			type: 'object',
			properties: {
				image: { type: 'string', description: '本地路径 / data URL / 纯 base64 / http(s) URL' },
				query: { type: 'string', description: '关于图片的问题或指令（如"描述这张图"、"图中报错是什么"、"把表格转成 markdown"）' },
				mode: { type: 'string', enum: ['auto', 'text', 'attach'], description: 'auto（默认）/ text / attach' },
			},
			required: ['image', 'query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					answer: { type: 'string' },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? String(value.answer ?? '（没回答）') : `分析失败：${value.error ?? '未知原因'}`,
			}],
		},
		isConcurrencySafe: () => true,  // 只读 ✓
		execute: async (params) => {
			const image = String(params?.image ?? '').trim();
			const query = String(params?.query ?? '').trim();
			if (!image) { throw new Error('image 必填（本地路径 / data URL / base64 / http(s) URL）'); }
			if (!query) { throw new Error('query 必填（关于图片的问题）'); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('视觉分析要经桥回 IDE（视觉模型在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: 'vssaros-media',
				params: { op: 'visionAnalyze', ...params },
			}, { timeoutMs: 5 * 60 * 1000 });  // 视觉分析比生成快（5 分钟够了）
			return reply ?? { ok: false, error: 'IDE 没回（provider 没实现 visionAnalyze？）' };
		},
	}, {
		// 重构 4（2026-10-16）：`video_analyze`——视频分析（一次调用完成：抽帧 + 字幕/口播转写 +
		// 多模态模型给结论）。重活全在壳侧（ffmpeg / yt-dlp / whisper 随 VsSaros 自带，模型 provider
		// 在 IDE 进程）⇒ 定义在插件、执行经桥回 IDE（与 vision_analyze 同构 ✓）。**只读**（读视频，
		// 不写远端）⇒ 不挂审批闸（与 vision_analyze 同口径 ✓）。
		name: 'video_analyze',
		description: '分析一段视频并回答关于它的问题（一次调用完成：抽帧 + 字幕/口播转写 + 多模态模型给结论）。输入 http(s) 视频链接（抖音/小红书/B站/YouTube…）或本地视频文件路径。口播内容的正确来源是音轨（有字幕轨用字幕轨；没有就走本地 ASR whisper 转写）——不要手工下载 + 循环抽帧 + 逐张 vision_analyze（那条路没有 ASR，且慢数倍）。返回带时间点标记的分析文本 + 素材清单。',
		parameters: {
			type: 'object',
			properties: {
				video_url: { type: 'string', description: 'http(s) 视频链接，或本地视频文件路径' },
				query: { type: 'string', description: '要回答的问题（如"这游戏的战斗循环是怎么设计的"）' },
				frames: { type: 'number', description: '抽帧数量（默认 8，最多 24）' },
				startSec: { type: 'number', description: '从第几秒开始抽（默认 0）' },
				durationSec: { type: 'number', description: '采样跨度秒数（默认：整段）' },
				maxWidth: { type: 'number', description: '帧图最大宽度（默认 768；调小可降低请求体积）' },
				outDir: { type: 'string', description: '产物目录（帧图落盘处；默认 ~/.vssaros/tmp/video-analyze/<名字>-<时间戳>）' },
				keepVideo: { type: 'boolean', description: '保留下载的视频文件（默认 false：分析完即删）' },
				withTranscript: { type: 'boolean', description: '是否抓字幕（默认 true；仅远端链接有效）' },
			},
			required: ['video_url', 'query'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					answer: { type: 'string' },
					assets: { type: 'object', description: '素材清单（帧图路径与时间点、字幕/转写字数与来源）' },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? String(value.answer ?? '（没回答）') : `分析失败：${value.error ?? '未知原因'}`,
			}],
		},
		isConcurrencySafe: () => true,  // 只读 ✓
		execute: async (params) => {
			const videoUrl = String(params?.video_url ?? '').trim();
			const query = String(params?.query ?? '').trim();
			if (!videoUrl) { throw new Error('video_url 必填（http(s) 视频链接或本地视频文件路径）'); }
			if (!query) { throw new Error('query 必填（要问这段视频什么问题）'); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('视频分析要经桥回 IDE（ffmpeg/whisper/多模态模型都在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: 'vssaros-media',
				params: { op: 'videoAnalyze', ...params },
			}, { timeoutMs: 15 * 60 * 1000 });  // 抽帧 + ASR + 多模态，给足时间（比生成还慢 ✓）
			return reply ?? { ok: false, error: 'IDE 没回（provider 没实现 videoAnalyze？）' };
		},
	}, {
		// 重构 4（2026-10-16）：`extract_video_frames`——只抽帧（给帧图路径，不分析；要把帧当证据落进
		// 笔记、或针对单帧追问时用）。与 video_analyze 同构（经桥回 IDE ✓）。**只读** ✓。
		name: 'extract_video_frames',
		description: '从视频中抽帧：返回帧图路径清单（含时间点）。不写远端、不删用户文件。要"一次拿到理解"用 video_analyze（它内部调本工具的抽帧 + 多模态分析）；要把帧当证据落进笔记、或针对单帧追问细节，用本工具 + vision_analyze。',
		parameters: {
			type: 'object',
			properties: {
				source: { type: 'string', description: 'http(s) 视频链接，或本地视频文件路径' },
				frames: { type: 'number', description: '抽帧数量（默认 6，最多 24）' },
				startSec: { type: 'number', description: '从第几秒开始抽（默认 0）' },
				durationSec: { type: 'number', description: '采样跨度秒数（默认：整段）' },
				maxWidth: { type: 'number', description: '帧图最大宽度（默认 768）' },
				outDir: { type: 'string', description: '产物目录（默认 ~/.vssaros/tmp/video-frames/<名字>-<时间戳>）' },
				keepVideo: { type: 'boolean', description: '保留下载的视频文件（默认 false：抽完即删）' },
			},
			required: ['source'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					frames: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, timeSec: { type: 'number' } } } },
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok ? `抽了 ${value.frames?.length ?? 0} 帧` : `抽帧失败：${value.error ?? '未知原因'}`,
			}],
		},
		isConcurrencySafe: () => true,  // 只读 ✓
		execute: async (params) => {
			const source = String(params?.source ?? '').trim();
			if (!source) { throw new Error('source 必填（http(s) 视频链接或本地视频文件路径）'); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('抽帧要经桥回 IDE（ffmpeg 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）');
			}
			const reply = await bridge.callIDE('ide.request', {
				capability: 'media',
				pluginId: 'vssaros-media',
				params: { op: 'extractVideoFrames', ...params },
			}, { timeoutMs: 10 * 60 * 1000 });  // 抽帧（不含 ASR）比 video_analyze 快
			return reply ?? { ok: false, error: 'IDE 没回（provider 没实现 extractVideoFrames？）' };
		},
	}];
}

export function apply(ctx, config = {}) {
	// 重构 1.3：绑定 foundation 共享服务（dataRoot/dshHome/pageShell/lock 的真源）。
	{
		// 同步直读在前：有插件在 apply 的**同步段**就建 store（inject 回调是异步的，会来不及 ✗）。
		let ready = null;
		try { ready = ctx.get?.('vssarosFoundation') ?? ctx.vssarosFoundation ?? null; } catch { /* 探针的 Proxy 假 ctx 对未知属性抛错 ⇒ 当不存在 */ }
		if (ready) { bindFoundation(ready); }
		ctx.inject(['vssarosFoundation'], child => {
		let svc = null;
		try { svc = child.vssarosFoundation ?? null; } catch { /* 探针的假 ctx（Proxy）对未知属性抛错 ⇒ 当不存在 */ }
		if (svc) { bindFoundation(svc); }
	});
	}
	const state = { tools: null, bridge: null };

	// 桥（**可选**注入：vssarosBridge 不在 ⇒ image_generate 如实失败，只读工具照常 ✓）。
	// 与 kanban 同口径（它的注释记着这条教训：可选注入不阻塞激活 ✓）。
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge;
		return () => { state.bridge = null; };
	});

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
					toolsRegistered,
					// 读成功之后才取样：它由 store 在**实际打开**时记录（直连 / 私有快照）
					via: lastReadModeOf(),
					error,
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
