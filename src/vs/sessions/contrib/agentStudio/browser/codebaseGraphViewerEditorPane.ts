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
		await this._loadVisualization(token);
	}

	// ─── Core: Load Visualization via Native Graph Service ──────────────

	private async _loadVisualization(token: CancellationToken): Promise<void> {
		try {
			const t0 = Date.now();
			this._logService.info(LOG_TAG, `[load] step 0: start`);

			// 1. 轻量级检查：图中是否有数据
			let hasData = this._graphService.hasGraphData();
			this._logService.info(LOG_TAG, `[load] step 1: hasData=${hasData} (${Date.now() - t0}ms)`);

			// 2. 如果图为空，尝试加载已保存的 graph 文件
			if (!hasData) {
				this._showLoading('正在加载代码图谱...');
				await this._yieldToUI();
				const folders = this._workspaceService.getWorkspace().folders;
				if (folders.length === 0) {
					this._showError('未打开工作区。');
					return;
				}
				const wsUri = folders[0].uri;
				const graphFileUri = URI.joinPath(wsUri, '.codebase-memory', 'graph.db.zst');
				this._logService.info(LOG_TAG, `[load] step 2: loading graph file: ${graphFileUri.fsPath}`);
				const loaded = await this._graphService.loadGraph(graphFileUri.fsPath);
				this._logService.info(LOG_TAG, `[load] step 2 done: loaded=${loaded} (${Date.now() - t0}ms)`);
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

			// 3. 获取节点总数
			const totalNodes = this._graphService.getTotalNodeCount();
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
				const { nodes, total } = this._graphService.getVisualizationNodes(nodeOffset, NODE_BATCH);
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
			const totalEdges = this._graphService.getTotalEdgeCount();
			this._logService.info(LOG_TAG, `[load] step 7: sending ${totalEdges} edges in batches of ${EDGE_BATCH}...`);
			let edgeOffset = 0;
			let totalEdgesSent = 0;

			while (edgeOffset < totalEdges) {
				if (token.isCancellationRequested) { break; }

				const tBatch = Date.now();
				const edges = this._graphService.getVisualizationEdges(loadedNodeIds, edgeOffset, EDGE_BATCH);
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
				this._loadVisualization(CancellationToken.None).catch(err => {
					this._logService.error(LOG_TAG, 'Refresh failed:', err);
				});
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
#loading { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #fff; font-size: 18px; z-index: 100; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
#loading .spinner { width: 36px; height: 36px; border: 3px solid rgba(128,160,255,0.15); border-top-color: #80a0ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
#loading .sub { font-size: 11px; color: #666; }
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
#graph-path { position: absolute; top: 20px; right: 20px; color: #555; font-size: 11px; max-width: 400px; text-align: right; z-index: 10; word-break: break-all; font-family: monospace; }
</style>
</head>
<body>
<div id="canvas-container">
  <div id="loading">
    <div class="spinner"></div>
    <div id="loading-text">Initializing 3D renderer...</div>
    <div class="sub">Codebase Graph Viewer (${totalNodes} nodes)</div>
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
  <div id="controls">
    <button onclick="refreshGraphData()">Refresh</button>
    <button onclick="resetCamera()">Reset View</button>
  </div>
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
// ─── State ──────────────────────────────────────────────────────────
let scene, camera, renderer, composer = null;
let nodeMesh = null;
let edgeLines = null;
let nodeLabels = [];
let allNodes = [];     // accumulates nodes from batches
let allEdges = [];     // accumulates edges from batches
let nodeMap = new Map(); // id → index
let edgesNeedRebuild = false; // 标记边线需要重建（load-complete 时一次性构建）
let nodesNeedRebuild = false; // 标记节点 mesh 需要重建
let selectedNode = null;
let animationId = null;
let sceneReady = false;
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

function setLoadingText(text) {
  var el = document.getElementById('loading-text');
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
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    if (typeof THREE.EffectComposer !== 'undefined') {
      composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      composer.addPass(new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.4, 0.6));
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    var pl1 = new THREE.PointLight(0xffffff, 0.6); pl1.position.set(500,500,500); scene.add(pl1);
    var pl2 = new THREE.PointLight(0x6040ff, 0.4); pl2.position.set(-300,-200,-300); scene.add(pl2);

    initControls();
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

// ─── Controls (orbit + damping) ──────────────────────────────────────
let isDragging = false, previousMouse = { x: 0, y: 0 };
let spherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let targetSpherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let target = new THREE.Vector3(0, 0, 0);
let lastInteractionTime = Date.now();
const DAMPING_FACTOR = 0.08;

function initControls() {
  var canvas = renderer.domElement;
  canvas.addEventListener('mousedown', function(e) { if(e.button===0){isDragging=true;previousMouse={x:e.clientX,y:e.clientY};lastInteractionTime=Date.now();} });
  canvas.addEventListener('mousemove', function(e) { if(!isDragging){checkHover(e);return;} var dx=e.clientX-previousMouse.x,dy=e.clientY-previousMouse.y; targetSpherical.theta-=dx*0.005; targetSpherical.phi-=dy*0.005; targetSpherical.phi=Math.max(0.1,Math.min(Math.PI-0.1,targetSpherical.phi)); previousMouse={x:e.clientX,y:e.clientY}; lastInteractionTime=Date.now(); });
  canvas.addEventListener('mouseup', function() { isDragging=false; lastInteractionTime=Date.now(); });
  canvas.addEventListener('mouseleave', function() { isDragging=false; });
  canvas.addEventListener('wheel', function(e) { e.preventDefault(); targetSpherical.radius*=(1+e.deltaY*0.001); targetSpherical.radius=Math.max(10,Math.min(50000,targetSpherical.radius)); lastInteractionTime=Date.now(); }, {passive:false});
  canvas.addEventListener('click', function(e) { if(Math.abs(e.clientX-previousMouse.x)<5&&Math.abs(e.clientY-previousMouse.y)<5){checkClick(e);} lastInteractionTime=Date.now(); });
}

function updateCamera() {
  spherical.theta += (targetSpherical.theta - spherical.theta) * DAMPING_FACTOR;
  spherical.phi += (targetSpherical.phi - spherical.phi) * DAMPING_FACTOR;
  spherical.radius += (targetSpherical.radius - spherical.radius) * DAMPING_FACTOR;
  camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
  camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
  camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
  camera.lookAt(target);
}

function resetCamera() { targetSpherical = { radius: 150, phi: Math.PI/2, theta: 0 }; target = new THREE.Vector3(0,0,0); lastInteractionTime = Date.now(); }

// ─── Incremental node/edge addition ──────────────────────────────────
function addNodesBatch(nodes) {
  if (!nodes || nodes.length === 0) return;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    nodeMap.set(n.id, allNodes.length);
    allNodes.push(n);
  }
  // 节点也需要重建 mesh，但每批重建太重
  // 策略：第一批立即重建（让用户快速看到内容），后续批次累积到 load-complete
  if (allNodes.length <= 2000) {
    rebuildNodeMesh();
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
  // 不每批重建边线（234k 边 × 47 批 = 极重），标记需要重建，在 load-complete 时一次性构建
  edgesNeedRebuild = true;
  updateStats();
}

function rebuildNodeMesh() {
  // Remove old mesh
  if (nodeMesh) { scene.remove(nodeMesh); nodeMesh.geometry.dispose(); nodeMesh.material.dispose(); }
  nodeLabels.forEach(function(l) { if(l){scene.remove(l); if(l.material.map)l.material.map.dispose(); if(l.material)l.material.dispose();} });
  nodeLabels = [];
  if (allNodes.length === 0) return;

  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;

  var geometry = new THREE.SphereGeometry(1, 24, 16);
  var material = new THREE.MeshBasicMaterial({ toneMapped: false });
  nodeMesh = new THREE.InstancedMesh(geometry, material, allNodes.length);
  nodeMesh.frustumCulled = false;
  nodeMesh.userData = { nodes: allNodes };

  var colorArray = new Float32Array(allNodes.length * 3);
  for (var i = 0; i < allNodes.length; i++) {
    var n = allNodes[i];
    tempObj.position.set(n.x * posScale, n.y * posScale, n.z * posScale);
    tempObj.scale.setScalar(n.size * 0.5);
    tempObj.updateMatrix();
    nodeMesh.setMatrixAt(i, tempObj.matrix);
    tempColor.set(n.color);
    var brightness = (tempColor.r + tempColor.g + tempColor.b) / 3;
    tempColor.multiplyScalar(1.0 + brightness * 0.3);
    colorArray[i*3] = tempColor.r; colorArray[i*3+1] = tempColor.g; colorArray[i*3+2] = tempColor.b;
  }
  nodeMesh.instanceMatrix.needsUpdate = true;
  nodeMesh.instanceColor = new THREE.InstancedBufferAttribute(colorArray, 3);
  scene.add(nodeMesh);

  // Labels for top 80 nodes
  var labeled = allNodes.map(function(n,i){return {node:n,idx:i};}).sort(function(a,b){return b.node.size-a.node.size;}).slice(0,80);
  labeled.forEach(function(item) {
    var node = item.node, idx = item.idx;
    var text = node.name || node.id || '?';
    var shortText = text.length > 24 ? text.substring(0,22)+'...' : text;
    var canvas = document.createElement('canvas');
    var ctx = canvas.getContext('2d');
    var fontSize = 32;
    ctx.font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';
    var metrics = ctx.measureText(shortText);
    var tw = Math.ceil(metrics.width) + 16, th = fontSize + 8;
    canvas.width = tw, canvas.height = th;
    ctx.font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.fillStyle = node.color;
    ctx.strokeText(shortText, tw/2, th/2);
    ctx.fillText(shortText, tw/2, th/2);
    var texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false;
    var spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
    var sprite = new THREE.Sprite(spriteMat);
    sprite.position.set(node.x * posScale, node.y * posScale, node.z * posScale);
    sprite.position.y += node.size * 0.5 + 2;
    var worldW = Math.max(4, node.size * 1.5);
    sprite.scale.set(worldW, worldW * (th/tw), 1);
    sprite.userData = { nodeIndex: idx };
    scene.add(sprite);
    nodeLabels[idx] = sprite;
  });

  targetSpherical.radius = scale * 3 + 100;
}

function rebuildEdgeLines() {
  if (edgeLines) { scene.remove(edgeLines); edgeLines.geometry.dispose(); edgeLines.material.dispose(); edgeLines = null; }
  if (allEdges.length === 0 || allNodes.length === 0) return;

  var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
  var posScale = 50 / scale;

  // 限制最大边数，避免 234k 边卡死 webview
  var MAX_RENDER_EDGES = 50000;
  var edgesToRender = allEdges.length > MAX_RENDER_EDGES ? allEdges.slice(0, MAX_RENDER_EDGES) : allEdges;

  // 预分配 Float32Array（避免 push 扩容 + GC）
  var maxFloats = edgesToRender.length * 6;
  var positions = new Float32Array(maxFloats);
  var colors = new Float32Array(maxFloats);
  var offset = 0;
  var validCount = 0;

  // 缓存颜色对象
  var colorCache = {};
  var tmpColor = new THREE.Color();

  for (var i = 0; i < edgesToRender.length; i++) {
    var edge = edgesToRender[i];
    var si = nodeMap.get(edge.source), ti = nodeMap.get(edge.target);
    if (si === undefined || ti === undefined) continue;
    var sn = allNodes[si], tn = allNodes[ti];

    positions[offset] = sn.x * posScale;
    positions[offset + 1] = sn.y * posScale;
    positions[offset + 2] = sn.z * posScale;
    positions[offset + 3] = tn.x * posScale;
    positions[offset + 4] = tn.y * posScale;
    positions[offset + 5] = tn.z * posScale;

    // 缓存颜色解析
    var hex = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
    if (!colorCache[hex]) {
      tmpColor.set(hex);
      colorCache[hex] = { r: tmpColor.r, g: tmpColor.g, b: tmpColor.b };
    }
    var c = colorCache[hex];
    var intensity = 0.15;
    var r = c.r * intensity, g = c.g * intensity, b = c.b * intensity;
    colors[offset] = r; colors[offset + 1] = g; colors[offset + 2] = b;
    colors[offset + 3] = r; colors[offset + 4] = g; colors[offset + 5] = b;

    offset += 6;
    validCount++;
  }

  if (validCount > 0) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, offset), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, offset), 3));
    var mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    edgeLines = new THREE.LineSegments(geo, mat);
    scene.add(edgeLines);
  }
}

