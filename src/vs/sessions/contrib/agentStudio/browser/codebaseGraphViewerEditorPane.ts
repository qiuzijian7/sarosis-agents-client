/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Viewer EditorPane — 原生 tree-sitter 解析 + Three.js 3D 渲染
 *
 * 实现方式：
 * 1. 通过 ICodebaseGraphService 直接获取内存中的 graph 数据（无 MCP 开销）
 * 2. 在 webview 中用力导向布局算法计算 3D 坐标
 * 3. 使用 Three.js (via CDN) 渲染交互式 3D 图谱
 * 4. 支持节点点击 → 在 VS Code 中打开代码文件
 *
 * 无外部二进制依赖，直接使用 VS Code 内置 tree-sitter WASM。
 */

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { ICodebaseGraphService, VisualizationData } from './codebaseGraphService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

const LOG_TAG = '[CodebaseGraphViewer]';

export class CodebaseGraphViewerEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.codebaseGraphViewer';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private _statusEl: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@ILogService private readonly _logService: ILogService,
		@ICodebaseGraphService private readonly _graphService: ICodebaseGraphService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IOpenerService private readonly _openerService: IOpenerService,
	) {
		super(CodebaseGraphViewerEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('codebase-graph-viewer-pane');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: CodebaseGraphViewerEditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!this._container) { return; }

		this._showLoading('正在加载 3D Graph 可视化...');
		await this._loadVisualization(token);
	}

	// ─── Core: Load Visualization via Native Graph Service ──────────────

	private async _loadVisualization(token: CancellationToken): Promise<void> {
		try {
			const DOWNSAMPLE_THRESHOLD = 50000;

			// 1. 轻量级检查：图中是否有数据（不创建完整数组）
			let hasData = this._graphService.hasGraphData();

			// 2. 如果图为空，尝试加载已保存的 graph.json
			if (!hasData) {
				this._showLoading('正在加载代码图谱...');
				const folders = this._workspaceService.getWorkspace().folders;
				if (folders.length === 0) {
					this._showError('未打开工作区。');
					return;
				}
				const wsUri = folders[0].uri;
				const graphFileUri = URI.joinPath(wsUri, '.codebase-memory', 'graph.db.zst');
				const loaded = await this._graphService.loadGraph(graphFileUri.fsPath);
				if (!loaded) {
					this._showError('代码图谱为空。请在 Codebase Memory 面板中索引代码库。');
					return;
				}
				hasData = this._graphService.hasGraphData();
			}

			if (token.isCancellationRequested) { return; }

			if (!hasData) {
				this._showError('图谱为空。请先索引代码库。');
				return;
			}

			this._showLoading('正在准备图谱数据...');

			// 3. 让 UI 有机会渲染 loading 状态
			await new Promise<void>(resolve => setTimeout(resolve, 0));

			// 4. 获取预计算的可视化数据（service 层已计算位置/颜色/大小，webview 直接渲染）
			const vizData = this._graphService.getVisualizationData(DOWNSAMPLE_THRESHOLD);

			if (token.isCancellationRequested) { return; }

			this._logService.info(LOG_TAG, `Visualization data ready: ${vizData.nodes.length}/${vizData.totalNodes} nodes, ${vizData.edges.length} edges`);
			this._showLoading(`正在渲染 ${vizData.nodes.length} 个节点...`);

			// 5. 获取 graph 文件路径用于显示
			let graphPath = '';
			try {
				const status = await this._graphService.getGraphStatus();
				graphPath = status.graphPath || '';
			} catch { /* ignore */ }

			if (token.isCancellationRequested) { return; }

			// 6. 在 webview 中渲染（数据已预计算，webview 直接渲染）
			this._renderGraphDirect(vizData, graphPath, vizData.totalNodes > vizData.nodes.length, vizData.totalNodes);

		} catch (err: any) {
			const msg = err?.message || String(err);
			this._logService.error(LOG_TAG, 'Failed to load visualization:', err);
			this._showError(`加载可视化失败: ${msg}`);
		}
	}

	// ─── Rendering: Three.js 3D Graph with Force-Directed Layout ─────────

	private _renderGraphDirect(vizData: VisualizationData, graphPath: string, wasDownsampled: boolean, totalNodes: number): void {
		if (!this._container) { return; }

		this._clearStatus();
		this._disposeWebview();

		const graphPathDisplay = graphPath || 'N/A';
		const totalEdges = vizData.edges.length;

		this._logService.info(LOG_TAG, `Rendering graph: ${vizData.nodes.length} nodes (total: ${totalNodes}, downsampled: ${wasDownsampled}), ${totalEdges} edges`);

		// 数据已限制大小（10k 节点 + 50k 边 ≈ 5MB），直接内嵌 HTML
		const html = this._makeHtmlTemplate(graphPathDisplay, wasDownsampled, totalNodes, totalEdges, vizData);

		this._webview = this._webviewService.createWebviewElement({
			title: 'Codebase Graph 3D Visualization',
			options: {
				enableFindWidget: true,
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				localResourceRoots: [],
			},
			extension: undefined,
		});

		this._register(this._webview);
		this._webview.mountTo(this._container, mainWindow);
		this._webview.setHtml(html);

		// 消息处理：open-file, refresh-graph
		this._register(this._webview.onMessage((msg: any) => {
			if (msg.type === 'open-file') {
				this._openFileInEditor(msg.filePath, msg.qualifiedName);
			} else if (msg.type === 'refresh-graph') {
				this._logService.info(LOG_TAG, 'Refresh requested by user');
				this._loadVisualization(CancellationToken.None).catch(err => {
					this._logService.error(LOG_TAG, 'Refresh failed:', err);
				});
			}
		}));

		this._logService.info(LOG_TAG, `Webview mounted with embedded data (${vizData.nodes.length} nodes, ${vizData.edges.length} edges)`);
	}

	/**
	 * 生成 webview HTML 模板（不含 graph 数据，数据通过 postMessage 传递）
	 */
	private _makeHtmlTemplate(graphPathDisplay: string, wasDownsampled: boolean, totalNodes: number, totalEdges: number, vizData: VisualizationData): string {
		const warning = wasDownsampled
			? `<div id="downsample-warn" style="position:absolute;top:60px;left:50%;transform:translateX(-50%);background:rgba(220,220,170,0.15);color:#dcdcaa;padding:6px 16px;border-radius:6px;font-size:12px;z-index:10;">⚠️ 数据已降级：显示 ${totalNodes} 个节点中的 10000 个（按连接数排序）。在 Codebase Memory 面板中切换过滤条件可探索子集。</div>`
			: '';

		return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https:; script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' 'unsafe-inline' data: blob: https:; connect-src 'self' https:;">
<title>Codebase Graph 3D Visualization</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { overflow: hidden; background: #06090f; font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
#canvas-container { width: 100vw; height: 100vh; position: relative; }
#loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 18px; z-index: 100; }
#info-panel { position: absolute; top: 20px; left: 20px; background: rgba(6,9,15,0.95); color: #fff; padding: 16px 20px; border-radius: 12px; font-size: 13px; max-width: 420px; display: none; z-index: 100; backdrop-filter: blur(12px); border: 1px solid rgba(128,160,255,0.25); box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden; }
#info-panel h3 { margin: 0 0 10px 0; font-size: 15px; color: #80a0ff; text-shadow: 0 0 10px rgba(128,160,255,0.3); }
#info-panel .meta { color: #aaa; font-size: 12px; margin-bottom: 12px; }
#info-panel .section { margin: 10px 0; }
#info-panel .label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
#info-panel .value { color: #fff; margin-top: 4px; word-break: break-all; }
#info-panel .close-btn { position: absolute; top: 10px; right: 14px; cursor: pointer; color: #888; font-size: 18px; }
#info-panel .close-btn:hover { color: #fff; }
#info-panel .open-btn { margin-top: 12px; padding: 6px 16px; background: #1976d2; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; }
#info-panel .open-btn:hover { background: #1565c0; }
#stats { position: absolute; bottom: 20px; left: 20px; color: #aaa; font-size: 12px; z-index: 10; }
#controls { position: absolute; top: 20px; right: 20px; z-index: 10; }
#controls button { background: rgba(0,0,0,0.7); color: #fff; border: 1px solid rgba(255,255,255,0.2); padding: 8px 14px; margin-left: 8px; border-radius: 6px; cursor: pointer; font-size: 12px; }
#controls button:hover { background: rgba(255,255,255,0.15); }
#filter-panel { position: absolute; top: 0; left: 0; width: 260px; height: 100vh; background: rgba(6,9,15,0.95); color: #ccc; overflow-y: auto; z-index: 20; border-right: 1px solid rgba(128,160,255,0.15); backdrop-filter: blur(10px); font-size: 12px; }
#filter-panel .fp-header { padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
#filter-panel .fp-stats { font-size: 13px; color: #80a0ff; font-weight: 600; }
#filter-panel .fp-section { padding: 10px 16px; }
#filter-panel .fp-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
#filter-panel .fp-allnone { display: flex; gap: 4px; }
#filter-panel .fp-allnone button { background: rgba(255,255,255,0.08); color: #aaa; border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; }
#filter-panel .fp-allnone button:hover { background: rgba(255,255,255,0.2); color: #fff; }
#filter-panel .fp-group-title { font-size: 11px; color: #888; margin: 10px 0 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; cursor: pointer; display: flex; align-items: center; gap: 4px; user-select: none; }
#filter-panel .fp-group-title:hover { color: #fff; }
#filter-panel .fp-group-title .fp-toggle { font-size: 9px; color: #666; transition: transform 0.15s ease; }
#filter-panel .fp-group-title.collapsed .fp-toggle { transform: rotate(-90deg); }
#filter-panel .fp-group-content { overflow: hidden; transition: max-height 0.2s ease; }
#filter-panel .fp-group-content.collapsed { display: none; }
#filter-panel .fp-item { display: flex; align-items: center; gap: 6px; padding: 3px 0; cursor: pointer; }
#filter-panel .fp-item:hover { color: #fff; }
#filter-panel .fp-item input { accent-color: #80a0ff; cursor: pointer; }
#filter-panel .fp-item label { flex: 1; cursor: pointer; font-size: 12px; text-transform: capitalize; }
#filter-panel .fp-item .fp-count { color: #555; font-size: 11px; font-family: monospace; }
#filter-panel .fp-checkbox { display: flex; align-items: center; gap: 6px; padding: 6px 0; }
#filter-panel .fp-checkbox input { accent-color: #80a0ff; cursor: pointer; }
#filter-panel .fp-checkbox label { cursor: pointer; font-size: 12px; }
#filter-panel .fp-search { margin: 8px 0; }
#filter-panel .fp-search input { width: 100%; padding: 5px 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; color: #fff; font-size: 12px; outline: none; }
#filter-panel .fp-search input:focus { border-color: rgba(128,160,255,0.5); }
#filter-panel .fp-search input::placeholder { color: #555; }
#filter-panel .fp-dir-list { margin-top: 6px; }
#filter-panel .fp-dir-item { padding: 2px 0 2px 8px; cursor: pointer; font-size: 11px; color: #888; }
#filter-panel .fp-dir-item:hover { color: #fff; }
#filter-panel .fp-dir-item.active { color: #80a0ff; }
#graph-path { position: absolute; top: 20px; right: 20px; color: #555; font-size: 11px; max-width: 400px; text-align: right; z-index: 10; word-break: break-all; font-family: monospace; }
</style>
</head>
<body>
<div id="canvas-container">
  <div id="filter-panel">
    <div class="fp-header">
      <span class="fp-stats" id="fp-stats">— nodes / — edges</span>
    </div>
    <div class="fp-section">
      <div class="fp-section-title">
        <span>Filters</span>
        <div class="fp-allnone">
          <button onclick="setAllFilters(true)">All</button>
          <button onclick="setAllFilters(false)">None</button>
        </div>
      </div>
      <div class="fp-group-title collapsed" onclick="toggleGroup('fp-node-types', this)"><span class="fp-toggle">▼</span>Nodes</div>
      <div id="fp-node-types" class="fp-group-content collapsed"></div>
      <div class="fp-group-title collapsed" onclick="toggleGroup('fp-edge-types', this)"><span class="fp-toggle">▼</span>Edges</div>
      <div id="fp-edge-types" class="fp-group-content collapsed"></div>
      <div class="fp-checkbox">
        <input type="checkbox" id="fp-show-labels" checked onchange="toggleLabels()">
        <label for="fp-show-labels">Show labels</label>
      </div>
      <div class="fp-search">
        <input type="text" id="fp-search-input" placeholder="Search nodes..." oninput="onSearchNodes()">
      </div>
      <div class="fp-group-title collapsed" onclick="toggleGroup('fp-dir-list', this)"><span class="fp-toggle">▼</span>Directories</div>
      <div id="fp-dir-list" class="fp-group-content collapsed"></div>
    </div>
  </div>
  <div id="loading">⏳ Waiting for graph data...</div>
  <div id="info-panel">
    <span class="close-btn" onclick="closeInfoPanel()">×</span>
    <h3 id="info-title"></h3>
    <div class="meta" id="info-meta"></div>
    <div class="section">
      <div class="label">File path</div>
      <div class="value" id="info-path"></div>
    </div>
    <div class="section">
      <div class="label">Node type</div>
      <div class="value" id="info-type"></div>
    </div>
    <button class="open-btn" onclick="openCodeFile()">📂 Open in editor</button>
  </div>
  <div id="controls">
    <button onclick="refreshGraphData()">🔄 Refresh</button>
    <button onclick="resetCamera()">🎥 Reset View</button>
  </div>
  ${warning}
  <div id="graph-path">GRAPH: ${graphPathDisplay}</div>
  <div id="stats"></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/CopyShader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/LuminosityHighPassShader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/EffectComposer.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/RenderPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/ShaderPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/UnrealBloomPass.js"></script>
<script>
// ─── State (InstancedMesh — single draw call for all nodes) ──────────
// ─── Embedded graph data (pre-computed by extension host) ────────────
const VIZ_DATA = ${JSON.stringify(vizData)};
let scene, camera, renderer;
let composer = null;      // EffectComposer for Bloom post-processing
let nodeMesh = null;       // InstancedMesh
let edgeLines = null;
let nodeLabels = [];
let nodeVisible = [];       // per-node visibility (for filtering)
let originalMatrices = [];  // stored for filter toggle restore
let selectedNode = null;
let showLabels = true;
let animationId = null;
const tempObj = new THREE.Object3D();
const tempColor = new THREE.Color();

const EDGE_TYPE_COLORS = {
  CALLS: '#1DA27E', IMPORTS: '#3b82f6', DEFINES: '#a855f7', DEFINES_METHOD: '#a855f7',
  CONTAINS_FILE: '#22c55e', CONTAINS_FOLDER: '#22c55e', CONTAINS_PACKAGE: '#22c55e',
  HANDLES: '#eab308', IMPLEMENTS: '#f97316', HTTP_CALLS: '#e11d48',
  USAGE: '#64748b', RAISES: '#f59e0b', WRITES: '#ec4899',
  INHERITS: '#f97316', THROWS: '#f59e0b', DECORATES: '#a78bfa'
};
const DEFAULT_EDGE_COLOR = '#1C8585';

// ─── Initialization (data has pre-computed x/y/z/size/color) ─────────
function initWithData(data) {
  if (typeof THREE === 'undefined') {
    document.getElementById('loading').innerHTML = '⚠️ Three.js failed to load from CDN.';
    document.getElementById('loading').style.color = '#f48771';
    return;
  }
  // VIZ_DATA is already set as const from embedded data
  const container = document.getElementById('canvas-container');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06090f);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100000);
  camera.position.set(0, 0, 800);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // ── Bloom 后处理（对齐 codebase-memory-mcp 的视觉效果）──────────
  // 颜色值 > 1.0 的节点会发光，产生光晕效果
  if (typeof THREE.EffectComposer !== 'undefined') {
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));
    const bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.4,   // strength — 降低，避免过曝看不清节点
      0.4,   // radius
      0.6    // threshold — 提高，只有最亮的节点才发光
    );
    composer.addPass(bloomPass);
  }

  scene.add(new THREE.AmbientLight(0xffffff, 0.5));
  const pl1 = new THREE.PointLight(0xffffff, 0.6); pl1.position.set(500, 500, 500); scene.add(pl1);
  const pl2 = new THREE.PointLight(0x6040ff, 0.4); pl2.position.set(-300, -200, -300); scene.add(pl2);

  initControls();

  // No layout computation needed — positions are pre-computed!
  document.getElementById('loading').style.display = 'none';
  document.getElementById('stats').innerText = 'Nodes: ' + data.nodes.length + ' | Edges: ' + data.edges.length;
  renderGraph(data.nodes, data.edges);

  window.addEventListener('resize', onWindowResize);
  animate();
}

