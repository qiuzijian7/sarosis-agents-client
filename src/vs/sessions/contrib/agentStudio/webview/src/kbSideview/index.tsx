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
	/** 重建索引（宿主有能力时提供；dsh 面板走 `/api/reindex` 一类路由） */
	reindex?(): void;
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
	/**
	 * 打开思维导图（生成/打开 `mindmap.canvas`）。**宿主不提供时不显示按钮** ——
	 * 与其放一个点了没反应的按钮，不如让能力差异可见（IDE 侧有、插件页暂无）。
	 */
	openMindmap?(): void;
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
	loadDoc?(path: string): Promise<{ title: string; text: string; /** 文档所在目录（绝对），图片相对路径要用它折算 */ base?: string } | null>;
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

/**
 * 极简 Markdown 渲染（**无第三方依赖**）。
 *
 * 为什么自建：插件页 / 工作台面板里没有 IDE 的 Markdown 渲染器可用，之前右栏直接 `<pre>` 输出
 * 原文 ⇒ `>`、`**`、`1)` 全裸露，和 IDE 侧栏里看到的排版完全两样（2026-10-24 用户报）。
 * 引 `marked` + `dompurify` 会给**常驻侧栏** bundle 增重几十 KB，并引入 XSS 面 ⇒ 只做「结构可读」：
 * 标题 / 段落 / 有序无序列表 / 引用 / 代码块 / 分隔线 + 行内粗体·斜体·行内代码·链接。
 * 表格与更复杂语法按原文给出（等宽显示），**不假装支持**。
 */
const INLINE_RE = /(!\[[^\]]*\]\([^)]+\)|\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*|\[[^\]]+\]\([^)]+\))/g;

/**
 * 渲染期上下文（图片要用宿主的资源路由 + 当前文档所在目录）。
 *
 * 为什么用模块级变量而不是一路传参：`renderInline` 在标题/列表/引用/表格里都被调用，
 * 逐层加参数会污染十几个调用点；而渲染是**同步**的，进入 `renderMarkdown` 时赋值即可。
 */
let MD_CTX: {
	assetUrl?: (absPath: string) => string;
	base?: string;
	/** 点任务清单的勾选框时回调（传入该行在 Markdown 里的**行号**） */
	onTaskToggle?: (lineIndex: number) => void;
} = {};

