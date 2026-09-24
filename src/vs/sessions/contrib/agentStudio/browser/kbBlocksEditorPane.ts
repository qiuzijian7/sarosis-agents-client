/*---------------------------------------------------------------------------------------------
 *  KbBlocksEditorPane — KB note editor backed by the react-markdown pipeline.
 *
 *  Replaces the old SiYuan (Lute) `KbNoteEditorPane` and the abandoned AFFiNE /
 *  BlockSuite WYSIWYG attempt. This is a real `EditorPane` (registered under
 *  the same `editorId` that `KbNoteEditorInput` reports) so clicking a KB file
 *  in the knowledge-base view opens the markdown renderer in the editor area.
 *
 *  Host side (AMD) mounts a sandboxed VS Code webview that loads the
 *  pre-bundled `media/kbblocks.js` (react-markdown + KaTeX + the wikilink /
 *  embed resolver). The `.md` content and the vault note index are injected via
 *  `window.__KB_INIT__`; edits in source mode are serialized straight back to
 *  disk through `IFileService`. `.md` is the single source of truth.
 *
 *  Collaboration (multi-agent editing of one document) is intentionally out of
 *  scope for now — each pane owns an independent doc.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import * as DOM from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname } from '../../../../base/common/resources.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INativeEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { IWebviewElement, IWebviewService } from '../../../../workbench/contrib/webview/browser/webview.js';
import { asWebviewUri } from '../../../../workbench/contrib/webview/common/webview.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { KbNoteEditorInput } from './kbNoteEditorInput.js';
// ★ 2026-09-24：媒体类（图片 pdf/docx）按类型路由到只读查看器，而不是当笔记打开
import { isKbMediaViewerFile } from './kbMediaViewerKinds.js';
import { KbMediaViewerInput } from './kbMediaViewerPane.js';
import { serializeBacklinks } from './kbBlocksCodec.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IKbNativeKernelService } from './kbNativeKernelService.js';
import { KbVersionService, IKbVersionService } from './kbVersionService.js';
import type { KbCommitMeta, KbDiffResult } from './kbVersionTypes.js';
import { IMermaidInlineRenderer } from './mermaidInlineRenderer.js';
import { IDrawioInlineRenderer } from './drawioInlineRenderer.js';
import { HtmlPreviewEditorInput } from './htmlPreviewEditorInput.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { MEDIA_STORE_CHANNEL, type IMediaBackend } from '../common/mediaStoreChannel.js';
import { createMediaStoreProxy } from './mediaStoreProxy.js';
import { KbAttachmentStore } from './knowledge/kbAttachmentStore.js';

interface KbHostMessage {
	direction: 'toHost';
	type: string;
	payload?: unknown;
}

/**
 * 内联 `<script>` 里的 JSON 必须转义 `<`（→ `<`）—— 否则内容中的 `</script>`
 * 会被 HTML 解析器当作脚本结束标签，提前截断 JSON（2026-09-24 实测：含 HTML 演示文本的
 * 笔记因此渲染成空白页）。`<` 是 JSON 字符串里的合法转义，解析后语义完全不变。
 * （导出以便单测。）
 */
export function escapeJsonForInlineScript(json: string): string {
	return json.replace(/</g, '\\u003c');
}

export class KbBlocksEditorPane extends EditorPane {

	/** Must match `KbNoteEditorInput.editorId` so KB clicks open this pane. */
	static readonly ID = 'workbench.editor.agentStudio.kbNotePane';

	private _container: HTMLElement | undefined;
	private _webview: IWebviewElement | undefined;

	private _currentResource: URI | undefined;
	private _currentMarkdown = '';
	/** Vault note index (URI + stem) for the webview wikilink resolver. */
	private _workspaceFiles: { uri: string; name: string }[] = [];
	/**
	 * 本 pane 创建/复用的**媒体预览 input**（按资源 URI 缓存）。
	 *
	 * ★ 2026-09-24：图片（png/svg/…）与 pdf/docx 由 `KbMediaViewerPane` 渲染；**不复用**会导致
	 * 每点一次图片就多一个 input（泄漏），而交给 resolver 创建又拿不到引用（同样泄漏 —— 视图侧
	 * 踩过 `[LEAKED DISPOSABLE]`）。⇒ 自己持有、按 URI 复用、`_register` 挂生命周期。
	 */
	private readonly _mediaInputs = new Map<string, KbMediaViewerInput>();
	/**
	 * `_workspaceFiles` 的**按 vault 缓存**（2026-09-23）。
	 *
	 * 为什么需要：解析 `[[wikilink]]` 只要「文件名清单」，但此前**每次打开笔记**都会
	 * 全量递归枚举磁盘（`库` + `笔记`，外加逐级 `_findVaultRoot` stat）+ 查询内核索引，
	 * 而这些都发生在 `_ensureWebview()` **之前** ⇒ 直接加在首屏关键路径上。
	 * 同一 vault 内连续打开多篇笔记时，这份清单几乎不变 ⇒ 缓存 30s 足以消除重复开销。
	 */
	private _workspaceFilesCache: { vaultKey: string; at: number; files: { uri: string; name: string }[] } | undefined;
	/**
	 * `kbblocks.js` / `kbblocks.css` 的文本缓存（2026-09-23）。
	 *
	 * 打包产物含 React + react-markdown + KaTeX，体积数 MB；此前**每次打开笔记**都要
	 * 读一遍并 `toString()`（几 MB 字符串）⇒ 明显拖慢首屏。媒体目录不变时无需重读。
	 */
	private _bundleCache: { key: string; js: string; css: string } | undefined;
	/** Absolute `file://` URI of the currently open note (wikilink disambiguation). */
	private _currentFilePath = '';
	/** `#heading` to scroll to after the note renders (`[[note#heading]]` jump). */
	private _pendingHeading: string | undefined;

	/** 媒体库代理（惰性创建）：解析笔记里的 `saros-media://<id>` 引用 + 沉淀到笔记附件。 */
	private _mediaBackendForKb: IMediaBackend | undefined;
	private _attachmentStore: KbAttachmentStore | undefined;

