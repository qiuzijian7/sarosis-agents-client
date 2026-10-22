/**
 * 画布工作台页（`/x/imagegen/canvas/`）—— **外壳**：双模式 + 与宿主同步。
 *
 * 这一页有两种形态（顶栏一键切）：
 *   · 自由绘制（Excalidraw）：手绘参考、贴图、按选区改图。
 *   · 节点工作流（自研）：节点 + 连线 ⇒ 按拓扑序批量出图。
 *
 * ★ 与宿主的通道：画布页是独立 webview ⇒ 只能同源 fetch。
 *   · 场景/模式 ⇒ POST /x/imagegen/api/canvas-state
 *   · 节点图 ⇒ POST /x/imagegen/api/canvas-graph（带 revision，冲突则合并）
 *   · 跑图 ⇒ POST /x/imagegen/api/canvas-run
 *
 * ★ Excalidraw（713KB）是**懒加载**的：只有真的进了自由绘制模式才下载。
 */
import { createGraphCanvas, KIND_NAMES, STATUS_NAMES } from './graphCanvas.js';

const API = '/x/imagegen/api';
/** 本页实例 id：同时开两个画布页时，宿主按"最后活跃的那个"作答。 */
const CLIENT_INSTANCE = 'cv-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
/** 模式记忆（刷新后还在）。 */
const MODE_KEY = 'vssaros.canvas.mode';

/** 推送序号（单调递增）：宿主用它挡住乱序/重连补发的旧消息。 */
let sequence = 0;
/** 当前模式：free | graph。 */
let mode = 'free';
/** 自由绘制层（懒加载后才存在）。 */
let free = null;
/** 节点画布。 */
let graphCanvas = null;
/** 当前节点图（本地副本；宿主侧那份是真源）。 */
let graph = { nodes: [], edges: [] };
/** 宿主给的节点图版本号（乐观并发用）。 */
let graphRevision = 0;
/** 本地有还没推给宿主的改动？ */
let graphDirty = false;
/** 乐观更新期间（本地临时状态，别推给宿主）。 */
let suppressPush = false;
/** 当前选中的节点 id。 */
let selectedNodeId = '';
let pushTimer = 0;

/** 取元素。 */
const $ = id => document.getElementById(id);

/** HTML 转义（用户输入进 innerHTML 前必须过这一层）。 */
function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, ch => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[ch]));
}

/** 文本截断。 */
function clip(value, max = 28) {
	const text = String(value ?? '').replace(/\s+/g, ' ').trim();
	return text.length > max ? text.slice(0, max) + '…' : text;
}

/** 连接徽标。 */
function setConn(text, tone) {
	const el = $('conn');
	if (!el) { return; }
	el.textContent = text;
	el.dataset.tone = tone || '';
}

/** 运行日志（底部）。 */
function log(text, tone) {
	const box = $('runlog');
	if (!box) { return; }
	const line = document.createElement('div');
	line.className = 'line' + (tone ? ' ' + tone : '');
	line.textContent = text;
	box.appendChild(line);
	box.scrollTop = box.scrollHeight;
	while (box.childElementCount > 200) { box.removeChild(box.firstChild); }
}

async function postJson(path, body) {
	const res = await fetch(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		credentials: 'same-origin',
		body: JSON.stringify(body),
	});
	if (!res.ok) { throw new Error('HTTP ' + res.status); }
	return res.json();
}

async function getJson(path) {
	const res = await fetch(path, { credentials: 'same-origin' });
	if (!res.ok) { throw new Error('HTTP ' + res.status); }
	return res.json();
}

/**
 * 把当前状态推给宿主（场景 + 模式 + 选中的节点）。
 * ⚠ 选区截图的"preparing / ready / error"三态由**自由绘制层**算好后带过来
 *   （见 `freeCanvas.js` 的 snapshot）⇒ 这里只负责组装 + 推送。
 */