// ─── Simple Orbit Controls (with damping + idle auto-rotate) ─────────
let isDragging = false;
let previousMouse = { x: 0, y: 0 };
let spherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
// 目标球面坐标（lerp 目标，实现阻尼效果）
let targetSpherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let target = new THREE.Vector3(0, 0, 0);
let lastInteractionTime = Date.now();
const IDLE_AUTO_ROTTE_DELAY = 60000; // 60 秒无交互后自动旋转
const DAMPING_FACTOR = 0.08; // 阻尼系数（对齐 codebase-memory-mcp OrbitControls）

function initControls() {
  const canvas = renderer.domElement;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { isDragging = true; previousMouse = { x: e.clientX, y: e.clientY }; lastInteractionTime = Date.now(); }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) { checkHover(e); return; }
    const dx = e.clientX - previousMouse.x;
    const dy = e.clientY - previousMouse.y;
    targetSpherical.theta -= dx * 0.005;
    targetSpherical.phi -= dy * 0.005;
    targetSpherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, targetSpherical.phi));
    previousMouse = { x: e.clientX, y: e.clientY };
    lastInteractionTime = Date.now();
  });

  canvas.addEventListener('mouseup', () => { isDragging = false; lastInteractionTime = Date.now(); });
  canvas.addEventListener('mouseleave', () => { isDragging = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    targetSpherical.radius *= (1 + e.deltaY * 0.001);
    targetSpherical.radius = Math.max(10, Math.min(50000, targetSpherical.radius));
    lastInteractionTime = Date.now();
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    if (Math.abs(e.clientX - previousMouse.x) < 5 && Math.abs(e.clientY - previousMouse.y) < 5) {
      checkClick(e);
    }
    lastInteractionTime = Date.now();
  });
}

