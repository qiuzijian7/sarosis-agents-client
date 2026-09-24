/*---------------------------------------------------------------------------------------------
 *  KbMediaViewerPane — 知识库的**只读文档预览**（PDF / Word），编辑器区里的一个 EditorPane。
 *
 *  需求（2026-09-23）：知识库里的 PDF / .docx 之前会被当**文本**打开 ⇒ 满屏二进制乱码。
 *  这里给它们注册真正的查看器：宿主（本文件）建一个 sandboxed webview，注入按需打包的
 *  `media/kbviewers.js`（内含 pdf.js + mammoth），并用 `vscode-webview-resource` URL
 *  把文件本体交给 webview 渲染。
 *
 *  注册（见 `agentStudio.contribution.ts`）：
 *    · `registerEditorPane(...)`  —— KbMediaViewerInput ⇒ 本 Pane
 *    · `editorResolverService.registerEditor('*.pdf' | '*.docx', ...)` —— 打开该类型时自动路由过来
 *  ⇒「资源管理器里双击 PDF」「知识库视图里点 PDF」都会打开预览，而不是文本编辑器。
 *
 *  ⚠ 只读：不提供编辑/保存；原文件始终是唯一真源。
 *  ⚠ bundle 通过**内联**注入（不走 service-worker fetch），与 `kbBlocksEditorPane` 同策略。
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext, EditorInputCapabilities } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { encodeBase64 } from '../../../../base/common/buffer.js';
import { escapeJsonForInlineScript } from './kbBlocksEditorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';

/** 接管的扩展名 → webview 侧的渲染器种类。 */
const VIEW_KINDS: Record<string, 'pdf' | 'docx'> = { pdf: 'pdf', docx: 'docx' };

/**
 * 内联文档的长度上限（30MB）。
 *
 * 为什么要有上限：文档字节经 base64 注入 HTML（膨胀 ~1.33 倍，再过 JSON 转义），
 * 且 webview 侧还要 `atob` 一次 ⇒ 峰值内存约等于文件的 3～4 倍。超大文件只提示、
 * 不内联（见 `_render`），避免把 webview 拖死。
 */
const MAX_INLINE_BYTES = 30 * 1024 * 1024;

/** 是否由本查看器接管（`agentStudio.contribution` 的 resolver 用同一份判据）。 */
export function isKbMediaViewerFile(resource: URI): boolean {
	const ext = resource.path.split('.').pop()?.toLowerCase() ?? '';
	return !!VIEW_KINDS[ext];
}

/** PDF / Word 预览的编辑器输入。 */
export class KbMediaViewerInput extends EditorInput {

	static readonly ID = 'workbench.editor.agentStudio.kbMediaViewer';

	override get typeId(): string {
		return KbMediaViewerInput.ID;
	}

	/**
	 * ★ 2026-09-23：必须与注册的 EditorPane id 一致。
	 *
	 * 缺它 ⇒ workbench 在 `editorResolverService.ts` 打印
	 * `Editor ID Mismatch: undefined !== workbench.editor.agentStudio.kbMediaViewerPane`
	 * （基类 `EditorInput.editorId` 默认返回 `undefined`）—— 这正是用户日志里的那条 WARN。
	 */
	override get editorId(): string {
		return KbMediaViewerPane.ID;
	}

	/** 只读预览：声明 Readonly，避免 workbench 提供保存/编辑语义。 */
	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}

	constructor(readonly resource: URI) {
		super();
	}

	override getName(): string {
		return basename(this.resource.path);
	}

	override getDescription(): string {
		return this.resource.fsPath;
	}

	override matches(other: EditorInput | unknown): boolean {
		return other instanceof KbMediaViewerInput && other.resource.toString() === this.resource.toString();
	}
}