async function pushState() {
	try {
		// ⚠ 自由绘制的现场是**缓存**的（自由绘制层自己算好才给过来）——
		//   每次推都重导选区截图会卡死（导出 PNG 挺慢的）。
		const partial = mode === 'free'
			? freePartial
			: { elementCount: 0, selectedIds: [], selection: [], selectionStatus: 'none' };
		await postJson(API + '/canvas-state', {
			clientInstance: CLIENT_INSTANCE,
			sequence: ++sequence,
			updatedAt: Date.now(),
			mode,
			selectedNodeId: mode === 'graph' ? selectedNodeId : '',
			...partial,
		});
		setConn('已同步', 'ok');
	} catch (e) {
		setConn('同步失败', 'bad');
	}
}

/** 节点图改了 ⇒ 推给宿主（带版本号；冲突则合并）。 */
function scheduleGraphPush() {
	// ★ 乐观更新（本地先把节点标成"运行中"）时**不要推**（否则把临时状态写进真源 ✗）。
	if (suppressPush) { return; }
	graphDirty = true;
	if (pushTimer) { clearTimeout(pushTimer); }
	pushTimer = setTimeout(() => { pushTimer = 0; void pushGraph(); }, 400);
}

async function pushGraph() {
	try {
		const reply = await postJson(API + '/canvas-graph', { graph, baseRevision: graphRevision });
		graphRevision = Number(reply?.revision ?? graphRevision);
		graphDirty = false;
		if (reply?.conflict === true) {
			log('宿主侧也改了节点图 ⇒ 两边已合并（你的改动没丢）', 'warn');
			if (reply.graph) {
				graph = reply.graph;
				if (graphCanvas) { graphCanvas.setGraph(graph); }
				renderOutline();
				renderPanel();
			}
		}
		setConn('已同步', 'ok');
	} catch (e) {
		setConn('推图失败', 'bad');
		log('推节点图失败：' + String(e?.message ?? e), 'bad');
	}
}

/** 拉宿主那边的节点图（Agent 工具改过 ⇒ 这里能看到）。 */
async function pullGraph() {
	try {
		const data = await getJson(API + '/canvas-graph');
		if (!data || data.ok !== true) { return; }
		if (graphDirty) { return; }
		if (Number(data.revision) > graphRevision) {
			graphRevision = Number(data.revision);
			graph = data.graph || graph;
			if (graphCanvas) { graphCanvas.setGraph(graph); }
			renderOutline();
			renderPanel();
			log('已同步宿主的节点图改动', 'ok');
		}
	} catch (e) {
		/* 拉不到就下轮再试（不打断用户）✓ */
	}
}

/** 左侧大纲。 */
function renderOutline() {
	const box = $('outline');
	if (!box) { return; }
	if (mode !== 'graph') {
		box.innerHTML = '<div class="hint">（切到「节点工作流」看节点大纲）</div>';
		return;
	}
	if (graph.nodes.length === 0) {
		box.innerHTML = '<div class="hint">还没有节点。点上面「添加节点」，或双击画布空白。</div>';
		return;
	}
	box.innerHTML = graph.nodes.map(node => {
		const title = node.label || node.prompt || node.text || node.id;
		const status = node.kind === 'image' ? (STATUS_NAMES[node.status] || '') : '';
		const color = node.kind === 'image' ? '#c586c0' : (node.kind === 'ref' ? '#dcdcaa' : '#4ec9b0');
		return '<div class="outline-item' + (node.id === selectedNodeId ? ' on' : '') + '" data-id="'
			+ esc(node.id) + '"><span class="dot" style="background:' + color
			+ '"></span><span class="txt">' + esc(title) + '</span>'
			+ (status ? '<span class="hint" style="margin:0">' + esc(status) + '</span>' : '') + '</div>';
	}).join('');
	for (const item of box.querySelectorAll('.outline-item')) {
		item.addEventListener('click', () => {
			selectedNodeId = item.dataset.id;
			if (graphCanvas) { graphCanvas.select(selectedNodeId); }
			renderOutline();
			renderPanel();
		});
	}
}