function updateCamera() {
  // 阻尼 lerp：spherical 平滑追赶 targetSpherical
  spherical.theta += (targetSpherical.theta - spherical.theta) * DAMPING_FACTOR;
  spherical.phi += (targetSpherical.phi - spherical.phi) * DAMPING_FACTOR;
  spherical.radius += (targetSpherical.radius - spherical.radius) * DAMPING_FACTOR;
  camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
  camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
  camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
  camera.lookAt(target);
}

function resetCamera() {
  targetSpherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
  target = new THREE.Vector3(0, 0, 0);
  lastInteractionTime = Date.now();
}

// ─── Render Graph (InstancedMesh — single draw call) ─────────────────
function renderGraph(nodes, edges) {
  // Cleanup old (dispose textures to prevent memory leaks)
  if (nodeMesh) { scene.remove(nodeMesh); nodeMesh.geometry.dispose(); nodeMesh.material.dispose(); }
  nodeLabels.forEach(l => {
    if (l) {
      scene.remove(l);
      if (l.material && l.material.map) { l.material.map.dispose(); }
      if (l.material) { l.material.dispose(); }
    }
  });
  if (edgeLines) { scene.remove(edgeLines); }
  nodeMesh = null; nodeLabels = []; edgeLines = null; originalMatrices = []; nodeVisible = [];

  if (nodes.length === 0) { return; }

  const scale = Math.max(1, Math.sqrt(nodes.length) * 5);
  const posScale = 50 / scale;

  // ── InstancedMesh for all nodes (1 draw call instead of N) ──
  const geometry = new THREE.SphereGeometry(1, 24, 16);
  const material = new THREE.MeshBasicMaterial({ toneMapped: false });
  nodeMesh = new THREE.InstancedMesh(geometry, material, nodes.length);
  nodeMesh.frustumCulled = false;
  nodeMesh.userData = { nodes: nodes };

  const colorArray = new Float32Array(nodes.length * 3);

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    // Use pre-computed position/size (scaled)
    tempObj.position.set(n.x * posScale, n.y * posScale, n.z * posScale);
    tempObj.scale.setScalar(n.size * 0.5);
    tempObj.updateMatrix();
    nodeMesh.setMatrixAt(i, tempObj.matrix);
    originalMatrices.push(tempObj.matrix.clone());
    nodeVisible.push(true);

    // Use pre-computed color with mild brightness boost
    tempColor.set(n.color);
    const brightness = (tempColor.r + tempColor.g + tempColor.b) / 3;
    tempColor.multiplyScalar(1.0 + brightness * 0.3);
    colorArray[i * 3] = tempColor.r;
    colorArray[i * 3 + 1] = tempColor.g;
    colorArray[i * 3 + 2] = tempColor.b;
  }

  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
  scene.add(nodeMesh);

  // ── Labels (top 80 by pre-computed size) ──
  if (showLabels) {
    const dpr = Math.min(window.devicePixelRatio, 2); // DPR 适配高清屏
    const labelCanvas = document.createElement('canvas');
    const ctx = labelCanvas.getContext('2d');
    const fontSize = 32;
    const font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';

    const labeled = nodes.map((n, i) => ({ node: n, idx: i, size: n.size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 80);

    labeled.forEach(({ node, idx }) => {
      const text = node.name || node.id || '?';
      const shortText = text.length > 24 ? text.substring(0, 22) + '...' : text;

      ctx.font = font;
      const metrics = ctx.measureText(shortText);
      const tw = Math.ceil(metrics.width) + 16;
      const th = fontSize + 8;
      labelCanvas.width = tw * dpr;
      labelCanvas.height = th * dpr;
      ctx.scale(dpr, dpr);

      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.fillStyle = node.color;
      ctx.strokeText(shortText, tw / 2, th / 2);
      ctx.fillText(shortText, tw / 2, th / 2);

      const texture = new THREE.CanvasTexture(labelCanvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const sprite = new THREE.Sprite(spriteMat);
      sprite.position.set(node.x * posScale, node.y * posScale, node.z * posScale);
      sprite.position.y += node.size * 0.5 + 2;
      const worldW = Math.max(4, node.size * 1.5);
      const worldH = worldW * (th / tw);
      sprite.scale.set(worldW, worldH, 1);
      sprite.userData = { nodeIndex: idx };
      scene.add(sprite);
      nodeLabels[idx] = sprite;
    });
  }

  // ── Edges (Float32Array + BufferGeometry — same as before) ──
  if (edges.length > 0) {
    const nodeMap = new Map();
    nodes.forEach((node, i) => { nodeMap.set(node.id, i); });

    const positions = [];
    const colors = [];
    let validCount = 0;

    edges.forEach(edge => {
      const si = nodeMap.get(edge.source);
      const ti = nodeMap.get(edge.target);
      if (si !== undefined && ti !== undefined) {
        const sn = nodes[si], tn = nodes[ti];
        positions.push(
          sn.x * posScale, sn.y * posScale, sn.z * posScale,
          tn.x * posScale, tn.y * posScale, tn.z * posScale
        );
        const edgeColorHex = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
        const ec = new THREE.Color(edgeColorHex);
        const sCluster = (sn.filePath || '').split('/').slice(0, 2).join('/');
        const tCluster = (tn.filePath || '').split('/').slice(0, 2).join('/');
        const intensity = sCluster === tCluster ? 0.25 : 0.06;
        colors.push(
          ec.r * intensity, ec.g * intensity, ec.b * intensity,
          ec.r * intensity, ec.g * intensity, ec.b * intensity
        );
        validCount++;
      }
    });

    if (validCount > 0) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const mat = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      edgeLines = new THREE.LineSegments(geo, mat);
      scene.add(edgeLines);
    }
  }

  targetSpherical.radius = scale * 3 + 100;
  buildFilterPanel(nodes, edges);
}

// ─── Filter System ─────────────────────────────────────────────────────
let allNodes = [];
let allEdges = [];
let activeNodeTypes = new Set();
let activeEdgeTypes = new Set();
let activeDir = null;
let searchQuery = '';

function getTopDir(filePath) {
  if (!filePath) return '(unknown)';
  var parts = filePath.replace(/\\\\/g, '/').split('/').filter(function(p) { return p && p !== '.'; });
  return parts[0] || '(root)';
}

// ─── Collapse/Expand Group ────────────────────────────────────────────
function toggleGroup(contentId, titleEl) {
  var content = document.getElementById(contentId);
  if (!content) return;
  var isCollapsed = content.classList.toggle('collapsed');
  if (titleEl) { titleEl.classList.toggle('collapsed', isCollapsed); }
}

function buildFilterPanel(nodes, edges) {
  allNodes = nodes;
  allEdges = edges;

  var nodeTypeCounts = {};
  nodes.forEach(function(n) {
    var t = (n.type || 'unknown').toLowerCase();
    nodeTypeCounts[t] = (nodeTypeCounts[t] || 0) + 1;
  });

  var edgeTypeCounts = {};
  edges.forEach(function(e) {
    var t = (e.type || 'UNKNOWN').toLowerCase();
    edgeTypeCounts[t] = (edgeTypeCounts[t] || 0) + 1;
  });

  var dirCounts = {};
  nodes.forEach(function(n) {
    var d = getTopDir(n.filePath);
    dirCounts[d] = (dirCounts[d] || 0) + 1;
  });

  document.getElementById('fp-stats').innerText = nodes.length + ' nodes / ' + edges.length + ' edges';

  var nodeContainer = document.getElementById('fp-node-types');
  nodeContainer.innerHTML = '';
  activeNodeTypes = new Set();
  Object.entries(nodeTypeCounts).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(entry) {
    var type = entry[0], count = entry[1];
    activeNodeTypes.add(type);
    var item = document.createElement('div');
    item.className = 'fp-item';
    item.innerHTML = '<input type="checkbox" checked data-type="' + type + '" data-kind="node" onchange="onFilterChange()">' +
      '<label>' + type + '</label><span class="fp-count">' + count + '</span>';
    nodeContainer.appendChild(item);
  });

  var edgeContainer = document.getElementById('fp-edge-types');
  edgeContainer.innerHTML = '';
  activeEdgeTypes = new Set();
  Object.entries(edgeTypeCounts).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(entry) {
    var type = entry[0], count = entry[1];
    activeEdgeTypes.add(type);
    var item = document.createElement('div');
    item.className = 'fp-item';
    item.innerHTML = '<input type="checkbox" checked data-type="' + type + '" data-kind="edge" onchange="onFilterChange()">' +
      '<label>' + type + '</label><span class="fp-count">' + count + '</span>';
    edgeContainer.appendChild(item);
  });

  var dirContainer = document.getElementById('fp-dir-list');
  dirContainer.innerHTML = '';
  Object.entries(dirCounts).sort(function(a, b) { return b[1] - a[1]; }).forEach(function(entry) {
    var dir = entry[0], count = entry[1];
    var item = document.createElement('div');
    item.className = 'fp-dir-item';
    item.innerHTML = dir + ' <span class="fp-count">' + count + '</span>';
    item.onclick = function() { onDirClick(dir, item); };
    dirContainer.appendChild(item);
  });
}

