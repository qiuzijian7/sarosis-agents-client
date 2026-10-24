/**
 * 自由绘制层（Excalidraw）—— **懒加载**。
 *
 * ★ 为什么单独一个模块、且是动态 import：
 *   Excalidraw 产物 713KB JS + 141KB CSS。节点工作流模式**完全用不到**它
 *   ⇒ 静态 import 意味着"进画布页就下载 850KB"（用户只想跑节点图时纯属浪费 ✗）。
 *   ⇒ 这里用 `import('./entry.js')` 在**第一次进自由绘制模式时**才加载。
 *
 * 这一层只管"自由绘制"自己的事：
 *   ① 挂载 Excalidraw（中文界面）；
 *   ② 产出现场快照（场景 + 选区三态 + 选区原图）交给外壳去推给宿主；
 *   ③ 本地磁盘的图插进画布（选文件 / 拖进来）；生成结果自动落位。
 *
 * ⚠ 这一层与宿主的唯一通道仍是 HTTP（页面是普通网页，不是 dsh 客户端）。
 */
import { isRectVisible, landingSize, nextLandingSlot } from './landing.js';

/** 场景体积上限（超出就不发场景本体，只发摘要）。 */
const MAX_SCENE_BYTES = 8 * 1024 * 1024;
/** 选区截图的上限（最长边 2048、4MB）。 */
const MAX_SELECTION_EDGE = 2048;
const MAX_SELECTION_CHARS = 4 * 1024 * 1024;

/** Excalidraw 的 CSS 只加一次。 */
let cssAdded = false;
function ensureStylesheet() {
	if (cssAdded) { return; }
	cssAdded = true;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = './entry.css';
	document.head.appendChild(link);
}

/** 元素的人话描述（给 Agent 看的文字）。 */
function describe(elements, selectedIds) {
	const set = new Set(selectedIds);
	return elements.filter(el => set.has(el.id)).map(el => {
		const kind = el.type === 'image' ? '图片' : el.type === 'freedraw' ? '手绘线条' : el.type === 'text' ? '文字' : el.type === 'rectangle' ? '矩形' : el.type === 'ellipse' ? '椭圆' : el.type === 'diamond' ? '菱形' : el.type === 'arrow' ? '箭头' : el.type;
		const text = typeof el.text === 'string' && el.text.trim() ? '「' + el.text.trim().slice(0, 40) + '」' : '';
		return kind + text;
	});
}

/** 场景快照：元素 + 视图状态 + 图片文件（dataURL，刷新后图还在）。 */
function sceneOf(elements, appState, files) {
	const out = { elements: elements.map(el => Object.assign({}, el)), appState: {}, files: {} };
	if (appState) {
		out.appState = {
			viewBackgroundColor: appState.viewBackgroundColor,
			zoom: appState.zoom, scrollX: appState.scrollX, scrollY: appState.scrollY,
		};
	}
	for (const id of Object.keys(files || {})) {
		const file = files[id];
		if (file && typeof file.dataURL === 'string') {
			out.files[id] = { mimeType: file.mimeType, dataURL: file.dataURL };
		}
	}
	return out;
}

function byteLengthOf(value) {
	try { return JSON.stringify(value).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

/** 图片 dataURL 的像素尺寸（拿不到就给 undefined）。 */
async function imageSizeOf(dataUrl) {
	try {
		const img = await new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('图片解码失败'));
			image.src = dataUrl;
		});
		const w = Number(img.naturalWidth);
		const h = Number(img.naturalHeight);
		return { width: isFinite(w) ? w : 0, height: isFinite(h) ? h : 0 };
	} catch (e) {
		return undefined;
	}
}

/**
 * 把一张 dataURL 缩到指定长边并转成 JPEG（降质）。
 *
 * ★ 为什么自己缩、而不是用 Excalidraw 的 `exportScale`：0.18 的 `exportToBlob` **不认**顶层
 *   `exportScale`，appState 里那个也不作用于"导出元素子集"（实测：4000px 的选区导出仍是 4016px）
 *   ⇒ 只能自己解码后缩。
 */
async function shrinkDataUrl(dataUrl, maxEdge, quality) {
	try {
		const img = await new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error('图片解码失败'));
			image.src = dataUrl;
		});
		const wRaw = Number(img.naturalWidth);
		const hRaw = Number(img.naturalHeight);
		const w = isFinite(wRaw) ? Math.max(1, wRaw) : 1;
		const h = isFinite(hRaw) ? Math.max(1, hRaw) : 1;
		const scale = Math.min(1, maxEdge / Math.max(w, h));
		const width = Math.max(1, Math.round(w * scale));
		const height = Math.max(1, Math.round(h * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, width, height);
		ctx.drawImage(img, 0, 0, width, height);
		return canvas.toDataURL('image/jpeg', quality);
	} catch (e) {
		return undefined;
	}
}

