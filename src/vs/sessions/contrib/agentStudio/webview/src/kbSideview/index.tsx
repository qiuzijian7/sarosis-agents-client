/*
 * 知识库侧栏（KB sideview）—— React 版。
 *
 * 目标：与 IDE 侧 `KnowledgeBaseViewPane`（5030 行，VS Code 原生 DOM）**布局与交互一致**，
 * 但渲染层换成 React，从而让「IDE 侧栏」与「agents 窗口插件页」能复用同一份 UI 代码。
 *
 * 本阶段的边界（重要）：
 *   - **只做展示层**：树 / 搜索行 / 标签 / 双链 / 库栏。写操作（新建/改名/删除/移动）先只发出
 *     `postMessage` 事件，由宿主决定怎么执行 —— 这样 IDE 侧可以接 `IKbCommandService`，
 *     dsh 插件页可以接 `/x/kb/api/*`，同一份 UI 两种后端 ✓。
 *   - **不碰数据源**：数据由宿主注入 `window.__KB_SIDEVIEW_DATA__`（见下面 KbSideviewData），
 *     UI 不做任何 IO。这样它可以被单测，也能在 `visual` 页面里用假数据跑起来。
 *
 * 视觉约定：颜色一律走 `--vscode-*` 变量（webview / 原生 DOM 两侧都有），
 * 回退值用 VS Code Dark+ 的等价色 ⇒ 单独打开也不会难看。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { continueMarkdownList, indentAt } from './mdList';
import { createRoot } from 'react-dom/client';

// ─── 数据契约（宿主注入）─────────────────────────────────────────────────────

export interface KbTreeNode {
	readonly name: string;
	readonly path: string;
	readonly isFolder: boolean;
	readonly count?: number;
	/** 文件字节数（IDE sideview 与旧插件页都显示，用于判断"是不是空壳"） */
	readonly size?: number;
	/** 修改时间（ms）；排序用，缺失时按 0 处理 */
	readonly mtime?: number;
	readonly children?: readonly KbTreeNode[];
}

/** 人类可读大小（`1.0 KB` / `320 B`）—— 与旧插件页 `sizeText` 同口径 */
function sizeText(n?: number): string {
	if (n === undefined || Number.isNaN(n)) { return ''; }
	if (n < 1024) { return `${n} B`; }
	if (n < 1024 * 1024) { return `${(n / 1024).toFixed(1)} KB`; }
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface KbTag {
	readonly tag: string;
	readonly count: number;
	/**
	 * 该标签下的笔记路径（**绝对、正斜杠、小写**）。
	 * dsh 侧由 `/api/view-data` 给出（服务端统一归一化）；IDE 侧可能不提供 ⇒
	 * 那种情况下点标签只做高亮，不筛树（能力缺失要可见，而不是静默无效）。
	 */
	readonly paths?: readonly string[];
}

export interface KbLinkRef {
	readonly title: string;
	readonly path: string;
}

export interface KbSideviewData {
	readonly vaultName: string;
	readonly vaults: readonly { readonly id: string; readonly name: string; readonly count: number }[];
	readonly activeVaultId?: string;
	readonly noteCount: number;
	readonly tree: readonly KbTreeNode[];
	/**
	 * 「库」区（原料/资料）——与「笔记」区并列，对齐 IDE sideview 的两节结构。
	 * 之前只渲染了笔记树，而 IDE 侧栏一直是「库 + 笔记」两节，这是最大的结构差异。
	 */
	readonly library?: readonly KbTreeNode[];
	readonly libraryCount?: number;
	readonly tags: readonly KbTag[];
	readonly untaggedCount?: number;
	readonly outLinks?: readonly KbLinkRef[];
	readonly inLinks?: readonly KbLinkRef[];
	/**
	 * 全量双链索引（2026-10-23）：`key = 节点 path`（与树的 path 同一命名空间）。
	 *
	 * 为什么是"全量注入"而不是"选中后再问宿主"：选中态在组件本地（`selected`），宿主看不见；
	 * 若每次点击都回问宿主，宿主只能整页重挂（数据是挂载时注入的）⇒ 闪一下且丢失树的展开状态 ✗。
	 * 一份 100 篇笔记的索引只有几 KB，直接注入、本地查表最省 ✓。
	 */
	readonly links?: Readonly<Record<string, { readonly out?: readonly KbLinkRef[]; readonly in?: readonly KbLinkRef[] }>>;
	/** 索引状态，用于底栏文案（`indexing` 时显示转圈） */
	readonly indexState?: 'ready' | 'indexing' | 'stale';
	/** 当前选中节点（用于高亮 + 双链面板取数） */
	readonly selectedPath?: string;
}

/**
 * 搜索结果高亮（2026-10-26，P3）：把命中词包成 `<mark>`。
 *
 * 为什么在前端做而不是服务端返回 HTML：结果列表要能点、要能被 React 复用，
 * 塞 HTML 就得 dangerousSetInnerHTML（又多一个注入口）。这里只做字符串切片，零风险。
 * 大小写不敏感；单条最多标 20 处（避免超长片段把 DOM 撑大）。
 */
function highlightMatch(text: string, query: string): React.ReactNode {
	const src = String(text ?? '');
	const q = String(query ?? '').trim();
	if (!q) { return src; }
	const lower = src.toLowerCase();
	const needle = q.toLowerCase();
	const out: React.ReactNode[] = [];
	let from = 0;
	let n = 0;
	while (n < 20) {
		const at = lower.indexOf(needle, from);
		if (at < 0) { break; }
		if (at > from) { out.push(src.slice(from, at)); }
		out.push(
			<mark key={'m' + n} style={{ background: 'rgba(255,204,0,.30)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>
				{src.slice(at, at + needle.length)}
			</mark>,
		);
		from = at + needle.length;
		n += 1;
	}
	out.push(src.slice(from));
	return out;
}

/**

/** 宿主可以监听这些事件；未接线时是 no-op。 */
/** 全文检索命中（`path` 与树的 path 同一命名空间，可直接 `openNode`） */
export interface KbSearchHit {
	readonly title: string;
	readonly path: string;
	readonly snippet?: string;
}

export interface KbSideviewActions {
	openNode?(path: string): void;
	refresh?(): void;
	openGraph?(): void;

	/**
	 * 能力位：宿主服务端有 `/api/canvas` ⇒ 视图**自己**渲染导图（2026-10-25 起三端统一）。
	 * 用能力位而不是动作：动作只能"请宿主去画"，而绘制实现已经在视图里了。
	 */
	canvas?: boolean;
	/** 打开站外链接（面板/页面：window.open；被拦时复制链接并提示）。缺省则视图自己 window.open */
	openUrl?(url: string): void;
	/**
	 * 在系统文件管理器里定位某个文件（2026-10-26）。
	 * 缺省时视图**不显示**该菜单项 —— 宁可不给，也不放一个点了没反应的按钮。
	 */
	reveal?(path: string): void;
	openSettings?(): void;
	/** 同步飞书（只在宿主真能执行时提供 —— 面板走 `/api/feishu-sync`，IDE 侧栏走命令桥） */
	feishuSync?(): void;
	/** 切换当前库（dsh 面板 / 插件页：重新取一次数据；IDE 侧栏由宿主切） */
	switchVault?(id: string): void;
	/**
	 * 新建 / 载入库。
	 * `create`：只给名字，宿主在自己那边建一个空库；
	 * `attach`：给已有文件夹的**绝对路径**（不移动、不复制文件）。
	 */
	addVault?(mode: 'create' | 'attach', path?: string, name?: string): void;
	/**
	 * 把一个库**从列表移除**（2026-10-28 用户要求：下拉每项要有删除按钮）。
	 *
	 * 语义约定：只摘登记，**不动磁盘**（外部库是用户的真实笔记目录）；
	 * 真正删目录的旧接口（`/api/vault-delete`）不能用在这里。
	 * 宿主若没提供 ⇒ 不渲染删除按钮（不给出会失败的入口）。
	 */
	removeVault?(vaultId: string): void;
	/**
	 * 打开**系统文件夹选择器**，返回绝对路径（用户取消 ⇒ `null`/空串）。
	 *
	 * 为什么要宿主来做：Electron 32+ 移除了 `File.path`，页面里的
	 * `<input type="file" webkitdirectory>` 只能拿到**相对路径**
	 * ⇒ 无法作为 vault 的绝对目录。只有原生对话框能给绝对路径。
	 */
	pickFolder?(): Promise<string | null> | string | null;

	switchVault?(vaultId: string): void;
	/**
	 * 检索。`mode='fulltext'` 时**返回 Promise<结果>** 才算支持全文检索：
	 * 返回 undefined/抛错 ⇒ 组件退回"按名过滤"（不显示假的空结果 ✗）。
	 */
	search?(query: string, mode: 'fulltext' | 'filename'): void | Promise<readonly KbSearchHit[] | undefined>;
	pickTag?(tag: string): void;
	openLink?(path: string): void;
	/** 拖拽移动（支持多选批量）：把 `fromPaths` 全部移到目录 `toFolderPath` 下（落盘由宿主做） */
	moveNodes?(fromPaths: readonly string[], toFolderPath: string): void;
	/** 体检（结构校验，产出 `lint-report.md`）。同样：宿主不提供就不显示按钮 */
	runLint?(): void;
	/** 整理去重（检测 + `dedup-report.md`；合并流程仍在经典视图里） */
	runDedup?(): void;
	/** 审核队列概览（只读；移回/清空仍在经典视图里） */
	reviewQueue?(): void;
	/**
	 * 写操作（2026-10-23 新增）。
	 *
	 * ⚠ 全部**不带具体表单**：组件只负责"用户点了新建/改名/删除"，弹输入框、决定落在哪、
	 *   是否覆盖 —— 都由宿主处理（IDE 侧走 `IFileService`，插件页走 `/api/new|rename|delete`）。
	 *   这样同一份 UI 不会被某一种后端的限制绑死（比如 Web 侧不能弹原生输入框）。
	 */
	createNote?(parentPath: string, name?: string): void;
	newFolder?(parentPath: string, name?: string): void;
	renameNode?(path: string, newName?: string): void;
	/**
	 * 取正文（插件页 / 工作台面板用）：有它 ⇒ 视图进入"内嵌阅读"模式（右栏显示正文）。
	 * IDE 侧栏**不提供** ⇒ 正文由编辑区打开，行为不变。
	 */
	loadDoc?(path: string): Promise<{
		title: string;
		text: string;
		/** 文档所在目录（绝对），图片相对路径要用它折算 */
		base?: string;
		/**
		 * **服务端已渲染好的 HTML**（dsh 侧由 markdown-it + Obsidian 方言生成）。
		 * 有它就直接注入并走事件委托；没有（IDE 侧）则回落到视图内手写渲染器。
		 */
		html?: string;
		/** 正文含公式 ⇒ 需要引入 `/x/kb/vendor/katex/katex.min.css` */
		math?: boolean;
		mtime?: number;
	} | null>;
	/**
	 * 把笔记里的**相对图片路径**折成可请求的 URL。
	 * dsh 侧实现为 `/x/kb/api/asset?uri=<绝对路径>`；IDE 侧不提供 ⇒ 图片退化成 alt 文字，不显示坏图。
	 */
	assetUrl?(absPath: string): string;
	/**
	 * 保存正文（dsh 侧行内编辑 / 任务清单勾选）。
	 * 宿主不提供 ⇒ 编辑器与勾选框都不出现（IDE 侧仍用编辑器改文件，能力差异可见）。
	 */
	saveDoc?(path: string, text: string, expectedMtime?: number): Promise<{
		ok: boolean; error?: string; conflict?: boolean; mtime?: number; backup?: string;
	} | undefined>;
	/**
	 * 上传附件（编辑器里粘贴 / 拖入图片）。`rel` 是相对当前文档的路径，可直接写进 `![]()`。
	 * 宿主不提供 ⇒ 粘贴/拖入不拦截（浏览器默认行为，不会莫名吞掉内容）。
	 */
	uploadAsset?(file: File, docPath: string): Promise<{ ok: boolean; rel?: string; abs?: string; error?: string } | undefined>;
	/** 列出某篇笔记的自动备份（保存时生成，仅 dsh 侧有） */
	listBackups?(path: string): Promise<{ ok: boolean; items?: { name: string; size: number; mtime: number }[]; error?: string } | undefined>;
	/** 恢复到某个备份（服务端会先把当前内容再备一份，因此恢复本身也可撤销） */
	restoreBackup?(path: string, name: string): Promise<{ ok: boolean; mtime?: number; bytes?: number; error?: string } | undefined>;
	/**
	 * 让视图自己弹改名/新建/删除确认对话框。
	 * 为什么需要：Electron 里 `window.prompt` **不可用**、`confirm` 不可靠 ⇒ 宿主侧弹不出来，
	 * 表现就是"点重命名没反应、点删除没反应"（2026-10-24 真机）。
	 */
	useInlineDialogs?: boolean;
	/** 批量删除（多选右键）：宿主只需**确认一次**，不要逐项弹框 */
	deleteNodes?(paths: readonly string[], skipConfirm?: boolean): void;
	deleteNode?(path: string): void;
}

declare global {
	interface Window {
		__KB_SIDEVIEW_DATA__?: KbSideviewData;
		__KB_SIDEVIEW_ACTIONS__?: KbSideviewActions;
	}
}

// ─── 主题 ──────────────────────────────────────────────────────────────────

const c = {
	bg: 'var(--vscode-sideBar-background, #252526)',
	fg: 'var(--vscode-sideBar-foreground, #cccccc)',
	fgDim: 'var(--vscode-descriptionForeground, #9d9d9d)',
	fgFaint: 'var(--vscode-disabledForeground, #6e7681)',
	line: 'var(--vscode-panel-border, #3c3c3c)',
	hover: 'var(--vscode-list-hoverBackground, #2a2d2e)',
	sel: 'var(--vscode-list-activeSelectionBackground, #094771)',
	selFg: 'var(--vscode-list-activeSelectionForeground, #ffffff)',
	accent: 'var(--vscode-focusBorder, #007acc)',
	link: 'var(--vscode-textLink-foreground, #3794ff)',
	inputBg: 'var(--vscode-input-background, #3c3c3c)',
	inputFg: 'var(--vscode-input-foreground, #cccccc)',
	badge: 'var(--vscode-badge-background, #4d4d4d)',
	badgeFg: 'var(--vscode-badge-foreground, #ffffff)',
	ok: 'var(--vscode-testing-iconPassed, #4ec9b0)',
} as const;

// ─── 小部件 ────────────────────────────────────────────────────────────────

const IconBtn = ({ title, label, onClick }: {
	title: string; label: string;
	/** 传 event 是为了让调用方 `stopPropagation`（例：节标题上的「＋」不能触发折叠） */
	onClick?: (e?: React.MouseEvent) => void;
}) => (
	<button
		type="button"
		title={title}
		aria-label={title}
		onClick={onClick}
		style={{
			width: 22, height: 22, display: 'grid', placeItems: 'center', border: 'none',
			borderRadius: 4, background: 'transparent', color: c.fgDim, cursor: 'pointer', fontSize: 13,
		}}
		onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = c.hover; }}
		onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
	>{label}</button>
);

/**
 * 图标一律用**内联 SVG**，不用 emoji。
 *
 * 为什么：webview 里的字体不一定含 emoji 字形（emoji 依赖 system emoji font），
 * 一旦缺失就渲染成方块 □ —— 而 SVG 走 `currentColor`，必然跟随主题且不会错位。
 * 这三个就是 VS Code 原生树里 folder / file / link 的等价形状。
 */
const Svg = ({ children, size = 13 }: { children: React.ReactNode; size?: number }) => (
	<svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style={{ flex: '0 0 auto', opacity: 0.9 }}>
		{children}
	</svg>
);

/**
 * 极小的 `.md` 文件字形（10×10，描边 1px）。
 * Obsidian 默认不给文件图标，但完全无名牌时 `.md` 与目录行难以区分；
 * 所以给 md 一个**极轻**的文档轮廓，非 md 仍用 4px 类型点（更醒目地区分 pdf/canvas/图片）。
 */
const MdIcon = () => (
	<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1"
		style={{ flex: '0 0 10px', opacity: .75 }}>
		<path d="M2.5 1.2h3.1L8 3.6v5.2H2.5z" />
		<path d="M5.6 1.2v2.4H8" />
	</svg>
);

const VaultIcon = () => (
	<Svg><path d="M3 2h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm1.5 2v8h7V4h-7z" /></Svg>
);

const SectionHeader = ({ title, count, expanded, onToggle, extra, onDropRoot }: {
	title: string; count?: string; expanded: boolean; onToggle: () => void; extra?: React.ReactNode;
	/**
	 * 拖到**节头**＝移到该区根目录（2026-10-23）。之前只有目录行能接 drop ⇒ 想把笔记
	 * 拖回 `笔记/` 顶层没有任何落点 ✗。传的是**区名**（`笔记` / `库`）而不是绝对路径：
	 * 组件不知道库根在哪，而两宿主都能把区名解析成根目录（IDE 走 sectionUri，插件页拼相对路径）。
	 */
	onDropRoot?: (paths: readonly string[]) => void;
}) => (
	<div
		role="button"
		tabIndex={0}
		onClick={onToggle}
		onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
		onDragOver={e => {
			if (!onDropRoot) { return; }
			e.preventDefault();                    // 节头也要允许投放（否则只有目录行能接）
			e.dataTransfer.dropEffect = 'move';
		}}
		onDrop={e => {
			if (!onDropRoot) { return; }
			const raw = e.dataTransfer.getData('text/plain');
			if (!raw) { return; }
			e.preventDefault();
			e.stopPropagation();
			onDropRoot(raw.split('\n').filter(Boolean));
		}}
		/*
		 * ★★ 2026-10-24（用户：三个折叠页签不明显，重新设计）：
		 *   上一版把节头做成了"和内容行一样"的普通行 ⇒ 在 27px 行高里，标题、计数、内容行
		 *   全都是 13px 同色文字，三者**视觉权重完全相同**，翻到中段就分不清哪是分组。
		 *   ⇒ 恢复「栏」的语义（Obsidian 的 sidebar 分组头其实也是这种处理）：
		 *     · 加厚到 30px + 轻微底色（与内容行区分开，且不抢眼）
		 *     · 标题 11.5px **加粗 + 字距**（短小、明显是"栏名"而不是条目名）
		 *     · 计数做成**胶囊徽标**（常驻可见，一眼看出这节有多少条）
		 *     · 左侧折叠箭头放大到 10px 并带过渡 ⇒ 收起/展开方向明确
		 *     · 顶部一条细分隔线 ⇒ 三节之间有清晰边界
		 *   工具按钮仍只在 hover 时出现（默认版面保持干净）。
		 */
		className="kb-sec-head"
		style={{
			display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 8px',
			background: 'rgba(127,127,127,.06)',
			borderTop: `1px solid ${c.line}`,
			cursor: 'pointer', userSelect: 'none',
		}}
	>
		<span style={{
			width: 14, flex: '0 0 14px', color: c.fgDim, fontSize: 10, textAlign: 'center',
			transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease',
		}}>▸</span>
		<span style={{
			fontSize: 11.5, fontWeight: 700, letterSpacing: '.08em', color: c.fgDim,
			overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
		}}>{title}</span>
		{count !== undefined && (
			<span style={{
				height: 16, minWidth: 18, padding: '0 6px', boxSizing: 'border-box',
				display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
				borderRadius: 8, background: 'rgba(127,127,127,.18)', color: c.fgDim,
				fontSize: 10, fontWeight: 600, fontVariantNumeric: 'tabular-nums',
			}}>{count}</span>
		)}
		<span style={{ flex: 1 }} />
		{extra ? <span className="kb-sec-extra" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>{extra}</span> : null}
	</div>
);

// ─── 树 ────────────────────────────────────────────────────────────────────

const TreeRow = ({ node, depth, selectedPaths, openSet, onOpen, onMove, onToggleSelect, onToggleOpen, onRangeSelect }: {
	node: KbTreeNode; depth: number; selectedPaths?: readonly string[];
	/**
	 * ★ 2026-10-23（方案 A）：展开状态**提升到父级**，TreeRow 变成受控组件。
	 *   原因：Shift 范围选择要按"用户眼里真实可见的顺序"取区间，而原来 `open` 是每行自己的
	 *   `useState` ⇒ 父组件根本不知道谁可见，算不出范围 ✗。受控之后父组件能算，顺带也支持
	 *   「全部折叠/展开」这类操作。
	 */
	openSet: ReadonlySet<string>;
	onOpen: (n: KbTreeNode) => void;
	/** 多选后拖拽：一次报**整批**（宿主只 reload 一次，避免 N 次重建 webview） */
	onMove?: (fromPaths: readonly string[], toFolder: string) => void;
	/** Ctrl/Cmd + 单击：只改选中集，不打开（与 IDE 一致的"多选不开"口径） */
	onToggleSelect?: (path: string) => void;
	onToggleOpen?: (path: string) => void;
	/** Shift + 单击：按可见顺序取区间（锚点由父组件记） */
	onRangeSelect?: (path: string) => void;
}) => {
	const open = openSet.has(node.path);
	const isFolder = node.isFolder;
	const hasChildren = !!node.children?.length;
	const selected = !!selectedPaths?.includes(node.path);

	const toggle = useCallback(() => {
		if (isFolder && hasChildren) { onToggleOpen?.(node.path); }
		onOpen(node);
	}, [isFolder, hasChildren, node, onOpen, onToggleOpen]);

	return (
		<>
			<div
				className="kb-row"
				role="treeitem"
				// 事件委托用：滚动容器统一挂 contextmenu，靠这两个属性反查是谁被右键
				data-kb-path={node.path}
				data-kb-folder={isFolder ? '1' : '0'}
				/* 拖拽整理（2026-10-23）：只有目录是投放目标；数据从 dataTransfer 取，
				   不引入全局 drag state（省一次整树重渲染）*/
				draggable
				onDragStart={e => {
					// 拖的是"选中集中的一员" ⇒ 带走整批；否则只带自己
					const batch = selectedPaths && selectedPaths.includes(node.path) && selectedPaths.length > 1
						? selectedPaths
						: [node.path];
					e.dataTransfer.setData('text/plain', batch.join('\n'));
					e.dataTransfer.effectAllowed = 'move';
				}}
				onDragOver={e => {
					if (!node.isFolder) { return; }
					const from = e.dataTransfer.types.includes('text/plain') ? '1' : '';
					if (!from) { return; }
					e.preventDefault();            // 不 preventDefault ⇒ 不触发 drop
					e.dataTransfer.dropEffect = 'move';
				}}
				onDrop={e => {
					if (!node.isFolder) { return; }
					const raw = e.dataTransfer.getData('text/plain');
					if (!raw) { return; }
					// 批量：一行一个 path（见 onDragStart）；逐个过滤掉"拖到自己/自己的子孙"（会成环）
					const froms = raw.split('\n').filter(p => p && p !== node.path && !node.path.startsWith(p + '/'));
					if (!froms.length) { return; }
					e.preventDefault();
					e.stopPropagation();
					onMove?.(froms, node.path);
				}}
				aria-expanded={isFolder ? open : undefined}
				aria-selected={selected}
				tabIndex={0}
				onClick={e => {
					// Shift + 单击 = 从锚点连到当前（按可见顺序取区间）；优先于 Ctrl
					if (e.shiftKey) { e.preventDefault(); onRangeSelect?.(node.path); return; }
					// Ctrl/Cmd + 单击 = 只改选中集（多选），不打开、也不展开/折叠
					if (e.ctrlKey || e.metaKey) { e.preventDefault(); onToggleSelect?.(node.path); return; }
					toggle();
				}}
				onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
				/*
				 * ★ 2026-10-24：行样式对齐 **Obsidian 文件树**（用户要求"复刻 Obsidian"）。
				 * 与之前（VS Code 风）的四点差别：
				 *   ① 行高 24 → 27，字号 12.5 → 13（Obsidian 的 `--nav-item-size` 是 13px）
				 *   ② 缩进不用 padding，改成**每层一条 1px 竖导引线**（Obsidian 的 indentation guide）
				 *   ③ 折叠箭头从**左侧移到右侧**，且只有目录才有（Obsidian 的 `nav-collapse-icon`）
				 *   ④ 选中是**低对比底色 + 正常前景**（不是 VS Code 那种整行高亮蓝）
				 */
				style={{
					display: 'flex', alignItems: 'stretch', height: 27, paddingRight: 6,
					cursor: 'pointer', fontSize: 13, position: 'relative',
					/* Obsidian：选中是**圆角浅底**（不是整行高亮蓝），并且右侧留 6px 空隙 */
					background: selected ? 'rgba(127,127,127,.16)' : 'transparent',
					borderRadius: 4, marginRight: 6,
					/* Obsidian 里目录与文件**同色同字重**，不做区分 */
					color: c.fg,
				}}
				onMouseEnter={e => { if (!selected) { (e.currentTarget as HTMLElement).style.background = 'rgba(127,127,127,.09)'; } }}
				onMouseLeave={e => { if (!selected) { (e.currentTarget as HTMLElement).style.background = 'transparent'; } }}
			>
				{/* 缩进导引：每层一条竖线（Obsidian `--nav-indentation-guide-color`） */}
				{Array.from({ length: depth }).map((_, i) => (
					<span
						key={'g' + i}
						style={{ width: 16, flex: '0 0 16px', alignSelf: 'stretch', borderLeft: `1px solid rgba(127,127,127,${i === depth - 1 ? .35 : .2})` }}
					/>
				))}
				{/*
				 * ★ 2026-10-24（照 Obsidian 原文排版复刻）：
				 *   · 折叠箭头在**名字左侧**（文件也占位，保证同层名字左边缘对齐）
				 *   · **没有任何文件图标**（Obsidian 默认无图标；非 md 靠名字里的扩展名区分）
				 *   · **不显示大小/子项数**（Obsidian 树里没有这一列；悬停也不显示）
				 */}
				<span style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0, paddingLeft: depth === 0 ? 6 : 2 }}>
					<span style={{
						width: 12, flex: '0 0 12px', textAlign: 'center', color: c.fgFaint, fontSize: 9,
						transform: isFolder && open ? 'rotate(90deg)' : 'none', transition: 'transform .12s ease',
					}}>{isFolder && hasChildren ? '▸' : ''}</span>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.name}</span>
				</span>
			</div>
			{isFolder && open && hasChildren && node.children!.map(child => (
				<TreeRow
					key={child.path}
					node={child}
					depth={depth + 1}
					selectedPaths={selectedPaths}
					openSet={openSet}
					onOpen={onOpen}
					onMove={onMove}
					onToggleSelect={onToggleSelect}
					onToggleOpen={onToggleOpen}
					onRangeSelect={onRangeSelect}
				/>
			))}
		</>
	);
};