function updateStats() {
  document.getElementById('stats').innerText = 'Nodes: ' + allNodes.length + ' | Edges: ' + allEdges.length;
}

// ─── Interaction ────────────────────────────────────────────────────
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

function checkHover(event) {
  var rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!nodeMesh) return;
  var intersects = raycaster.intersectObject(nodeMesh);
  renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
}

function checkClick(event) {
  var rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  if (!nodeMesh) { if(vscode) vscode.postMessage({type:'debug', msg:'checkClick: nodeMesh is null'}); return; }
  var intersects = raycaster.intersectObject(nodeMesh);
  if(vscode) vscode.postMessage({type:'debug', msg:'checkClick: intersects=' + intersects.length});
  if (intersects.length > 0 && intersects[0].instanceId !== undefined) {
    var idx = intersects[0].instanceId;
    if(vscode) vscode.postMessage({type:'debug', msg:'checkClick: idx=' + idx + ', allNodes[idx]=' + (allNodes[idx] ? allNodes[idx].name : 'undefined')});
    if (allNodes[idx]) showInfoPanel(allNodes[idx], event);
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
  if(vscode) vscode.postMessage({type:'debug', msg:'showInfoPanel: node=' + node.name + ', filePath=' + node.filePath});
  if (clickEvent) {
    var rect = document.getElementById('canvas-container').getBoundingClientRect();
    var pw = panel.offsetWidth, ph = panel.offsetHeight;
    var x = clickEvent.clientX - rect.left + 16, y = clickEvent.clientY - rect.top + 16;
    if (x + pw > rect.width - 10) x = clickEvent.clientX - rect.left - pw - 16;
    if (y + ph > rect.height - 10) y = clickEvent.clientY - rect.top - ph - 16;
    if (x < 10) x = 10; if (y < 10) y = 10;
    panel.style.left = x + 'px'; panel.style.top = y + 'px';
  }
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
  updateCamera();
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
  setLoadingText('Error: ' + (e.message || 'unknown'));
});