/** 把 Markdown 里的图片地址折成**绝对路径**，再交给宿主的资源路由。 */
function resolveAssetSrc(src: string): string | undefined {
	const raw = src.trim();
	if (/^(https?:|data:|blob:)/i.test(raw)) { return raw; }        // 外链直用
	const build = MD_CTX.assetUrl;
	if (!build) { return undefined; }                                // 宿主没有资源路由 ⇒ 当普通文字
	const base = (MD_CTX.base ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	let abs: string;
	if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('/')) { abs = raw; }
	else if (raw.startsWith('../')) {
		// 逐级回退（相对当前文档目录）
		const parts = base.split('/');
		let rest = raw;
		while (rest.startsWith('../')) { parts.pop(); rest = rest.slice(3); }
		abs = parts.join('/') + '/' + rest;
	} else { abs = base ? base + '/' + raw : raw; }
	return build(abs);
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
	const out: React.ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of text.matchAll(INLINE_RE)) {
		const idx = m.index ?? 0;
		if (idx > last) { out.push(text.slice(last, idx)); }
		const tok = m[0];
		const key = keyPrefix + '-i' + (i++);
		if (tok.startsWith('![')) {
			// 资产：解析出 alt 与 src；宿主无资源路由时退化成「alt」文字（不显示坏图）
			const mm = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(tok);
			const src = mm ? resolveAssetSrc(mm[2]) : undefined;
			if (!mm || !src) {
				out.push(<span key={key} style={{ opacity: .7 }}>{mm ? mm[1] || '（附件）' : tok}</span>);
				continue;
			}
			// ★ 2026-10-24：按扩展名分流 —— 以前一律塞 `<img>`，pdf / 视频会渲染成坏图 ✗
			const ext = (mm[2].split(/[?#]/)[0].split('.').pop() ?? '').toLowerCase();
			const label = mm[1] || (mm[2].split('/').pop() ?? '附件');
			if (ext === 'pdf') {
				// 优先内嵌（Chromium 自带 PDF 阅读器）；不支持时下面那条链接可兜底（同 webview 内跳转）
				out.push(
					<div key={key} style={{ margin: '8px 0' }}>
						<embed src={src} type="application/pdf"
							style={{ width: '100%', height: 520, border: '1px solid rgba(127,127,127,.35)', borderRadius: 4, background: 'rgba(127,127,127,.08)' }} />
						<a href={src} style={{ display: 'inline-block', marginTop: 4, fontSize: 11.5, opacity: .8, textDecoration: 'underline', color: 'inherit' }}>
							PDF · {label}（打不开就点这里）
						</a>
					</div>);
			} else if (['mp4', 'webm', 'mov'].includes(ext)) {
				out.push(<video key={key} src={src} controls style={{ maxWidth: '100%', margin: '6px 0', borderRadius: 4, display: 'block' }} />);
			} else if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) {
				out.push(<audio key={key} src={src} controls style={{ width: '100%', margin: '6px 0' }} />);
			} else {
				// 图片：点击在新标签放大（不引灯箱，省一个组件）
				out.push(
					<a key={key} href={src} target="_blank" rel="noreferrer" title="点击放大">
						<img src={src} alt={label} loading="lazy"
							style={{ maxWidth: '100%', borderRadius: 4, margin: '6px 0', display: 'block', border: '1px solid rgba(127,127,127,.25)' }} />
					</a>);
			}
		}
		else if (tok.startsWith('**')) { out.push(<strong key={key}>{tok.slice(2, -2)}</strong>); }
		else if (tok.startsWith('`')) { out.push(<code key={key} style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', background: 'rgba(127,127,127,.18)', padding: '1px 4px', borderRadius: 3 }}>{tok.slice(1, -1)}</code>); }
		else if (tok.startsWith('[')) {
			const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
			out.push(mm ? <a key={key} href={mm[2]} style={{ color: 'var(--vscode-textLink-foreground, #3794ff)' }}>{mm[1]}</a> : tok);
		} else { out.push(<em key={key}>{tok.slice(1, -1)}</em>); }
		last = idx + tok.length;
	}
	if (last < text.length) { out.push(text.slice(last)); }
	return out;
}

/**
 * 极简语法高亮（无第三方依赖）。
 *
 * 只做四类记号：注释 / 字符串 / 数字 / 关键字 —— 这四类已经能覆盖「代码块一眼可读」的需求。
 * 刻意不引 highlight.js（+~30KB 且要按语言注册）：侧栏是常驻视图，收益不抵体积。
 * `#` 注释只对 py/sh/yaml 系生效，否则 JS 的私有字段名会被误判成注释。
 */
const HL_KEYWORDS = new Set([
	'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'class', 'new', 'import', 'from', 'export',
	'async', 'await', 'try', 'catch', 'finally', 'throw', 'typeof', 'interface', 'type', 'implements', 'extends', 'public',
	'private', 'readonly', 'enum', 'switch', 'case', 'break', 'continue', 'default', 'yield', 'in', 'of', 'do', 'void',
	'null', 'undefined', 'true', 'false', 'this', 'super', 'static', 'def', 'elif', 'lambda', 'pass', 'with', 'as', 'not',
	'and', 'or', 'is', 'None', 'True', 'False', 'echo', 'then', 'fi', 'esac', 'local',
]);
const HASH_COMMENT_LANGS = new Set(['py', 'python', 'sh', 'bash', 'shell', 'zsh', 'yaml', 'yml', 'toml', 'conf', 'dockerfile']);

function highlight(code: string, lang: string): React.ReactNode[] {
	const useHash = HASH_COMMENT_LANGS.has(lang.toLowerCase());
	// 顺序敏感：注释 > 字符串 > 数字 > 标识符
	const re = new RegExp(
		(useHash ? '(#[^\\n]*)' : '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)')
		+ '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)'
		+ '|\\b(\\d+(?:\\.\\d+)?)\\b'
		+ '|\\b([A-Za-z_$][\\w$]*)\\b',
		'g',
	);
	const out: React.ReactNode[] = [];
	let last = 0;
	let i = 0;
	for (const m of code.matchAll(re)) {
		const idx = m.index ?? 0;
		if (idx > last) { out.push(code.slice(last, idx)); }
		const key = 'h' + (i++);
		if (m[1] !== undefined) { out.push(<span key={key} style={{ color: '#6a9955' }}>{m[1]}</span>); }
		else if (m[2] !== undefined) { out.push(<span key={key} style={{ color: '#ce9178' }}>{m[2]}</span>); }
		else if (m[3] !== undefined) { out.push(<span key={key} style={{ color: '#b5cea8' }}>{m[3]}</span>); }
		else if (m[4] !== undefined && HL_KEYWORDS.has(m[4])) { out.push(<span key={key} style={{ color: '#569cd6' }}>{m[4]}</span>); }
		else { out.push(m[0]); }
		last = idx + m[0].length;
	}
	if (last < code.length) { out.push(code.slice(last)); }
	return out;
}

function renderMarkdown(md: string, ctx?: { assetUrl?: (absPath: string) => string; base?: string; onTaskToggle?: (lineIndex: number) => void }): React.ReactNode[] {
	MD_CTX = ctx ?? {};
	const lines = md.replace(/\r\n?/g, '\n').split('\n');
	const blocks: React.ReactNode[] = [];
	let i = 0;
	let k = 0;
	const key = () => 'md' + (k++);

	while (i < lines.length) {
		const line = lines[i];

		// 代码块（带极简高亮：注释/字符串/数字/关键字）
		if (/^\s*```/.test(line)) {
			const lang = line.replace(/^\s*```/, '').trim();
			const buf: string[] = [];
			i++;
			while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i++]); }
			i++;
			const codeText = buf.join('\n');
			blocks.push(
				<div key={key()} style={{ position: 'relative', margin: '8px 0' }}>
					<button
						type="button"
						title="复制代码"
						onClick={e => {
							// 不引状态：直接改按钮文案（避免为每个代码块加一个 useState）
							const btn = e.currentTarget;
							void navigator.clipboard?.writeText(codeText).then(() => {
								btn.textContent = '已复制';
								setTimeout(() => { btn.textContent = '复制'; }, 1200);
							}).catch(() => { btn.textContent = '复制失败'; });
						}}
						style={{
							position: 'absolute', top: 6, right: 6, height: 20, padding: '0 8px',
							fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
							background: 'rgba(127,127,127,.18)', color: 'inherit',
							border: '1px solid rgba(127,127,127,.35)', opacity: .8,
						}}
					>复制</button>
					<pre style={{ margin: 0, padding: '8px 10px', background: 'rgba(127,127,127,.12)', borderRadius: 4, overflow: 'auto', fontSize: 12, lineHeight: 1.6, fontFamily: 'var(--vscode-editor-font-family, monospace)' }}>
						{highlight(codeText, lang)}
					</pre>
					{lang ? (
						<span style={{ position: 'absolute', top: 6, left: 8, fontSize: 9.5, opacity: .45, textTransform: 'uppercase', letterSpacing: '.05em' }}>{lang}</span>
					) : null}
				</div>);
			continue;
		}

		// 标题
		const h = /^(#{1,4})\s+(.*)$/.exec(line);
		if (h) {
			const lv = h[1].length;
			const size = lv === 1 ? 16 : lv === 2 ? 15 : lv === 3 ? 14 : 13;
			blocks.push(<div key={key()} style={{ fontSize: size, fontWeight: 600, margin: '14px 0 6px' }}>{renderInline(h[2], key())}</div>);
			i++;
			continue;
		}

		// 分隔线
		if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
			blocks.push(<div key={key()} style={{ height: 1, background: 'rgba(127,127,127,.3)', margin: '12px 0' }} />);
			i++;
			continue;
		}

		// 引用块（连续 > 行合并）
		if (/^\s*>/.test(line)) {
			const buf: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
			blocks.push(
				<div key={key()} style={{ borderLeft: '3px solid rgba(127,127,127,.45)', padding: '2px 0 2px 10px', margin: '8px 0', color: 'var(--vscode-descriptionForeground, #9d9d9d)' }}>
					{renderInline(buf.join('\n'), key())}
				</div>);
			continue;
		}

		// 列表（有序 / 无序，按缩进给一级子项）
		if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
			const items: React.ReactNode[] = [];
			while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
				const li = lines[i];
				const lineIndex = i;   // 任务清单切换要回写**这一行**，先记下行号
				const indent = (li.match(/^\s*/)?.[0].length ?? 0) >= 2 ? 16 : 0;
				const rawBody = li.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
				const ordered = /^\s*\d+[.)]\s+/.test(li);
				// 任务列表：`- [ ]` / `- [x]` ⇒ 真勾选框（只读；点击即切换属于编辑，dsh 侧不做）
				const task = /^\[([ xX])\]\s+/.exec(rawBody);
				const body = task ? rawBody.slice(task[0].length) : rawBody;
				const bullet = task
					? (task[1].toLowerCase() === 'x' ? '☑' : '☐')
					: (ordered ? (li.trim().match(/^\d+/)?.[0] ?? '') + '.' : '•');
				items.push(
					<div key={key()} style={{ display: 'flex', gap: 6, marginLeft: indent, marginBottom: 2 }}>
						<span
							// 任务清单：宿主提供 onTaskToggle 时才能点（点击=切换 `[ ]`/`[x]`，会写回文件）
							onClick={task && MD_CTX.onTaskToggle ? () => MD_CTX.onTaskToggle?.(lineIndex) : undefined}
							title={task && MD_CTX.onTaskToggle ? '点击切换完成状态' : undefined}
							style={{
								color: task ? 'var(--vscode-textLink-foreground, #3794ff)' : 'var(--vscode-descriptionForeground, #9d9d9d)',
								minWidth: task ? 14 : (ordered ? 16 : 10),
								cursor: task && MD_CTX.onTaskToggle ? 'pointer' : 'default',
							}}>{bullet}</span>
						<span style={{ flex: 1, minWidth: 0, opacity: task && task[1].toLowerCase() === 'x' ? .75 : 1 }}>{renderInline(body, key())}</span>
					</div>);
				i++;
			}
			blocks.push(<div key={key()} style={{ margin: '6px 0' }}>{items}</div>);
			continue;
		}

		// 表格（2026-10-24：从"等宽原文"升级为真表格，带边框与对齐）
		if (/^\s*\|/.test(line)) {
			const rows: string[][] = [];
			while (i < lines.length && /^\s*\|/.test(lines[i])) {
				const raw = lines[i].trim();
				// 去掉首尾竖线后按 | 切（不支持转义竖线 —— 笔记里极少出现，先不假装支持）
				const cells = raw.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
				rows.push(cells);
				i++;
			}
			const isSep = (cells: string[]) => cells.every(c => /^:?-{2,}:?$/.test(c));
			const sep = rows.length > 1 && isSep(rows[1]) ? rows[1] : undefined;
			const head = sep ? rows[0] : undefined;
			const body = sep ? rows.slice(2) : rows;
			const alignOf = (idx: number): 'left' | 'center' | 'right' => {
				const c = sep?.[idx] ?? '';
				if (c.startsWith(':') && c.endsWith(':')) { return 'center'; }
				if (c.endsWith(':')) { return 'right'; }
				return 'left';
			};
			const cellStyle = (idx: number): React.CSSProperties => ({
				padding: '5px 9px', border: '1px solid rgba(127,127,127,.35)', textAlign: alignOf(idx), verticalAlign: 'top',
			});
			blocks.push(
				<div key={key()} style={{ margin: '10px 0', overflowX: 'auto' }}>
					<table style={{ borderCollapse: 'collapse', fontSize: 12.5, minWidth: '50%' }}>
						{head ? (
							<thead>
								<tr>{head.map((c, ci) => (
									<th key={ci} style={{ ...cellStyle(ci), background: 'rgba(127,127,127,.14)', fontWeight: 600 }}>{renderInline(c, key())}</th>
								))}</tr>
							</thead>
						) : null}
						<tbody>
							{body.map((cells, ri) => (
								<tr key={ri}>{cells.map((c, ci) => (
									<td key={ci} style={cellStyle(ci)}>{renderInline(c, key())}</td>
								))}</tr>
							))}
						</tbody>
					</table>
				</div>);
			continue;
		}

		// 空行
		if (!line.trim()) { i++; continue; }

		// 段落：连续非空行合并
		const buf: string[] = [];
		while (i < lines.length && lines[i].trim() && !/^\s*(#{1,4}\s|>|[-*+]\s|\d+[.)]\s|```|\|)/.test(lines[i]) && !/^\s*(-{3,}|\*{3,})\s*$/.test(lines[i])) {
			buf.push(lines[i]); i++;
		}
		if (buf.length) {
			blocks.push(<p key={key()} style={{ margin: '8px 0', lineHeight: 1.75 }}>{renderInline(buf.join(' '), key())}</p>);
		} else { i++; }
	}
	return blocks;
}

