/* Mermaid 图示渲染：KB 文档中的 ```mermaid 代码块 → 请求 host 的
 * IMermaidInlineRenderer（隐藏 webview 渲染引擎，与聊天 Mermaid 卡片一致）
 * 渲染为 SVG 字符串，再注入本文档 DOM 显示。
 *
 * 渲染结果经由 kbblocks.renderMermaid / kbblocks.mermaidResult 消息往返；
 * 本组件持有 pending map 按 requestId 匹配响应（同 embedBridge 模式）。
 */

import { useEffect, useState } from 'react';
import { postMessage } from '../../bridge/messageClient';

interface MermaidResult {
	svg: string;
	error: string;
}

const pending = new Map<string, (r: MermaidResult) => void>();
let counter = 0;
let listenerInstalled = false;

function installMermaidListener(): void {
	if (listenerInstalled) { return; }
	listenerInstalled = true;
	window.addEventListener('message', (event) => {
		const message = event.data;
		if (!message || message.direction !== 'toWebview' || message.type !== 'kbblocks.mermaidResult') { return; }
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const data = message.data as { requestId?: string; svg?: string; error?: string } | undefined;
		if (!data?.requestId) { return; }
		const resolve = pending.get(data.requestId);
		if (resolve) {
			pending.delete(data.requestId);
			resolve({ svg: data.svg ?? '', error: data.error ?? '' });
		}
	});
}

function renderMermaid(source: string): Promise<MermaidResult> {
	installMermaidListener();
	const requestId = `mermaid_${++counter}_${Date.now()}`;
	// VS Code webview 会给 <body> 加 vscode-dark/vscode-light class，据此传主题
	const theme = document.body.classList.contains('vscode-dark') ? 'dark' : 'default';
	return new Promise<MermaidResult>((resolve) => {
		pending.set(requestId, resolve);
		postMessage('kbblocks.renderMermaid', { source, requestId, theme });
		// 兜底：host 挂起时不让图示一直转圈
		window.setTimeout(() => {
			if (pending.has(requestId)) {
				pending.delete(requestId);
				resolve({ svg: '', error: '渲染超时' });
			}
		}, 30_000);
	});
}

export function MermaidDiagram({ source }: { source: string }): React.ReactElement {
	const [state, setState] = useState<MermaidResult & { loading: boolean }>({ svg: '', error: '', loading: true });

	useEffect(() => {
		let disposed = false;
		renderMermaid(source).then((r) => {
			if (!disposed) { setState({ ...r, loading: false }); }
		});
		return () => { disposed = true; };
	}, [source]);

	if (state.loading) {
		return <div className="kb-mermaid kb-mermaid-loading">正在渲染 Mermaid 图示…</div>;
	}
	if (state.error || !state.svg) {
		return (
			<div className="kb-mermaid kb-mermaid-error">
				<div className="kb-diagram-label">Mermaid 渲染失败：{state.error || '空结果'}</div>
				<pre className="kb-diagram-code">{source}</pre>
			</div>
		);
	}
	// SVG 由 host 的 mermaid webview 渲染（mermaid strict 模式已消毒）；本 webview
	// CSP script-src 仅放行 bundle 自身，SVG 内任何脚本/事件属性都不会执行。
	return <div className="kb-mermaid" dangerouslySetInnerHTML={{ __html: state.svg }} />;
}
