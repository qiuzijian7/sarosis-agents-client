// @vssaros/dsh-media — host half：只读页面（`/x/media/`）+ 只读工具（media_list / media_stats）。
//
// 数据面在同目录的 `lib/store.js`（**只读**直连 VsSaros 主进程的 media.db —— 为什么"能直连"、
// 为什么"只读"，理由都写在那里）。本文件只管三件事：路由、页面渲染、工具定义。
//
// 页面形态照 `vssaros-codebase` / `vssaros-kanban` 的整页范式：静态 `inject = ['tools']`
// （别把 `webServer` / `connection` 写进去 —— 那会让插件在 headless / tui profile 里**永久
// pending**，连工具一起失效，kanban 实测过），页面路由走可选 `ctx.inject([...])` 动态挂。

import { escapeHtml, renderChips, renderShell } from './pageShell.js';
// ★ 2026-10-24：dsh 侧媒体库**真源**（用户拍板 A：IDE 侧下线，全部搬 dsh）。
//   与 `store.js`（IDE media.db 的**只读镜像**）并存一段时间：迁移已完成、API 先接新库，
//   页面默认仍读旧镜像（`?source=dsh` 可看新库），等写入方全部改向后再切默认并下线 IDE 侧。
import { createOwnStore } from './ownStore.js';
// ★ 2026-10-24（P4）：**增量收编** IDE 侧 media.db 里新出现的资产（IDE 零改动的过渡通道，见该文件头）。
import { syncFromIdeDb } from './ideSync.js';
import { bindFoundation } from './foundationRef.js';
import { dataRootOf, lastReadModeOf, listAssets, mediaDbPathOf, mediaRootOf, statsOf } from './store.js';


export const name = 'vssaros-media';

/** 只依赖 tools：见文件头。 */
export const inject = ['tools'];

/** 页面前缀路由：不带尾斜杠（prefix 匹配 `p` 与 `p/<anything>`）。 */
const ROUTE_PREFIX = '/x/media';
/** 清单声明的整页路由（**精确匹配**）。 */
const PAGE_ROUTE = '/x/media/';
/** ★ 2026-10-24：媒体库 API 前缀（读写的都是 **dsh 侧真源** `media-store/`）。 */
const API_PREFIX = '/x/media/api/';
/** 本插件注册的工具名（页面自诊断用，探针据此断言）。 */
const TOOL_NAMES = ['media_list', 'media_stats'];
/** 页面默认列出的资产条数。 */
const PAGE_LIMIT = 30;
/** 支持的资产类型（与 VsSaros 侧 `MediaAsset.kind` 一致）。 */
const KINDS = ['image', 'video', 'audio', 'text'];

// ── LightAI 直连（2026-10-22）─────────────────────────────────────────────
//   `video_generate` / `text_to_speech` 原来经桥回 IDE 的 `media` 能力（op=generateVideo / generateAudio），
//   但 **IDE 侧根本没有实现这两个 op**（`dshIdeCapabilities.ts` 的 media 分支只有 generateImage / editImage /
//   capabilities）⇒ 这两个工具一直跑不通（探针 p3-107 只钉住"经桥回了"，没钉住"IDE 认这个 op"✗）。
//   现在接到 **dsh 侧**的 LightAI 生成服务（bridge 提供 `vssarosLightAI`：建任务 → 轮询 → 取产物，都在 Host 里）✓。
//   没指定 provider / model 时：LightAI 已登录就用它（IDE 侧那条路本来就不通 ⇒ 直连是唯一能用的路）；
//   显式指定了别的 provider / model ⇒ 仍走 IDE（尊重用户的显式选择，将来 IDE 补上这两个 op 也不用改这边）。

/** 指 LightAI 的 provider id（dsh 直连用 `lightai`；`lm:lightai` 是 IDE 侧那个注册名）。 */
const LIGHTAI_PROVIDER_IDS = new Set(['lightai', 'lm:lightai']);

