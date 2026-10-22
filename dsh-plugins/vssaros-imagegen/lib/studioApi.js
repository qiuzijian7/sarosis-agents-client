/**
 * 生图工作台的**宿主侧 API**（`/x/imagegen/api/*`）：画廊 / 能力表 / 生成 / 批量 / 存盘。
 *
 * 为什么要页面自己有 API（而不是全靠 Agent 工具）：工作台是**给人用的**界面 ⇒ 用户点「生成」
 *   就能出图，不必先回聊天框说一句话。
 *
 * ⚠ 但**生图本身仍走同一条链路**（`state.generateImage` ⇒ 桥回 IDE ⇒ 凭据/审批只有一份真源 ✓）——
 *   页面**不自己**调 provider（那会变成第二份真源 ✗）。
 *
 * ⚠ 页面 API 的写操作**没有**聊天框那层审批闸（页面是用户自己点的 ⇒ 用户就是审批人 ✓）。
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { DEFAULT_IMAGE_DIR, mediaTypeForExtension, maybeSaveToWorkspace, resolveTargetDir } from './workspaceSave.js';
import { decodeDataUrl } from './imageBytes.js';
import { CANVAS_IMAGE_ROUTE } from './canvasState.js';

/** 请求体上限（生图请求体很小：prompt + 选项）。 */
const MAX_BODY_BYTES = 512 * 1024;

/** 批量最多几条（与工具同口径：10）。 */
const MAX_BATCH = 10;

/** ★ 导入图的请求体上限（dataURL ⇒ 约 1.33 倍字节数）。 */
const MAX_IMPORT_BYTES = 24 * 1024 * 1024;

/** 工作区已落盘图的字节路由（画廊的**持久**来源）。 */
const WORKSPACE_IMAGE_ROUTE = '/x/imagegen/api/workspace-image';

function sendJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
	res.end(JSON.stringify(payload));
}

/** 读请求体（JSON）。 */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
	let raw = '';
	try {
		for await (const chunk of req) {
			raw += chunk;
			if (raw.length > limit) {
				return { error: '请求体太大' };
			}
		}
	} catch (e) {
		return { error: String((e && e.message) || e) };
	}
	if (!raw) { return {}; }
	try {
		return JSON.parse(raw);
	} catch {
		return { error: '请求体不是合法 JSON' };
	}
}

/** 账本条目 ⇒ 画廊条目（url 指向图字节路由）。 */
function toGalleryItem(item) {
	return {
		id: item.id,
		url: CANVAS_IMAGE_ROUTE + '/' + item.id,
		mimeType: item.mediaType,
		width: item.width,
		height: item.height,
		prompt: item.prompt,
		at: item.at,
		savedPath: item.savedPath || '',
		// ★ 四批⑪：provider/模型/来源（筛选与"这是哪来的"都要用）。
		provider: item.provider || '',
		model: item.model || '',
		source: 'recent',
	};
}

/**
 * 工作区里**已落盘**的图（画廊的持久来源：Host 重启还在）。
 *
 * ⚠ 只认我们自己的图目录（`<工作区>/.vssaros-images/`）⇒ 不会把用户仓库里别的图卷进来。
 * @param {string} root 工作区根
 * @param {string} [dir] 相对目录
 * @returns {{items: Array<object>, dir: string, error?: string}}
 */
function listWorkspaceImages(root, dir) {
	const target = resolveTargetDir(root, dir ?? DEFAULT_IMAGE_DIR);
	if (target.error) { return { items: [], dir: '', error: target.error }; }
	let names = [];
	try {
		names = readdirSync(target.dir);
	} catch {
		return { items: [], dir: target.dir };
	}
	const items = [];
	for (const name of names) {
		if (name.startsWith('.')) { continue; }
		if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) { continue; }
		const abs = resolve(target.dir, name);
		let stat;
		try {
			stat = lstatSync(abs);
		} catch {
			continue;
		}
		if (stat.isSymbolicLink() || !stat.isFile()) { continue; }
		items.push({
			id: 'ws-' + name,
			name,
			url: WORKSPACE_IMAGE_ROUTE + '?name=' + encodeURIComponent(name),
			mimeType: mediaTypeForExtension(name) || 'image/png',
			prompt: name,
			at: stat.mtimeMs,
			size: stat.size,
			savedPath: abs,
			provider: '',
			model: '',
			source: 'workspace',
		});
	}
	items.sort((a, b) => b.at - a.at);
	return { items, dir: target.dir };
}

