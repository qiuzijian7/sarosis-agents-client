// @vssaros/dsh-media — host half：只读页面（`/x/media/`）+ 只读工具（media_list / media_stats）。
//
// 数据面在同目录的 `lib/store.js`（**只读**直连 VsSaros 主进程的 media.db —— 为什么"能直连"、
// 为什么"只读"，理由都写在那里）。本文件只管三件事：路由、页面渲染、工具定义。
//
// 页面形态照 `vssaros-codebase` / `vssaros-kanban` 的整页范式：静态 `inject = ['tools']`
// （别把 `webServer` / `connection` 写进去 —— 那会让插件在 headless / tui profile 里**永久
// pending**，连工具一起失效，kanban 实测过），页面路由走可选 `ctx.inject([...])` 动态挂。

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { dirname } from 'node:path';
// ★ 2026-10-26（改版 A 案）：页面拆成三块 —— 渲染层 `mediaPage.js`（SSR）、客户端 `mediaApp.js`
//   （作为 `/x/media/app.js` 单独下发）、本文件（路由 + API + 工具）。拆开的理由见 mediaPage.js 头注释。
import { KIND_LABEL, renderMediaPage, toView } from './mediaPage.js';
// ★ 2026-10-24：dsh 侧媒体库**真源**（用户拍板 A：IDE 侧下线，全部搬 dsh）。
//   与 `store.js`（IDE media.db 的**只读镜像**）并存一段时间：迁移已完成、API 先接新库，
//   页面默认仍读旧镜像（`?source=dsh` 可看新库），等写入方全部改向后再切默认并下线 IDE 侧。
import { createOwnStore } from './ownStore.js';
// ★ 2026-10-24（P4）：**增量收编** IDE 侧 media.db 里新出现的资产（IDE 零改动的过渡通道，见该文件头）。
import { syncFromIdeDb } from './ideSync.js';
import { bindFoundation } from './foundationRef.js';
import { dataRootOf, lastReadModeOf, listAssets, mediaDbPathOf, mediaRootOf, statsOf } from './store.js';
import { ensureMediaAgent } from './mediaAgent.js';


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
const TOOL_NAMES = ['media_list', 'media_stats', 'media_context', 'media_export', 'media_autotag', 'media_tag_merge', 'media_board_plan'];

/**
 * **页面当前上下文**（2026-10-27「助手 ⇄ UI 交互」的页面→助手 方向）。
 *
 * 用户说"就按我页面上现在这样整理"时，agent 光看库不知道"现在这样"是什么（左栏哪一格、什么筛选、
 * 选中了哪几张）⇒ 页面点「AI 助手」时把这台状态 POST 上来，agent 用 `media_context` 读回。
 * ⚠ 只存在内存里（一个 Host 一份）：它是"人正在看什么"的瞬时快照，重启后自然失效。
 */
let pageContext = null;
/** 页面首屏列出的资产条数（600+ 条别一次拉完；底部「加载更多」按这个步长翻页）。 */
const PAGE_LIMIT = 60;
/** 缩略图缓存宽度（`media-store/thumbs/<sha8>.webp` 都是这个宽度；`?w=` 只作契约声明）。 */
const THUMB_WIDTH = 256;
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

/**
 * 「IDE 侧没实现这个 op」的统一出口（2026-10-26 审计）。
 *
 * 事实：`dshIdeCapabilities.ts` 的 `media` 分支只认 `generateImage` / `editImage` / `capabilities`，
 * 其它 op 一律抛「media 的 op 不认识」。而本插件的视频生成 / 语音合成 / 视觉分析 / 视频分析 / 抽帧
 * 以前都是「显式选了非 LightAI 就回退 IDE」⇒ **那条回退 100% 必失败**，用户还会收到一句
 * "IDE 没回（provider 没实现 xxx？）"的模糊话。
 * ⇒ 改成在**发桥之前**就说清为什么 + 给出路（去登录 LightAI / 显式指定 LightAI 模型）。
 * ⚠ 哪天 IDE 侧补了这些 op，把各工具里那句 `throw ideMissingOp(...)` 换回 `bridge.callIDE` 即可
 *   （调用形状留在各处的注释里）。
 */
function ideMissingOp(what) {
	return new Error(`${what}目前只能用 dsh 侧直连的 LightAI：IDE 的 media 能力只实现了「生图 / 按参考图改图 / 能力表」，`
		+ '没有这个能力对应的 op（dshIdeCapabilities.ts 会回「media 的 op 不认识」）。'
		+ '⇒ 去 设置 → 模型 → LightAI 登录，再让它走默认路由；或调用时显式指定 LightAI 的 provider_id / model_id。');
}

/** 产物下载上限（视频可能很大）：超过就**不入库**，只把 URL 回给会话。 */
const IMPORT_MAX_BYTES = 512 * 1024 * 1024;
const IMPORT_TIMEOUT_MS = 3 * 60 * 1000;

/** content-type → { mime, ext }（认不出来的按 kind 兜底）。 */
function mimeInfoOf(contentType, kind, urlStr) {
	const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
	const byType = {
		'video/mp4': ['video/mp4', 'mp4'], 'video/webm': ['video/webm', 'webm'], 'video/quicktime': ['video/quicktime', 'mov'],
		'audio/mpeg': ['audio/mpeg', 'mp3'], 'audio/mp3': ['audio/mpeg', 'mp3'], 'audio/wav': ['audio/wav', 'wav'],
		'audio/x-wav': ['audio/wav', 'wav'], 'audio/mp4': ['audio/mp4', 'm4a'], 'audio/ogg': ['audio/ogg', 'ogg'],
		'audio/flac': ['audio/flac', 'flac'],
	};
	if (byType[type]) { return { mime: byType[type][0], ext: byType[type][1] }; }
	// URL 后缀兜底（CDN 常回 application/octet-stream）
	const fromUrl = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(urlStr ?? ''));
	const ext = fromUrl ? fromUrl[1].toLowerCase() : (kind === 'video' ? 'mp4' : 'mp3');
	return { mime: type && type !== 'application/octet-stream' ? type : (kind === 'video' ? 'video/mp4' : 'audio/mpeg'), ext };
}