// ─── 主组件 ────────────────────────────────────────────────────────────────

/**
 * 库里那些**不该出现在树上的**条目（2026-10-23）：
 * 真机截图里 `index.md` / `insights.md` / `overview.md` / `.kb-insights-cache.json`
 * 和真正的笔记并排列着 —— 它们是索引/缓存产物，不是内容 ✗。
 * ⚠ 不按"点开头"一刀切（`.obsidian` 该隐，但库名可能带点），也**不动 `raw` 这类真目录**。
 */
const NOISE_BASE = new Set(['index', 'insights', 'overview', 'readme']);

function isNoise(name: string): boolean {
	const n = name.toLowerCase();
	return NOISE_BASE.has(n)
		|| n.startsWith('.kb')
		|| (n.endsWith('.json') && n.includes('cache'));
}

/** 递归：剔噪音 ＋ 搜索时按文件名过滤（子命中则父保留，否则父会消失） */
function refine(nodes: readonly KbTreeNode[], q: string): KbTreeNode[] {
	const out: KbTreeNode[] = [];
	for (const node of nodes) {
		if (isNoise(node.name)) { continue; }
		if (node.isFolder) {
			const children = refine(node.children ?? [], q);
			if (!q || children.length > 0 || node.name.toLowerCase().includes(q)) {
				out.push({ ...node, children, count: countOf(children) });
			}
		} else if (!q || node.name.toLowerCase().includes(q)) {
			out.push(node);
		}
	}
	return out;
}

/** 收集树里所有目录的 path（Shift 范围/搜索时用"全展开"视图） */
function allFolders(nodes: readonly KbTreeNode[], into: Set<string>): Set<string> {
	for (const n of nodes) {
		if (n.isFolder) { into.add(n.path); allFolders(n.children ?? [], into); }
	}
	return into;
}

/**
 * 排序键。原生 sideview 有 14 种，这里覆盖**日常真正会用的** 5 种：
 *   名称↑ / 名称↓ / 大小↓ / 时间↓（新的在前）/ 时间↑（旧的在前）
 * ⚠ 不硬凑到 14 种：其余那些（按子项数、按标签、按来源…）在侧栏里几乎没人点，
 *   加了只是让工具栏变长。
 */
export type KbSortKey = 'name' | 'nameDesc' | 'size' | 'mtime' | 'mtimeAsc';

/**
 * 递归排序。**目录永远在前**（与原生 sideview 的默认口径一致）—— 只有同一类内部才比排序键，
 * 否则「按大小排序」会把一堆文件排在目录前面，树的结构感就没了。
 */
function applySort(nodes: readonly KbTreeNode[], key: KbSortKey): KbTreeNode[] {
	const out = nodes.map(n => (n.isFolder ? { ...n, children: applySort(n.children ?? [], key) } : n));
	out.sort((a, b) => {
		if (a.isFolder !== b.isFolder) { return a.isFolder ? -1 : 1; }
		const byName = a.name.localeCompare(b.name, 'zh');
		if (key === 'nameDesc') { return -byName; }
		if (key === 'size') { return (b.size ?? 0) - (a.size ?? 0) || byName; }
		if (key === 'mtime') { return (b.mtime ?? 0) - (a.mtime ?? 0) || byName; }
		if (key === 'mtimeAsc') { return (a.mtime ?? 0) - (b.mtime ?? 0) || byName; }
		return byName;
	});
	return out;
}

/**
 * 按标签筛选树（2026-10-24：用户报「点击分类页签没有反应」）。
 *
 * 为什么放在视图层而不是宿主：三个宿主（IDE 侧栏 / 插件页 / 工作台面板）都要有同样的行为，
 * 交给宿主各自实现必然漂移；视图只需要 `data.tags[].paths` 这一份数据即可。
 * 规则：文件必须命中集合；目录**保留仍有命中子孙的**（否则树里会出现一堆空目录）。
 * 比较口径与服务端一致：**正斜杠 + 小写**（Windows 路径大小写不敏感）。
 */
function filterByTag(nodes: readonly KbTreeNode[], paths: ReadonlySet<string> | null): KbTreeNode[] {
	if (!paths) { return nodes as KbTreeNode[]; }
	const out: KbTreeNode[] = [];
	for (const node of nodes) {
		if (node.isFolder) {
			const kids = filterByTag(node.children ?? [], paths);
			if (kids.length) { out.push({ ...node, children: kids, count: kids.length }); }
		} else if (paths.has(String(node.path).replace(/\\/g, '/').toLowerCase())) {
			out.push(node);
		}
	}
	return out;
}

/** 叶子（笔记/文件）计数 */
function countOf(nodes: readonly KbTreeNode[]): number {
	let n = 0;
	for (const node of nodes) { n += node.isFolder ? countOf(node.children ?? []) : 1; }
	return n;
}

const KB_SCOPED_CSS = `
.kb-meta { opacity: 0; transition: opacity .1s ease; }
.kb-row:hover .kb-meta, .kb-row[aria-selected="true"] .kb-meta { opacity: .85; }
/* 节头右侧的工具按钮：默认隐藏，hover 才现（Obsidian 的节头没有任何工具条） */
.kb-sec-extra { opacity: 0; transition: opacity .1s ease; }
.kb-sec-head:hover .kb-sec-extra { opacity: 1; }

/* ── 服务端渲染的 Markdown（class 由 lib/md/render.js 产出，2026-10-25）──────
   为什么样式放在视图、HTML 放服务端：HTML 要能被三个宿主共用，而配色/间距属于
   「看的人」这一侧（IDE 与 dsh 的主题变量不同）。 */
.kb-md { font-size: 13px; line-height: 1.75; word-break: break-word; }
/*
 * ★ 2026-10-26（性能，P1）：长文档一次性注入整篇 HTML 时，浏览器会把**屏外**内容也全部布局。
 *   content-visibility: auto 让屏外块跳过布局与绘制；contain-intrinsic-size 给个占位高度，
 *   以免滚动条乱跳。首块不加（避免首屏测量被推迟）。
 *   对 1 万字以上的笔记首屏更快；短笔记无感。
 */
.kb-md > *:not(:first-child) { content-visibility: auto; contain-intrinsic-size: auto 2.4em; }
.kb-md h1 { font-size: 1.55em; margin: .7em 0 .4em; }
.kb-md h2 { font-size: 1.3em; margin: .7em 0 .4em; }
.kb-md h3 { font-size: 1.12em; margin: .6em 0 .3em; }
.kb-md h4, .kb-md h5, .kb-md h6 { font-size: 1em; margin: .6em 0 .3em; }
.kb-md p { margin: .5em 0; }
.kb-md ul, .kb-md ol { margin: .4em 0; padding-left: 1.7em; }
.kb-md li { margin: .15em 0; }
.kb-md blockquote { border-left: 3px solid rgba(127,127,127,.45); margin: .6em 0; padding: .1em 0 .1em 10px; color: var(--vscode-descriptionForeground, #9d9d9d); }
.kb-md .kb-callout { border-left: 3px solid #3794ff; background: rgba(127,127,127,.07); border-radius: 4px; padding: 6px 10px; margin: .7em 0; }
.kb-md .kb-callout > p:first-of-type { margin-top: 0; }
.kb-md .kb-callout::before {
	content: attr(data-callout-title);
	display: block; font-size: 12px; font-weight: 600; color: #3794ff; margin-bottom: 3px;
}
.kb-md .kb-callout[data-callout="tip"]::before, .kb-md .kb-callout[data-callout="hint"]::before { color: #3fb950; }
.kb-md .kb-callout[data-callout="warning"]::before, .kb-md .kb-callout[data-callout="caution"]::before { color: #d29922; }
.kb-md .kb-callout[data-callout="danger"]::before, .kb-md .kb-callout[data-callout="error"]::before, .kb-md .kb-callout[data-callout="bug"]::before { color: #f85149; }
.kb-md .kb-callout[data-callout="quote"]::before { color: #9d9d9d; }
.kb-md .kb-wiki { color: var(--vscode-textLink-foreground, #3794ff); cursor: pointer; text-decoration: none; }
.kb-md .kb-wiki:hover { text-decoration: underline; }
.kb-md .kb-wiki-missing { border-bottom: 1px dashed rgba(127,127,127,.6); opacity: .72; }
.kb-md .kb-task { margin-right: 6px; vertical-align: middle; cursor: pointer; }
.kb-md table.kb-table { border-collapse: collapse; margin: .7em 0; font-size: 12.5px; }
.kb-md .kb-table th, .kb-md .kb-table td { border: 1px solid rgba(127,127,127,.3); padding: 4px 10px; }
.kb-md .kb-table th { background: rgba(127,127,127,.12); font-weight: 600; }
.kb-md pre.kb-code { margin: .7em 0; padding: 8px 10px; background: rgba(127,127,127,.12); border-radius: 4px; overflow: auto; font-size: 12px; line-height: 1.6; }
.kb-md code { font-family: var(--vscode-editor-font-family, monospace); background: rgba(127,127,127,.14); padding: 1px 4px; border-radius: 3px; }
.kb-md pre.kb-code code { background: none; padding: 0; }
/*
 * mermaid 由**服务端**用 pele 渲染成内联 SVG（2026-10-26）⇒ 客户端零脚本。
 * 这里只负责让它自适应宽度并居中；配色已内联在 SVG 根节点的 style 里。
 */
.kb-md .kb-mermaid-block { margin: .8em 0; text-align: center; }
.kb-md .kb-mermaid-block > svg { max-width: 100%; height: auto; }
/* 服务端轻量高亮的四类记号（与旧的视图内高亮同色口径） */
.kb-md .kb-tok-kw { color: #569cd6; }
.kb-md .kb-tok-str { color: #ce9178; }
.kb-md .kb-tok-num { color: #b5cea8; }
.kb-md .kb-tok-com { color: #6a9955; }
.kb-md img { max-width: 100%; border-radius: 4px; }
.kb-md hr { border: 0; border-top: 1px solid rgba(127,127,127,.3); margin: 1em 0; }
.kb-md a { color: var(--vscode-textLink-foreground, #3794ff); }
`;

/** 非 Markdown 文件的预览类型（点树上的 pdf/图片/音视频时用，不再走 `/api/doc` 读文本） */
function assetKindOf(path: string): 'image' | 'pdf' | 'video' | 'audio' | null {
	const ext = (path.split(/[?#]/)[0].split('.').pop() ?? '').toLowerCase();
	if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext)) { return 'image'; }
	if (ext === 'pdf') { return 'pdf'; }
	if (['mp4', 'webm', 'mov'].includes(ext)) { return 'video'; }
	if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) { return 'audio'; }
	return null;
}

type KbCanvasNode = { id: string; x: number; y: number; w: number; h: number; type: string; color: string; text: string; file: string };
type KbCanvasDoc = { name: string; path: string; notesRoot?: string; nodes: KbCanvasNode[]; edges: { from: string; to: string; label: string }[] };

/**
 * 导图（.canvas）只读渲染（2026-10-25 从面板侧迁到视图层）。
 *
 * 为什么迁到视图：渲染器原先在 `client.js`（工作台面板）里 ⇒ **插件页 `/x/kb/` 用不到**，
 * 「导图」按钮在页面上永远不出现。迁到这里后三端（IDE/面板/页面）共用一份实现，
 * 面板侧那份 200 行重复代码同时删掉。
 *
 * 能力门控：宿主声明 `actions.canvas === true`（表示它的服务端有 `/api/canvas`）才显示按钮。
 * IDE 侧不声明 ⇒ 不显示（它自己的「思维导图」是开编辑器）。
 */
/**
 * **完整设置（飞书同步）** —— 用 bundle 自己的 React 实现（2026-10-28）。
 *
 * 为什么在这里重写一份，而不是复用面板的 `KbSettingsPage`：
 *   bundle 是 esbuild `bundle: true` 的独立产物，**自带一份 React**；面板用的是宿主的 `react`。
 *   跨实例渲染（portal / 自建根）都不可靠 —— 真机上表现为"设置页被一个不透明空容器盖成空白"。
 *   所以按**同一组 HTTP 端点**在这里重写：同树渲染，绝无跨实例问题。
 *
 * 端点（与面板/插件页完全一致，见 `dsh-plugins/vssaros-kb/lib/index.js`）：
 *   GET/POST /x/kb/api/kb-settings           读/写设置（含 `feishu.cliPath` / `feishu.mappings`）
 *   GET      /x/kb/api/feishu-cli?cli=…      检测 lark-cli
 *   POST     /x/kb/api/feishu-cli            { action: 'upgrade' }
 *   GET      /x/kb/api/feishu-spaces         飞书知识库列表
 *   POST     /x/kb/api/feishu-sync[?dry=1]   触发同步（dry = 试运行）
 *   GET      /x/kb/api/feishu-log?lines=200  上次同步日志
 *   GET      /x/kb/api/feishu-schedule       定时状态
 */
