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
import { ICodebaseGraphService } from './codebaseGraphService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

const LOG_TAG = '[CodebaseGraphViewer]';

export class CodebaseGraphViewerEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.codebaseGraphViewer';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private _statusEl: HTMLElement | undefined;
	private _webviewReadyResolve: (() => void) | undefined;

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
		@IFileService private readonly _fileService: IFileService,
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
		await this._loadVisualization(input, token);
	}

	// ─── Core: Load Visualization via Native Graph Service ──────────────

	private async _loadVisualization(input: CodebaseGraphViewerEditorInput, token: CancellationToken): Promise<void> {
		try {
			const t0 = Date.now();
			this._logService.info(LOG_TAG, `[load] step 0: start`);

			// 1. 轻量级检查：图中是否有数据
			let hasData = await this._graphService.hasGraphDataAsync();
			this._logService.info(LOG_TAG, `[load] step 1: hasData=${hasData} (${Date.now() - t0}ms)`);

		// 2. 如果图为空，尝试加载已保存的 graph 文件
		if (!hasData) {
			this._showLoading('正在加载代码图谱...');
			await this._yieldToUI();
			// 优先使用输入指定的 folderPath（库中的文件夹右键「代码图谱」），
			// 否则回退到当前 VS Code 工作区的第一个文件夹。
			let graphRoot: URI;
			if (input.folderPath) {
				graphRoot = URI.file(input.folderPath);
			} else {
				const folders = this._workspaceService.getWorkspace().folders;
				if (folders.length === 0) {
					this._showError('未打开工作区。');
					return;
				}
				graphRoot = folders[0].uri;
			}
			const graphFileUri = URI.joinPath(graphRoot, '.codebase-memory', 'graph.db.zst');
				this._logService.info(LOG_TAG, `[load] step 2: loading graph file: ${graphFileUri.fsPath}`);
				const loaded = await this._graphService.loadGraph(graphFileUri.fsPath);
				this._logService.info(LOG_TAG, `[load] step 2 done: loaded=${loaded} (${Date.now() - t0}ms)`);
				if (!loaded) {
					this._showError('代码图谱为空。请在 Codebase Memory 面板中索引代码库。');
					return;
				}
				hasData = await this._graphService.hasGraphDataAsync();
			}

			if (token.isCancellationRequested) { return; }

			if (!hasData) {
				this._showError('图谱为空。请先索引代码库。');
				return;
			}

			// 3. 获取节点总数
			const totalNodes = await this._graphService.getTotalNodeCountAsync();
			this._logService.info(LOG_TAG, `[load] step 3: totalNodes=${totalNodes} (${Date.now() - t0}ms)`);

			// 4. 获取 graph 文件路径
			let graphPath = '';
			try {
				const status = await this._graphService.getGraphStatus();
				graphPath = status.graphPath || '';
			} catch { /* ignore */ }

			if (token.isCancellationRequested) { return; }

			// 5. 创建 webview（不含数据，数据通过 postMessage 分批发送）
			this._logService.info(LOG_TAG, `[load] step 5: creating webview (empty)...`);
			this._showLoading(`正在初始化 3D 渲染器...`);
			await this._yieldToUI();
			await this._createWebview(graphPath, totalNodes);
			this._logService.info(LOG_TAG, `[load] step 5b: webview ready`);

			// 6. 分批发送节点数据到 webview
			const NODE_BATCH = 2000;
			const EDGE_BATCH = 5000;
			let nodeOffset = 0;
			let loadedNodeIds = new Set<string>();

			this._logService.info(LOG_TAG, `[load] step 6: sending nodes in batches of ${NODE_BATCH}...`);
			while (nodeOffset < totalNodes) {
				if (token.isCancellationRequested) { break; }

				const tBatch = Date.now();
				const { nodes, total } = await this._graphService.getVisualizationNodesAsync(nodeOffset, NODE_BATCH);
				if (nodes.length === 0) { break; }

				// 收集已加载节点 ID
				for (const n of nodes) { loadedNodeIds.add(n.id); }

				// 发送批次到 webview
				this._webview?.postMessage({ type: 'nodes-batch', nodes, offset: nodeOffset, total });
				nodeOffset += nodes.length;

				this._logService.info(LOG_TAG, `[load] nodes batch: ${nodes.length} (offset ${nodeOffset - nodes.length}, ${Date.now() - tBatch}ms)`);

				// yield 让 UI 更新
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}

			// 7. 分批发送边数据
			const totalEdges = await this._graphService.getTotalEdgeCountAsync();
			this._logService.info(LOG_TAG, `[load] step 7: sending ${totalEdges} edges in batches of ${EDGE_BATCH}...`);
			let edgeOffset = 0;
			let totalEdgesSent = 0;

			while (edgeOffset < totalEdges) {
				if (token.isCancellationRequested) { break; }

				const tBatch = Date.now();
				const edges = await this._graphService.getVisualizationEdgesAsync(loadedNodeIds, edgeOffset, EDGE_BATCH);
				if (edges.length === 0) { break; }

				this._webview?.postMessage({ type: 'edges-batch', edges, offset: edgeOffset });
				totalEdgesSent += edges.length;
				edgeOffset += edges.length;

				this._logService.info(LOG_TAG, `[load] edges batch: ${edges.length} (total ${totalEdgesSent}/${totalEdges}, ${Date.now() - tBatch}ms)`);
				await new Promise<void>(resolve => setTimeout(resolve, 0));
			}

			// 8. 通知 webview 加载完成
			this._webview?.postMessage({ type: 'load-complete', totalNodes, totalEdges: totalEdgesSent });
			this._logService.info(LOG_TAG, `[load] step 8: done. ${nodeOffset} nodes, ${totalEdgesSent}/${totalEdges} edges (total ${Date.now() - t0}ms)`);

		} catch (err: any) {
			const msg = err?.message || String(err);
			this._logService.error(LOG_TAG, 'Failed to load visualization:', err);
			this._showError(`加载可视化失败: ${msg}`);
		}
	}

	// ─── Rendering: Three.js 3D Graph with Force-Directed Layout ─────────

	private _createWebview(graphPath: string, totalNodes: number): Promise<void> {
		if (!this._container) { return Promise.resolve(); }

		this._clearStatus();
		this._disposeWebview();

		const graphPathDisplay = graphPath || 'N/A';
		this._logService.info(LOG_TAG, `Creating webview (totalNodes=${totalNodes}, graphPath=${graphPathDisplay})`);

		// 创建 webview-ready Promise（等待 webview 的 initScene 完成后再发送数据）
		this._webviewReadyResolve = undefined;
		const readyPromise = new Promise<void>((resolve) => {
			this._webviewReadyResolve = resolve;
		});

		const html = this._makeHtmlTemplate(graphPathDisplay, totalNodes);

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

		// 消息处理
		this._register(this._webview.onMessage((msg: any) => {
			if (msg.type === 'open-file') {
				this._logService.info(LOG_TAG, `Received open-file: filePath=${msg.filePath}, qualifiedName=${msg.qualifiedName}`);
				this._openFileInEditor(msg.filePath, msg.qualifiedName);
			} else if (msg.type === 'refresh-graph') {
				this._logService.info(LOG_TAG, 'Refresh requested by user');
				const currentInput = this.input as CodebaseGraphViewerEditorInput | undefined;
				if (currentInput) {
					this._loadVisualization(currentInput, CancellationToken.None).catch(err => {
						this._logService.error(LOG_TAG, 'Refresh failed:', err);
					});
				}
			} else if (msg.type === 'webview-ready') {
				this._logService.info(LOG_TAG, 'Webview ready, starting data transfer...');
				this._webviewReadyResolve?.();
			} else if (msg.type === 'debug') {
				this._logService.info(LOG_TAG, `[webview] ${msg.msg}`);
			}
		}));

		this._logService.info(LOG_TAG, `Webview mounted (empty, awaiting data via postMessage)`);

		// 返回 readyPromise（带 10 秒超时 fallback，避免 webview 不发 ready 时永久阻塞）
		return Promise.race([
			readyPromise,
			new Promise<void>((resolve) => setTimeout(resolve, 10000)),
		]);
	}

	/**
	 * 生成 webview HTML 模板（不含 graph 数据，数据通过 postMessage 分批传递）
	 */
	private _makeHtmlTemplate(graphPathDisplay: string, totalNodes: number): string {
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

/* ─── Loading overlay (constellation pulse) ─── */
#loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 200; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 16px; pointer-events: none; }
#loading-canvas { display: block; }
#loading-text-wrap { color: #80a0ff; font-size: 14px; font-weight: 500; text-shadow: 0 0 12px rgba(128,160,255,0.4); }
#loading .sub { font-size: 11px; color: #555; margin-top: -8px; }
#loading .progress-bar { width: 220px; height: 3px; background: rgba(128,160,255,0.1); border-radius: 2px; overflow: hidden; }
#loading .progress-fill { height: 100%; background: linear-gradient(90deg, #1DA27E, #80a0ff); border-radius: 2px; transition: width 0.3s ease; width: 0; }

/* ─── Info panel ─── */
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

/* ─── Stats bar ─── */
#stats { position: absolute; bottom: 20px; left: 20px; color: #aaa; font-size: 12px; z-index: 10; display: flex; gap: 16px; align-items: center; }
#edge-limit-warn { color: #eab308; font-size: 11px; display: none; }

/* ─── Top-right controls ─── */
#controls { position: absolute; top: 20px; right: 20px; z-index: 50; display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
#controls button, #controls .ctrl-btn { background: rgba(0,0,0,0.7); color: #aaa; border: 1px solid rgba(255,255,255,0.12); padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; transition: all 0.2s; }
#controls button:hover, #controls .ctrl-btn:hover { background: rgba(255,255,255,0.12); color: #fff; }
#controls button.active, #controls .ctrl-btn.active { background: rgba(29,162,126,0.2); border-color: rgba(29,162,126,0.4); color: #1DA27E; }
#graph-path { position: absolute; top: 60px; right: 20px; color: #444; font-size: 10px; max-width: 300px; text-align: right; z-index: 10; word-break: break-all; font-family: monospace; }

/* ─── Side panels (filter / display settings) ─── */
.side-panel { position: absolute; top: 20px; left: 20px; background: rgba(6,9,15,0.92); border: 1px solid rgba(128,160,255,0.15); border-radius: 10px; padding: 12px 14px; z-index: 50; backdrop-filter: blur(10px); display: none; max-height: 70vh; overflow-y: auto; min-width: 180px; }
.side-panel h4 { color: #80a0ff; font-size: 12px; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.8px; }
.side-panel label { display: flex; align-items: center; gap: 6px; font-size: 11px; color: #ccc; padding: 3px 0; cursor: pointer; }
.side-panel label input[type=checkbox] { accent-color: #1DA27E; }
.side-panel .color-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.side-panel .range-row { margin: 8px 0 4px; }
.side-panel .range-row .range-label { font-size: 10px; color: #888; display: flex; justify-content: space-between; }
.side-panel input[type=range] { width: 100%; accent-color: #1DA27E; margin: 2px 0; }
.side-panel .reset-btn { margin-top: 10px; padding: 4px 10px; background: rgba(255,255,255,0.06); color: #888; border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; cursor: pointer; font-size: 10px; width: 100%; }
.side-panel .reset-btn:hover { color: #fff; background: rgba(255,255,255,0.1); }
</style>
</head>
<body>
<div id="canvas-container">
  <div id="loading">
    <canvas id="loading-canvas" width="160" height="160"></canvas>
    <div id="loading-text-wrap">Initializing 3D renderer...</div>
    <div class="sub">Codebase Graph Viewer (${totalNodes} nodes)</div>
    <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
  </div>
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
    <button class="open-btn" onclick="openCodeFile()">Open in editor</button>
  </div>

  <!-- Filter panel -->
  <div class="side-panel" id="filter-panel" style="display:none;">
    <h4>Filter</h4>
    <div id="filter-node-types"></div>
    <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px;">
      <label><input type="checkbox" id="filter-show-all-nodes" checked onchange="toggleAllNodeTypes(this.checked)"> All node types</label>
    </div>
    <div style="margin-top:10px; border-top:1px solid rgba(255,255,255,0.06); padding-top:8px;">
      <h4 style="margin-bottom:6px;">Edge types</h4>
      <div id="filter-edge-types"></div>
    </div>
    <button class="reset-btn" onclick="resetFilters()">Reset filters</button>
  </div>

  <!-- Display settings panel -->
  <div class="side-panel" id="settings-panel" style="display:none; left:220px;">
    <h4>Display</h4>
    <div class="range-row">
      <div class="range-label"><span>Edge brightness</span><span id="edge-bright-val">1.0x</span></div>
      <input type="range" id="edge-brightness" min="0.1" max="3" step="0.1" value="1" oninput="onDisplaySettingChange()">
    </div>
    <div class="range-row">
      <div class="range-label"><span>Node glow</span><span id="node-glow-val">1.0x</span></div>
      <input type="range" id="node-glow" min="0.1" max="3" step="0.1" value="1" oninput="onDisplaySettingChange()">
    </div>
    <div class="range-row">
      <div class="range-label"><span>Bloom intensity</span><span id="bloom-inten-val">1.0x</span></div>
      <input type="range" id="bloom-intensity" min="0.1" max="3" step="0.1" value="1" oninput="onDisplaySettingChange()">
    </div>
    <button class="reset-btn" onclick="resetDisplaySettings()">Reset defaults</button>
  </div>

  <div id="controls">
    <button id="btn-filter" onclick="togglePanel('filter-panel')" class="ctrl-btn">Filter</button>
    <button id="btn-settings" onclick="togglePanel('settings-panel')" class="ctrl-btn">Display</button>
    <button onclick="refreshGraphData()">Refresh</button>
    <button onclick="resetCamera()">Reset View</button>
  </div>
  <div id="graph-path">GRAPH: ${graphPathDisplay}</div>
  <div id="stats">
    <span id="stats-nodes">Nodes: 0</span>
    <span id="stats-edges">Edges: 0</span>
    <span id="edge-limit-warn"></span>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/CopyShader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/shaders/LuminosityHighPassShader.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/EffectComposer.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/RenderPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/ShaderPass.js"></script>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/postprocessing/UnrealBloomPass.js"></script>
<script>
// ─── State ──────────────────────────────────────────────────────────
let scene, camera, renderer, composer = null;
let nodeMesh = null;
let edgeLines = null;
let nodeLabels = [];
let allNodes = [];     // accumulates nodes from batches
let allEdges = [];     // accumulates edges from batches
let nodeMap = new Map(); // id → index
let edgesNeedRebuild = false;
let nodesNeedRebuild = false;
let selectedNode = null;
let animationId = null;
let sceneReady = false;
const tempObj = new THREE.Object3D();
const tempColor = new THREE.Color();

// ─── Density & display settings ─────────────────────────────────────
let displaySettings = {
  edgeBrightness: 1.0,
  nodeGlow: 1.0,
  bloomIntensity: 1.0
};
// computed density values (recalculated on load-complete)
let densityEdgeScale = 1.0;
let densityBloomScale = 1.0;
let densityNodeBoostScale = 1.0;
let densitySphereSegments = 24;
let densityUsePointsMode = false;
let densityMaxRenderEdges = 50000;
let totalNodeBudget = ${totalNodes};

// ─── Filter state ───────────────────────────────────────────────────
let filterState = {
  nodeTypes: {},    // {label: boolean}
  edgeTypes: {},    // {type: boolean}
  allNodesOn: true,
  allEdgesOn: true
};
let knownNodeTypes = [];
let knownEdgeTypes = [];

// ─── Camera animation state ─────────────────────────────────────────
let cameraAnimTarget = null;       // {target: Vector3, radius: number, startTime: number, duration: number}
let lastInteractionTime = Date.now();
const IDLE_AUTO_ROTATE_DELAY = 60000;  // 60s idle → auto-rotate
const AUTO_ROTATE_SPEED = 0.4;

// ─── Edge type colors ───────────────────────────────────────────────
const EDGE_TYPE_COLORS = {
  CALLS: '#1DA27E', IMPORTS: '#3b82f6', DEFINES: '#a855f7', DEFINES_METHOD: '#a855f7',
  CONTAINS_FILE: '#22c55e', CONTAINS_FOLDER: '#22c55e', CONTAINS_PACKAGE: '#22c55e',
  HANDLES: '#eab308', IMPLEMENTS: '#f97316', HTTP_CALLS: '#e11d48',
  USAGE: '#64748b', RAISES: '#f59e0b', WRITES: '#ec4899',
  INHERITS: '#f97316', THROWS: '#f59e0b', DECORATES: '#a78bfa'
};
const DEFAULT_EDGE_COLOR = '#1C8585';

// precompute edge color cache (lazy: built on first use to avoid CDN race)
const edgeColorCache = {};
function buildEdgeColorCache() {
  if (Object.keys(edgeColorCache).length > 0) return;
  if (typeof THREE === 'undefined') return;
  try {
    const tc = new THREE.Color();
    for (const k in EDGE_TYPE_COLORS) {
      tc.set(EDGE_TYPE_COLORS[k]);
      edgeColorCache[k] = {r: tc.r, g: tc.g, b: tc.b};
    }
    tc.set(DEFAULT_EDGE_COLOR);
    edgeColorCache['__default__'] = {r: tc.r, g: tc.g, b: tc.b};
  } catch(e) {
    console.warn('[webview] buildEdgeColorCache failed:', e);
  }
}

// ─── Density-adaptive calculations (aligns with codebase-memory-mcp density.ts) ──
function recalcDensity() {
  const n = allNodes.length;
  const e = allEdges.length;

  // Edge intensity scale: sqrt(2500 / edgeCount), floor 0.05
  densityEdgeScale = e > 2500 ? Math.max(0.05, Math.sqrt(2500 / e)) : 1.0;

  // Bloom scale: linear 25k→250k nodes, range [0.7, 1.0]
  densityBloomScale = n > 25000 ? Math.max(0.7, 1.0 - (n - 25000) / (250000 - 25000) * 0.3) : 1.0;

  // Node boost scale: linear 25k→250k nodes, range [0.8, 1.0]
  densityNodeBoostScale = n > 25000 ? Math.max(0.8, 1.0 - (n - 25000) / (250000 - 25000) * 0.2) : 1.0;

  // Sphere subdivision: 8k→32seg, 25k→16seg, rest→10seg
  densitySphereSegments = n > 25000 ? 10 : n > 8000 ? 16 : 32;

  // Points mode threshold: >75k nodes
  densityUsePointsMode = n > 75000;

  // Edge render cap: scale with budget
  densityMaxRenderEdges = Math.min(100000, Math.max(10000, Math.floor(totalNodeBudget * 5)));
}

// ─── Per-node glow boost (aligns with codebase-memory-mcp) ──────────
function calcGlowBoost(color) {
  // Blue-dominant (high-degree hub): highest boost
  // Red-dominant (leaf): medium boost
  // White/yellow: lowest boost (bloom already handles)
  const b = color.b || 0, r = color.r || 0;
  const blueRatio = b / Math.max(0.01, r + (color.g || 0) + b);
  if (blueRatio > 0.45) return Math.min(0.8, (blueRatio - 0.45) * 2.5);  // blue hub: up to +0.8
  if (r > 0.8 && (color.g || 0) < 0.3) return 0.3;  // red leaf: +0.3
  return 0.05;  // default
}

// ─── Constellation pulse loading animation ──────────────────────────
let loadAnimId = null;
let loadAnimPhase = 0;
const LOAD_NODES = [{x:0.5,y:0.35},{x:0.3,y:0.6},{x:0.7,y:0.6},{x:0.2,y:0.3},{x:0.8,y:0.3},{x:0.5,y:0.75}];
const LOAD_EDGES = [[0,1],[0,2],[1,3],[2,4],[1,5],[2,5]];
function startLoadAnimation() {
  const canvas = document.getElementById('loading-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  function draw() {
    loadAnimId = requestAnimationFrame(draw);
    loadAnimPhase += 0.03;
    ctx.clearRect(0, 0, w, h);
    const t = loadAnimPhase;
    // Draw edges (fade in sequence)
    LOAD_EDGES.forEach(function(e, i) {
      const progress = Math.max(0, Math.min(1, (t - i * 0.3) / 1.5));
      if (progress <= 0) return;
      const a = LOAD_NODES[e[0]], b = LOAD_NODES[e[1]];
      ctx.strokeStyle = 'rgba(128,160,255,' + (progress * 0.3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x * w, a.y * h);
      ctx.lineTo(b.x * w, b.y * h);
      ctx.stroke();
    });
    // Draw nodes (pulse)
    LOAD_NODES.forEach(function(n, i) {
      const pulse = 0.4 + 0.3 * Math.sin(t * 2 + i);
      const alpha = 0.3 + 0.4 * pulse;
      ctx.fillStyle = 'rgba(128,160,255,' + alpha + ')';
      ctx.beginPath();
      ctx.arc(n.x * w, n.y * h, 4 + pulse * 2, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  draw();
}
function stopLoadAnimation() {
  if (loadAnimId) { cancelAnimationFrame(loadAnimId); loadAnimId = null; }
}

// ─── Panel toggle ────────────────────────────────────────────────────
function togglePanel(id) {
  const panel = document.getElementById(id);
  if (!panel) return;
  const isOpen = panel.style.display === 'block';
  panel.style.display = isOpen ? 'none' : 'block';
  // Update button state
  const btnId = id === 'filter-panel' ? 'btn-filter' : 'btn-settings';
  const btn = document.getElementById(btnId);
  if (btn) { btn.classList.toggle('active', !isOpen); }
  // Close other panel
  const otherId = id === 'filter-panel' ? 'settings-panel' : 'filter-panel';
  const other = document.getElementById(otherId);
  if (other) other.style.display = 'none';
  const otherBtn = document.getElementById(otherId === 'filter-panel' ? 'btn-filter' : 'btn-settings');
  if (otherBtn) otherBtn.classList.remove('active');
  // Build filter UI on first open
  if (id === 'filter-panel' && !isOpen && allNodes.length > 0) buildFilterUI();
}

// ─── Filter UI ───────────────────────────────────────────────────────
function buildFilterUI() {
  // Collect known types
  const ntSet = new Set(), etSet = new Set();
  allNodes.forEach(function(n) { ntSet.add(n.type || n.label || 'unknown'); });
  allEdges.forEach(function(e) { etSet.add(e.type || 'unknown'); });
  knownNodeTypes = Array.from(ntSet).sort();
  knownEdgeTypes = Array.from(etSet).sort();

  const ntDiv = document.getElementById('filter-node-types');
  ntDiv.innerHTML = '';
  knownNodeTypes.forEach(function(t) {
    const checked = filterState.nodeTypes[t] !== false;
    const label = document.createElement('label');
    label.innerHTML = '<input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="onNodeTypeFilter(\'' + t.replace(/'/g, "\\'") + '\', this.checked)"> ' + t;
    ntDiv.appendChild(label);
  });

  const etDiv = document.getElementById('filter-edge-types');
  etDiv.innerHTML = '';
  knownEdgeTypes.forEach(function(t) {
    const checked = filterState.edgeTypes[t] !== false;
    const colorHex = EDGE_TYPE_COLORS[t] || DEFAULT_EDGE_COLOR;
    const label = document.createElement('label');
    label.innerHTML = '<span class="color-dot" style="background:' + colorHex + '"></span><input type="checkbox" ' + (checked ? 'checked' : '') + ' onchange="onEdgeTypeFilter(\'' + t.replace(/'/g, "\\'") + '\', this.checked)"> ' + t;
    etDiv.appendChild(label);
  });
}

function onNodeTypeFilter(type, checked) {
  filterState.nodeTypes[type] = checked;
  filterState.allNodesOn = false;
  document.getElementById('filter-show-all-nodes').checked = false;
  scheduleFilteredRebuild();
}

function onEdgeTypeFilter(type, checked) {
  filterState.edgeTypes[type] = checked;
  filterState.allEdgesOn = false;
  scheduleFilteredRebuild();
}

function toggleAllNodeTypes(on) {
  filterState.allNodesOn = on;
  filterState.nodeTypes = {};
  document.querySelectorAll('#filter-node-types input[type=checkbox]').forEach(function(cb) { cb.checked = on; });
  scheduleFilteredRebuild();
}

function resetFilters() {
  filterState = { nodeTypes: {}, edgeTypes: {}, allNodesOn: true, allEdgesOn: true };
  document.getElementById('filter-show-all-nodes').checked = true;
  scheduleFilteredRebuild();
  buildFilterUI();
}

let filterRebuildTimer = null;
function scheduleFilteredRebuild() {
  if (filterRebuildTimer) clearTimeout(filterRebuildTimer);
  filterRebuildTimer = setTimeout(function() {
    rebuildNodeMeshFiltered();
    rebuildEdgeLinesFiltered();
    filterRebuildTimer = null;
  }, 100);
}

// ─── Display settings ───────────────────────────────────────────────
function onDisplaySettingChange() {
  displaySettings.edgeBrightness = parseFloat(document.getElementById('edge-brightness').value);
  displaySettings.nodeGlow = parseFloat(document.getElementById('node-glow').value);
  displaySettings.bloomIntensity = parseFloat(document.getElementById('bloom-intensity').value);
  document.getElementById('edge-bright-val').textContent = displaySettings.edgeBrightness.toFixed(1) + 'x';
  document.getElementById('node-glow-val').textContent = displaySettings.nodeGlow.toFixed(1) + 'x';
  document.getElementById('bloom-inten-val').textContent = displaySettings.bloomIntensity.toFixed(1) + 'x';
  // Apply bloom immediately
  if (composer && composer.passes && composer.passes.length >= 2) {
    const bloomPass = composer.passes[composer.passes.length - 1];
    if (bloomPass.strength !== undefined) {
      bloomPass.strength = displaySettings.bloomIntensity * densityBloomScale;
    }
  }
  scheduleFilteredRebuild();
}

function resetDisplaySettings() {
  displaySettings = { edgeBrightness: 1.0, nodeGlow: 1.0, bloomIntensity: 1.0 };
  document.getElementById('edge-brightness').value = 1;
  document.getElementById('node-glow').value = 1;
  document.getElementById('bloom-intensity').value = 1;
  document.getElementById('edge-bright-val').textContent = '1.0x';
  document.getElementById('node-glow-val').textContent = '1.0x';
  document.getElementById('bloom-inten-val').textContent = '1.0x';
  if (composer && composer.passes && composer.passes.length >= 2) {
    composer.passes[composer.passes.length - 1].strength = 0.4 * densityBloomScale;
  }
  scheduleFilteredRebuild();
}

// ─── Get filtered nodes/edges ───────────────────────────────────────
function getFilteredNodeIndices() {
  if (filterState.allNodesOn) return null;  // null = all
  const result = [];
  for (let i = 0; i < allNodes.length; i++) {
    const t = allNodes[i].type || allNodes[i].label || 'unknown';
    if (filterState.nodeTypes[t] !== false) result.push(i);
  }
  return result;
}

function isEdgeVisible(edge) {
  if (filterState.allEdgesOn) return true;
  return filterState.edgeTypes[edge.type] !== false;
}

function isNodeVisible(idx) {
  if (filterState.allNodesOn) return true;
  const t = allNodes[idx].type || allNodes[idx].label || 'unknown';
  return filterState.nodeTypes[t] !== false;
}

function setLoadingText(text) {
  var el = document.getElementById('loading-text-wrap');
  if (el) el.textContent = text;
}

// ─── Init scene (empty, nodes added incrementally) ──────────────────
function initScene() {
  try {
    console.log('[webview] initScene start, THREE=' + (typeof THREE !== 'undefined'));
    if (typeof THREE === 'undefined') {
      setLoadingText('Three.js failed to load from CDN.');
      return false;
    }
    const container = document.getElementById('canvas-container');
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x06090f);
    camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100000);
    camera.position.set(0, 0, 800);
    renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputEncoding = THREE.sRGBEncoding;
    container.appendChild(renderer.domElement);

    if (typeof THREE.EffectComposer !== 'undefined') {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      const bloomPass = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.4, 0.6);
      composer.addPass(bloomPass);
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    var pl1 = new THREE.PointLight(0xffffff, 0.6); pl1.position.set(500,500,500); scene.add(pl1);
    var pl2 = new THREE.PointLight(0x6040ff, 0.4); pl2.position.set(-300,-200,-300); scene.add(pl2);

    initControls();
    startLoadAnimation();
    sceneReady = true;
    console.log('[webview] initScene done, sceneReady=true');
    if(vscode) vscode.postMessage({type:'debug', msg:'initScene done, sceneReady=true'});
    window.addEventListener('resize', onWindowResize);
    animate();
    return true;
  } catch(err) {
    console.error('[webview] initScene error:', err);
    setLoadingText('Render init failed: ' + (err.message || err));
    return false;
  }
}

// ─── Controls (orbit + damping + idle auto-rotate + camera animation) ──
let isDragging = false, previousMouse = { x: 0, y: 0 };
let spherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let targetSpherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let target = new THREE.Vector3(0, 0, 0);
const DAMPING_FACTOR = 0.08;

function markInteraction() { lastInteractionTime = Date.now(); cameraAnimTarget = null; }

function initControls() {
  var canvas = renderer.domElement;
  canvas.addEventListener('mousedown', function(e) { if(e.button===0){isDragging=true;previousMouse={x:e.clientX,y:e.clientY};markInteraction();} });
  canvas.addEventListener('mousemove', function(e) { if(!isDragging){checkHover(e);return;} var dx=e.clientX-previousMouse.x,dy=e.clientY-previousMouse.y; targetSpherical.theta-=dx*0.005; targetSpherical.phi-=dy*0.005; targetSpherical.phi=Math.max(0.1,Math.min(Math.PI-0.1,targetSpherical.phi)); previousMouse={x:e.clientX,y:e.clientY}; markInteraction(); });
  canvas.addEventListener('mouseup', function() { isDragging=false; markInteraction(); });
  canvas.addEventListener('mouseleave', function() { isDragging=false; });
  canvas.addEventListener('wheel', function(e) { e.preventDefault(); targetSpherical.radius*=(1+e.deltaY*0.001); targetSpherical.radius=Math.max(10,Math.min(50000,targetSpherical.radius)); markInteraction(); }, {passive:false});
  canvas.addEventListener('click', function(e) { if(Math.abs(e.clientX-previousMouse.x)<5&&Math.abs(e.clientY-previousMouse.y)<5){checkClick(e);} markInteraction(); });
}

// ─── Camera animation (ease-out cubic, aligns with codebase-memory-mcp) ──
function animateCameraTo(centerPos, lookRadius, durationMs) {
  durationMs = durationMs || 1500;
  cameraAnimTarget = {
    target: new THREE.Vector3(centerPos.x, centerPos.y, centerPos.z),
    radius: lookRadius,
    startTime: Date.now(),
    duration: durationMs,
    startTheta: targetSpherical.theta,
    startPhi: targetSpherical.phi,
    startRadius: targetSpherical.radius,
    startTarget: target.clone()
  };
}

function updateCamera() {
  if (cameraAnimTarget) {
    var elapsed = Date.now() - cameraAnimTarget.startTime;
    var t = Math.min(1, elapsed / cameraAnimTarget.duration);
    // ease-out cubic
    var ease = 1 - Math.pow(1 - t, 3);
    targetSpherical.theta = cameraAnimTarget.startTheta + (cameraAnimTarget.startTheta + 0.01) * 0.01 * ease + cameraAnimTarget.startTheta * (1 - ease);
    // Recompute theta toward target
    var dx = cameraAnimTarget.target.x - target.x;
    var dz = cameraAnimTarget.target.z - target.z;
    var targetTheta = Math.atan2(dz, dx);
    // Smooth theta toward target
    targetSpherical.theta += (targetTheta - targetSpherical.theta) * ease;
    targetSpherical.phi = cameraAnimTarget.startPhi + (Math.PI * 0.35 - cameraAnimTarget.startPhi) * ease;
    targetSpherical.radius = cameraAnimTarget.startRadius + (cameraAnimTarget.radius - cameraAnimTarget.startRadius) * ease;
    target.lerp(cameraAnimTarget.target, ease);
    if (t >= 1) { cameraAnimTarget = null; markInteraction(); }
  }

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
  cameraAnimTarget = null;
  markInteraction();
}

// ─── Incremental node/edge addition ──────────────────────────────────
function addNodesBatch(nodes) {
  if (!nodes || nodes.length === 0) return;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    nodeMap.set(n.id, allNodes.length);
    allNodes.push(n);
  }
  if (allNodes.length <= 2000) {
    rebuildNodeMeshFiltered();
  } else {
    nodesNeedRebuild = true;
  }
  updateStats();
}

function addEdgesBatch(edges) {
  if (!edges || edges.length === 0) return;
  for (var i = 0; i < edges.length; i++) {
    allEdges.push(edges[i]);
  }
  edgesNeedRebuild = true;
  updateStats();
}

// ─── Density-adaptive node mesh rebuild ──────────────────────────────
function rebuildNodeMeshFiltered() {
  // Remove old mesh
  if (nodeMesh) { scene.remove(nodeMesh); if (nodeMesh.geometry) nodeMesh.geometry.dispose(); if (nodeMesh.material) nodeMesh.material.dispose(); nodeMesh = null; }
  nodeLabels.forEach(function(l) { if(l){scene.remove(l); if(l.material && l.material.map)l.material.map.dispose(); if(l.material)l.material.dispose();} });
  nodeLabels = [];
  if (allNodes.length === 0) return;

  recalcDensity();

  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;
  var filteredIndices = getFilteredNodeIndices();
  var useFiltered = filteredIndices !== null;
  var visibleCount = useFiltered ? filteredIndices.length : allNodes.length;
  if (visibleCount === 0) { updateStats(); return; }

  // PointSprites or InstancedMesh based on density
  if (densityUsePointsMode) {
    rebuildNodePoints(posScale, useFiltered ? filteredIndices : null);
  } else {
    rebuildNodeInstanced(posScale, useFiltered ? filteredIndices : null);
  }

  // Labels for top 80 visible nodes
  buildNodeLabels(posScale, useFiltered ? filteredIndices : null);

  targetSpherical.radius = scale * 3 + 100;
}

function rebuildNodeInstanced(posScale, filteredIndices) {
  var visibleCount = filteredIndices ? filteredIndices.length : allNodes.length;
  var segs = densitySphereSegments;
  var geometry = new THREE.SphereGeometry(1, segs, Math.ceil(segs * 0.67));
  var material = new THREE.MeshBasicMaterial({ toneMapped: false });
  nodeMesh = new THREE.InstancedMesh(geometry, material, visibleCount);
  nodeMesh.frustumCulled = false;
  nodeMesh.userData = { nodes: allNodes, filteredIndices: filteredIndices };

  var colorArray = new Float32Array(visibleCount * 3);
  for (var vi = 0; vi < visibleCount; vi++) {
    var i = filteredIndices ? filteredIndices[vi] : vi;
    var n = allNodes[i];
    tempObj.position.set(n.x * posScale, n.y * posScale, n.z * posScale);
    tempObj.scale.setScalar(n.size * 0.5);
    tempObj.updateMatrix();
    nodeMesh.setMatrixAt(vi, tempObj.matrix);
    tempColor.set(n.color);
    // Glow boost: boost brightness by node glow factor × density scale
    var glowBoost = calcGlowBoost(tempColor);
    var boost = 1.0 + glowBoost * displaySettings.nodeGlow * densityNodeBoostScale;
    tempColor.multiplyScalar(Math.min(boost, 2.5));
    colorArray[vi * 3] = tempColor.r;
    colorArray[vi * 3 + 1] = tempColor.g;
    colorArray[vi * 3 + 2] = tempColor.b;
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
  scene.add(nodeMesh);
}

function rebuildNodePoints(posScale, filteredIndices) {
  // PointSprites mode for >75k nodes: single vertex per node, 64px radial gradient sprite
  var visibleCount = filteredIndices ? filteredIndices.length : allNodes.length;
  var positionsArray = new Float32Array(visibleCount * 3);
  var colorsArray = new Float32Array(visibleCount * 3);

  for (var vi = 0; vi < visibleCount; vi++) {
    var i = filteredIndices ? filteredIndices[vi] : vi;
    var n = allNodes[i];
    positionsArray[vi * 3] = n.x * posScale;
    positionsArray[vi * 3 + 1] = n.y * posScale;
    positionsArray[vi * 3 + 2] = n.z * posScale;
    tempColor.set(n.color);
    var glowBoost = calcGlowBoost(tempColor);
    var boost = 1.0 + glowBoost * displaySettings.nodeGlow * densityNodeBoostScale;
    tempColor.multiplyScalar(Math.min(boost, 2.5));
    colorsArray[vi * 3] = tempColor.r;
    colorsArray[vi * 3 + 1] = tempColor.g;
    colorsArray[vi * 3 + 2] = tempColor.b;
  }

  var geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positionsArray, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colorsArray, 3));

  // Create radial gradient sprite texture (64px)
  var spriteCanvas = document.createElement('canvas');
  spriteCanvas.width = 64; spriteCanvas.height = 64;
  var ctx = spriteCanvas.getContext('2d');
  var gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  gradient.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 64, 64);
  var spriteTexture = new THREE.CanvasTexture(spriteCanvas);
  spriteTexture.needsUpdate = true;

  var mat = new THREE.PointsMaterial({
    size: 2.5, map: spriteTexture, vertexColors: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
    toneMapped: false, transparent: true, alphaTest: 0.35
  });
  nodeMesh = new THREE.Points(geo, mat);
  nodeMesh.frustumCulled = false;
  nodeMesh.userData = { nodes: allNodes, filteredIndices: filteredIndices, isPoints: true };
  scene.add(nodeMesh);
}

function buildNodeLabels(posScale, filteredIndices) {
  var candidates = [];
  for (var i = 0; i < allNodes.length; i++) {
    if (filteredIndices && filteredIndices.indexOf(i) === -1) continue;
    candidates.push({ node: allNodes[i], idx: i });
  }
  candidates.sort(function(a, b) { return b.node.size - a.node.size; });
  var labeled = candidates.slice(0, Math.min(80, candidates.length));

  labeled.forEach(function(item) {
    var node = item.node, origIdx = item.idx;
    var text = node.name || node.id || '?';
    var shortText = text.length > 24 ? text.substring(0, 22) + '...' : text;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var fontSize = 32;
    ctx.font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';
    var metrics = ctx.measureText(shortText);
    var tw = Math.ceil(metrics.width) + 16, th = fontSize + 8;
    canvas.width = tw; canvas.height = th;
    ctx.font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.fillStyle = node.color;
    ctx.strokeText(shortText, tw / 2, th / 2);
    ctx.fillText(shortText, tw / 2, th / 2);
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
    var sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(node.x * posScale, node.y * posScale, node.z * posScale);
    sprite.position.y += node.size * 0.5 + 2;
    var worldW = Math.max(4, node.size * 1.5);
    sprite.scale.set(worldW, worldW * (th / tw), 1);
    sprite.userData = { nodeIndex: origIdx };
    scene.add(sprite);
    nodeLabels[origIdx] = sprite;
  });
}

// ─── Density-adaptive edge lines rebuild ─────────────────────────────
function rebuildEdgeLinesFiltered() {
  buildEdgeColorCache();
  if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines.material.dispose(); edgeLines = null; }
  if (allEdges.length === 0 || allNodes.length === 0) return;

  recalcDensity();

  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;
  var maxRender = densityMaxRenderEdges;

  // Show edge limit warning
  var warnEl = document.getElementById('edge-limit-warn');
  if (allEdges.length > maxRender) {
    warnEl.style.display = 'inline';
    warnEl.textContent = '(showing ' + maxRender.toLocaleString() + ' / ' + allEdges.length.toLocaleString() + ' edges)';
  } else {
    warnEl.style.display = 'none';
  }

  // Pre-allocate
  var maxFloats = Math.min(allEdges.length, maxRender) * 6;
  var positions = new Float32Array(maxFloats);
  var colors = new Float32Array(maxFloats);
  var offset = 0;
  var validCount = 0;

  // Density-aware edge intensity
  var baseIntensity = 0.15 * displaySettings.edgeBrightness * densityEdgeScale;
  // Fallback color if cache is empty (THREE not loaded)
  var fallbackColor = { r: 0.11, g: 0.52, b: 0.52 };  // ≈ #1C8585

  for (var i = 0; i < allEdges.length && validCount < maxRender; i++) {
    var edge = allEdges[i];
    if (!isEdgeVisible(edge)) continue;

    var si = nodeMap.get(edge.source), ti = nodeMap.get(edge.target);
    if (si === undefined || ti === undefined) continue;
    if (!isNodeVisible(si) || !isNodeVisible(ti)) continue;

    var sn = allNodes[si], tn = allNodes[ti];

    positions[offset] = sn.x * posScale;
    positions[offset + 1] = sn.y * posScale;
    positions[offset + 2] = sn.z * posScale;
    positions[offset + 3] = tn.x * posScale;
    positions[offset + 4] = tn.y * posScale;
    positions[offset + 5] = tn.z * posScale;

    var c = edgeColorCache[edge.type] || edgeColorCache['__default__'] || fallbackColor;
    var r = c.r * baseIntensity, g = c.g * baseIntensity, b = c.b * baseIntensity;
    colors[offset] = r; colors[offset + 1] = g; colors[offset + 2] = b;
    colors[offset + 3] = r; colors[offset + 4] = g; colors[offset + 5] = b;

    offset += 6;
    validCount++;
  }

  if (validCount > 0) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, offset), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, offset), 3));
    var mat = new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
    });
    edgeLines = new THREE.LineSegments(geo, mat);
    scene.add(edgeLines);
  }
}

function updateStats() {
  document.getElementById('stats-nodes').textContent = 'Nodes: ' + allNodes.length.toLocaleString();
  document.getElementById('stats-edges').textContent = 'Edges: ' + allEdges.length.toLocaleString();
}

// ─── Interaction ────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function checkHover(event) {
  if (!nodeMesh) { renderer.domElement.style.cursor = 'default'; return; }
  var rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  // For Points mode, use larger threshold
  if (nodeMesh.isPoints) {
    raycaster.params.Points.threshold = 3;
    var intersects = raycaster.intersectObject(nodeMesh);
    renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
  } else {
    var intersects = raycaster.intersectObject(nodeMesh);
    renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
  }
}