/**
 * 导出选区截图（**限长边 + 体积上限 + 逐级降质**）。
 * ⚠ 为什么必须限：dataURL 会进宿主状态、再进模型上下文 ⇒ 不限就会把 Host/上下文撑爆。
 */
async function exportSelectionCapped(elements, appState, files, selectedIds) {
	try {
		const set = new Set(selectedIds);
		const picked = elements.filter(function (el) {
			if (!set.has(el.id)) { return false; }
			return el.isDeleted !== true;
		});
		if (picked.length === 0) { return { error: '选区里没有可导出的对象' }; }
		const blob = await exportToBlob({
			elements: picked,
			appState: Object.assign({}, appState, {
				exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: '#ffffff',
			}),
			files: files || {},
			mimeType: 'image/png',
			exportPadding: 8,
		});
		if (!blob) { return { error: '导出没拿到图片' }; }
		const raw = await new Promise(resolve => {
			const reader = new FileReader();
			reader.onload = () => resolve(String(reader.result || ''));
			reader.onerror = () => resolve('');
			reader.readAsDataURL(blob);
		});
		if (!raw) { return { error: '导出结果读不出来' }; }
		const dims = await imageSizeOf(raw);
		const tooBig = dims ? Math.max(dims.width, dims.height) > MAX_SELECTION_EDGE : false;
		let result = raw;
		if (tooBig || raw.length > MAX_SELECTION_CHARS) {
			const jpeg = await shrinkDataUrl(result, MAX_SELECTION_EDGE, 0.85);
			if (jpeg) { result = jpeg; }
		}
		if (result.length > MAX_SELECTION_CHARS) {
			const small = await shrinkDataUrl(result, MAX_SELECTION_EDGE / 2, 0.7);
			if (small) { result = small; }
		}
		return { dataUrl: result, oversized: result.length > MAX_SELECTION_CHARS };
	} catch (e) {
		return { error: String(e?.message ?? e) };
	}
}

/** 画布视口尺寸（像素）。 */
function viewportSize() {
	const root = document.getElementById('cv-root');
	return {
		width: (root && root.clientWidth) || window.innerWidth || 0,
		height: (root && root.clientHeight) || window.innerHeight || 0,
	};
}

/** 本地文件 ⇒ dataURL。 */
function readFileAsDataUrl(file) {
	return new Promise(function (resolve, reject) {
		const reader = new FileReader();
		reader.onload = function () { resolve(String(reader.result || '')); };
		reader.onerror = function () { reject(new Error('文件读不出来')); };
		reader.readAsDataURL(file);
	});
}

/** 导出函数（动态 import 之后才有）。 */
let exportToBlob = null;

/**
 * 挂载自由绘制层。
 * @param {object} options
 * @param {HTMLElement} options.host 挂载点
 * @param {object} [options.initial] 首屏要恢复的场景
 * @param {string} options.apiBase 宿主 API 前缀
 * @param {(partial: object) => void} options.onSnapshot 现场快照（交给外壳推宿主）
 * @param {(text: string, tone: string) => void} options.onStatus
 */
