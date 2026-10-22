/**
 * 生图工作台的**页面脚本**（`/x/imagegen/`）：读承载面 → **一次取数** → 渲染壳 → 轮询刷新。
 *
 * 规范：`doc/workbench-authoring-standard.md`
 *   §4.1 URL：`/x/<module>/?surface=sideview|editor`（缺省 = 完整页）；**只登记一条路由** ✓
 *   §4.2 **一份数据获取，三个壳**（禁止为 sideview 另写一套取数逻辑 ⇒ 两份口径必分叉 ✗）
 *   §5.3 选中项共享：**S1 同源 localStorage**（`vssaros.wb.imagegen.sel`）—— 不新增桥命令 ✓
 *   §9   未知 surface ⇒ 回落完整页（页面不把自己钉死在某个 surface 上）
 *
 * ⚠ 页面里**不许**出现"点开空白"（规范 §8 第 4 行）：取数失败 ⇒ 显示原因 + 刷新按钮，不是白屏 ✓。
 */

import { PAGE_CSS, renderShell } from './views/imagegen/shell.js';

const SEL_KEY = 'vssaros.wb.imagegen.sel';
const REV_KEY = 'vssaros.wb.imagegen.rev';
/** ★ 四批⑪：画廊筛选状态（存在 localStorage ⇒ 重绘/重开都不丢 ✓）。 */
const FILTER_KEY = 'vssaros.wb.imagegen.filters';
/**
 * ★ 表单草稿（提示词 / provider / 模型 / 尺寸 / 质量 / 张数）。
 * ⚠ 为什么必须有：页面**每 5 秒轮询重绘**（重绘 = 重建 DOM）⇒ 草稿只存在 DOM 里的话，
 *   用户写到一半的字会被抹掉（真机体验：输入框根本没法用 ✗）⇒ 草稿存状态 + localStorage。
 */
const DRAFT_KEY = 'vssaros.wb.imagegen.draft';
const GALLERY_URL = '/x/imagegen/api/gallery';
const POLL_MS = 5000;

const root = document.getElementById('igwb');
const surface = normalizeSurface(document.body.dataset.vssarosSurface);
let data = { images: [], gallery: [], providers: [], canvas: null, error: '' };
let selectedId = readSel();
let filters = readFilters();
let draft = readDraft();
/** 内联大图预览（放大看）是否开着。 */
let zoom = false;
let busy = false;

/**
 * ★ 重绘前后保住"焦点 + 光标位置"（否则用户正在打字时被 5 秒轮询重绘打断 ✗）。
 *
 * ⚠ 为什么要这个：筛选状态在页面里 ⇒ 改一个字就要重绘（否则轮询会把筛选抹掉），
 *   而重绘会**重建 DOM** ⇒ 输入框失焦 ⇒ 用户打第二个字打不进去（真浏览器实测会踩）✓。
 */
function captureFocus() {
	const active = document.activeElement;
	if (!active || typeof active.getAttribute !== 'function') { return null; }
	const key = active.getAttribute('data-igb-filter')
		|| active.getAttribute('data-igb-search')
		|| active.getAttribute('data-igb-field');
	if (!key) { return null; }
	const value = String(active.value || '');
	const caret = typeof active.selectionStart === 'number' ? active.selectionStart : value.length;
	return { key, caret };
}

function restoreFocus(snapshot) {
	if (!snapshot) { return; }
	const node = document.querySelector('[data-igb-filter="' + snapshot.key + '"]')
		|| document.querySelector('[data-igb-field="' + snapshot.key + '"]')
		|| document.querySelector('[data-igb-search]');
	if (!node) { return; }
	node.focus();
	try { node.setSelectionRange(snapshot.caret, snapshot.caret); } catch (e) { /* 某些输入框不支持 */ }
}
/** 最近一条状态（重绘后要重新贴上去 —— 见 applyStatus 的说明 ✓）。 */
let lastStatus = { text: '就绪。写一句画面描述，点「生成」。', isError: false, tone: '' };

function normalizeSurface(value) {
	const text = String(value || '').trim();
	if (text === 'sideview' || text === 'editor') { return text; }
	return 'full';
}

function readSel() {
	try { return String(localStorage.getItem(SEL_KEY) || ''); } catch { return ''; }
}

function writeSel(id) {
	try { localStorage.setItem(SEL_KEY, String(id || '')); } catch { /* 隐私模式等：忽略 */ }
}