/** 右侧参数面板。 */
function renderPanel() {
	const panel = $('right');
	if (!panel) { return; }
	if (mode !== 'graph') {
		panel.innerHTML = '<h4>说明</h4><div class="hint">自由绘制：手绘参考、贴图，然后让 Agent 按选区改图。</div>'
			+ '<div class="hint">要批量出图？切到「节点工作流」：节点 + 连线 ⇒ 按拓扑序跑。</div>';
		return;
	}
	const node = graph.nodes.find(item => item.id === selectedNodeId);
	if (!node) {
		panel.innerHTML = '<h4>节点参数</h4><div class="hint">选中一个节点来改它的参数；双击画布空白可以新建节点。</div>'
			+ '<div class="hint">当前图：' + graph.nodes.length + ' 个节点 / ' + graph.edges.length + ' 条连线。</div>';
		return;
	}
	const upstream = graph.edges
		.filter(edge => edge.toNode === node.id)
		.map(edge => graph.nodes.find(item => item.id === edge.fromNode))
		.filter(Boolean);
	const upstreamText = upstream.length
		? upstream.map(item => (KIND_NAMES[item.kind] || item.kind) + '「' + clip(item.label || item.prompt || item.text || item.id) + '」').join('、')
		: '（无 —— 没有上游继承）';
	const kindName = KIND_NAMES[node.kind] || node.kind;
	const fields = [];
	fields.push('<h4>节点参数</h4>');
	fields.push('<div class="field"><label>类型</label><div class="hint">' + esc(kindName) + ' · ' + esc(node.id) + '</div></div>');
	fields.push('<div class="field"><label>名称</label><input id="f-label" type="text"></div>');
	if (node.kind === 'image') {
		fields.push('<div class="field"><label>提示词</label><textarea id="f-prompt"></textarea></div>');
		fields.push('<div class="field"><label>模型 id</label><input id="f-model" type="text"></div>');
		fields.push('<div class="field"><label>尺寸</label><input id="f-size" type="text"></div>');
	} else if (node.kind === 'ref') {
		fields.push('<div class="field"><label>参考图 id</label><input id="f-image" type="text"></div>');
		fields.push('<div class="field"><label>说明</label><textarea id="f-text"></textarea></div>');
	} else {
		fields.push('<div class="field"><label>内容</label><textarea id="f-text"></textarea></div>');
	}
	fields.push('<div class="field"><label>上游继承</label><div class="hint">' + esc(upstreamText) + '</div></div>');
	if (node.kind === 'image' && node.imageId) {
		fields.push('<div class="field"><label>产出图</label><div class="hint">' + esc(node.imageId) + '</div></div>');
	}
	if (node.error) {
		fields.push('<div class="hint bad">' + esc(node.error) + '</div>');
	}
	fields.push('<div class="rowbtns"><button type="button" id="b-run-one">只跑这个节点</button>'
		+ '<button type="button" id="b-del" class="danger">删除节点</button></div>');
	panel.innerHTML = fields.join('');

	const patch = {};
	const bind = (id, key) => {
		const el = $(id);
		if (!el) { return; }
		el.value = String(node[key] ?? '');
		el.addEventListener('input', event => {
			patch[key] = event.target.value;
			if (graphCanvas) { graphCanvas.updateNode(node.id, patch); }
			renderOutline();
		});
	};
	bind('f-label', 'label');
	bind('f-prompt', 'prompt');
	bind('f-model', 'model');
	bind('f-size', 'size');
	bind('f-image', 'imageId');
	bind('f-text', 'text');

	const runOne = $('b-run-one');
	if (runOne) {
		runOne.addEventListener('click', () => { void runGraph(node.id); });
	}
	const del = $('b-del');
	if (del) {
		del.addEventListener('click', () => {
			if (!graphCanvas) { return; }
			graphCanvas.removeNode(node.id);
			selectedNodeId = '';
			renderOutline();
			renderPanel();
		});
	}
}