function KbFeishuSettings() {
	const [open, setOpen] = useState(true);
	const [settings, setSettings] = useState<any>(null);
	const [cliPath, setCliPath] = useState('');
	const [cli, setCli] = useState<any>(null);
	const [busy, setBusy] = useState('');
	const [out, setOut] = useState('');
	const [spaces, setSpaces] = useState<any[]>([]);
	const [schedule, setSchedule] = useState<any>(null);

	/*
	 * 面板侧点「同步飞书」的结果（2026-10-29）：面板用 DOM 事件抛过来，
	 * 这里显示在**页内输出区**（不再用会阻塞渲染进程的 window.alert）。
	 */
	useEffect(() => {
		const onResult = (ev: Event) => {
			const d = (ev as CustomEvent).detail || {};
			if (d.phase === 'start') { setBusy('sync'); setOut(String(d.text || '同步中…')); return; }
			setBusy('');
			setOut(String(d.text || (d.ok ? '同步完成' : '同步结束（有失败项）')));
		};
		window.addEventListener('kb:feishu-sync-result', onResult);
		return () => window.removeEventListener('kb:feishu-sync-result', onResult);
	}, []);

	const api = (p: string, init?: RequestInit) => fetch('/x/kb/api/' + p, Object.assign({ credentials: 'same-origin' as const }, init));
	const feishuOf = (s: any) => (s && s.feishu) || {};

	useEffect(() => {
		let alive = true;
		api('kb-settings').then(r => r.json()).then((b) => {
			if (!alive || !b || !b.ok) { return; }
			setSettings(b.settings || {});
			setCliPath(String(feishuOf(b.settings).cliPath || ''));
		}).catch(() => undefined);
		api('feishu-schedule').then(r => r.json()).then((b) => { if (alive && b && b.ok) { setSchedule(b); } }).catch(() => undefined);
		return () => { alive = false; };
	}, []);

	/** 保存：只合并 feishu 这一段，避免把别的设置覆盖掉 */
	const save = (patch: any) => {
		const next = Object.assign({}, settings || {}, { feishu: Object.assign({}, feishuOf(settings), patch) });
		setSettings(next);
		api('kb-settings', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
		}).then(r => r.json()).then((b) => { if (!b || b.ok === false) { setOut('保存失败：' + String((b && b.error) || '未知')); } }).catch(e => setOut('保存失败：' + String(e)));
	};

	const checkCli = () => {
		setBusy('cli');
		const q = cliPath.trim();
		api('feishu-cli' + (q ? '?cli=' + encodeURIComponent(q) : '')).then(r => r.json())
			.then(b => setCli(b || { ok: false, error: '无响应' }))
			.catch(e => setCli({ ok: false, error: String(e) }))
			.then(() => setBusy(''));
	};

	const upgradeCli = () => {
		setBusy('cli');
		api('feishu-cli', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'upgrade' }) })
			.then(r => r.json()).then(b => setCli(b || { ok: false, error: '无响应' }))
			.catch(e => setCli({ ok: false, error: String(e) }))
			.then(() => setBusy(''));
	};

	const loadSpaces = () => {
		setBusy('spaces');
		api('feishu-spaces').then(r => r.json()).then((b) => {
			setSpaces((b && b.ok && Array.isArray(b.spaces)) ? b.spaces : []);
			if (!b || !b.ok) { setOut('拉取飞书知识库失败：' + String((b && b.error) || '未知')); }
		}).catch(e => setOut('拉取飞书知识库失败：' + String(e))).then(() => setBusy(''));
	};

	const runSync = (dry: boolean) => {
		setBusy('sync');
		setOut(dry ? '试运行中…' : '正在同步（逐篇串行，可能几分钟）…');
		api('feishu-sync' + (dry ? '?dry=1' : ''), { method: 'POST' }).then(r => r.json())
			.then(b => setOut(String((b && b.output) || (b && b.error) || '(无输出)')))
			.catch(e => setOut(String(e))).then(() => setBusy(''));
	};

	const loadLog = () => {
		api('feishu-log?lines=200').then(r => r.json())
			.then(b => setOut(b && b.ok ? ((b.lines || []).join('\n') || '（还没有同步日志）') : ('读取日志失败：' + String((b && b.error) || '未知'))))
			.catch(e => setOut('读取日志失败：' + String(e)));
	};

	const mappings: any[] = feishuOf(settings).mappings || [];
	const setMapping = (i: number, patch: any) => {
		const next = mappings.map((m, k) => (k === i ? Object.assign({}, m, patch) : m));
		save({ mappings: next });
	};
	const addMapping = () => save({ mappings: [...mappings, { dir: '', spaceId: '' }] });
	const removeMapping = (i: number) => save({ mappings: mappings.filter((_m, k) => k !== i) });

	const row = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' } as const;
	const inp = { height: 24, padding: '0 8px', fontSize: 11.5, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}`, borderRadius: 4, minWidth: 0 } as const;
	const btn = { height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` } as const;

	return (
		<div style={{ marginBottom: 12 }}>
			<div role="button" tabIndex={0} onClick={() => setOpen(v => !v)} onKeyDown={e => { if (e.key === 'Enter') { setOpen(v => !v); } }}
				style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: c.fgFaint, marginBottom: 4, cursor: 'pointer' }}>
				<span style={{ width: 9, fontSize: 9 }}>{open ? '▾' : '▸'}</span>
				<span style={{ fontWeight: 700, letterSpacing: '.03em' }}>飞书同步</span>
				<span style={{ opacity: .8 }}>{feishuOf(settings).enabled ? '已启用' : '未启用'}</span>
			</div>

			{!open ? null : (
				<div style={{ paddingLeft: 14 }}>
					{/* CLI */}
					<div style={row}>
						<span style={{ fontSize: 11, color: c.fgFaint, width: 64, flex: '0 0 auto' }}>CLI 路径</span>
						<input value={cliPath} placeholder="留空 = 走 PATH" onChange={e => setCliPath(e.target.value)} style={{ ...inp, flex: '1 1 auto', minWidth: 0 }} />
						<button type="button" style={btn} onClick={() => { save({ cliPath }); checkCli(); }}>{busy === 'cli' ? '检测中…' : '保存并检测'}</button>
						<button type="button" style={btn} onClick={upgradeCli}>升级</button>
					</div>
					{cli ? (
						<div style={{ fontSize: 10.5, color: cli.ok ? c.fgDim : '#e06c75', marginBottom: 8 }}>
							{cli.ok ? ('✓ ' + String(cli.version || '可用')) : ('✗ ' + String(cli.error || '不可用'))}
						</div>
					) : null}

					{/* 开关 */}
					<div style={row}>
						<label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
							<input type="checkbox" checked={!!feishuOf(settings).enabled} onChange={e => save({ enabled: e.target.checked })} />启用
						</label>
						<label style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
							<input type="checkbox" checked={!!feishuOf(settings).schedule} onChange={e => save({ schedule: e.target.checked })} />定时同步
						</label>
						<span style={{ fontSize: 11, color: c.fgFaint }}>间隔(分钟)</span>
						<input type="number" value={Number(feishuOf(settings).scheduleMinutes ?? 60)} onChange={e => save({ scheduleMinutes: Number(e.target.value) || 60 })}
							style={{ ...inp, width: 70 }} />
						<span style={{ fontSize: 11, color: c.fgFaint }}>
							{schedule && schedule.nextRunAt ? ('下次 ' + String(schedule.nextRunAt)) : ''}
						</span>
					</div>

					{/* 映射 */}
					<div style={{ ...row, marginTop: 4 }}>
						<span style={{ fontSize: 11, color: c.fgFaint, width: 64, flex: '0 0 auto' }}>目录映射</span>
						<button type="button" style={btn} onClick={loadSpaces}>{busy === 'spaces' ? '拉取中…' : '拉取飞书知识库'}</button>
						<button type="button" style={btn} onClick={addMapping}>＋ 一行</button>
						<span style={{ fontSize: 10.5, color: c.fgFaint }}>{mappings.length} 条</span>
					</div>
					{mappings.map((m, i) => (
						<div key={i} style={row}>
							<input value={String(m.dir || '')} placeholder="笔记区相对目录，如 笔记/学习" onChange={e => setMapping(i, { dir: e.target.value })} style={{ ...inp, flex: '1 1 auto' }} />
							<input value={String(m.spaceId || '')} placeholder="飞书 spaceId" onChange={e => setMapping(i, { spaceId: e.target.value })} style={{ ...inp, flex: '0 1 180px', minWidth: 120 }} />
							{spaces.length ? (
								<select onChange={e => e.target.value && setMapping(i, { spaceId: e.target.value })} style={{ ...inp, maxWidth: 160 }} value="">
									<option value="">选飞书库…</option>
									{spaces.map((sp: any) => <option key={sp.spaceId || sp.name} value={sp.spaceId}>{sp.name || sp.spaceId}</option>)}
								</select>
							) : null}
							<button type="button" style={btn} onClick={() => removeMapping(i)}>删除</button>
						</div>
					))}

					{/* 动作 */}
					<div style={{ ...row, marginTop: 8 }}>
						<button type="button" style={btn} onClick={() => runSync(true)}>{busy === 'sync' ? '执行中…' : '试运行'}</button>
						<button type="button" style={btn} onClick={() => runSync(false)}>立即同步</button>
						<button type="button" style={btn} onClick={loadLog}>读日志</button>
					</div>
					{out ? (
						<pre style={{ margin: 0, maxHeight: 220, overflow: 'auto', padding: 8, fontSize: 10.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', background: 'rgba(127,127,127,.10)', border: `1px solid ${c.line}`, borderRadius: 4 }}>{out}</pre>
					) : null}
				</div>
			)}
		</div>
	);
}

/**
 * **关系图谱页签**（bundle 自己的 React · 2026-10-29）。
 *
 * 数据源与面板的 `KbGraph` 完全一致：`GET /x/kb/api/graph?refresh=1[&vault=…]`
 *   → `{ ok, nodes: [{ id, … }], edges: [{ from, to }] }`
 * 之所以在 bundle 里再写一份：面板那份在**另一棵 React 树**里（跨树渲染 = 空白/黑屏，已踩过三次）。
 * 这里同树渲染 ⇒ 页签内容必然可见。
 */
function KbGraphTab({ vaultId, onOpenNote }: { vaultId?: string; onOpenNote?: (path: string) => void }) {
	const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
	const [nodes, setNodes] = useState<any[]>([]);
	const [edges, setEdges] = useState<any[]>([]);
	const [error, setError] = useState('');

	const load = useCallback(() => {
		setPhase('loading');
		fetch('/x/kb/api/graph?refresh=1' + (vaultId ? '&vault=' + encodeURIComponent(vaultId) : ''), { credentials: 'same-origin' })
			.then(r => r.json())
			.then((b) => {
				if (!b || b.ok === false) { setPhase('error'); setError(String((b && b.error) || '读取图谱失败')); return; }
				const ns: any[] = (b.nodes || []).map((n: any, i: number) => Object.assign({}, n, {
					x: Math.cos(i * 2.399963) * 160,
					y: Math.sin(i * 2.399963) * 160,
				}));
				const byId = new Map(ns.map(n => [n.id, n]));
				const es: any[] = (b.edges || [])
					.map((e: any) => ({ s: byId.get(e.from ?? e.source ?? e.s?.id), t: byId.get(e.to ?? e.target ?? e.t?.id) }))
					.filter((e: any) => e.s && e.t);
				setNodes(ns);
				setEdges(es);
				setPhase('ready');
			})
			.catch((e) => { setPhase('error'); setError(String((e && e.message) || e)); });
	}, [vaultId]);

	useEffect(() => { load(); }, [load]);

	const labelOf = (n: any) => String(n.title || n.name || n.id || '').replace(/\.md$/i, '').split(/[\\/]/).pop() || '';

	const header = (
		<div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px', borderBottom: `1px solid ${c.line}`, flex: '0 0 auto' }}>
			<span style={{ fontSize: 12, fontWeight: 600 }}>关系图谱</span>
			<span style={{ fontSize: 10.5, color: c.fgFaint }}>{nodes.length} 个节点 · {edges.length} 条关系</span>
			<span style={{ flex: 1 }} />
			<button type="button" onClick={load} style={{ height: 20, padding: '0 8px', fontSize: 11, cursor: 'pointer', background: 'transparent', color: 'inherit', border: `1px solid ${c.line}`, borderRadius: 3 }}>刷新</button>
		</div>
	);

	if (phase === 'loading') {
		return <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--vscode-editor-background, #1e1e1e)' }}>{header}
			<div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.fgFaint, fontSize: 12 }}>正在读取图谱…</div></div>;
	}
	if (phase === 'error') {
		return <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--vscode-editor-background, #1e1e1e)' }}>{header}
			<div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e06c75', fontSize: 12 }}>{error}</div></div>;
	}
	if (!nodes.length) {
		return <div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--vscode-editor-background, #1e1e1e)' }}>{header}
			<div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', color: c.fgFaint, fontSize: 12 }}>这个库里还没有可画的节点</div></div>;
	}

	return (
		<div style={{ flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--vscode-editor-background, #1e1e1e)' }}>
			{header}
			<div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
				<svg width="100%" height="100%" viewBox="-220 -220 440 440" preserveAspectRatio="xMidYMid meet" style={{ display: 'block', minHeight: 320 }}>
					<g stroke={c.line} strokeWidth={0.8}>
						{edges.map((e, i) => <line key={i} x1={e.s.x} y1={e.s.y} x2={e.t.x} y2={e.t.y} />)}
					</g>
					<g>
						{nodes.map((n, i) => (
							<g key={i}>
								<circle cx={n.x} cy={n.y} r={4} fill={String(n.id || '').indexOf('/库/') >= 0 ? '#dcb67a' : '#3794ff'}
									onClick={() => { if (onOpenNote && n.id) { onOpenNote(String(n.id)); } }}
									style={{ cursor: onOpenNote ? 'pointer' : 'default' }} />
								<text x={n.x + 7} y={n.y + 3} fontSize={9} fill={c.fgDim}>{labelOf(n).slice(0, 14)}</text>
							</g>
						))}
					</g>
				</svg>
			</div>
		</div>
	);
}

function KbCanvasPane({ onClose, onOpenNote }: { onClose: () => void; onOpenNote: (abs: string) => void }) {
	const wrapRef = useRef<HTMLDivElement | null>(null);
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const [list, setList] = useState<{ name: string; rel: string; abs: string; size: number }[] | null>(null);
	const [doc, setDoc] = useState<KbCanvasDoc | null>(null);
	const [error, setError] = useState('');
	const viewRef = useRef({ s: 1, x: 0, y: 0 });
	const layoutRef = useRef<{ nodes: KbCanvasNode[] }>({ nodes: [] });


	useEffect(() => {
		let alive = true;
		fetch('/x/kb/api/canvas-list', { credentials: 'same-origin' })
			.then(r => r.json())
			.then(b => {
				if (!alive) { return; }
				if (!b || b.ok === false) { setError(String(b?.error || '读取导图清单失败')); setList([]); return; }
				setList(Array.isArray(b.files) ? b.files : []);
			})
			.catch(e => { if (alive) { setError(String(e?.message || e)); setList([]); } });
		return () => { alive = false; };
	}, []);

	const openFile = (abs: string) => {
		setError('');
		fetch('/x/kb/api/canvas?uri=' + encodeURIComponent(abs), { credentials: 'same-origin' })
			.then(r => r.json())
			.then(b => {
				if (!b || b.ok === false) { setError(String(b?.error || '解析 .canvas 失败')); return; }
				setDoc(b as KbCanvasDoc);
			})
			.catch(e => setError(String(e?.message || e)));
	};

	// 只有一份时自动打开
	useEffect(() => {
		if (!doc && list && list.length === 1) { openFile(list[0].abs); }
	}, [list, doc]);

	// 绘制：包围盒 → 适应视图 → 静态绘制（无物理模拟：550 节点也不卡）
	useEffect(() => {
		if (!doc) { return; }
		const canvas = canvasRef.current;
		const wrap = wrapRef.current;
		if (!canvas || !wrap) { return; }
		const ctx = canvas.getContext('2d');
		if (!ctx) { return; }
		const nodes = doc.nodes || [];
		const byId = new Map(nodes.map(n => [n.id, n]));
		layoutRef.current = { nodes };

		const dpr = () => window.devicePixelRatio || 1;
		const resize = () => {
			const w = wrap.clientWidth || 600;
			const h = wrap.clientHeight || 400;
			canvas.width = Math.round(w * dpr());
			canvas.height = Math.round(h * dpr());
			ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
		};

		let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
		for (const n of nodes) {
			minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
			maxX = Math.max(maxX, n.x + n.w); maxY = Math.max(maxY, n.y + n.h);
		}
		if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
		const bw = Math.max(1, maxX - minX);
		const bh = Math.max(1, maxY - minY);
		const fit = () => {
			const w = wrap.clientWidth || 600;
			const h = wrap.clientHeight || 400;
			const s = Math.max(0.02, Math.min(1, Math.min((w - 40) / bw, (h - 40) / bh)));
			viewRef.current = { s, x: (w - bw * s) / 2 - minX * s, y: (h - bh * s) / 2 - minY * s };
		};

		const PALETTE = ['#3a3a3a', '#8b3a3a', '#8b6b3a', '#3a8b5a', '#3a6b8b', '#6b3a8b', '#8b3a6b'];
		const wrapText = (text: string, maxChars: number) => {
			const clean = String(text || '').replace(/\*\*/g, '').replace(/\r/g, '');
			const out: string[] = [];
			for (const para of clean.split('\n')) {
				let cur = '';
				for (const ch of para) {
					if (cur.length >= maxChars) { out.push(cur); cur = ''; }
					cur += ch;
				}
				out.push(cur);
			}
			return out.filter(l => l.length);
		};

		const draw = () => {
			const w = wrap.clientWidth || 600;
			const h = wrap.clientHeight || 400;
			const v = viewRef.current;
			ctx.clearRect(0, 0, w, h);
			ctx.save();
			ctx.translate(v.x, v.y);
			ctx.scale(v.s, v.s);
			ctx.strokeStyle = 'rgba(150,150,150,.55)';
			ctx.lineWidth = Math.max(0.5, 1.2 / v.s);
			for (const e of (doc.edges || [])) {
				const a = byId.get(e.from);
				const b = byId.get(e.to);
				if (!a || !b) { continue; }
				const ax = a.x + a.w / 2; const ay = a.y + a.h / 2;
				const bx = b.x + b.w / 2; const by = b.y + b.h / 2;
				const mx = (ax + bx) / 2;
				ctx.beginPath();
				ctx.moveTo(ax, ay);
				ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
				ctx.stroke();
			}
			ctx.font = '13px sans-serif';
			ctx.textBaseline = 'top';
			for (const n of nodes) {
				const ci = Number(n.color);
				ctx.fillStyle = PALETTE[ci >= 1 && ci <= 6 ? ci : 0];
				ctx.strokeStyle = 'rgba(200,200,200,.35)';
				ctx.lineWidth = Math.max(0.4, 1 / v.s);
				const r = 6;
				ctx.beginPath();
				ctx.moveTo(n.x + r, n.y);
				ctx.arcTo(n.x + n.w, n.y, n.x + n.w, n.y + n.h, r);
				ctx.arcTo(n.x + n.w, n.y + n.h, n.x, n.y + n.h, r);
				ctx.arcTo(n.x, n.y + n.h, n.x, n.y, r);
				ctx.arcTo(n.x, n.y, n.x + n.w, n.y, r);
				ctx.closePath();
				ctx.fill();
				ctx.stroke();
				if (v.s > 0.45) {
					ctx.fillStyle = '#e6e6e6';
					const maxChars = Math.max(6, Math.floor((n.w - 16) / 7));
					const maxLines = Math.max(1, Math.floor((n.h - 12) / 17));
					const lines = wrapText(n.text, maxChars).slice(0, maxLines);
					let ty = n.y + 8;
					for (const line of lines) { ctx.fillText(line, n.x + 8, ty); ty += 17; }
				}
			}
			ctx.restore();
		};

		resize();
		fit();
		draw();
		let ro: ResizeObserver | null = null;
		try {
			ro = new ResizeObserver(() => { resize(); draw(); });
			ro.observe(wrap);
		} catch { /* 老内核无 RO */ }

		const onClick = (ev: MouseEvent) => {
			const rect = canvas.getBoundingClientRect();
			const v = viewRef.current;
			const gx = (ev.clientX - rect.left - v.x) / v.s;
			const gy = (ev.clientY - rect.top - v.y) / v.s;
			for (const n of layoutRef.current.nodes) {
				if (gx < n.x || gx > n.x + n.w || gy < n.y || gy > n.y + n.h) { continue; }
				if (!n.file) { return; }
				const root = String(doc.notesRoot || '').replace(/\/+$/, '');
				onOpenNote(root ? root + '/' + n.file : n.file);
				return;
			}
		};
		canvas.addEventListener('click', onClick);
		return () => {
			if (ro) { ro.disconnect(); }
			canvas.removeEventListener('click', onClick);
		};
	}, [doc, onOpenNote]);

	const barStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, height: 32, padding: '0 10px', borderBottom: '1px solid rgba(127,127,127,.25)', flex: '0 0 auto' };
	const btnStyle: React.CSSProperties = { height: 22, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: '1px solid rgba(127,127,127,.35)' };

	const bar = (
		<div style={barStyle}>
			<button type="button" onClick={onClose} style={btnStyle}>← 返回笔记</button>
			<span style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
				{doc ? `${doc.name}  ·  ${doc.nodes.length} 节点 / ${doc.edges.length} 连线` : '思维导图'}
			</span>
			<span style={{ marginLeft: 'auto', fontSize: 11, opacity: 0.6 }}>
				{doc ? '点击有来源的节点可跳到笔记' : ''}
			</span>
		</div>
	);

	if (error) {
		return (
			<div data-kb-canvas-pane="1" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
				{bar}
				<div style={{ padding: 16, opacity: 0.8, fontSize: 12 }}>导图打开失败：{error}</div>
			</div>
		);
	}
	if (!doc) {
		const files = list || [];
		return (
			<div data-kb-canvas-pane="1" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
				{bar}
				<div style={{ padding: 12, overflow: 'auto' }}>
					{list === null ? (
						<div style={{ fontSize: 12, opacity: 0.6 }}>正在查找 .canvas…</div>
					) : files.length === 0 ? (
						<div style={{ fontSize: 12, opacity: 0.7 }}>「笔记」区里还没有 .canvas。生成导图请在会话里用 kb_mindmap。</div>
					) : files.map(f => (
						<div
							key={f.abs}
							onClick={() => openFile(f.abs)}
							style={{ display: 'flex', alignItems: 'center', gap: 8, height: 26, padding: '0 8px', cursor: 'pointer', fontSize: 12.5, borderRadius: 4 }}
						>
							<span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.rel}</span>
							<span style={{ fontSize: 10.5, opacity: 0.6 }}>{Math.round((f.size || 0) / 1024)}KB</span>
						</div>
					))}
				</div>
			</div>
		);
	}
	return (
		<div data-kb-canvas-pane="1" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
			{bar}
			<div ref={wrapRef} style={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
				<canvas ref={canvasRef} data-kb-canvas-map="1" style={{ display: 'block', width: '100%', height: '100%' }} />
			</div>
		</div>
	);
}

/** 绝对路径 → 文件名（Tab 与细条面包屑用） */
function fileNameOf(p?: string): string {
	const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	return s ? (s.split("/").pop() || s) : "";
}