/**
 * 组件内联的少量 CSS（只放**伪类**能表达的东西，其余仍走 inline style）。
 * 目前只有一条：树行右侧的大小/子项数**默认隐藏，hover 或选中时淡入**（Obsidian 观感）。
 * 用 `<style>` 而不是每行 `useState` 的理由：一棵树动辄上百行，状态化 hover 会带来整树重渲染。
 */
const KB_SCOPED_CSS = `
.kb-meta { opacity: 0; transition: opacity .1s ease; }
.kb-row:hover .kb-meta, .kb-row[aria-selected="true"] .kb-meta { opacity: .85; }
/* 节头右侧的工具按钮：默认隐藏，hover 才现（Obsidian 的节头没有任何工具条） */
.kb-sec-extra { opacity: 0; transition: opacity .1s ease; }
.kb-sec-head:hover .kb-sec-extra { opacity: 1; }
/* 排序条同理：hover 整节时才出现，默认保持 Obsidian 的干净版面 */
.kb-sortbar { opacity: 0; transition: opacity .1s ease; }
.kb-sec:hover .kb-sortbar, .kb-sortbar:hover { opacity: 1; }
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
		/** 非 Markdown 文件的预览信息（有它就不渲染 Markdown，也不显示「编辑」） */
		asset?: { kind: 'image' | 'pdf' | 'video' | 'audio'; url: string };
	} | null>(null);
	/** 行内编辑草稿（`null` = 不在编辑态） */
	const [draft, setDraft] = useState<string | null>(null);

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
	/** 标题行的「库下拉」（切换 / 新建 / 本地载入） */
	const [vaultMenu, setVaultMenu] = useState(false);

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
			void load(node.path)
				.then(d => setDoc({ ...(d ?? { title: node.name, text: '读取失败：宿主没有返回正文' }), path: node.path }))
				.catch(() => setDoc({ title: node.name, text: '读取失败', path: node.path }));
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
			background: c.bg, color: c.fg, fontFamily: 'var(--vscode-font-family, "Segoe UI", sans-serif)',
			fontSize: 13, overflow: 'hidden',
		}}>
			<style>{KB_SCOPED_CSS}</style>
			<div style={{ display: 'flex', flexDirection: 'column', height: '100%', flex: docMode ? '0 0 340px' : '1 1 auto', minWidth: 0, minHeight: 0 }}>
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
					if (actions?.openSettings) { actions.openSettings(); return; }
					setShowSettings(true);
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
				{actions?.openGraph ? <IconBtn title="关系图谱" label="🕸" onClick={() => actions?.openGraph?.()} /> : null}
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
						{(data.vaults ?? []).map(v => (
							<button
								key={v.id}
								type="button"
								onClick={() => { setVaultMenu(false); actions?.switchVault?.(v.id); }}
								style={{
									display: 'flex', alignItems: 'center', gap: 6, width: '100%', height: 24, padding: '0 8px',
									background: v.id === data.activeVaultId ? 'rgba(127,127,127,.18)' : 'transparent',
									border: 0, borderRadius: 3, color: 'inherit', fontSize: 12, cursor: 'pointer',
								}}
							>
								<span style={{ flex: 1, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
								<span style={{ color: c.fgFaint, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{v.count}</span>
							</button>
						))}
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
									onClick={() => { setVaultMenu(false); setDialog({ kind: 'vaultAttach', value: '' }); }}
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
									<div style={{ fontSize: 12, color: c.fg }}>{r.title}</div>
									{r.snippet && (
										<div style={{ fontSize: 11, color: c.fgFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
											{r.snippet}
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
							<span style={{ display: 'flex', gap: 2 }}>
								<IconBtn title="新建笔记" label="＋" onClick={e => {
									e?.stopPropagation?.();
									if (actions?.useInlineDialogs) { setDialog({ kind: 'newNote', value: '未命名笔记' }); return; }
									actions?.createNote?.('');
								}} />
								<IconBtn title="新建目录" label="▤" onClick={e => {
									e?.stopPropagation?.();
									if (actions?.useInlineDialogs) { setDialog({ kind: 'newFolder', value: '新目录' }); return; }
									actions?.newFolder?.('');
								}} />
							</span>
						}
					/>
					{expanded.notes && (
						<div className="kb-sortbar" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px 4px' }}>
							<span style={{ fontSize: 10.5, color: c.fgFaint }}>排序</span>
							{([
								['name', '名称↑'], ['nameDesc', '名称↓'],
								['size', '大小↓'],
								['mtime', '时间↓'], ['mtimeAsc', '时间↑'],
							] as const).map(([k, label]) => (
								<button
									key={k}
									type="button"
									onClick={() => setSortKey(k)}
									style={{
										height: 19, padding: '0 7px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
										background: sortKey === k ? c.sel : 'transparent',
										color: sortKey === k ? c.selFg : c.fgDim,
										border: `1px solid ${sortKey === k ? c.sel : c.line}`,
									}}
								>{label}</button>
							))}
							{/* 右侧动作（宿主没提供就整块不渲染，不留死按钮） */}
							{(actions?.openMindmap || actions?.runLint || actions?.runDedup || actions?.reviewQueue) && <span style={{ flex: 1 }} />}
							{actions?.reviewQueue && (
								<button
									type="button"
									title="查看 .review/ 待审条目（只读）"
									onClick={() => actions?.reviewQueue?.()}
									style={{
										height: 19, padding: '0 8px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
										background: 'transparent', color: c.fgDim, border: `1px solid ${c.line}`,
									}}
								>审核</button>
							)}
							{actions?.runDedup && (
								<button
									type="button"
									title="检测疑似重复，产出 dedup-report.md"
									onClick={() => actions?.runDedup?.()}
									style={{
										height: 19, padding: '0 8px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
										background: 'transparent', color: c.fgDim, border: `1px solid ${c.line}`,
									}}
								>去重</button>
							)}
							{actions?.openMindmap && (
								<button
									type="button"
									title="打开/生成思维导图"
									onClick={() => actions?.openMindmap?.()}
									style={{
										height: 19, padding: '0 8px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
										background: 'transparent', color: c.fgDim, border: `1px solid ${c.line}`,
									}}
								>导图</button>
							)}
							{actions?.runLint && (
								<button
									type="button"
									title="跑结构校验，产出 lint-report.md"
									onClick={() => actions?.runLint?.()}
									style={{
										height: 19, padding: '0 8px', fontSize: 10.5, cursor: 'pointer', borderRadius: 3,
										background: 'transparent', color: c.fgDim, border: `1px solid ${c.line}`,
									}}
								>体检</button>
							)}
						</div>
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
				<div style={{ flex: '1 1 auto', minWidth: 0, minHeight: 0, overflow: 'auto', borderLeft: `1px solid ${c.line}`, padding: '14px 18px' }}>
					{doc ? (
						<>
							{/* 标题行：右端「编辑 / 保存·取消」——只有宿主提供 saveDoc 时才出现 */}
							<div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
								<div style={{ fontSize: 14, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
								{!doc.asset && actions?.saveDoc && doc.path ? (
									draft === null ? (
										<button type="button" onClick={() => setDraft(doc.text)} title="在当前面板里编辑并保存"
											style={{ height: 22, padding: '0 9px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>编辑</button>
									) : (
										<>
											<button type="button" onClick={() => { void (async () => {
												if (!doc.path) { return; }
												const res = await saveDocText(doc.path, draft, doc.mtime);
												if (res.ok) { setDoc({ ...doc, text: draft, mtime: res.mtime }); setDraft(null); }
											})(); }}
												style={{ height: 22, padding: '0 9px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'var(--vscode-button-background, #0e639c)', color: 'var(--vscode-button-foreground, #fff)', border: '1px solid transparent' }}>保存</button>
											<button type="button" onClick={() => setDraft(null)}
												style={{ height: 22, padding: '0 9px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>取消</button>
										</>
									)
								) : null}
								{!doc.asset && actions?.listBackups && doc.path ? (
									<button type="button" title="查看自动备份，可一键恢复"
										onClick={() => { if (backups) { setBackups(null); } else { void openHistory(); } }}
										style={{ height: 22, padding: '0 9px', fontSize: 11, cursor: 'pointer', borderRadius: 3, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>
										{backups ? '收起历史' : '历史'}
									</button>
								) : null}
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
							{doc.asset ? (
								<div style={{ padding: '4px 0' }}>
									{doc.asset.kind === 'image'
										? <img src={doc.asset.url} alt={doc.title} style={{ maxWidth: '100%', borderRadius: 4, border: '1px solid rgba(127,127,127,.25)', display: 'block' }} />
										: doc.asset.kind === 'pdf'
											? <embed src={doc.asset.url} type="application/pdf" style={{ width: '100%', height: 560, border: '1px solid rgba(127,127,127,.35)', borderRadius: 4 }} />
											: doc.asset.kind === 'video'
												? <video src={doc.asset.url} controls style={{ maxWidth: '100%', borderRadius: 4 }} />
												: <audio src={doc.asset.url} controls style={{ width: '100%' }} />}
									<div style={{ marginTop: 6, fontSize: 11, opacity: .55 }}>{doc.asset.url}</div>
								</div>
							) : draft !== null ? (
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
									style={{
										width: '100%', minHeight: 420, boxSizing: 'border-box', resize: 'vertical',
										padding: '8px 10px', background: c.inputBg, color: c.inputFg, border: `1px solid ${c.line}`,
										borderRadius: 4, fontSize: 12.5, lineHeight: 1.7,
										fontFamily: 'var(--vscode-editor-font-family, monospace)',
									}}
								/>
							) : (
								<div style={{ opacity: .95 }}>
									{renderMarkdown(doc.text, {
										assetUrl: actions?.assetUrl,
										base: doc.base,
										onTaskToggle: actions?.saveDoc && doc.path ? (li) => { void toggleTask(li); } : undefined,
									})}
								</div>
							)}
						</>
					) : (
						<div style={{ color: c.fgFaint, fontSize: 12 }}>点左边的笔记看正文</div>
					)}
				</div>
			) : null}

			{/* 设置面板（⚙）：dsh 侧没有宿主设置页，这里给出真正能用的几项 */}
			{showSettings ? (
				<div
					data-kb-settings="1"
					role="dialog"
					aria-modal="true"
					onClick={() => setShowSettings(false)}
					style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 61, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
				>
					<div
						onClick={e => e.stopPropagation()}
						style={{ width: 460, maxHeight: '82%', overflow: 'auto', background: 'var(--vscode-menu-background, #252526)', border: `1px solid ${c.line}`, borderRadius: 6, padding: 14, boxShadow: '0 10px 30px rgba(0,0,0,.5)' }}
					>
						<div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
							<div style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>知识库设置</div>
							<button type="button" onClick={() => setShowSettings(false)}
								style={{ height: 22, padding: '0 10px', fontSize: 11.5, cursor: 'pointer', borderRadius: 4, background: 'transparent', color: 'inherit', border: `1px solid ${c.line}` }}>关闭</button>
						</div>

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
