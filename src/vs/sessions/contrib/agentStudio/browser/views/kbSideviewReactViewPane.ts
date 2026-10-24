/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 知识库侧栏 · **React 版**视图（实验入口）。
 *
 * 目的：让 IDE 侧栏与 agents 窗口插件页能复用**同一份 UI 代码**
 * （React 组件见 `webview/src/kbSideview/index.tsx`，产出 `webview/media/kbSideview.js`）。
 *
 * ── 为什么不走 `WebviewViewProvider` ─────────────────────────────────────────
 * 仓库里没有它的先例，而 `kbBlocksEditorPane` 已经验证了另一条路：
 * `IWebviewService.createWebviewElement()` + `mountTo(container)` + 内联 html。
 * ⇒ 同一套机制可以挂到**任意 DOM 容器**，于是不需要扩展点、不需要 `localResourceRoots`。
 *
 * ── 视图 id 为什么独立 ──────────────────────────────────────────────────────
 * `agentStudio.knowledgeBaseView` 在 legacy 下是 `KnowledgeBaseViewPane`（5030 行），
 * 在 dsh 下被 `DshPluginViewPane` 接管；抢同一 id 会抛 "already registered" 并中断加载 ✗。
 */

import { mainWindow } from '../../../../../base/browser/window.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { URI } from '../../../../../base/common/uri.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IWebviewElement, IWebviewService } from '../../../../../workbench/contrib/webview/browser/webview.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { loadActiveKbVault, resolveKbRootUri, resolveVaultNotesDir } from '../knowledge/kbVaultState.js';
import { IKbCommandService } from '../knowledge/kbCommandService.js';
// 双链/反链：复用 IDE 侧栏（knowledgeBaseView）已在用的同一个图索引，不另写一份解析 ✗
import { KbLinkGraph } from './knowledgeBase/kbGraph.js';

/** 双链索引缓存（60s）：图索引要读全库正文，不能每次刷新都重建 */
let LINK_CACHE: { key: string; at: number; graph: KbLinkGraph } | undefined;

/**
 * 侧栏里**可见的文件类型**（2026-10-23）。
 *
 * 原来只收 `.md` ⇒ 库区的 pdf / canvas / 图片 / docx **在侧栏里根本看不见**，
 * 而 IDE sideview 里它们是能看见、并能由编辑器 resolver 打开的（`.canvas` 走 agentStudio
 * 的 resolver、pdf/docx/媒体走 kbMediaViewerPane）⇒ 这是一个真实的能力缺口，不是懒。
 * ⚠ 不按"全部文件"放开：`index.md`/缓存 json 那类噪音已由组件的 `isNoise` 过滤，
 *   但把 `json/ts/js` 也放进来会让库树变成文件浏览器 ✗ —— 只放"能打开、有意义"的类型。
 */
const VIEWABLE_EXTS = new Set([
	'md', 'markdown', 'canvas',
	'pdf', 'docx', 'pptx', 'xlsx',
	'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
	'mp4', 'webm', 'mp3', 'wav',
	'html', 'htm', 'txt',
]);

/** 收树里的文件节点（`path` 已是 `笔记/…` 相对形态，与组件同一命名空间） */
function flattenFiles(nodes: readonly KbTreeNode[]): KbTreeNode[] {
	const out: KbTreeNode[] = [];
	for (const n of nodes) {
		if (n.isFolder) { out.push(...flattenFiles(n.children ?? [])); } else { out.push(n); }
	}
	return out;
}

type LinkPair = { out: Array<{ title: string; path: string }>; in: Array<{ title: string; path: string }> };

/**
 * 建一份**全量**双链索引：每篇笔记的出链与被引（反链）。
 *
 * 为什么全量而不是按需：选中态在组件本地，宿主看不见；按需就得"点一次 ⇒ 整页重挂"，
 * 会闪屏且丢掉树的展开状态 ✗。102 篇的索引只有几 KB ✓。
 */