function onFilterChange() {
  activeNodeTypes = new Set();
  activeEdgeTypes = new Set();
  document.querySelectorAll('#fp-node-types input').forEach(function(cb) {
    if (cb.checked) activeNodeTypes.add(cb.dataset.type);
  });
  document.querySelectorAll('#fp-edge-types input').forEach(function(cb) {
    if (cb.checked) activeEdgeTypes.add(cb.dataset.type);
  });
  applyFilters();
}

function setAllFilters(state) {
  document.querySelectorAll('#filter-panel input[type=checkbox][data-type]').forEach(function(cb) {
    cb.checked = state;
  });
  onFilterChange();
}

function onDirClick(dir, el) {
  if (activeDir === dir) {
    activeDir = null;
    el.classList.remove('active');
  } else {
    document.querySelectorAll('.fp-dir-item').forEach(function(e) { e.classList.remove('active'); });
    activeDir = dir;
    el.classList.add('active');
  }
  applyFilters();
}

function onSearchNodes() {
  searchQuery = document.getElementById('fp-search-input').value.toLowerCase().trim();
  applyFilters();
}

function applyFilters() {
  var visibleNodeCount = 0;
  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;

  allNodes.forEach(function(node, i) {
    var type = (node.type || 'unknown').toLowerCase();
    var isVisible = activeNodeTypes.has(type);
    if (isVisible && activeDir) {
      var dir = getTopDir(node.filePath);
      if (dir !== activeDir) isVisible = false;
    }
    // Search dimming
    var isDimmed = false;
    if (isVisible && searchQuery) {
      var name = (node.name || node.id || '').toLowerCase();
      var qualName = (node.qualifiedName || '').toLowerCase();
      if (!name.includes(searchQuery) && !qualName.includes(searchQuery)) {
        isDimmed = true;
      }
    }

    nodeVisible[i] = isVisible;
    // Toggle InstancedMesh instance: scale=0 to hide, restore original to show
    if (nodeMesh && originalMatrices[i]) {
      if (isVisible) {
        nodeMesh.setMatrixAt(i, originalMatrices[i]);
      } else {
        tempObj.position.set(0, 0, 0);
        tempObj.scale.setScalar(0);
        tempObj.updateMatrix();
        nodeMesh.setMatrixAt(i, tempObj.matrix);
      }
    }
    // Dim non-matching nodes by reducing color intensity
    if (nodeMesh && nodeMesh.instanceColor) {
      if (isDimmed) {
        tempColor.set(node.color);
        tempColor.multiplyScalar(0.1);
      } else {
        tempColor.set(node.color);
        var brightness = (tempColor.r + tempColor.g + tempColor.b) / 3;
        tempColor.multiplyScalar(1.0 + brightness * 0.3);
      }
      nodeMesh.instanceColor.setXYZ(i, tempColor.r, tempColor.g, tempColor.b);
    }
    if (nodeLabels[i]) {
      nodeLabels[i].visible = isVisible && showLabels && !isDimmed;
    }
    if (isVisible && !isDimmed) visibleNodeCount++;
  });

  if (nodeMesh) {
    nodeMesh.instanceMatrix.needsUpdate = true;
    if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
  }

  if (edgeLines) {
    // 复用 geometry：不销毁，只更新 buffer 数据（避免 GC 压力）
    edgeLines.visible = false;
  }

  var visibleEdgeCount = 0;
  if (allEdges.length > 0) {
    var nodeMap = new Map();
    allNodes.forEach(function(node, i) { nodeMap.set(node.id, i); });

    // 预分配 Float32Array（最大可能大小 = allEdges.length * 6）
    var maxFloats = allEdges.length * 6;
    var positions = new Float32Array(maxFloats);
    var colors = new Float32Array(maxFloats);
    var offset = 0;

    allEdges.forEach(function(edge) {
      var type = (edge.type || 'UNKNOWN').toLowerCase();
      if (!activeEdgeTypes.has(type)) return;
      var si = nodeMap.get(edge.source);
      var ti = nodeMap.get(edge.target);
      if (si === undefined || ti === undefined) return;
      if (!nodeVisible[si] || !nodeVisible[ti]) return;
      var sn = allNodes[si], tn = allNodes[ti];
      positions[offset] = sn.x * posScale;
      positions[offset + 1] = sn.y * posScale;
      positions[offset + 2] = sn.z * posScale;
      positions[offset + 3] = tn.x * posScale;
      positions[offset + 4] = tn.y * posScale;
      positions[offset + 5] = tn.z * posScale;
      var edgeColorHex = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
      var ec = new THREE.Color(edgeColorHex);
      var sCluster = (sn.filePath || '').split('/').slice(0, 2).join('/');
      var tCluster = (tn.filePath || '').split('/').slice(0, 2).join('/');
      var intensity = sCluster === tCluster ? 0.25 : 0.06;
      var r = ec.r * intensity, g = ec.g * intensity, b = ec.b * intensity;
      colors[offset] = r; colors[offset + 1] = g; colors[offset + 2] = b;
      colors[offset + 3] = r; colors[offset + 4] = g; colors[offset + 5] = b;
      offset += 6;
      visibleEdgeCount++;
    });

    if (visibleEdgeCount > 0) {
      if (edgeLines) {
        // 复用已有 geometry：更新 buffer attribute 数据
        var posAttr = edgeLines.geometry.getAttribute('position');
        var colAttr = edgeLines.geometry.getAttribute('color');
        if (posAttr.array.length >= offset) {
          // 复制到现有 buffer
          posAttr.array.set(positions.subarray(0, offset));
          posAttr.needsUpdate = true;
          posAttr.count = offset / 3;
          colAttr.array.set(colors.subarray(0, offset));
          colAttr.needsUpdate = true;
          colAttr.count = offset / 3;
          edgeLines.geometry.setDrawRange(0, offset / 3);
          edgeLines.visible = true;
        } else {
          // buffer 不够大，需要重建
          scene.remove(edgeLines);
          edgeLines.geometry.dispose();
          edgeLines.material.dispose();
          edgeLines = null;
        }
      }
      if (!edgeLines) {
        var geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, offset), 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, offset), 3));
        var material = new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 1.0,
          blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
        });
        edgeLines = new THREE.LineSegments(geometry, material);
        scene.add(edgeLines);
      }
    }
  }

  document.getElementById('fp-stats').innerText =
    visibleNodeCount + ' / ' + allNodes.length + ' nodes | ' +
    visibleEdgeCount + ' / ' + allEdges.length + ' edges';
}