function checkClick(event) {
  var rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!nodeMesh) return;

  if (nodeMesh.isPoints) {
    raycaster.params.Points.threshold = 3;
  }
  var intersects = raycaster.intersectObject(nodeMesh);

  if (intersects.length > 0) {
    var idx;
    if (nodeMesh.isPoints) {
      idx = intersects[0].index;
    } else {
      idx = intersects[0].instanceId;
    }
    // Map back to original node index if using filtered indices
    var filteredIndices = nodeMesh.userData.filteredIndices;
    var origIdx = filteredIndices ? filteredIndices[idx] : idx;
    if (origIdx !== undefined && allNodes[origIdx]) {
      showInfoPanel(allNodes[origIdx], event);
    }
  } else {
    closeInfoPanel();
  }
}

function showInfoPanel(node, clickEvent) {
  selectedNode = node;
  var panel = document.getElementById('info-panel');
  document.getElementById('info-title').innerText = node.name || node.id || 'Unknown';
  document.getElementById('info-meta').innerText = 'In: ' + node.inDegree + ' | Out: ' + node.outDegree;
  document.getElementById('info-path').innerText = node.filePath || 'N/A';
  document.getElementById('info-type').innerText = node.type || 'unknown';
  panel.style.display = 'block';
  if (clickEvent) {
    var rect = document.getElementById('canvas-container').getBoundingClientRect();
    var pw = panel.offsetWidth, ph = panel.offsetHeight;
    var x = clickEvent.clientX - rect.left + 16, y = clickEvent.clientY - rect.top + 16;
    if (x + pw > rect.width - 10) x = clickEvent.clientX - rect.left - pw - 16;
    if (y + ph > rect.height - 10) y = clickEvent.clientY - rect.top - ph - 16;
    if (x < 10) x = 10; if (y < 10) y = 10;
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  }

  // Camera fly-to animation
  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;
  var centerPos = new THREE.Vector3(node.x * posScale, node.y * posScale, node.z * posScale);
  var lookRadius = Math.max(spherical.radius * 0.4, Math.min(spherical.radius, node.size * 30 + 50));
  animateCameraTo(centerPos, lookRadius, 800);
}

