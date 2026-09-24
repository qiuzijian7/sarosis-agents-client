/* 图表文件嵌入（`![[x.drawio]]` / `![[x.mermaid]]` / `![[x.canvas]]`）。
 *
 * 与 EmbedComponent（把目标当 markdown 重渲染）的本质区别：这些是**结构化图表源文件**，
 * 语义是「渲染成图」：
 *   · mermaid：读文件文本 → 复用 MermaidDiagram 的宿主渲染通道（IMermaidInlineRenderer → SVG）；
 *   · drawio：读文件文本（mxGraphModel XML）→ 新通道 `kbblocks.renderDrawio`
 *     （宿主 IDrawioInlineRenderer → SVG，与聊天 drawio 卡片同一引擎）；
 *   · canvas：JSON Canvas ⇒ 内置只读迷你渲染器（节点绝对定位 + SVG 连线），
 *     刻意不复用 canvasEditor/canvasViewport（80KB 全功能编辑器）。
 */

import { useEffect, useState } from 'react';
import { postMessage } from '../../bridge/messageClient';
import { requestNoteContentDetailed } from '../embedBridge';
import { kbLog } from '../kbDebug';
import { MermaidDiagram } from './MermaidDiagram';
import type { DiagramEmbedKind } from '../markdownExtensions';

// ── drawio 渲染桥（镜像 MermaidDiagram 的 pending-map 模式）──────────────────

interface IDiagramResult { svg: string; error: string }

const drawioPending = new Map<string, (r: IDiagramResult) => void>();
let drawioCounter = 0;
let drawioListenerInstalled = false;

function installDrawioListener(): void {
	if (drawioListenerInstalled) { return; }
	drawioListenerInstalled = true;
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.direction !== 'toWebview' || message.type !== 'kbblocks.drawioResult') { return; }
		const data = message.data as { requestId?: string; svg?: string; error?: string } | undefined;
		if (!data?.requestId) { return; }
		const resolve = drawioPending.get(data.requestId);
		if (resolve) {
			drawioPending.delete(data.requestId);
			resolve({ svg: data.svg ?? '', error: data.error ?? '' });
		}
	});
}

function renderDrawio(source: string): Promise<IDiagramResult> {
	installDrawioListener();
	const requestId = `drawio_${++drawioCounter}_${Date.now()}`;
	const theme = document.body.classList.contains('vscode-dark') ? 'dark' : 'default';
	return new Promise<IDiagramResult>((resolve) => {
		drawioPending.set(requestId, resolve);
		postMessage('kbblocks.renderDrawio', { source, requestId, theme });
		window.setTimeout(() => {
			if (drawioPending.has(requestId)) {
				drawioPending.delete(requestId);
				resolve({ svg: '', error: '渲染超时' });
			}
		}, 30_000);
	});
}

// ── canvas 迷你只读渲染器 ────────────────────────────────────────────────────

interface ICanvasNode {
	id?: string;
	type?: string;
	x?: number; y?: number; width?: number; height?: number;
	/** JSON Canvas 规范用 `text`；本项目思维导图生成器用 `content`（首行为标题） */
	text?: string; content?: string; label?: string; file?: string;
}
interface ICanvasEdge { id?: string; fromNode?: string; toNode?: string; label?: string }

function nodeText(n: ICanvasNode): string {
	const raw = n.text ?? n.content ?? n.label ?? (n.file ? String(n.file).split(/[\\/]/).pop() ?? '' : '');
	// 思维导图约定「首行为标题」：只取首行，避免节点里塞长文
	return raw.split('\n')[0].trim();
}

function CanvasMiniView({ source }: { source: string }): React.ReactElement {
	let nodes: ICanvasNode[] = [];
	let edges: ICanvasEdge[] = [];
	try {
		const json = JSON.parse(source) as { nodes?: ICanvasNode[]; edges?: ICanvasEdge[] };
		nodes = Array.isArray(json.nodes) ? json.nodes : [];
		edges = Array.isArray(json.edges) ? json.edges : [];
	} catch {
		return <div className="kb-diagram-embed-error">⚠ canvas 解析失败（不是合法 JSON）</div>;
	}
	if (nodes.length === 0) {
		return <div className="kb-diagram-embed-error">⚠ canvas 为空（无节点）</div>;
	}

	const pad = 16;
	const x0 = Math.min(...nodes.map(n => n.x ?? 0));
	const y0 = Math.min(...nodes.map(n => n.y ?? 0));
	const x1 = Math.max(...nodes.map(n => (n.x ?? 0) + (n.width ?? 160)));
	const y1 = Math.max(...nodes.map(n => (n.y ?? 0) + (n.height ?? 60)));
	const w = Math.max(1, x1 - x0 + pad * 2);
	const h = Math.max(1, y1 - y0 + pad * 2);
	const byId = new Map(nodes.filter(n => n.id).map(n => [n.id as string, n]));
	const center = (n: ICanvasNode) => ({
		x: (n.x ?? 0) - x0 + pad + (n.width ?? 160) / 2,
		y: (n.y ?? 0) - y0 + pad + (n.height ?? 60) / 2,
	});

	return (
		<div className="kb-canvas-mini" style={{ position: 'relative', width: '100%', aspectRatio: `${w} / ${h}` }}>
			<svg
				viewBox={`0 0 ${w} ${h}`}
				style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
				preserveAspectRatio="xMidYMid meet"
			>
				<defs>
					<marker id="kb-canvas-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
						<path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
					</marker>
				</defs>
				{edges.map((e, i) => {
					const a = e.fromNode ? byId.get(e.fromNode) : undefined;
					const b = e.toNode ? byId.get(e.toNode) : undefined;
					if (!a || !b) { return null; }
					const pa = center(a); const pb = center(b);
					return (
						<line key={e.id ?? i} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y}
							stroke="currentColor" strokeWidth="1.5" opacity="0.5" markerEnd="url(#kb-canvas-arrow)" />
					);
				})}
			</svg>
			{nodes.map((n, i) => {
				const label = nodeText(n);
				return (
					<div
						key={n.id ?? i}
						className="kb-canvas-mini-node"
						style={{
							position: 'absolute',
							left: `${(((n.x ?? 0) - x0 + pad) / w) * 100}%`,
							top: `${(((n.y ?? 0) - y0 + pad) / h) * 100}%`,
							width: `${((n.width ?? 160) / w) * 100}%`,
							height: `${((n.height ?? 60) / h) * 100}%`,
						}}
						title={label}
					>
						{label}
					</div>
				);
			})}
		</div>
	);
}