/**
 * **把 LightAI 的产物 URL 下载成字节 → 入库**（2026-10-27，补上"生成时自动归档"漏的一段）。
 *
 * 背景：`video_generate` / `text_to_speech` 原来只把 `{url}` 回给会话 —— 既不进库也不归档，
 * 而 imagegen 的生图是直接 `importAsset({bytes})` 的 ⇒ 库里永远只有图、没有视频/音频。
 * 入库后**自动归档**（`ownStore.importAsset` 尾钩）也跟着生效。
 *
 * ⚠ 三条不变量（与生图入库同口径）：
 *   · **绝不抛**：CDN 需要鉴权 / 超时 / 文件过大 ⇒ 只记 warning，工具照常返回 URL；
 *   · 只有 `http(s)` 的产物 URL 才试（`data:` / 本地路径不走这条路）；
 *   · `ref` 记原始 URL ⇒ 即使字节没下下来，库里也能看到产物地址。
 *
 * @returns {Promise<{id: string, archivePath?: string}|undefined>}
 */
async function importExternalOutput(store, { kind, url, prompt, model, posterUrl }) {
	if (!store || typeof store.importAsset !== 'function') { return undefined; }
	const target = String(url ?? '');
	if (!/^https?:\/\//i.test(target)) { return undefined; }
	const timer = new AbortController();
	const timeout = setTimeout(() => timer.abort(), IMPORT_TIMEOUT_MS);
	try {
		const res = await fetch(target, { signal: timer.signal, redirect: 'follow' });
		if (!res.ok) {
			console.warn(`[vssaros-media] 产物没下下来（HTTP ${res.status}），只留 URL：${target.slice(0, 120)}`);
			return undefined;
		}
		const declared = Number(res.headers.get('content-length') ?? 0);
		if (declared > IMPORT_MAX_BYTES) {
			console.warn(`[vssaros-media] 产物 ${Math.round(declared / 1048576)}MB 超过入库上限，只留 URL：${target.slice(0, 120)}`);
			return undefined;
		}
		const bytes = Buffer.from(await res.arrayBuffer());
		if (!bytes.length) { return undefined; }
		if (bytes.length > IMPORT_MAX_BYTES) {
			console.warn('[vssaros-media] 产物超过入库上限（无 content-length），只留 URL');
			return undefined;
		}
		const { mime, ext } = mimeInfoOf(res.headers.get('content-type'), kind, target);
		// 可读文件名：归档目录是**给人看的**，别落成 `asset-xxxx.mp4`（exportNameOf 会用它当 slug）
		const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
		const label = kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '素材';
		const asset = await store.importAsset({
			bytes,
			kind,
			mime,
			ext,
			fileName: `${label}-${String(model ?? '') || 'lightai'}-${stamp}.${ext}`,
			provider: 'lightai',
			source: 'lightai',
			ref: target,
			prompt: String(prompt ?? '').slice(0, 2000),
			model: String(model ?? ''),
			metaJson: JSON.stringify({ lightaiUrl: target, ...(posterUrl ? { posterUrl } : {}) }),
		});
		return asset?.id ? { id: asset.id, archivePath: asset.archivePath } : undefined;
	} catch (err) {
		// 取消 / 超时 / 网络错误：记一句就够，绝不影响生成结果
		console.warn(`[vssaros-media] 产物入库失败（只留 URL）：${String(err?.message ?? err)}`);
		return undefined;
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * 批量入库 LightAI 产物（一次最多 4 条：一批视频已很少，多了纯下载耗时）。
 * @returns {Promise<Array<{id: string, archivePath?: string}>>} 入库成功的那些（失败的不占位）
 */
async function importOutputs(store, kind, list, prompt, model) {
	const out = [];
	for (const item of (Array.isArray(list) ? list : []).slice(0, 4)) {
		const one = await importExternalOutput(store, {
			kind,
			url: item?.url,
			posterUrl: item?.coverUrl ?? item?.posterUrl,
			prompt,
			model,
		});
		if (one) { out.push(one); }
	}
	return out;
}

/** ★ 2026-10-24：dsh 侧真源（懒建 + 记住；建不起来就如实报，不让整页 500）。 */
let ownStoreCache = null;
let ownStoreError = '';
function ownStoreOf(config) {
	if (ownStoreCache) { return ownStoreCache; }
	try {
		ownStoreCache = createOwnStore({
			dataRoot: dataRootOf(config),
			// 自动归档：`config.archiveDir`（缺省 = `<数据根>/media-store/archive`，同卷硬链接不占空间；
			// 传空串关掉）。`archiveLayout` 决定分层（provider/kind/date/flat）。
			archiveDir: config?.archiveDir,
			archiveLayout: config?.archiveLayout,
		});
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

/**
 * 读**裸字节**请求体（缩略图上传用；JSON 那套 `readJsonBody` 会把二进制当文本解坏）。
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit 上限（超了抛错，不 OOM）
 */
async function readRawBody(req, limit) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > limit) { throw new Error(`请求体太大（>${Math.round(limit / 1024 / 1024)}MB）`); }
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
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
					// ★ 2026-10-27：产物入库结果（有就说明已进媒体库 + 已归档；没有说明只留了 URL）
					media: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, archivePath: { type: 'string' } },
						},
					},
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `生成了 ${value.videos?.length ?? 0} 个视频`
						+ (value.media?.length ? `（已入库 ${value.media.length} 条并归档）` : '（产物没下下来，只留了 URL）')
					: `生成失败：${value.error ?? '未知原因'}`,
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
				// ★ 2026-10-27：产物**下载入库**（入库即自动归档）—— 以前只回 URL，库里有图没视频。
				//   best-effort：下不来就只留 URL（见 importExternalOutput 的三条不变量）。
				const media = await importOutputs(ownStoreOf(config), 'video', videos, prompt, out.modelId);
				return { ok: true, videos, model: out.modelId, ...(media.length ? { media } : {}) };
			}
			const hint = needLightAIDefault(state, target);
			if (hint) { throw new Error(hint); }
			// ★ 2026-10-26：IDE 侧没有 `generateVideo` 这个 op ⇒ 不再发注定被拒的桥请求（见 `ideMissingOp`）。
			//   IDE 补上之后换回：
			//   bridge.callIDE('ide.request', { capability: 'media', pluginId: 'vssaros-media',
			//     params: { op: 'generateVideo', ...params } }, { timeoutMs: 10 * 60 * 1000 })
			throw ideMissingOp('视频生成');
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
					media: {
						type: 'array',
						items: {
							type: 'object',
							properties: { id: { type: 'string' }, archivePath: { type: 'string' } },
						},
					},
					error: { type: 'string' },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok
					? `合成了 ${value.audios?.length ?? 0} 段音频`
						+ (value.media?.length ? `（已入库 ${value.media.length} 条并归档）` : '（产物没下下来，只留了 URL）')
					: `合成失败：${value.error ?? '未知原因'}`,
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
				// ★ 2026-10-27：同视频 —— 下载入库（音频很小，这条几乎总能成功）
				const media = await importOutputs(ownStoreOf(config), 'audio', audios, text, out.modelId);
				return { ok: true, audios, model: out.modelId, ...(media.length ? { media } : {}) };
			}
			const hint = needLightAIDefault(state, target);
			if (hint) { throw new Error(hint); }
			// ★ 2026-10-26：IDE 侧没有 `generateAudio` 这个 op（见 `ideMissingOp`）。IDE 补上后换回
			//   bridge.callIDE('ide.request', { capability: 'media', params: { op: 'generateAudio', ...params } }, …)。
			throw ideMissingOp('语音合成');
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
			// ★ 2026-10-26：IDE 侧没有 `visionAnalyze` 这个 op（见 `ideMissingOp`）。IDE 补上后换回
			//   bridge.callIDE('ide.request', { capability: 'media', params: { op: 'visionAnalyze', ...params } }, …)。
			throw ideMissingOp('视觉分析（读图）');
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
			// ★ 2026-10-26：IDE 侧没有 `videoAnalyze` 这个 op（见 `ideMissingOp`）。IDE 补上后换回
			//   bridge.callIDE('ide.request', { capability: 'media', params: { op: 'videoAnalyze', ...params } }, …)。
			throw ideMissingOp('视频分析（抽帧 + 转写 + 多模态）');
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
			// ★ 2026-10-26：IDE 侧没有 `extractVideoFrames` 这个 op（见 `ideMissingOp`）。IDE 补上后换回
			//   bridge.callIDE('ide.request', { capability: 'media', params: { op: 'extractVideoFrames', ...params } }, …)。
			throw ideMissingOp('视频抽帧');
		},
	}, {
		// ★ 2026-10-27（助手 ⇄ UI 交互）：**用户此刻在页面里看什么**。
		//   页面点「AI 助手」时会把当前状态（左栏哪一格 / 筛选 / 选中项 / 总数）交上来，
		//   这里读回来 ⇒ 用户说"就按现在这样整理"时不用再问一遍范围。
		name: 'media_context',
		description: [
			'读用户**当前在媒体库页面里的状态**：左栏在哪一格（全部/收藏/未分类/未标签/回收站/某分组/某标签）、',
			'激活的筛选（kind / provider / query / favorite …）、选中了哪些资产（id 与文件名）、当前命中总数。',
			'⚠ 这是"人正在看什么"的瞬时快照，可能为空（用户没从页面点过助手）⇒ 空就按普通流程问范围，别猜。',
			'用户提到"这些 / 现在这些 / 我选中的 / 当前筛选"时**先调它**，再决定用哪些参数去 media_list 取数据。',
		].join(''),
		parameters: { type: 'object', properties: {} },
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					empty: { type: 'boolean' },
					context: {
						type: 'object',
						properties: {
							nav: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string' },
							provider: { type: 'string' }, board: { type: 'string' }, tag: { type: 'string' },
							query: { type: 'string' }, favorite: { type: 'boolean' }, untagged: { type: 'boolean' },
							unclassified: { type: 'boolean' }, deleted: { type: 'boolean' },
							selected: { type: 'array', items: { type: 'string' } },
							total: { type: 'integer' }, at: { type: 'integer' },
						},
					},
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.empty
					? '用户还没有从媒体库页面点过「AI 助手」⇒ 没有页面上文，按普通流程问范围。'
					: `用户正在看：${value.context?.label ?? value.context?.nav ?? '(未知)'}`
						+ `（命中 ${value.context?.total ?? 0} 条）`
						+ (value.context?.query ? ` · 搜索「${value.context.query}」` : '')
						+ (value.context?.selected?.length ? ` · 选中 ${value.context.selected.length} 条` : ''),
			}],
		},
		isConcurrencySafe: () => true,   // 只读
		execute: async () => ({ ok: true, empty: !pageContext, context: pageContext ?? undefined }),
	}, {
		// ★ 2026-10-27（用户要求）：让「媒体库管家」能说"把这批导到 D:\交付\0715"。
		//   导出的是**副本**（可读文件名 + 按来源/月份分层），库仍以内容寻址的 objects/ 为真源；
		//   同卷走硬链接不占空间、同名跳过 ⇒ **幂等**，所以重跑就是重试。
		name: 'media_export',
		description: [
			'把媒体库里的素材导出成**可读文件名**的独立文件到指定文件夹（副本，不影响库）。',
			'目录结构：`<dir>/<provider|kind|月份>/<yyyy-MM>/<可读名>-<sha8前6>.<ext>`（layout 可选 provider/kind/date/flat）。',
			'范围：给了 ids 就只导这些；否则按 filter（kind/provider/board/tag/query/favorite/untagged/unclassified/deleted）；',
			'两者都不给 = 整个库。⚠ 导出是**幂等**的（同名跳过），所以先 dryRun=true 报数、再真跑；',
			'返回 exported/linked/copied/bytes 与 skipped（noFile=仅外链没字节、missing=文件被移走、exists=已存在）。',
			'同卷用硬链接（bytes=0，不占空间），异盘才复制（bytes>0）。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				dir: { type: 'string', description: '目标文件夹**绝对路径**（必填，如 D:/交付/0715）' },
				ids: { type: 'array', items: { type: 'string' }, description: '只导这些资产 id' },
				filter: {
					type: 'object',
					description: '按筛选导出（与 media_list 的参数同名）',
					properties: {
						kind: { type: 'string' }, provider: { type: 'string' }, board: { type: 'string' },
						tag: { type: 'string' }, query: { type: 'string' },
						favorite: { type: 'boolean' }, untagged: { type: 'boolean' },
						unclassified: { type: 'boolean' }, deleted: { type: 'boolean' },
					},
				},
				layout: { type: 'string', enum: ['provider', 'kind', 'date', 'flat'], description: '分层方式（默认 provider）' },
				overwrite: { type: 'boolean', description: '同名覆盖（默认 false = 跳过）' },
				dryRun: { type: 'boolean', description: 'true = 只报数不落盘' },
				limit: { type: 'number', description: '最多导出多少条（默认 2000，上限 5000）' },
			},
			required: ['dir'],
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' },
					dryRun: { type: 'boolean' },
					dir: { type: 'string' },
					exported: { type: 'integer' },
					linked: { type: 'integer' },
					copied: { type: 'integer' },
					bytes: { type: 'integer' },
					skipped: {
						type: 'object',
						properties: {
							noFile: { type: 'integer' }, missing: { type: 'integer' },
							exists: { type: 'integer' }, truncated: { type: 'integer' },
						},
					},
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: (value.dryRun ? '【预演·未落盘】' : '') + `导出 ${value.exported ?? 0} 条到 ${value.dir}`
					+ `（硬链接 ${value.linked ?? 0} / 复制 ${value.copied ?? 0}${value.bytes ? '，占用 ' + value.bytes + ' 字节' : ''}）`
					+ (value.skipped?.exists ? ` · 已存在 ${value.skipped.exists}` : '')
					+ (value.skipped?.noFile ? ` · 仅外链 ${value.skipped.noFile}` : '')
					+ (value.skipped?.missing ? ` · 文件不在 ${value.skipped.missing}` : ''),
			}],
		},
		execute: async (params) => {
			const result = ownStoreOf(config).exportAssets({
				dir: params?.dir, ids: params?.ids, filter: params?.filter, layout: params?.layout,
				overwrite: params?.overwrite === true, dryRun: params?.dryRun === true, limit: params?.limit,
			});
			if (result.ok === false) { throw new Error(result.error ?? '导出失败'); }
			return result;
		},
	}, {
		// ★ 2026-10-26（用户要求：「媒体库管家」要能自动打标 / 整理标签 / 整理目录）：
		//   三件事都不需要"看图"，所以放在 Host 侧做成**确定性规则**（可复核、可 dryRun）。
		//   ⚠ 语义标签（角色/风格/场景）需要视觉能力，当前 dsh 侧没有（Host 无编码器、无视觉模型）
		//     ⇒ 这里明确写进工具描述，别让 agent 以为能"看图打标"。
		name: 'media_autotag',
		description: [
			'给媒体库里的资产**按元数据规则**自动补标签（只追加，不覆盖已有标签）。',
			'规则：orientation（横图/竖图/方图）、size（大图/小图）、keyword（从 prompt 与文件名抽词）、',
			'month（YYYY-MM）、provider（来源:xxx）；默认 orientation+size+keyword。',
			'⚠ 这是"按元数据"，**不是"看图"**：当前没有视觉模型，打不出角色/风格/场景这类语义标签。',
			'先 dryRun 看 changes 再真跑（dryRun=true 只算不写）。一次最多 500 条。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				ids: { type: 'array', items: { type: 'string' }, description: '只处理这些资产 id（省略 = 全库未删的）' },
				rules: { type: 'array', items: { type: 'string' }, description: '要应用的规则名（默认 orientation/size/keyword）' },
				limit: { type: 'number', description: '最多处理多少条（默认 200，上限 500）' },
				dryRun: { type: 'boolean', description: 'true = 只算不写（默认 false）' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, dryRun: { type: 'boolean' },
					scanned: { type: 'integer' }, tagged: { type: 'integer' },
					changes: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, add: { type: 'array', items: { type: 'string' } } } } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: (value.dryRun ? '【预演】' : '') + `扫了 ${value.scanned} 条，给 ${value.tagged} 条加了标签`
					+ (value.changes?.length ? '\n' + value.changes.slice(0, 8).map(c => `· ${c.name} → ${c.add.join(' / ')}`).join('\n') : ''),
			}],
		},
		execute: async (params) => {
			const result = ownStoreOf(config).autoTag({
				ids: params?.ids, rules: params?.rules, limit: params?.limit, dryRun: params?.dryRun === true,
			});
			return { ok: true, ...result };
		},
	}, {
		name: 'media_tag_merge',
		description: [
			'整理标签：把"同义/大小写/多余空白"的写法合并成一个（`Cat` / `cat` / ` cat ` → 一个）。',
			'返回 mapping（旧写法 → 保留写法）与受影响条数。先 dryRun=true 看 mapping 再真跑。',
		].join(''),
		parameters: {
			type: 'object',
			properties: { dryRun: { type: 'boolean', description: 'true = 只出 mapping 不写（默认 false）' } },
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, dryRun: { type: 'boolean' },
					mergedTags: { type: 'integer' }, affected: { type: 'integer' },
					// ⚠ `additionalProperties` 在 dsh 的受限 JSON Schema 子集里**只能是布尔**。
					//   写成 `{ type:'string' }`（对象 schema）会抛
					//   `unsupported JSON schema: schema.properties.mapping.additionalProperties must be a boolean`
					//   ⇒ **整个插件不挂载**（工具没有、页面路由也没有 ⇒ 媒体库白屏，且没有任何报错）。
					//   先例：`vssaros-workflow/lib/index.js` 里那段注释写的就是这个坑。
					//   `dsh-plugins/check-tool-definitions.mjs` 现在会盯这条（写错就红）。
					mapping: { type: 'object', additionalProperties: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: (value.dryRun ? '【预演】' : '') + `合并 ${value.mergedTags} 个写法，影响 ${value.affected} 条`
					+ (value.mergedTags ? '\n' + Object.entries(value.mapping ?? {}).slice(0, 10).map(([from, to]) => `· ${from} → ${to}`).join('\n') : '（没有需要合并的）'),
			}],
		},
		execute: async (params) => ({ ok: true, ...ownStoreOf(config).mergeTags({ dryRun: params?.dryRun === true }) }),
	}, {
		name: 'media_board_plan',
		description: [
			'整理**目录（分组）**：给还没分组的资产按规则归到一个 board。mode：provider（按来源）/ kind（图片视频…）/',
			'date（YYYY-MM）/ tag（用第一个标签）。默认 **dryRun=true**（只出方案）；真跑要显式 dryRun=false。',
			'默认**不动**已经有分组的资产（overwrite=true 才覆盖）。',
		].join(''),
		parameters: {
			type: 'object',
			properties: {
				mode: { type: 'string', enum: ['provider', 'kind', 'date', 'tag'], description: '归类依据（默认 provider）' },
				prefix: { type: 'string', description: '分组名前缀（如 "归档-"）' },
				overwrite: { type: 'boolean', description: '已有分组的也覆盖（默认 false）' },
				limit: { type: 'number', description: '最多移动多少条（默认 500）' },
				dryRun: { type: 'boolean', description: '默认 true = 只出方案；真跑传 false' },
			},
		},
		output: {
			schema: {
				type: 'object',
				properties: {
					ok: { type: 'boolean' }, dryRun: { type: 'boolean' }, mode: { type: 'string' },
					moved: { type: 'integer' }, skipped: { type: 'integer' },
					boards: { type: 'array', items: { type: 'object', properties: { board: { type: 'string' }, n: { type: 'integer' } } } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: (value.dryRun ? '【预演·未落库】' : '') + `按 ${value.mode} 归类：移动 ${value.moved} 条，跳过 ${value.skipped} 条\n`
					+ (value.boards ?? []).slice(0, 10).map(b => `· ${b.board}（${b.n}）`).join('\n'),
			}],
		},
		execute: async (params) => ({
			ok: true,
			...ownStoreOf(config).planBoards({
				mode: params?.mode, prefix: params?.prefix, overwrite: params?.overwrite === true,
				limit: params?.limit, dryRun: params?.dryRun !== false,
			}),
		}),
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
async function handleMediaApi(config, { req, res, url, authenticatedUrl }) {
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
				// ★ 2026-10-26（改版 A 案左栏）：Eagle 的两个默认导航 + 只看回收站。
				untagged: boolParam(url, 'untagged') || undefined,
				unclassified: boolParam(url, 'unclassified') || undefined,
				onlyDeleted: boolParam(url, 'deleted') || undefined,
				includeDeleted: boolParam(url, 'includeDeleted'),
				limit: numberParam(url, 'limit'),
				offset: numberParam(url, 'offset'),
			});
			// `hasThumb` 是**页面才关心**的派生字段（工具输出不需要）⇒ 在这里补，不污染 store 的资产形状。
			const items = result.items.map(asset => ({ ...asset, hasThumb: store.hasThumbOf(asset.sha8) }));
			reply(200, { ok: true, items, total: result.total });
			return;
		}
		if (path === 'stats' && method === 'GET') {
			reply(200, { ok: true, stats: store.stats() });
			return;
		}
		// ★ 2026-10-26（页面「↗ 外开」）：外开是**另一个浏览器**，没有当前这份 Cookie；
		//   `?token=` 只在"还没有有效 Cookie"时用、认证完就被消费掉 ⇒ 必须由服务端现签一条带 token 的深链。
		//   口径与 `vssaros-workbenches` 的 `/link` 完全一致（`connection.authenticatedUrl`）。
		if (path === 'link' && method === 'GET') {
			// ⚠ origin 必须带端口：`new URL(req.url, 'http://127.0.0.1')` 的 host 里**没有端口**
			//   （Host 每实例随机端口在 `Host` 头上）⇒ 用头拼，否则签出来的链接指向 80 端口。
			const hostHeader = String(req.headers?.host ?? '').trim();
			const origin = hostHeader ? `http://${hostHeader}` : `${url.protocol}//${url.host}`;
			let target = '';
			try {
				target = typeof authenticatedUrl === 'function' ? String(authenticatedUrl(origin + PAGE_ROUTE)) : '';
			} catch { target = ''; }
			if (!target) { reply(501, { ok: false, error: '这台 Host 没有 authenticatedUrl（宿主太旧），无法签外开链接' }); return; }
			reply(200, { ok: true, url: target });
			return;
		}
		// ★ 2026-10-26（改版 A 案）：左栏聚合（分组 / 标签 / 来源 / 类型计数 + 未分类 / 未标签 / 收藏 / 回收站）。
		if (path === 'facets' && method === 'GET') {
			reply(200, { ok: true, facets: store.facets() });
			return;
		}
		// ★ 2026-10-27（助手 ⇄ UI 交互，方向一）：**变更版本号**。页面每 2.5s 比一次，
		//   变了就自己重载 ⇒ agent 用 `media_autotag` / `media_board_plan` 改完，打开着的页面会自动跟上。
		//   `total_changes()` 覆盖**同连接的所有写**（工具调用也走它），不需要每处埋计数。
		if (path === 'rev' && method === 'GET') {
			reply(200, { ok: true, rev: store.revision(), at: pageContext?.at ?? 0 });
			return;
		}
		// ★ 2026-10-27（方向二）：页面把"人正在看什么"交上来（左栏哪一格/筛选/选中项），agent 用 `media_context` 读。
		if (path === 'context') {
			if (method === 'POST') {
				const body = await readJsonBody(req);
				const ids = Array.isArray(body.selected) ? body.selected.map(String).filter(Boolean).slice(0, 50) : [];
				pageContext = {
					nav: String(body.nav ?? '').slice(0, 40),
					label: String(body.label ?? '').slice(0, 60),
					kind: String(body.kind ?? '').slice(0, 16),
					provider: String(body.provider ?? '').slice(0, 40),
					board: String(body.board ?? '').slice(0, 80),
					tag: String(body.tag ?? '').slice(0, 40),
					query: String(body.query ?? '').slice(0, 120),
					favorite: body.favorite === true,
					untagged: body.untagged === true,
					unclassified: body.unclassified === true,
					deleted: body.deleted === true,
					selected: ids,
					selectedNames: Array.isArray(body.selectedNames) ? body.selectedNames.map(String).slice(0, 50) : [],
					total: Number(body.total ?? 0) || 0,
					at: Date.now(),
				};
				reply(200, { ok: true, context: pageContext });
				return;
			}
			reply(200, { ok: true, context: pageContext });
			return;
		}
		// ★ 2026-10-26（改版 A 案，用户拍板 ⑤）：256px webp 缩略图缓存。
		//   `GET` 命中就回 webp（内容寻址 ⇒ immutable）；没命中回 404（页面据此回退到原图并在页面侧生成）。
		//   `POST` 收页面编好的 webp 落盘（Host 侧零依赖、没有编码器 ⇒ 编码这一步由页面完成，见 mediaApp.js）。
		//   ⚠ `?w=` 只是契约声明：缓存只有 256 一档（多档会让去重文件数翻倍，收益极小）。
		if (path.startsWith('thumb/')) {
			const id = decodeURIComponent(path.slice('thumb/'.length));
			const asset = store.get(id);
			if (!asset) { reply(404, { ok: false, error: '没有这张资产' }); return; }
			const file = store.thumbPathOf(asset.sha8);
			if (method === 'GET') {
				if (!asset.sha8 || !existsSync(file)) {
					res.writeHead(404, {
						'content-type': 'application/json; charset=utf-8',
						'cache-control': 'no-store',
						'x-vssaros-thumb': 'missing',
					});
					res.end(JSON.stringify({ ok: false, error: '缩略图还没生成（首屏由页面生成后回传）' }));
					return;
				}
				let bytes;
				try { bytes = await readFileAsync(file); } catch { reply(404, { ok: false, error: '缩略图读不出来' }); return; }
				res.writeHead(200, {
					'content-type': 'image/webp',
					'content-length': String(bytes.length),
					'cache-control': 'private, max-age=31536000, immutable',
					'x-vssaros-thumb': `hit;w=${THUMB_WIDTH}`,
				});
				res.end(bytes);
				return;
			}
			if (method === 'POST') {
				if (!asset.sha8) { reply(409, { ok: false, error: '这条资产没有内容寻址键（仅引用资产），不能生成缩略图' }); return; }
				const raw = await readRawBody(req, 4 * 1024 * 1024);
				// 只收 webp：魔数 `RIFF....WEBP`（别把任意二进制塞进缓存目录）
				const isWebp = raw.length > 12
					&& raw.toString('latin1', 0, 4) === 'RIFF'
					&& raw.toString('latin1', 8, 12) === 'WEBP';
				if (!isWebp) { reply(415, { ok: false, error: '只接受 webp（RIFF/WEBP）' }); return; }
				mkdirSync(dirname(file), { recursive: true });
				const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
				writeFileSync(tmp, raw);
				try {
					if (!existsSync(file)) { renameSync(tmp, file); } else { rmSync(tmp, { force: true }); }
				} catch (e) {
					rmSync(tmp, { force: true });
					throw e;
				}
				reply(200, { ok: true, bytes: raw.length, width: THUMB_WIDTH });
				return;
			}
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
			// ★ 2026-10-26（真机卡顿）：这里原来 `readFileSync` ⇒ 一次要几十个大文件（尤其**视频**）时
			//   Host 主线程被同步 I/O 顶住，整个 dsh 界面连切页签都卡。改成异步读。
			const loaded = await store.readBytesAsync(id);
			if (!loaded) { reply(404, { ok: false, error: '没有这张资产（或文件已不在）' }); return; }
			res.writeHead(200, {
				'content-type': loaded.asset.mime || 'application/octet-stream',
				'content-length': String(loaded.bytes.length),
				'cache-control': 'private, max-age=31536000, immutable',
			});
			res.end(loaded.bytes);
			return;
		}
		// ★ 2026-10-26：**不带 id** 的三条破坏性/巡检端点要排在下面的 `if (!id) 400` 之前
		//   （否则 body 为空 ⇒ 还没进到分支就先被"要 body.id"挡掉了）。
		if (method === 'POST' && path === 'purge-deleted') {
			reply(200, { ok: true, ...store.purgeDeleted() });
			return;
		}
		if (method === 'POST' && path === 'clean-orphans') {
			reply(200, { ok: true, ...store.cleanOrphaned() });
			return;
		}
		// ---- 链接外部文件夹（2026-10-27：显示"文件夹里的独立文件"，**不复制字节**）----
		//   `dir` 由用户在页面上粘绝对路径（浏览器拿不到 `<input webkitdirectory>` 的绝对路径）；
		//   同一个路径已登记过就跳过 ⇒ 可以反复点（幂等）。`dryRun` 只扫描不落库。
		if (method === 'POST' && path === 'link-folder') {
			const body = await readJsonBody(req);
			const result = store.linkFolder({
				dir: body.dir, recursive: body.recursive !== false,
				dryRun: body.dryRun === true, limit: body.limit,
			});
			reply(result.ok === false ? 400 : 200, result.ok === false ? { ok: false, error: result.error } : result);
			return;
		}
		// ---- 导出到文件夹（2026-10-27：「生成物也存成指定目录里的独立文件」）----
		//   与 `link-folder` 相反：那边是"库里只记路径"，这边是"把库里的字节再落一份可读文件"。
		//   同卷优先硬链接（零额外空间），跨卷/不支持退回复制；已存在就跳过（幂等，可反复跑）。
		if (method === 'POST' && path === 'export-folder') {
			const body = await readJsonBody(req);
			const result = store.exportAssets({
				dir: body.dir,
				layout: body.layout,
				ids: body.ids,
				filter: body.filter,
				dryRun: body.dryRun === true,
				overwrite: body.overwrite === true,
				hardlink: body.hardlink !== false,
				limit: body.limit,
			});
			reply(result.ok === false ? 400 : 200, result);
			return;
		}
		// ---- 「媒体库管家」的三个整理动作（2026-10-26）----
		//   都支持 **dryRun**（默认见各端点注释）：整理是**改结构**的动作，先出方案再落库。
		if (method === 'POST' && path === 'auto-tag') {
			const body = await readJsonBody(req);
			reply(200, { ok: true, ...store.autoTag({
				ids: body.ids, limit: body.limit, rules: body.rules, dryRun: body.dryRun === true,
			}) });
			return;
		}
		if (method === 'POST' && path === 'tag-merge') {
			const body = await readJsonBody(req);
			reply(200, { ok: true, ...store.mergeTags({ dryRun: body.dryRun === true }) });
			return;
		}
		if (method === 'POST' && path === 'board-plan') {
			const body = await readJsonBody(req);
			reply(200, { ok: true, ...store.planBoards({
				mode: body.mode, prefix: body.prefix, overwrite: body.overwrite === true,
				limit: body.limit, dryRun: body.dryRun !== false,
			}) });
			return;
		}
		if (method === 'GET' && path === 'usage') {
			// `archive` = 自动归档的账目（成功/复制/失败 + 最后一条错误）—— 归档是"尽力而为"，
			// 失败只在这里体现，不去打扰生成流程（见 ownStore.archiveOne 的决策说明）。
			reply(200, { ok: true, usage: store.usage(), archive: store.archiveStats() });
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
				// ⚠ 别直接用 `store.get()` 覆盖：`importAsset` 返回里那个 `archivePath` 是**瞬时的**
				//   （自动归档刚落的可读副本路径，不落库）⇒ 重读一次会把它丢掉。这里手动带上。
				const fresh = store.get(asset.id);
				reply(200, {
					ok: true,
					asset: asset.archivePath ? { ...fresh, archivePath: asset.archivePath } : fresh,
				});
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
			// ★ 2026-10-26（改版 A 案，用户拍板 ⑥）：检查器的「注释」列。
			if (path === 'note') {
				reply(200, { ok: true, asset: store.setNote(id, body.note ?? '') });
				return;
			}
			// ★ 2026-10-26（用户要求补「清空回收站 / 永久删除」）：**物理删除**行 + 文件。
			//   单条走这里；批量由页面串行调用（与批量收藏/软删同一口径：一次 ≤20 条、3 路并发）。
			//   ⚠ 内容寻址：同一 sha8 还有别的行在用时**只删行、不删文件**（由 store.purge 判断）。
			if (path === 'purge') {
				const result = store.purge(id);
				if (!result.ok) { reply(404, { ok: false, error: result.error ?? '没有这条资产' }); return; }
				reply(200, { ok: true, ...result });
				return;
			}
		}
		reply(404, { ok: false, error: `没有这个端点：${method} ${url.pathname}` });
	} catch (e) {
		reply(500, { ok: false, error: String(e?.message ?? e) });
	}
}

