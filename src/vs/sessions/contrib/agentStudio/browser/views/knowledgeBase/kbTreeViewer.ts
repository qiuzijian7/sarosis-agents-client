/*---------------------------------------------------------------------------------------------
 *  KbTreeViewer — 知识库原生树组件（DataSource / Delegate / Renderer / Filter / Sorter / A11y）
 *
 *  使用 VS Code WorkbenchCompressibleAsyncDataTree，支持：
 *  - 键盘导航（方向键/Enter/Home/End/F2）
 *  - 文件图标主题（ResourceLabels）
 *  - 原生右键菜单（IContextMenuService）
 *  - 懒加载子节点
 *  - 14 种排序模式
 *  - 搜索过滤
 *  - ARIA 无障碍
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../../../base/common/uri.js';
import { IListVirtualDelegate } from '../../../../../../base/browser/ui/list/list.js';
import { IListAccessibilityProvider } from '../../../../../../base/browser/ui/list/listWidget.js';
import { IAsyncDataSource, ITreeNode, ITreeFilter, ITreeSorter } from '../../../../../../base/browser/ui/tree/tree.js';
import { ICompressibleTreeRenderer } from '../../../../../../base/browser/ui/tree/objectTree.js';
import { ICompressedTreeNode } from '../../../../../../base/browser/ui/tree/compressedObjectTreeModel.js';
import { FuzzyScore } from '../../../../../../base/common/filters.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { dirname, isEqual, joinPath } from '../../../../../../base/common/resources.js';
import { localize } from '../../../../../../nls.js';
import { IFileService } from '../../../../../../platform/files/common/files.js';
import { IDragAndDropData } from '../../../../../../base/browser/dnd.js';
import { ITreeDragAndDrop, TreeDragOverReactions } from '../../../../../../base/browser/ui/tree/tree.js';
import { ListViewTargetSector } from '../../../../../../base/browser/ui/list/listView.js';
import { IKbNode, KbSection, KbSortMode } from './kbTypes.js';
import { getStatus } from '../../knowledge/frontmatter.js';

// ─── Section 包装节点（树根的直接子节点）──────────────────────────────

export interface IKbTreeSection {
	readonly kind: 'section';
	readonly section: KbSection;
	readonly label: string;
	readonly uri: URI;
}

export type KbTreeElement = IKbTreeSection | IKbNode;

// ─── Delegate ──────────────────────────────────────────────────────────

export class KbTreeDelegate implements IListVirtualDelegate<KbTreeElement> {
	static readonly ITEM_HEIGHT = 22;
	getHeight(): number { return KbTreeDelegate.ITEM_HEIGHT; }
	getTemplateId(e: KbTreeElement): string {
		return isSection(e) ? KbSectionRenderer.TEMPLATE_ID : KbNodeRenderer.TEMPLATE_ID;
	}
}

// ─── Helpers ───────────────────────────────────────────────────────────

function isSection(e: KbTreeElement): e is IKbTreeSection {
	return (e as IKbTreeSection).kind === 'section';
}

// ─── Section Renderer ──────────────────────────────────────────────────

interface ISectionTemplate {
	label: HTMLSpanElement;
	container: HTMLElement;
	disposables: DisposableStore;
}

export class KbSectionRenderer implements ICompressibleTreeRenderer<IKbTreeSection, FuzzyScore, ISectionTemplate> {
	static readonly TEMPLATE_ID = 'kb.section';
	readonly templateId = KbSectionRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): ISectionTemplate {
		container.classList.add('kb-section-node');
		const label = document.createElement('span');
		label.classList.add('kb-section-label');
		container.appendChild(label);
		return { label, container, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<IKbTreeSection, FuzzyScore>, _index: number, t: ISectionTemplate): void {
		t.label.textContent = node.element.label;
	}

	renderCompressedElements(): void { /* no compression for sections */ }
	disposeTemplate(t: ISectionTemplate): void { t.disposables.dispose(); }
}


// ─── File / Folder Renderer ────────────────────────────────────────────