async function buildLinkIndex(fileService: IFileService, notesDir: URI, tree: readonly KbTreeNode[], relSegments: (p: string) => string[]): Promise<Record<string, LinkPair>> {
	const key = notesDir.toString();
	if (!LINK_CACHE || LINK_CACHE.key !== key || Date.now() - LINK_CACHE.at > 60_000) {
		const graph = new KbLinkGraph(fileService);
		await graph.build([{ uri: notesDir, section: 'notes' }]);
		LINK_CACHE = { key, at: Date.now(), graph };
	}
	const graph = LINK_CACHE.graph;
	const rel = (uri: URI) => '笔记/' + uri.path.slice(notesDir.path.length + 1);
	const result: Record<string, LinkPair> = {};
	for (const node of flattenFiles(tree)) {
		const id = URI.joinPath(notesDir, ...relSegments(node.path)).toString();
		result[node.path] = {
			out: graph.outgoingLinks(id).filter(l => !!l.targetUri).map(l => ({ title: l.label, path: rel(l.targetUri!) })),
			in: graph.backlinks(id).map(b => ({ title: b.name.replace(/\.md$/i, ''), path: rel(b.uri) })),
		};
	}
	return result;
}

/** 本视图对外暴露的 id（注册方引用它，避免字符串漂移）。 */
export const AGENT_STUDIO_KB_REACT_VIEW_ID = 'agentStudio.knowledgeBaseReactView';

const BUNDLE_JS = 'kbSideview.js';
const BUNDLE_CSS = 'kbSideview.css';
/** 树的最大递归深度（再深就是噪音，且扫描成本上升）。 */
const MAX_TREE_DEPTH = 3;

interface KbTreeNode {
	readonly name: string;
	readonly path: string;
	readonly isFolder: boolean;
	readonly count?: number;
	/** 文件字节数（UI 显示 `1.0 KB`，也用于按大小排序） */
	readonly size?: number;
	/** 修改时间（ms）。原生 sideview 有 14 种排序，这里先落「名称/大小/时间」三种 */
	readonly mtime?: number;
	readonly children?: readonly KbTreeNode[];
}

interface KbSideviewPayload {
	readonly vaultName: string;
	readonly vaults: readonly { readonly id: string; readonly name: string; readonly count: number }[];
	readonly activeVaultId?: string;
	readonly noteCount: number;
	readonly tree: readonly KbTreeNode[];
	/** 「库」区（原料）：与笔记区并列，对齐 IDE sideview 的两节结构 */
	readonly library?: readonly KbTreeNode[];
	readonly libraryCount?: number;
	/** 全量双链索引：`key = 树的 path`（`笔记/…`）⇒ 组件按选中项本地查表 */
	readonly links?: Record<string, LinkPair>;
	readonly tags: readonly { readonly tag: string; readonly count: number }[];
	readonly indexState: 'ready' | 'indexing' | 'stale';
}

/** 组件通过 `postMessage` 发来的动作（与 `webview/src/kbSideview/index.tsx` 的 actions 一一对应）。 */
interface IKbAction {
	readonly type?: 'openNode' | 'openLink' | 'openGraph' | 'openSettings' | 'refresh' | 'switchVault' | 'search' | 'pickTag'
		// 写操作（2026-10-23）：组件只表达意图，落盘/弹框由宿主实现
		| 'createNote' | 'newFolder' | 'renameNode' | 'deleteNode'
		// 拖拽移动（2026-10-23）：`path` = 被拖节点，`toPath` = 目标目录
		| 'moveNode'
		// 多选右键批量删除（只确认一次）
		| 'deleteNodes'
		// 思维导图（2026-10-23）：转发给 IKbCommandService.openMindmap，不重写生成逻辑
		| 'openMindmap'
		// 体检 / 去重（2026-10-24）：转发给 IKbCommandService（规则与报告都在 kbLint / dedup 里）
		| 'runLint'
		| 'runDedup'
		// 审核队列概览（只读，2026-10-24）
		| 'reviewQueue';
	readonly path?: string;
	readonly toPath?: string;
	/** 批量移动的源（多选拖拽一次带多个；单个时组件也会给一个长度 1 的数组） */
	readonly paths?: readonly string[];
	readonly id?: string;
	/** 检索**回推标识**：宿主办完把 requestId 原样带回（组件按它兑现 Promise） */
	readonly requestId?: string;
	readonly query?: string;
	readonly mode?: 'fulltext' | 'filename';
	readonly tag?: string;
}

export class KbSideviewReactViewPane extends ViewPane {

	static readonly ID = AGENT_STUDIO_KB_REACT_VIEW_ID;