/**
 * ★ 2026-10-27（"工作台白屏"定位）：apply 外面加一层**可观测**的壳。
 *
 * 事实：真 Host 上这个插件的**工具与页面路由全都没注册**（harness 日志里 `media_*` 一个都没命中），
 * 但**没有任何一行报错** —— dsh 把 apply 抛错吞掉了 ⇒ 只能靠猜。
 * 这层壳做两件事：进入/完成各打一行、抛错时把栈打出来再原样抛（行为不变）。
 * 定位完可以留着 —— 它就是"插件没挂上"的唯一线索。
 */
export function apply(ctx, config = {}) {
	console.log('[vssaros-media] apply 开始（config 键：' + Object.keys(config ?? {}).join(',') + '）');
	try {
		applyInner(ctx, config);
	} catch (err) {
		console.error('[vssaros-media] apply 抛错（插件因此没挂载）：' + String(err?.stack ?? err));
		throw err;
	}
	// ★ 2026-10-28（用户：「媒体库工作台中的 AI 助手内，应该显示 媒体库助手 agent」）：
	//   媒体库原来**只有工具、没有 agent** ⇒ `vssaros-media-librarian` preset 不存在 ⇒ 右侧对话列
	//   只能沿用别的插件（商城）的 preset。这里把「媒体库管家」落成 `<数据根>/agents/media-librarian/.agent.md`
	//   （与用户自建 bot 同构，由 `vssaros-agents` 启动时扫描注册）。
	//   ⚠ 只在缺文件时创建，不覆盖用户改过的人设；失败只打日志，绝不影响页面/工具。
	try {
		ensureMediaAgent({ dataRoot: dataRootOf(config) })
			.then((r) => {
				if (r && r.created) { console.log('[vssaros-media] 已创建「媒体库管家」agent：' + r.file); }
				else if (r && r.ok === false) { console.warn('[vssaros-media] 创建「媒体库管家」agent 失败：' + r.error); }
			})
			.catch((e) => console.warn('[vssaros-media] ensureMediaAgent 抛错：' + String(e?.message ?? e)));
	} catch (e) {
		console.warn('[vssaros-media] ensureMediaAgent 同步失败：' + String(e?.message ?? e));
	}
	console.log('[vssaros-media] apply 完成');
}

