/*---------------------------------------------------------------------------------------------
 *  KB 文档查看器（webview 侧）：PDF（pdf.js）与 Word `.docx`（mammoth）的**只读预览**。
 *
 *  宿主 = `KbMediaViewerPane`（agentStudio）。宿主通过 `__VIEWER_INIT__` 注入：
 *    · `fileBase64` —— 文档本体字节（**内联**，不走 URL）
 *    · `workerText` —— pdf.js worker 脚本文本（这里用 Blob 造**同源** worker）
 *  ⚠ 两者都必须内联、不能给 URL —— 原因见 `IViewerInit` 的字段注释与宿主侧 `_render` 的完整因果链。
 *  两者都**只读**：不提供编辑/保存（原文件始终是唯一真源）。
 *
 *  为什么放在 webview 而不是 renderer：
 *   renderer 侧是 AMD 打包，直接 import `pdfjs-dist` / `mammoth` 的 ESM 产物行不通；
 *   webview 走 esbuild（见 `esbuild.kbviewers.config.mjs`）⇒ 可正常打包这两个库。
 *
 *  ⚠ pdf.js 版本：这里用 `^4`（4.x 仍支持 `page.render({ canvasContext, viewport })`；
 *    5.x/6.x 改成了传 `canvas`）。若真机上出现 `Promise.withResolvers is not a function`
 *    之类的新 API 缺失，改用 `pdfjs-dist/legacy/build/pdf.mjs` 即可。
 *--------------------------------------------------------------------------------------------*/

interface IViewerInit {
	kind: 'pdf' | 'docx';
	fileName: string;
	/**
	 * 文档本体（base64）—— 宿主**内联**注入。
	 *
	 * ⚠ 不再用 `asWebviewUri` URL：那条路依赖 webview 的资源代理，而两种配置都实测不通 ——
	 *   禁用 SW ⇒ 请求发往真实网络（`…vscode-cdn.net` 不存在）；启用 SW ⇒ `pre/index.html`
	 *   的 `workerReady` 会 gate **整个页面内容**的加载（首次要等 `controllerchange`）。
	 *   内联后与资源代理完全无关。
	 */
	fileBase64?: string;
	/**
	 * pdf.js worker 脚本文本 —— 宿主内联注入，这里用 Blob 造**同源** worker。
	 *
	 * ⚠ 必须同源：pdf.js 对**跨域** worker 的 `new Worker()` **不会同步抛错**，worker 静默失败后
	 *   既不回消息也不报错 ⇒ `getDocument()` **永久挂起**（实测：页面空白、无任何报错）。
	 */
	workerText?: string;
	/** 超过宿主的内联上限（宿主只给 MB 数，不给内容）。 */
	tooLarge?: number;
	/** 宿主读文件失败的原因。 */
	readError?: string;
}

const init = (window as unknown as { __VIEWER_INIT__?: IViewerInit }).__VIEWER_INIT__;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string): HTMLElementTagNameMap[K] => {
	const e = document.createElement(tag);
	if (cls) { e.className = cls; }
	return e;
};

const styled = <T extends HTMLElement>(e: T, s: Record<string, string>): T => {
	for (const [k, v] of Object.entries(s)) { (e.style as unknown as Record<string, string>)[k] = v; }
	return e;
};

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
	const b = el('button');
	b.textContent = label;
	b.title = title;
	styled(b, { cursor: 'pointer', padding: '2px 8px', minWidth: '26px' });
	b.onclick = onClick;
	return b;
}

/** 只读预览的公共骨架：顶部工具栏 + 内容区（纵向滚动、居中）。 */
function scaffold(title: string): { add: (n: HTMLElement) => void; content: HTMLElement; setStatus: (s: string) => void } {
	document.body.replaceChildren();
	styled(document.body, {
		margin: '0', height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
		background: 'var(--vscode-editor-background, #1e1e1e)', color: 'var(--vscode-editor-foreground, #ddd)',
	});

	const bar = styled(el('div', 'kbv-bar'), {
		display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 10px', flex: '0 0 auto',
		borderBottom: '1px solid var(--vscode-panel-border, #444)', fontSize: '12px',
	});
	const name = styled(el('span'), {
		marginRight: 'auto', opacity: '0.85', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
	});
	name.textContent = `${title}（只读预览）`;
	const status = styled(el('span'), { opacity: '0.6' });
	bar.append(name, status);

	const content = styled(el('div', 'kbv-content'), {
		flex: '1 1 auto', overflow: 'auto', display: 'flex', flexDirection: 'column',
		alignItems: 'center', gap: '12px', padding: '12px',
	});

	document.body.append(bar, content);
	return { add: n => bar.appendChild(n), content, setStatus: s => { status.textContent = s; } };
}

function showError(err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	document.body.replaceChildren();
	styled(document.body, { padding: '16px', fontFamily: 'var(--vscode-font-family)', color: 'var(--vscode-errorForeground, #f88)' });
	const h = el('div'); h.textContent = '无法预览该文档';
	const d = el('pre'); d.textContent = `${msg}\n\n可用右键「在系统程序中打开」查看原文件。`;
	styled(d, { whiteSpace: 'pre-wrap', opacity: '0.85' });
	document.body.append(h, d);
}

/** base64 → Uint8Array（宿主内联注入的文档字节）。 */
function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
	return out;
}