	private _getKbMediaBackend(): IMediaBackend | undefined {
		if (!this._mediaBackendForKb && this._mainProcessService?.getChannel(MEDIA_STORE_CHANNEL)) {
			this._mediaBackendForKb = createMediaStoreProxy(this._mainProcessService);
		}
		return this._mediaBackendForKb;
	}

	private readonly _onReady = this._register(new Emitter<{ docId: string }>());
	readonly onReady: Event<{ docId: string }> = this._onReady.event;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@ILogService private readonly _logService: ILogService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@IClipboardService private readonly _clipboardService: IClipboardService,
		@IEditorService private readonly _editorService: IEditorService,
		@IKbNativeKernelService private readonly _kbKernelService: IKbNativeKernelService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IKbVersionService private readonly _versionService: KbVersionService,
		@IMermaidInlineRenderer private readonly _mermaidRenderer: IMermaidInlineRenderer,
		// 图表文件嵌入 `![[x.drawio]]` 的渲染引擎（与聊天 drawio 卡片同一服务）
		@IDrawioInlineRenderer private readonly _drawioRenderer: IDrawioInlineRenderer,
		@IMainProcessService private readonly _mainProcessService: IMainProcessService,
	) {
		super(KbBlocksEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = document.createElement('div');
		this._container.classList.add('agent-studio-kb-blocks-pane');
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

		if (!(input instanceof KbNoteEditorInput) || !this._container || token.isCancellationRequested) {
			return;
		}

		await this._openDoc(input.resource, input.heading);
	}

	private async _openDoc(resource: URI, heading?: string): Promise<void> {
		this._currentResource = resource;
		this._currentFilePath = resource.toString();
		this._pendingHeading = heading;

		let mdContent = '';
		try {
			const content = await this._fileService.readFile(resource);
			mdContent = content.value.toString();
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to read KB note, opening empty doc', err);
		}
		this._currentMarkdown = mdContent;

		// Enumerate the vault notes so the webview can resolve `[[wikilinks]]`.
		//
		// ⚠ 2026-09-22：内核索引**不保证完整**。实测某 vault：`.kbkernel.json` 里
		// `totalDocs: 1`，而磁盘上有 15 篇 md（同一份数据跑真实 `KbFullTextIndex.build()`
		// 得到 15 篇 ⇒ 构建逻辑没问题，是运行时拿到的是残缺/陈旧索引）。
		// 后果：所有 `[[链接]]` 被判为断链 ⇒ 点击**静默无反应**、出链面板只能显示
		// 未解码的原始 URI。而链接解析要的只是「文件名清单」，文件系统才是权威真源
		// ⇒ 这里改为**磁盘枚举为主、内核索引补充**。
		//
		// ★ 2026-09-23（性能）：**不再阻塞首屏等待索引**。
		//   枚举磁盘 + 查询内核（首次还可能触发内核全量构建）都发生在渲染之前，
		//   是「打开笔记很慢」的来源之一。现在：先用上次的清单（通常已命中缓存）立即渲染，
		//   索引在后台补齐后用 `kbblocks.workspaceFiles` 推给 webview ⇒ wikilink 随之可点。
		this._workspaceFiles = this._workspaceFilesCache?.files ?? [];

		await this._ensureWebview();

		void this._pushWorkspaceFiles(resource);
	}

	/**
	 * 把「文件名清单」推给 webview（`kbblocks.workspaceFiles`）。
	 *
	 * ★ 2026-09-24（用户实测：`![[live-demo.html]]` 显示「未在库内找到该文件」）：
	 *   `setInput` 里的这次后台推送**常常早于 webview 的 React 挂载**（bundle 3.8MB，
	 *   启动 + 挂载要几百毫秒；而 113 个文件的枚举只要几毫秒），而处理这条消息的监听器
	 *   是 `KbMarkdownApp` 挂载时才注册的 ⇒ **推送被丢弃**，webview 只能用 INIT 里的清单
	 *   （冷缓存时是空数组）⇒ 所有 wikilink / 嵌入目标都解析不到。
	 *   ⇒ 除这里之外，宿主还在 `kbblocks.ready`（webview 就绪信号）与
	 *     `kbblocks.requestWorkspaceFiles`（webview 主动问）时**各重推一次**，确保可达。
	 */
	private async _pushWorkspaceFiles(resource: URI | undefined): Promise<void> {
		if (!resource) { return; }
		try {
			const files = await this._loadWorkspaceFiles(resource);
			this._workspaceFiles = files;
			// 诊断（★ 2026-09-24）：确认「清单已推送 + 条数」，用于判定是否送达 webview。
			this._logService.info(`[KbBlocksEditorPane] push workspaceFiles (${files.length} entries) -> webview`);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.workspaceFiles',
				data: files,
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] background workspace index failed', err);
		}
	}

	// ── Media resolution (out/ for prod, src/ for dev) ──────────────────────

	/**
	 * 收集用于 `[[wikilink]]` 解析的文件清单：**磁盘枚举为主 + 内核索引补充**。
	 *
	 * ## 为什么不只信内核索引
	 *
	 * 索引可能「不存在 / 构建失败 / 缓存陈旧不完整」。2026-09-22 实测到的真实案例：
	 * 索引里只有 1 篇而磁盘有 15 篇 ⇒ 全部链接变断链，且断链在 UI 上**完全静默**
	 * （`LinkComponent` 直接 return），用户只看到「点了没反应」。
	 *
	 * 链接解析需要的只是「文件名清单」，而**文件系统才是权威真源**；枚举 15 篇 md
	 * 实测仅数十毫秒 ⇒ 用磁盘结果兜底/合并，语义上也更符合用户直觉
	 * （文件确实存在 ⇒ 链接就该能跳）。
	 */
	private async _loadWorkspaceFiles(resource: URI): Promise<{ uri: string; name: string }[]> {
		// ★ 2026-09-23：先看缓存（见字段注释）——同一 vault 内连续打开多篇笔记时，
		// 这份「文件名清单」几乎不变，没必要每次重扫磁盘 + 重查内核。
		const vaultRoot = await this._findVaultRoot(resource);
		const vaultKey = vaultRoot?.toString() ?? '';
		const cached = this._workspaceFilesCache;
		if (cached && cached.vaultKey === vaultKey && cached.files.length && Date.now() - cached.at < 30_000) {
			return cached.files;
		}

		let kernelFiles: { uri: string; name: string }[] = [];
		try {
			kernelFiles = await this._kbKernelService.getWorkspaceFiles(resource.toString());
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] kernel workspace index unavailable', err);
		}

		const diskFiles = await this._enumerateVaultNotes(vaultRoot);
		if (diskFiles.length === 0) {
			// 没有磁盘结果时只剩内核索引 —— 同样要过滤（★ 见下）
			const only = this._sanitizeWorkspaceFiles(kernelFiles, 'kernel-only');
			this._workspaceFilesCache = { vaultKey, at: Date.now(), files: only };
			return only;
		}

		// 合并去重：**磁盘优先**（name 以磁盘为准，避免索引里的陈旧命名）
		const byUri = new Map<string, { uri: string; name: string }>();
		for (const f of kernelFiles) { byUri.set(f.uri, f); }
		for (const f of diskFiles) { byUri.set(f.uri, f); }
		const merged = this._sanitizeWorkspaceFiles([...byUri.values()], `kernel=${kernelFiles.length} disk=${diskFiles.length}`);
		this._logService.info(`[KbBlocksEditorPane] workspaceFiles: kernel=${kernelFiles.length} disk=${diskFiles.length} merged=${merged.length}`);
		this._workspaceFilesCache = { vaultKey, at: Date.now(), files: merged };
		return merged;
	}

	/**
	 * 丢掉**没有可用 uri / name** 的清单条目（★ 2026-09-24 诊断「文件不可用或不在当前库内」）。
	 *
	 * 内核索引（`KbNativeKernel.listNotes()`）会包含**合成文档**（如 `.overview.md`），其 `uri`
	 * 可能是空串。空 uri 的条目**永远打不开**，却会在 webview 侧的消歧规则里
	 * （「最短路径优先」：`''.length === 0` 最小）**胜出**并挤掉真正可用的磁盘条目 ⇒
	 * 链接/嵌入"解析成功"但拿不到路径，UI 只显示「文件不可用或不在当前库内」，真因被掩盖。
	 * ⇒ 在源头过滤，并打印被丢弃的样例（便于确认索引污染程度）。
	 */
	private _sanitizeWorkspaceFiles(
		files: { uri: string; name: string }[],
		origin: string,
	): { uri: string; name: string }[] {
		const out: { uri: string; name: string }[] = [];
		const dropped: string[] = [];
		for (const f of files ?? []) {
			if (typeof f?.uri === 'string' && f.uri && typeof f?.name === 'string' && f.name) {
				out.push(f);
			} else if (dropped.length < 5) {
				dropped.push(`uri=${JSON.stringify(f?.uri)} name=${JSON.stringify(f?.name)}`);
			}
		}
		if (files && out.length !== files.length) {
			this._logService.warn(`[KbBlocksEditorPane] dropped ${files.length - out.length} malformed workspaceFiles entries (${origin}): ${dropped.join(' | ')}`);
		}
		return out;
	}

	/** 枚举 vault 的 `库` / `笔记` 两个分区下的 markdown 与 html（`root` 为空 ⇒ 返回空）。 */
	private async _enumerateVaultNotes(root: URI | undefined): Promise<{ uri: string; name: string }[]> {
		if (!root) { return []; }
		const files: { uri: string; name: string }[] = [];
		for (const section of ['库', '笔记']) {
			await this._collectMarkdownFiles(URI.joinPath(root, section), files);
		}
		return files;
	}

	/** 递归收集 markdown（带条目上限，避免超大库把打开笔记拖慢）。 */
	private async _collectMarkdownFiles(dir: URI, out: { uri: string; name: string }[]): Promise<void> {
		if (out.length > 20000) { return; }
		let stat;
		try { stat = await this._fileService.resolve(dir); } catch { return; }
		if (!stat.children) { return; }
		for (const c of stat.children) {
			if (c.isDirectory) {
				await this._collectMarkdownFiles(c.resource, out);
			} else if (/\.(md|markdown|html|htm|drawio|mermaid|mmd|canvas)$/i.test(c.name)) {
				// ★ 2026-09-24：html/图表文件也进清单 —— 「活页面」与「图表文件」嵌入
				//   （`![[page.html]]` / `![[x.drawio|.mermaid|.canvas]]`）的解析依赖这份文件名清单
				//   （此前只收 md ⇒ 这些 embed 永远解析不到目标）。
				out.push({ uri: c.resource.toString(), name: c.name });
			}
		}
	}

	/**
	 * 从笔记 URI 向上找 vault 根：**含 `笔记` 子目录的最近祖先**。
	 *
	 * 与 `kbNativeKernelService._inferBuildContext` 同规则，但**不依赖 `.kbkernel.json`**
	 * （该缓存文件可能不存在 —— 例如刚被清理或从未生成，此时内核侧的根推断会失败）。
	 */
	private async _findVaultRoot(resource: URI): Promise<URI | undefined> {
		let cur: URI | undefined = URI.joinPath(resource, '..');
		for (let depth = 0; depth < 12 && cur; depth++) {
			if (await this._isDirectory(URI.joinPath(cur, '笔记'))) { return cur; }
			const parent = URI.joinPath(cur, '..');
			if (parent.toString() === cur.toString()) { break; }
			cur = parent;
		}
		return undefined;
	}

	private async _isDirectory(uri: URI): Promise<boolean> {
		try { const s = await this._fileService.resolve(uri); return !!s?.children; } catch { return false; }
	}

	private _mediaCandidates(): URI[] {
		const appRoot = this._environmentService.appRoot;
		const segments = ['vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media'];
		const outUri = URI.joinPath(URI.file(appRoot), 'out', ...segments);
		const srcUri = URI.joinPath(URI.file(appRoot), 'src', ...segments);
		// Prefer `src` (the esbuild output target — always the freshest local
		// build) during development; fall back to `out` for the packaged build
		// where `src` is not shipped.
		return [srcUri, outUri];
	}

	private async _resolveMediaUri(): Promise<URI | undefined> {
		for (const uri of this._mediaCandidates()) {
			try {
				await this._fileService.stat(URI.joinPath(uri, 'kbblocks.js'));
				return uri;
			} catch {
				// try next candidate
			}
		}
		return undefined;
	}

	/**
	 * 组装注入给 webview 的初始数据（`window.__KB_INIT__` 与 `kbblocks.loadDoc` **共用同一形态**）。
	 *
	 * ⚠ 必须共用：首次注入 HTML 与「复用 webview 换文档」是两条路径，若各自拼一份数据，
	 * 迟早漂移成「首次打开正常、切换笔记却缺 assetBaseUri / workspaceFiles」这类难查问题。
	 */
	private _buildInitData(): Record<string, unknown> {
		// ⚠ 临时诊断（2026-09-24，定位"笔记里图片一律裂图"）。定案后删除。
		//   只回答一个问题：宿主**有没有**注入 assetBaseUri、它长什么样。
		//   为什么必须打日志：六种图片写法（含 file:/// 绝对路径）在内置预览里全断，而
		//   `resolveAssetSrc` 的逻辑本身是对的 ⇒ 断点只可能在"注入了什么"这一层，日志是唯一
		//   能区分「没注入 / 注入了但值不对 / 注入了也对（那么断点在 webview 侧）」的手段。
		{
			const base = this._currentResource ? asWebviewUri(URI.joinPath(this._currentResource, '..')).toString() : '(none)';
			this._logService.info(`[KbBlocksEditorPane][diag] resource=${this._currentResource?.toString() ?? '(none)'}`
				+ ` currentFilePath=${this._currentFilePath ?? '(none)'} assetBaseUri=${base}`
				+ ` markdownLen=${(this._currentMarkdown ?? '').length}`
				+ ` hasAssetsRef=${/!\[[^\]]*\]\((?!https?:)[^)]*\)/.test(this._currentMarkdown ?? '')}`);
		}
		return {
			docId: this._currentResource?.toString() ?? 'kb:probe',
			markdown: this._currentMarkdown,
			workspaceFiles: this._workspaceFiles,
			currentFilePath: this._currentFilePath,
			// 图文显示：文档目录的 webview URI 前缀（webview 侧拼接相对图片路径）
			...(this._currentResource ? { assetBaseUri: asWebviewUri(URI.joinPath(this._currentResource, '..')).toString() } : {}),
			...(this._pendingHeading ? { heading: this._pendingHeading } : {}),
		};
	}

	/** 读取并缓存 `kbblocks.js` / `kbblocks.css`（见 `_bundleCache` 字段注释）。 */
	private async _readBundle(mediaUri: URI | undefined): Promise<{ js: string; css: string }> {
		if (!mediaUri) { return { js: '', css: '' }; }
		const key = mediaUri.toString();
		if (this._bundleCache?.key === key) {
			return { js: this._bundleCache.js, css: this._bundleCache.css };
		}

		let js = '';
		let css = '';
		try {
			js = (await this._fileService.readFile(URI.joinPath(mediaUri, 'kbblocks.js'))).value.toString();
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to read kbblocks.js, using external ref', err);
		}
		try {
			css = (await this._fileService.readFile(URI.joinPath(mediaUri, 'kbblocks.css'))).value.toString();
		} catch {
			// no stylesheet — use default styles
		}
		// 只在成功时缓存：读取失败（例如媒体目录尚未构建）留待下次重试
		if (js) { this._bundleCache = { key, js, css }; }
		return { js, css };
	}

	private async _ensureWebview(): Promise<void> {
		if (!this._container) {
			return;
		}

		// ★ 2026-09-23：**已有 webview 时绝不 setHtml**。
		//
		// 此前每次打开笔记都 `setHtml(html)`，而 html 里内联着整个 `kbblocks.js`
		// （React + react-markdown + KaTeX，数 MB）⇒ 每次切换笔记都等于**冷启动**一次
		// webview（重新解析 HTML + 重新执行整个 bundle）。这就是「打开笔记渲染太慢」的主因，
		// 也让 `retainContextWhenHidden: true` 完全失效。
		// 现在：只在**首次创建**时注入 HTML，之后仅推送新文档数据（webview 的 `kbblocks.loadDoc`）。
		if (this._webview) {
			this._webview.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.loadDoc',
				data: this._buildInitData(),
			});
			return;
		}

		const mediaUri = await this._resolveMediaUri();
		const { js: bundleJs, css } = await this._readBundle(mediaUri);
		const html = this._getHtml(bundleJs, css, mediaUri);

		// 图文显示：把「当前笔记所在目录」加入资源根，webview 内的相对路径图片
		// （![](x.png) / ![[x.png]]）经 asWebviewUri 前缀（init.assetBaseUri）加载；
		// 媒体库根一并授权 ⇒ `saros-media://<id>` 引用（resolveMediaAsset 桥）可直接加载。
		const docDir = this._currentResource ? URI.joinPath(this._currentResource, '..') : undefined;
		const mediaLibDir = URI.joinPath(URI.file(this._environmentService.userDataPath), 'media');
		// ★ 2026-09-23：webview 现在会被**复用**，而 `localResourceRoots` 只在创建时生效一次
		// ⇒ 不能只授权「当前笔记目录」（否则切到别的目录后相对图片全部加载失败）
		// ⇒ 额外授权整个 vault 根（同 vault 内的笔记/附件都可用）。
		const vaultRoot = this._currentResource ? await this._findVaultRoot(this._currentResource) : undefined;
		const localResourceRoots = [
			...this._mediaCandidates(),
			...(vaultRoot ? [vaultRoot] : []),
			...(docDir ? [docDir] : []),
			mediaLibDir,
		];

		this._webview = this._webviewService.createWebviewElement({
			title: 'Markdown KB',
			options: {
				enableFindWidget: false,
				retainContextWhenHidden: true,
				// ★ 2026-09-23：**不能禁用 service worker**（原先按「bundle 已内联 ⇒ SW 纯开销」禁用）。
				//   笔记里的图片走 `init.assetBaseUri`（`asWebviewUri` → `…vscode-cdn.net/…`）与
				//   `saros-media://` 引用 —— 都是**本地资源**，加载必须经 SW 代理（见 `webview.ts`
				//   的 `disableServiceWorker` 注释）。禁用后这些请求无人代理 ⇒ 图片全部裂图。
				//   （省掉 SW 的收益只对「脚本内联」那一部分成立，图片没法内联。）
				disableServiceWorker: false,
			},
			contentOptions: {
				allowScripts: true,
				allowForms: true,
				localResourceRoots,
			},
			extension: undefined,
		});

		this._register(this._webview);

		this._register(
			this._webview.onMessage((e) => this._onMessage(e.message as KbHostMessage)),
		);

		this._webview.mountTo(this._container, mainWindow);
		this._webview.setHtml(html);
	}

	private async _onMessage(msg: KbHostMessage): Promise<void> {
		if (!msg || msg.direction !== 'toHost') {
			return;
		}

		if (msg.type === 'kbblocks.ready') {
			const payload = msg.payload as { docId?: string } | undefined;
			this._onReady.fire({ docId: payload?.docId ?? this._currentResource?.toString() ?? '' });
			// AFFiNE "linked references" parity: push the shared kernel's
			// backlinks/mentions for this doc into the webview.
			void this._refreshBacklinks(payload?.docId);
			// ★ 2026-09-24：webview 就绪 ⇒ **重推文件名清单**。`setInput` 里那次推送
			//   常早于 webview 挂载（监听器尚未注册）而被丢弃，导致 wikilink / 嵌入目标
			//   解析不到（用户实测 `![[live-demo.html]]` 报「未在库内找到该文件」）。
			//   ready 由 webview 在自己跑起来之后发出 ⇒ 这一次是确定可达的。
			void this._pushWorkspaceFiles(this._currentResource);
		} else if (msg.type === 'kbblocks.requestWorkspaceFiles') {
			// webview 主动问（自愈路径：清单为空 / 错过推送时）
			void this._pushWorkspaceFiles(this._currentResource);
		} else if (msg.type === 'kbblocks.debugLog') {
			// ★ 2026-09-24：webview 侧诊断日志（生产打包会剥掉 webview 的 console.*，
			//   见 kbMarkdown/kbDebug.ts）⇒ 统一落到宿主日志里，双端日志一处可查。
			const payload = msg.payload as { scope?: string; message?: string } | undefined;
			this._logService.info(`[KB webview] ${payload?.scope ?? '?'}: ${payload?.message ?? ''}`);
		} else if (msg.type === 'kbblocks.save') {
			const payload = msg.payload as { markdown?: string; kind?: string } | undefined;
			if (typeof payload?.markdown === 'string') {
				// Await so we can drop the stale kernel index *after* the `.md`
				// hit disk (task flips also change file content, so invalidate).
				const markdownSaved = await this._saveDoc(payload.markdown);
				if (markdownSaved) {
					this._kbKernelService.invalidate();
					// Notify webview the file was saved (external change notification),
					// so the double-buffer (editContent/dirty) stays in sync.
					this._webview?.postMessage({
						direction: 'toWebview',
						type: 'kbblocks.fileChanged',
						data: { markdown: payload.markdown },
					});
					// AutoGit: snapshot the file after every save (SoloMD v2.2 pattern).
					void this._autoCommit();
				}
			}
			// A task checkbox flip only changes `[ ]`↔`[x]`; it never alters
			// `[[wikilink]]`s, so skip the (relatively heavy) backlink refresh.
			if (payload?.kind !== 'taskToggle') {
				void this._refreshBacklinks();
			}
		} else if (msg.type === 'kbblocks.getNoteContent') {
			const payload = msg.payload as { uri?: string; requestId?: string } | undefined;
			if (typeof payload?.uri === 'string' && typeof payload?.requestId === 'string') {
				void this._serveNoteContent(payload.uri, payload.requestId);
			}
		} else if (msg.type === 'kbblocks.renderDrawio') {
			const payload = msg.payload as { source?: string; requestId?: string; theme?: string } | undefined;
			if (typeof payload?.source === 'string' && typeof payload?.requestId === 'string') {
				void this._handleRenderDrawio(payload.source, payload.requestId, payload.theme);
			}
		} else if (msg.type === 'kbblocks.openHtmlEmbed') {
			const payload = msg.payload as { uri?: string } | undefined;
			if (typeof payload?.uri === 'string') {
				void this._openHtmlEmbed(payload.uri);
			}
		} else if (msg.type === 'kbblocks.openRelative') {
			const payload = msg.payload as { href?: string; fromUri?: string } | undefined;
			if (typeof payload?.href === 'string' && typeof payload?.fromUri === 'string') {
				this._openRelative(payload.href, payload.fromUri);
			}
		} else if (msg.type === 'kbblocks.openExternal') {
			const payload = msg.payload as { url?: string } | undefined;
			if (typeof payload?.url === 'string') {
				try {
					void this._openerService.open(URI.parse(payload.url), { openExternal: true });
				} catch (err) {
					this._logService.warn('[KbBlocksEditorPane] failed to open external url', err);
				}
			}
		} else if (msg.type === 'kbblocks.copy') {
			const payload = msg.payload as { markdown?: string } | undefined;
			if (typeof payload?.markdown === 'string') {
				void this._copyMarkdown(payload.markdown);
			}
		} else if (msg.type === 'kbblocks.openDoc') {
			const payload = msg.payload as { uri?: string; heading?: string } | undefined;
			if (typeof payload?.uri === 'string') {
				this._openDocByUri(payload.uri, payload.heading);
			}
		} else if (msg.type === 'kbblocks.getVersionHistory') {
			const payload = msg.payload as { requestId?: string } | undefined;
			if (typeof payload?.requestId === 'string') {
				void this._handleGetVersionHistory(payload.requestId);
			}
		} else if (msg.type === 'kbblocks.getVersionDiff') {
			const payload = msg.payload as { requestId?: string; sha?: string } | undefined;
			if (typeof payload?.requestId === 'string' && typeof payload?.sha === 'string') {
				void this._handleGetVersionDiff(payload.requestId, payload.sha);
			}
		} else if (msg.type === 'kbblocks.restoreVersion') {
			const payload = msg.payload as { sha?: string } | undefined;
			if (typeof payload?.sha === 'string') {
				void this._handleRestoreVersion(payload.sha);
			}
		} else if (msg.type === 'kbblocks.renderMermaid') {
			const payload = msg.payload as { source?: string; requestId?: string; theme?: string } | undefined;
			if (typeof payload?.source === 'string' && typeof payload?.requestId === 'string') {
				void this._handleRenderMermaid(payload.source, payload.requestId, payload.theme);
			}
		} else if (msg.type === 'kbblocks.resolveMediaAsset') {
			// 同源化方案 B（引用层）：把笔记里 `saros-media://<id>` 解析为 webview 可加载 URL
			const payload = msg.payload as { assetId?: string; requestId?: string } | undefined;
			if (typeof payload?.assetId === 'string' && typeof payload?.requestId === 'string') {
				void this._handleResolveMediaAsset(payload.assetId, payload.requestId);
			}
		} else if (msg.type === 'kbblocks.saveMediaToNote') {
			// 同源化方案 C（沉淀层）：媒体库资产显式复制进笔记附件目录并回报相对引用
			const payload = msg.payload as { assetId?: string; requestId?: string } | undefined;
			if (typeof payload?.assetId === 'string' && typeof payload?.requestId === 'string') {
				void this._handleSaveMediaToNote(payload.assetId, payload.requestId);
			}
		}
	}

	/**
	 * 方案 B：`saros-media://<id>` → 媒体库文件绝对路径 → asWebviewUri（webview 可加载）。
	 * 失败（资产不存在 / 无媒体库）回 url=null，webview 显示占位而非裂图。
	 */
	private async _handleResolveMediaAsset(assetId: string, requestId: string): Promise<void> {
		let url: string | null = null;
		try {
			const backend = this._getKbMediaBackend();
			const filePath = backend ? await backend.getFilePath(assetId) : null;
			if (filePath) { url = asWebviewUri(URI.file(filePath)).toString(); }
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] resolveMediaAsset failed', err);
		}
		this._webview?.postMessage({
			direction: 'toWebview',
			type: 'kbblocks.mediaAssetUrl',
			data: { requestId, assetId, url },
		});
	}

	/**
	 * 方案 C：把媒体库资产复制到 `<note>.attachments/`，回报可写进正文的相对引用。
	 * 复制即快照——媒体库后续版本更新不影响笔记（刻意不联动）。
	 */
	private async _handleSaveMediaToNote(assetId: string, requestId: string): Promise<void> {
		let relRef: string | null = null;
		let error: string | undefined;
		try {
			if (!this._currentResource) { throw new Error('no open note'); }
			const backend = this._getKbMediaBackend();
			if (!backend) { throw new Error('media backend unavailable'); }
			const asset = await backend.get(assetId);
			const filePath = await backend.getFilePath(assetId);
			if (!asset || !filePath) { throw new Error('asset not found'); }
			const bytes = (await this._fileService.readFile(URI.file(filePath))).value.buffer;
			this._attachmentStore ??= new KbAttachmentStore(this._fileService);
			const fileName = asset.fileName ?? `${assetId}.png`;
			const id = await this._attachmentStore.save(this._currentResource, bytes, fileName, asset.mime ?? 'image/png');
			relRef = KbAttachmentStore.relativeRef(this._currentResource, id, fileName);
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			this._logService.warn('[KbBlocksEditorPane] saveMediaToNote failed', err);
		}
		this._webview?.postMessage({
			direction: 'toWebview',
			type: 'kbblocks.mediaSaved',
			data: { requestId, assetId, relRef, error },
		});
	}

	/** Render Mermaid source via the shared inline renderer and stream the SVG back to the webview. */
	private async _handleRenderMermaid(source: string, requestId: string, theme?: string): Promise<void> {
		let svg = '';
		let error = '';
		try {
			svg = await this._mermaidRenderer.renderToSvg(source, theme === 'dark' ? 'dark' : 'default');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		this._webview?.postMessage({
			direction: 'toWebview',
			type: 'kbblocks.mermaidResult',
			data: { requestId, svg, error },
		});
	}

	/** `![[x.drawio]]` 嵌入的渲染（镜像 `_handleRenderMermaid`；引擎与聊天 drawio 卡片一致）。 */
	private async _handleRenderDrawio(source: string, requestId: string, theme?: string): Promise<void> {
		let svg = '';
		let error = '';
		try {
			svg = await this._drawioRenderer.renderToSvg(source, theme === 'dark' ? 'dark' : 'default');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		}
		this._webview?.postMessage({
			direction: 'toWebview',
			type: 'kbblocks.drawioResult',
			data: { requestId, svg, error },
		});
	}

	/** Query the shared KB kernel for backlinks/mentions and push to the webview. */
	private async _refreshBacklinks(docId?: string): Promise<void> {
		const id = docId ?? this._currentResource?.toString();
		if (!id || !this._webview) {
			return;
		}
		try {
			const result = await this._kbKernelService.getBacklinks(id);
			const payload = serializeBacklinks(result);
			this._webview.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.backlinks',
				data: payload,
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to resolve backlinks', err);
		}
	}

	/** Open a KB note referenced by a backlink card / wikilink (AFFiNE jump-to-reference parity). */
	private _openDocByUri(uriStr: string, heading?: string): void {
		try {
			const uri = URI.parse(uriStr);
			this._editorService.openEditor(
				new KbNoteEditorInput(uri, uri.path, heading),
				{ pinned: true },
				this.group,
			);
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to open backlink target', err);
		}
	}

	/**
	 * Serve a note's markdown to the webview for an `![[embed]]`（不限扩展名 —— 图表/HTML 嵌入也走它）。
	 *
	 * ★ 2026-09-24：失败时**带上原因**（`error` 字段）—— 此前只回空串，webview 只能显示
	 * 「读取失败」，真实病因（ENOENT / 权限 / URI 解析）全被吞掉，排查只能猜。
	 * 现在 error 会一路透传到嵌入卡片的错误文案里。
	 */
	private async _serveNoteContent(uriStr: string, requestId: string): Promise<void> {
		const respond = (markdown: string, error?: string): void => {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.noteContent',
				data: { requestId, markdown, error },
			});
		};
		try {
			const uri = URI.parse(uriStr);
			// 诊断（★ 2026-09-24）：先记录「收到请求」，与 webview 侧 `[KB embed] request` 配对排查。
			this._logService.info(`[KbBlocksEditorPane] getNoteContent request uri=${uriStr} id=${requestId}`);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			this._logService.info(`[KbBlocksEditorPane] served embed content: ${uriStr} (${text.length} chars)`);
			respond(text);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this._logService.warn(`[KbBlocksEditorPane] failed to serve embed content ${uriStr}: ${reason}`);
			respond('', reason);
		}
	}

	/**
	 * 「活页面」嵌入（`![[page.html]]`）的「⚡ 打开活页面」按钮：在**专属页签**里打开
	 * `HtmlPreviewEditorPane`（独立 webview，脚本完整运行 —— 与点击 .html 文件同一成熟通道）。
	 *
	 * 为什么不内联跑脚本：VS Code webview 的 Service Worker 处理资源请求要从
	 * `event.clientId` 反查 `webviewId`（`processResourceRequest`），而 iframe 顶层导航是
	 * **新 client**、从未注册 ⇒ SW 恒返回 notFound ⇒ 内联 iframe 白屏（2026-09-24 实测）；
	 * srcdoc/blob 又会继承父文档 CSP（script-src nonce）⇒ 脚本同样无法运行。
	 * ⇒ 内联只做静态预览（srcDoc + sandbox=""），活交互交给专属页签。
	 *
	 * ⚠ 安全边界：只打开**当前 vault 内**的文件（防 `![[../../secret.html]]` 借道）。
	 */
	private async _openHtmlEmbed(uriStr: string): Promise<void> {
		try {
			const target = URI.parse(uriStr);
			const vaultRoot = this._currentResource ? await this._findVaultRoot(this._currentResource) : undefined;
			const rootStr = vaultRoot?.toString();
			if (!rootStr || !target.toString().startsWith(rootStr + '/')) {
				this._logService.warn('[KbBlocksEditorPane] openHtmlEmbed rejected (outside vault):', uriStr);
				return;
			}
			const fileName = target.path.split('/').pop() ?? 'page.html';
			const input = new HtmlPreviewEditorInput(target, `活页面：${fileName}`);
			await this._editorService.openEditor(input, { pinned: true });
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] openHtmlEmbed failed', err);
		}
	}

	/** Open a relative markdown/canvas link resolved against the current note. */
	private _openRelative(href: string, fromUri: string): void {
		try {
			const base = dirname(URI.parse(fromUri));
			const segments = href.split('/').filter((s) => s.length > 0 && s !== '.');
			const parts: string[] = [];
			for (const s of segments) {
				if (s === '..') parts.pop();
				else parts.push(s);
			}
			const target = URI.joinPath(base, ...parts);
			// ★★ 2026-09-24（用户要求「知识库中的 png/svg 图片要在 editorPane 中显示」）：
			//   **按类型路由**，不要一律套 KbNoteEditorInput —— 后者会把图片当笔记渲染（满屏二进制）。
			//
			//   ⚠ 但媒体类**不能**走 `openEditor({ resource })`：resolver 内部 `createInstance(input)`
			//   而调用方拿不到引用 ⇒ 失败/关闭时无人释放（知识库视图踩过 `[LEAKED DISPOSABLE]
			//   new KbMediaViewerInput`，见 knowledgeBaseView._openMediaViewer 的注释）。
			//   ⇒ 这里与视图同款：**自己创建、按资源复用、失败时自己释放**；并用 `_register` 挂钩
			//     本 pane 的生命周期（pane 销毁 ⇒ input 一并释放），彻底避免泄漏。
			if (!/\.(md|markdown)$/i.test(target.path) && isKbMediaViewerFile(target)) {
				const key = target.toString();
				let input = this._mediaInputs.get(key);
				if (!input) {
					input = this._register(new KbMediaViewerInput(target));
					this._mediaInputs.set(key, input);
				}
				const opened = input;
				void this._editorService.openEditor(opened, { pinned: true }, this.group).then(
					(result) => {
						if (!result) {
							this._mediaInputs.delete(key);
							this._logService.warn(`[KbBlocksEditorPane] 媒体预览未能打开，已释放 input：${key}`);
							opened.dispose();
						}
					},
					(err) => {
						this._mediaInputs.delete(key);
						this._logService.warn('[KbBlocksEditorPane] 打开媒体预览失败', err);
						opened.dispose();
					},
				);
				return;
			}
			this._editorService.openEditor(
				new KbNoteEditorInput(target, target.path),
				{ pinned: true },
				this.group,
			);
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to open relative link', err);
		}
	}

	/** Copy the current note's Markdown to the OS clipboard (AFFiNE "copy" parity). */
	private async _copyMarkdown(markdown: string): Promise<void> {
		try {
			await this._clipboardService.writeText(markdown);
			this._logService.info('[KbBlocksEditorPane] KB note markdown copied to clipboard');
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to copy KB note markdown', err);
		}
	}

	/** AutoGit: commit the current file after a save (SoloMD v2.2 pattern). */
	private async _autoCommit(): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) return;
			const sha = await this._versionService.autoCommit(vaultRoot, this._currentResource);
			if (sha && this._webview) {
				this._webview.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionCommitted',
					data: { sha, shortSha: sha.substring(0, 7) },
				});
			}
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] autoCommit failed', err);
		}
	}

	/** Handle webview request for version history. */
	private async _handleGetVersionHistory(requestId: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits: [] },
			});
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) {
				this._webview?.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionHistory',
					data: { requestId, commits: [] },
				});
				return;
			}
			const commits: KbCommitMeta[] = await this._versionService.fileHistory(vaultRoot, this._currentResource);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits },
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] getVersionHistory failed', err);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionHistory',
				data: { requestId, commits: [] },
			});
		}
	}

	/** Handle webview request for a specific commit's diff. */
	private async _handleGetVersionDiff(requestId: string, sha: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff: null },
			});
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) {
				this._webview?.postMessage({
					direction: 'toWebview',
					type: 'kbblocks.versionDiff',
					data: { requestId, diff: null },
				});
				return;
			}
			const diff: KbDiffResult | null = await this._versionService.fileDiff(vaultRoot, this._currentResource, sha);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff },
			});
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] getVersionDiff failed', err);
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionDiff',
				data: { requestId, diff: null },
			});
		}
	}

	/** Handle webview request to restore a file to a specific commit version. */
	private async _handleRestoreVersion(sha: string): Promise<void> {
		if (!this._currentResource || !this._versionService.isAvailable()) {
			return;
		}
		try {
			const vaultRoot = this._versionService.resolveVaultRoot(this._currentResource);
			if (!vaultRoot) return;
			const restoredContent = await this._versionService.rollbackFile(vaultRoot, this._currentResource, sha);
			// Update our in-memory copy so subsequent saves don't overwrite the rollback.
			this._currentMarkdown = restoredContent;
			this._kbKernelService.invalidate();
			// Notify webview with the restored content so the editor buffer syncs.
			this._webview?.postMessage({
				direction: 'toWebview',
				type: 'kbblocks.versionRestored',
				data: { sha, markdown: restoredContent },
			});
			this._logService.info('[KbBlocksEditorPane] restored to', sha.substring(0, 7));
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] restoreVersion failed', err);
		}
	}

	/**
	 * Persist the note. Returns `true` if the `.md` (the only thing the shared
	 * kernel indexes) was actually written — callers use this to decide whether
	 * the backlink index needs invalidating.
	 */
	/**
	 * Persist the note. Returns `true` if the `.md` (the only source of truth now
	 * that BlockSuite/`.bsdoc` is gone) was actually written.
	 */
	private async _saveDoc(markdown: string | undefined): Promise<boolean> {
		if (!this._currentResource || typeof markdown !== 'string') {
			return false;
		}
		try {
			await this._fileService.writeFile(this._currentResource, VSBuffer.fromString(markdown));
			this._currentMarkdown = markdown;
			this._logService.info('[KbBlocksEditorPane] KB note saved (markdown)');
		} catch (err) {
			this._logService.warn('[KbBlocksEditorPane] failed to save KB note', err);
			return false;
		}
		return true;
	}

	private _getHtml(bundleJs: string, css: string, mediaUri: URI | undefined): string {
		const nonce = generateUuid().replace(/-/g, '');
		// ★ 与复用路径的 `kbblocks.loadDoc` 共用同一份数据组装（见 `_buildInitData`），避免两处漂移
		// ★★ 2026-09-24 用户实测踩坑：笔记正文里含 `</script>`（如演示内嵌 HTML 的文档）时，
		//   内联 <script> 里的 JSON 会被 HTML 解析器**提前截断** ⇒ `__KB_INIT__` 损坏 ⇒
		//   整篇笔记渲染成「空白文件」。⇒ 所有 `<` 转义为 \u003c（JSON 合法转义，语义不变）。
		const initJson = escapeJsonForInlineScript(JSON.stringify(this._buildInitData()));

		// Inline the stylesheet (style-src 'unsafe-inline' allows it; a <link> to a
		// webview resource would be blocked by the CSP origin allow-list).
		const styleTag = css ? `<style nonce="${nonce}">${css}</style>` : '';

		let scriptTag: string;
		if (bundleJs.length > 0) {
			scriptTag = `<script nonce="${nonce}">${bundleJs}</script>`;
		} else if (mediaUri) {
			// Fallback: external reference through the webview URI (needs SW on).
			const scriptUri = asWebviewUri(URI.joinPath(mediaUri, 'kbblocks.js')).toString();
			scriptTag = `<script nonce="${nonce}" src="${scriptUri}"></script>`;
		} else {
			scriptTag = `<script nonce="${nonce}">console.error('[KbBlocksEditorPane] kbblocks.js not found');</script>`;
		}

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: https: vscode-webview: vscode-resource:; font-src data: vscode-webview: vscode-resource:; connect-src vscode-webview:;">
	<title>Markdown KB</title>
	${styleTag}
</head>
<body>
	<div id="root" style="height:100%"></div>
	<script nonce="${nonce}">window.__KB_INIT__ = ${initJson};</script>
	${scriptTag}
</body>
</html>`;
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}

	override clearInput(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		this._currentResource = undefined;
		this._currentMarkdown = '';
		this._workspaceFiles = [];
		this._currentFilePath = '';
		if (this._container) {
			DOM.clearNode(this._container);
		}
		super.clearInput();
	}

	override dispose(): void {
		if (this._webview) {
			this._webview.dispose();
			this._webview = undefined;
		}
		super.dispose();
	}
}