/** 跑图（整张图或单个节点）。 */
async function runGraph(onlyNodeId) {
	const btn = $('btn-run');
	if (btn) { btn.disabled = true; }
	log(onlyNodeId ? '开始运行节点 ' + onlyNodeId + '…' : '开始按拓扑序运行…', 'ok');
	// ★ 先把要跑的节点标成"运行中"（本地乐观更新）——
	//   宿主是**同步**跑图（POST 要等全部跑完才回）⇒ 没有这步的话，
	//   屏幕上几十秒毫无变化，用户不知道到底跑没跑（看着像卡死了 ✗）。
	const pending = graph.nodes
		.filter(node => node.kind === 'image' && (!onlyNodeId || node.id === onlyNodeId))
		.map(node => node.id);
	suppressPush = true;
	for (const id of pending) {
		if (graphCanvas) { graphCanvas.updateNode(id, { status: 'running', error: '' }); }
	}
	suppressPush = false;
	if (graphCanvas) { graph = graphCanvas.getGraph(); }
	renderOutline();
	try {
		const reply = await postJson(API + '/canvas-run', {
			graph,
			...(onlyNodeId ? { nodeId: onlyNodeId } : {}),
		});
		if (reply?.graph) {
			graph = reply.graph;
			graphRevision = Number(reply?.revision ?? graphRevision);
			if (graphCanvas) { graphCanvas.setGraph(graph); }
		}
		const results = Array.isArray(reply?.results) ? reply.results : [];
		let okCount = 0;
		for (const item of results) {
			if (item.ok) {
				okCount += 1;
				log('✓ ' + (item.title || item.nodeId) + '（图 id：' + (item.imageId || '无') + '）', 'ok');
			} else {
				log('✗ ' + (item.title || item.nodeId) + '：' + String(item.error || '失败'), 'bad');
			}
		}
		log('运行结束：成功 ' + okCount + ' / 共 ' + results.length + ' 个节点。', okCount === results.length ? 'ok' : 'warn');
		renderOutline();
		renderPanel();
	} catch (e) {
		log('运行失败：' + String(e?.message ?? e), 'bad');
	} finally {
		if (btn) { btn.disabled = false; }
	}
}

/** 导出 JSON Canvas 1.0（通用格式 ⇒ Obsidian Canvas / dsh-noteboard 能读）。 */
async function exportGraph() {
	try {
		const data = await getJson(API + '/canvas-graph/export');
		const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = 'canvas-' + new Date().toISOString().slice(0, 10) + '.canvas.json';
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		log('已导出 JSON Canvas（' + data.nodes.length + ' 个节点 / ' + data.edges.length + ' 条连线）', 'ok');
	} catch (e) {
		log('导出失败：' + String(e?.message ?? e), 'bad');
	}
}

/** 导入 JSON Canvas 1.0。 */
async function importGraphFile(file) {
	try {
		const text = await file.text();
		const payload = JSON.parse(text);
		const reply = await postJson(API + '/canvas-graph/import', payload);
		const pulled = await getJson(API + '/canvas-graph');
		graph = pulled?.graph || graph;
		graphRevision = Number(pulled?.revision ?? reply?.revision ?? graphRevision);
		if (graphCanvas) { graphCanvas.setGraph(graph); }
		renderOutline();
		renderPanel();
		log('已导入：' + graph.nodes.length + ' 个节点 / ' + graph.edges.length + ' 条连线', 'ok');
	} catch (e) {
		log('导入失败：' + String(e?.message ?? e), 'bad');
	}
}

/** 自由绘制层的最新现场（缓存 ⇒ 推状态时不用每次重导选区截图，费时）。 */
let freePartial = { elementCount: 0, selectedIds: [], selection: [], selectionStatus: 'none' };

/** 建节点画布（第一次进节点模式时）。 */
function ensureGraphCanvas() {
	if (graphCanvas) { return graphCanvas; }
	graphCanvas = createGraphCanvas({
		viewport: $('graph-viewport'),
		world: $('graph-world'),
		wires: $('graph-wires'),
		onChange: next => {
			graph = next;
			scheduleGraphPush();
			renderOutline();
			// ★ 右栏也要跟着刷（连完线右边的"连线数"不能还是旧的 ✗）。
			renderPanel();
		},
		onSelect: id => {
			selectedNodeId = id;
			renderOutline();
			renderPanel();
			void pushState('auto');
		},
		onRequestAdd: (x, y) => { addNodeAt('text', x, y); },
		imageUrl: id => API + '/canvas-image/' + encodeURIComponent(id),
	});
	graphCanvas.setGraph(graph);
	return graphCanvas;
}

