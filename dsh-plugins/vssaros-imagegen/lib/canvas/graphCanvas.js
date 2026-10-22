/**
 * 节点画布（自研，**零新依赖**）：节点卡片 + SVG 贝塞尔连线 + 平移/缩放 + 拖拽连线。
 *
 * ★ 为什么不用现成画布库：
 *   · tldraw 的 SDK license **禁止生产使用**；React Flow 要引 React。
 *   · Excalidraw 已经 vendor 了一份（自由绘制用），但它**不是节点编辑器**（没有端口、没有依赖边）。
 *   ⇒ 自己画：DOM 节点卡片 + 一层 SVG 连线 ⇒ 20KB 出头，且能精确控制交互。
 *
 * ★ 关键实现细节（都是踩过的坑）：
 *   ① SVG 元素**必须**用 `createElementNS` 创建（用 createElement 会落进 HTML 命名空间 ⇒ 看不见 ✗）。
 *   ② 连线层要 `pointer-events: none`（否则会挡住节点拖拽）。
 *   ③ 拖拽节点时只改 style（不重建 DOM）⇒ 否则 pointer capture 断掉、拖拽中途卡死。
 *   ④ 节点宽固定 224px（与外壳 CSS 一致）⇒ 连线端点算得准。
 *
 * 交互：
 *   · 拖节点右侧圆点（输出端口）到另一个节点 ⇒ 连一条边。
 *   · 拖空白 ⇒ 平移；滚轮 ⇒ 以光标为锚点缩放。
 *   · 双击空白 ⇒ 请求新建节点（由调用方决定类型）。
 *   · 点节点 ⇒ 选中（右侧参数面板据此渲染）。
 */
const SVGNS = 'http://www.w3.org/2000/svg';

/** 节点类型 → 中文名。 */
export const KIND_NAMES = { text: '文本', image: '图片', ref: '参考素材' };
/** 节点类型 → 颜色（左侧色条）。 */
export const KIND_COLORS = { text: '#4ec9b0', image: '#c586c0', ref: '#dcdcaa' };
/** 状态 → 中文名。 */
export const STATUS_NAMES = { idle: '待运行', running: '运行中', done: '已完成', error: '失败' };
/** 节点宽度（与 canvas.css 的 `.gnode` 一致）。 */
const NODE_W = 224;
/** 节点默认高度（按类型）。 */
const DEFAULT_H = { text: 128, image: 196, ref: 178 };

/** 文本截断（卡片上显示）。 */
function clip(text, max = 46) {
	const value = String(text ?? '').replace(/\s+/g, ' ').trim();
	return value.length > max ? value.slice(0, max) + '…' : value;
}

/** 数字兜底。 */
function num(value, fallback) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * 建节点画布。
 * @param {object} options
 * @param {HTMLElement} options.viewport 可视区（平移/缩放/双击的落点）
 * @param {HTMLElement} options.world 变换层（节点卡片挂这里）
 * @param {SVGSVGElement} options.wires 连线层
 * @param {() => void} [options.onChange] 图被改了（要推给宿主）
 * @param {(id: string) => void} [options.onSelect] 选中变了
 * @param {(kind: string, x: number, y: number) => void} [options.onRequestAdd] 双击空白 ⇒ 请求建节点
 * @param {(imageId: string) => string} [options.imageUrl] 产出图的 URL
 */