function refreshGraphData() {
  if (vscode) {
    vscode.postMessage({ type: 'refresh-graph' });
  }
}

// ─── Interaction ──────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function checkHover(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!nodeMesh) { return; }
  const intersects = raycaster.intersectObject(nodeMesh);
  renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
}

function checkClick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!nodeMesh) { return; }
  const intersects = raycaster.intersectObject(nodeMesh);
  if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
    const idx = intersects[0].instanceId;
    const nodes = nodeMesh.userData.nodes;
    if (nodes && nodes[idx]) {
      showInfoPanel(nodes[idx], event);
    }
  } else {
    closeInfoPanel();
  }
}

function showInfoPanel(node, clickEvent) {
  selectedNode = node;
  const panel = document.getElementById('info-panel');
  document.getElementById('info-title').innerText = node.name || node.id || 'Unknown';
  document.getElementById('info-meta').innerText = 'In: ' + node.inDegree + ' | Out: ' + node.outDegree;
  document.getElementById('info-path').innerText = node.filePath || 'N/A';
  document.getElementById('info-type').innerText = node.type || 'unknown';
  panel.style.display = 'block';

  // Position panel near the click / node, with boundary clamping
  if (clickEvent) {
    const container = document.getElementById('canvas-container');
    const rect = container.getBoundingClientRect();
    const pw = panel.offsetWidth;
    const ph = panel.offsetHeight;
    // Default: place below-right of cursor, offset slightly
    let x = clickEvent.clientX - rect.left + 16;
    let y = clickEvent.clientY - rect.top + 16;

    // Clamp right edge
    if (x + pw > rect.width - 10) { x = clickEvent.clientX - rect.left - pw - 16; }
    // Clamp bottom edge
    if (y + ph > rect.height - 10) { y = clickEvent.clientY - rect.top - ph - 16; }
    // Clamp left edge
    if (x < 10) { x = 10; }
    // Clamp top edge
    if (y < 10) { y = 10; }

    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  } else {
    // Fallback: top-left
    panel.style.left = '20px';
    panel.style.top = '20px';
  }
}