function closeInfoPanel() { selectedNode = null; document.getElementById('info-panel').style.display = 'none'; }

function openCodeFile() {
  if(vscode) vscode.postMessage({type:'debug', msg:'openCodeFile called, selectedNode=' + (selectedNode ? selectedNode.name : 'null') + ', filePath=' + (selectedNode ? selectedNode.filePath : 'null')});
  if (!selectedNode || !selectedNode.filePath) return;
  if (vscode) vscode.postMessage({ type: 'open-file', filePath: selectedNode.filePath, qualifiedName: selectedNode.qualifiedName });
}

function refreshGraphData() { if (vscode) vscode.postMessage({ type: 'refresh-graph' }); }

// ─── Animation ──────────────────────────────────────────────────────
function animate() {
  animationId = requestAnimationFrame(animate);

  // Idle auto-rotate
  var idleTime = Date.now() - lastInteractionTime;
  if (idleTime > IDLE_AUTO_ROTATE_DELAY && !cameraAnimTarget) {
    targetSpherical.theta += 0.001 * AUTO_ROTATE_SPEED;
  }

  updateCamera();

  // Apply bloom intensity (density-adaptive + user setting)
  if (composer && composer.passes && composer.passes.length >= 2) {
    var bloomPass = composer.passes[composer.passes.length - 1];
    if (bloomPass.strength !== undefined) {
      var targetBloom = 0.4 * displaySettings.bloomIntensity * densityBloomScale;
      bloomPass.strength += (targetBloom - bloomPass.strength) * 0.05;
    }
  }

  if (composer) composer.render(); else renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (composer) composer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Error handler ──────────────────────────────────────────────────
window.addEventListener('error', function(e) {
  var msg = 'Error: ' + (e.message || 'unknown');
  console.error('[webview]', msg, e.error);
  setLoadingText(msg);
  if (vscode) { try { vscode.postMessage({type:'debug', msg: msg}); } catch(_) {} }
});

// ─── VS Code API ─────────────────────────────────────────────────────
const vscode = (function() { try { return acquireVsCodeApi(); } catch(e) { return null; } })();

// ─── Message handler: receive data batches from extension ───────────
window.addEventListener('message', function(e) {
  try {
    var msg = e.data;
    if (!msg || !msg.type) return;
    if (msg.type !== 'nodes-batch' && msg.type !== 'edges-batch' && msg.type !== 'load-complete') return;
    if (msg.type === 'nodes-batch') {
      if (!sceneReady) return;
      addNodesBatch(msg.nodes);
      var pct = msg.total > 0 ? Math.round(Math.min(msg.offset + msg.nodes.length, msg.total) / msg.total * 100) : 0;
      setLoadingText('Loading nodes ' + pct + '% (' + Math.min(msg.offset + msg.nodes.length, msg.total).toLocaleString() + '/' + msg.total.toLocaleString() + ')');
      var progressFill = document.getElementById('progress-fill');
      if (progressFill) progressFill.style.width = Math.min(pct, 90) + '%';
    } else if (msg.type === 'edges-batch') {
      if (!sceneReady) return;
      addEdgesBatch(msg.edges);
      setLoadingText('Loading edges ' + allEdges.length.toLocaleString() + '...');
    } else if (msg.type === 'load-complete') {
      // First hide loading overlay so user sees something, then do heavy work async
      setLoadingText('Building scene (' + allNodes.length.toLocaleString() + ' nodes, ' + allEdges.length.toLocaleString() + ' edges)...');
      stopLoadAnimation();
      var progressFill = document.getElementById('progress-fill');
      if (progressFill) progressFill.style.width = '95%';
      // Move heavy mesh rebuild off the main thread so loading text update is visible
      setTimeout(function() {
        try {
          if (nodesNeedRebuild) { rebuildNodeMeshFiltered(); nodesNeedRebuild = false; }
          if (progressFill) progressFill.style.width = '97%';
          if (edgesNeedRebuild) { rebuildEdgeLinesFiltered(); edgesNeedRebuild = false; }
          if (progressFill) progressFill.style.width = '100%';
          document.getElementById('loading').style.display = 'none';
          updateStats();
          buildFilterUI();
          var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
          targetSpherical.radius = scale * 3 + 100;
          if (vscode) { try { vscode.postMessage({type:'debug', msg:'scene built: ' + allNodes.length + ' nodes, ' + allEdges.length + ' edges'}); } catch(_) {} }
        } catch(err) {
          console.error('[webview] load-complete build error:', err);
          setLoadingText('Render error: ' + (err.message || err));
          if (vscode) { try { vscode.postMessage({type:'debug', msg:'render error: ' + (err.message||err)}); } catch(_) {} }
        }
      }, 30);
    }
  } catch(err) {
    console.error('[webview] message handler error:', err);
    setLoadingText('Error: ' + (err.message || err));
  }
});

// ─── Start ──────────────────────────────────────────────────────────
try {
  var ok = initScene();
  if (ok) {
    setLoadingText('Waiting for graph data...');
    if (vscode) { try { vscode.postMessage({ type: 'webview-ready' }); } catch(_) {} }
  } else {
    setLoadingText('Init failed (see console)');
  }
} catch(err) {
  setLoadingText('Fatal: ' + (err.message || err));
  if (vscode) { try { vscode.postMessage({type:'debug', msg:'init fatal: ' + (err.message||err)}); } catch(_) {} }
}
</script>
</body>
</html>`;
	}

	/** Open a file in VS Code editor */
	private async _openFileInEditor(filePath: string, qualifiedName?: string): Promise<void> {
		if (!filePath) { return; }
		try {
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { this._logService.warn(LOG_TAG, `open-file: no workspace folders`); return; }

			// 尝试每个 workspace folder，找到文件实际所在的根
			let fileUri: URI | undefined;
			for (const folder of folders) {
				const tryUri = URI.joinPath(folder.uri, filePath);
				try {
					const stat = await this._fileService.stat(tryUri);
					if (stat) { fileUri = tryUri; break; }
				} catch { /* try next folder */ }
			}

			// Fallback: 用第一个 folder
			if (!fileUri) {
				fileUri = URI.joinPath(folders[0].uri, filePath);
				this._logService.warn(LOG_TAG, `open-file: file not found in any folder, trying: ${fileUri.fsPath}`);
			}

			this._logService.info(LOG_TAG, `open-file: ${filePath} → ${fileUri.fsPath}`);
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
		this._statusEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;display:flex;flex-direction:column;align-items:center;gap:16px;';

		// 旋转动画 spinner
		const spinner = document.createElement('div');
		spinner.style.cssText = 'width:40px;height:40px;border:3px solid rgba(128,160,255,0.15);border-top-color:#80a0ff;border-radius:50%;animation:saros-spin 0.8s linear infinite;';
		this._statusEl.appendChild(spinner);

		// 注入 keyframes（只注入一次）
		if (!document.getElementById('saros-graph-loading-style')) {
			const style = document.createElement('style');
			style.id = 'saros-graph-loading-style';
			style.textContent = '@keyframes saros-spin{to{transform:rotate(360deg)}}';
			document.head.appendChild(style);
		}

		// 加载消息
		const msg = document.createElement('div');
		msg.style.cssText = 'color:var(--vscode-descriptionForeground);font-size:14px;';
		msg.textContent = message;
		this._statusEl.appendChild(msg);

		// 副标题：加载阶段提示
		const subMsg = document.createElement('div');
		subMsg.style.cssText = 'color:var(--vscode-disabledForeground);font-size:11px;margin-top:-8px;';
		subMsg.textContent = 'Codebase Graph Viewer';
		this._statusEl.appendChild(subMsg);

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

	/** Yield 到 UI 线程：让浏览器有机会渲染 DOM 更新后再执行后续 CPU 密集操作 */
	private _yieldToUI(): Promise<void> {
		return new Promise<void>(resolve => {
			// requestAnimationFrame 确保 DOM 已渲染，再 setTimeout(0) 让出微任务队列
			requestAnimationFrame(() => setTimeout(resolve, 0));
		});
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
