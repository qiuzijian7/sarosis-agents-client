/* 图表文件嵌入（`![[x.drawio]]` / `![[x.mermaid]]` / `![[x.canvas]]`）。
 *
 * 与 EmbedComponent（把目标当 markdown 重渲染）的本质区别：这些是**结构化图表源文件**，
 * 语义是「渲染成图」：
 *   · mermaid：读文件文本 → 复用 MermaidDiagram 的宿主渲染通道（IDiagramRenderer → SVG）；
 *   · drawio：读文件文本（mxGraphModel XML）→ 新通道 `kbblocks.renderDrawio`
 *     （宿主 IDrawioInlineRenderer → SVG，与聊天 drawio 卡片同一引擎）；
 *   · canvas：JSON Canvas ⇒ **宿主转译成 Mermaid 后交给 pele**（2026-10-19），与 mermaid 图
 *     同一引擎、同一观感。此前是内置的 CanvasMiniView（React + 绝对定位）自己画；
 *     ⚠ 代价：绝对坐标会被丢弃（Mermaid 由引擎排版），见 knowledge/canvasToMermaid.ts。
 */

import { useEffect, useState } from 'react';
import { postMessage } from '../../bridge/messageClient';
import { requestNoteContentDetailed } from '../embedBridge';
import { kbLog } from '../kbDebug';
import { MermaidDiagram } from './MermaidDiagram';
import { hostDiagramWidth } from '../diagramWidth';
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

// ── canvas 渲染桥（2026-10-19）：文本 → 宿主转译成 Mermaid → pele → SVG ──────
// 与 drawio 桥同一个 pending-map 模式（MermaidDiagram 亦同）⇒ 三者的超时/去重口径一致 ✓

const canvasPending = new Map<string, (r: IDiagramResult) => void>();
let canvasCounter = 0;
let canvasListenerInstalled = false;

function installCanvasListener(): void {
	if (canvasListenerInstalled) { return; }
	canvasListenerInstalled = true;
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.direction !== 'toWebview' || message.type !== 'kbblocks.canvasResult') { return; }
		const data = message.data as { requestId?: string; svg?: string; error?: string } | undefined;
		if (!data?.requestId) { return; }
		const resolve = canvasPending.get(data.requestId);
		if (resolve) {
			canvasPending.delete(data.requestId);
			resolve({ svg: data.svg ?? '', error: data.error ?? '' });
		}
	});
}

function renderCanvas(source: string): Promise<IDiagramResult> {
	installCanvasListener();
	const requestId = `canvas_${++canvasCounter}_${Date.now()}`;
	const theme = document.body.classList.contains('vscode-dark') ? 'dark' : 'default';
	const maxWidth = hostDiagramWidth();
	return new Promise<IDiagramResult>((resolve) => {
		canvasPending.set(requestId, resolve);
		postMessage('kbblocks.renderCanvas', { source, requestId, theme, maxWidth });
		window.setTimeout(() => {
			if (canvasPending.has(requestId)) {
				canvasPending.delete(requestId);
				resolve({ svg: '', error: '渲染超时' });
			}
		}, 30_000);
	});
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
	// drawio 与 canvas 都需要「文本 → 宿主渲染 → SVG」这一步（mermaid 自己在 MermaidDiagram 里做）
	const [hosted, setHosted] = useState<IDiagramResult & { loading: boolean }>({ svg: '', error: '', loading: kind === 'drawio' || kind === 'canvas' });

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

	// ② drawio / canvas：文本 → 宿主渲染 SVG（canvas 由宿主转译成 Mermaid 后走 pele）
	useEffect(() => {
		if (source === null) { return; }
		const render = kind === 'drawio' ? renderDrawio : kind === 'canvas' ? renderCanvas : undefined;
		if (!render) { return; }
		let alive = true;
		setHosted({ svg: '', error: '', loading: true });
		render(source).then((r) => {
			if (alive) { setHosted({ ...r, loading: false }); }
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
	// drawio / canvas：宿主渲染（canvas 走 pele，drawio 走 maxgraph）
	if (hosted.loading) {
		return <div className="kb-diagram-embed kb-diagram-embed-loading">正在渲染 {KIND_LABEL[kind]} 图示…</div>;
	}
	if (hosted.error || !hosted.svg) {
		return (
			<div className="kb-diagram-embed kb-diagram-embed-error">
				<div className="kb-diagram-label">{KIND_LABEL[kind]} 渲染失败：{hosted.error || '空结果'}</div>
				<pre className="kb-diagram-code">{source.slice(0, 2000)}</pre>
			</div>
		);
	}
	// SVG 由宿主引擎产出（pele / maxgraph）；本 webview CSP 的 script-src 仅放行 bundle 自身，
	// SVG 内任何脚本/事件属性都不会执行（与 MermaidDiagram 同一注入口径）。
	return <div className="kb-diagram-embed" dangerouslySetInnerHTML={{ __html: hosted.svg }} />;
}