	private _webview: IWebviewElement | undefined;
	private _bundleCache: { key: string; js: string; css: string } | undefined;
	/** 挂载容器引用 —— `refresh` 要在这里重建 webview（数据内联在 html 里，无法原地更新）。 */
	private _container: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IWebviewService private readonly _webviewService: IWebviewService,
		@IFileService private readonly _fileService: IFileService,
		@IStorageService private readonly _storageService: IStorageService,
		@IKbCommandService private readonly _kbCommand: IKbCommandService,
		@IEditorService private readonly _editorService: IEditorService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@INativeEnvironmentService private readonly _environmentService: INativeEnvironmentService,
		@ILogService private readonly _logService: ILogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.style.height = '100%';
		container.style.overflow = 'hidden';
		void this._mount(container);
	}

	override dispose(): void {
		this._webview = undefined;
		super.dispose();
	}

	// ── 挂载 ────────────────────────────────────────────────────────────────

	private async _mount(container: HTMLElement): Promise<void> {
		if (this._webview) { return; }
		this._container = container;

		const mediaUri = await this._resolveMediaUri();
		if (!mediaUri) {
			this._logService.warn(`[KB-React] 找不到 ${BUNDLE_JS}（已探测 src/ 与 out/ 的 webview/media）`);
			container.textContent = `找不到 ${BUNDLE_JS}：请先在 src/vs/sessions/contrib/agentStudio/webview 下运行 npm run build:kbSideview`;
			return;
		}

		const [{ js, css }, data] = await Promise.all([this._readBundle(mediaUri), this._buildData()]);
		const nonce = generateUuid().replace(/-/g, '');

		this._webview = this._webviewService.createWebviewElement({
			title: '知识库（React）',
			options: {
				enableFindWidget: false,
				// 侧栏切换时保留 React 状态（否则每次展开都重建整棵树）
				retainContextWhenHidden: true,
			},
			contentOptions: {
				allowScripts: true,
				localResourceRoots: [],
			},
			extension: undefined,
		});

		this._register(this._webview);
		this._register(this._webview.onMessage(e => void this._onAction(e.message as IKbAction)));

		this._webview.mountTo(container, mainWindow);
		this._webview.setHtml(this._getHtml(js, css, nonce, data));
	}

	// ── 动作（组件 → 宿主）──────────────────────────────────────────────────

	private async _onAction(action: IKbAction): Promise<void> {
		try {
			switch (action?.type) {
				case 'openNode':
				case 'openLink':
					if (action.path) { await this._openNote(action.path); }
					break;
				case 'openGraph':
					await this._kbCommand.openGraph();
					break;
				case 'openSettings':
					await this._kbCommand.openSettings();
					break;
				case 'switchVault':
					if (action.id) { this._kbCommand.setActiveVaultId(action.id); }
					break;
				case 'moveNode': {
					const froms = action.paths ?? (action.path ? [action.path] : []);
					if (!froms.length || !action.toPath) { break; }
					const dstBase = await this._baseDirOf(action.toPath);
					if (!dstBase) { break; }
					let moved = 0;
					// 批量：逐个 move，但**只 reload 一次**（每次 reload 都要重建 webview，N 次会闪 N 下）
					for (const from of froms) {
						// 源与目标**各自**解析基准目录：支持跨区移动（库 ⇄ 笔记），也修掉原先"库区路径拼到笔记区"的错
						const srcBase = await this._baseDirOf(from);
						if (!srcBase) { continue; }
						const baseName = srcBase.segs[srcBase.segs.length - 1];
						if (!baseName) { continue; }
						const sameDir = srcBase.dir.toString() === dstBase.dir.toString()
							&& srcBase.segs.slice(0, -1).join('/') === dstBase.segs.join('/');
						// 目标就是原位置 ⇒ 跳过（避免无谓 move + 报错）
						if (sameDir) { continue; }
						const src = URI.joinPath(srcBase.dir, ...srcBase.segs);
						const dst = URI.joinPath(dstBase.dir, ...dstBase.segs, baseName);
						// 同名冲突不让 IFileService 静默覆盖（overwrite=false），失败的跳过、其余照做
						await this._fileService.move(src, dst, false).then(() => { moved++; }).catch(() => undefined);
					}
					if (moved > 0) { await this._reload(); }
					break;
				}
				case 'reviewQueue':
					// 只读概览：不刷新树（没有任何文件变化）
					await this._kbCommand.showReviewQueue();
					break;
				case 'runDedup': {
					const groups = await this._kbCommand.runVaultDedup();
					if (groups >= 0) { await this._reload(); }
					break;
				}
				case 'runLint': {
					// 体检会写 `lint-report.md` ⇒ 成功后刷新树（报告本身就在笔记区里）
					const issues = await this._kbCommand.runVaultLint();
					if (issues >= 0) { await this._reload(); }
					break;
				}
				case 'openMindmap':
					// 生成/打开都交给命令服务（内部已处理"没有库 / 没有 canvas 就先生成"两条分支）
					await this._kbCommand.openMindmap();
					break;
				case 'search': {
					const dir = await this._notesDir();
					const items = dir ? await this._searchNotes(dir, action.query ?? '') : [];
					// 回推：组件按 requestId 兑现 Promise（见 html 里的 PENDING_SEARCH）
					this._webview?.postMessage({ type: 'searchResults', requestId: action.requestId, items });
					break;
				}
				case 'renameNode': {
					const loc = await this._baseDirOf(action.path ?? '');
					if (!loc) { break; }
					const dir = loc.dir;
					const segs = loc.segs;
					const current = segs.length ? segs[segs.length - 1] : '';
					if (!current) { break; }
					// 笔记保留扩展名（tree 里 path 带 `.md`，显示的 name 已去掉）⇒ 输入框只编辑主名
					const isNote = current.toLowerCase().endsWith('.md');
					// ⚠ 本分支上方已用 `loc` 表示「解析出的基准目录」对象；这里**不能**再叫 `base`
					//    （历史上就重名过一次）：同一块作用域里两个同名 `const` ⇒ transpile（esbuild）报
					//    `The symbol "base" has already been declared` ⇒ `npm run transpile-client` 退出码 1
					//    ⇒ F5 的 preLaunchTask 失败（`tsc` 也能看到 TS2451，但 F5 不跑它）。
					const stem = isNote ? current.slice(0, -3) : current;
					const next = await this._quickInput.input({ prompt: isNote ? '笔记名称（不含 .md）' : '目录名称', value: stem });
					if (!next?.trim() || next.trim() === stem) { break; }
					const target = URI.joinPath(dir, ...segs.slice(0, -1), next.trim() + (isNote ? '.md' : ''));
					await this._fileService.move(URI.joinPath(dir, ...segs), target, true);
					await this._reload();
					break;
				}
				case 'deleteNodes': {
					const paths = action.paths ?? [];
					if (!paths.length) { break; }
					const dir = await this._notesDir();
					if (!dir) { break; }
					// **只确认一次**（逐项弹框在批量删除下不可接受）
					const pick = await this._quickInput.pick(
						[{ label: `移到回收站（${paths.length} 项）` }, { label: '取消' }],
						{ placeHolder: `删除选中的 ${paths.length} 项？` },
					);
					if (!pick || !pick.label?.startsWith('移到回收站')) { break; }
					let deleted = 0;
					for (const p of paths) {
						// 逐项解析基准目录：选中的可能跨「库 / 笔记」两区
						const base = await this._baseDirOf(p);
						if (!base) { continue; }
						await this._fileService.del(URI.joinPath(base.dir, ...base.segs), { useTrash: true, recursive: true })
							.then(() => { deleted++; }).catch(() => undefined);
					}
					if (deleted > 0) { await this._reload(); }
					break;
				}
				case 'deleteNode': {
					// `action.path` 是可选字段：先落成局部变量，别在多处反复 `?.`（否则
					// `action.path.split(...)` 会报 TS18048「possibly undefined」✗）
					const path = action.path ?? '';
					const base = await this._baseDirOf(path);
					if (!base) { break; }
					// 复用 quick pick 做确认（不引入额外服务；删除走系统回收站，可恢复）
					const pick = await this._quickInput.pick(
						[{ label: '移到回收站' }, { label: '取消' }],
						{ placeHolder: `删除「${path.split('/').pop() ?? path}」？` },
					);
					if (!pick || pick.label !== '移到回收站') { break; }
					await this._fileService.del(URI.joinPath(base.dir, ...base.segs), { useTrash: true, recursive: true });
					await this._reload();
					break;
				}
				case 'createNote': {
					// ⚠ 是 `input` 不是 `inputBox` —— 本仓的 `IQuickInputService` 只有
					//   `pick` / `input` / `quickAccess`（见 `quickInput.ts:973-980`）。
					const name = await this._quickInput.input({ prompt: '新建笔记名称（不含 .md）', value: '未命名笔记' });
					if (!name?.trim()) { break; }
					const dir = await this._notesDir();
					if (!dir) { break; }
					const target = URI.joinPath(dir, ...this._relSegments(action.path), `${name.trim()}.md`);
					await this._fileService.writeFile(target, VSBuffer.fromString(''));
					await this._editorService.openEditor({ resource: target });
					await this._reload();   // 树里立刻能看到新文件
					break;
				}
				case 'newFolder': {
					const name = await this._quickInput.input({ prompt: '新建目录名称', value: '新目录' });
					if (!name?.trim()) { break; }
					const dir = await this._notesDir();
					if (!dir) { break; }
					await this._fileService.createFolder(URI.joinPath(dir, ...this._relSegments(action.path), name.trim()));
					await this._reload();
					break;
				}
				case 'refresh':
					await this._reload();
					break;
				default:
					this._logService.trace(`[KB-React] 未处理的 action: ${JSON.stringify(action)}`);
			}
		} catch (err) {
			this._logService.warn(`[KB-React] action 执行失败：${JSON.stringify(action)}`, err);
		}
	}

	/**
	 * 重建 webview（`refresh` 与首次挂载走同一条路）。
	 *
	 * 为什么不能"原地更新"：数据是 `setHtml` 时内联进 html 的，React 根已经带着旧
	 * `__KB_SIDEVIEW_DATA__` 初始化完毕 ⇒ 只能整体重建。代价约 30ms（bundle 走缓存
	 * 时不重读盘），对"点一下刷新"完全可接受。
	 */
	private async _reload(): Promise<void> {
		const container = this._container;
		if (!container || container !== this._container || !container.isConnected) { return; }
		this._webview?.dispose();
		this._webview = undefined;
		// bundle 可能刚被 esbuild 重新产出 ⇒ 重读（否则刷新拿到的还是旧 UI）
		this._bundleCache = undefined;
		await this._mount(container);
	}

	/** 笔记区根目录（`<vault>/笔记`）。库未配置时返回 undefined（调用方直接放弃，不弹错误）。 */
	private async _notesDir(): Promise<URI | undefined> {
		const vault = loadActiveKbVault(this._storageService);
		if (!vault) { return undefined; }
		return resolveVaultNotesDir(vault, resolveKbRootUri(this._storageService, this._environmentService));
	}

	/** `笔记/01_学习/x` → `['01_学习','x']`：去掉 `笔记/` 前缀并过滤空段（防止拼出 `笔记/笔记/…`）。 */
	private _relSegments(relPath: string | undefined): string[] {
		return (relPath ?? '').replace(/^笔记\//, '').split('/').filter(Boolean);
	}

	/**
	 * ★ 2026-10-23（修一个已上线的 bug）：按 path 的**首段**决定基准目录。
	 *
	 * 原先所有写操作都是 `URI.joinPath(await this._notesDir(), ..._relSegments(p))`，
	 * 而 `_relSegments` 只剥 `笔记/` ⇒ 库区的 `库/方法/x.md` 会被解析成
	 * `<vault>/笔记/库/方法/x.md`（不存在）⇒ **库区的改名/删除/移动全部失效**（静默失败）。
	 * 两个区的根不同（`笔记` = notesDir，`库` = sectionUri(vault,'library')），必须分开解析。
	 */
	private async _baseDirOf(path: string): Promise<{ dir: URI; segs: string[] } | undefined> {
		const vault = loadActiveKbVault(this._storageService);
		if (!vault) { return undefined; }
		const kbRoot = resolveKbRootUri(this._storageService, this._environmentService);
		const raw = (path ?? '').split('/').filter(Boolean);
		const section = raw[0];
		if (section === '库') {
			return { dir: this._kbCommand.sectionUri(vault, 'library'), segs: raw.slice(1) };
		}
		// `笔记/…` 或（历史数据）没有前缀 ⇒ 都按笔记区处理
		return { dir: resolveVaultNotesDir(vault, kbRoot), segs: section === '笔记' ? raw.slice(1) : raw };
	}

	/** 打开笔记：tree 的 path 形如 `笔记/01_学习/x`，而 notesDir 已指向「笔记」⇒ 去掉前缀。 */
	private async _openNote(relPath: string): Promise<void> {
		// ★ 2026-10-23：原先固定用 notesDir + 只剥 `笔记/` ⇒ **库区文件点开也指错**
		//   （`<vault>/笔记/库/…`，同 `_baseDirOf` 修掉的那批问题）。现在按首段解析基准目录，
		//   库区的 pdf / canvas / 图片也能真正由编辑器 resolver 打开 ✓
		const base = await this._baseDirOf(relPath);
		if (!base) { return; }
		const uri = URI.joinPath(base.dir, ...base.segs);
		await this._editorService.openEditor({ resource: uri });
	}

	// ── 真实数据（当前库的笔记树）────────────────────────────────────────────

	private async _buildData(): Promise<KbSideviewPayload> {
		const empty: KbSideviewPayload = {
			vaultName: '(未配置知识库)', vaults: [], noteCount: 0, tree: [], tags: [], indexState: 'stale',
		};
		try {
			const vault = loadActiveKbVault(this._storageService);
			if (!vault) { return empty; }

			const kbRoot = resolveKbRootUri(this._storageService, this._environmentService);
			const notesDir = resolveVaultNotesDir(vault, kbRoot);
			// 「库」区目录由服务给（不同库的自定义路径由它负责），不自己拼 `<vault>/库`
			const libraryDir = this._kbCommand.sectionUri(vault, 'library');
			const [tree, library, tags] = await Promise.all([
				this._walkChildren(notesDir, '笔记', 0),
				this._walkChildren(libraryDir, '库', 0),
				this._readTags(vault),
			]);
			const noteCount = countLeaves(tree);
			const links = await buildLinkIndex(this._fileService, notesDir, tree, p => this._relSegments(p));

			return {
				vaultName: vault.name,
				activeVaultId: vault.id,
				vaults: [{ id: vault.id, name: vault.name, count: noteCount }],
				noteCount,
				tree,
				library,
				libraryCount: countLeaves(library),
				links,
				tags,
				indexState: 'ready',
			};
		} catch (err) {
			this._logService.warn('[KB-React] 构建知识库数据失败', err);
			return empty;
		}
	}

	/** 递归列目录（只收 `.md` 与子目录；跳过点开头项，避免把 `.obsidian` 之类扫进来）。 */
	private async _walkChildren(dir: URI, relPrefix: string, depth: number): Promise<KbTreeNode[]> {
		if (depth >= MAX_TREE_DEPTH) { return []; }
		let stat;
		try {
			stat = await this._fileService.resolve(dir);
		} catch {
			return [];   // 目录不存在 / 无权限 ⇒ 当作空（不抛，避免整个视图挂掉）
		}

		const out: KbTreeNode[] = [];
		for (const child of stat.children ?? []) {
			if (child.name.startsWith('.')) { continue; }
			const rel = `${relPrefix}/${child.name}`;
			if (child.isDirectory) {
				const grandchildren = await this._walkChildren(child.resource, rel, depth + 1);
				out.push({
					name: child.name,
					path: rel,
					isFolder: true,
					count: countLeaves(grandchildren),
					children: grandchildren,
				});
			} else {
				const lower = child.name.toLowerCase();
				const ext = lower.includes('.') ? lower.split('.').pop()! : '';
				if (!VIEWABLE_EXTS.has(ext)) { continue; }
				// 笔记类去掉扩展名（树里更清爽，与 IDE sideview 一致）；其他类型**保留后缀**，
				// 因为「同名不同类」在库里很常见（x.canvas / x.pdf），去掉就分不清了
				const isNote = ext === 'md' || ext === 'markdown';
				out.push({
					name: isNote ? child.name.replace(/\.(md|markdown)$/i, '') : child.name,
					path: rel, isFolder: false, size: child.size, mtime: child.mtime,
				});
			}
		}
		// 目录在前、同类按名字排（与 IDE sideview 的默认排序一致）
		out.sort((a, b) => (a.isFolder === b.isFolder ? a.name.localeCompare(b.name, 'zh') : (a.isFolder ? -1 : 1)));
		return out;
	}

	/**
	 * 全文检索（2026-10-23）：**扫盘 + 子串匹配**，不用 `KbFullTextIndex`。
	 *
	 * 为什么不用那个索引：它要 worker + 全量内存索引（`knowledgeBaseView` 里是 5000 行的重装备），
	 * 而侧栏只做"输入框里敲词、给前 20 条"这一件事。102 篇 md 直接读一遍 ≈ 几十 ms，比拉 worker 便宜 ✓。
	 * ⚠ 命中路径返回 `笔记/…`（与树的 path 同一命名空间）⇒ 组件点结果直接 `openNode` 即可 ✓。
	 */
	private async _searchNotes(notesDir: URI, query: string, limit = 20): Promise<{ title: string; path: string; snippet: string }[]> {
		const q = query.trim().toLowerCase();
		if (!q) { return []; }
		const hits: { title: string; path: string; snippet: string }[] = [];
		const walk = async (dir: URI, prefix: string): Promise<void> => {
			if (hits.length >= limit) { return; }
			const stat = await this._fileService.resolve(dir, { resolveMetadata: false }).catch(() => undefined);
			if (!stat?.children) { return; }
			for (const child of stat.children) {
				if (hits.length >= limit) { return; }
				if (child.name.startsWith('.')) { continue; }
				if (child.isDirectory) { await walk(child.resource, `${prefix}${child.name}/`); continue; }
				if (!child.name.toLowerCase().endsWith('.md')) { continue; }
				const text = (await this._fileService.readFile(child.resource).catch(() => undefined))?.value.toString() ?? '';
				const at = text.toLowerCase().indexOf(q);
				if (at < 0) { continue; }
				hits.push({
					title: child.name.replace(/\.md$/i, ''),
					path: `${prefix}${child.name}`,
					snippet: text.slice(Math.max(0, at - 30), at + 70).replace(/\s+/g, ' ').trim(),
				});
			}
		};
		await walk(notesDir, '笔记/');
		return hits;
	}

	/**
	 * 标签聚合：读 `<vault>/.kbkernel.json` 的 `docs[].tags`。
	 *
	 * 为什么不走 `KbFullTextIndex`（IDE 侧那个）：它需要 worker + 内存索引，
	 * 而这里只需要「标签 → 篇数」这一层聚合，读一次 kernel 缓存最省。
	 * ⚠ kernel 缺失/损坏时**返回空数组**（UI 会退化成没有标签区，不报错）。
	 */
	private async _readTags(vault: { readonly path: string }): Promise<{ tag: string; count: number }[]> {
		try {
			const kernelUri = URI.joinPath(URI.file(vault.path), '.kbkernel.json');
			const raw = (await this._fileService.readFile(kernelUri)).value.toString();
			const parsed = JSON.parse(raw) as { docs?: readonly { tags?: readonly string[] }[] };
			const counts = new Map<string, number>();
			for (const doc of parsed.docs ?? []) {
				for (const tag of doc.tags ?? []) {
					const key = String(tag).trim();
					if (key) { counts.set(key, (counts.get(key) ?? 0) + 1); }
				}
			}
			return [...counts.entries()]
				.map(([tag, count]) => ({ tag, count }))
				.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh'))
				// ★ 2026-10-23：原来只给前 30 个，而真库有 198 个标签 ⇒ 渲染出来和 IDE sideview
				//   差一大截（用户看到的就是"标签少了一堆"）。组件侧已改为**分组 + 可折叠 + 可筛选**，
				//   所以这里给足（300 足够覆盖现实规模，同时不至于把一个大库全塞进注入 JSON）。
				.slice(0, 300);
		} catch {
			return [];
		}
	}

	// ── bundle 定位与读取（与 `kbBlocksEditorPane` 同口径）─────────────────────

	private _mediaCandidates(): URI[] {
		const appRoot = this._environmentService.appRoot;
		const segments = ['vs', 'sessions', 'contrib', 'agentStudio', 'webview', 'media'];
		// 优先 `src`：esbuild 的输出目标就是源码树里的 media/（本地始终最新）；打包产物回落 `out`。
		return [
			URI.joinPath(URI.file(appRoot), 'src', ...segments),
			URI.joinPath(URI.file(appRoot), 'out', ...segments),
		];
	}

	private async _resolveMediaUri(): Promise<URI | undefined> {
		for (const uri of this._mediaCandidates()) {
			try {
				await this._fileService.stat(URI.joinPath(uri, BUNDLE_JS));
				return uri;
			} catch {
				// try next
			}
		}
		return undefined;
	}

	private async _readBundle(mediaUri: URI): Promise<{ js: string; css: string }> {
		const key = mediaUri.toString();
		if (this._bundleCache?.key === key) {
			return { js: this._bundleCache.js, css: this._bundleCache.css };
		}

		let js = '';
		let css = '';
		try {
			js = (await this._fileService.readFile(URI.joinPath(mediaUri, BUNDLE_JS))).value.toString();
		} catch (err) {
			this._logService.warn(`[KB-React] 读取 ${BUNDLE_JS} 失败`, err);
		}
		try {
			css = (await this._fileService.readFile(URI.joinPath(mediaUri, BUNDLE_CSS))).value.toString();
		} catch {
			// 组件目前全用 inline style ⇒ 没有 css 文件是正常情况
		}

		this._bundleCache = { key, js, css };
		return { js, css };
	}

	private _getHtml(js: string, css: string, nonce: string, data: KbSideviewPayload): string {
		const styleTag = css ? `<style nonce="${nonce}">${css}</style>` : '';
		// `<` 转义成 \\u003c：笔记名里出现 `</script>` 时内联脚本会被 HTML 解析器提前截断
		const dataJson = JSON.stringify(data).replace(/</g, '\\u003c');
		return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body{height:100%;margin:0;padding:0;overflow:hidden}</style>
${styleTag}
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
// ── 数据由宿主注入（组件不做任何 IO）──
window.__KB_SIDEVIEW_DATA__ = ${dataJson};
// ── 动作桥：组件只发消息，由本 Pane 决定怎么执行（IDE 走命令 / 插件页走 HTTP）──
// 检索结果回推通道：宿主 postMessage({type:'searchResults', requestId, items}) ⇒ 兑现对应 Promise
const PENDING_SEARCH = {};
window.addEventListener('message', ev => {
	const m = ev.data;
	if (m && m.type === 'searchResults' && m.requestId && PENDING_SEARCH[m.requestId]) {
		PENDING_SEARCH[m.requestId](Array.isArray(m.items) ? m.items : []);
		delete PENDING_SEARCH[m.requestId];
	}
});
window.__KB_SIDEVIEW_ACTIONS__ = {
	openNode: p => acquireVsCodeApi().postMessage({ type: 'openNode', path: p }),
	refresh: () => acquireVsCodeApi().postMessage({ type: 'refresh' }),
	openGraph: () => acquireVsCodeApi().postMessage({ type: 'openGraph' }),
	openSettings: () => acquireVsCodeApi().postMessage({ type: 'openSettings' }),
	switchVault: id => acquireVsCodeApi().postMessage({ type: 'switchVault', id }),
	// 全文检索是**双向**的：发消息带 requestId，宿主回推 searchResults 时按 id 兑现 Promise。
	// 插件页那边是 fetch（同源、天然异步）⇒ 组件只依赖"返回 Promise"这一条契约 ✓。
	search: (q, m) => new Promise(resolve => {
		const api = acquireVsCodeApi();
		const requestId = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
		PENDING_SEARCH[requestId] = resolve;
		api.postMessage({ type: 'search', query: q, mode: m, requestId });
		// 8s 兜底：宿主没回就把 Promise 兑成空结果，避免 pending 永久泄漏
		setTimeout(() => { if (PENDING_SEARCH[requestId]) { PENDING_SEARCH[requestId]([]); delete PENDING_SEARCH[requestId]; } }, 8000);
	}),
	pickTag: t => acquireVsCodeApi().postMessage({ type: 'pickTag', tag: t }),
	openLink: p => acquireVsCodeApi().postMessage({ type: 'openLink', path: p }),
	moveNodes: (paths, to) => acquireVsCodeApi().postMessage({ type: 'moveNode', paths, toPath: to }),
	deleteNodes: paths => acquireVsCodeApi().postMessage({ type: 'deleteNodes', paths }),
	// 思维导图的生成/打开逻辑只有一份（KbMindmapGenerator + canvas 编辑器），这里只转发
	openMindmap: () => acquireVsCodeApi().postMessage({ type: 'openMindmap' }),
	// 体检：规则/报告只有一份（kbLint），这里仅转发
	runLint: () => acquireVsCodeApi().postMessage({ type: 'runLint' }),
	runDedup: () => acquireVsCodeApi().postMessage({ type: 'runDedup' }),
	reviewQueue: () => acquireVsCodeApi().postMessage({ type: 'reviewQueue' }),
};
</script>
<script nonce="${nonce}">${js}</script>
</body>
</html>`;
	}
}

/** 统计树里的**叶子**（笔记）数。 */
function countLeaves(nodes: readonly KbTreeNode[]): number {
	let n = 0;
	for (const node of nodes) {
		if (node.isFolder) { n += countLeaves(node.children ?? []); }
		else { n += 1; }
	}
	return n;
}
