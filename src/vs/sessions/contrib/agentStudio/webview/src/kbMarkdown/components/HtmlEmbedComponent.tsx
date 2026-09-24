/* 「活页面」嵌入（`![[page.html]]`）—— 2026-09-24 二次修正版。
 *
 * ⚠ 第一版用 `<iframe src={asWebviewUri}>` 尝试在预览里跑脚本 —— **结构性不可行**（实测白屏）：
 *   VS Code webview 的 Service Worker 处理资源请求时要从 `event.clientId` 反查 `webviewId`
 *   （service-worker.js `processResourceRequest`），而 iframe 顶层导航产生的是**新 client**，
 *   从未注册过 webviewId ⇒ SW 恒返回 notFound ⇒ 白屏。图片/子资源能加载是因为请求由
 *   已注册的外层页面发起 —— 导航请求没有这条路径。
 *
 * 现方案（对齐本仓库已验证的模式）：
 *   · 内联 = **静态预览**：`srcDoc` + `sandbox=""`（srcdoc 继承父文档 CSP ⇒ 脚本被拦，
 *     但内联样式照常渲染），给用户「这个页面长什么样」的直观预览；
 *   · 「⚡ 打开活页面」按钮 → 宿主 `kbblocks.openHtmlEmbed` → `HtmlPreviewEditorInput`
 *     在**专属页签**里打开（独立 webview，脚本完整运行 —— 与点击 .html 文件同一成熟通道）。
 */

import { useEffect, useState } from 'react';
import { postMessage } from '../../bridge/messageClient';
import { requestNoteContentDetailed } from '../embedBridge';
import { kbLog } from '../kbDebug';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function HtmlEmbedComponent(props: any): React.ReactElement {
	const target = props['data-html-embed-target'] as string | undefined;
	const path = props['data-html-embed-path'] as string | undefined;
	const broken = 'data-html-embed-broken' in props;
	const [html, setHtml] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [reason, setReason] = useState('');

	// 诊断（★ 2026-09-24）：把组件**实际收到**的属性打出来 —— 报错卡片文案取决于
	// `data-html-embed-path` / `data-html-embed-broken` 两个 key 的**有无**，而界面文案
	// 无法区分「目标没解析到（broken）」「解析到但 uri 为空（两者都无）」这两种病因。
	useEffect(() => {
		kbLog('html-embed', `props: target=${target ?? '(无)'} path=${path ?? '(无)'} broken=${broken}`);
	}, [target, path, broken]);

	useEffect(() => {
		if (broken) { setFailed(true); return; }
		// ★★ 2026-09-24：`broken === false` 但**没有 path** ⇒ 这是**瞬时态**（宿主推送的
		//   文件名清单还没到，首次渲染必然如此 ⇒ Pass 1 解析不到目标，但 broken 属性是"解析失败"
		//   的语义，两者不同）。旧代码把它也当永久失败，且 `failed` 是黏性 state、成功时从不清零
		//   ⇒ 即使随后清单到达、内容成功读取，卡片仍永久停在错误文案。
		//   实测日志（同一实例）：先 `path=(无) broken=true` → 随后 `path=file:///… broken=false`
		//   + `getNoteContent:resp len=2069`（内容已到手），界面却一直显示「内容为空」。
		if (!path) { setFailed(false); setReason(''); return; }
		let alive = true;
		setFailed(false); setReason(''); setHtml(null);
		requestNoteContentDetailed(path).then((r) => {
			if (!alive) { return; }
			if (!r.markdown) {
				kbLog('html-embed', `内容为空: path=${path} error=${r.error ?? '(无)'}`);
				setReason(r.error ?? '内容为空');
				setFailed(true);
				return;
			}
			kbLog('html-embed', `内容就绪: ${r.markdown.length} chars`);
			setHtml(r.markdown);
		});
		return () => { alive = false; };
	}, [path, broken]);

	const openLive = (): void => {
		if (path) { postMessage('kbblocks.openHtmlEmbed', { uri: path }); }
	};

	if (failed) {
		return (
			<div className="kb-html-embed kb-html-embed--broken">
				⚠ 无法嵌入 HTML 页面：{target}
				{broken ? '（未在库内找到该文件）' : `（${reason || '内容为空'}）`}
			</div>
		);
	}
	if (html === null) {
		return <div className="kb-html-embed kb-html-embed--loading">页面加载中…</div>;
	}
	return (
		<div className="kb-html-embed">
			<div className="kb-html-embed-bar">
				<span className="kb-html-embed-name">{target ?? 'HTML 页面'}</span>
				<button className="kb-html-embed-open" onClick={openLive} type="button">⚡ 打开活页面（脚本交互）</button>
				<span className="kb-html-embed-hint">下方为静态预览（样式可见，脚本不运行）</span>
			</div>
			<iframe
				className="kb-html-embed-frame"
				sandbox=""
				srcDoc={html}
				title={target ?? 'embedded html page'}
			/>
		</div>
	);
}