/** 读筛选状态（来源 / provider / 时间 / 关键字）。 */
function readFilters() {
	try {
		const raw = localStorage.getItem(FILTER_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return {
			source: String(parsed?.source || 'all'),
			provider: String(parsed?.provider || ''),
			range: String(parsed?.range || 'all'),
			keyword: String(parsed?.keyword || ''),
		};
	} catch {
		return { source: 'all', provider: '', range: 'all', keyword: '' };
	}
}

/** 写筛选状态。 */
function writeFilters(next) {
	filters = {
		source: String(next?.source || 'all'),
		provider: String(next?.provider || ''),
		range: String(next?.range || 'all'),
		keyword: String(next?.keyword || ''),
	};
	try { localStorage.setItem(FILTER_KEY, JSON.stringify(filters)); } catch { /* 忽略 */ }
}

/** 读表单草稿（提示词等）。 */
function readDraft() {
	try {
		const raw = localStorage.getItem(DRAFT_KEY);
		const parsed = raw ? JSON.parse(raw) : {};
		return {
			prompt: String(parsed?.prompt || ''),
			provider: String(parsed?.provider || ''),
			model: String(parsed?.model || ''),
			size: String(parsed?.size || '1024x1024'),
			quality: String(parsed?.quality || ''),
			n: Number(parsed?.n) || 1,
		};
	} catch {
		return { prompt: '', provider: '', model: '', size: '1024x1024', quality: '', n: 1 };
	}
}

/** 写表单草稿（只写状态 ⇒ **不重绘**，免得打字时输入框被打断）。 */
function writeDraft(next) {
	draft = {
		prompt: String(next?.prompt || ''),
		provider: String(next?.provider || ''),
		model: String(next?.model || ''),
		size: String(next?.size || '1024x1024'),
		quality: String(next?.quality || ''),
		n: Number(next?.n) || 1,
	};
	try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch { /* 忽略 */ }
}

function bumpRev() {
	try { localStorage.setItem(REV_KEY, String(Date.now())); } catch { /* 同上 */ }
}

const style = document.createElement('style');
style.textContent = PAGE_CSS;
document.head.appendChild(style);

/** 一次取数（画廊 + 能力表 + 画布状态）⇒ 三个壳共用这一份 ✓。 */
async function load() {
	try {
		const response = await fetch(GALLERY_URL, { credentials: 'same-origin' });
		const payload = await response.json();
		data = {
			images: Array.isArray(payload.images) ? payload.images : [],
			workspaceImages: Array.isArray(payload.workspaceImages) ? payload.workspaceImages : [],
			// 合并画廊（最近出图 + 工作区图库）；宿主没给就退回 images。
			gallery: Array.isArray(payload.gallery)
				? payload.gallery
				: (Array.isArray(payload.images) ? payload.images : []),
			providers: Array.isArray(payload.providers) ? payload.providers : [],
			canvas: payload.canvas || null,
			workspace: payload.workspace || null,
			error: payload.ok === false ? String(payload.error || '未知错误') : '',
		};
	} catch (e) {
		data = { images: [], gallery: [], providers: [], canvas: null, error: '取数失败：' + String((e && e.message) || e) };
	}
	render();
	// 取数失败要在页面上**说清楚**（规范 §8 第 10 行：不能是空白 ✗）。
	if (data.error) { setStatus(data.error, true, 'err'); }
}

function render() {
	if (!root) { return; }
	// 先记住焦点（重绘会重建 DOM ⇒ 不记就会失焦）。
	const focus = captureFocus();
	renderShell(root, {
		surface,
		data,
		selectedId,
		filters,
		draft,
		zoom,
		// 顶部徽标用：页面桥在不在（不在 ⇒ 徽标变黄，点一下重新检测）。
		bridgeOk: hasBridge(),
		handlers: {
			onSelect(id) {
				selectedId = String(id || '');
				writeSel(selectedId);
				render();
			},
			// ★ 四批⑪：筛选状态改了就存下来 + 重绘（重绘不丢 ⇒ 5 秒轮询也不怕）。
			onFilter(patch) {
				writeFilters(Object.assign({}, filters, patch));
				render();
			},
			onRefresh() { load(); },
			onOpenWorkbench() { openModulePage('/x/imagegen/'); },
			onOpenCanvas() { openModulePage('/x/imagegen/canvas/'); },
			onGenerate(options) { runAction('/x/imagegen/api/generate', options, '生成中…（可能几十秒）'); },
			onBatch(options) { runAction('/x/imagegen/api/batch', options, '批量生成中…'); },
			onSave(id) { runAction('/x/imagegen/api/save', { id }, '正在存到工作区…'); },
			// 内联大图预览开关（详情预览图 / 选中条的小图都能点开）。
			onZoom(next) { zoom = next === true; render(); },
			// 表单草稿：只写状态，不重绘（打字时不能重绘）。
			onDraft(patch) { writeDraft(patch); },
			onCopyPrompt(text) { copyPrompt(text); },
		},
	});
	// 重绘后把状态重新贴上去（否则"已生成 N 张"会被重绘抹掉 ✗）。
	applyStatus();
	// 重绘后把焦点还给输入框（否则打第二个字打不进去 ✗）。
	restoreFocus(focus);
}

/** 页面桥在不在（不在 ⇒ 顶部徽标变黄 + 点一下重新检测）。 */
function hasBridge() {
	const bridge = window.vssarosDsh;
	return !!(bridge && typeof bridge.openModulePage === 'function');
}

/** 复制提示词（详情栏 / 选中条上的动作）。 */
async function copyPrompt(text) {
	const value = String(text || '');
	if (!value) {
		setStatus('这张图没有提示词。', true, 'err');
		return;
	}
	try {
		await navigator.clipboard.writeText(value);
		setStatus('提示词已复制。', false, 'ok');
	} catch (e) {
		setStatus('复制失败（剪贴板不可用）：' + String((e && e.message) || e), true, 'err');
	}
}

/** 走页面桥打开模块页（页面 → 宿主是允许的方向 ✓；桥不在 ⇒ 如实说，不静默失败）。 */
function openModulePage(route) {
	const bridge = window.vssarosDsh;
	if (bridge && typeof bridge.openModulePage === 'function') {
		bridge.openModulePage(route);
		return;
	}
	setStatus('这一版 IDE 没有提供打开模块页的桥（页面桥版本太旧）——请升级后再试。', true, 'err');
	// 顶部徽标要跟着变黄 ⇒ 重绘一次（状态在页面上）。
	render();
}

function setStatus(text, isError, tone) {
	lastStatus = { text: String(text || ''), isError: isError === true, tone: String(tone || '') };
	applyStatus();
}

/**
 * 把状态贴到页面上。
 * ⚠ 状态必须**存在变量里**再贴：每次写操作结束都会 `load()` 重绘（重绘会重建 DOM）⇒
 *   只贴一次的话，"已生成 1 张"会在重绘后被抹掉（真浏览器点一次就发现：屏幕上什么都不剩 ✗）。
 */
function applyStatus() {
	const box = document.querySelector('[data-igb-status]');
	if (!box) { return; }
	const text = document.querySelector('[data-igb-status-text]');
	if (text) { text.textContent = lastStatus.text; }
	const tone = lastStatus.isError ? 'err' : (lastStatus.tone || '');
	box.className = 'igb-status' + (tone ? ' ' + tone : '');
}


async function post(url, payload) {
	const response = await fetch(url, {
		method: 'POST',
		credentials: 'same-origin',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload || {}),
	});
	return response.json();
}