export async function mountFreeCanvas(options) {
	const host = options.host;
	const apiBase = options.apiBase || '/x/imagegen/api';
	const onSnapshot = options.onSnapshot || (() => {});
	const onStatus = options.onStatus || (() => {});
	ensureStylesheet();
	const mod = await import('./entry.js');
	exportToBlob = mod.exportToBlob;
	const { Excalidraw, createRoot, createElement } = mod;

	const root = createRoot(host);
	const initial = options.initial || { elements: [], appState: {}, files: {} };
	let pushTimer = 0;
	let lastSelectionKey = '';
	const apiRef = { current: null };
	/** 已经落过位的图 id（避免同一张图重复落位）。 */
	const placedImages = new Set();
	/** 「最近出图」的游标（毫秒）。 */
	let lastSeenAt = 0;

	/**
	 * 产出现场快照。
	 * @param {'auto'|'preparing'} phase 'preparing' = 只报"选区截图还在导出"
	 */
	async function snapshot(phase = 'auto') {
		const api = apiRef.current;
		if (!api) { return null; }
		const elements = api.getSceneElements();
		const appState = api.getAppState();
		const files = api.getFiles();
		const selectedIds = Object.keys(appState && appState.selectedElementIds ? appState.selectedElementIds : {});
		const scene = sceneOf(elements, appState, files);
		const tooBig = byteLengthOf(scene) > MAX_SCENE_BYTES;
		const partial = {
			elementCount: elements.length,
			selectedIds: selectedIds,
			selection: describe(elements, selectedIds),
			scene: tooBig ? undefined : scene,
			sceneOmitted: tooBig,
		};
		const selectionFiles = {};
		for (const id of selectedIds) {
			const el = elements.find(item => item.id === id);
			if (el && el.type === 'image' && el.fileId && files && files[el.fileId] && typeof files[el.fileId].dataURL === 'string') {
				selectionFiles[el.fileId] = files[el.fileId].dataURL;
			}
		}
		if (Object.keys(selectionFiles).length > 0) { partial.selectionFiles = selectionFiles; }
		if (phase === 'preparing') {
			partial.selectionStatus = 'preparing';
		} else if (selectedIds.length > 0) {
			const shot = await exportSelectionCapped(elements, appState, files, selectedIds);
			if (shot.dataUrl) {
				partial.selectionPng = shot.dataUrl;
				partial.selectionStatus = 'ready';
				if (shot.oversized) {
					partial.selectionError = '截图已压到最小仍然偏大（清晰度可能受影响）';
				}
			} else {
				partial.selectionStatus = 'error';
				partial.selectionError = shot.error;
			}
		} else {
			partial.selectionStatus = 'none';
		}
		return partial;
	}

	/**
	 * 把一张图放进画布（Excalidraw 的 image 元素 + addFiles）。
	 * @param {object} item 账本条目
	 * @param {string} dataUrl
	 */
	async function placeImage(item, dataUrl) {
		try {
			const api = apiRef.current;
			if (!api) { return; }
			const fileId = 'img-' + item.id;
			try {
				await api.addFiles([{ id: fileId, mimeType: item.mimeType ?? 'image/png', dataURL: dataUrl }]);
			} catch (e) {
				// 文件已存在 ⇒ 继续（下面的元素会引用它）。
			}
			// 等一拍再放元素：文件没登记进 files 之前，引用它的 image 元素会被**静默丢弃**。
			await new Promise(function (resolve) { setTimeout(resolve, 60); });
			const size = landingSize({ width: item.width, height: item.height });
			const existing = api.getSceneElements();
			if (existing.some(el => el && el.id === 'el-' + item.id)) { return; }
			const slot = nextLandingSlot(existing, size);
			const element = {
				id: 'el-' + item.id,
				type: 'image', x: slot.x, y: slot.y, width: slot.width, height: slot.height,
				angle: 0, strokeColor: 'transparent', backgroundColor: 'transparent',
				fillStyle: 'solid', strokeWidth: 1, roughness: 0, opacity: 100,
				groupIds: [], frameId: null, index: 'a0', seed: Date.now() % 100000,
				version: 1, versionNonce: Date.now() % 1000000, isDeleted: false,
				boundElements: null, updated: Date.now(), link: null, locked: false,
				fileId: fileId, status: 'saved', scale: [1, 1],
			};
			// updateScene 是**替换**语义 ⇒ 只能"现有 + 新增"。
			api.updateScene({ elements: existing.concat([element]) });
			const viewport = viewportSize();
			if (!isRectVisible(api.getAppState(), viewport, element)) {
				try {
					api.scrollToContent([element], { animate: true, fitToContent: false, viewport });
				} catch (e) {
					/* scrollToContent 不可用也不该让落位失败 ✓ */
				}
			}
			const partial = await snapshot('auto');
			if (partial) { onSnapshot(partial); }
		} catch (e) {
			onStatus('落位失败：' + String(e?.message ?? e), 'bad');
		}
	}

	/**
	 * 把**本地磁盘上的图**插进画布（选文件 / 直接拖进来）。
	 * 链路：dataURL → 宿主（存 attachment + 记账本 + 落工作区）→ 拿到图 id → 落位。
	 */
	async function importFiles(files) {
		const picked = Array.from(files || [])
			.filter(file => file && /^image\//.test(String(file.type || '')))
			.slice(0, 8);
		if (picked.length === 0) {
			onStatus('没有可导入的图片文件（只认 image/*）', 'bad');
			return;
		}
		let done = 0;
		for (const file of picked) {
			try {
				const dataUrl = await readFileAsDataUrl(file);
				const res = await fetch(apiBase + '/canvas-import', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					body: JSON.stringify({ dataURL: dataUrl, name: file.name }),
				});
				const reply = await res.json();
				if (!reply || reply.ok !== true || !reply.image) {
					onStatus('导入失败：' + String(reply?.error || '原因不明'), 'bad');
					continue;
				}
				await placeImage(reply.image, dataUrl);
				done += 1;
				onStatus('已导入 ' + done + ' 张（' + file.name + '）', 'ok');
			} catch (e) {
				onStatus('导入失败：' + String(e?.message ?? e), 'bad');
			}
		}
	}

	/**
	 * 轮询宿主「最近出图」⇒ 把没落过位的图取回来放上画布（**生成结果自动落画布**）。
	 */
	async function pullImages() {
		const api = apiRef.current;
		if (!api) { return; }
		try {
			const res = await fetch(apiBase + '/canvas-images?since=' + lastSeenAt, { credentials: 'same-origin' });
			if (!res.ok) { return; }
			const data = await res.json();
			const items = Array.isArray(data && data.images) ? data.images : [];
			for (const item of items) {
				if (!item || !item.id) { continue; }
				if (placedImages.has(item.id)) { continue; }
				placedImages.add(item.id);
				if (typeof item.at === 'number') { lastSeenAt = Math.max(lastSeenAt, item.at); }
				const imgRes = await fetch(item.url, { credentials: 'same-origin' });
				if (!imgRes.ok) { continue; }
				const blob = await imgRes.blob();
				const dataUrl = await new Promise(function (resolve) {
					const reader = new FileReader();
					reader.onload = function () { resolve(String(reader.result || '')); };
					reader.onerror = function () { resolve(''); };
					reader.readAsDataURL(blob);
				});
				if (!dataUrl) { continue; }
				await placeImage(item, dataUrl);
				onStatus('已落位新图 · ' + placedImages.size + ' 张', 'ok');
			}
		} catch (e) {
			onStatus('取图失败（稍后重试）：' + String(e?.message ?? e), 'bad');
		}
	}

	root.render(createElement(Excalidraw, {
		initialData: initial,
		langCode: 'zh-CN',
		UIOptions: { languages: [{ code: 'zh-CN', label: '简体中文' }, { code: 'en', label: 'English' }] },
		excalidrawAPI: (api) => {
			apiRef.current = api;
			window.__cvApi = api;
			window.__cvSync = async function () {
				const partial = await snapshot('auto');
				if (partial) { onSnapshot(partial); }
			};
			onStatus('画布已就绪', 'ok');
			// ⚠ 这里不能写 await（回调不是 async）⇒ 用 then。
			snapshot('auto').then(partial => { if (partial) { onSnapshot(partial); } });
		},
		onChange: () => {
			const current = apiRef.current;
			if (current) {
				const state = current.getAppState();
				const sel = state ? state.selectedElementIds : null;
				const key = Object.keys(sel ? sel : {}).join(',');
				if (key !== lastSelectionKey) {
					lastSelectionKey = key;
					// 选中集合变了 ⇒ 先报"导出中"（模型别把"还没导好"当成"没有截图"）。
					snapshot('preparing').then(partial => { if (partial) { onSnapshot(partial); } });
				}
			}
			if (pushTimer) { clearTimeout(pushTimer); }
			pushTimer = setTimeout(() => {
				pushTimer = 0;
				snapshot('auto').then(partial => { if (partial) { onSnapshot(partial); } });
			}, 600);
		},
	}));

	/**
	 * 按 id 把一张图放进画布（"到画布里改"用：`/x/imagegen/canvas/?image=<id>`）。
	 *
	 * ⚠ 与 `pullImages` 的区别：那个走**账本时间游标**（"最近出图"），
	 *   这个走**指定 id**（图可能早于游标 ⇒ 拉不到 ✗）。
	 */
	async function placeImageById(imageId) {
		const id = String(imageId || '').trim();
		if (!id) { return false; }
		if (placedImages.has(id)) { return true; }
		try {
			const res = await fetch(apiBase + '/canvas-image/' + encodeURIComponent(id), { credentials: 'same-origin' });
			if (!res.ok) {
				onStatus('取图失败（图不在「最近出图」账本里？）：HTTP ' + res.status, 'bad');
				return false;
			}
			const blob = await res.blob();
			const dataUrl = await new Promise(function (resolve) {
				const reader = new FileReader();
				reader.onload = function () { resolve(String(reader.result || '')); };
				reader.onerror = function () { resolve(''); };
				reader.readAsDataURL(blob);
			});
			if (!dataUrl) { return false; }
			// 尺寸：blob 自己解码（宿主只给 id，不给尺寸 ⇒ 猜不得 ✗）。
			let width = 0;
			let height = 0;
			try {
				const bitmap = await createImageBitmap(blob);
				width = bitmap.width;
				height = bitmap.height;
				bitmap.close();
			} catch (e) {
				width = 512;
				height = 512;
			}
			placedImages.add(id);
			await placeImage({ id, mimeType: blob.type || 'image/png', width, height, prompt: '' }, dataUrl);
			onStatus('已把选中的图放进画布', 'ok');
			return true;
		} catch (e) {
			onStatus('取图失败：' + String((e && e.message) || e), 'bad');
			return false;
		}
	}

	return {
		snapshot,
		importFiles,
		pullImages,
		placeImageById,
		/** 当前的 Excalidraw API（探针/调试用）。 */
		api: () => apiRef.current,
	};
}