// ── 主组件 ──────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<DiagramEmbedKind, string> = { mermaid: 'Mermaid', drawio: 'drawio', canvas: 'Canvas' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function DiagramEmbedComponent(props: any): React.ReactElement {
	const kind = (props['data-diagram-kind'] as DiagramEmbedKind | undefined) ?? 'mermaid';
	const target = props['data-diagram-target'] as string | undefined;
	const path = props['data-diagram-path'] as string | undefined;
	const broken = 'data-diagram-broken' in props;
	const [source, setSource] = useState<string | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [loadReason, setLoadReason] = useState('');
	const [drawio, setDrawio] = useState<IDiagramResult & { loading: boolean }>({ svg: '', error: '', loading: kind === 'drawio' });

	// ① 读目标文件文本（宿主 `_serveNoteContent` 不限类型 ✓）
	useEffect(() => {
		if (broken) { setLoadFailed(true); return; }
		// ★★ 2026-09-24：`broken=false` 且无 path ⇒ **瞬时态**（宿主的名清单未到，首帧必然如此）。
		//   旧代码把它当永久失败、且成功后从不清零 `loadFailed` ⇒ 内容明明读到了，界面仍显示
		//   「读取失败」（与 HtmlEmbedComponent 同一个黏性 state 缺陷，实测日志已证明内容到手）。
		if (!path) { setLoadFailed(false); setLoadReason(''); return; }
		let alive = true;
		setLoadFailed(false); setLoadReason(''); setSource(null);
		requestNoteContentDetailed(path).then((r) => {
			if (!alive) { return; }
			if (!r.markdown) {
				kbLog(`diagram-embed(${kind})`, `内容为空: path=${path} error=${r.error ?? '(无)'}`);
				setLoadReason(r.error ?? '内容为空');
				setLoadFailed(true);
				return;
			}
			kbLog(`diagram-embed(${kind})`, `内容就绪: ${r.markdown.length} chars`);
			setSource(r.markdown);
		});
		return () => { alive = false; };
	}, [path, broken]);

	// ② drawio：文本 → 宿主渲染 SVG
	useEffect(() => {
		if (kind !== 'drawio' || source === null) { return; }
		let alive = true;
		setDrawio({ svg: '', error: '', loading: true });
		renderDrawio(source).then((r) => {
			if (alive) { setDrawio({ ...r, loading: false }); }
		});
		return () => { alive = false; };
	}, [kind, source]);

	if (loadFailed) {
		return (
			<div className="kb-diagram-embed kb-diagram-embed-error">
				⚠ 无法嵌入图表：{target}{broken ? '（未在库内找到该文件）' : `（${loadReason || '读取失败'}）`}
			</div>
		);
	}
	if (source === null) {
		return <div className="kb-diagram-embed kb-diagram-embed-loading">{KIND_LABEL[kind]} 加载中…</div>;
	}

	if (kind === 'mermaid') {
		return <div className="kb-diagram-embed"><MermaidDiagram source={source} /></div>;
	}
	if (kind === 'canvas') {
		return <div className="kb-diagram-embed"><CanvasMiniView source={source} /></div>;
	}
	// drawio
	if (drawio.loading) {
		return <div className="kb-diagram-embed kb-diagram-embed-loading">正在渲染 drawio 图示…</div>;
	}
	if (drawio.error || !drawio.svg) {
		return (
			<div className="kb-diagram-embed kb-diagram-embed-error">
				<div className="kb-diagram-label">drawio 渲染失败：{drawio.error || '空结果'}</div>
				<pre className="kb-diagram-code">{source.slice(0, 2000)}</pre>
			</div>
		);
	}
	// SVG 由宿主 maxgraph 引擎产出；本 webview CSP 的 script-src 仅放行 bundle 自身，
	// SVG 内任何脚本/事件属性都不会执行（与 MermaidDiagram 同一注入口径）。
	return <div className="kb-diagram-embed" dangerouslySetInnerHTML={{ __html: drawio.svg }} />;
}