/** 一次写操作（生成 / 批量 / 存盘）⇒ 统一口径：忙 ⇒ 拒；失败 ⇒ 如实说；成功 ⇒ 刷新。 */
async function runAction(url, payload, busyText) {
	if (busy) { return; }
	const body = payload || {};
	const prompt = String(body.prompt || '').trim();
	const prompts = Array.isArray(body.prompts) ? body.prompts : [];
	if (url.endsWith('/generate') && !prompt) {
		setStatus('先写一句画面描述再生成。', true, 'err');
		return;
	}
	if (url.endsWith('/batch') && prompts.length === 0) {
		setStatus('批量生成：一行一条画面描述，先写几行。', true, 'err');
		return;
	}
	busy = true;
	setStatus(busyText, false, 'busy');
	try {
		const result = await post(url, body);
		if (result && result.ok === false) {
			setStatus('操作失败：' + String(result.error || '原因不明'), true, 'err');
		} else {
			const images = Array.isArray(result.images) ? result.images : [];
			const failures = Array.isArray(result.failures) ? result.failures : [];
			const saved = Array.isArray(result.savedPaths) && result.savedPaths.length
				? '（已存到工作区：' + result.savedPaths.join('、') + '）' : '';
			setStatus('完成：' + images.length + ' 张' + (failures.length ? '，失败 ' + failures.length + ' 条' : '') + saved, false, 'ok');
			if (images[0]) {
				selectedId = images[0].id;
				writeSel(selectedId);
			}
			bumpRev();
		}
	} catch (e) {
		setStatus('请求失败：' + String((e && e.message) || e), true, 'err');
	} finally {
		busy = false;
		await load();
	}
}

load();
// 轮询：出图后画廊自动出现（不用手点刷新 ✓）。
setInterval(() => { if (!busy) { load(); } }, POLL_MS);
// 另一个 Pane 改了选中项 ⇒ 这里跟着（规范 §5.3 的 storage 事件）。
window.addEventListener('storage', (event) => {
	if (event.key === SEL_KEY) {
		selectedId = readSel();
		render();
	}
});