export function createGraphCanvas(options) {
	const viewport = options.viewport;
	const world = options.world;
	const wires = options.wires;
	const nodeLayer = document.createElement('div');
	nodeLayer.className = 'nodes';
	nodeLayer.style.position = 'absolute';
	nodeLayer.style.left = '0';
	nodeLayer.style.top = '0';
	world.appendChild(nodeLayer);

	const state = {
		nodes: [],
		edges: [],
		selectedId: '',
		tx: 0,
		ty: 0,
		zoom: 1,
		temp: null,
		drag: null,
		link: null,
		pan: null,
		seq: 0,
	};
	/** id → 节点 DOM。 */
	const els = new Map();

	// ── 变换 ───────────────────────────────────────────────────────────────
	function applyTransform() {
		world.style.transform = 'translate(' + state.tx + 'px,' + state.ty + 'px) scale(' + state.zoom + ')';
	}

	/** 屏幕坐标 ⇒ 世界坐标。 */
	function worldPos(clientX, clientY) {
		const rect = viewport.getBoundingClientRect();
		return {
			x: (clientX - rect.left - state.tx) / state.zoom,
			y: (clientY - rect.top - state.ty) / state.zoom,
		};
	}

	// ── 渲染 ───────────────────────────────────────────────────────────────
	function nodeById(id) {
		return state.nodes.find(node => node.id === id);
	}

	function ensureEl(node) {
		let el = els.get(node.id);
		if (el) { return el; }
		el = document.createElement('div');
		el.className = 'gnode';
		el.dataset.id = node.id;
		el.innerHTML = [
			'<div class="head"><span class="kind"></span><span class="st"></span></div>',
			'<div class="body"><div class="t"></div><div class="meta"></div></div>',
			'<div class="port in"></div><div class="port out"></div>',
		].join('');
		nodeLayer.appendChild(el);
		els.set(node.id, el);
		return el;
	}

	function renderNodes() {
		const alive = new Set();
		for (const node of state.nodes) {
			alive.add(node.id);
			const el = ensureEl(node);
			el.dataset.kind = node.kind;
			el.style.left = node.x + 'px';
			el.style.top = node.y + 'px';
			el.style.width = node.width + 'px';
			el.classList.toggle('sel', node.id === state.selectedId);
			const head = el.querySelector('.head .kind');
			const st = el.querySelector('.head .st');
			const title = el.querySelector('.body .t');
			const meta = el.querySelector('.body .meta');
			head.textContent = KIND_NAMES[node.kind] || node.kind;
			st.textContent = STATUS_NAMES[node.status] || '';
			st.className = 'st ' + (node.status || 'idle');
			const body = node.kind === 'image' ? (node.prompt || node.text) : (node.text || node.prompt);
			title.textContent = clip(body) || '（空）';
			// 产出图缩略图（图片节点跑完后有 imageId）。
			const wanted = node.kind === 'image' && node.imageId ? 'img' : '';
			const current = title.parentNode.querySelector('img');
			const src = wanted && options.imageUrl ? options.imageUrl(node.imageId) : '';
			if (wanted && !current) {
				const img = document.createElement('img');
				img.alt = '产出图';
				img.src = src;
				title.parentNode.insertBefore(img, meta);
			} else if (!wanted && current) {
				current.remove();
			} else if (wanted && current && current.getAttribute('src') !== src) {
				current.src = src;
			}
			const bits = [];
			if (node.model) { bits.push('模型 ' + node.model); }
			if (node.size) { bits.push(node.size); }
			if (node.error) { bits.push(node.error); }
			meta.textContent = bits.join(' · ');
			meta.className = 'meta' + (node.error ? ' err' : '');
		}
		for (const [id, el] of [...els.entries()]) {
			if (!alive.has(id)) {
				el.remove();
				els.delete(id);
			}
		}
	}

	/** 贝塞尔连线路径。 */
	function wirePath(from, to) {
		const x1 = from.x + from.width;
		const y1 = from.y + from.height / 2;
		const x2 = to.x;
		const y2 = to.y + to.height / 2;
		const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
		return 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
	}

	function renderWires() {
		while (wires.firstChild) { wires.removeChild(wires.firstChild); }
		for (const edge of state.edges) {
			const from = nodeById(edge.fromNode);
			const to = nodeById(edge.toNode);
			if (!from || !to) { continue; }
			const path = document.createElementNS(SVGNS, 'path');
			path.setAttribute('d', wirePath(from, to));
			if (edge.fromNode === state.selectedId || edge.toNode === state.selectedId) {
				path.setAttribute('class', 'hot');
			}
			wires.appendChild(path);
		}
		if (state.temp) {
			const path = document.createElementNS(SVGNS, 'path');
			path.setAttribute('class', 'temp');
			const x1 = state.temp.x;
			const y1 = state.temp.y;
			const x2 = state.temp.tx;
			const y2 = state.temp.ty;
			const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
			path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2);
			wires.appendChild(path);
		}
	}

	function render() {
		renderNodes();
		renderWires();
		applyTransform();
	}

	// ── 图的读写 ───────────────────────────────────────────────────────────
	function setGraph(graph) {
		state.nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(node => Object.assign({}, node)) : [];
		state.edges = Array.isArray(graph?.edges) ? graph.edges.map(edge => Object.assign({}, edge)) : [];
		if (state.selectedId && !nodeById(state.selectedId)) { state.selectedId = ''; }
		render();
	}

	function getGraph() {
		return {
			nodes: state.nodes.map(node => Object.assign({}, node)),
			edges: state.edges.map(edge => Object.assign({}, edge)),
		};
	}

	function changed() {
		if (typeof options.onChange === 'function') { options.onChange(getGraph()); }
	}

	function select(id) {
		state.selectedId = String(id || '');
		render();
		if (typeof options.onSelect === 'function') { options.onSelect(state.selectedId); }
	}

	function updateNode(id, patch) {
		const node = nodeById(id);
		if (!node) { return false; }
		Object.assign(node, patch || {});
		render();
		changed();
		return true;
	}

	function addNode(kind, x, y) {
		state.seq += 1;
		const safeKind = KIND_NAMES[kind] ? kind : 'text';
		const id = 'n' + Date.now().toString(36) + '-' + state.seq;
		const node = {
			id,
			kind: safeKind,
			x: Math.round(num(x, 0)),
			y: Math.round(num(y, 0)),
			width: NODE_W,
			height: DEFAULT_H[safeKind] || 128,
			label: '',
			text: '',
			prompt: '',
			model: '',
			provider: '',
			size: '',
			quality: '',
			imageId: '',
			status: 'idle',
			error: '',
		};
		state.nodes.push(node);
		render();
		changed();
		select(id);
		return node;
	}

	function removeNode(id) {
		const before = state.nodes.length;
		state.nodes = state.nodes.filter(node => node.id !== id);
		state.edges = state.edges.filter(edge => edge.fromNode !== id && edge.toNode !== id);
		if (state.nodes.length === before) { return false; }
		if (state.selectedId === id) { select(''); }
		render();
		changed();
		return true;
	}

	function connect(fromId, toId) {
		if (!fromId || !toId || fromId === toId) { return false; }
		if (!nodeById(fromId) || !nodeById(toId)) { return false; }
		if (state.edges.some(edge => edge.fromNode === fromId && edge.toNode === toId)) { return false; }
		state.edges.push({
			id: 'e-' + fromId + '-' + toId,
			fromNode: fromId,
			fromSide: 'right',
			toNode: toId,
			toSide: 'left',
		});
		render();
		changed();
		return true;
	}

	function disconnect(edgeId) {
		const before = state.edges.length;
		state.edges = state.edges.filter(edge => edge.id !== edgeId);
		if (state.edges.length === before) { return false; }
		render();
		changed();
		return true;
	}

	/** 视野适配（把整张图摆进视口）。 */
	function fitView() {
		if (state.nodes.length === 0) {
			state.tx = 0; state.ty = 0; state.zoom = 1;
			applyTransform();
			return;
		}
		let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
		for (const node of state.nodes) {
			minX = Math.min(minX, node.x);
			minY = Math.min(minY, node.y);
			maxX = Math.max(maxX, node.x + node.width);
			maxY = Math.max(maxY, node.y + node.height);
		}
		const rect = viewport.getBoundingClientRect();
		if (!rect.width || !rect.height) { return; }
		const pad = 34;
		const zoom = Math.min(1.4, Math.max(0.4, Math.min(
			(rect.width - pad * 2) / Math.max(1, maxX - minX),
			(rect.height - pad * 2) / Math.max(1, maxY - minY),
		)));
		state.zoom = zoom;
		state.tx = (rect.width - (maxX - minX) * zoom) / 2 - minX * zoom;
		state.ty = (rect.height - (maxY - minY) * zoom) / 2 - minY * zoom;
		applyTransform();
	}

	// ── 交互 ───────────────────────────────────────────────────────────────
	viewport.addEventListener('pointerdown', event => {
		const portEl = event.target.closest ? event.target.closest('.port') : null;
		const nodeEl = event.target.closest ? event.target.closest('.gnode') : null;
		if (portEl && nodeEl) {
			// 从输出端口拉一条线。
			const node = nodeById(nodeEl.dataset.id);
			if (!node) { return; }
			event.preventDefault();
			state.link = { fromId: node.id, x: node.x + node.width, y: node.y + node.height / 2 };
			state.temp = { x: state.link.x, y: state.link.y, tx: state.link.x, ty: state.link.y };
			try { viewport.setPointerCapture(event.pointerId); } catch { /* 老浏览器没有 capture */ }
			renderWires();
			return;
		}
		if (nodeEl) {
			const node = nodeById(nodeEl.dataset.id);
			if (!node) { return; }
			event.preventDefault();
			select(node.id);
			nodeEl.classList.add('dragging');
			state.drag = {
				id: node.id,
				el: nodeEl,
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				originX: node.x,
				originY: node.y,
			};
			try { viewport.setPointerCapture(event.pointerId); } catch { /* 同上 */ }
			return;
		}
		// 空白 ⇒ 平移。
		event.preventDefault();
		select('');
		state.pan = {
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			tx: state.tx,
			ty: state.ty,
		};
		viewport.classList.add('panning');
		try { viewport.setPointerCapture(event.pointerId); } catch { /* 同上 */ }
	});

	viewport.addEventListener('pointermove', event => {
		if (state.drag) {
			const dx = (event.clientX - state.drag.startX) / state.zoom;
			const dy = (event.clientY - state.drag.startY) / state.zoom;
			const node = nodeById(state.drag.id);
			if (!node) { return; }
			node.x = Math.round(state.drag.originX + dx);
			node.y = Math.round(state.drag.originY + dy);
			render();
			return;
		}
		if (state.link) {
			const pos = worldPos(event.clientX, event.clientY);
			state.temp.tx = pos.x;
			state.temp.ty = pos.y;
			renderWires();
			return;
		}
		if (state.pan) {
			state.tx = state.pan.tx + (event.clientX - state.pan.startX);
			state.ty = state.pan.ty + (event.clientY - state.pan.startY);
			applyTransform();
		}
	});

	function endPointer(event) {
		if (state.drag) {
			state.drag.el.classList.remove('dragging');
			state.drag = null;
			changed();
		}
		if (state.link) {
			const target = document.elementFromPoint(event.clientX, event.clientY);
			const nodeEl = target && target.closest ? target.closest('.gnode') : null;
			if (nodeEl && nodeEl.dataset.id !== state.link.fromId) {
				connect(state.link.fromId, nodeEl.dataset.id);
			}
			state.link = null;
			state.temp = null;
			renderWires();
		}
		if (state.pan) {
			viewport.classList.remove('panning');
			state.pan = null;
		}
	}
	viewport.addEventListener('pointerup', endPointer);
	viewport.addEventListener('pointercancel', endPointer);

	viewport.addEventListener('wheel', event => {
		event.preventDefault();
		const rect = viewport.getBoundingClientRect();
		const px = event.clientX - rect.left;
		const py = event.clientY - rect.top;
		const before = {
			x: (px - state.tx) / state.zoom,
			y: (py - state.ty) / state.zoom,
		};
		const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
		state.zoom = Math.min(2.5, Math.max(0.25, state.zoom * factor));
		state.tx = px - before.x * state.zoom;
		state.ty = py - before.y * state.zoom;
		applyTransform();
	}, { passive: false });

	viewport.addEventListener('dblclick', event => {
		const nodeEl = event.target.closest ? event.target.closest('.gnode') : null;
		if (nodeEl) { return; }
		event.preventDefault();
		const pos = worldPos(event.clientX, event.clientY);
		if (typeof options.onRequestAdd === 'function') { options.onRequestAdd(pos.x, pos.y); }
	});

	viewport.addEventListener('contextmenu', event => {
		// 右键连线 ⇒ 断开它（不然只能一条条删节点才能断线 ✗）。
		const path = event.target.closest ? event.target.closest('path') : null;
		if (!path) { return; }
		event.preventDefault();
		const index = [...wires.children].indexOf(path);
		const edge = state.edges[index];
		if (edge) { disconnect(edge.id); }
	});

	render();

	return {
		setGraph,
		getGraph,
		updateNode,
		addNode,
		removeNode,
		connect,
		disconnect,
		select,
		fitView,
		/** 当前选中的节点 id。 */
		selectedId: () => state.selectedId,
		/** 当前视图状态（缩放/平移）。 */
		view: () => ({ tx: state.tx, ty: state.ty, zoom: state.zoom }),
	};
}