function closeInfoPanel() {
  selectedNode = null;
  document.getElementById('info-panel').style.display = 'none';
}

function openCodeFile() {
  if (!selectedNode || !selectedNode.filePath) { return; }
  const msg = { type: 'open-file', filePath: selectedNode.filePath, qualifiedName: selectedNode.qualifiedName };
  if (vscode) {
    vscode.postMessage(msg);
  }
}

function toggleLabels() {
  showLabels = document.getElementById('fp-show-labels').checked;
  nodeLabels.forEach((l, i) => {
    if (l) { l.visible = showLabels && nodeVisible[i]; }
  });
}

// ─── Animation Loop (Bloom + idle auto-rotate) ──────────────────────
function animate() {
  animationId = requestAnimationFrame(animate);
  updateCamera();
  // 空闲自动旋转：60 秒无交互后缓慢旋转（对齐 codebase-memory-mcp 的 IdleAutoRotate）
  const idleTime = Date.now() - lastInteractionTime;
  if (!isDragging && idleTime > IDLE_AUTO_ROTTE_DELAY) {
    targetSpherical.theta += 0.0008;
  }
  // 使用 EffectComposer 渲染（含 Bloom），回退到普通渲染
  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) { composer.setSize(window.innerWidth, window.innerHeight); }
}