/** 视口中心的世界坐标（新建节点放这儿）。 */
function centerWorld() {
	const vp = $('graph-viewport');
	const rect = vp ? vp.getBoundingClientRect() : { width: 0, height: 0 };
	const view = graphCanvas ? graphCanvas.view() : { tx: 0, ty: 0, zoom: 1 };
	return {
		x: (rect.width / 2 - view.tx) / view.zoom,
		y: (rect.height / 2 - view.ty) / view.zoom,
	};
}

/** 新建节点。 */
function addNodeAt(kind, x, y) {
	ensureGraphCanvas();
	// ⚠ 每次都放同一个点 ⇒ 新节点全叠在一起（看着像只有一个节点 ✗）⇒ 错开摆。
	//   三列一排（以视口中心为基准左右展开）⇒ 三个节点都在视野里（超出视口的节点没法拖线 ✗）。
	const count = graph.nodes.length;
	const col = count % 3;
	const row = Math.floor(count / 3);
	const node = graphCanvas.addNode(kind, x + (col - 1) * 250, y + row * 190);
	graph = graphCanvas.getGraph();
	selectedNodeId = node.id;
	scheduleGraphPush();
	renderOutline();
	renderPanel();
}

/** 懒加载自由绘制层（Excalidraw 713KB ⇒ 只在真的要画的时候才下）。 */
async function ensureFree(initialScene) {
	if (free) { return free; }
	const mod = await import('./freeCanvas.js');
	free = await mod.mountFreeCanvas({
		host: $('cv-root'),
		apiBase: API,
		initial: initialScene,
		onSnapshot: partial => {
			if (partial) { freePartial = partial; }
			void pushState('auto');
		},
		onStatus: (text, tone) => { log(text, tone); },
	});
	// ★ 挂上就拉一次「最近出图」⇒ 之前（哪怕是节点模式跑出来的）图能落到自由绘制层。
	void free.pullImages();
	return free;
}

/** 切模式。 */
async function setMode(next, initialScene) {
	if (next !== 'free' && next !== 'graph') { return; }
	mode = next;
	try { localStorage.setItem(MODE_KEY, mode); } catch { /* 隐私模式下写不了，忽略 ✓ */ }
	for (const btn of document.querySelectorAll('#mode-seg button')) {
		btn.classList.toggle('on', btn.dataset.mode === mode);
	}
	const root = $('cv-root');
	if (root) { root.classList.toggle('hidden', mode !== 'free'); }
	const graphHost = $('graph-host');
	if (graphHost) { graphHost.classList.toggle('on', mode === 'graph'); }
	for (const id of ['btn-run', 'btn-export', 'btn-import', 'btn-clear']) {
		const el = $(id);
		if (el) { el.hidden = mode !== 'graph'; }
	}
	const insert = $('btn-insert');
	if (insert) { insert.hidden = mode !== 'free'; }
	if (mode === 'graph') {
		ensureGraphCanvas();
		graphCanvas.fitView();
	} else {
		await ensureFree(initialScene);
		// ★ 从节点模式切回来 ⇒ 节点跑出来的图得落上（轮询只在自由绘制模式跑，切回来要补拉一次 ✗）。
		if (free) { void free.pullImages(); }
	}
	renderOutline();
	renderPanel();
	await pushState('auto');
}