/** 绝对路径 → 上一级目录名（细条面包屑中点） */
function parentNameOf(p?: string): string {
	const s = String(p ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	const parts = s.split("/").filter(Boolean);
	return parts.length >= 2 ? String(parts[parts.length - 2]) : "";
}

export const KbSideview = ({ data, actions, debug }: { data: KbSideviewData; actions?: KbSideviewActions; /** 诊断串：显示"数据来自哪层 / 动作数"，出问题一张截图即可定位 */ debug?: string }) => {
	const [query, setQuery] = useState('');
	const [mode, setMode] = useState<'fulltext' | 'filename'>('fulltext');
	const [expanded, setExpanded] = useState({ library: true, vaults: true, notes: true, tags: true, links: true });
	// 多选（2026-10-23）：`selected` 是**选中集**；`primary` = 最后点的那一个（双链面板/高亮用它）
	const [selected, setSelected] = useState<readonly string[]>(data.selectedPath ? [data.selectedPath] : []);
	const primary = selected.length ? selected[selected.length - 1] : undefined;

	// 展开集（受控）：初始 = 所有顶层目录展开（与原"顶层一律展开"一致）
	const [openSet, setOpenSet] = useState<ReadonlySet<string>>(() => {
		const s = new Set<string>();
		for (const n of [...(data.library ?? []), ...data.tree]) { if (n.isFolder) { s.add(n.path); } }
		// ★ 受控化后补回"选中项在深层也看得见"：注入的 selectedPath（宿主恢复上次选中）可能落在
		//   折叠目录里 ⇒ 把它的**祖先**一并展开。用户点击产生的选中不需要这步（能点说明本来就展开着）。
		const sel = data.selectedPath;
		if (sel) {
			const segs = sel.split('/');
			for (let i = 1; i < segs.length; i++) { s.add(segs.slice(0, i).join('/')); }
		}
		return s;
	});

	const onToggleOpen = useCallback((path: string) => {
		setOpenSet(prev => {
			const next = new Set(prev);
			if (next.has(path)) { next.delete(path); } else { next.add(path); }
			return next;
		});
	}, []);
	// 右键菜单（2026-10-23）：只表达"用户想改名/删除哪个"，具体弹框与落盘由宿主决定
	// `paths` = 这次右键实际作用的对象：点在选中集里 ⇒ 整批；否则只作用于被点的那一项
	const [menu, setMenu] = useState<{ x: number; y: number; path: string; paths: readonly string[] } | null>(null);

	const toggle = (k: keyof typeof expanded) => setExpanded(v => ({ ...v, [k]: !v[k] }));

	// 双链取数：优先查注入的全量索引（按选中节点）；没有选中/没有索引时退回 data 里的示例值。
	// ⚠ 键要**归一化**再查：IDE 侧注入的是 `笔记/…` 相对路径，插件页注入的是绝对路径，
	//   两边分隔符还可能一个正斜杠一个反斜杠 ⇒ 统一成小写正斜杠，避免"索引有、查不到"。
	const linksIndex = useMemo(() => {
		if (!data.links) { return undefined; }
		const key = (p: string) => p.replace(/\\/g, '/').toLowerCase();
		const out: Record<string, { readonly out?: readonly KbLinkRef[]; readonly in?: readonly KbLinkRef[] }> = {};
		for (const k of Object.keys(data.links)) { out[key(k)] = data.links[k]; }
		return { key, map: out };
	}, [data.links]);
	const curLinks = primary && linksIndex ? linksIndex.map[linksIndex.key(primary)] : undefined;
	// ⚠ 右值必须写 `data.outLinks`（属性访问，不是上面那个同名 const —— 写成立即自引用/TDZ ✗）
	const outLinks = curLinks?.out ?? (selected ? [] : data.outLinks);
	const inLinks = curLinks?.in ?? (selected ? [] : data.inLinks);

	// ── 全文检索（2026-10-23）──────────────────────────────────────────────
	// 契约：`actions.search(q, 'full')` **返回 Promise<结果数组>**。
	//   · IDE 宿主：postMessage + 请求 id，宿主办完回推 searchResults（见 Pane 侧）
	//   · 插件页：直接 fetch /x/kb/api/search（同源，本来就是异步的）
	// 返回 undefined/抛错 ⇒ 视为"这个宿主不支持全文"⇒ 退回按名过滤（不显示假的空结果 ✗）。
	const [results, setResults] = useState<readonly KbSearchHit[] | null>(null);
	useEffect(() => {
		if (mode !== 'fulltext' || !query.trim() || !actions?.search) { setResults(null); return; }
		let alive = true;
		const timer = setTimeout(() => {
			Promise.resolve(actions.search!(query.trim(), 'fulltext'))
				.then(items => { if (alive) { setResults(Array.isArray(items) ? items as KbSearchHit[] : null); } })
				.catch(() => { if (alive) { setResults(null); } });
		}, 250);   // 防抖：每敲一个字就扫全库不可接受
		return () => { alive = false; clearTimeout(timer); };
	}, [query, mode, actions]);

	// 本地过滤（不依赖宿主搜索）：前端按名字筛，父子一起保留
	const q = query.trim().toLowerCase();
	// 排序（2026-10-23）：原生 sideview 有 14 种，这里先给最常用的三种（目录恒定在前）
	// ⚠ 必须声明在 libTree/noteTree 的 useMemo **之前**（否则 TS2448：block-scoped used before declaration）
	const [sortKey, setSortKey] = useState<KbSortKey>('name');
	/** 当前选中的标签（`null` = 不筛选）。点同一个标签再点一次即取消。 */
	const [tagFilter, setTagFilter] = useState<string | null>(null);
	/**
	 * 该标签对应的笔记路径集合；**拿不到 `paths` 时为 null**（IDE 侧未提供 ⇒ 不筛树，
	 * 只把标签高亮，避免"点了没反应"与"点了树突然空掉"两种更差的表现）。
	 */
	const tagPathSet = useMemo(() => {
		if (!tagFilter) { return null; }
		const hit = (data.tags ?? []).find(t => t.tag === tagFilter);
		const list = hit?.paths ?? [];
		if (!list.length) { return null; }
		return new Set(list.map(p => String(p).replace(/\\/g, '/').toLowerCase()));
	}, [tagFilter, data.tags]);

	const libTree = useMemo(() => filterByTag(applySort(refine(data.library ?? [], q), sortKey), tagPathSet), [data.library, q, sortKey, tagPathSet]);
	const noteTree = useMemo(() => filterByTag(applySort(refine(data.tree, q), sortKey), tagPathSet), [data.tree, q, sortKey, tagPathSet]);
	const libTotal = useMemo(() => countOf(libTree), [libTree]);
	const noteTotal = useMemo(() => countOf(noteTree), [noteTree]);

	// 搜索时强制"全展开"：命中项基本都在子目录里，保持折叠会让用户只看到一串文件夹 ✗
	const openSetView = useMemo<ReadonlySet<string>>(
		() => (q ? allFolders([...libTree, ...noteTree], new Set<string>()) : openSet),
		[q, libTree, noteTree, openSet],
	);

	/** 按**真实可见顺序**展平（只走已展开的目录）—— Shift 范围选择靠它取区间 */
	const flatVisible = useMemo(() => {
		const out: string[] = [];
		const walk = (nodes: readonly KbTreeNode[]) => {
			for (const n of nodes) {
				out.push(n.path);
				if (n.isFolder && openSetView.has(n.path)) { walk(n.children ?? []); }
			}
		};
		walk(libTree);
		walk(noteTree);
		return out;
	}, [libTree, noteTree, openSetView]);

	// ── 标签分类：分组 + 筛选（2026-10-23，对齐 IDE sideview）──────────────────
	// 原来 198 个标签平铺成一片 chips ⇒ 根本找不到。改成按 `a/b` 的前缀（没有斜杠就用首字）
	// 分组、组可折叠，再加一个筛选框。
	const [tagQuery, setTagQuery] = useState('');
	// 长尾默认收起（197 个标签里有 148 个只出现 ≤2 次，铺开就是一屏噪音）
	const [closedTagGroups, setClosedTagGroups] = useState<ReadonlySet<string>>(() => new Set<string>(['tail']));
	/**
	 * ★★ 2026-10-24（用户：分类页签不合理）：
	 *   之前按「首字母」分组（A / U / C / 内 / 数 …）—— 那是**检索式**分组，
	 *   对"我想找常用的主题标签"没有任何帮助，反而把 197 个标签切成十几个小格子。
	 *   ⇒ 改成按**使用热度**分三档（这也是标签的价值所在：越常用越是真主题）：
	 *     常用 ≥8 篇 / 一般 3–7 篇 / 长尾 1–2 篇（默认收起，可展开）。
	 *   搜索时三档全部展开，避免"搜到了却被折叠"。
	 */
	const tagGroups = useMemo(() => {
		const q = tagQuery.trim().toLowerCase();
		const buckets: Record<'hot' | 'mid' | 'tail', { tag: string; count: number }[]> = { hot: [], mid: [], tail: [] };
		for (const t of data.tags) {
			if (q && !t.tag.toLowerCase().includes(q)) { continue; }
			const bucket = t.count >= 8 ? 'hot' : t.count >= 3 ? 'mid' : 'tail';
			buckets[bucket].push({ tag: t.tag, count: t.count });
		}
		const labels: Record<'hot' | 'mid' | 'tail', string> = { hot: '常用（≥8 篇）', mid: '一般（3–7 篇）', tail: '长尾（1–2 篇）' };
		return (['hot', 'mid', 'tail'] as const)
			.map(k => ({ key: k as string, label: labels[k], tags: buckets[k].slice().sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, 'zh')) }))
			.filter(g => g.tags.length > 0);
	}, [data.tags, tagQuery]);

	/** Shift + 单击：从 primary 连到目标（锚点 = 最后点的那一项） */
	const onRangeSelect = useCallback((path: string) => {
		const anchor = primary ?? path;
		const a = flatVisible.indexOf(anchor);
		const b = flatVisible.indexOf(path);
		if (a < 0 || b < 0) { setSelected([path]); return; }
		const lo = Math.min(a, b);
		const hi = Math.max(a, b);
		setSelected(flatVisible.slice(lo, hi + 1));
	}, [flatVisible, primary]);

	const onMoveNode = useCallback((fromPaths: readonly string[], toFolder: string) => {
		actions?.moveNodes?.(fromPaths, toFolder);
	}, [actions]);

	/** Ctrl/Cmd 单击：切换某个节点在选中集里的去留（不动 primary 以外的语义） */
	const onToggleSelect = useCallback((path: string) => {
		setSelected(prev => prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]);
	}, []);

	/**
	 * 宿主没有 IDE 编辑区时（插件页 / 工作台面板），正文由本视图右栏显示：
	 * `actions.loadDoc` 有 ⇒ 视为"内嵌阅读"模式 ⇒ 渲染右栏 + 点节点先取正文。
	 */
	/** `base` = 该文档所在目录（绝对）；`path` = 该文档路径（保存时回写用） */
	const [doc, setDoc] = useState<{
		title: string; text: string; base?: string; path?: string; mtime?: number;
		/** 服务端渲染好的 HTML（有它就不走手写渲染器）；`math` 决定是否引入 KaTeX 样式 */
		html?: string; math?: boolean;
		/** 非 Markdown 文件的预览信息（有它就不渲染 Markdown，也不显示「编辑」） */
		asset?: { kind: 'image' | 'pdf' | 'video' | 'audio'; url: string };
	} | null>(null);
	/** 行内编辑草稿（`null` = 不在编辑态） */
	const [draft, setDraft] = useState<string | null>(null);
	/**
	 * 已读过的正文缓存（2026-10-26）：`path → doc`。
	 * 为什么需要：切换笔记时每次都要等一次请求 + 一次整篇 HTML 注入，回来回去就"卡"；
	 * 命中缓存**先上屏**，同时后台按 ETag 再校验一次（304 极便宜），内容变了才替换。
	 */
	const docCacheRef = useRef(new Map<string, { title: string; text: string; html?: string; math?: boolean; base?: string; path?: string; mtime?: number; asset?: { kind: "image" | "pdf" | "video" | "audio"; url: string } }>());
	/** 正在取正文（缓存未命中时给个可见反馈，避免"点了像没反应"） */
	const [docLoading, setDocLoading] = useState(false);

	/*
	 * ★ 2026-10-26（方案 C+D）：右栏改成「多文档 Tab + 极简细条」。
	 *   C 的动机：点树就覆盖当前正文 ⇒ 两篇对照要来回重开（还丢滚动位置）。
	 *     ⇒ 现在每篇开一个 Tab，切回**保留滚动位置与未保存草稿**。
	 *   D 的动机：原来标题行随正文滚动而消失，滚到中段就不知道在看哪篇、也够不到动作。
	 *     ⇒ 细条常驻 28px：折叠面包屑 + 预览/编辑 + ⋯ + 阅读进度线。
	 */
	const [tabs, setTabs] = useState<{ path: string; title: string }[]>([]);
	const [activePath, setActivePath] = useState("");
	/** 每个 Tab 的现场（doc / draft / 滚动位置）；切走时存、切回时还原 */
	const tabSnapRef = useRef(new Map<string, { doc: unknown; draft: string | null; scroll: number }>());
	/** 细条与正文之间要还原的滚动位置（等内容渲染完再滚，否则滚不动） */
	const pendingScrollRef = useRef<number | null>(null);
	const docScrollRef = useRef<HTMLDivElement | null>(null);
	const [docScrollTop, setDocScrollTop] = useState(0);
	const [docProgress, setDocProgress] = useState(0);
	/**
	 * 轻提示（2026-10-27）：双链缺失、复制失败这类反馈**必须看得见**。
	 * 为什么不用 `window.alert`：面板/页面都在宿主 webview 里，alert 可能被静默吞掉，
	 * 用户看到的就是"点了没反应"。改成视图自绘的底部条，三端同一个表现。
	 */
	const [toast, setToast] = useState("");
	const toastTimerRef = useRef(0);
	const showToast = useCallback((msg: string) => {
		setToast(msg);
		window.clearTimeout(toastTimerRef.current);
		toastTimerRef.current = window.setTimeout(() => setToast(""), 4000);
	}, []);

	/** 细条右侧 ⋯ 菜单（完整路径 / 历史 / 资源管理器） */
	const [docMenu, setDocMenu] = useState(false);
	/** 空转的 rAF 标记：滚动时只按帧更新一次状态，避免每像素一次 render */
	const scrollRafRef = useRef(0);


	/** 正文 HTML 容器（mermaid 渲染要往里找块） */
	const docHtmlRef = useRef<HTMLDivElement | null>(null);
	/**
	 * 编辑器状态（2026-10-26）：
	 *   'idle' = 还没进入编辑态 · 'ok' = CodeMirror 已挂上 · 'fail' = 拉不到编辑器脚本 ⇒ 用 textarea
	 * 为什么要三态：编辑器是**按需加载**的独立 bundle；IDE webview 没有那条 HTTP 路由，
	 * 加载必然失败 —— 那时必须**静默退回 textarea**，而不是让用户对着空白框发呆。
	 */
	const [cmState, setCmState] = useState<'idle' | 'ok' | 'fail'>('idle');
	const editorDivRef = useRef<HTMLDivElement | null>(null);
	const editorHandleRef = useRef<{ destroy(): void } | null>(null);

	/**
	 * 保存正文。
	 * 带 `expectedMtime` ⇒ 服务端做前置校验：磁盘已变则回 409，这里弹确认再**强制覆盖**。
	 * （2026-10-24：之前是裸写，IDE 同时开着同一文件时会静默互相覆盖。）
	 */
	const saveDocText = async (path: string, text: string, expectedMtime?: number): Promise<{ ok: boolean; mtime?: number }> => {
		const save = actions?.saveDoc;
		if (!save) { return { ok: false }; }
		let r = await save(path, text, expectedMtime);
		if (r && r.conflict) {
			const go = window.confirm('该笔记已被其他程序修改。\n\n继续覆盖会丢失外部改动（原文件已备份到 笔记/.kb-backup/）。确定覆盖？');
			if (!go) { return { ok: false }; }
			r = await save(path, text);        // 不带 expectedMtime ⇒ 强制写
		}
		if (r && r.ok === false) {
			window.alert('保存失败：' + (r.error || '未知错误'));
			return { ok: false };
		}
		return { ok: true, mtime: r?.mtime };
	};

	/** 拉一次编辑器 bundle（同源；失败就记住失败，别每次重试刷控制台） */
	const ensureEditor = (): Promise<boolean> => new Promise((resolve) => {
		const w = window as unknown as { __KB_EDITOR_MOUNT__?: unknown };
		if (typeof w.__KB_EDITOR_MOUNT__ === 'function') { resolve(true); return; }
		const s = document.createElement('script');
		s.src = '/x/kb/web/kbEditor.js';
		s.onload = () => resolve(true);
		s.onerror = () => resolve(false);
		document.head.appendChild(s);
	});

	/* 进入编辑态 ⇒ 尝试挂 CodeMirror；任何一步失败都退回 textarea */
	useEffect(() => {
		if (draft === null) {
			if (editorHandleRef.current) { try { editorHandleRef.current.destroy(); } catch { /* 忽略 */ } editorHandleRef.current = null; }
			setCmState('idle');
			return;
		}
		let cancelled = false;
		void ensureEditor().then((ok) => {
			if (cancelled) { return; }
			const mount = (window as unknown as { __KB_EDITOR_MOUNT__?: (el: HTMLElement, text: string, o: unknown) => { destroy(): void } }).__KB_EDITOR_MOUNT__;
			if (!ok || typeof mount !== 'function' || !editorDivRef.current) { setCmState('fail'); return; }
			try {
				editorHandleRef.current = mount(editorDivRef.current, draft, {
					onChange: (v: string) => setDraft(v),
					onSave: () => { void commitDraftRef.current?.(); },
					onEscape: () => { setDraft(null); },
				});
				setCmState('ok');
			} catch { setCmState('fail'); }
		});
		return () => {
			cancelled = true;
			if (editorHandleRef.current) { try { editorHandleRef.current.destroy(); } catch { /* 忽略 */ } editorHandleRef.current = null; }
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draft !== null]);

	/** `onSave` 要在 effect 里调用，但 `commitDraft` 定义在下面 ⇒ 用 ref 转一手 */
	const commitDraftRef = useRef<null | (() => Promise<void>)>(null);

	/**
	 * 提交草稿（2026-10-26）：保存按钮与 Ctrl/Cmd+S 共用这一条，
	 * 避免"按钮能存、快捷键另写一份"导致行为分叉。
	 */
	const commitDraft = async () => {
		if (draft === null || !doc?.path) { return; }
		const res = await saveDocText(doc.path, draft, doc.mtime);
		if (res.ok) { setDoc({ ...doc, text: draft, mtime: res.mtime }); setDraft(null); }
	};
	commitDraftRef.current = commitDraft;

	/** 任务清单勾选：翻转该行的 `[ ]` ↔ `[x]` 并写回 */
	const toggleTask = async (lineIndex: number) => {
		if (!doc?.path) { return; }
		const lines = doc.text.replace(/\r\n?/g, '\n').split('\n');
		const line = lines[lineIndex];
		const m = line === undefined ? null : /^(\s*[-*+]\s+)\[([ xX])\](.*)$/.exec(line);
		if (!m) { return; }
		lines[lineIndex] = m[1] + '[' + (m[2].toLowerCase() === 'x' ? ' ' : 'x') + ']' + m[3];
		const next = lines.join('\n');
		const res = await saveDocText(doc.path, next, doc.mtime);
		if (res.ok) { setDoc({ ...doc, text: next, mtime: res.mtime }); }
	};

	/** 备份列表面板（`null` = 收起） */
	const [backups, setBackups] = useState<{ name: string; size: number; mtime: number }[] | null>(null);
	/**
	 * 设置面板（2026-10-24）：dsh 侧没有宿主设置页 ⇒ 视图内自建。
	 * 内容只放**本视图真能生效**的项（库切换 / 排序 / 能力清单 / 诊断），
	 * 不放"点了没反应"的假开关（比如飞书启用状态——那需要宿主配置，dsh 侧只读）。
	 */
	const [showSettings, setShowSettings] = useState(false);
	/**
	 * ★ 2026-10-29（用户：「点设置 / 关系图谱要显示成**带页签**的页面，与打开文档的页签并列」）：
	 *   一个状态管三块内容：文档 / 设置 / 关系图谱。页签条上永远有这两个页签，可点击来回切。
	 */
	const [activeView, setTab] = useState<'doc' | 'settings' | 'graph' | 'canvas'>('doc');
	/**
	 * ★ 2026-10-29（用户：「设置 / 关系图谱页签**只有点击对应按钮**才会打开」）：
	 *   这两个页签**不常驻**在页签条上 —— 只有用户点了 ⚙ / 🕸 才出现；
	 *   回到文档时自动收起（点当前激活的页签也能关掉它）。
	 */
	const [openViews, setOpenViews] = useState<{ settings: boolean; graph: boolean; canvas: boolean }>({ settings: false, graph: false, canvas: false });
	/*
	 * ★ 2026-10-28：**宿主富设置**（飞书同步/目录映射/CLI）也要在「中栏页签」里显示。
	 *   它属于面板层（另一个 React 树）⇒ 这里只给一个空容器，由宿主往里渲染
	 *   （`actions.openHostSettings(el)`；宿主用 react-dom/client 建根）。
	 */
	/** 标题行的「库下拉」（切换 / 新建 / 本地载入） */
	const [vaultMenu, setVaultMenu] = useState(false);
	/**
	 * 待确认「从列表移除」的库 id（2026-10-28）。
	 * 两级确认：第一次点 ✕ 只把这一行变成「确认移除?」，2.5s 自复原或点别的行也复原 ——
	 * 与插件页既有手法一致（Electron 里 `window.confirm` 不可靠，不走它）。
	 */
	const [vaultRemoveAsk, setVaultRemoveAsk] = useState('');
	/** 排序档位 → 中文（菜单里要显示当前值，否则用户不知道现在是哪种排序） */
	const SORT_LABEL: Record<string, string> = {
		name: "名称 ↑", nameDesc: "名称 ↓", size: "大小 ↓", mtime: "时间 ↓", mtimeAsc: "时间 ↑",
	};

	/** 导图覆盖层（三端共用同一份 `KbCanvasPane`） */
	/**
	 * 「笔记」节的一行收纳菜单（2026-10-26 方案 B）。
	 * 原来 9 个按钮平铺在第二行，340px 面板里被压成竖排单字 ⇒ 现在收进 ⋯ 菜单，
	 * 节头只留「排序：名称 ↑ ▾ / ＋ / ⋯」，**永远一行、永不溢出**。
	 */
	const [notesMenu, setNotesMenu] = useState<{ x: number; y: number } | null>(null);

	/**
	 * 复制文本到剪贴板（2026-10-26）。
	 * `navigator.clipboard` 在非安全上下文/无权限时会抛 ⇒ 回退到隐藏 textarea + execCommand，
	 * 保证「复制绝对路径」在三个宿主里都真的生效。
	 */
	const copyText = async (text: string) => {
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				await navigator.clipboard.writeText(text);
				return true;
			}
		} catch { /* 落到兜底 */ }
		try {
			const ta = document.createElement("textarea");
			ta.value = text;
			ta.style.position = "fixed";
			ta.style.opacity = "0";
			document.body.appendChild(ta);
			ta.select();
			const ok = document.execCommand("copy");
			document.body.removeChild(ta);
			return ok;
		} catch { return false; }
	};

	const openHistory = async () => {
		const list = actions?.listBackups;
		if (!list || !doc?.path) { return; }
		const r = await list(doc.path);
		if (!r || r.ok === false) {
			window.alert('读取备份失败：' + ((r && r.error) || '未知错误'));
			return;
		}
		setBackups(r.items ?? []);
	};

	const doRestore = async (name: string) => {
		const restore = actions?.restoreBackup;
		if (!doc?.path || !restore) { return; }
		if (!window.confirm('恢复到「' + name + '」？\n当前内容会先被备份一份，所以恢复本身也可撤销。')) { return; }
		const r = await restore(doc.path, name);
		if (!r || r.ok === false) {
			window.alert('恢复失败：' + ((r && r.error) || '未知错误'));
			return;
		}
		setBackups(null);
		const load = actions?.loadDoc;
		if (load) {
			const d = await load(doc.path);
			if (d) { setDoc({ ...doc, ...d, path: doc.path }); }
		} else {
			window.alert('已恢复，重新打开该笔记即可看到内容');
		}
	};

	/** 编辑框引用（粘贴/拖入附件后要把 Markdown 插到**光标处**） */
	const editorRef = useRef<HTMLTextAreaElement | null>(null);

	/** 粘贴 / 拖入图片 ⇒ 上传到 `笔记/_assets/`，再把 `![](相对路径)` 插到光标位置 */
	const insertAsset = async (file: File) => {
		const up = actions?.uploadAsset;
		if (!up || !doc?.path) {
			window.alert('当前宿主不支持附件上传');
			return;
		}
		const r = await up(file, doc.path);
		if (!r || r.ok === false || !r.rel) {
			window.alert('附件上传失败：' + ((r && r.error) || '未知错误'));
			return;
		}
		const md = `![${file.name.replace(/\.[^.]+$/, '')}](${r.rel})`;
		const cur = draft ?? doc.text;
		const ta = editorRef.current;
		const pos = ta && typeof ta.selectionStart === 'number' ? ta.selectionStart : cur.length;
		setDraft(cur.slice(0, pos) + md + cur.slice(pos));
		// 光标移到插入内容之后（等 React 把新值刷进 textarea）
		setTimeout(() => {
			const el = editorRef.current;
			if (el) { const p = pos + md.length; el.focus(); el.setSelectionRange(p, p); }
		}, 0);
	};
	/**
	 * 视图内对话框（2026-10-24）：Electron 里 `window.prompt` 不可用、`confirm` 也不可靠
	 * ⇒ 改名 / 新建 / 删除确认改由本组件自己弹，宿主只负责执行（`useInlineDialogs` 开关）。
	 */
	const [dialog, setDialog] = useState<
		| { kind: 'rename'; path: string; value: string }
		| { kind: 'newNote' | 'newFolder'; value: string }
		/** 新建知识库（只要名字）/ 本地载入（要文件夹绝对路径） */
		| { kind: 'vaultCreate' | 'vaultAttach'; value: string }
		| { kind: 'delete'; paths: readonly string[] }
		| null
	>(null);

	/**
	 * 在**本视图右栏**里打开一篇正文（2026-10-26）。
	 *
	 * 为什么要有它：文档里的 `[[双链]]` 原来交给宿主 `actions.openLink`，
	 * 而面板那个实现只是 `setDoc(...)` 更新**宿主自己的**状态 —— 界面上显示的却是
	 * 视图内部的 doc ⇒ 用户看到"点了没反应"。这里让视图自己开，宿主只做兜底。
	 */
	const loadIntoView = useCallback((path: string, fallbackName?: string) => {
		const load = actions?.loadDoc;
		if (!load) { return false; }
		const name = fallbackName || String(path).split("/").pop() || path;
		ensureTab(path, name);      // 每次打开正文都确保有对应 Tab
		const kind = assetKindOf(path);
		if (kind && actions?.assetUrl) {
			setDoc({ title: name, text: "", path, asset: { kind, url: actions.assetUrl(path) } });
			return true;
		}
		const cached = docCacheRef.current.get(path);
		if (cached) {
			setDoc(cached);
			void load(path).then(d => {
				if (!d) { return; }
				const next = { ...d, path };
				docCacheRef.current.set(path, next);
				setDoc(prev => (prev && prev.path === path ? next : prev));
			}).catch(() => { /* 后台校验失败沿用缓存 */ });
			return true;
		}
		setDocLoading(true);
		void load(path)
			.then(d => {
				const next = { ...(d ?? { title: name, text: "读取失败：宿主没有返回正文" }), path };
				if (d) { docCacheRef.current.set(path, next); }
				setDoc(next);
			})
			.catch(() => setDoc({ title: name, text: "读取失败", path }))
			.finally(() => setDocLoading(false));
		return true;
	}, [actions]);

	/** `loadIntoView` 的引用（Tab 切换需要它，但它定义在后面） */
	const loadIntoViewRef = useRef<null | ((path: string, name?: string) => boolean)>(null);

	/* 切 Tab 时记下的滚动位置：等内容落到 DOM 再滚（否则容器还没高度，滚了也没用） */
	useEffect(() => {
		const want = pendingScrollRef.current;
		if (want == null) { return; }
		const el = docScrollRef.current;
		if (!el) { return; }
		pendingScrollRef.current = null;
		requestAnimationFrame(() => { el.scrollTop = want; });
	}, [doc?.html, doc?.path]);
	// 每次渲染都刷新一次引用：Tab 切换时用的永远是最新闭包（含最新的 docCache / actions）
	loadIntoViewRef.current = loadIntoView;

	/*
	 * ★★ 2026-10-27（真机反复报「点链接没反应」）—— 兜底监听：
	 *   正文点击本来就由 React 合成事件处理（`.kb-md` 的 onClick）。但在这套
	 *   `customFrame + portal + dangerouslySetInnerHTML` 组合里，合成事件**偶发整条不触发**
	 *   （studio 也遇到过同类问题），表现就是"点了什么都不发生"。
	 *   ⇒ 在 document 冒泡阶段再挂一条：只有 React **没处理**（defaultPrevented === false）时才兜。
	 *   顺序是成立的：React 18 把监听挂在 root 容器上，比 document 更早冒泡；
	 *   只要它处理过就会 preventDefault ⇒ 这条自动跳过，不会重复执行。
	 */
	useEffect(() => {
		const kbClickSafetyNet = (ev: MouseEvent) => {
			if (ev.defaultPrevented) { return; }
			const t0 = ev.target as HTMLElement | null;
			if (!t0 || typeof t0.closest !== 'function' || !t0.closest('.kb-md')) { return; }
			const missing = t0.closest('[data-wiki-missing]');
			if (missing) {
				ev.preventDefault();
				showToast('找不到这篇笔记：' + (missing.getAttribute('data-wiki-missing') || ''));
				return;
			}
			const link = t0.closest('[data-wiki]');
			if (link) {
				ev.preventDefault();
				const p = link.getAttribute('data-wiki');
				if (p && !loadIntoView(p)) { (actions?.openLink ?? actions?.openNode)?.(p); }
				return;
			}
			const a = t0.closest('a[href]') as HTMLAnchorElement | null;
			if (a) {
				const href = String(a.getAttribute('href') || '').trim();
				if (/^(https?:|mailto:)/i.test(href)) { ev.preventDefault(); actions?.openUrl?.(href); }
			}
		};
		document.addEventListener('click', kbClickSafetyNet, false);
		return () => document.removeEventListener('click', kbClickSafetyNet, false);
	}, [actions, loadIntoView, showToast]);

	/** 确保某篇有 Tab 并激活它（已存在则只激活） */
	const ensureTab = useCallback((path: string, title: string) => {
		setTabs(prev => (prev.some(x => x.path === path) ? prev : [...prev, { path, title }]));
		setActivePath(path);
	}, []);

	/** 切到某个 Tab：先存下当前现场，再还原目标现场（没有现场就去加载） */
	const switchTab = useCallback((path: string) => {
		if (path === activePath) { return; }
		setDoc(prev => {
			if (prev && prev.path) {
				tabSnapRef.current.set(prev.path, { doc: prev, draft, scroll: docScrollRef.current ? docScrollRef.current.scrollTop : 0 });
			}
			return prev;
		});
		setDraft(cur => {
			const prevPath = activePath;
			if (prevPath) {
				const snap = tabSnapRef.current.get(prevPath);
				if (snap) { snap.draft = cur; }
			}
			return cur;
		});
		setActivePath(path);
		const snap = tabSnapRef.current.get(path);
		if (snap && snap.doc) {
			setDoc(snap.doc as typeof doc);
			setDraft(snap.draft);
			pendingScrollRef.current = snap.scroll;
			return;
		}
		const title = (tabs.find(x => x.path === path) || { title: fileNameOf(path) }).title;
		loadIntoViewRef.current?.(path, title);
	}, [activePath, draft, tabs]);

	/** 关闭 Tab：删现场；关的是当前 Tab 就切到邻居，全关了就回到空态 */
	const closeTab = useCallback((path: string) => {
		/*
		 * 关掉"正在编辑且有改动"的那篇时要拦一下：Tab 关了就取不回来，
		 * 而草稿只存在内存里（磁盘上还是旧内容）⇒ 静默丢弃等于删了用户的工作。
		 */
		if (path === activePath && draft !== null && doc && typeof doc.text === 'string' && draft !== doc.text) {
			if (!window.confirm('这篇有未保存的修改，关闭标签页会丢弃这些改动。确定关闭？')) { return; }
		}
		tabSnapRef.current.delete(path);
		const idx = tabs.findIndex(x => x.path === path);
		const rest = tabs.filter(x => x.path !== path);
		setTabs(rest);
		if (path !== activePath) { return; }
		const next = rest[Math.min(idx, rest.length - 1)];
		if (!next) {
			setActivePath("");
			setDoc(null);
			setDraft(null);
			return;
		}
		setActivePath(next.path);
		const snap = tabSnapRef.current.get(next.path);
		if (snap && snap.doc) {
			setDoc(snap.doc as typeof doc);
			setDraft(snap.draft);
			pendingScrollRef.current = snap.scroll;
		} else {
			loadIntoViewRef.current?.(next.path, next.title);
		}
	}, [activePath, tabs]);

	/** 细条上的滚动处理：按帧节流，只更新进度与是否显示「回到顶部」 */
	const onDocScroll = useCallback(() => {
		if (scrollRafRef.current) { return; }
		scrollRafRef.current = requestAnimationFrame(() => {
			scrollRafRef.current = 0;
			const el = docScrollRef.current;
			if (!el) { return; }
			const top = el.scrollTop;
			const max = Math.max(1, el.scrollHeight - el.clientHeight);
			setDocScrollTop(top);
			setDocProgress(Math.max(0, Math.min(1, top / max)));
		});
	}, []);

	const onOpenNode = useCallback((node: KbTreeNode) => {
		// 普通单击 = 单选举中（并把选中集收敛成这一项）；目录不改变选中集
		if (!node.isFolder) { setSelected([node.path]); }
		// 有 loadDoc（插件页 / 工作台面板）⇒ 正文在本视图右栏内嵌显示
		// 非 Markdown 文件（图片/PDF/音视频）：`/api/doc` 是文本读取，直接读会报"读取失败"
		// ⇒ 有资源路由就渲染预览，没有就继续走原逻辑（IDE 侧由编辑器接管）
		const kind = node.isFolder ? null : assetKindOf(node.path);
		if (kind && actions?.assetUrl) {
			setDoc({ title: node.name, text: '', path: node.path, asset: { kind, url: actions.assetUrl(node.path) } });
			return;
		}
		const load = actions?.loadDoc;
		if (load && !node.isFolder) {
			loadIntoView(node.path, node.name);
			return;
		}
		actions?.openNode?.(node.path);
	}, [actions]);

	const status = useMemo(() => {
		switch (data.indexState) {
			case 'indexing': return { text: '索引中…', color: c.fgDim };
			case 'stale': return { text: `索引待更新 · ${data.noteCount} 篇`, color: c.fgDim };
			default: return { text: `索引就绪 · ${data.noteCount} 篇`, color: c.fgFaint };
		}
	}, [data.indexState, data.noteCount]);

	/** 有 `loadDoc` ⇒ 内嵌阅读模式：左栏固定 340px，右栏显示正文 */
	const docMode = !!actions?.loadDoc;

	return (
		<div style={{
			display: 'flex', flexDirection: 'row', height: '100%',
			// ★ 2026-10-28（真机：设置页水平方向没占满，文档列只剩 ~95px）：
			//   根行没有宽度 ⇒ 它是**内容宽** ⇒ 340px 的树列把文档列挤到只剩一点点。
			//   ⇒ 根行必须铺满父容器（width:100% + minWidth:0，让内部 flex 去分配剩余空间）。
			width: '100%', minWidth: 0, flex: '1 1 0%',
			// 容器太窄（IDE 窄编辑器组）时**横向滚动**，而不是把正文压成 0 宽
			overflowX: 'auto', overflowY: 'hidden',
			background: c.bg, color: c.fg, fontFamily: 'var(--vscode-font-family, "Segoe UI", sans-serif)',
			fontSize: 13, overflow: 'hidden',
		}}>
			<style>{KB_SCOPED_CSS}</style>
			<div style={{
				display: 'flex', flexDirection: 'column', height: '100%',
				// ★ 2026-10-28（真机：IDE 编辑器被拆成 4 个窄组 ⇒ 页面只有 ~220px 宽）：
				//   树列原本**固定 340px** ⇒ 在窄容器里把文档列挤成 0（设置页只剩一条窄柱）。
				//   ⇒ 树列宽度改为**按容器比例**（200~340px），文档列保底 260px，
				//     容器实在放不下时整行**横向滚动**（而不是把正文压没）。
				flex: docMode ? '0 0 clamp(200px, 34%, 340px)' : '1 1 auto',
				maxWidth: docMode ? 340 : undefined,
				minWidth: 0, minHeight: 0,
			}}>
			{/* 标题栏 */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 35, padding: '0 10px', borderBottom: `1px solid ${c.line}`, flex: '0 0 auto' }}>
				<Svg size={14}><path d="M2 2.5A1.5 1.5 0 0 1 3.5 1H13v14H3.5A1.5 1.5 0 0 1 2 13.5v-11zm2 0v11h8v-11H4z" /></Svg>
				<span style={{ fontSize: 12, fontWeight: 600 }}>知识库</span>
				<span style={{ flex: 1 }} />
				{/*
				 * ★ 2026-10-24（用户：缺少设置入口）：**设置按钮永远有**。
				 *   IDE 侧栏提供 `openSettings` ⇒ 打开宿主设置页（那里有飞书/索引/库路径）。
				 *   dsh 侧没有宿主设置页 ⇒ 打开**本视图内的设置面板**（库切换 / 排序 / 能力清单 / 诊断）。
				 *   之前是"没 openSettings 就不渲染按钮"，用户看到的直接结果是"没有设置入口"。
				 */}
				<IconBtn title="知识库设置" label="⚙" onClick={() => {
					// 宿主提供富设置 ⇒ 在中栏开页签（面板层负责往容器里渲染）
					/*
					 * ★ 2026-10-28（用户要求：设置要在**中栏作为独立页签**，与文档页签同款式）：
					 *   宿主若声明 `preferInlineSettings`，就把设置开成**视图内的页签** ——
					 *   同一个 React 树、没有第二个根，因此不会再出现"跨根渲染整页崩"那类问题。
					 *   完整设置（飞书 / 目录映射）仍可从该页内的入口跳到宿主设置页。
					 */
					// ★ 2026-10-29：设置 = 中栏的**独立页签**（与文档页签并列）
					if (actions?.preferInlineSettings) { setOpenViews(o => ({ ...o, settings: true })); setTab('settings'); return; }
					if (actions?.openSettings) { actions.openSettings(); return; }
					setOpenViews(o => ({ ...o, settings: true }));
					setTab('settings');
				}} />
			</div>

			{/* 库栏 */}
			<div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 8px', borderBottom: `1px solid ${c.line}`, flex: '0 0 auto' }}>
				{/*
				 * ★★ 2026-10-24（用户：有两个「库」页签不合理）：库选择从侧栏的独立「库」节
				 *   **收进标题行下拉**（照 IDE 侧布局）—— 原来那一节与真正的「库」目录节重名，
				 *   同一屏两个"库"必然让人误判。
				 */}
				<button
					type="button"
					onClick={() => setVaultMenu(v => !v)}
					title="切换 / 新建 / 载入知识库"
					style={{
						display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, overflow: 'hidden',
						background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0, maxWidth: '72%',
					}}
				>
					<span style={{ minWidth: 16, height: 16, borderRadius: 3, background: c.badge, color: c.badgeFg, fontSize: 9, fontWeight: 700, display: 'grid', placeItems: 'center' }}>Ns</span>
					<span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{data.vaultName}</span>
					<span style={{ color: c.fgFaint, fontSize: 9 }}>▾</span>
				</button>
				<span style={{ flex: 1 }} />
				{actions?.refresh ? <IconBtn title="刷新" label="⟳" onClick={() => actions?.refresh?.()} /> : null}
				{actions?.openGraph ? <IconBtn title="关系图谱" label="🕸" onClick={() => {
					// ★ 2026-10-29：图谱 = 中栏的**独立页签**（与文档页签并列），
					//   而不是"宿主把它开在右栏"。宿主没有内置图谱时再回退给它。
					setOpenViews(o => ({ ...o, graph: true }));
						setTab('graph');
				}} /> : null}
				{/*
				 * 导图（.canvas）：只有宿主能「就地渲染」时才出现。
				 * 宿主声明 `canvas: true`（服务端有 /api/canvas）⇒ 视图自己画；
				 */}
				{actions?.canvas
					? <IconBtn title="思维导图（.canvas）" label="🗺" onClick={() => { setOpenViews(o => ({ ...o, canvas: true })); setTab('canvas'); }} />
					: null}
				{actions?.feishuSync ? <IconBtn title="同步飞书" label="☁" onClick={() => actions?.feishuSync?.()} /> : null}

				{/* 库下拉：列表 + 新建 + 本地载入（照 IDE 侧「＋ 配置文件夹为知识库…」的位置） */}
				{vaultMenu ? (
					<div
						style={{
							position: 'absolute', left: 6, top: 30, zIndex: 50, minWidth: 240, maxWidth: 320,
							background: 'var(--vscode-menu-background, #252526)', border: `1px solid ${c.line}`,
							borderRadius: 4, boxShadow: '0 8px 24px rgba(0,0,0,.45)', padding: 4,
						}}
					>
						{/* 每一项 = 「切库」按钮 + 「从列表移除」✕（2026-10-28 用户要求） */}
						{(data.vaults ?? []).map(v => {
							const asking = vaultRemoveAsk === v.id;
							const on = v.id === data.activeVaultId;
							return (
								<div
									key={v.id}
									style={{
										display: 'flex', alignItems: 'center', gap: 2, borderRadius: 3,
										background: on ? 'rgba(127,127,127,.18)' : 'transparent',
									}}
								>
									<button
										type="button"
										onClick={() => { setVaultMenu(false); actions?.switchVault?.(v.id); }}
										style={{
											display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0, height: 24,
											padding: '0 8px', background: 'transparent', border: 0, borderRadius: 3,
											color: 'inherit', fontSize: 12, cursor: 'pointer',
										}}
									>
										<span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
										<span style={{ color: c.fgFaint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{v.count}</span>
									</button>
									{actions?.removeVault ? (
										<span
											role="button"
											tabIndex={0}
											title={asking
												? '再点一次：从列表移除（只摘登记，磁盘文件不动）'
												: '从列表移除（不会删除磁盘上的笔记）'}
											aria-label="从列表移除"
											onClick={ev => {
												ev.stopPropagation();
												if (asking) {
													setVaultRemoveAsk('');
													actions.removeVault?.(v.id);
													return;
												}
												setVaultRemoveAsk(v.id);
												setTimeout(() => setVaultRemoveAsk(cur => (cur === v.id ? '' : cur)), 2500);
											}}
											onKeyDown={ev => {
												if (ev.key !== 'Enter') { return; }
												ev.stopPropagation();
												if (asking) { setVaultRemoveAsk(''); actions.removeVault?.(v.id); } else { setVaultRemoveAsk(v.id); }
											}}
											style={{
												flex: '0 0 auto', padding: '0 6px', height: 24, lineHeight: '24px',
												fontSize: asking ? 10.5 : 12, cursor: 'pointer', userSelect: 'none',
												color: asking ? '#e06c75' : c.fgFaint,
											}}
										>{asking ? '确认移除?' : '✕'}</span>
									) : null}
								</div>
							);
						})}
						{/*
						 * ★ 2026-10-28（用户要求：不要「我的知识库」默认库）：
						 *   没有库时不再给一条"看似已就绪"的空库，而是**明说要用户自己选文件夹**。
						 */}
						{(data.vaults ?? []).length === 0 ? (
							<div style={{ padding: '6px 8px', fontSize: 11, color: c.fgFaint, lineHeight: 1.55 }}>
								还没有知识库。用下面的「＋ 本地载入文件夹…」选择一个文件夹作为知识库
								（文件夹名即库名，不会复制或移动里面的文件）。
							</div>
						) : null}
						<div style={{ height: 1, background: c.line, margin: '4px 2px' }} />
						{actions?.addVault ? (
							<>
								<button
									type="button"
									onClick={() => { setVaultMenu(false); setDialog({ kind: 'vaultCreate', value: '' }); }}
									style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 24, padding: '0 8px', background: 'transparent', border: 0, borderRadius: 3, color: 'inherit', fontSize: 12, cursor: 'pointer' }}
								>＋ 新建知识库…</button>
								<button
									type="button"
									onClick={async () => {
										setVaultMenu(false);
										/*
										 * ★ 2026-10-28（用户：导入本地知识库要用**文件夹选择器**）：
										 *   优先走宿主原生对话框（能拿到绝对路径；Electron 32+ 页面里
										 *   `File.path` 已移除，`webkitdirectory` 只有相对路径）。
										 *   宿主没提供 / 调用失败 ⇒ 退回原来的手输框（不丢能力）。
										 */
										if (actions?.pickFolder) {
											try {
												const picked = await actions.pickFolder();
												if (picked) { actions.addVault?.('attach', String(picked)); }
												return;   // 用户取消 ⇒ 直接结束，不再弹手输框
											} catch { /* 落回手输 */ }
										}
										setDialog({ kind: 'vaultAttach', value: '' });
									}}
									style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 24, padding: '0 8px', background: 'transparent', border: 0, borderRadius: 3, color: 'inherit', fontSize: 12, cursor: 'pointer' }}
								>＋ 本地载入文件夹…</button>
							</>
						) : (
							<div style={{ padding: '4px 8px', fontSize: 10.5, opacity: .6 }}>当前宿主不支持新建 / 载入库</div>
						)}
					</div>
				) : null}
			</div>

			{/* 搜索 */}
			<div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderBottom: `1px solid ${c.line}`, flex: '0 0 auto' }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: 6, height: 26, padding: '0 8px', background: c.inputBg, border: `1px solid ${c.line}`, borderRadius: 4 }}>
					<span>🔍</span>
					<input
						value={query}
						placeholder="搜索笔记或库…"
						onChange={e => { setQuery(e.target.value); }}
						style={{ flex: 1, minWidth: 0, border: 'none', outline: 'none', background: 'transparent', color: c.inputFg, fontSize: 12.5 }}
					/>
					{(['fulltext', 'filename'] as const).map(m => (
						<button
							key={m}
							type="button"
							onClick={() => { setMode(m); if (query) { actions?.search?.(query, m); } }}
							style={{
								border: 'none', borderRadius: 3, padding: '1px 6px', fontSize: 10, cursor: 'pointer',
								background: mode === m ? c.sel : 'transparent',
								color: mode === m ? c.selFg : c.fgDim,
							}}
						>{m === 'fulltext' ? '全文' : '文件名'}</button>
					))}
				</div>
			</div>

			{/* 主体 —— 右键委托在这里：靠行的 data-kb-path 反查目标，不必给每个节点传回调 */}
			<div
				style={{ flex: 1, overflowY: 'auto' }}
				onContextMenu={e => {
					const el = (e.target as HTMLElement).closest('[data-kb-path]') as HTMLElement | null;
					const path = el?.dataset.kbPath;
					if (!path) { return; }
					e.preventDefault();
					// 右键落在选中集里（且多于一项）⇒ 作用于整批；否则收敛为这一项
					const paths = selected.includes(path) && selected.length > 1 ? selected : [path];
					if (!selected.includes(path)) { setSelected([path]); }
					setMenu({ x: e.clientX, y: e.clientY, path, paths });
				}}
			>
				{menu && (
					<>
						{/* 点空白关闭（盖一层透明 backdrop，避免全局 listener 泄漏） */}
						<div
							style={{ position: 'fixed', inset: 0, zIndex: 40 }}
							onClick={() => setMenu(null)}
							onContextMenu={e => { e.preventDefault(); setMenu(null); }}
						/>
						<div style={{
							position: 'fixed', left: menu.x, top: menu.y, zIndex: 41, minWidth: 132,
							background: 'var(--vscode-menu-background, #252526)',
							border: `1px solid ${c.line}`, borderRadius: 4, padding: 4,
							boxShadow: '0 4px 16px rgba(0,0,0,.5)', fontSize: 12.5,
						}}>
							{/* 多选时：改名只能一次一个（藏起来），删除作用于整批 */}
							{[
								...(menu.paths.length > 1 ? [] : [{
									label: '重命名',
									run: () => {
										if (actions?.useInlineDialogs) {
											const base = String(menu.path).split('/').pop() ?? '';
											setDialog({ kind: 'rename', path: menu.path, value: base.replace(/\.md$/i, '') });
											return;
										}
										actions?.renameNode?.(menu.path);
									},
								}]),
							// 2026-10-26：右键菜单补齐「复制绝对路径 / 在资源管理器中打开」
							{
								label: '复制绝对路径',
								run: () => {
									const target = (menu.paths && menu.paths[0]) || menu.path || "";
									if (!target) { return; }
									void copyText(target).then(ok => {
										if (!ok) { showToast("复制失败，路径：" + target); }
									});
								},
							},
							// 只有宿主声明了 reveal 才显示（没有就整项不出现，而不是给个空按钮）
							...(actions?.reveal ? [{
								label: '在资源管理器中打开',
								run: () => {
									const target = (menu.paths && menu.paths[0]) || menu.path || "";
									if (target) { actions?.reveal?.(target); }
								},
							}] : []),
								{
									label: menu.paths.length > 1 ? `删除这 ${menu.paths.length} 项` : '删除',
									run: () => {
										if (actions?.useInlineDialogs) { setDialog({ kind: 'delete', paths: menu.paths }); return; }
										actions?.deleteNodes?.(menu.paths);
									},
								},
							].map(item => (
								<div
									key={item.label}
									role="menuitem"
									tabIndex={0}
									onClick={() => { setMenu(null); item.run(); }}
									onKeyDown={e => { if (e.key === 'Enter') { setMenu(null); item.run(); } }}
									style={{ display: 'flex', alignItems: 'center', height: 24, padding: '0 8px', borderRadius: 3, cursor: 'pointer' }}
									onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = c.hover; }}
									onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = 'transparent'; }}
								>{item.label}</div>
							))}
						</div>
					</>
				)}
				{/* 全文检索结果（仅当宿主支持并返回了结果） */}
				{results && (
					<div style={{ borderBottom: `1px solid ${c.line}` }}>
						<SectionHeader title="检索结果" count={String(results.length)} expanded onToggle={() => { }} />
						<div style={{ padding: '0 10px 8px' }}>
							{results.length === 0 && (
								<div style={{ color: c.fgFaint, fontSize: 11.5 }}>没有命中「{query.trim()}」</div>
							)}
							{results.map(r => (
								<div key={r.path} onClick={() => actions?.openNode?.(r.path)}
									style={{ padding: '3px 0', cursor: 'pointer' }}>
									<div style={{ fontSize: 12, color: c.fg }}>{highlightMatch(r.title, query)}</div>
									{r.snippet && (
										<div style={{ fontSize: 11, color: c.fgFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
											{highlightMatch(r.snippet, query)}
										</div>
									)}
								</div>
							))}
						</div>
					</div>
				)}

				{/* 库（原料区）—— IDE sideview 的主体第二块，React 版原先缺这一节 */}
				<div className="kb-sec" style={{ borderBottom: '1px solid #2b2b2b' }}>
					<SectionHeader
						title="库"
						count={String(libTotal)}
						expanded={expanded.library}
						onToggle={() => toggle('library')}
						onDropRoot={paths => onMoveNode(paths, '库')}
					/>
					{expanded.library && libTree.map(node => (
						<TreeRow key={node.path} node={node} depth={0} selectedPaths={selected} openSet={openSetView} onOpen={onOpenNode} onMove={onMoveNode}
							onToggleSelect={onToggleSelect} onToggleOpen={onToggleOpen} onRangeSelect={onRangeSelect} />
					))}
				</div>

				{/* 笔记 */}
				<div className="kb-sec" style={{ borderBottom: '1px solid #2b2b2b' }}>
					<SectionHeader
						title="笔记"
						count={String(noteTotal)}
						expanded={expanded.notes}
						onToggle={() => toggle('notes')}
						onDropRoot={paths => onMoveNode(paths, '笔记')}
						extra={
							/*
							 * ★ 2026-10-26（方案 B · 单行收纳）：
							 *   节头一行放完：排序（当前值可点开菜单）+ 新建笔记 + ⋯（体检/查重/审核/导图/新建目录）。
							 *   刻意**不放** 4 个独立图标 —— 340px 面板里放不下，历史上就被压成竖排单字。
							 */
							<span style={{ display: "flex", alignItems: "center", gap: 4, flex: "0 0 auto", whiteSpace: "nowrap" }}>
								<button
									type="button"
									title="排序（点击选择）与更多操作"
									onClick={e => {
										e?.stopPropagation?.();
										const r = (e?.currentTarget as HTMLElement)?.getBoundingClientRect?.();
										setNotesMenu({ x: Math.max(8, (r ? r.right : 200) - 208), y: (r ? r.bottom : 100) + 4 });
									}}
									style={{
										height: 20, padding: "0 6px", fontSize: 10.5, cursor: "pointer", borderRadius: 3, flex: "0 0 auto",
										background: "transparent", color: c.fgDim, border: `1px solid ${c.line}`, whiteSpace: "nowrap",
									}}
								>
									{/* ⇅ 比「排序：」三个字省 ~28px，窄面板更稳（2026-10-27） */}
									<span style={{ marginRight: 3, opacity: .85 }}>⇅</span>{SORT_LABEL[sortKey] ?? "名称 ↑"} ▾
								</button>
								<IconBtn title="新建笔记" label="＋" onClick={e => {
									e?.stopPropagation?.();
									if (actions?.useInlineDialogs) { setDialog({ kind: "newNote", value: "未命名笔记" }); return; }
									actions?.createNote?.("");
								}} />
								<IconBtn title="更多（新建目录 / 体检 / 查重 / 审核 / 导图 / 排序）" label="⋯" onClick={e => {
									e?.stopPropagation?.();
									const r = (e?.currentTarget as HTMLElement)?.getBoundingClientRect?.();
									setNotesMenu({ x: Math.max(8, (r ? r.right : 200) - 208), y: (r ? r.bottom : 100) + 4 });
								}} />
							</span>
						}
					/>
					{/*
					 * 「笔记」节的 ⋯ 菜单（方案 B）。数据全部来自已有动作 ⇒ 不新增后端；
					 * 每个条目仍按**能力**显示（宿主没提供就不出现，绝不留死按钮）。
					 */}
					{notesMenu && (
						<>
							<div
								data-kb-notes-menu-backdrop="1"
								onClick={() => setNotesMenu(null)}
								onContextMenu={e => { e.preventDefault(); setNotesMenu(null); }}
								style={{ position: "fixed", inset: 0, zIndex: 40 }}
							/>
							<div
								data-kb-notes-menu="1"
								style={{
									position: "fixed", left: notesMenu.x, top: notesMenu.y, zIndex: 41, minWidth: 208,
									background: "var(--vscode-menu-background, #252526)", border: `1px solid ${c.line}`,
									borderRadius: 4, padding: 4, boxShadow: "0 4px 16px rgba(0,0,0,.5)", fontSize: 12.5,
								}}
							>
								{[
									{ label: "新建笔记", run: () => { if (actions?.useInlineDialogs) { setDialog({ kind: "newNote", value: "未命名笔记" }); return; } actions?.createNote?.(""); }, show: true },
									{ label: "新建目录", run: () => { if (actions?.useInlineDialogs) { setDialog({ kind: "newFolder", value: "新目录" }); return; } actions?.newFolder?.(""); }, show: true },
									{ label: "体检", run: () => actions?.runLint?.(), show: !!actions?.runLint },
									{ label: "查重", run: () => actions?.runDedup?.(), show: !!actions?.runDedup },
									{ label: "审核", run: () => actions?.reviewQueue?.(), show: !!actions?.reviewQueue },
									{ label: "思维导图", run: () => { setOpenViews(o => ({ ...o, canvas: true })); setTab('canvas'); }, show: !!actions?.canvas },
								].filter(item => item.show).map(item => (
									<div
										key={item.label}
										role="menuitem"
										tabIndex={0}
										onClick={() => { setNotesMenu(null); item.run(); }}
										onKeyDown={e => { if (e.key === "Enter") { setNotesMenu(null); item.run(); } }}
										style={{ display: "flex", alignItems: "center", height: 24, padding: "0 8px", borderRadius: 3, cursor: "pointer" }}
										onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = c.hover; }}
										onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = "transparent"; }}
									>{item.label}</div>
								))}
								<div style={{ height: 1, background: c.line, margin: "4px 6px" }} />
								<div style={{ padding: "2px 8px 3px", fontSize: 10.5, color: c.fgFaint }}>排序</div>
								{(Object.keys(SORT_LABEL) as string[]).map(k => (
									<div
										key={k}
										role="menuitemradio"
										aria-checked={sortKey === k}
										tabIndex={0}
										onClick={() => { setSortKey(k as Parameters<typeof setSortKey>[0]); setNotesMenu(null); }}
										onKeyDown={e => { if (e.key === "Enter") { setSortKey(k as Parameters<typeof setSortKey>[0]); setNotesMenu(null); } }}
										style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px", borderRadius: 3, cursor: "pointer" }}
										onMouseEnter={ev => { (ev.currentTarget as HTMLElement).style.background = c.hover; }}
										onMouseLeave={ev => { (ev.currentTarget as HTMLElement).style.background = "transparent"; }}
									>
										<span style={{ width: 10, color: c.selFg }}>{sortKey === k ? "✓" : ""}</span>
										{SORT_LABEL[k]}
									</div>
								))}
							</div>
						</>
					)}

					{expanded.notes && noteTree.map(node => (
						<TreeRow key={node.path} node={node} depth={0} selectedPaths={selected} openSet={openSetView} onOpen={onOpenNode} onMove={onMoveNode}
							onToggleSelect={onToggleSelect} onToggleOpen={onToggleOpen} onRangeSelect={onRangeSelect} />
					))}
				</div>

				{/* 标签 */}
				<div className="kb-sec" style={{ borderBottom: '1px solid #2b2b2b' }}>
					<SectionHeader title="标签分类" count={String(data.tags.length)} expanded={expanded.tags} onToggle={() => toggle('tags')} />
					{expanded.tags && (
						<div style={{ padding: '4px 10px 8px' }}>
							{/* 筛选状态条：点标签后这里会亮出「筛选：#xxx ×」，否则用户不知道树为什么变短了 */}
							{tagFilter ? (
								<div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5, fontSize: 11, color: c.fgDim }}>
									<span>筛选：#{tagFilter}</span>
									{!tagPathSet ? <span style={{ opacity: .6 }}>（该标签没有路径信息，未筛树）</span> : null}
									<button
										type="button"
										onClick={() => setTagFilter(null)}
										style={{ height: 18, padding: '0 6px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}
									>清除</button>
								</div>
							) : null}
							<input
								value={tagQuery}
								onChange={e => setTagQuery(e.target.value)}
								placeholder="筛选标签…"
								style={{
									width: '100%', height: 22, boxSizing: 'border-box', padding: '0 6px', marginBottom: 6,
									background: c.inputBg, color: c.inputFg, border: `1px solid ${c.line}`, borderRadius: 3, fontSize: 11.5,
								}}
							/>
							{tagGroups.length === 0 && (
								<div style={{ fontSize: 11, color: c.fgFaint }}>没有匹配的标签</div>
							)}
							{tagGroups.map(g => {
								// 搜索时三档全部展开（否则"搜到了却看不到"）
								const closed = !tagQuery.trim() && closedTagGroups.has(g.key);
								return (
									<div key={g.key} style={{ marginBottom: 4 }}>
										<div
											role="button"
											tabIndex={0}
											onClick={() => setClosedTagGroups(prev => {
												const next = new Set(prev);
												if (next.has(g.key)) { next.delete(g.key); } else { next.add(g.key); }
												return next;
											})}
											onKeyDown={e => { if (e.key === 'Enter') { setClosedTagGroups(prev => new Set(prev).add(g.key)); } }}
											style={{ display: 'flex', alignItems: 'center', gap: 4, height: 18, cursor: 'pointer', fontSize: 10.5, color: c.fgFaint, userSelect: 'none' }}
										>
											<span style={{ width: 9, fontSize: 9 }}>{closed ? '▸' : '▾'}</span>
											<span style={{ fontWeight: 700, letterSpacing: '.03em' }}>{g.label}</span>
											<span>{g.tags.length}</span>
										</div>
										{!closed && (
											<div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, paddingTop: 3 }}>
												{g.tags.map(t => (
													<button
														key={t.tag}
														type="button"
														onClick={() => {
															// 本地筛选（三宿主通用）+ 通知宿主（IDE 侧可能还有自己的联动）
															setTagFilter(prev => (prev === t.tag ? null : t.tag));
															actions?.pickTag?.(t.tag);
														}}
														title={tagFilter === t.tag ? '再点一次取消筛选' : ('筛选出带 #' + t.tag + ' 的笔记')}
														style={{
															display: 'flex', alignItems: 'center', gap: 4, height: 21, padding: '0 7px',
															background: tagFilter === t.tag ? 'var(--vscode-button-background, #0e639c)' : '#2a2d2e',
															border: '1px solid ' + (tagFilter === t.tag ? 'transparent' : '#383838'),
															borderRadius: 11, fontSize: 11,
															color: tagFilter === t.tag ? 'var(--vscode-button-foreground, #fff)' : '#c8c8c8',
															cursor: 'pointer',
														}}
													>#{t.tag}<span style={{ fontSize: 9.5, color: c.fgFaint }}>{t.count}</span></button>
												))}
											</div>
										)}
									</div>
								);
							})}
							{data.untaggedCount ? (
								<span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 21, padding: '0 7px', border: '1px dashed #555', borderRadius: 11, fontSize: 11, color: c.fgDim, marginTop: 4 }}>
									未标签<span style={{ fontSize: 9.5, color: c.fgFaint }}>{data.untaggedCount}</span>
								</span>
							) : null}
						</div>
					)}
				</div>

				{/* 双链 */}
				{(outLinks?.length || inLinks?.length) ? (
					<div>
						<SectionHeader
							title="双链"
							count={`出 ${outLinks?.length ?? 0} · 反 ${inLinks?.length ?? 0}`}
							expanded={expanded.links}
							onToggle={() => toggle('links')}
						/>
						{expanded.links && (
							<div style={{ padding: '2px 10px 8px' }}>
								{(outLinks?.length ?? 0) > 0 && (
									<>
										<div style={{ color: c.fgFaint, fontSize: 11, marginBottom: 2 }}>出链（当前笔记）</div>
										{outLinks!.map(l => (
											<div key={l.path} onClick={() => actions?.openLink?.(l.path)}
												style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: c.link, cursor: 'pointer', padding: '1px 0' }}>
												🕸 {l.title}
											</div>
										))}
									</>
								)}
								{(inLinks?.length ?? 0) > 0 && (
									<>
										<div style={{ color: c.fgFaint, fontSize: 11, margin: '6px 0 2px' }}>反链（被引用）</div>
										{inLinks!.map(l => (
											<div key={l.path} onClick={() => actions?.openLink?.(l.path)}
												style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: c.link, cursor: 'pointer', padding: '1px 0' }}>
												🕸 {l.title}
											</div>
										))}
									</>
								)}
							</div>
						)}
					</div>
				) : null}
			</div>

			{/* 底栏 */}
			<div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 10px', background: '#1a1a1a', borderTop: `1px solid ${c.line}`, fontSize: 11, color: status.color, flex: '0 0 auto' }}>
				<span style={{ width: 6, height: 6, borderRadius: '50%', background: data.indexState === 'indexing' ? c.fgDim : c.ok }} />
				<span>{status.text} · b1644{debug ? ' · ' + debug : ''}</span>
			</div>
			</div>

			{/* 右栏：内嵌正文（插件页 / 工作台面板没有 IDE 编辑区时用它，见 docMode） */}
			{docMode ? (
				/*
				 * ★ 2026-10-26（方案 C+D）：外层**不再滚动**，改成「Tab 条 / 细条 / 滚动区」三段。
				 *   之前整个右栏是一个 overflow:auto 容器 ⇒ 标题行跟着正文滚走（滚到中段不知道在看哪篇、
				 *   也够不到「编辑/历史」）。现在顶部两段固定，只有正文滚动。
				 */
				<div style={{
					flex: '1 1 auto', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column',
					borderLeft: `1px solid ${c.line}`, position: 'relative',
					// ★ 2026-10-28（真机：窄容器里文档列被压成 0 宽）⇒ 保底宽度，放不下就横向滚
					minWidth: 260,
					// 与空态/正文同一个底色：否则空态、正文、容器三段会拼出竖缝（2026-10-28 用户截图）
					background: 'var(--vscode-editor-background, #1e1e1e)',
				}}>
					{(doc || activeView !== 'doc') ? (
						<>
							{/* ── C：多文档 Tab（每篇保留滚动位置与草稿）────────────── */}
							<div
								data-kb-tabs="1"
								style={{ display: 'flex', alignItems: 'stretch', height: 30, flex: '0 0 auto', overflowX: 'auto', overflowY: 'hidden', whiteSpace: 'nowrap', background: 'rgba(127,127,127,.06)', borderBottom: `1px solid ${c.line}` }}
							>
								{tabs.map(t => {
									const on = activeView === 'doc' && t.path === activePath;   // ★ 2026-10-29：切到设置/图谱时，文档页签不许再高亮
									/*
									 * ★ 2026-10-28（真机：点设置整页黑屏，CDP 抓到
									 *   `TypeError: Cannot read properties of null (reading 'path')`）：
									 *   页签条原先只在 `doc ? (…)` 里渲染，所以这里可以直接读 `doc.path`；
									 *   设置页签把它挪到了 `doc || showSettings || hostSettingsOpen` 之下 ⇒
									 *   **`doc` 为 null 时也会渲染**，这一行当场抛错，整棵 bundle 根被卸载 ⇒ 黑屏。
									 *   ⇒ 判空前先确认 `doc` 存在。
									 */
									const dirty = !!doc && on && draft !== null && doc.path === t.path && draft !== doc.text;
									return (
										<div
											key={t.path}
											role="tab"
											tabIndex={0}
											aria-selected={on}
											title={t.path}
											onClick={() => { setTab('doc'); setOpenViews({ settings: false, graph: false, canvas: false }); switchTab(t.path); }}
											onKeyDown={e => { if (e.key === "Enter") { switchTab(t.path); } }}
											style={{
												display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto", maxWidth: 190,
												padding: "0 8px 0 10px", fontSize: 11.5, cursor: "pointer",
												color: on ? c.fg : c.fgDim,
												background: on ? "var(--vscode-editor-background, #1e1e1e)" : "transparent",
												borderRight: `1px solid ${c.line}`,
												boxShadow: on ? "inset 0 2px 0 var(--vscode-focusBorder, #3794ff)" : "none",
											}}
										>
											{dirty ? <span title="有未保存修改" style={{ width: 6, height: 6, borderRadius: "50%", background: "#d29922", flex: "0 0 auto" }} /> : null}
											<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
											<span
												role="button"
												tabIndex={0}
												title="关闭"
												aria-label="关闭"
												onClick={ev => { ev.stopPropagation(); closeTab(t.path); }}
												onKeyDown={ev => { if (ev.key === "Enter") { ev.stopPropagation(); closeTab(t.path); } }}
												style={{ opacity: .55, fontSize: 13, lineHeight: 1, flex: "0 0 auto" }}
											>×</span>
										</div>
									);
								})}
								{/* ★ 2026-10-29：设置 / 关系图谱 = 与文档页签**并列**的两个页签（可点击切换） */}
									{openViews.settings ? (
										<div
											data-kb-settings-tab="1"
									role="tab"
									aria-selected={activeView === 'settings'}
									title="知识库设置"
									onClick={() => {
										// 再点一次 = 关闭（回到文档）
										if (activeView === 'settings') { setTab('doc'); setOpenViews(o => ({ ...o, settings: false })); return; }
										setTab('settings');
									}}
									style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', padding: '0 10px', fontSize: 11.5, cursor: 'pointer', color: activeView === 'settings' ? c.fg : c.fgDim, background: activeView === 'settings' ? 'var(--vscode-editor-background, #1e1e1e)' : 'transparent', borderRight: `1px solid ${c.line}`, boxShadow: activeView === 'settings' ? 'inset 0 2px 0 var(--vscode-focusBorder, #3794ff)' : 'none' }}
								>⚙ 设置</div>
									) : null}
									{openViews.graph ? (
										<div
											data-kb-graph-tab="1"
									role="tab"
									aria-selected={activeView === 'graph'}
									title="关系图谱"
									onClick={() => {
										if (activeView === 'graph') { setTab('doc'); setOpenViews(o => ({ ...o, graph: false })); return; }
										setTab('graph');
									}}
									style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', padding: '0 10px', fontSize: 11.5, cursor: 'pointer', color: activeView === 'graph' ? c.fg : c.fgDim, background: activeView === 'graph' ? 'var(--vscode-editor-background, #1e1e1e)' : 'transparent', borderRight: `1px solid ${c.line}`, boxShadow: activeView === 'graph' ? 'inset 0 2px 0 var(--vscode-focusBorder, #3794ff)' : 'none' }}
								>🕸 关系图谱</div>
									) : null}
										{openViews.canvas ? (
											<div
												data-kb-canvas-tab="1"
												role="tab"
												aria-selected={activeView === 'canvas'}
												title="思维导图"
												onClick={() => {
													if (activeView === 'canvas') { setTab('doc'); setOpenViews(o => ({ ...o, canvas: false })); return; }
													setTab('canvas');
												}}
												style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', padding: '0 10px', fontSize: 11.5, cursor: 'pointer', color: activeView === 'canvas' ? c.fg : c.fgDim, background: activeView === 'canvas' ? 'var(--vscode-editor-background, #1e1e1e)' : 'transparent', borderRight: `1px solid ${c.line}`, boxShadow: activeView === 'canvas' ? 'inset 0 2px 0 var(--vscode-focusBorder, #3794ff)' : 'none' }}
											>🗺 思维导图</div>
										) : null}
							</div>

							{/* ── D：极简细条（28px）：折叠面包屑 + 预览/编辑 + ⋯ + 进度 ── */}
							{activeView === 'doc' ? (<>
							<div
								data-kb-docbar="1"
								style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, height: 28, flex: '0 0 auto', padding: '0 6px 0 10px', whiteSpace: 'nowrap', overflow: 'hidden', background: 'rgba(127,127,127,.03)', borderBottom: `1px solid ${c.line}` }}
							>
								<span role="button" tabIndex={0} title="完整路径 / 更多操作" onClick={() => setDocMenu(v => !v)}
									onKeyDown={e => { if (e.key === "Enter") { setDocMenu(v => !v); } }}
									style={{ cursor: "pointer", color: c.fgFaint, flex: "0 0 auto" }}>…</span>
								<span style={{ color: c.fgFaint, flex: "0 0 auto" }}>/</span>
								<span style={{ color: c.fgFaint, flex: "0 0 auto", maxWidth: 110, overflow: "hidden", textOverflow: "ellipsis" }}>{parentNameOf(doc?.path)}</span>
								<span style={{ color: c.fgFaint, flex: "0 0 auto" }}>/</span>
								<span style={{ color: c.fg, flex: "0 1 auto", overflow: "hidden", textOverflow: "ellipsis" }}>{fileNameOf(doc?.path) || doc?.title}</span>
								<span style={{ flex: 1 }} />
								{docLoading ? <span style={{ fontSize: 10.5, color: c.fgFaint, flex: "0 0 auto" }}>载入中…</span> : null}
								{draft !== null ? (
									<span style={{ fontSize: 10.5, flex: "0 0 auto", color: draft === doc?.text ? c.fgFaint : "#d29922" }}>
										{draft === doc?.text ? "未修改" : "● 未保存"}
									</span>
								) : null}
								{!doc?.asset && actions?.saveDoc && doc?.path ? (
									<span data-kb-mode="1" style={{ display: "flex", border: `1px solid ${c.line}`, borderRadius: 3, overflow: "hidden", flex: "0 0 auto" }}>
										<button type="button" title="预览" onClick={() => { if (draft !== null) { setDraft(null); } }}
											style={{ height: 18, padding: "0 7px", fontSize: 10.5, border: 0, cursor: "pointer", background: draft === null ? "var(--vscode-button-background, #0e639c)" : "transparent", color: draft === null ? "var(--vscode-button-foreground, #fff)" : c.fgDim }}>预览</button>
										<button type="button" title="编辑 Markdown 源码" onClick={() => { if (draft === null) { setDraft(doc?.text); } }}
											style={{ height: 18, padding: "0 7px", fontSize: 10.5, border: 0, cursor: "pointer", background: draft !== null ? "var(--vscode-button-background, #0e639c)" : "transparent", color: draft !== null ? "var(--vscode-button-foreground, #fff)" : c.fgDim }}>编辑</button>
									</span>
								) : null}
								<button type="button" title="更多（完整路径 / 历史 / 资源管理器）" onClick={() => setDocMenu(v => !v)}
									style={{ width: 22, height: 20, flex: "0 0 auto", border: 0, borderRadius: 3, background: "transparent", color: c.fgDim, cursor: "pointer" }}>⋯</button>
								{/* 阅读进度：贴细条底边，越长越满 */}
								<div style={{ position: "absolute", left: 0, bottom: -1, height: 2, width: Math.round(docProgress * 100) + "%", background: "var(--vscode-focusBorder, #3794ff)", opacity: .75, pointerEvents: "none" }} />
								{docMenu ? (
									<>
										<div onClick={() => setDocMenu(false)} onContextMenu={e => { e.preventDefault(); setDocMenu(false); }} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
										<div style={{ position: "absolute", right: 4, top: 26, zIndex: 41, minWidth: 240, background: "var(--vscode-menu-background, #252526)", border: `1px solid ${c.line}`, borderRadius: 4, padding: 4, boxShadow: "0 4px 16px rgba(0,0,0,.5)", fontSize: 11.5 }}>
											<div style={{ padding: "4px 8px", color: c.fgFaint, wordBreak: "break-all", lineHeight: 1.5 }}>{doc?.path || "(无路径)"}</div>
											<div style={{ height: 1, background: c.line, margin: "4px 6px" }} />
											{actions?.listBackups && doc?.path && !doc?.asset ? (
												<div role="menuitem" tabIndex={0} onClick={() => { setDocMenu(false); if (backups) { setBackups(null); } else { void openHistory(); } }}
													style={{ height: 24, display: "flex", alignItems: "center", padding: "0 8px", borderRadius: 3, cursor: "pointer" }}>{backups ? "收起历史备份" : "历史备份"}</div>
											) : null}
											{actions?.reveal && doc?.path ? (
												<div role="menuitem" tabIndex={0} onClick={() => { setDocMenu(false); actions?.reveal?.(doc?.path as string); }}
													style={{ height: 24, display: "flex", alignItems: "center", padding: "0 8px", borderRadius: 3, cursor: "pointer" }}>在资源管理器中打开</div>
											) : null}
										</div>
									</>
								) : null}
							</div>

							{/* ── 正文滚动区（只有它滚；Tab/细条固定）──────────────── */}
							<div ref={docScrollRef} onScroll={onDocScroll} style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '12px 18px 72px', position: 'relative' }}>
							{/* 标题行：右端「编辑 / 保存·取消」——只有宿主提供 saveDoc 时才出现 */}
							{/*
							 * 文档头（C+D 之后）：模式切换与「历史」已经移到顶部细条（预览/编辑 + ⋯），
							 * 这里只留**身份信息**与**编辑态的两个必答动作**（保存 / 取消）。
							 * 重复的按钮会让"该点哪个"变成新的问题。
							 */}
							<div style={{ marginBottom: 10 }}>
								<div style={{ fontSize: 17, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
									{doc?.title}
								</div>
								<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, fontSize: 10.5, color: c.fgFaint }}>
									{!doc?.asset && doc?.path ? <span>{(doc?.path.split('/').pop() || '')}</span> : null}
									{draft !== null
										? <span>{draft.length} 字{draft === doc?.text ? '' : ' · 未保存'}</span>
										: (doc?.text ? <span>{doc?.text.length} 字</span> : null)}
									<span style={{ flex: 1 }} />
									{draft !== null && !doc?.asset ? (
										<>
											<button type="button" onClick={() => { void commitDraft(); }}
												style={{ height: 22, padding: '0 10px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)', border: '1px solid transparent' }}>保存</button>
											<button type="button" onClick={() => { if (draft !== doc?.text && !window.confirm('放弃未保存的修改？')) { return; } setDraft(null); }}
												style={{ height: 22, padding: '0 10px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>取消</button>
										</>
									) : null}
								</div>
							</div>

							{/* 备份列表：保存时自动生成（`笔记/.kb-backup/`），这里只读列出 + 恢复 */}
							{backups ? (
								<div style={{ marginBottom: 10, border: `1px solid ${c.line}`, borderRadius: 4, maxHeight: 220, overflow: 'auto' }}>
									{backups.length === 0 ? (
										<div style={{ padding: '8px 10px', fontSize: 11.5, opacity: .6 }}>还没有备份（本页保存或恢复过一次后才会产生）</div>
									) : backups.map(b => (
										<div key={b.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderTop: `1px solid ${c.line}`, fontSize: 11.5 }}>
											<span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
											<span style={{ opacity: .55, flex: '0 0 auto' }}>{new Date(b.mtime).toLocaleString()}</span>
											<button type="button" onClick={() => { void doRestore(b.name); }}
												style={{ flex: '0 0 auto', height: 20, padding: '0 8px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>恢复</button>
										</div>
									))}
								</div>
							) : null}
							{doc?.asset ? (
								<div style={{ padding: '4px 0' }}>
									{doc?.asset.kind === 'image'
										? <img src={doc?.asset.url} alt={doc?.title} style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid rgba(127,127,127,.25)', display: 'block' }} />
										: doc?.asset.kind === 'pdf'
											? <embed src={doc?.asset.url} type="application/pdf" style={{ width: '100%', height: 560, border: '1px solid rgba(127,127,127,.35)', borderRadius: 4 }} />
											: doc?.asset.kind === 'video'
												? <video src={doc?.asset.url} controls style={{ maxWidth: '100%', borderRadius: 4 }} />
												: <audio src={doc?.asset.url} controls style={{ width: '100%' }} />}
									<div style={{ marginTop: 6, fontSize: 11, opacity: .55 }}>{doc?.asset.url}</div>
								</div>
							) : draft !== null ? (
								<>
									{/* 编辑器挂载点：拉到 kbEditor.js 后由它接管；失败时这块保持隐藏 */}
									<div
										ref={editorDivRef}
										data-kb-editor="cm"
										style={{ display: cmState === 'ok' ? 'block' : 'none', minHeight: 420, border: `1px solid ${c.line}`, borderRadius: 4, overflow: 'hidden' }}
									/>
									{cmState === 'ok' ? null : (
								<textarea
									ref={editorRef}
									value={draft}
									onChange={e => setDraft(e.target.value)}
									spellCheck={false}
									/* 粘贴 / 拖入图片 ⇒ 上传并插入 Markdown（宿主没有 uploadAsset 时不拦截） */
									onPaste={e => {
										if (!actions?.uploadAsset) { return; }
										const img = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith('image/'));
										if (img) { e.preventDefault(); void insertAsset(img); }
									}}
									onDragOver={e => { if (actions?.uploadAsset) { e.preventDefault(); } }}
									onDrop={e => {
										if (!actions?.uploadAsset) { return; }
										const img = Array.from(e.dataTransfer?.files ?? []).find(f => f.type.startsWith('image/'));
										if (img) { e.preventDefault(); void insertAsset(img); }
									}}
									/*
									 * 键盘行为（2026-10-26）：编辑态没有任何快捷键时，用户会以为"这编辑器是半成品"。
									 * 只加四条最基本、且**不会与浏览器/宿主冲突**的：
									 *   Ctrl/Cmd+S 保存 · Esc 取消 · Tab 缩进两空格 · Enter 续写列表
									 */
									onKeyDown={e => {
										const el = e.currentTarget;
										if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
											e.preventDefault();
											void commitDraft();
											return;
										}
										if (e.key === 'Escape') {
											e.preventDefault();
											if (draft !== doc?.text && !window.confirm('放弃未保存的修改？')) { return; }
											setDraft(null);
											return;
										}
										if (e.key === 'Tab') {
											e.preventDefault();
											const start = el.selectionStart ?? 0;
											const end = el.selectionEnd ?? 0;
											const r = indentAt(draft, start, end);
											setDraft(r.next);
											requestAnimationFrame(() => { el.selectionStart = r.start; el.selectionEnd = r.end; });
											return;
										}
										if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
											const caret = el.selectionStart ?? 0;
											const r = continueMarkdownList(draft, caret);
											if (r) {
												e.preventDefault();
												setDraft(r.next);
												requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = r.caret; });
											}
										}
									}}
									style={{
										width: '100%', minHeight: 420, boxSizing: 'border-box', resize: 'vertical',
										padding: '8px 10px', background: c.inputBg, color: c.inputFg, border: `1px solid ${c.line}`,
										borderRadius: 4, fontSize: 12.5, lineHeight: 1.7,
										fontFamily: 'var(--vscode-editor-font-family, monospace)',
									}}
								/>
									)}
								</>
							) : (
								<div style={{ opacity: .95 }}>
									{/*
									 * ★ 2026-10-25：**优先用服务端渲染的 HTML**（markdown-it + Obsidian 方言）。
									 *   宿主给了 `html` ⇒ 直接注入，并靠事件委托处理双链点击与任务勾选；
									 *   没给（IDE 侧）⇒ 回落到下面的手写渲染器，行为不变。
									 */}
{/*
							 * ★★ 2026-10-28（真机：点 ⚙ 后**整页不显示**）：
							 *   这里的分支条件是 `draft !== null`（编辑态），**不是 `doc`** ⇒ 没有文档时
							 *   仍会走到预览分支并读 `doc.html` ⇒ `doc` 为 null 直接抛
							 *   "Cannot read properties of null (reading 'html')" ⇒ 整棵 React 根被卸载（白屏）。
							 *   ⇒ 全部改成可选链（doc?.html / doc?.math），没有文档时这一段自然不渲染。
							 */}
							{doc?.html ? (
										<>
											{doc?.math ? <link rel="stylesheet" href="/x/kb/vendor/katex/katex.min.css" /> : null}
											<div
												className="kb-md"
												ref={docHtmlRef}
												// 服务端 `html:false`（原始 HTML 一律转义）⇒ 这里的 HTML 由我们自己拼接，安全
												dangerouslySetInnerHTML={{ __html: doc?.html }}
												onClick={e => {
													const el = e.target as HTMLElement;
													/*
													 * ★ 2026-10-26（真机：超链接无法跳转）：
													 *   笔记里的 `[[05 DSH 框架原理]]` 在库里**并不存在** ⇒ 渲染成灰色虚线（不可点），
													 *   用户看到的就是"点了没反应"。这里给出明确反馈：告诉用户找的是哪一篇。
													 */
													const missing = el.closest('[data-wiki-missing]');
													if (missing) {
														e.preventDefault();
														const target = missing.getAttribute('data-wiki-missing') || '';
														showToast("找不到这篇笔记：" + target + "（可能已改名/删除；可用「体检 → 修断链」修正）");
														return;
													}
													const link = el.closest('[data-wiki]');
													if (link) {
														e.preventDefault();
														const p = link.getAttribute('data-wiki');
														if (p) {
															/*
															 * ★ 2026-10-26（真机：文档里点双链没反应）：
															 *   面板的 `openLink` 只更新了**宿主自己的**状态，而界面显示的是视图内部的
															 *   doc ⇒ 点了什么都看不到。有 `loadDoc` 时**由视图自己打开**，宿主只兜底。
															 */
															if (!loadIntoView(p)) { (actions?.openLink ?? actions?.openNode)?.(p); }
														}
														return;
													}
													/*
													 * ★★ 2026-10-26（真机：超链接点了没反应）：
													 *   这条分支之前只处理双链与任务勾选 ⇒ 普通链接 `[文字](https://…)`
													 *   点了会尝试**导航当前 webview**，被宿主拦掉 ⇒ 表现就是"没反应"。
													 *   现在：站外链接交给宿主 `openUrl`（面板/页面都会 window.open 并在被拦时复制链接）；
													 *   站内 `#锚点` 就地滚动（双链已经走 data-wiki，不吃这条）。
													 */
													const anchor = el.closest('a[href]') as HTMLAnchorElement | null;
													if (anchor) {
														const href = String(anchor.getAttribute('href') || '').trim();
														if (!href) { e.preventDefault(); return; }
														if (href.startsWith('#')) {
															// 锚点能找到就就地滚动；找不到就**放行**（浏览器的同页跳转不会刷新，无害）
															const id = href.slice(1);
															const target = id ? (document.getElementById(id) ?? document.querySelector(`[data-anchor="${CSS.escape(id)}"]`)) : null;
															if (target && 'scrollIntoView' in target) {
																e.preventDefault();
																(target as HTMLElement).scrollIntoView({ block: 'start', behavior: 'smooth' });
															}
															return;
														}
														if (/^(https?:|mailto:)/i.test(href)) {
															e.preventDefault();
															if (actions?.openUrl) { actions.openUrl(href); }
															else { window.open(href, '_blank', 'noopener'); }
															return;
														}
														// 其它（相对路径附件等）也不让 webview 自己导航：交给宿主按 URL 打开
														if (/^(file:|[A-Za-z]:[\\/]|\.{0,2}\/)/.test(href)) {
															e.preventDefault();
															if (actions?.openUrl) { actions.openUrl(href); }
														}
													}
													const box = el.closest('[data-task-line]') as HTMLInputElement | null;
													if (box && actions?.saveDoc) {
														const line = Number(box.getAttribute('data-task-line'));
														e.preventDefault();            // 捕获阶段：阻止原生 toggle（下面的手动翻转才是唯一来源）
						box.checked = !box.checked;    // 先给即时反馈，写盘失败由 toggleTask 弹错
														if (Number.isInteger(line) && line >= 0) { void toggleTask(line); }
													}
												}}
											/>
										</>
									) : (
										/*
										 * 兜底：宿主既没给服务端 HTML、我们也不再内置解析器（2026-10-25 删除手写渲染器）。
										 * 如实按纯文本显示并说明原因 —— 比"渲染出一半 Markdown"更不容易误解为解析错误。
										 */
										<div>
											<div style={{ fontSize: 11, opacity: .6, marginBottom: 6 }}>
												当前宿主未提供服务端渲染结果，以下按纯文本显示。
											</div>
											<pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.7, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
												{doc?.text}
											</pre>
										</div>
									)}
								</div>
							)}
							</div>

							{/* 回到顶部：滚过一屏才出现，避免小文档也挂一个按钮 */}
							{docScrollTop > 300 ? (
								<button type="button" title="回到顶部" aria-label="回到顶部"
									onClick={() => { const el = docScrollRef.current; if (el) { el.scrollTo({ top: 0, behavior: "smooth" }); } }}
									style={{ position: 'absolute', right: 16, bottom: 14, width: 28, height: 28, borderRadius: '50%', border: `1px solid ${c.line}`, background: 'var(--vscode-editorWidget-background, #2a2d2e)', color: c.fgDim, cursor: 'pointer', zIndex: 5 }}>↑</button>
							) : null}
						</>
					) : (
						/* 2026-10-28（用户要求）：空态不再显示任何文案，只保留整块底色 */
						<div style={{ flex: '1 1 auto', minHeight: 0, background: 'var(--vscode-editor-background, #1e1e1e)' }} />
					)}
							</>) : null}
			{activeView === 'graph' ? (
				<KbGraphTab vaultId={data.activeVaultId} onOpenNote={actions?.openNode} />
			) : null}

				{activeView === 'canvas' ? (
					<div style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--vscode-editor-background, #1e1e1e)' }}>
						<KbCanvasPane
							onClose={() => { setTab('doc'); setOpenViews(o => ({ ...o, canvas: false })); }}
							onOpenNote={(abs) => {
								setTab('doc');
								setOpenViews({ settings: false, graph: false, canvas: false });
								(actions?.openLink ?? actions?.openNode)?.(abs);
							}}
						/>
					</div>
				) : null}

			{activeView === 'settings' ? (
				<div
					data-kb-settings="1"
					role="tabpanel"
					style={{ flex: '1 1 auto', minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--vscode-editor-background, #1e1e1e)' }}
				>
					<div
						onClick={e => e.stopPropagation()}
						style={{ width: '100%', height: '100%', maxHeight: 'none', overflow: 'auto', boxSizing: 'border-box',
							// ★ 2026-10-29（用户：设置页面右侧太贴边）：内容紧贴容器右缘 ⇒ 控件被裁。
							//   ⇒ 加左右内边距 + 内容最大宽度（超宽屏上不至于拉成一条线）。
							padding: '14px 20px 28px', maxWidth: '1180px',
						}}
					>
						<div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
							<div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>知识库设置</div>
							{/*
							 * ★ 2026-10-28：完整设置（飞书同步 / 目录映射 / CLI 路径）**不在**本页签内
							 *   （跨 React 实例渲染不可靠），这里给一个明确入口 ⇒ 宿主把它开在右栏。
							 */}
							{actions?.openSettings ? (
								<button
									type="button"
									title="完整设置：飞书同步 / 目录映射 / CLI 路径"
									onClick={() => { setShowSettings(false); actions.openSettings!(); }}
									style={{ height: 22, padding: '0 10px', marginRight: 6, fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: c.fgDim, border: `1px solid ${c.line}` }}
								>完整设置…</button>
							) : null}
							<button type="button" onClick={() => setShowSettings(false)}

								style={{ height: 22, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>关闭</button>
						</div>

					{/*
					 * ★★ 2026-10-28（真机：点设置后**整块空白**，且三次都没修好）：
					 *   原因就是这个容器 —— 它在**设置页内部**，却用
					 *   `position:absolute; inset:0; zIndex:41` + 不透明背景 ⇒ 一旦 `hostSettingsOpen`
					 *   为真，它就把整个设置页盖住；而面板往里渲染的内容若不可见，用户看到的就是"空白"。
					 *
					 *   结论：**跨 React 实例渲染面板富设置这条路放弃**（bundle 自带另一份 React，
					 *   既不能 portal，也保证不了可见性）。设置页签只渲染 bundle 自己的设置页；
					 *   完整设置（飞书 / 目录映射 / CLI）通过下面的「完整设置」按钮开在右栏。
					 */}

						{/* 完整设置（飞书）：bundle 自己的 React，同树渲染 */}
						<KbFeishuSettings />

{/* ① 当前库 */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>当前库</div>
						<div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
							{(data.vaults ?? []).map(v => (
								<button
									key={v.id}
									type="button"
									onClick={() => { actions?.switchVault?.(v.id); setShowSettings(false); }}
									style={{
										display: 'flex', alignItems: 'center', gap: 8, height: 24, padding: '0 8px',
										background: v.id === data.activeVaultId ? 'rgba(127,127,127,.18)' : 'transparent',
										border: `1px solid ${c.line}`, borderRadius: 4, color: 'inherit', fontSize: 12,
										cursor: actions?.switchVault ? 'pointer' : 'default',
										opacity: actions?.switchVault ? 1 : .65,
									}}
								>
									<span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
									<span style={{ color: c.fgFaint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{v.count}</span>
								</button>
							))}
							{!actions?.switchVault ? <div style={{ fontSize: 10.5, opacity: .6 }}>当前宿主不支持在页面内切库</div> : null}
						</div>

						{/* ①-b 库信息（对齐 IDE 设置页里能看到的那几项） */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>库信息</div>
						<div style={{ fontSize: 11, color: c.fgDim, marginBottom: 6, lineHeight: 1.7 }}>
							<div>名称：{data.vaultName}</div>
							<div>笔记：{data.noteCount} 篇 · 库：{data.libraryCount ?? 0} 个文件</div>
							<div>索引：{data.indexState === 'ready' ? '就绪' : '未就绪（数据可能过时）'} · 标签 {data.tags.length} 个</div>
						</div>

						{/* ①-c 快捷操作（只有宿主真给的动作才出现，避免死按钮） */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>快捷操作</div>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
							{actions?.refresh ? <button type="button" onClick={() => actions.refresh?.()} style={{ height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>重新加载数据</button> : null}
							{actions?.openGraph ? <button type="button" onClick={() => { setShowSettings(false); actions.openGraph?.(); }} style={{ height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>关系图谱</button> : null}
							{actions?.feishuSync ? <button type="button" onClick={() => { setShowSettings(false); actions.feishuSync?.(); }} style={{ height: 24, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>同步飞书</button> : null}
							{!actions?.refresh && !actions?.openGraph && !actions?.feishuSync
								? <span style={{ fontSize: 10.5, opacity: .6 }}>当前宿主没有提供快捷操作</span> : null}
						</div>

						{/* ② 排序 */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>排序</div>
						<div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 12 }}>
							{([
								['name', '名称↑'], ['nameDesc', '名称↓'], ['size', '大小↓'], ['mtime', '时间↓'], ['mtimeAsc', '时间↑'],
							] as const).map(([k, label]) => (
								<button
									key={k}
									type="button"
									onClick={() => setSortKey(k)}
									style={{
										height: 22, padding: '0 9px', fontSize: 11, cursor: 'pointer', borderRadius: 4,
										background: sortKey === k ? 'var(--vscode-button-background, #0e639c)' : 'transparent',
										color: sortKey === k ? 'var(--vscode-button-foreground, #fff)' : 'inherit',
										border: `1px solid ${sortKey === k ? 'transparent' : c.line}`,
									}}
								>{label}</button>
							))}
						</div>

						{/* ③ 能力清单：把"为什么某些按钮没有"讲清楚 */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>当前宿主可用的能力</div>
						<div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
							{([
								['loadDoc', '阅读正文'], ['saveDoc', '保存'], ['assetUrl', '图片/附件'],
								['openGraph', '关系图谱'], ['feishuSync', '同步飞书'], ['switchVault', '切库'],
								['search', '检索'], ['createNote', '新建'], ['renameNode', '改名'],
								['deleteNodes', '删除'], ['moveNodes', '拖拽'], ['openSettings', '宿主设置页'],
							] as const).map(([k, label]) => {
								const on = !!(actions as unknown as Record<string, unknown>)?.[k];
								return (
									<span key={k} style={{
										fontSize: 10.5, padding: '1px 7px', borderRadius: 9,
										border: `1px solid ${c.line}`, opacity: on ? 1 : .45,
									}}>{(on ? '✓ ' : '— ') + label}</span>
								);
							})}
						</div>

						{/* ④ 诊断 */}
						<div style={{ fontSize: 11, color: c.fgFaint, marginBottom: 4 }}>诊断</div>
						<div style={{ fontSize: 10.5, fontFamily: 'var(--vscode-editor-font-family, monospace)', opacity: .75, wordBreak: 'break-all' }}>
							{debug ?? '(无)'} · 数据字段 {Object.keys(data).length} · 动作 {actions ? Object.keys(actions).length : 0}
						</div>
					</div>
				</div>
			) : null}
				</div>
			) : null}

			{/* 设置面板（⚙）：dsh 侧没有宿主设置页，这里给出真正能用的几项 */}
			{/*
			 * 导图覆盖层（2026-10-25 从面板侧迁到视图）：三端共用一份 `KbCanvasPane`。
			 * 与设置面板同一套「父 relative + 子 absolute」定位（不用 fixed：宿主容器带 transform）。
			 */}
			{/* 轻提示：底部居中浮层（pointerEvents: none 不挡点击） */}
			{toast ? (
				<div
					data-kb-toast="1"
					role="status"
					style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 60, maxWidth: '90%', padding: '7px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.5, color: '#fff', background: 'rgba(30,30,30,.95)', border: '1px solid rgba(255,255,255,.16)', boxShadow: '0 6px 20px rgba(0,0,0,.45)', pointerEvents: 'none' }}
				>
					{toast}
				</div>
			) : null}



			{/* 视图内对话框（Electron 不支持 window.prompt ⇒ 改名/新建/删除确认自己弹） */}
			{dialog ? (
				<div
					role="dialog"
					aria-modal="true"
					onClick={() => setDialog(null)}
					style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
				>
					<div
						onClick={e => e.stopPropagation()}
						style={{ minWidth: 320, maxWidth: 460, background: 'var(--vscode-menu-background, #252526)', border: `1px solid ${c.line}`, borderRadius: 6, padding: 14, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}
					>
						<div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>
							{dialog.kind === 'rename' ? '重命名'
								: dialog.kind === 'delete' ? '确认删除'
									: dialog.kind === 'newNote' ? '新建笔记'
										: dialog.kind === 'newFolder' ? '新建目录'
											: dialog.kind === 'vaultCreate' ? '新建知识库'
												: '本地载入文件夹'}
						</div>
						{dialog.kind === 'delete' ? (
							<div style={{ fontSize: 12.5, color: c.fgDim, marginBottom: 12 }}>
								确定删除选中的 {dialog.paths.length} 项？此操作不可撤销。
							</div>
						) : (
							<input
								autoFocus
								value={dialog.value}
								placeholder={dialog.kind === 'vaultCreate' || dialog.kind === 'vaultAttach'
									? '文件夹绝对路径，如 E:\\Notes\\MyVault'
									: undefined}
								onChange={e => setDialog({ ...dialog, value: e.target.value })}
								onKeyDown={e => {
									if (e.key === 'Enter') { (e.currentTarget as HTMLInputElement).blur(); }
								}}
								style={{ width: '100%', height: 26, boxSizing: 'border-box', padding: '0 8px', background: c.inputBg, color: c.inputFg, border: `1px solid ${c.line}`, borderRadius: 4, fontSize: 12.5, marginBottom: 12 }}
							/>
						)}
						{dialog.kind === 'vaultCreate' ? (
							<div style={{ fontSize: 11, color: c.fgFaint, marginTop: 6 }}>
								文件夹不存在会自动创建（并补 <code>笔记/</code> 与 <code>库/</code>）；<b>文件夹名就是知识库名字</b>。
							</div>
						) : null}
						<div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
							<button type="button" onClick={() => setDialog(null)} style={{ height: 24, padding: '0 12px', fontSize: 12, background: 'transparent', color: c.fg, border: `1px solid ${c.line}`, borderRadius: 4, cursor: 'pointer' }}>取消</button>
							<button
								type="button"
								onClick={() => {
									const d = dialog;
									setDialog(null);
									if (d.kind === 'rename') { actions?.renameNode?.(d.path, d.value.trim()); }
									else if (d.kind === 'delete') { actions?.deleteNodes?.(d.paths, true); }
									else if (d.kind === 'newNote') { actions?.createNote?.('', d.value.trim()); }
									// 新建：传**文件夹路径**，库名由服务端取文件夹名（不再另取名）
									else if (d.kind === 'vaultCreate') { actions?.addVault?.('create', d.value.trim()); }
									else if (d.kind === 'vaultAttach') { actions?.addVault?.('attach', d.value.trim()); }
									else { actions?.newFolder?.('', d.value.trim()); }
								}}
								style={{ height: 24, padding: '0 12px', fontSize: 12, background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)', border: '1px solid transparent', borderRadius: 4, cursor: 'pointer' }}
							>确定</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
};

// ─── 引导（宿主未注入数据时用演示数据，便于 visual / 单独打开）──────────────

const DEMO: KbSideviewData = {
	vaultName: 'VsSarosVault',
	activeVaultId: 'vs',
	vaults: [
		{ id: 'vs', name: 'VsSarosVault', count: 134 },
		{ id: 'old', name: '旧库 · ObsidianWorkspace', count: 23 },
	],
	noteCount: 102,
	tree: [
		{
			name: '01_学习', path: '笔记/01_学习', isFolder: true, count: 102, children: [
				{
					name: 'AI_Agent', path: '笔记/01_学习/AI_Agent', isFolder: true, count: 20, children: [
						{ name: '01 智能体是什么', path: '笔记/01_学习/AI_Agent/01 智能体是什么.md', isFolder: false },
						{ name: '05 DSH 框架原理', path: '笔记/01_学习/AI_Agent/05 DSH 框架原理.md', isFolder: false },
						{ name: '05a 框架原理（讲懂版）', path: '笔记/01_学习/AI_Agent/05a 框架原理（讲懂版）.md', isFolder: false },
					],
				},
				{ name: 'UnrealEngine', path: '笔记/01_学习/UnrealEngine', isFolder: true, count: 45 },
				{ name: '游戏设计', path: '笔记/01_学习/游戏设计', isFolder: true, count: 8 },
			],
		},
		{ name: '02_工作', path: '笔记/02_工作', isFolder: true, count: 0 },
	],
	tags: [
		{ tag: 'AI-Agent', count: 19 }, { tag: '游戏设计', count: 8 }, { tag: 'UE', count: 7 },
		{ tag: 'Harness', count: 5 }, { tag: '技巧', count: 4 },
	],
	untaggedCount: 56,
	outLinks: [
		{ title: '工程实践 工具设计与 Harness', path: '笔记/01_学习/AI_Agent/工程实践 工具设计与 Harness.md' },
	],
	inLinks: [
		{ title: '08 DeepSeek Harness (DSH) 总览与架构', path: '笔记/01_学习/AI_Agent/08 DeepSeek Harness (DSH) 总览与架构.md' },
		{ title: '03 DSH 优缺点评估', path: '笔记/01_学习/AI_Agent/03 DSH 优缺点评估.md' },
	],
	indexState: 'ready',
	selectedPath: '笔记/01_学习/AI_Agent/05 DSH 框架原理.md',
};

/**
 * ★ 2026-10-24（引导层拆分，对齐 Theia `ReactWidget` / OpenSumi `SlotRenderer` 的做法）：
 * 把同一份视图暴露成**可挂载单元**，任何宿主都能把 UI 挂到自己的容器上：
 *
 *   const dispose = window.__KB_SIDEVIEW_MOUNT__(el, data, actions);
 *
 * 为什么要这一层：桌面「工作台面板」是由 dsh 客户端在自己的 React 树里渲染插件组件的
 * （`desktopWorkbenches.register(descriptor, Component)`），它**不是独立文档**，
 * 拿不到 `#root` + 全局注入那套引导；而插件页/IDE webview 又必须保留自动引导。
 * ⇒ 一份 bundle 两种用法：有 `#root` 就自举，否则等宿主调 MOUNT。
 *
 * ⚠ 与自动引导互斥：面板宿主自己会拿到 el，这里绝不能再去 `document.getElementById('root')`。
 */
export type KbSideviewMount = (el: HTMLElement, data: KbSideviewData, actions?: KbSideviewActions) => () => void;

declare global {
	interface Window {
		__KB_SIDEVIEW_MOUNT__?: KbSideviewMount;
	}
}

if (typeof window !== 'undefined') {
	window.__KB_SIDEVIEW_MOUNT__ = (el, data, actions) => {
		const root = createRoot(el);
		const dbg = 'mount/d' + (data ? Object.keys(data).length : 0) + '/a' + (actions ? Object.keys(actions).length : 0);
		root.render(<KbSideview data={data} actions={actions} debug={dbg} />);
		return () => root.unmount();
	};
}

/**
 * ★★ 2026-10-24（真机事故）：作为 **chunk 被宿主载入**时**绝不能自举**。
 * 原因：dsh 客户端 SPA 自己也有 `<div id="root">`，而我们按 `#root` 自举 ⇒ 把整个应用根节点
 * 换成知识库侧栏（且没有数据/动作，显示的是内置 DEMO）——表现就是"页面卡在演示数据"。
 * ⇒ chunk 形态在加载前会置 `window.__KB_SIDEVIEW_EMBED__ = true`，此处据此跳过自举，
 *   等宿主显式调 `window.__KB_SIDEVIEW_MOUNT__(el, data, actions)`。
 */
const embedded = !!(window as unknown as { __KB_SIDEVIEW_EMBED__?: boolean }).__KB_SIDEVIEW_EMBED__;
const host = embedded ? null : document.getElementById('root');
if (host) {
	const injected = window.__KB_SIDEVIEW_DATA__;
	const acts = window.__KB_SIDEVIEW_ACTIONS__;
	// 诊断串：host=页面内联脚本给的 / demo=没拿到（回头看内联脚本有没有跑通）
	const stage = (window as unknown as { __KB_BOOT_STAGE__?: string }).__KB_BOOT_STAGE__ ?? '-';
	const dbg = 'page/' + (injected ? 'host' : 'demo') + '/a' + (acts ? Object.keys(acts).length : 0) + '/s' + stage;
	void stage;
	createRoot(host).render(<KbSideview data={injected ?? DEMO} actions={acts} debug={dbg} />);
}