/**
 * 处理工作台 API。
 *
 * @param {object} state 宿主状态
 * @param {object} input
 * @param {string} input.pathname 路径
 * @param {string} input.method HTTP 方法
 * @param {object} input.req 请求
 * @param {object} input.res 响应
 * @returns {Promise<boolean>} true = 已处理（false = 不是工作台 API，交给别的分支）
 */
export async function handleStudioApi(state, { pathname, req, res, url }) {
	const isGenerate = pathname === '/x/imagegen/api/generate';
	const isBatch = pathname === '/x/imagegen/api/batch';
	const isSave = pathname === '/x/imagegen/api/save';
	const isGallery = pathname === '/x/imagegen/api/gallery';
	const isCaps = pathname === '/x/imagegen/api/capabilities';
	const isWorkspaceImage = pathname === WORKSPACE_IMAGE_ROUTE;
	const isImport = pathname === '/x/imagegen/api/canvas-import';
	const isCanvasRun = pathname === '/x/imagegen/api/canvas-run';
	if (!isGenerate && !isBatch && !isSave && !isGallery && !isCaps && !isWorkspaceImage && !isImport && !isCanvasRun) {
		return false;
	}

	// (1) 画廊 + 能力表 + 画布状态（**一次取数**，页面三个壳共用 —— 规范 4.2）。
	if (isGallery) {
		const items = (state.canvasImages?.since?.(0) ?? []).slice().reverse();
		let providers = [];
		let capabilitiesError = '';
		try {
			const capabilities = await state.capabilities?.load?.();
			providers = capabilities?.providers ?? [];
		} catch (e) {
			capabilitiesError = String((e && e.message) || e);
		}
		const canvasEntry = state.canvas?.latest?.();
		// ★ 四批⑪：画廊有两个来源 —— 内存账本（最近出图）+ 工作区里已落盘的图（**持久**）。
		const workspace = listWorkspaceImages(state.resolveWorkspaceRoot?.() || '', undefined);
		const recent = items.map(toGalleryItem);
		sendJson(res, 200, {
			ok: true,
			images: recent,
			workspaceImages: workspace.items,
			// 合并后的画廊（页面侧筛选用这个；一次取数 ⇒ 三个壳共用 ✓）。
			gallery: recent.concat(workspace.items),
			providers,
			canvas: canvasEntry
				? { connected: true, elementCount: canvasEntry.elementCount, selectedCount: canvasEntry.selectedIds.length }
				: { connected: false, elementCount: 0, selectedCount: 0 },
			workspace: { root: state.resolveWorkspaceRoot?.() || '', dir: workspace.dir || '' },
			...(capabilitiesError ? { capabilitiesError } : {}),
			...(workspace.error ? { workspaceError: workspace.error } : {}),
		});
		return true;
	}

	// (2) 能力表（单独取，便于探针直接问）。
	if (isCaps) {
		try {
			const capabilities = await state.capabilities?.load?.();
			sendJson(res, 200, { ok: true, providers: capabilities?.providers ?? [] });
		} catch (e) {
			sendJson(res, 200, { ok: false, error: String((e && e.message) || e), providers: [] });
		}
		return true;
	}

	// (3) 生成（一条）—— 与工具同一条链路（state.generateImage）。
	if (isGenerate) {
		const body = await readJsonBody(req);
		if (body.error) {
			sendJson(res, 400, { ok: false, error: body.error });
			return true;
		}
		const prompt = String(body.prompt || '').trim();
		if (!prompt) {
			sendJson(res, 400, { ok: false, error: 'prompt 必填（画面描述）' });
			return true;
		}
		if (typeof state.generateImage !== 'function') {
			sendJson(res, 503, { ok: false, error: '生图链路没装好（宿主侧 generateImage 缺失）' });
			return true;
		}
		try {
			const result = await state.generateImage(state, {
				prompt,
				model: body.model,
				provider: body.provider,
				size: body.size,
				quality: body.quality,
				numImages: body.n,
				askedSave: true,
				saveDir: body.save_dir,
			});
			sendJson(res, 200, {
				ok: true,
				images: result.images.map(toGalleryItem),
				savedPaths: result.savedPaths,
				failures: result.failures,
			});
		} catch (e) {
			sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
		}
		return true;
	}

	// (4) 批量（顺序执行；单条失败不中断其余 —— 与工具同口径）。
	if (isBatch) {
		const body = await readJsonBody(req);
		if (body.error) {
			sendJson(res, 400, { ok: false, error: body.error });
			return true;
		}
		const prompts = Array.isArray(body.prompts)
			? body.prompts.map(item => String(item || '').trim()).filter(Boolean)
			: [];
		if (prompts.length === 0) {
			sendJson(res, 400, { ok: false, error: 'prompts 必填（一行一条画面描述）' });
			return true;
		}
		if (prompts.length > MAX_BATCH) {
			sendJson(res, 400, { ok: false, error: '一次最多 ' + MAX_BATCH + ' 条（收到 ' + prompts.length + ' 条）' });
			return true;
		}
		if (typeof state.generateImage !== 'function') {
			sendJson(res, 503, { ok: false, error: '生图链路没装好（宿主侧 generateImage 缺失）' });
			return true;
		}
		const images = [];
		const failures = [];
		const savedPaths = [];
		for (const [index, prompt] of prompts.entries()) {
			try {
				const result = await state.generateImage(state, {
					prompt,
					model: body.model,
					provider: body.provider,
					size: body.size,
					quality: body.quality,
					numImages: 1,
					askedSave: true,
					saveDir: body.save_dir,
				});
				for (const image of result.images) { images.push(toGalleryItem(image)); }
				for (const path of result.savedPaths) { savedPaths.push(path); }
				for (const failure of result.failures) { failures.push({ index, prompt, error: failure }); }
			} catch (e) {
				failures.push({ index, prompt, error: String((e && e.message) || e) });
			}
		}
		sendJson(res, 200, { ok: true, images, failures, savedPaths });
		return true;
	}

	// (5) 存到工作区（把图落到用户工作区 —— 内容寻址 + 原子写，见 lib/workspaceSave.js）。
	if (isSave) {
		const body = await readJsonBody(req);
		if (body.error) {
			sendJson(res, 400, { ok: false, error: body.error });
			return true;
		}
		const item = state.canvasImages?.find?.(String(body.id || ''));
		if (!item) {
			sendJson(res, 404, { ok: false, error: '找不到这张图（只留最近 50 张）' });
			return true;
		}
		const attachments = state.attachments;
		if (!attachments || typeof attachments.readImage !== 'function') {
			sendJson(res, 503, { ok: false, error: 'attachments 服务不在（读不到图字节）' });
			return true;
		}
		try {
			const raw = await attachments.readImage(item.attachment);
			const bytes = raw && raw.bytes ? raw.bytes : (raw && raw.data ? raw.data : raw);
			if (!bytes) {
				sendJson(res, 500, { ok: false, error: 'readImage 没给出字节' });
				return true;
			}
			const saved = await maybeSaveToWorkspace({
				asked: true,
				bytes,
				mediaType: item.mediaType,
				root: state.resolveWorkspaceRoot?.(),
				dir: body.save_dir,
			});
			if (!saved.saved) {
				sendJson(res, 200, { ok: false, error: saved.error || '落盘失败' });
				return true;
			}
			state.canvasImages?.markSaved?.(item.id, saved.path);
			sendJson(res, 200, { ok: true, path: saved.path });
		} catch (e) {
			sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
		}
		return true;
	}

	// (6) 工作区里已落盘图的字节（画廊的**持久**来源）。
	if (isWorkspaceImage) {
		const name = String(url?.searchParams?.get('name') || '').trim();
		// ⚠ 只接受**裸文件名**（不许带路径）⇒ 越权读别的文件这条路直接堵死。
		if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
			sendJson(res, 400, { ok: false, error: '文件名不合法' });
			return true;
		}
		const root = state.resolveWorkspaceRoot?.() || '';
		const target = resolveTargetDir(root, DEFAULT_IMAGE_DIR);
		if (target.error) {
			sendJson(res, 200, { ok: false, error: target.error });
			return true;
		}
		const abs = resolve(target.dir, name);
		if (!abs.startsWith(target.dir.endsWith(sep) ? target.dir : target.dir + sep)) {
			sendJson(res, 400, { ok: false, error: '路径不合法' });
			return true;
		}
		try {
			const bytes = readFileSync(abs);
			res.writeHead(200, { 'content-type': mediaTypeForExtension(name) || 'application/octet-stream', 'cache-control': 'no-store' });
			res.end(bytes);
		} catch (e) {
			sendJson(res, 404, { ok: false, error: String((e && e.message) || e) });
		}
		return true;
	}

	// (7) ★ 四批⑫：把**本地磁盘上的图**插进画布（拖进来 / 选文件）。
	//   链路：dataURL → attachment（长期在）→ 账本（画布按 id 去重落位）→ 落工作区（持久）。
	if (isImport) {
		const body = await readJsonBody(req, MAX_IMPORT_BYTES);
		if (body.error) {
			sendJson(res, 400, { ok: false, error: body.error });
			return true;
		}
		const decoded = decodeDataUrl(body.dataURL);
		if (!decoded) {
			sendJson(res, 400, { ok: false, error: '这张图读不出来（要 dataURL）' });
			return true;
		}
		const attachments = state.attachments;
		if (!attachments || typeof attachments.saveImage !== 'function') {
			sendJson(res, 503, { ok: false, error: 'attachments 服务不在（图片无处存放）' });
			return true;
		}
		try {
			const name = String(body.name || '').trim() || 'imported-image';
			const attachment = await attachments.saveImage({
				data: decoded.bytes,
				mediaType: decoded.mediaType,
				name,
			});
			const recorded = state.canvasImages?.record({
				attachment,
				mediaType: decoded.mediaType,
				width: attachment.width,
				height: attachment.height,
				prompt: '（从磁盘导入：' + name + '）',
				provider: 'import',
				model: '',
				source: 'import',
			});
			// 落工作区（默认存）⇒ 导入的图也在"我的图"里（画廊的持久来源能看见它）。
			const saved = await maybeSaveToWorkspace({
				asked: true,
				bytes: decoded.bytes,
				mediaType: decoded.mediaType,
				root: state.resolveWorkspaceRoot?.(),
			});
			if (saved.saved && recorded?.id) {
				state.canvasImages?.markSaved?.(recorded.id, saved.path);
			}
			sendJson(res, 200, {
				ok: true,
				image: recorded ? toGalleryItem(recorded) : undefined,
				id: recorded?.id,
				savedPath: saved.saved ? saved.path : '',
				saveError: saved.error || '',
			});
		} catch (e) {
			sendJson(res, 200, { ok: false, error: String((e && e.message) || e) });
		}
		return true;
	}

	// (8) ★ 节点图的执行（画布页「▶ 运行」按钮 / Agent 工具都走这里）。
	//     引擎在 `lib/canvasRun.js`；单节点失败不中断其余。
	if (isCanvasRun) {
		const body = await readJsonBody(req);
		if (body.error) {
			sendJson(res, 400, { ok: false, error: body.error });
			return true;
		}
		if (typeof state.runCanvasGraph !== 'function') {
			sendJson(res, 503, { ok: false, error: '执行引擎没装好（宿主侧 runCanvasGraph 缺失）' });
			return true;
		}
		try {
			const result = await state.runCanvasGraph(state, {
				graph: body.graph,
				nodeId: body.nodeId,
			});
			sendJson(res, 200, {
				ok: result.ok !== false,
				results: result.results,
				graph: result.graph,
				revision: result.revision,
				cycles: result.cycles,
			});
		} catch (e) {
			sendJson(res, 200, { ok: false, error: String(e?.message ?? e) });
		}
		return true;
	}

	return false;
}