interface IKbNodeTemplate {
	icon: HTMLSpanElement;
	label: HTMLSpanElement;
	meta: HTMLSpanElement;
	badge: HTMLSpanElement;
	container: HTMLElement;
	disposables: DisposableStore;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) { return `${bytes}B`; }
	if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)}KB`; }
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function formatMtime(ts: number): string {
	if (!ts) { return ''; }
	const now = Date.now();
	const diffMs = now - ts;
	if (diffMs < 60_000) { return '刚刚'; }
	if (diffMs < 3600_000) { return `${Math.floor(diffMs / 60_000)}分钟前`; }
	if (diffMs < 86400_000) { return `${Math.floor(diffMs / 3600_000)}小时前`; }
	if (diffMs < 172800_000) { return '昨天'; }
	if (diffMs < 604800_000) { return `${Math.floor(diffMs / 86400_000)}天前`; }
	return `${Math.floor(diffMs / 604800_000)}周前`;
}

export class KbNodeRenderer implements ICompressibleTreeRenderer<KbTreeElement, FuzzyScore, IKbNodeTemplate> {
	static readonly TEMPLATE_ID = 'kb.node';
	readonly templateId = KbNodeRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IKbNodeTemplate {
		container.classList.add('kb-tree-node');
		const icon = document.createElement('span');
		icon.classList.add('kb-icon');
		container.appendChild(icon);
		const label = document.createElement('span');
		label.classList.add('kb-name');
		container.appendChild(label);
		const meta = document.createElement('span');
		meta.classList.add('kb-meta');
		meta.style.display = 'none';
		container.appendChild(meta);
		const badge = document.createElement('span');
		badge.classList.add('kb-pending-badge');
		badge.textContent = '⏳';
		badge.style.display = 'none';
		container.appendChild(badge);
		return { icon, label, meta, badge, container, disposables: new DisposableStore() };
	}

	renderElement(node: ITreeNode<KbTreeElement, FuzzyScore>, _index: number, t: IKbNodeTemplate): void {
		const n = node.element as IKbNode;
		// 图标
		if (n.isDirectory) {
			t.icon.textContent = node.collapsed ? '📁' : '📂';
			t.icon.style.opacity = '1';
		} else {
			t.icon.textContent = '📄';
			t.icon.style.opacity = '0.6';
		}
		t.label.textContent = n.name;
		// P0: 元数据行：文件夹显示子文件数，文件显示大小 + 修改时间
		if (n.isDirectory) {
			const count = n.childCount;
			t.meta.textContent = count > 0 ? `${count}项` : '';
			t.meta.style.display = count > 0 ? '' : 'none';
			t.label.title = n.path;
		} else {
			const parts: string[] = [];
			if (n.size > 0) { parts.push(formatSize(n.size)); }
			if (n.mtime > 0) { parts.push(formatMtime(n.mtime)); }
			t.meta.textContent = parts.length > 0 ? parts.join(' · ') : '';
			t.meta.style.display = parts.length > 0 ? '' : 'none';
			t.label.title = n.path +
				(n.size > 0 ? `\n大小: ${formatSize(n.size)}` : '') +
				(n.mtime > 0 ? `\n修改: ${new Date(n.mtime).toLocaleString()}` : '');
		}
		// P0-1 去抽象化门控：pending 笔记灰显 + ⏳ 徽标
		const pending = n.status === 'pending';
		t.container.classList.toggle('kb-pending', pending);
		t.badge.style.display = pending ? '' : 'none';
		if (pending) {
			t.badge.title = '待确认：该笔记目前仅有单一来源提及，被第二个来源确认后自动转正';
			t.label.title = `${n.path}（待确认 · 单一来源）`;
		}
	}

	renderCompressedElements(node: ITreeNode<ICompressedTreeNode<KbTreeElement>, FuzzyScore>, _index: number, t: IKbNodeTemplate): void {
		const filtered = node.element.elements.filter((e): e is IKbNode => !isSection(e));
		const names = filtered.map(e => e.name);
		t.icon.textContent = '📁';
		t.icon.style.opacity = '1';
		t.label.textContent = names.join('/');
		t.label.title = filtered.map(e => e.path).join(' → ');
		t.meta.textContent = '';
		t.meta.style.display = 'none';
		t.badge.style.display = 'none';
		t.container.classList.remove('kb-pending');
	}
	disposeTemplate(t: IKbNodeTemplate): void { t.disposables.dispose(); }
	disposeElement?(_node: ITreeNode<KbTreeElement, FuzzyScore>, _index: number, _t: IKbNodeTemplate): void { /* optional */ }
}


// ─── Data Source ───────────────────────────────────────────────────────

export class KbTreeDataSource implements IAsyncDataSource<null, KbTreeElement> {
	constructor(
		private readonly fileService: IFileService,
		private readonly getSections: () => { libraryUri: URI; notesUri: URI },
		private readonly getSortMode: () => KbSortMode,
	) { }

	hasChildren(e: null | KbTreeElement): boolean {
		if (e === null) { return true; } // 根有子（两个 section）
		if (isSection(e)) { return true; } // section 有子
		return e.isDirectory; // IKbNode
	}

	async getChildren(e: null | KbTreeElement): Promise<KbTreeElement[]> {
		if (e === null) {
			const { libraryUri, notesUri } = this.getSections();
			return [
				{ kind: 'section' as const, section: 'library' as const, label: '库', uri: libraryUri },
				{ kind: 'section' as const, section: 'notes' as const, label: '笔记', uri: notesUri },
			];
		}
		if (isSection(e)) {
			return this._loadChildren(e.uri, e.section);
		}
		return this._loadChildren(e.uri, e.section);
	}

	private async _loadChildren(uri: URI, section: KbSection): Promise<IKbNode[]> {
		try {
			let stat = await this.fileService.resolve(uri);
			if (!stat.children || stat.children.length === 0) { return []; }

			// 过滤隐藏文件
			const nodes: IKbNode[] = stat.children
				.filter(c => !c.name.startsWith('.'))
				.map(c => ({
					name: c.name,
					path: c.resource.fsPath,
					uri: c.resource,
					isDirectory: c.isDirectory,
					section,
					size: c.size ?? 0,
					mtime: c.mtime ?? 0,
					ctime: c.ctime ?? 0,
					childCount: c.children?.length ?? 0,
				}));
			// P0-1 去抽象化门控：读取 .md 笔记的 status frontmatter（pending → 树中灰显）
			await Promise.all(nodes
				.filter(n => !n.isDirectory && n.name.toLowerCase().endsWith('.md') && n.size < 256 * 1024)
				.map(async n => {
					try {
						const content = (await this.fileService.readFile(n.uri)).value.toString();
						n.status = getStatus(content);
					} catch { /* 读取失败按 active 处理 */ }
				}));
			return this._sortNodes(nodes);
		} catch {
			return [];
		}
	}

	private _sortNodes(nodes: IKbNode[]): IKbNode[] {
		const dirs = nodes.filter(n => n.isDirectory);
		const files = nodes.filter(n => !n.isDirectory);
		const mode = this.getSortMode();
		const cmp = (a: IKbNode, b: IKbNode): number => {
			switch (mode) {
				case 'fileNameASC': return a.name.localeCompare(b.name);
				case 'fileNameDESC': return b.name.localeCompare(a.name);
				case 'fileNameNatASC': return naturalCompare(a.name, b.name);
				case 'fileNameNatDESC': return naturalCompare(b.name, a.name);
				case 'createdASC': return a.ctime - b.ctime;
				case 'createdDESC': return b.ctime - a.ctime;
				case 'modifiedASC': return a.mtime - b.mtime;
				case 'modifiedDESC': return b.mtime - a.mtime;
				case 'docSizeASC': return a.size - b.size;
				case 'docSizeDESC': return b.size - a.size;
				case 'subDocCountASC': return a.childCount - b.childCount;
				case 'subDocCountDESC': return b.childCount - a.childCount;
				case 'refCountASC': return 0;  // 引用数排序需独立实现
				case 'refCountDESC': return 0;
				default: return a.name.localeCompare(b.name);
			}
		};
		return [...dirs.sort(cmp), ...files.sort(cmp)];
	}
}

// ─── Filter ────────────────────────────────────────────────────────────

export type KbSearchMode = 'fulltext' | 'filename';

export class KbTreeFilter implements ITreeFilter<KbTreeElement> {
	constructor(
		private readonly getSearchQuery: () => string,
		private readonly getSearchMode: () => KbSearchMode,
	) { }

	filter(e: KbTreeElement): boolean {
		const q = this.getSearchQuery();
		const mode = this.getSearchMode();
		// fulltext 模式：不过滤树节点，搜索结果显示在独立面板中
		if (!q || mode === 'fulltext') { return true; }
		if (isSection(e)) { return true; } // 搜索时始终显示 section
		return e.name.toLowerCase().includes(q.toLowerCase());
	}
}

// ─── Sorter ────────────────────────────────────────────────────────────

export class KbTreeSorter implements ITreeSorter<KbTreeElement> {
	compare(a: KbTreeElement, b: KbTreeElement): number {
		// Section 保持固定顺序：library → notes
		if (isSection(a) && isSection(b)) { return a.section === 'library' ? -1 : 1; }
		if (isSection(a)) { return -1; }
		if (isSection(b)) { return 1; }
		// 文件和文件夹排序由 DataSource 中的 _sortNodes 处理
		return 0;
	}
}

// ─── Accessibility Provider ────────────────────────────────────────────

export class KbTreeAccessibilityProvider implements IListAccessibilityProvider<KbTreeElement> {
	getWidgetAriaLabel(): string { return localize('kbAria', "Knowledge Base"); }
	getAriaLabel(e: KbTreeElement): string {
		if (isSection(e)) { return `分区 ${e.label}`; }
		return e.isDirectory ? `文件夹 ${e.name}` : `文件 ${e.name}`;
	}
}

// ─── Identity Provider ─────────────────────────────────────────────────

export function kbTreeIdentityProvider(): { getId(e: KbTreeElement): string } {
	return {
		getId(e: KbTreeElement): string {
			if (isSection(e)) { return `section:${e.section}`; }
			return e.path;
		},
	};
}

// ─── Natural sort helper ───────────────────────────────────────────────

function naturalCompare(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// ─── 拖拽移动（DnD）─────────────────────────────────────────────────────

/**
 * 知识库树拖拽移动：把文件/文件夹拖到「分区根」或「目录」节点上，即移动到该目标目录下。
 * 分区节点不可作为被拖拽对象（getDragURI 返回 null）。
 * 安全护栏：禁止移动到自身或子孙目录、禁止移动到当前所在目录（无操作）、同名目标跳过防覆盖。
 */
export class KbTreeDragAndDrop implements ITreeDragAndDrop<KbTreeElement> {

	constructor(
		private readonly fileService: IFileService,
		private readonly getSectionUri: (section: KbSection) => URI,
		private readonly onDidMove: () => void | Promise<void>,
	) { }

	getDragURI(element: KbTreeElement): string | null {
		if (isSection(element)) { return null; }
		return element.uri.toString();
	}

	onDragStart(_data: IDragAndDropData, _originalEvent: DragEvent): void {
		// 无需处理
	}

	onDragOver(
		data: IDragAndDropData,
		target: KbTreeElement | undefined,
		_targetIndex: number | undefined,
		_targetSector: ListViewTargetSector | undefined,
		_originalEvent: DragEvent,
	): boolean | import('../../../../../../base/browser/ui/tree/tree.js').ITreeDragOverReaction {
		const dragged = this._draggedNodes(data);
		if (!dragged.length || !target) { return false; }
		if (isSection(target)) {
			return TreeDragOverReactions.acceptBubbleDown();
		}
		if (target.isDirectory) {
			// 禁止移动到自身、自身子孙目录，或「目标在拖动项内部」的情况
			if (dragged.some(d =>
				isEqual(d.uri, target.uri, false)
				|| this._isDescendant(d, target.uri)   // 拖动项已在目标内
				|| this._isDescendant({ uri: target.uri } as IKbNode, d.uri), // 目标在拖动项内
			)) {
				return false;
			}
			return TreeDragOverReactions.acceptBubbleDown();
		}
		return false;
	}

	async drop(
		data: IDragAndDropData,
		target: KbTreeElement | undefined,
		_targetIndex: number | undefined,
		_targetSector: ListViewTargetSector | undefined,
		_originalEvent: DragEvent,
	): Promise<void> {
		const dragged = this._draggedNodes(data);
		if (!dragged.length || !target) { return; }
		let targetDir: URI;
		if (isSection(target)) {
			targetDir = this.getSectionUri(target.section);
		} else if (target.isDirectory) {
			targetDir = target.uri;
		} else {
			return;
		}
		const moving = dragged.filter(d =>
			!isEqual(d.uri, targetDir, false)
			&& !this._isDescendant(d, targetDir)
			&& !this._isDescendant({ uri: targetDir } as IKbNode, d.uri) // 目标在拖动项内 → 跳过
			&& !isEqual(dirname(d.uri), targetDir, false), // 已在目标目录则跳过
		);
		if (!moving.length) { return; }
		for (const d of moving) {
			try {
				const dest = joinPath(targetDir, d.name);
				if (await this.fileService.exists(dest)) { continue; } // 同名目标存在则跳过，避免覆盖
				await this.fileService.move(d.uri, dest, false);
			} catch {
				// 单个移动失败不中断其余项
			}
		}
		await this.onDidMove();
	}

	onDragEnd(_originalEvent: DragEvent): void {
		// 无需处理
	}

	dispose(): void {
		// 无资源需释放
	}

	private _draggedNodes(data: IDragAndDropData): IKbNode[] {
		const raw = data.getData();
		const arr = (Array.isArray(raw) ? raw : (raw ? [raw] : [])) as KbTreeElement[];
		return arr.filter((e): e is IKbNode => !!e && !isSection(e));
	}

	private _isDescendant(node: IKbNode, dirUri: URI): boolean {
		const np = node.uri.path;
		const dp = dirUri.path;
		return np.startsWith(dp + '/') || np.startsWith(dp + '\\');
	}
}
