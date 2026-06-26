/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Codebase Graph Viewer EditorPane — 方案 B：通过 MCP 工具获取数据 + webview 中 Three.js 渲染
 *
 * 实现方式：
 * 1. 通过 IMcpService 调用 search_graph 获取节点列表（分页，限制 2000 个）
 * 2. 通过 IMcpService 调用 query_graph (Cypher) 获取边列表（限制 200 条）
 * 3. 在 webview 中用力导向布局算法计算 3D 坐标
 * 4. 使用 Three.js (via CDN) 渲染交互式 3D 图谱
 * 5. 支持节点点击 → 在 VS Code 中打开代码文件
 *
 * 不依赖 codebase-memory-mcp 的 UI 服务器（--ui=true），纯 MCP 协议获取数据。
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
import { IMcpService, McpConnectionState } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';

const LOG_TAG = '[CodebaseGraphViewer]';
const SERVER_NAME = 'codebase-memory-mcp';
const MAX_NODES = 2000;
const MAX_EDGES = 200;

interface GraphNode {
	id: string;
	name: string;
	type: string;
	filePath?: string;
	qualifiedName?: string;
	inDegree: number;
	outDegree: number;
	x: number;
	y: number;
	z: number;
}

interface GraphEdge {
	source: string;
	target: string;
	type: string;
}

interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

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
		@IMcpService private readonly _mcpService: IMcpService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
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

	// ─── Core: Load Visualization via MCP ───────────────────────────────

	private async _loadVisualization(token: CancellationToken): Promise<void> {
		try {
			// 1. 解析项目名（codebase-memory-mcp 格式）
			const projectName = this._resolveFullProjectName();
			if (!projectName) {
				this._showError('无法解析项目名称。请确保已索引代码库。');
				return;
			}

			this._logService.info(LOG_TAG, `Fetching graph data for project "${projectName}"...`);

			// 2. 通过 MCP 工具获取 graph 数据
			const graphData = await this._fetchGraphData(projectName, token);
			if (token.isCancellationRequested) { return; }

			if (graphData.nodes.length === 0) {
				this._showError('图谱为空。请先索引代码库。');
				return;
			}

		this._logService.info(LOG_TAG, `Graph data loaded: ${graphData.nodes.length} nodes, ${graphData.edges.length} edges`);
		this._showLoading(`正在渲染 ${graphData.nodes.length} 个节点...`);

		// 3. 获取 graph 文件路径用于显示
		let graphPath = '';
		try {
			const status = await this._cbmService.getGraphStatus();
			graphPath = status.graphPath || '';
		} catch { /* ignore */ }

		// 4. 在 webview 中渲染
		this._renderGraph(graphData, graphPath);

		} catch (err: any) {
			const msg = err?.message || String(err);
			this._logService.error(LOG_TAG, 'Failed to load visualization:', err);
			this._showError(`加载可视化失败: ${msg}`);
		}
	}

	/** 解析完整的 codebase-memory-mcp 项目名 */
	private _resolveFullProjectName(): string | undefined {
		const folders = this._workspaceService.getWorkspace().folders;
		if (folders.length === 0) { return undefined; }
		const wsPath = folders[0].uri.fsPath;

		const config = this._cbmService.getIndexConfig();
		let repoPath = wsPath;
		if (config.subPath && config.subPath.trim()) {
			const sep = this._isWindows() ? '\\' : '/';
			repoPath = wsPath + sep + config.subPath.trim().replace(/[\\/]/g, sep);
		}

		// codebase-memory-mcp 项目名 = repo_path 去掉冒号 + 分隔符替换为 - + 盘符大写
		// 例：g:\Foo\Bar → G-Foo-Bar（G- 来自盘符 G: 去掉冒号，不是前缀）
		const normalized = repoPath.replace(/:/g, '').replace(/[\\\/]/g, '-').replace(/^([a-z])/, (_, c) => c.toUpperCase());
		return normalized;
	}

	private _isWindows(): boolean {
		return typeof process !== 'undefined' && process.platform === 'win32';
	}

	/** 通过 MCP search_graph + query_graph 获取 graph 数据 */
	private async _fetchGraphData(projectName: string, token: CancellationToken): Promise<GraphData> {
		// 1. 查找 MCP 服务器
		const servers = this._mcpService.servers.get();
		const server = servers.find(s =>
			s.definition.label === SERVER_NAME
			|| s.definition.id === SERVER_NAME
			|| s.definition.id.includes('codebase_memory_mcp')
			|| s.definition.id.includes('codebase-memory-mcp')
		);
		if (!server) {
			throw new Error(`MCP server "${SERVER_NAME}" not found`);
		}

		// 2. 确保服务器已启动
		const connState = server.connectionState.get();
		if (connState.state !== McpConnectionState.Kind.Running) {
			this._showLoading('正在启动 MCP 服务器...');
			await server.start();
		}

		// 3. 查找工具
		const tools = server.tools.get();
		const searchTool = tools.find(t => t.definition.name === 'search_graph');
		const queryTool = tools.find(t => t.definition.name === 'query_graph');
		if (!searchTool) {
			throw new Error('Tool "search_graph" not found on MCP server');
		}

		// 4. 获取节点数据（分页）
		const nodes: GraphNode[] = [];
		const pageSize = 100;
		let offset = 0;

		while (nodes.length < MAX_NODES) {
			if (token.isCancellationRequested) { break; }

			this._showLoading(`正在获取节点数据... (${nodes.length}/${MAX_NODES})`);

			const params: Record<string, unknown> = {
				project: projectName,
				name_pattern: '.*',
				limit: pageSize,
				offset: offset,
			};

			const result = await searchTool.call(params, undefined, token);
			const text = this._extractText(result);
			const data = JSON.parse(text);

			if (!data.results || data.results.length === 0) { break; }

			for (const r of data.results) {
				if (nodes.length >= MAX_NODES) { break; }
				nodes.push({
					id: r.qualified_name || r.name,
					name: r.name,
					type: (r.label || 'unknown').toLowerCase(),
					filePath: r.file_path,
					qualifiedName: r.qualified_name,
					inDegree: r.in_degree || 0,
					outDegree: r.out_degree || 0,
					x: 0, y: 0, z: 0,
				});
			}

			if (!data.has_more) { break; }
			offset += pageSize;
		}

		this._logService.info(LOG_TAG, `Fetched ${nodes.length} nodes`);

		// 5. 获取边数据（Cypher 查询，200 行上限）
		const edges: GraphEdge[] = [];
		if (queryTool) {
			this._showLoading('正在获取边数据...');
			try {
				const cypher = 'MATCH (a)-[r]->(b) RETURN a.qualified_name, b.qualified_name, type(r) LIMIT ' + MAX_EDGES;
				const result = await queryTool.call({ project: projectName, query: cypher }, undefined, token);
				const text = this._extractText(result);
				const data = JSON.parse(text);

				if (data.results) {
					for (const r of data.results) {
						const source = r['a.qualified_name'] || r[0] || '';
						const target = r['b.qualified_name'] || r[1] || '';
						const type = r['type(r)'] || r[2] || 'UNKNOWN';
						if (source && target) {
							edges.push({ source, target, type });
						}
					}
				}
			} catch (err: any) {
				this._logService.warn(LOG_TAG, `Failed to fetch edges: ${err?.message || err}`);
			}
		}

		this._logService.info(LOG_TAG, `Fetched ${edges.length} edges`);
		return { nodes, edges };
	}

	/** 从 MCP CallToolResult 中提取文本 */
	private _extractText(result: any): string {
		if (result.content && Array.isArray(result.content)) {
			return result.content.map((c: any) => c.text || '').join('\n').trim();
		}
		return '';
	}

	// ─── Rendering: Three.js 3D Graph with Force-Directed Layout ─────────

	private _renderGraph(graphData: GraphData, graphPath: string): void {
		if (!this._container) { return; }

		this._clearStatus();
		this._disposeWebview();

		// 将 graph 数据嵌入 webview HTML
		const graphJson = JSON.stringify(graphData);
		const graphPathDisplay = graphPath || 'N/A';

		const html = `<!DOCTYPE html>
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
#info-panel { position: absolute; top: 20px; left: 20px; background: rgba(6,9,15,0.92); color: #fff; padding: 16px 20px; border-radius: 12px; font-size: 13px; max-width: 420px; display: none; z-index: 10; backdrop-filter: blur(10px); border: 1px solid rgba(128,160,255,0.2); box-shadow: 0 0 30px rgba(128,160,255,0.1); }
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
/* Filter Panel */
#filter-panel { position: absolute; top: 0; left: 0; width: 260px; height: 100vh; background: rgba(6,9,15,0.95); color: #ccc; overflow-y: auto; z-index: 20; border-right: 1px solid rgba(128,160,255,0.15); backdrop-filter: blur(10px); font-size: 12px; }
#filter-panel .fp-header { padding: 14px 16px 10px; border-bottom: 1px solid rgba(255,255,255,0.08); }
#filter-panel .fp-stats { font-size: 13px; color: #80a0ff; font-weight: 600; }
#filter-panel .fp-section { padding: 10px 16px; }
#filter-panel .fp-section-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between; }
#filter-panel .fp-allnone { display: flex; gap: 4px; }
#filter-panel .fp-allnone button { background: rgba(255,255,255,0.08); color: #aaa; border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 10px; }
#filter-panel .fp-allnone button:hover { background: rgba(255,255,255,0.2); color: #fff; }
#filter-panel .fp-group-title { font-size: 11px; color: #888; margin: 10px 0 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
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
      <div class="fp-group-title">Nodes</div>
      <div id="fp-node-types"></div>
      <div class="fp-group-title">Edges</div>
      <div id="fp-edge-types"></div>
      <div class="fp-checkbox">
        <input type="checkbox" id="fp-show-labels" checked onchange="toggleLabels()">
        <label for="fp-show-labels">Show labels</label>
      </div>
      <div class="fp-search">
        <input type="text" id="fp-search-input" placeholder="Search nodes..." oninput="onSearchNodes()">
      </div>
      <div class="fp-group-title">Directories</div>
      <div class="fp-dir-list" id="fp-dir-list"></div>
    </div>
  </div>
  <div id="loading">⏳ 正在计算 3D 布局...</div>
  <div id="info-panel">
    <span class="close-btn" onclick="closeInfoPanel()">×</span>
    <h3 id="info-title"></h3>
    <div class="meta" id="info-meta"></div>
    <div class="section">
      <div class="label">文件路径</div>
      <div class="value" id="info-path"></div>
    </div>
    <div class="section">
      <div class="label">节点类型</div>
      <div class="value" id="info-type"></div>
    </div>
    <button class="open-btn" onclick="openCodeFile()">📂 在编辑器中打开</button>
  </div>
  <div id="controls">
    <button onclick="refreshGraphData()">🔄 Refresh</button>
    <button onclick="resetCamera()">🎥 Reset View</button>
  </div>
  <div id="graph-path">GRAPH: ${graphPathDisplay}</div>
  <div id="stats"></div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
// ─── Graph Data (embedded from MCP) ──────────────────────────────────
const GRAPH_DATA = ${graphJson};

// ─── State ─────────────────────────────────────────────────────────────
let scene, camera, renderer;
let nodeMeshes = [], edgeLines = null;
let nodeLabels = [];
let selectedNode = null;
let showLabels = true;
let animationId = null;

const EDGE_TYPE_COLORS = {
  CALLS: '#1DA27E', IMPORTS: '#3b82f6', DEFINES: '#a855f7', DEFINES_METHOD: '#a855f7',
  CONTAINS_FILE: '#22c55e', CONTAINS_FOLDER: '#22c55e', CONTAINS_PACKAGE: '#22c55e',
  HANDLES: '#eab308', IMPLEMENTS: '#f97316', HTTP_CALLS: '#e11d48',
  USAGE: '#64748b', RAISES: '#f59e0b', WRITES: '#ec4899',
  INHERITS: '#f97316', THROWS: '#f59e0b', DECORATES: '#a78bfa'
};
const DEFAULT_EDGE_COLOR = '#1C8585';

// Stellar color based on connection count (codebase-memory-mcp layout3d.c)
function stellarColor(connections) {
  if (connections >= 50) return '#80a0ff'; // O (Blue Giant)
  if (connections >= 26) return '#c0d0ff'; // B (Blue-White)
  if (connections >= 13) return '#e8e8ff'; // A (White)
  if (connections >= 7) return '#fff0c0';  // F (Yellow-White)
  if (connections >= 4) return '#ffe080';  // G (Yellow/Sun)
  if (connections >= 2) return '#ffa060';  // K (Orange)
  return '#ff6050'; // M (Red Dwarf)
}

function nodeSize(connections) {
  return 2 + Math.min(connections, 50) * 0.15;
}

// ─── Force-Directed 3D Layout ─────────────────────────────────────────
function computeLayout(nodes, edges, iterations) {
  const n = nodes.length;
  if (n === 0) { return; }

  // Initialize random positions in a sphere
  nodes.forEach(node => {
    const r = 30 * Math.cbrt(n);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    node.x = r * Math.sin(phi) * Math.cos(theta);
    node.y = r * Math.sin(phi) * Math.sin(theta);
    node.z = r * Math.cos(phi);
  });

  // Build node index map
  const nodeMap = new Map();
  nodes.forEach((node, i) => { nodeMap.set(node.id, i); });

  // Force simulation
  const repulsion = 200;
  const attraction = 0.05;
  const damping = 0.85;
  const dt = 0.02;

  for (let iter = 0; iter < iterations; iter++) {
    const forces = nodes.map(() => ({ x: 0, y: 0, z: 0 }));

    // Repulsion (all pairs)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dz = nodes[i].z - nodes[j].z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.1;
        const force = repulsion / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        forces[i].x += fx; forces[i].y += fy; forces[i].z += fz;
        forces[j].x -= fx; forces[j].y -= fy; forces[j].z -= fz;
      }
    }

    // Attraction (edges)
    edges.forEach(edge => {
      const si = nodeMap.get(edge.source);
      const ti = nodeMap.get(edge.target);
      if (si === undefined || ti === undefined) { return; }
      const dx = nodes[si].x - nodes[ti].x;
      const dy = nodes[si].y - nodes[ti].y;
      const dz = nodes[si].z - nodes[ti].z;
      const dist = Math.sqrt(dx*dx + dy*dy + dz*dz) + 0.1;
      const force = attraction * dist;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      const fz = (dz / dist) * force;
      forces[si].x -= fx; forces[si].y -= fy; forces[si].z -= fz;
      forces[ti].x += fx; forces[ti].y += fy; forces[ti].z += fz;
    });

    // Apply forces
    for (let i = 0; i < n; i++) {
      nodes[i].x += forces[i].x * dt * damping;
      nodes[i].y += forces[i].y * dt * damping;
      nodes[i].z += forces[i].z * dt * damping;
    }
  }

  // Center the graph
  let cx = 0, cy = 0, cz = 0;
  nodes.forEach(node => { cx += node.x; cy += node.y; cz += node.z; });
  cx /= n; cy /= n; cz /= n;
  nodes.forEach(node => { node.x -= cx; node.y -= cy; node.z -= cz; });
}

// ─── Initialization ───────────────────────────────────────────────────
function init() {
  const container = document.getElementById('canvas-container');

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06090f);

  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100000);
  camera.position.set(0, 0, 800);

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  // Lighting matching codebase-memory-mcp GraphScene
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
  scene.add(ambientLight);
  const pointLight1 = new THREE.PointLight(0xffffff, 0.6);
  pointLight1.position.set(500, 500, 500);
  scene.add(pointLight1);
  const pointLight2 = new THREE.PointLight(0x6040ff, 0.4);
  pointLight2.position.set(-300, -200, -300);
  scene.add(pointLight2);

  initControls();

  // Compute layout and render
  const nodes = GRAPH_DATA.nodes;
  const edges = GRAPH_DATA.edges;

  document.getElementById('loading').innerText = '⏳ 正在计算 3D 布局... (' + nodes.length + ' 节点)';

  // Use setTimeout to let the loading message render
  setTimeout(() => {
    const iterCount = Math.min(100, Math.max(30, Math.floor(2000 / nodes.length)));
    computeLayout(nodes, edges, iterCount);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('stats').innerText = '节点: ' + nodes.length + ' | 边: ' + edges.length;
    renderGraph(nodes, edges);
  }, 50);

  window.addEventListener('resize', onWindowResize);
  animate();
}

// ─── Simple Orbit Controls ────────────────────────────────────────────
let isDragging = false;
let previousMouse = { x: 0, y: 0 };
let spherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
let target = new THREE.Vector3(0, 0, 0);

function initControls() {
  const canvas = renderer.domElement;

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) { isDragging = true; previousMouse = { x: e.clientX, y: e.clientY }; }
  });

  canvas.addEventListener('mousemove', (e) => {
    if (!isDragging) { checkHover(e); return; }
    const dx = e.clientX - previousMouse.x;
    const dy = e.clientY - previousMouse.y;
    spherical.theta -= dx * 0.005;
    spherical.phi -= dy * 0.005;
    spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
    previousMouse = { x: e.clientX, y: e.clientY };
  });

  canvas.addEventListener('mouseup', () => { isDragging = false; });
  canvas.addEventListener('mouseleave', () => { isDragging = false; });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    spherical.radius *= (1 + e.deltaY * 0.001);
    spherical.radius = Math.max(10, Math.min(1000, spherical.radius));
  }, { passive: false });

  canvas.addEventListener('click', (e) => {
    if (Math.abs(e.clientX - previousMouse.x) < 5 && Math.abs(e.clientY - previousMouse.y) < 5) {
      checkClick(e);
    }
  });
}

function updateCamera() {
  camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
  camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
  camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
  camera.lookAt(target);
}

function resetCamera() {
  spherical = { radius: 150, phi: Math.PI / 2, theta: 0 };
  target = new THREE.Vector3(0, 0, 0);
}

// ─── Render Graph (codebase-memory-mcp style) ─────────────────────────
function renderGraph(nodes, edges) {
  nodeMeshes.forEach(m => scene.remove(m));
  nodeLabels.forEach(l => scene.remove(l));
  if (edgeLines) { scene.remove(edgeLines); }
  nodeMeshes = []; nodeLabels = []; edgeLines = null;

  if (nodes.length === 0) { return; }

  const scale = Math.max(1, Math.sqrt(nodes.length) * 5);
  const posScale = 50 / scale;

  // Pre-compute node colors and sizes (stellar mapping)
  const nodeData = nodes.map(node => {
    const connections = (node.inDegree || 0) + (node.outDegree || 0);
    const colorHex = stellarColor(connections);
    const color = new THREE.Color(colorHex);
    // Color boost: brighter stars get stronger glow (simulates bloom)
    const brightness = (color.r + color.g + color.b) / 3;
    const boost = 1.2 + brightness * 0.8;
    color.multiplyScalar(boost);
    const size = nodeSize(connections);
    return { color, size, connections };
  });

  // Create nodes — sphereGeometry + meshBasicMaterial (toneMapped=false for glow)
  const nodeGeometry = new THREE.SphereGeometry(1, 32, 24);
  nodes.forEach((node, idx) => {
    const nd = nodeData[idx];
    const material = new THREE.MeshBasicMaterial({ color: nd.color, toneMapped: false });
    const mesh = new THREE.Mesh(nodeGeometry, material);
    mesh.scale.setScalar(nd.size * 0.5);
    mesh.position.set(node.x * posScale, node.y * posScale, node.z * posScale);
    mesh.userData = { nodeIndex: idx, node: node };
    scene.add(mesh);
    nodeMeshes.push(mesh);
  });

  // Create labels — top 80 nodes by size, with stroke
  if (showLabels) {
    const labelCanvas = document.createElement('canvas');
    const ctx = labelCanvas.getContext('2d');
    const fontSize = 32;
    const font = '600 ' + fontSize + 'px Inter, system-ui, sans-serif';

    // Sort by size, take top 80
    const labeled = nodes.map((n, i) => ({ node: n, idx: i, size: nodeData[i].size }))
      .sort((a, b) => b.size - a.size)
      .slice(0, 80);

    labeled.forEach(({ node, idx }) => {
      const nd = nodeData[idx];
      const colorHex = stellarColor(nd.connections);
      const text = node.name || node.id || '?';
      const shortText = text.length > 24 ? text.substring(0, 22) + '...' : text;

      ctx.font = font;
      const metrics = ctx.measureText(shortText);
      const tw = Math.ceil(metrics.width) + 16;
      const th = fontSize + 8;
      labelCanvas.width = tw;
      labelCanvas.height = th;

      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.9)';
      ctx.fillStyle = colorHex;
      ctx.strokeText(shortText, tw / 2, th / 2);
      ctx.fillText(shortText, tw / 2, th / 2);

      const texture = new THREE.CanvasTexture(labelCanvas);
      texture.minFilter = THREE.LinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = false;
      const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false });
      const sprite = new THREE.Sprite(spriteMat);
      const mesh = nodeMeshes[idx];
      sprite.position.copy(mesh.position);
      sprite.position.y += nd.size * 0.5 + 2;
      const worldW = Math.max(4, nd.size * 1.5);
      const worldH = worldW * (th / tw);
      sprite.scale.set(worldW, worldH, 1);
      sprite.userData = { nodeIndex: idx };
      scene.add(sprite);
      nodeLabels[idx] = sprite;
    });
  }

  // Create edges — lineSegments + additiveBlending + type-based colors
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
        const off = validCount * 6;
        positions.push(
          sn.x * posScale, sn.y * posScale, sn.z * posScale,
          tn.x * posScale, tn.y * posScale, tn.z * posScale
        );
        // Edge color based on type
        const edgeColorHex = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
        const ec = new THREE.Color(edgeColorHex);
        // Intensity: same-cluster brighter, cross-cluster dimmer
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
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      const material = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      edgeLines = new THREE.LineSegments(geometry, material);
      scene.add(edgeLines);
    }
  }

  spherical.radius = scale * 3 + 100;
  
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
  allNodes.forEach(function(node, i) {
    var type = (node.type || 'unknown').toLowerCase();
    var isVisible = activeNodeTypes.has(type);
    if (isVisible && activeDir) {
      var dir = getTopDir(node.filePath);
      if (dir !== activeDir) isVisible = false;
    }
    if (nodeMeshes[i]) {
      nodeMeshes[i].visible = isVisible;
      if (isVisible) {
        if (searchQuery) {
          var name = (node.name || node.id || '').toLowerCase();
          var qualName = (node.qualifiedName || '').toLowerCase();
          if (!name.includes(searchQuery) && !qualName.includes(searchQuery)) {
            nodeMeshes[i].material.opacity = 0.1;
            nodeMeshes[i].material.transparent = true;
          } else {
            nodeMeshes[i].material.opacity = 1.0;
            nodeMeshes[i].material.transparent = false;
          }
        } else {
          nodeMeshes[i].material.opacity = 1.0;
          nodeMeshes[i].material.transparent = false;
        }
      }
    }
    if (nodeLabels[i]) {
      nodeLabels[i].visible = isVisible && showLabels;
    }
    if (isVisible) visibleNodeCount++;
  });

  if (edgeLines) {
    scene.remove(edgeLines);
    edgeLines.geometry.dispose();
    edgeLines.material.dispose();
    edgeLines = null;
  }

  var visibleEdgeCount = 0;
  if (allEdges.length > 0) {
    var nodeMap = new Map();
    allNodes.forEach(function(node, i) { nodeMap.set(node.id, i); });

    var positions = [];
    var colors = [];
    var scale = Math.max(1, Math.sqrt(allNodes.length) * 5);
    var posScale = 50 / scale;

    allEdges.forEach(function(edge) {
      var type = (edge.type || 'UNKNOWN').toLowerCase();
      if (!activeEdgeTypes.has(type)) return;
      var si = nodeMap.get(edge.source);
      var ti = nodeMap.get(edge.target);
      if (si === undefined || ti === undefined) return;
      if (nodeMeshes[si] && !nodeMeshes[si].visible) return;
      if (nodeMeshes[ti] && !nodeMeshes[ti].visible) return;
      var sn = allNodes[si], tn = allNodes[ti];
      positions.push(sn.x * posScale, sn.y * posScale, sn.z * posScale, tn.x * posScale, tn.y * posScale, tn.z * posScale);
      var edgeColorHex = EDGE_TYPE_COLORS[edge.type] || DEFAULT_EDGE_COLOR;
      var ec = new THREE.Color(edgeColorHex);
      var sCluster = (sn.filePath || '').split('/').slice(0, 2).join('/');
      var tCluster = (tn.filePath || '').split('/').slice(0, 2).join('/');
      var intensity = sCluster === tCluster ? 0.25 : 0.06;
      colors.push(ec.r * intensity, ec.g * intensity, ec.b * intensity, ec.r * intensity, ec.g * intensity, ec.b * intensity);
      visibleEdgeCount++;
    });

    if (visibleEdgeCount > 0) {
      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      var material = new THREE.LineBasicMaterial({
        vertexColors: true, transparent: true, opacity: 1.0,
        blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false
      });
      edgeLines = new THREE.LineSegments(geometry, material);
      scene.add(edgeLines);
    }
  }

  document.getElementById('fp-stats').innerText =
    visibleNodeCount + ' / ' + allNodes.length + ' nodes | ' +
    visibleEdgeCount + ' / ' + allEdges.length + ' edges';
}

function refreshGraphData() {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'refresh-graph' }, '*');
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
  const intersects = raycaster.intersectObjects(nodeMeshes);
  renderer.domElement.style.cursor = intersects.length > 0 ? 'pointer' : 'default';
}

function checkClick(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObjects(nodeMeshes);
  if (intersects.length > 0) {
    showInfoPanel(intersects[0].object.userData.node);
  } else {
    closeInfoPanel();
  }
}

function showInfoPanel(node) {
  selectedNode = node;
  document.getElementById('info-title').innerText = node.name || node.id || 'Unknown';
  document.getElementById('info-meta').innerText = '入度: ' + node.inDegree + ' | 出度: ' + node.outDegree;
  document.getElementById('info-path').innerText = node.filePath || 'N/A';
  document.getElementById('info-type').innerText = node.type || 'unknown';
  document.getElementById('info-panel').style.display = 'block';
}

function closeInfoPanel() {
  selectedNode = null;
  document.getElementById('info-panel').style.display = 'none';
}

function openCodeFile() {
  if (!selectedNode || !selectedNode.filePath) { return; }
  const msg = { type: 'open-file', filePath: selectedNode.filePath, qualifiedName: selectedNode.qualifiedName };
  if (window.parent !== window) {
    window.parent.postMessage(msg, '*');
  }
}

function toggleLabels() {
  showLabels = document.getElementById('fp-show-labels').checked;
  nodeLabels.forEach((l, i) => {
    if (l) { l.visible = showLabels && nodeMeshes[i] && nodeMeshes[i].visible; }
  });
}

// ─── Animation Loop ──────────────────────────────────────────────────
function animate() {
  animationId = requestAnimationFrame(animate);
  updateCamera();
  if (!isDragging) { spherical.theta += 0.001; }
  renderer.render(scene, camera);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

// ─── Start ───────────────────────────────────────────────────────────
init();
</script>
</body>
</html>`;

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
		this._logService.info(LOG_TAG, 'Webview mounted with MCP data + Three.js 3D graph renderer');

		// Listen for messages from webview (file open requests)
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
	}

	/** Open a file in VS Code editor */
	private async _openFileInEditor(filePath: string, qualifiedName?: string): Promise<void> {
		if (!filePath) { return; }
		try {
			// Resolve file path relative to workspace or subPath
			const config = this._cbmService.getIndexConfig();
			const folders = this._workspaceService.getWorkspace().folders;
			if (folders.length === 0) { return; }

			const wsUri = folders[0].uri;
			let fileUri: URI;
			if (config.subPath && config.subPath.trim()) {
				fileUri = URI.joinPath(wsUri, config.subPath.trim(), filePath);
			} else {
				fileUri = URI.joinPath(wsUri, filePath);
			}

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