export class KbMediaViewerPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.kbMediaViewerPane';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;
	private _currentResource: URI | undefined;
	/** bundle 文本缓存（数 MB 的字符串，避免每次打开都重读）。 */
	private _bundleCache: { key: string; js: string } | undefined;
	/** pdf.js worker 脚本文本缓存（1.3MB，仅 PDF 需要；见 `_readWorkerText`）。 */
	private _workerCache: { key: string; text: string } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
	) {
		super(KbMediaViewerPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-kb-media-viewer');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.position = 'relative';
		this._container.style.background = 'var(--vscode-editor-background, #1e1e1e)';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof KbMediaViewerInput) || !this._container || token.isCancellationRequested) {
			return;
		}
		this._currentResource = input.resource;
		this._logService.info(`[KbMediaViewerPane] open ${input.resource.toString()}`);
		await this._render();
	}

	override clearInput(): void {
		this._currentResource = undefined;
		if (this._container) { this._container.replaceChildren(); }
		this._webview = undefined;
		super.clearInput();
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		this._webview?.focus();
		super.focus();
	}

	// ── internals ──────────────────────────────────────────────────────────

	private async _render(): Promise<void> {
		const resource = this._currentResource;
		if (!this._container || !resource) { return; }
		const ext = resource.path.split('.').pop()?.toLowerCase() ?? '';
		const kind = VIEW_KINDS[ext];
		if (!kind) {
			this._logService.warn(`[KbMediaViewerPane] unsupported extension: ${ext}`);
			return;
		}

		const mediaUri = await this._resolveMediaUri();
		const bundleJs = await this._readBundle(mediaUri);

		// ★★ 2026-09-23（第三次、最终修正）：「无法预览 PDF」的完整因果链。
		//
		//   症状演变：① `Setting up fake worker failed: Failed to fetch dynamically imported module`
		//            → ② 修 CSP 后**毫无变化** → ③ 启用 SW 后变成**完全空白**（连错误卡片都没有）。
		//
		//   真正原因：**文档本体与 pdf.js worker 都走了 `vscode-resource` URL**，而这类 URL 依赖
		//   webview 的代理通道，两种情况都不通：
		//     · 禁用 SW ⇒ 请求发往真实网络（`…vscode-cdn.net` 并不存在）⇒ fetch/import 全失败（症状 ①）；
		//     · 启用 SW ⇒ `pre/index.html` 的 `workerReady` 会 **gate 整个页面内容**的加载，首次注册
		//       还要等 `controllerchange`（SW 未 claim 当前 client 时长期不触发）⇒ 页面内容不注入（症状 ③）。
		//     · 而 pdf.js 对**跨域 worker**（页面 origin 是 `vscode-webview://…`，worker 在 cdn 域）的
		//       `new Worker()` **不会同步抛错**，worker 静默失败后既不回消息也不报错
		//       ⇒ `getDocument()` **永久挂起** ⇒ 空白且无任何报错。
		//
		//   ⇒ 结论：**不要再依赖任何资源代理**。文档本体走 **base64 内联**；pdf.js worker 走 **Blob
		//     同源 URL**（blob 与页面同源，CSP 的 `worker-src blob:` / `script-src blob:` 已放行）。
		//     这样 webview 可以保持 `disableServiceWorker: true`：页面立即加载、零 SW 握手开销，
		//     也不再有跨域 worker 的静默挂起。
		//
		//   ⚠ 代价：HTML = bundle(0.7MB) + worker(1.3MB，仅 PDF) + 文档 base64。素材多为几十 KB～几 MB，
		//     可接受；超大文件由 `MAX_INLINE_BYTES` 保护（只提示、不内联）。
		const initData: Record<string, unknown> = {
			kind,
			fileName: basename(resource.path),
		};
		try {
			const bytes = (await this._fileService.readFile(resource)).value;
			if (bytes.byteLength > MAX_INLINE_BYTES) {
				initData.tooLarge = Math.round(bytes.byteLength / 1024 / 1024);
				this._logService.warn(`[KbMediaViewerPane] file too large to inline (${bytes.byteLength} bytes): ${resource.toString()}`);
			} else {
				initData.fileBase64 = encodeBase64(bytes);
			}
		} catch (err) {
			initData.readError = err instanceof Error ? err.message : String(err);
			this._logService.warn(`[KbMediaViewerPane] failed to read file: ${resource.toString()}`, err);
		}
		if (kind === 'pdf' && mediaUri) {
			const workerText = await this._readWorkerText(mediaUri);
			if (workerText) { initData.workerText = workerText; }
		}

		const html = this._getHtml(bundleJs, initData);

		if (this._webview) {
			// 切换文件：直接重设 HTML（查看器无状态需要保留；比走消息更新更简单可靠）
			this._webview.setHtml(html);
			return;
		}

		this._webview = this._webviewService.createWebviewElement({
			title: 'KB Document Viewer',
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				// 文档与 worker 均已内联/blob（见 `_render` 里 initData 处的完整因果链）
				// ⇒ **不再需要**资源代理 ⇒ 保持禁用 SW：页面内容立即加载
				//   （启用 SW 时 `workerReady` 会 gate 页面内容，实测表现为「完全空白」）。
				disableServiceWorker: true,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: false,
				// 已不依赖本地资源加载；保留 mediaUri 便于将来回退（无开销）
				localResourceRoots: mediaUri ? [mediaUri] : [],
			},
			extension: undefined,
		});

		this._register(this._webview);
		this._webview.mountTo(this._container, mainWindow);
		this._webview.setHtml(html);
	}

	/** media 目录候选（dev 用 `src`，打包版回退 `out`）——与 `kbBlocksEditorPane` 同策略。 */
	private _mediaCandidates(): URI[] {
		const appRoot = this._environmentService.appRoot;
		const segments = ['vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media'];
		return [
			URI.joinPath(URI.file(appRoot), 'src', ...segments),
			URI.joinPath(URI.file(appRoot), 'out', ...segments),
		];
	}

	private async _resolveMediaUri(): Promise<URI | undefined> {
		for (const uri of this._mediaCandidates()) {
			try {
				await this._fileService.stat(URI.joinPath(uri, 'kbviewers.js'));
				return uri;
			} catch { /* try next candidate */ }
		}
		return undefined;
	}

	private async _readBundle(mediaUri: URI | undefined): Promise<string> {
		if (!mediaUri) { return ''; }
		const key = mediaUri.toString();
		if (this._bundleCache?.key === key) { return this._bundleCache.js; }
		try {
			const js = (await this._fileService.readFile(URI.joinPath(mediaUri, 'kbviewers.js'))).value.toString();
			if (js) { this._bundleCache = { key, js }; }
			return js;
		} catch (err) {
			this._logService.warn('[KbMediaViewerPane] failed to read kbviewers.js', err);
			return '';
		}
	}

	/**
	 * 读取 pdf.js worker 脚本文本（1.3MB）—— webview 侧用 Blob 造**同源** worker。
	 *
	 * ⚠ 为什么必须内联、而不是把 URL 交给 webview：pdf.js 对**跨域** worker 的
	 *   `new Worker()` **不会同步抛错**，worker 静默失败后既不回消息也不报错
	 *   ⇒ `getDocument()` **永久挂起**（实测：页面空白且无任何报错）。
	 *   blob URL 与页面同源 ⇒ 创建必然成功（最坏情况退回主线程 fake worker，
	 *   走 `script-src blob:` 的动态 import 也放行）。
	 */
	private async _readWorkerText(mediaUri: URI): Promise<string | undefined> {
		const key = mediaUri.toString();
		if (this._workerCache?.key === key) { return this._workerCache.text; }
		try {
			const text = (await this._fileService.readFile(URI.joinPath(mediaUri, 'pdf.worker.min.mjs'))).value.toString();
			if (text) { this._workerCache = { key, text }; }
			return text || undefined;
		} catch (err) {
			this._logService.warn('[KbMediaViewerPane] failed to read pdf.js worker', err);
			return undefined;
		}
	}

	private _getHtml(bundleJs: string, initData: Record<string, unknown>): string {
		const nonce = generateUuid().replace(/-/g, '');
		// CSP 要点（资源已**全部内联 / blob** ⇒ 不再需要任何 `vscode-resource:` 来源）：
		//  · script-src `blob:` —— 内联 bundle 用 nonce；blob 供 pdf.js 的
		//    `new Worker(blobUrl)`（以及最坏情况回退时的 `import(blobUrl)`）使用
		//  · worker-src `blob:` —— pdf.js worker（同源 blob，见 `_readWorkerText`）
		//  · img-src data: blob: —— docx 内嵌图片（mammoth 产出 data: URI）
		const csp = [
			"default-src 'none'",
			`script-src 'nonce-${nonce}' blob:`,
			"style-src 'unsafe-inline'",
			'img-src data: blob:',
			'font-src data:',
			'connect-src blob:',
			'worker-src blob:',
		].join('; ');

		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Document Viewer</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}">window.__VIEWER_INIT__ = ${escapeJsonForInlineScript(JSON.stringify(initData))};</script>
	<script nonce="${nonce}">${bundleJs}</script>
</body>
</html>`;
	}
}