/** dsh 侧 LightAI 是否可用（服务在 + 已登录）。读不到状态 ⇒ 当不可用。 */
async function lightaiReady(state) {
	const svc = state.lightai;
	if (!svc || typeof svc.status !== 'function') { return false; }
	try {
		return (await svc.status())?.signedIn === true;
	} catch {
		return false;
	}
}

/**
 * 这一次生成走哪条路（纯规则 + 一次状态读）。
 * @param {object} state 宿主状态
 * @param {{provider?: string, model?: string, kind: 'video'|'audio'}} target
 * @returns {Promise<'lightai'|'ide'>}
 */
async function pickMediaRoute(state, target) {
	const provider = String(target?.provider ?? '').trim();
	const model = String(target?.model ?? '').trim();
	if (provider) { return LIGHTAI_PROVIDER_IDS.has(provider) ? 'lightai' : 'ide'; }
	if (model) {
		if (target.kind === 'video' && /^video_/.test(model)) { return 'lightai'; }
		if (target.kind === 'audio' && (/^audio_/.test(model) || /^seed_audio_/.test(model))) { return 'lightai'; }
		return 'ide';
	}
	return (await lightaiReady(state)) ? 'lightai' : 'ide';
}

/** 默认路径（没指定 provider / model）且 LightAI 服务在、却没登录 ⇒ 如实说清"去登录"（IDE 侧这条路不通）。 */
function needLightAIDefault(state, target) {
	const provider = String(target?.provider ?? '').trim();
	const model = String(target?.model ?? '').trim();
	if (provider || model) { return false; }
	if (!state.lightai) { return false; }
	return 'IDE 侧目前没有可用的视频/音频 provider（`media` 能力只实现了生图 / 改图 / 能力表）'
		+ '——请在 设置 → 模型 → LightAI 登录后生成（也可显式指定 provider / model 走 IDE 侧）';
}

/** ★ 2026-10-24：dsh 侧真源（懒建 + 记住；建不起来就如实报，不让整页 500）。 */
let ownStoreCache = null;
let ownStoreError = '';
function ownStoreOf(config) {
	if (ownStoreCache) { return ownStoreCache; }
	try {
		ownStoreCache = createOwnStore({ dataRoot: dataRootOf(config) });
		ownStoreError = '';
	} catch (e) {
		ownStoreError = String(e?.message ?? e);
		throw e;
	}
	return ownStoreCache;
}

/** 增量收编的节流（页面每次刷新都会触发一次 ⇒ 至少间隔一分钟才真扫）。 */
const SYNC_MIN_INTERVAL_MS = 60_000;
let lastSyncAt = 0;

/**
 * 可能跑一次"收编 IDE 增量"。
 * @param {object} config 插件配置
 * @param {boolean} [force] 无视节流（API 显式调用用）
 * @returns {Promise<object|null>} 统计；被节流跳过 ⇒ null
 */
async function maybeSyncIde(config, force = false) {
	if (!force && Date.now() - lastSyncAt < SYNC_MIN_INTERVAL_MS) { return null; }
	lastSyncAt = Date.now();
	try {
		return await syncFromIdeDb({ config, store: ownStoreOf(config) });
	} catch (e) {
		// 收编失败不该影响页面/API（它是"锦上添花"的过渡通道）
		return { ok: false, error: String(e?.message ?? e), imported: 0, alreadyThere: 0, scanned: 0 };
	}
}

/** 写 JSON 响应（API 统一形状：成功带 `ok:true`，失败带 `ok:false` + `error`）。 */
function sendJson(res, status, payload) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(body);
}

/** 读请求体（JSON）。上限 64MB：一次导入一张大图够用，超了如实拒（不 OOM）。 */
async function readJsonBody(req, limit = 64 * 1024 * 1024) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) { throw new Error(`请求体太大（>${Math.round(limit / 1024 / 1024)}MB）`); }
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (!text.trim()) { return {}; }
	return JSON.parse(text);
}

/** 查询参数里的布尔/数字（页面与本机脚本都会用，口径统一）。 */
function boolParam(url, name) {
	const value = url.searchParams.get(name);
	return value === '1' || value === 'true' || value === 'yes';
}
function numberParam(url, name) {
	const raw = url.searchParams.get(name);
	if (raw === null || raw === '') { return undefined; }
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}

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