/**
 * 超时保护：任何异常路径都必须给出**可见反馈**，而不是永久空白。
 *
 * 为什么需要：pdf.js 在某些 worker 异常下既不 resolve 也不 reject（见 `IViewerInit.workerText`
 * 注释），没有这层保护时用户看到的就是「一片空白、毫无线索」。
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
	return Promise.race([
		p,
		new Promise<never>((_, reject) => { setTimeout(() => reject(new Error(message)), ms); }),
	]);
}

/** PDF：分页 + 缩放（pdf.js 渲染到 canvas）。 */
async function renderPdf(view: IViewerInit): Promise<void> {
	const pdfjs = await import('pdfjs-dist');
	// ★ worker 必须是**同源**的（宿主把脚本文本内联进来，这里用 Blob 造 URL）：
	//   pdf.js 对跨域 worker 的 `new Worker()` 不抛错，worker 静默失败后 `getDocument()` 会永久挂起。
	//   Blob URL 与页面同源 ⇒ 创建必然成功；即便 module worker 不被支持，pdf.js 回退到
	//   主线程 fake worker 的 `import(blobUrl)` 也被 CSP 的 `script-src blob:` 放行。
	if (view.workerText) {
		try {
			pdfjs.GlobalWorkerOptions.workerSrc =
				URL.createObjectURL(new Blob([view.workerText], { type: 'text/javascript' }));
		} catch { /* 退回主线程 fake worker */ }
	}

	const { add, content, setStatus } = scaffold(view.fileName);
	setStatus('加载文档…');
	// 文档本体经 base64 注入（不走 URL ⇒ 不依赖资源代理）
	const doc = await withTimeout(
		pdfjs.getDocument({ data: base64ToBytes(view.fileBase64 ?? '') }).promise,
		30_000,
		'加载 PDF 超时（30s）——文件可能损坏或过大。',
	);

	let page = 1;
	let scale = 1.2;
	const pageLabel = el('span'); pageLabel.textContent = '1';

	const draw = async (): Promise<void> => {
		setStatus('渲染中…');
		const p = await doc.getPage(page);
		const viewport = p.getViewport({ scale });
		const canvas = el('canvas');
		canvas.width = Math.floor(viewport.width);
		canvas.height = Math.floor(viewport.height);
		styled(canvas, {
			background: '#fff', boxShadow: '0 1px 8px rgba(0,0,0,0.45)',
			maxWidth: '100%', height: 'auto',
		});
		content.replaceChildren(canvas);
		const ctx = canvas.getContext('2d');
		if (!ctx) { throw new Error('canvas 2d context unavailable'); }
		// pdf.js 4.x 的渲染参数形态
		await p.render({ canvasContext: ctx, viewport } as unknown as Parameters<typeof p.render>[0]).promise;
		pageLabel.textContent = String(page);
		setStatus(`/ ${doc.numPages} 页 · ${Math.round(scale * 100)}%`);
		// 翻页后保持内容居中滚动位置（首页顶部）
		content.scrollTop = 0;
	};

	add(button('‹', '上一页', () => { if (page > 1) { page--; void draw().catch(showError); } }));
	add(pageLabel);
	add(button('›', '下一页', () => { if (page < doc.numPages) { page++; void draw().catch(showError); } }));
	add(button('−', '缩小', () => { scale = Math.max(0.4, scale - 0.2); void draw().catch(showError); }));
	add(button('＋', '放大', () => { scale = Math.min(4, scale + 0.2); void draw().catch(showError); }));

	await draw();
}

/** Word `.docx`：mammoth 转 HTML 预览（**保留基本结构，不保证版式还原**）。 */
async function renderDocx(view: IViewerInit): Promise<void> {
	// ⚠ 用包名导入（不要写 `mammoth/mammoth.browser.js`）：mammoth 的 package.json 有
	//   `browser` 字段 ⇒ esbuild（platform: browser）会自动解析到浏览器版并**保留类型**。
	//   直接写 browser 子路径会丢类型（TS7016），而运行时行为完全一样。
	const mod = await import('mammoth');
	const mammoth = (mod as unknown as { default?: unknown }).default ?? mod;

	const { content, setStatus } = scaffold(view.fileName);
	setStatus('解析中…');
	// 文档本体经 base64 注入（不走 URL ⇒ 不依赖资源代理）
	const bytes = base64ToBytes(view.fileBase64 ?? '');
	const result = await withTimeout((mammoth as {
		convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
	}).convertToHtml({ arrayBuffer: bytes.buffer as ArrayBuffer }), 30_000, '解析 docx 超时（30s）。');

	const body = el('div', 'kbv-doc');
	styled(body, {
		maxWidth: '900px', width: '100%', background: 'var(--vscode-editor-background)',
		padding: '24px 28px', borderRadius: '4px', lineHeight: '1.6', overflowWrap: 'anywhere',
	});
	body.innerHTML = result.value || '<p style="opacity:.6">（文档为空或无可提取内容）</p>';
	content.appendChild(body);
	setStatus(result.messages?.length ? `已解析（${result.messages.length} 条转换提示）` : '已解析');
}

if (!init) {
	showError('缺少初始化数据（__VIEWER_INIT__）');
} else if (init.tooLarge) {
	// 宿主因体积保护未内联 ⇒ 明确告知，别让用户面对空白
	showError(`文件过大（约 ${init.tooLarge}MB），已跳过内嵌预览。`);
} else if (init.readError) {
	showError(`读取文件失败：${init.readError}`);
} else if (!init.fileBase64) {
	showError('缺少文件内容（fileBase64 为空）。');
} else if (init.kind === 'pdf') {
	void renderPdf(init).catch(showError);
} else {
	void renderDocx(init).catch(showError);
}