// ─── VS Code webview API (for open-file, refresh messages) ──────────
// ─── Global error handler (display errors in webview instead of black screen) ──
window.addEventListener('error', function(e) {
  var loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = '⚠️ Error: ' + (e.message || 'unknown');
    loading.style.color = '#f48771';
    loading.style.fontSize = '14px';
  }
});

const vscode = (function() {
  try { return acquireVsCodeApi(); } catch(e) { return null; }
})();

// ─── Start: data is embedded in HTML, initialize immediately ────────
initWithData(VIZ_DATA);
</script>
</body>
</html>`;
	}

	/** Open a file in VS Code editor */
	private async _openFileInEditor(filePath: string, qualifiedName?: string): Promise<void> {
		if (!filePath) { return; }
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { return; }

			const wsUri = folders[0].uri;
			const fileUri = URI.joinPath(wsUri, filePath);

			await this._openerService.open(fileUri, { fromUserGesture: true, openToSide: false });
			this._logService.info(LOG_TAG, `Opened file: ${filePath}`);
		} catch (err: any) {
			this._logService.warn(LOG_TAG, `Failed to open file ${filePath}:`, err);
		}
	}

	// ─── UI Helpers ────────────────────────────────────────────────────

	private _showLoading(message: string): void {
		if (!this._container) { return; }
		this._clearStatus();
		this._disposeWebview();

		this._statusEl = document.createElement('div');
		this._statusEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:var(--vscode-descriptionForeground);font-size:14px;';

		const icon = document.createElement('div');
		icon.style.cssText = 'margin-bottom:12px;font-size:24px;';
		icon.textContent = '⏳';
		this._statusEl.appendChild(icon);

		const msg = document.createElement('div');
		msg.textContent = message;
		this._statusEl.appendChild(msg);

		this._container.appendChild(this._statusEl);
	}

	private _showError(message: string): void {
		if (!this._container) { return; }
		this._clearStatus();
		this._disposeWebview();

		this._statusEl = document.createElement('div');
		this._statusEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;max-width:500px;color:var(--vscode-errorForeground);font-size:14px;padding:20px;';

		const icon = document.createElement('div');
		icon.style.cssText = 'margin-bottom:12px;font-size:28px;';
		icon.textContent = '⚠️';
		this._statusEl.appendChild(icon);

		const msg = document.createElement('div');
		msg.textContent = message;
		this._statusEl.appendChild(msg);

		this._container.appendChild(this._statusEl);
	}

	private _clearStatus(): void {
		if (this._statusEl) {
			this._statusEl.remove();
			this._statusEl = undefined;
		}
	}

	private _disposeWebview(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
	}

	override layout(_dimension: { width: number; height: number }): void {
		// Webview fills container
	}

	override dispose(): void {
		this._disposeWebview();
		super.dispose();
	}
}