/** 接线（顶栏 / 左栏 / 快捷键 / 拖放）。 */
function wireUi() {
	for (const btn of document.querySelectorAll('#mode-seg button')) {
		btn.addEventListener('click', () => { void setMode(btn.dataset.mode); });
	}
	const runBtn = $('btn-run');
	if (runBtn) { runBtn.addEventListener('click', () => { void runGraph(); }); }
	const exportBtn = $('btn-export');
	if (exportBtn) { exportBtn.addEventListener('click', () => { void exportGraph(); }); }
	const importBtn = $('btn-import');
	const importFile = $('file-import');
	if (importBtn && importFile) {
		importBtn.addEventListener('click', () => importFile.click());
		importFile.addEventListener('change', () => {
			const file = importFile.files && importFile.files[0];
			if (file) { void importGraphFile(file); }
			importFile.value = '';
		});
	}
	const insertBtn = $('btn-insert');
	const imageFile = $('file-image');
	if (insertBtn && imageFile) {
		insertBtn.addEventListener('click', () => imageFile.click());
		imageFile.addEventListener('change', () => {
			if (free) { void free.importFiles(imageFile.files); }
			imageFile.value = '';
		});
	}
	const refreshBtn = $('btn-refresh');
	if (refreshBtn) { refreshBtn.addEventListener('click', () => location.reload()); }
	// 清空图（跑乱了重来）——⚠ 清空**不可撤销** ⇒ 要用户确认一次。
	const clearBtn = $('btn-clear');
	if (clearBtn) {
		clearBtn.addEventListener('click', () => {
			if (!graphCanvas) { return; }
			if (graph.nodes.length === 0) { return; }
			if (!window.confirm('清空这张节点图？' + graph.nodes.length + ' 个节点会没了（不可撤销）。')) { return; }
			graphCanvas.setGraph({ nodes: [], edges: [] });
			graph = graphCanvas.getGraph();
			selectedNodeId = '';
			scheduleGraphPush();
			renderOutline();
			renderPanel();
			log('已清空节点图', 'warn');
		});
	}
	for (const btn of document.querySelectorAll('.addbtn')) {
		btn.addEventListener('click', () => {
			const center = centerWorld();
			addNodeAt(btn.dataset.kind, center.x, center.y);
		});
	}
	// 拖放：图片进自由绘制层。
	window.addEventListener('dragover', event => { event.preventDefault(); });
	window.addEventListener('drop', event => {
		event.preventDefault();
		const files = event.dataTransfer ? event.dataTransfer.files : null;
		if (files && files.length && free) { void free.importFiles(files); }
	});
	// Delete：删掉选中的节点。
	window.addEventListener('keydown', event => {
		if (mode !== 'graph') { return; }
		if (event.key !== 'Delete' && event.key !== 'Backspace') { return; }
		const tag = (event.target && event.target.tagName) || '';
		if (tag === 'INPUT' || tag === 'TEXTAREA') { return; }
		if (!selectedNodeId || !graphCanvas) { return; }
		event.preventDefault();
		graphCanvas.removeNode(selectedNodeId);
		selectedNodeId = '';
		renderOutline();
		renderPanel();
	});
}

/** 启动。 */
async function boot() {
	wireUi();
	// ① 拉回上次的状态（场景 + 节点图）。
	let initialScene = { elements: [], appState: {}, files: {} };
	let hostMode = 'free';
	try {
		const data = await getJson(API + '/canvas-state');
		if (data && data.scene) { initialScene = data.scene; }
		if (data && data.mode === 'graph') { hostMode = 'graph'; }
	} catch (e) {
		log('取上次场景失败（先用空的）：' + String(e?.message ?? e), 'bad');
	}
	try {
		const data = await getJson(API + '/canvas-graph');
		if (data && data.ok === true) {
			graph = data.graph || graph;
			graphRevision = Number(data.revision ?? 0);
		}
	} catch (e) {
		/* 节点图拿不到 ⇒ 空图起步 ✓ */
	}
	// ② 模式：本地记忆优先（用户上次选的那个），否则用宿主记的。
	let remembered = hostMode;
	try { remembered = localStorage.getItem(MODE_KEY) || hostMode; } catch { /* 忽略 ✓ */ }
	await setMode(remembered === 'graph' ? 'graph' : 'free', initialScene);
	// ③ 心跳与轮询。
	setInterval(() => { void pullGraph(); }, 3000);
	setInterval(() => {
		if (mode === 'free' && free) { void free.pullImages(); }
	}, 3000);
	setInterval(() => { void pushState(); }, 5000);
	log('画布工作台已就绪（自由绘制 / 节点工作流 两套模式）', 'ok');
}

void boot();