function applyInner(ctx, config = {}) {
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
	ctx.inject(['webServer', 'connection'], page => page.effect(() => {
		const disposeRoute = page.webServer.register({
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
					// `authenticatedUrl` 交给 API（「外开」要服务端现签带 token 的深链）。
					// ⚠ 老 Host / 探针的 connection 可能没有这个方法 ⇒ 传 undefined，端点会如实回 501（不抛）。
					const signUrl = typeof page.connection?.authenticatedUrl === 'function'
						? (target => page.connection.authenticatedUrl(target))
						: undefined;
					await handleMediaApi(config, { req, res, url, authenticatedUrl: signUrl });
					return;
				}
				// ★ 2026-10-26：页面脚本单独下发（真正的 .js 文件，不进模板字符串；理由见 mediaApp.js 头）。
				if (url.pathname === `${ROUTE_PREFIX}/app.js`) {
					const script = readFileSync(new URL('./mediaApp.js', import.meta.url));
					res.writeHead(200, {
						'content-type': 'application/javascript; charset=utf-8',
						'content-length': String(script.length),
						// 页面本身 no-store ⇒ 脚本也 no-store（改完刷新即生效，不被中间层缓存坑）
						'cache-control': 'no-store',
					});
					res.end(script);
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
				//   `?source=ide` 仍可看 IDE 镜像（`store.js`）—— 并存期对账 / 排查老数据用（只读）。
				const source = url.searchParams.get('source') === 'ide' ? 'ide' : 'dsh';
				// 深链参数：SSR 首屏就按它过滤（`?kind=image` 是探针钉的那条；其余给书签/分享用）
				const filter = {
					kind,
					provider: url.searchParams.get('provider') ?? '',
					board: url.searchParams.get('board') ?? '',
					tag: url.searchParams.get('tag') ?? '',
					query: url.searchParams.get('query') ?? '',
					favorite: boolParam(url, 'favorite'),
					untagged: boolParam(url, 'untagged'),
					unclassified: boolParam(url, 'unclassified'),
					deleted: boolParam(url, 'deleted'),
					nav: url.searchParams.get('nav') ?? '',
				};
				filter.nav = filter.nav || (filter.board ? `board:${filter.board}`
					: filter.tag ? `tag:${filter.tag}`
						: filter.deleted ? 'trash'
							: filter.untagged ? 'untagged'
								: filter.unclassified ? 'unclassified'
									: filter.favorite ? 'favorite'
										: kind ? `kind:${kind}` : 'all');
				filter.label = filter.board ? filter.board
					: filter.tag ? `#${filter.tag}`
						: filter.deleted ? '回收站'
							: filter.untagged ? '未标签'
								: filter.unclassified ? '未分类'
									: filter.favorite ? '收藏'
										: kind ? (KIND_LABEL[kind] ?? kind) : '全部';

				let stats = { assetCount: 0, totalBytes: 0, deletedCount: 0, byKind: {} };
				let facets;
				let views = [];
				let total = 0;
				let error;
				let root = mediaRootOf(config);
				let dbPath = mediaDbPathOf(config);
				let via = lastReadModeOf();
				let sync = null;
				const writable = source === 'dsh';
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
						facets = own.facets();
						const result = own.list({
							kind: filter.kind || undefined,
							provider: filter.provider || undefined,
							board: filter.board || undefined,
							tag: filter.tag || undefined,
							query: filter.query || undefined,
							favorite: filter.favorite || undefined,
							untagged: filter.untagged || undefined,
							unclassified: filter.unclassified || undefined,
							onlyDeleted: filter.deleted || undefined,
							limit: PAGE_LIMIT,
						});
						// `hasThumb` 是页面派生的（工具输出不需要）⇒ 在这里补，别污染 store 的资产形状
						views = result.items
							.map(asset => ({ ...asset, hasThumb: own.hasThumbOf(asset.sha8) }))
							.map(asset => toView(asset, { source: 'dsh', apiPrefix: API_PREFIX }));
						total = result.total;
						root = own.root;
						dbPath = own.dbPath;
						via = 'dsh';
					} else {
						stats = await statsOf(config);
						const assets = await listAssets(config, { kind: kind || undefined, limit: PAGE_LIMIT });
						views = assets.map(asset => toView(asset, { source: 'ide', apiPrefix: API_PREFIX }));
						total = views.length;
					}
				} catch (e) {
					error = String(e?.message ?? e);
				}
				const boot = {
					source,
					writable,
					api: API_PREFIX,
					filter,
					views,
					facets: facets ?? null,
					stats,
					total,
					limit: PAGE_LIMIT,
					// 缩略图的实际产出方式（诊断锚点会写出来）：`page` = 页面首次渲染时编 webp 回传落盘
					thumbMode: writable ? 'page' : 'readonly',
				};
				// 先渲染再 writeHead（渲染抛错还能干净回 500）
				const html = renderMediaPage({
					views, facets, stats, filter, writable,
					root, dbPath, toolsRegistered, sync,
					// 读成功之后才取样：它由 store 在**实际打开**时记录（直连 / 私有快照 / dsh）
					via,
					error,
					boot,
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
		});
		// ★ 2026-10-27（"工作台白屏"排查）：挂上就打一行。
		//   以前页面 404 / 白屏时**一句日志都没有** ⇒ 只能靠猜"插件是不是没挂"；
		//   有这行就能一眼分清「没装上」与「装上了但页面渲染崩了」（后者会有 500 或者页面里的 error 横幅）。
		console.log(`[vssaros-media] 页面路由已注册：${ROUTE_PREFIX}/（含 ${API_PREFIX}*）`);
		return disposeRoute;
	}));
}