// ─── VS Code API ─────────────────────────────────────────────────────
const vscode = (function() { try { return acquireVsCodeApi(); } catch(e) { return null; } })();

// ─── Message handler: receive data batches from extension ───────────
window.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || !msg.type) return;
  if (msg.type !== 'nodes-batch' && msg.type !== 'edges-batch' && msg.type !== 'load-complete') return; // skip other messages
  if (allNodes.length === 0 && msg.type === 'nodes-batch') { if(vscode) vscode.postMessage({type:'debug', msg:'FIRST nodes-batch received! offset=' + msg.offset + ', count=' + msg.nodes.length}); }
  if (msg.type === 'nodes-batch') {
    if (!sceneReady) { if(vscode) vscode.postMessage({type:'debug', msg:'nodes-batch DROPPED, scene not ready'}); return; }
    addNodesBatch(msg.nodes);
    setLoadingText('Loading nodes ' + Math.min(msg.offset + msg.nodes.length, msg.total) + '/' + msg.total + '...');
    if (allNodes.length <= 4000) { if(vscode) vscode.postMessage({type:'debug', msg:'nodes-batch: added=' + msg.nodes.length + ', total=' + allNodes.length}); }
  } else if (msg.type === 'edges-batch') {
    if (!sceneReady) { return; }
    addEdgesBatch(msg.edges);
    setLoadingText('Loading edges ' + allEdges.length + '...');
  } else if (msg.type === 'load-complete') {
    if(vscode) vscode.postMessage({type:'debug', msg:'load-complete: allNodes=' + allNodes.length + ', allEdges=' + allEdges.length});
    try {
      if (nodesNeedRebuild) { rebuildNodeMesh(); nodesNeedRebuild = false; if(vscode) vscode.postMessage({type:'debug', msg:'nodeMesh rebuilt, children=' + scene.children.length}); }
      if (edgesNeedRebuild) { rebuildEdgeLines(); edgesNeedRebuild = false; if(vscode) vscode.postMessage({type:'debug', msg:'edgeLines rebuilt'}); }
      document.getElementById('loading').style.display = 'none';
      updateStats();
      if(vscode) vscode.postMessage({type:'debug', msg:'load-complete done, scene.children=' + scene.children.length + ', nodeMesh=' + (nodeMesh?'yes':'no') + ', edgeLines=' + (edgeLines?'yes':'no')});
    } catch(err) {
      if(vscode) vscode.postMessage({type:'debug', msg:'load-complete ERROR: ' + (err.message||err)});
      setLoadingText('Render error: ' + (err.message || err));
    }
  }
});

// ─── Start ──────────────────────────────────────────────────────────
var ok = initScene();
if (ok) {
  setLoadingText('Waiting for graph data...');
  if (vscode) vscode.postMessage({ type: 'webview-ready' });
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