function renderPage({ stats, assets, kind, root, dbPath, toolsRegistered, via, error, sync }) {
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
	data-vssaros-media-sync="${escapeHtml(String(sync?.imported ?? ''))}"
	data-vssaros-media-tools="${escapeHtml(toolsRegistered)}">库文件 <code>${escapeHtml(dbPath)}</code> · 读取 <code>${escapeHtml(via)}</code>${sync ? ` · 本次收编 ${escapeHtml(String(sync.imported ?? 0))} 条（IDE 暂存区已有 ${escapeHtml(String(sync.alreadyThere ?? 0))} 条）` : ''} · 工具 <code>${escapeHtml(toolsRegistered)}</code> · 列表 ${escapeHtml(String(assets.length))} 条${kind ? `（过滤 ${escapeHtml(kind)}）` : ''}</p>
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
		description: [
			'生成视频：按提示词（或参考图）生成，返回视频 URL。',
			'默认走 LightAI（dsh 侧登录即可用，不需要 IDE）；也可显式指定 provider_id / model_id 走 IDE 侧的模型。',
			'参数：prompt（视频内容描述，图生视频时可省）、image_url（首帧/参考图 URL 或 data URL，与 prompt 至少一个）、',
			'duration（秒）、resolution（分辨率档，如 768P / 2K）、ratio（画幅比，如 16:9）、provider_id、model_id。',
		].join(''),
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
			const target = { provider: params?.provider_id, model: params?.model_id, kind: 'video' };
			const route = await pickMediaRoute(state, target);
			if (route === 'lightai') {
				const svc = state.lightai;
				if (!svc || typeof svc.generate !== 'function') {
					throw new Error('选中了 LightAI，但 dsh 侧 LightAI 生成服务不在（bridge 插件版本太旧，需 ≥ 0.2.38）');
				}
				const out = await svc.generate('video', {
					prompt,
					...(imageUrl ? { imageInput: imageUrl } : {}),
					...(params?.model_id ? { modelId: String(params.model_id) } : {}),
					...(Number.isFinite(Number(params?.duration)) ? { duration: Number(params.duration) } : {}),
					...(params?.resolution ? { resolution: String(params.resolution) } : {}),
					...(params?.ratio ? { ratio: String(params.ratio) } : {}),
				});
				const videos = Array.isArray(out?.videos) ? out.videos : [];
				if (videos.length === 0) { throw new Error('LightAI 视频生成完成但没返回视频 URL'); }
				return { ok: true, videos, model: out.modelId };
			}
			const hint = needLightAIDefault(state, target);
			if (hint) { throw new Error(hint); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('视频生成要经桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）——或在 设置 → 模型 → LightAI 登录，用 LightAI 生成视频');
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
		description: [
			'语音合成：把文本合成为语音，返回音频 URL。',
			'默认走 LightAI（dsh 侧登录即可用，不需要 IDE）；也可显式指定 provider_id / model_id 走 IDE 侧的音频模型。',
			'参数：text（要合成的文本，必填）、voice（音色 id）、speed（语速，1 = 正常）、emotion（情绪，如 happy / sad）、',
			'lyrics（歌词，给音乐类 provider；LightAI 暂无音乐模型，会忽略）、provider_id、model_id。',
		].join(''),
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
			const target = { provider: params?.provider_id, model: params?.model_id, kind: 'audio' };
			const route = await pickMediaRoute(state, target);
			if (route === 'lightai') {
				const svc = state.lightai;
				if (!svc || typeof svc.generate !== 'function') {
					throw new Error('选中了 LightAI，但 dsh 侧 LightAI 生成服务不在（bridge 插件版本太旧，需 ≥ 0.2.38）');
				}
				const out = await svc.generate('audio', {
					prompt: text,
					...(params?.model_id ? { modelId: String(params.model_id) } : {}),
					...(params?.voice ? { voiceId: String(params.voice) } : {}),
					...(Number.isFinite(Number(params?.speed)) ? { speed: Number(params.speed) } : {}),
					...(params?.emotion ? { emotion: String(params.emotion) } : {}),
				});
				const audios = Array.isArray(out?.audios) ? out.audios : [];
				if (audios.length === 0) { throw new Error('LightAI 语音合成完成但没返回音频 URL'); }
				return { ok: true, audios, model: out.modelId };
			}
			const hint = needLightAIDefault(state, target);
			if (hint) { throw new Error(hint); }
			const bridge = state.bridge;
			if (!bridge || typeof bridge.callIDE !== 'function') {
				throw new Error('语音合成要经桥回 IDE（模型 provider 在 IDE 进程），但 vssarosBridge 不在（bridge 插件没装/没连）——或在 设置 → 模型 → LightAI 登录，用 LightAI 合成语音');
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

/**
 * 媒体库 API（**dsh 侧真源** `{dataRoot}/media-store/`，2026-10-24）。
 *
 * 端点（都返回 JSON；失败 `{ok:false,error}` + 4xx/5xx）：
 *   GET  /x/media/api/list?kind&provider&source&query&favorite&board&tag&includeDeleted&limit&offset
 *   GET  /x/media/api/stats
 *   GET  /x/media/api/bytes/<id>                    ⇒ 原图字节（带 content-type）
 *   POST /x/media/api/import                        { base64, kind?, mime?, ext?, provider?, source?, prompt?, model?, metaJson?, originId?, favorite?, tags?, board? }
 *   POST /x/media/api/delete   { id }               ⇒ 软删（回收站语义）
 *   POST /x/media/api/restore  { id }
 *   POST /x/media/api/favorite { id, value? }       ⇒ value 缺省 = true
 *   POST /x/media/api/tags     { id, tags: string[] }
 *   POST /x/media/api/board    { id, board }
 *
 * ⚠ 为什么先只做 API 不切页面默认：页面还读 IDE 镜像（`store.js`）—— 并存期用于对账；
 *   等写入方（imagegen / ComfyUI 工作流）全部改向 dsh、IDE 侧下线时再切默认。
 */
async function handleMediaApi(config, { req, res, url }) {
	const method = String(req.method ?? 'GET').toUpperCase();
	const path = url.pathname.slice(API_PREFIX.length);
	const reply = (status, payload) => sendJson(res, status, payload);
	try {
		const store = ownStoreOf(config);
		if (path === 'list' && method === 'GET') {
			const result = store.list({
				kind: url.searchParams.get('kind') || undefined,
				provider: url.searchParams.get('provider') || undefined,
				source: url.searchParams.get('source') || undefined,
				query: url.searchParams.get('query') || undefined,
				board: url.searchParams.get('board') || undefined,
				tag: url.searchParams.get('tag') || undefined,
				favorite: boolParam(url, 'favorite') || undefined,
				includeDeleted: boolParam(url, 'includeDeleted'),
				limit: numberParam(url, 'limit'),
				offset: numberParam(url, 'offset'),
			});
			reply(200, { ok: true, ...result });
			return;
		}
		if (path === 'stats' && method === 'GET') {
			reply(200, { ok: true, stats: store.stats() });
			return;
		}
		// ★ 2026-10-24（P4）：把 IDE 侧 media.db 里**新出现**的资产收编进来（幂等，可随时调）。
		//   IDE 那条 `media.import` 暂时原样保留（当"暂存区"）；等 IDE 侧下线后这里是唯一入口。
		if (path === 'sync' && method === 'POST') {
			const stats = await maybeSyncIde(config, true);
			reply(200, { ok: stats?.ok !== false, sync: stats });
			return;
		}
		if (path.startsWith('bytes/') && method === 'GET') {
			const id = decodeURIComponent(path.slice('bytes/'.length));
			const asset = store.get(id);
			const bytes = store.readBytes(id);
			if (!asset || !bytes) { reply(404, { ok: false, error: '没有这张资产（或文件已不在）' }); return; }
			res.writeHead(200, {
				'content-type': asset.mime || 'application/octet-stream',
				'content-length': String(bytes.length),
				'cache-control': 'private, max-age=31536000, immutable',
			});
			res.end(bytes);
			return;
		}
		if (method === 'POST') {
			const body = await readJsonBody(req);
			const id = body.id ? String(body.id) : '';
			if (path === 'import') {
				const asset = store.importAsset({
					base64: body.base64,
					bytes: body.bytes,
					// ★ 2026-10-24：只给 `ref`（URL/相对名）也能入库 ⇒ **仅引用资产**（没字节，预览走 URL）
					ref: body.ref,
					kind: body.kind,
					mime: body.mime,
					ext: body.ext,
					provider: body.provider,
					source: body.source,
					prompt: body.prompt,
					model: body.model,
					metaJson: body.metaJson,
					originId: body.originId,
					createdAt: body.createdAt,
					fileName: body.fileName,
					width: body.width,
					height: body.height,
					board: body.board,
					tags: body.tags,
				});
				if (!asset) { reply(400, { ok: false, error: '没有内容（要 base64 或 bytes）' }); return; }
				if (body.favorite) { store.setFavorite(asset.id, true); }
				reply(200, { ok: true, asset: store.get(asset.id) });
				return;
			}
			if (!id) { reply(400, { ok: false, error: '要 body.id' }); return; }
			if (path === 'delete') {
				const asset = store.softDelete(id);
				if (!asset) { reply(404, { ok: false, error: '没有这张资产' }); return; }
				reply(200, { ok: true, asset });
				return;
			}
			if (path === 'restore') {
				reply(200, { ok: true, asset: store.restore(id) });
				return;
			}
			if (path === 'favorite') {
				reply(200, { ok: true, asset: store.setFavorite(id, body.value !== false) });
				return;
			}
			if (path === 'tags') {
				reply(200, { ok: true, asset: store.setTags(id, body.tags ?? []) });
				return;
			}
			if (path === 'board') {
				reply(200, { ok: true, asset: store.setBoard(id, body.board ?? '') });
				return;
			}
		}
		reply(404, { ok: false, error: `没有这个端点：${method} ${url.pathname}` });
	} catch (e) {
		reply(500, { ok: false, error: String(e?.message ?? e) });
	}
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
	const state = { tools: null, bridge: null, lightai: null };

	// ★ 2026-10-24（P4）：把**媒体库真源**作为 Host 服务提供出去 —— 与 `vssarosLightAI` 同口径。
	//   同 Host 的其它插件（`@vssaros/dsh-imagegen` 生图 / 将来的画布、工作流）**直接写这里**，
	//   不再绕 IDE 主进程（那条 `media` 能力的 `importAsset` 只是过渡通道，IDE 侧媒体库随后下线）。
	//   ⚠ 方法都**惰性**（每次取才建库）：本插件可能只是被加载、当次并不写盘。
	ctx.provide('vssarosMediaStore', {
		/** 入库一条（幂等：originId 已存在 ⇒ 返回已有那条）。 @returns {Promise<object|undefined>} */
		importAsset: async input => ownStoreOf(config).importAsset(input),
		list: async filter => ownStoreOf(config).list(filter ?? {}),
		get: async id => ownStoreOf(config).get(id),
		stats: async () => ownStoreOf(config).stats(),
		/** 真源根目录（排查"图到底存哪"用）。 */
		root: async () => ownStoreOf(config).root,
	});
	// 注：`ctx.provide` 在真 Host 一定存在（cordis 标准面）；探针的假 ctx 可能没有 ⇒
	//     上面那行不要改成可选调用（`?.` 会把"真 Host 没 provide"这种真故障静默掉）。


	// 桥（**可选**注入：vssarosBridge 不在 ⇒ image_generate 如实失败，只读工具照常 ✓）。
	// 与 kanban 同口径（它的注释记着这条教训：可选注入不阻塞激活 ✓）。
	ctx.inject(['vssarosBridge'], scope => {
		state.bridge = scope.vssarosBridge;
		return () => { state.bridge = null; };
	});

	// LightAI 生成服务（**可选**注入，2026-10-22）：bridge 插件 ≥ 0.2.38 提供 `vssarosLightAI`
	//   ⇒ video_generate / text_to_speech 直接在 Host 里建任务 / 轮询（IDE 侧那两个 op 本来就没实现 ✗）。
	//   不在 ⇒ 这两个工具照旧经桥回 IDE（将来 IDE 补上这两个 op 也不用改这边 ✓）。
	ctx.inject(['vssarosLightAI'], scope => {
		// ⚠ 有些宿主的 scope 是"读未知属性即抛"的 Proxy ⇒ 读属性要兜住（缺这个可选服务 = 走旧路，不是崩）✓
		let svc = null;
		try { svc = scope.vssarosLightAI ?? null; } catch { svc = null; }
		state.lightai = svc;
		return () => { state.lightai = null; };
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
				// ★ 2026-10-24：媒体库 API（读写真源 `media-store/`）。
				//   鉴权已在上面 `connection.requestRejection` 那层做过 ⇒ 这里不再重复判。
				if (url.pathname.startsWith(API_PREFIX)) {
					await handleMediaApi(config, { req, res, url });
					return;
				}
				if (url.pathname !== PAGE_ROUTE) {
					res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
					res.end(`不是本插件的页面路由：${url.pathname}`);
					return;
				}
				const requested = url.searchParams.get('kind') ?? '';
				const kind = KINDS.includes(requested) ? requested : '';
				const toolsRegistered = TOOL_NAMES.filter(tool => !!state.tools?.get(tool)).join(',') || '(未注册)';
				// 读失败不 500：把原因渲染进页面（"库还没建"/"node:sqlite 不可用"都是用户能自己处理的）
				// ★ 2026-10-24：**默认读 dsh 侧真源**（`media-store/`），与"IDE 侧下线"的口径一致。
				//   `?source=ide` 仍可看 IDE 镜像（`store.js`）—— 并存期对账 / 排查老数据用。
				const source = url.searchParams.get('source') === 'ide' ? 'ide' : 'dsh';
				let stats;
				let assets = [];
				let error;
				let root = mediaRootOf(config);
				let dbPath = mediaDbPathOf(config);
				let via = lastReadModeOf();
				let sync = null;
				try {
					if (source === 'dsh') {
						// ★ 打开新库时顺带**收编 IDE 增量**（节流 60s）：用户在 IDE 里跑完 ComfyUI 工作流后，
						//   刷新这一页就能看到新图（过渡期"IDE 零改动"的代价：不是实时推送）。
						sync = await maybeSyncIde(config);
						const own = ownStoreOf(config);
						const ownStats = own.stats();
						// 形状适配：页面吃 `{assetCount,totalBytes,deletedCount,byKind:{image:n}}`（IDE 镜像那套）
						stats = {
							assetCount: ownStats.live,
							totalBytes: ownStats.bytes,
							deletedCount: ownStats.total - ownStats.live,
							byKind: Object.fromEntries(ownStats.byKind.map(row => [String(row.kind), Number(row.n ?? 0)])),
						};
						assets = own.list({ kind: kind || undefined, limit: PAGE_LIMIT }).items
							// 页面老字段名兜底（自己库用 bytes/fileName）
							.map(asset => ({ ...asset, sizeBytes: asset.bytes, ref: asset.fileName ?? '' }));
						root = own.root;
						dbPath = own.dbPath;
						via = 'dsh';
					} else {
						stats = await statsOf(config);
						assets = await listAssets(config, { kind: kind || undefined, limit: PAGE_LIMIT });
					}
				} catch (e) {
					error = String(e?.message ?? e);
				}
				// 先渲染再 writeHead（渲染抛错还能干净回 500）
				const html = renderPage({
					stats, assets, kind, root, dbPath,
					toolsRegistered,
					sync,
					// 读成功之后才取样：它由 store 在**实际打开**时记录（直连 / 私有快照 / dsh）
					via,
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
