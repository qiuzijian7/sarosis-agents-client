/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, append } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { IAgentOSService } from '../common/agentOS.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { MemoryDetailEditorInput } from './memoryDetailEditorInput.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { ICodebaseGraphService } from './codebaseGraphService.js';
import { CodebaseGraphViewerEditorInput } from './codebaseGraphViewerEditorInput.js';
import { FIXED_SLOT_NAMES, IMemoryProvider } from '../common/providers.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';

interface IMemoryEntry {
	id: string;
	type: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp?: number;
}

/** 
 * agentmemory 原生类型筛选器 — 直接使用 Memory.type 值，不再做 4-Tier 映射。
 * 所有 agentmemory 细分类型（pattern/preference/bug/fact/architecture/workflow）均为一级筛选标签。
 */
type LayerFilter = 'all' | 'working' | 'episodic' | 'semantic' | 'procedural'
	| 'pattern' | 'preference' | 'architecture' | 'bug' | 'workflow' | 'fact';

/** Episodic 层的原生类型集合（agentmemory 原版：KV.memories 内 Memory.type 的合法值） */
const EPISODIC_TYPES: ReadonlySet<string> = new Set(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact']);
function isEpisodicType(type: string): boolean { return EPISODIC_TYPES.has(type); }


/** 分类 → 头部统计色板 class（与 _addStat 的原配色保持一致） */
const CATEGORY_HOVER_CLS: Record<string, string> = {
	working: 'l0', episodic: 'l1', pattern: 'l1', fact: 'l1', preference: 'l1', architecture: 'l2',
	bug: 'l1', workflow: 'l3', semantic: 'l2', procedural: 'l3',
};

/** 分类 → hover 提示（触发逻辑 / 写入时机） */
const CATEGORY_TRIGGER_TIPS: Record<string, string> = {
	working: '**Working · 原始观察**\n\n- 触发：每次会话中产生的瞬时上下文、临时笔记、未固化的原始输入\n- 写入：Agent 在对话/工具执行过程中自动落盘的原始观察\n- 特点：高频、低结构化，是其他类型的来源',
	episodic: '**Episodic · 长时记忆层**\n\n- 含义：KV.memories 中的所有长时记忆（原生类型 pattern/fact/preference/architecture/bug/workflow）\n- 写入：memory_remember / 固化管线沉淀\n- 本行计数 = 全部原生类型之和',
	pattern: '**Pattern · 模式**\n\n- 触发：从多条 Working/Episodic 中归纳出的可复用规律\n- 写入：压缩/固化阶段检测到重复行为模式时自动提炼\n- 特点：抽象层高于 Fact，描述"什么情况下该怎么做"',
	fact: '**Fact · 事实**\n\n- 触发：被明确陈述或反复验证为真的客观信息（配置、接口、约束）\n- 写入：用户确认、文档提取或稳定出现 ≥N 次的事实\n- 特点：原子化、可被 Semantic 聚合',
	preference: '**Preference · 偏好**\n\n- 触发：用户表达的主观倾向（语言、风格、工具选择、约定）\n- 写入：用户在对话中明确要求或否定某做法\n- 特点：指导 Agent 的默认行为，优先级高',
	architecture: '**Architecture · 架构**\n\n- 触发：关于代码结构、模块边界、依赖关系的高层描述\n- 写入：代码库扫描（Codebase Memory）或设计讨论沉淀\n- 特点：跨会话稳定，服务于 Semantic 检索',
	bug: '**Bug · 缺陷**\n\n- 触发：出现的错误、异常、回归以及与它们的修复方案\n- 写入：报错被定位并修复后记录根因与对策\n- 特点：避免重复踩坑，含 trigger → fix 映射',
	workflow: '**Workflow · 工作流**\n\n- 触发：多步骤的重复操作流程（发布、构建、回归）\n- 写入：顺序动作被成功执行后固化为流程模板\n- 特点：可被 Agent 直接调用执行',
	semantic: '**Semantic · 语义**\n\n- 触发：跨领域的概念关系、知识图谱节点与推理结论\n- 写入：Fact/Architecture 经语义聚合后生成\n- 特点：支撑 RAG 检索与跨 agent 共享',
	procedural: '**Procedural · 程序化**\n\n- 触发：可复用的程序化技能（Skill），由 feat.extractSkill 提炼\n- 写入：从历史会话提取并落盘为 SKILL.md（~/.vssaros/skills）\n- 特点：最高可执行性，直接驱动工具调用',
};
type ViewName = 'memories' | 'sessions' | 'slots' | 'lessons' | 'consolidation' | 'audit' | 'hooks' | 'commits' | 'report' | 'skills';

/** Check if a memory belongs to a specific filter。
 *  'episodic' 视为「层」（匹配全部原生类型）；working/semantic/procedural 为层类型精确匹配；其余为原生类型精确匹配。 */
function matchesTier(mem: IMemoryEntry, tier: LayerFilter): boolean {
	if (tier === 'all') return true;
	if (tier === 'episodic') return isEpisodicType(mem.type);
	return mem.type === tier;
}

export class MemoryDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentStudio.memoryDetail';

	private _container: HTMLElement | null = null;
	private _agentId: string = 'default';
	private _allMemories: IMemoryEntry[] = [];
	private _layerFilter: LayerFilter = 'all';
	private _searchQuery: string = '';
	private _targetContentPreview: string | null = null;
	private _agentFilter: string = '__all__'; // '__all__' = 所有 agent，其他值 = 指定 agentId
	private _currentView: ViewName = 'memories';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentOSService private readonly _agentOSService: IAgentOSService,
		@ICodebaseMemoryMcpService private readonly _cbmService: ICodebaseMemoryMcpService,
		@ICodebaseGraphService private readonly _codebaseGraphService: ICodebaseGraphService,
		@IEditorService private readonly _editorService: IEditorService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IHoverService private readonly _hoverService: IHoverService,
	) {
		super(MemoryDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this._container = append(parent, $('.memory-detail-container'));
		this._injectStyles();
		this._renderLoading();
	}

	private _loadMemoryPromise: Promise<void> | null = null;

	/**
	 * 根据当前 agent filter 加载记忆数据。
	 * '__all__' → 加载所有 agent 的数据（searchAllAgents）
	 * 其他值 → 加载指定 agent 的数据（searchMemory）
	 */
	private async _loadMemoryWithFilter(): Promise<void> {
		if (this._agentFilter === '__all__') {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			if (!memProvider?.searchAllAgents) {
				this._loadMemory();
				return;
			}
			this._renderLoading();
			try {
				const results = await memProvider.searchAllAgents('');
				console.log(`[MemoryDetailEditorPane] searchAllAgents returned: ${results?.length ?? 0} results`);
				this._allMemories = (results || []).map((e: any) => ({
					id: e.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
					type: e.type || (e.metadata?.['memoryType'] as string) || 'working',
					content: e.content || '',
					metadata: { ...e.metadata, agentId: e.agentId },
					timestamp: e.timestamp,
				}));
				this._renderFull();
			} catch (err) {
				console.error('[MemoryDetailEditorPane] searchAllAgents failed:', err);
				this._renderEmpty(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		} else {
			this._agentId = this._agentFilter;
			this._loadMemory();
		}
	}

	override async setInput(input: MemoryDetailEditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._agentId = input.agentId;
		if (input.targetLayer) {
			this._layerFilter = input.targetLayer as LayerFilter;
		}
		// 从聊天框跳转 → 默认仅显示当前 agent；从侧边栏打开 → 默认全部 agent
		this._agentFilter = input.fromAgentChat ? this._agentId : '__all__';
		await this._loadMemoryWithFilter();
	}

	private _injectStyles(): void {
		if (!this._container) { return; }
		const style = document.createElement('style');
		style.textContent = `
			.memory-detail-container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
			/* View navigation */
			.md-view-nav { display: flex; gap: 2px; padding: 6px 20px 0; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; background: var(--vscode-editorWidget-background); }
			.md-view-tab { padding: 6px 14px; cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; transition: all 0.15s; }
			.md-view-tab:hover { color: var(--vscode-foreground); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
			.md-view-tab.active { color: var(--vscode-foreground); background: var(--vscode-editor-background); border-color: var(--vscode-widget-border); border-bottom-color: var(--vscode-editor-background); margin-bottom: -1px; }
			/* Header */
			.md-header { padding: 16px 20px 8px; flex-shrink: 0; }
			.md-header h1 { font-size: 16px; font-weight: 600; margin-bottom: 8px; color: var(--vscode-foreground); }
			.md-stats { display: flex; gap: 10px; flex-wrap: wrap; }
			.md-stat { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 6px; padding: 6px 14px; cursor: help; }
			.md-stat .label { font-size: 10px; color: var(--vscode-descriptionForeground); }
			.md-stat .value { font-size: 16px; font-weight: 600; color: var(--vscode-foreground); }
			.md-stat.l0 .value { color: #569cd6; } .md-stat.l1 .value { color: #4ec9b0; }
			.md-stat.l2 .value { color: #b799ff; } .md-stat.l3 .value { color: #f0a04b; }
			/* Layer tabs */
			.md-layer-tabs { display: flex; border-bottom: 1px solid var(--vscode-widget-border); padding: 0 20px; flex-shrink: 0; }
			.md-layer-tab { padding: 8px 16px; cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); border-bottom: 2px solid transparent; transition: all 0.15s; display: flex; align-items: center; gap: 4px; }
			.md-layer-tab:hover { color: var(--vscode-foreground); }
			.md-layer-tab.active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, #3794ff); }
		.md-layer-tab .count { background: var(--vscode-badge-background, rgba(128,128,128,0.2)); font-size: 10px; padding: 1px 6px; border-radius: 8px; color: var(--vscode-badge-foreground, #888); }
		/* Episodic 原生类型细分（第二行，视觉次级） */
		.md-layer-tabs.md-type-tabs { background: var(--vscode-sideBar-background, rgba(128,128,128,0.04)); }
		.md-layer-tabs.md-type-tabs .md-layer-tab { padding: 5px 14px; font-size: 11px; opacity: 0.85; }
		/* Filter bar */
			.md-filter-bar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; }
			.md-filter-label { font-size: 11px; color: var(--vscode-descriptionForeground); }
			.md-filter-chip { padding: 3px 10px; border-radius: 12px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); transition: all 0.15s; }
			.md-filter-chip:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); }
			.md-filter-chip.active { background: var(--vscode-focusBorder, #3794ff); color: white; border-color: var(--vscode-focusBorder, #3794ff); }
			.md-search { margin-left: auto; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 4px 10px; color: var(--vscode-input-foreground); font-size: 12px; width: 200px; outline: none; }
			/* Memory list */
			.md-list { flex: 1; overflow-y: auto; padding: 12px 20px; }
			.md-list::-webkit-scrollbar { width: 6px; } .md-list::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.3); border-radius: 3px; }
			/* Memory card */
			.md-card { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
			.md-card-header { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid rgba(128,128,128,0.06); cursor: pointer; }
			.md-card-header:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
			.md-badge { font-size: 10px; font-weight: 600; padding: 2px 8px; border-radius: 10px; flex-shrink: 0; }
			.md-badge.l0 { background: rgba(86,156,214,0.1); color: #569cd6; }
			.md-badge.l1 { background: rgba(78,201,176,0.15); color: #4ec9b0; }
			.md-badge.l2 { background: rgba(183,153,255,0.15); color: #b799ff; }
			.md-badge.l3 { background: rgba(240,160,75,0.15); color: #f0a04b; }
			.md-badge.superseded { background: rgba(244,63,94,0.12); color: #f43f5e; text-decoration: line-through; }
			.md-card-strength { font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 8px; flex-shrink: 0; }
			.md-card-strength.high { background: rgba(93,202,165,0.15); color: #5dcaa5; }
			.md-card-strength.mid { background: rgba(240,160,75,0.15); color: #f0a04b; }
			.md-card-strength.low { background: rgba(244,63,94,0.12); color: #f43f5e; }
			.md-card-title { font-size: 12px; color: var(--vscode-foreground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
			.md-card-time { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
			.md-card-action { font-size: 11px; cursor: pointer; opacity: 0.55; flex-shrink: 0; padding: 0 3px; border-radius: 3px; }
			.md-card-action:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, rgba(90,93,94,0.31)); }
			.md-expand { color: var(--vscode-descriptionForeground); font-size: 10px; flex-shrink: 0; transition: transform 0.2s; }
			.md-card.expanded .md-expand { transform: rotate(90deg); }
			.md-content-box { max-height: 0; overflow: hidden; transition: max-height 0.25s ease; }
			.md-card.expanded .md-content-box { max-height: 500px; }
			.md-content { padding: 12px 14px; max-height: 440px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: var(--vscode-foreground); }
			.md-content::-webkit-scrollbar { width: 4px; } .md-content::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.2); border-radius: 2px; }
			/* markdown */
			.md-content h1 { font-size: 16px; font-weight: 600; margin: 8px 0 4px; }
			.md-content h2 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; }
			.md-content h3 { font-size: 13px; font-weight: 600; margin: 6px 0 3px; }
			.md-content p { margin: 4px 0; }
			.md-content code { background: rgba(128,128,128,0.15); padding: 1px 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; }
			.md-content pre { background: rgba(0,0,0,0.3); padding: 8px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; }
			.md-content pre code { background: transparent; padding: 0; }
			.md-content ul, .md-content ol { margin: 4px 0 4px 20px; }
			.md-content li { margin: 2px 0; }
			.md-content strong { font-weight: 600; }
			.md-content em { color: var(--vscode-editorWarning-foreground, #dcdcaa); }
			.md-content blockquote { border-left: 3px solid var(--vscode-focusBorder, #3794ff); padding-left: 10px; margin: 6px 0; color: var(--vscode-descriptionForeground); }
			/* meta chips */
			.md-meta { padding: 6px 14px; border-top: 1px solid rgba(128,128,128,0.06); display: flex; flex-wrap: wrap; gap: 4px; }
			.md-meta-chip { font-size: 10px; padding: 2px 8px; border-radius: 10px; background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1)); color: var(--vscode-descriptionForeground); }
			.md-meta-chip.priority { background: rgba(255,165,0,0.12); color: #ffa500; }
			.md-meta-chip.scene { background: rgba(183,153,255,0.1); color: #b799ff; }
			.md-meta-chip.role { background: rgba(78,201,176,0.1); color: #4ec9b0; }
			.md-meta-chip.session { background: rgba(55,148,255,0.1); color: #3794ff; }
			/* target highlight */
			.md-card.target { border-color: var(--vscode-focusBorder, #3794ff); box-shadow: 0 0 0 2px rgba(55,148,255,0.2); }
			/* empty/loading */
			.md-empty { padding: 60px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
			.md-loading { padding: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
			/* Action toolbar */
			.md-toolbar { display: flex; gap: 6px; padding: 6px 20px; border-bottom: 1px solid var(--vscode-widget-border); flex-shrink: 0; flex-wrap: wrap; }
			.md-btn { padding: 4px 12px; border-radius: 4px; font-size: 11px; cursor: pointer; border: 1px solid var(--vscode-widget-border); background: var(--vscode-editorWidget-background); color: var(--vscode-descriptionForeground); transition: all 0.15s; display: flex; align-items: center; gap: 4px; }
			.md-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder, #3794ff); background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.06)); }
			.md-btn:active { transform: scale(0.96); }
			.md-btn.primary { background: var(--vscode-focusBorder, #3794ff); color: white; border-color: var(--vscode-focusBorder, #3794ff); }
			.md-btn.primary:hover { opacity: 0.9; }
			.md-btn.danger { color: #f48771; border-color: rgba(244,135,113,0.3); }
			.md-btn.danger:hover { background: rgba(244,135,113,0.1); border-color: #f48771; }
			/* Diagnostics panel */
			.md-diag-panel { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 600px; max-height: 70vh; overflow-y: auto; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 16px 20px; z-index: 1000; box-shadow: 0 8px 32px rgba(0,0,0,0.3); }
			.md-diag-panel h2 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
			.md-diag-section { margin-bottom: 12px; }
			.md-diag-section h3 { font-size: 12px; font-weight: 600; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
			.md-diag-item { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; border-bottom: 1px solid rgba(128,128,128,0.06); }
			.md-diag-item .key { color: var(--vscode-descriptionForeground); }
			.md-diag-item .val { color: var(--vscode-foreground); font-weight: 500; }
			.md-diag-item .val.pass { color: #5dcaa5; } .md-diag-item .val.warn { color: #cca75d; } .md-diag-item .val.fail { color: #f48771; }
			.md-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 999; }
		`;
		this._container.appendChild(style);
	}

	private _renderLoading(): void {
		if (!this._container) { return; }
		this._clearExceptStyle();
		append(this._container, $('.md-loading')).textContent = '加载记忆数据...';
	}

	private _clearExceptStyle(): void {
		if (!this._container) { return; }
		const styleEl = this._container.querySelector('style');
		while (this._container.firstChild) { this._container.removeChild(this._container.firstChild); }
		if (styleEl) { this._container.appendChild(styleEl); }
	}

	private async _loadMemory(): Promise<void> {
		// 防止并发加载：如果已有 pending 请求，复用之
		if (this._loadMemoryPromise) {
			return this._loadMemoryPromise;
		}
		this._loadMemoryPromise = this._doLoadMemory().finally(() => {
			this._loadMemoryPromise = null;
		});
		return this._loadMemoryPromise;
	}

	private async _doLoadMemory(): Promise<void> {
		// 立即渲染框架（header/tabs/toolbar/search），不阻塞等数据
		// — 消除打开面板时的"加载记忆数据..."白屏卡顿
		this._renderLoading();
		try {
			const memProvider = this._agentOSService.getActiveMemoryProvider();
			console.log(`[MemoryDetailEditorPane] _doLoadMemory: agentId=${this._agentId}, memProvider=${memProvider ? memProvider.id : 'null'}`);
			if (!memProvider) {
				if (this._allMemories.length > 0) {
					this._renderFull();
				} else {
					this._renderEmpty('未找到记忆服务');
				}
				return;
			}

			// 框架先行渲染（空数据），再异步拉取
			if (this._allMemories.length > 0) {
				// 已有缓存 → 先渲染旧数据，再异步刷新
				this._renderFull();
			} else {
				// 无缓存 → 渲染空框架
				this._allMemories = [];
				this._renderFull();
			}

			console.log(`[MemoryDetailEditorPane] calling searchMemory(${this._agentId}, '')...`);
			const results = await memProvider.searchMemory(this._agentId, '');
			console.log(`[MemoryDetailEditorPane] searchMemory returned: ${results?.length ?? 'null'} results`);
			const newMemories = (results || []).map(e => ({
				id: e.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
				type: e.type || (e.metadata?.['memoryType'] as string) || 'working',
				content: e.content || '',
				metadata: e.metadata,
				timestamp: e.timestamp,
			}));
			// 并入 working(core)/semantic/procedural 独立 scope——这些不在 KV.memories 内，
			// searchMemory 不返回，故 working/semantic/procedural 类型页签一直为空。
			newMemories.push(...await this._loadScopedMemories(memProvider));
			// searchMemory 返回空数组（而非抛异常），不覆盖已有缓存
			if (newMemories.length === 0 && this._allMemories.length > 0) {
				console.warn('[MemoryDetailEditorPane] searchMemory returned empty, keeping cached data');
			} else {
				this._allMemories = newMemories;
				console.log(`[MemoryDetailEditorPane] rendering ${newMemories.length} memories`);
			}
			this._renderFull();
		} catch (err) {
			console.error(`[MemoryDetailEditorPane] _doLoadMemory FAILED:`, err);
			if (this._allMemories.length > 0) {
				// 网络错误等但已有缓存数据，保留缓存并重新渲染（支持 navigateToTarget 跳转）
				this._renderFull();
			} else {
				this._renderEmpty(`加载失败: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	/**
	 * 读取 working(core)/semantic/procedural 独立 scope，映射为记忆视图条目。
	 * 这些 scope 不在 KV.memories 内，由 writeMemory 路由（方案A）写入：
	 *   working → mem:core-memory；semantic → mem:semantic；procedural → mem:procedural。
	 */
	private async _loadScopedMemories(memProvider: any): Promise<Array<{ id: string; type: string; content: string; metadata: Record<string, unknown>; timestamp: number }>> {
		const out: Array<{ id: string; type: string; content: string; metadata: Record<string, unknown>; timestamp: number }> = [];
		const toTs = (v: unknown): number => {
			const ms = typeof v === 'number' ? v : new Date(String(v ?? '')).getTime();
			return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
		};
		try {
			const core = await memProvider.coreMemoryList?.(this._agentId).catch(() => []) ?? [];
			for (const c of core as Array<Record<string, unknown>>) {
				out.push({ id: String(c['id'] ?? ''), type: 'working', content: String(c['content'] ?? ''), metadata: c, timestamp: toTs(c['updatedAt'] ?? c['createdAt']) });
			}
		} catch { /* scope 读取失败不阻断 */ }
		try {
			const sem = await memProvider.semanticList?.(this._agentId).catch(() => []) ?? [];
			for (const s of sem as Array<Record<string, unknown>>) {
				out.push({ id: String(s['id'] ?? ''), type: 'semantic', content: String(s['content'] ?? ''), metadata: s, timestamp: toTs(s['updatedAt'] ?? s['createdAt']) });
			}
		} catch { /* scope 读取失败不阻断 */ }
		try {
			const proc = await memProvider.proceduralList?.(this._agentId).catch(() => []) ?? [];
			for (const p of proc as Array<Record<string, unknown>>) {
				const title = String(p['title'] ?? p['content'] ?? '');
				const steps = Array.isArray(p['steps']) ? (p['steps'] as unknown[]).map(x => String(x)).join(' → ') : '';
				out.push({ id: String(p['id'] ?? ''), type: 'procedural', content: steps ? `${title}\n${steps}` : title, metadata: p, timestamp: toTs(p['updatedAt'] ?? p['createdAt']) });
			}
		} catch { /* scope 读取失败不阻断 */ }
		return out;
	}

	private _renderEmpty(msg: string): void {
		if (!this._container) { return; }
		this._clearExceptStyle();
		// 重新渲染视图导航栏，确保用户可以切换页签
		this._renderViewNav();
		const empty = append(this._container, $('.md-empty'));
		empty.style.padding = '40px 20px';
		empty.style.color = 'var(--vscode-descriptionForeground)';
		empty.style.fontSize = '13px';
		empty.textContent = msg;
	}

	private _renderViewNav(): void {
		const viewNav = append(this._container!, $('.md-view-nav'));
		const views: Array<{ id: ViewName; label: string }> = [
			{ id: 'memories', label: '🧠 记忆' },
			{ id: 'sessions', label: '💬 会话' },
			{ id: 'slots', label: '📌 槽位' },
			{ id: 'lessons', label: '📖 教训' },
			{ id: 'consolidation', label: '🔄 固化' },
			{ id: 'audit', label: '📋 审计' },
			{ id: 'hooks', label: '🪝 钩子' },
			{ id: 'commits', label: '🔀 提交' },
			{ id: 'report', label: '📊 报告' },
			{ id: 'skills', label: '⚡ 技能' },
		];
		for (const view of views) {
			const tab = append(viewNav, $('.md-view-tab'));
			tab.textContent = view.label;
			if (this._currentView === view.id) { tab.classList.add('active'); }
			tab.addEventListener('click', () => {
				this._currentView = view.id;
				this._renderFull();
			});
		}
	}

	private async _renderFull(): Promise<void> {
		if (!this._container) { return; }
		this._clearExceptStyle();

		// View navigation bar
		this._renderViewNav();

		// Route to the appropriate view renderer
		// 注意：slots/lessons 视图现已改为 async（await 网关代理），
		// 必须 await 后再 return，避免漂浮 Promise。
		switch (this._currentView) {
			case 'sessions': await this._renderSessionsView(); return;
			case 'slots': await this._renderSlotsView(); return;
			case 'lessons': await this._renderLessonsView(); return;
			case 'consolidation': await this._renderConsolidationView(); return;
			case 'audit': this._renderAuditView(); return;
			case 'hooks': await this._renderHooksView(); return;
			case 'commits': this._renderCommitsView(); return;
			case 'report': this._renderReportView(); return;
			case 'skills': await this._renderSkillsView(); return;
		}

		// ── Memories view (default) ──
		// Header
		const header = append(this._container, $('.md-header'));
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const headerRow = append(header, $('div'));
		headerRow.style.display = 'flex';
		headerRow.style.alignItems = 'center';
		headerRow.style.gap = '12px';
		headerRow.style.marginBottom = '8px';
		append(headerRow, $('h1')).textContent = '🧠 记忆详情';
		// Agent 下拉框
		const agentSelect = document.createElement('select');
		agentSelect.style.background = 'var(--vscode-input-background)';
		agentSelect.style.border = '1px solid var(--vscode-input-border)';
		agentSelect.style.borderRadius = '4px';
		agentSelect.style.padding = '3px 8px';
		agentSelect.style.color = 'var(--vscode-input-foreground)';
		agentSelect.style.fontSize = '12px';
		agentSelect.style.cursor = 'pointer';
		agentSelect.style.outline = 'none';
		const allOption = document.createElement('option');
		allOption.value = '__all__'; allOption.textContent = '全部 Agent';
		agentSelect.appendChild(allOption);
		// 当前 agent 选项（仅在非全部模式下显示为单独选项）
		const currentOption = document.createElement('option');
		currentOption.value = this._agentId; currentOption.textContent = `当前 Agent (${this._agentId})`;
		agentSelect.appendChild(currentOption);
		agentSelect.value = this._agentFilter;
		// 异步加载有其他数据的 agent 列表
		if (memProvider?.listAllAgentsWithData) {
			memProvider.listAllAgentsWithData().then((agents: string[]) => {
				for (const aid of agents) {
					if (aid === this._agentId) continue;
					const opt = document.createElement('option');
					opt.value = aid; opt.textContent = `Agent (${aid})`;
					agentSelect.appendChild(opt);
				}
			}).catch(() => {});
		}
		agentSelect.addEventListener('change', () => {
			this._agentFilter = agentSelect.value;
			this._loadMemoryWithFilter();
		});
		headerRow.appendChild(agentSelect);
		const stats = append(header, $('.md-stats'));
		this._addStat(stats, '总数', this._allMemories.length, '');
		// agentmemory 原版 4 层 + Episodic 原生类型细分
		const catStats: Array<[string, LayerFilter]> = [
			['Working', 'working'],
			['Episodic', 'episodic'],
			['Semantic', 'semantic'],
			['Procedural', 'procedural'],
			['Pattern', 'pattern'],
			['Fact', 'fact'],
			['Preference', 'preference'],
			['Architecture', 'architecture'],
			['Bug', 'bug'],
			['Workflow', 'workflow'],
		];
		for (const [label, type] of catStats) {
			const el = this._addStat(stats, label, this._countByTier(type), CATEGORY_HOVER_CLS[type]);
			if (CATEGORY_TRIGGER_TIPS[type]) {
				this._register(this._hoverService.setupDelayedHover(el, () => ({
					content: new MarkdownString(CATEGORY_TRIGGER_TIPS[type]),
				})));
			}
		}

		// Extended stats from AgentMemoryProvider (if available)
		// 注意：getExtendedStats 是 async（网关代理），但 _renderFull 内部不能再 await，
		// 否则与 _loadMemory 的多次 _renderFull 调用发生 DOM 追加竞态（出现 3 套重复 UI）。
		// 改为 fire-and-forget：等返回后再次只刷新统计区域。
		if (memProvider?.getExtendedStats) {
			this._loadExtendedStatsAsync(memProvider, header);
		}

		// Action toolbar
		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._loadMemoryWithFilter());
		if (memProvider?.flush) {
			this._addToolbarBtn(toolbar, '💾 Flush', '', async () => {
				try { await memProvider.flush!(); this._loadMemory(); } catch { /* best effort */ }
			});
		}
		if (memProvider?.getExtendedStats) {
			this._addToolbarBtn(toolbar, '📊 诊断', '', () => this._showDiagnostics(memProvider));
		}
		this._addToolbarBtn(toolbar, '📥 导出JSON', '', () => this._exportMemory('json'));
		this._addToolbarBtn(toolbar, '📄 导出MD', '', () => this._exportMemory('markdown'));
		this._addToolbarBtn(toolbar, '🔍 搜索历史', '', () => this._showSearchHistory(memProvider!));

		// Layer tabs — agentmemory 原版：第一行 4 层筛选，第二行 Episodic 原生类型细分
		const layerTabs = append(this._container, $('.md-layer-tabs'));
		this._addLayerTab(layerTabs, 'all', '全部');
		this._addLayerTab(layerTabs, 'working', 'Working');
		this._addLayerTab(layerTabs, 'episodic', 'Episodic');
		this._addLayerTab(layerTabs, 'semantic', 'Semantic');
		this._addLayerTab(layerTabs, 'procedural', 'Procedural');
		const typeTabs = append(this._container, $('.md-layer-tabs.md-type-tabs'));
		this._addLayerTab(typeTabs, 'pattern', 'Pattern');
		this._addLayerTab(typeTabs, 'fact', 'Fact');
		this._addLayerTab(typeTabs, 'preference', 'Preference');
		this._addLayerTab(typeTabs, 'architecture', 'Architecture');
		this._addLayerTab(typeTabs, 'bug', 'Bug');
		this._addLayerTab(typeTabs, 'workflow', 'Workflow');
		// Filter bar — only search, scope chips removed per user request
		const filterBar = append(this._container, $('.md-filter-bar'));
		const search = document.createElement('input');
		search.className = 'md-search'; search.type = 'text'; search.placeholder = '🔍 搜索记忆内容...';
		search.addEventListener('input', () => { this._searchQuery = search.value.toLowerCase().trim(); this._renderList(); });
		filterBar.appendChild(search);
		// List
		this._renderList();
	}

	/**
	 * 异步加载扩展统计（getExtendedStats 是 async 网关调用）。
	 *
	 * 注意：必须在 _renderFull 外部 fire-and-forget 调用，因为 _renderFull 内部
	 * 不能含 await —— 否则与 _loadMemory 多次触发 _renderFull 产生 DOM 追加竞态
	 * （出现 3 套重复 UI）。
	 */
	private _loadExtendedStatsAsync(memProvider: IMemoryProvider, header: HTMLElement): void {
		const fn = memProvider.getExtendedStats;
		if (!fn) { return; }
		Promise.resolve(fn.call(memProvider, this._agentId)).then((extStats: Record<string, unknown> | undefined) => {
			if (!this._container || !extStats || typeof extStats !== 'object') { return; }
			// 找已存在的 ext stats div（如果同时多次触发，留最新一份）
			const existing = header.querySelector('.md-extended-stats');
			if (existing) { existing.remove(); }
			const extStatsDiv = append(header, $('.md-stats.md-extended-stats'));
			extStatsDiv.style.marginTop = '6px';
			const entries = Object.entries(extStats).slice(0, 8);
			for (const [key, value] of entries) {
				const displayValue = typeof value === 'number'
					? (value > 1000 ? `${(value / 1000).toFixed(1)}K` : String(value))
					: typeof value === 'string' ? value.slice(0, 20) : String(value);
				this._addStat(extStatsDiv, key, displayValue, '');
			}
		}).catch(() => { /* best effort */ });
	}

	// ─── Slots View ──────────────────────────────────────────────────────

	// 注意：agentmemory 的真实 IMemoryProvider 现运行于网关子进程，
	// renderer 侧为 HTTP 代理，所有数据读取方法均为 async（返回 Promise）。
	// 下方各视图必须 await，否则会把 Promise 当成空数组/空对象 → 显示为空。
	private async _renderSlotsView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `📌 固定槽位 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());
		this._addToolbarBtn(toolbar, '➕ 新增槽位', '', () => this._addSlot(memProvider));

		// 固定 8 槽位模型：无论记忆提供者是否实现 getSlots、或网关是否返回数据，
		// 都展示这 8 个固定槽位；网关返回的内容优先覆盖，缺则显示「(空)」。
		// 这样即使网关未返回槽位数据，也不会误报「暂无固定槽位 / 暂无槽位数据」。
		try {
			const slots = memProvider?.getSlots ? await memProvider.getSlots(this._agentId) : [];
			const map = new Map<string, string>();
			for (const s of (slots ?? [])) { map.set(String(s.name ?? ''), String(s.content ?? '')); }
			const names = [
				...FIXED_SLOT_NAMES.filter((n) => !!n),
				...(slots ?? []).map((s) => String(s.name ?? '')).filter((n) => !!n && !FIXED_SLOT_NAMES.includes(n)),
			];
			if (names.length === 0) {
				this._renderEmpty('暂无固定槽位。点击"新增槽位"创建。');
				return;
			}
			const list = append(this._container, $('.md-list'));
			for (const name of names) {
				const content = map.get(name) ?? '';
				const card = append(list, $('.md-card'));
				const headerEl = append(card, $('.md-card-header'));
				append(headerEl, $('.md-badge.l2')).textContent = name;
				append(headerEl, $('.md-card-title')).textContent = content.slice(0, 80) || '(空)';
				this._addToolbarBtn(headerEl, '✏️', '', () => this._editSlot(memProvider, name, content));
				this._addToolbarBtn(headerEl, '🗑️', 'danger', async () => {
					try { await memProvider?.setSlot?.(this._agentId, name, ''); this._renderFull(); } catch { /* best effort */ }
				});
				// Expanded content
				const contentBox = append(card, $('.md-content-box'));
				card.classList.add('expanded');
				const contentEl = append(contentBox, $('.md-content'));
				contentEl.textContent = content;
				contentEl.style.whiteSpace = 'pre-wrap';
			}
		} catch { this._renderEmpty('加载槽位失败'); }
	}

	private async _addSlot(memProvider: any): Promise<void> {
		const name = prompt('槽位名称 (如: persona, guidance):');
		if (!name) { return; }
		const content = prompt('槽位内容:');
		if (content === null) { return; }
		try {
			await memProvider.setSlot?.(this._agentId, name, content);
			this._renderFull();
		} catch { /* best effort */ }
	}

	private async _editSlot(memProvider: any, name: string, currentContent: string): Promise<void> {
		const content = prompt(`编辑槽位 "${name}":`, currentContent);
		if (content === null) { return; }
		try {
			await memProvider.setSlot?.(this._agentId, name, content);
			this._renderFull();
		} catch { /* best effort */ }
	}

	// ─── Lessons View ────────────────────────────────────────────────────

	private async _renderLessonsView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `📖 教训 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());
		this._addToolbarBtn(toolbar, '➕ 新增教训', '', () => this._addLesson(memProvider));

		if (!memProvider?.getLessons) {
			this._renderEmpty('暂无教训数据');
			return;
		}

		try {
			const lessons = await memProvider.getLessons(this._agentId);
			if (!lessons || lessons.length === 0) {
				this._renderEmpty('暂无教训记录。');
				return;
			}
			const list = append(this._container, $('.md-list'));
			for (const lesson of lessons) {
				const card = append(list, $('.md-card'));
				const headerEl = append(card, $('.md-card-header'));
				append(headerEl, $('.md-badge.l3')).textContent = 'lesson';
				append(headerEl, $('.md-card-title')).textContent = String(lesson.content ?? '').slice(0, 80);
				if (lesson.tags?.length) {
					append(headerEl, $('.md-card-time')).textContent = lesson.tags.join(', ');
				}
				this._addToolbarBtn(headerEl, '🗑️', 'danger', async () => {
					try { await memProvider.deleteLesson?.(this._agentId, lesson.id); this._renderFull(); } catch { /* best effort */ }
				});
				// Expanded content
				const contentBox = append(card, $('.md-content-box'));
				card.classList.add('expanded');
				const contentEl = append(contentBox, $('.md-content'));
				contentEl.textContent = String(lesson.content ?? '');
				if (lesson.context) {
					append(contentEl, $('blockquote')).textContent = `上下文: ${lesson.context}`;
				}
			}
		} catch { this._renderEmpty('加载教训失败'); }
	}

	// ─── Sessions View（基于 agentmemory 会话机制）────────────────────────
	// 数据流：observe() → mem:obs:<agent>:<session> 暂存 → 阈值/session_end 触发
	// compressSession() → KV.summaries SessionSummary。本视图呈现该管线状态。

	private async _renderSessionsView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider() as any;
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `💬 会话 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());

		if (!memProvider?.listSessions) {
			this._renderEmpty('暂无会话数据（记忆服务未提供 listSessions）');
			return;
		}

		try {
			const [sessions, summaries] = await Promise.all([
				memProvider.listSessions(this._agentId).catch(() => []),
				(memProvider.listSummaries ? memProvider.listSummaries(this._agentId).catch(() => []) : Promise.resolve([])),
			]);
			const sessionList = (sessions ?? []) as Array<Record<string, unknown>>;
			const summaryList = (summaries ?? []) as Array<Record<string, unknown>>;
			if (sessionList.length === 0) {
				this._renderEmpty('暂无会话记录。开始对话后，观察会暂存到会话，达到阈值或会话结束时压缩为摘要。');
				return;
			}
			const summaryById = new Map<string, Record<string, unknown>>(summaryList.map(s => [String(s['sessionId']), s]));

			// 管线统计
			const totalObs = sessionList.reduce((n, s) => n + (Number(s['observationCount']) || 0), 0);
			const summarizedCount = sessionList.filter(s => summaryById.has(String(s['id']))).length;
			const stats = append(this._container, $('.md-stats'));
			stats.style.padding = '8px 20px';
			this._addStat(stats, '会话数', sessionList.length, 'l0');
			this._addStat(stats, '观察总数', totalObs, 'l1');
			this._addStat(stats, '已压缩会话', summarizedCount, 'l2');
			this._addStat(stats, '摘要数', summaryList.length, 'l3');

			const list = append(this._container, $('.md-list'));
			for (const s of sessionList) {
				const sid = String(s['id'] ?? '');
				const summary = summaryById.get(sid);
				this._appendSessionCard(list, s, summary, memProvider);
			}
		} catch {
			this._renderEmpty('加载会话失败');
		}
	}

	private _appendSessionCard(list: HTMLElement, s: Record<string, unknown>, summary: Record<string, unknown> | undefined, memProvider: any): void {
		const sid = String(s['id'] ?? '');
		const obsCount = Number(s['observationCount']) || 0;
		const compressed = !!summary;
		const card = append(list, $('.md-card'));

		// Header
		const headerEl = append(card, $('.md-card-header'));
		headerEl.style.cursor = 'pointer';
		const badge = append(headerEl, $(`.md-badge.${compressed ? 'l1' : 'l0'}`));
		badge.textContent = compressed ? '已压缩' : '暂存中';
		const title = (s['firstPrompt'] as string) || sid || '未命名会话';
		append(headerEl, $('.md-card-title')).textContent = title;
		append(headerEl, $('.md-card-time')).textContent = this._sessionRelTime(String(s['updatedAt'] ?? s['startedAt'] ?? ''));

		// Meta chips
		const meta = append(card, $('.md-meta'));
		meta.style.padding = '0 14px 8px';
		const obsChip = append(meta, $('.md-meta-chip'));
		obsChip.textContent = `👁 ${obsCount} 观察`;
		if (s['project']) {
			const projChip = append(meta, $('.md-meta-chip'));
			projChip.textContent = `📁 ${String(s['project'])}`;
		}
		if (summary && typeof summary['observationCount'] === 'number') {
			const compChip = append(meta, $('.md-meta-chip'));
			compChip.textContent = `🗜 压缩 ${summary['observationCount']} 观察`;
		}

		// Expandable content
		const contentBox = append(card, $('.md-content-box'));
		const contentEl = append(contentBox, $('.md-content'));

		let loaded = false;
		headerEl.addEventListener('click', async () => {
			const willExpand = !card.classList.contains('expanded');
			card.classList.toggle('expanded');
			if (!willExpand || loaded) { return; }
			loaded = true;
			await this._fillSessionDetail(contentEl, sid, summary, compressed, memProvider);
		});
	}

	private async _fillSessionDetail(contentEl: HTMLElement, sid: string, summary: Record<string, unknown> | undefined, compressed: boolean, memProvider: any): Promise<void> {
		// 1. 压缩摘要（已压缩会话）
		if (compressed && summary) {
			const titleEl = append(contentEl, $('h3'));
			titleEl.textContent = `📋 ${String(summary['title'] ?? '会话摘要')}`;
			if (summary['narrative']) {
				const p = append(contentEl, $('p'));
				p.style.whiteSpace = 'pre-wrap';
				p.textContent = String(summary['narrative']);
			}
			const decisions = summary['keyDecisions'] as string[] | undefined;
			if (decisions?.length) {
				append(contentEl, $('h3')).textContent = '关键决策';
				const ul = append(contentEl, $('ul'));
				for (const d of decisions.slice(0, 10)) { append(ul, $('li')).textContent = String(d); }
			}
			const files = summary['filesModified'] as string[] | undefined;
			if (files?.length) {
				append(contentEl, $('h3')).textContent = '涉及文件';
				const ul = append(contentEl, $('ul'));
				for (const f of files.slice(0, 20)) { append(ul, $('li')).textContent = String(f); }
			}
			const concepts = summary['concepts'] as string[] | undefined;
			if (concepts?.length) {
				const p = append(contentEl, $('p'));
				p.style.color = 'var(--vscode-descriptionForeground)';
				p.textContent = `概念: ${concepts.slice(0, 20).join(', ')}`;
			}
		}

		// 2. 会话观察（暂存层）
		if (memProvider?.observeList) {
			append(contentEl, $('h3')).textContent = compressed ? '观察（暂存层残留）' : '观察（暂存层）';
			const loading = append(contentEl, $('p'));
			loading.textContent = '加载观察…';
			loading.style.color = 'var(--vscode-descriptionForeground)';
			try {
				const obs = (await memProvider.observeList(this._agentId, sid).catch(() => [])) as Array<Record<string, unknown>> | undefined;
				loading.remove();
				if (!obs || obs.length === 0) {
					const none = append(contentEl, $('p'));
					none.textContent = '（无观察）';
					none.style.color = 'var(--vscode-descriptionForeground)';
				} else {
					const recent = [...obs].sort((a, b) => String(b['timestamp'] ?? '').localeCompare(String(a['timestamp'] ?? ''))).slice(0, 15);
					const ul = append(contentEl, $('ul'));
					for (const o of recent) {
						const li = append(ul, $('li'));
						const imp = Number(o['importance']) || 0;
						const mark = o['compressed'] ? '🗜' : (imp >= 5 ? '⭐' : '·');
						li.textContent = `${mark} [${String(o['hookType'] ?? '')}] ${String(o['title'] ?? '').slice(0, 80)}`;
					}
					if (obs.length > 15) {
						const more = append(contentEl, $('p'));
						more.style.color = 'var(--vscode-descriptionForeground)';
						more.textContent = `… 共 ${obs.length} 条观察`;
					}
				}
			} catch {
				loading.textContent = '观察加载失败';
			}
		}
	}

	private _sessionRelTime(iso: string): string {
		const ms = new Date(iso).getTime();
		if (!ms || Number.isNaN(ms)) { return ''; }
		const diffMin = Math.floor((Date.now() - ms) / 60000);
		if (diffMin < 1) { return '刚刚'; }
		if (diffMin < 60) { return `${diffMin}分钟前`; }
		const diffHour = Math.floor(diffMin / 60);
		if (diffHour < 24) { return `${diffHour}小时前`; }
		return `${Math.floor(diffHour / 24)}天前`;
	}

	private async _addLesson(memProvider: any): Promise<void> {
		const content = prompt('教训内容:');
		if (!content) { return; }
		const context = prompt('上下文 (可选):') || undefined;
		const tagsStr = prompt('标签 (逗号分隔, 可选):') || '';
		const tags = tagsStr ? tagsStr.split(',').map((t: string) => t.trim()).filter(Boolean) : undefined;
		try {
			await memProvider.addLesson?.(this._agentId, content, context, tags);
			this._renderFull();
		} catch { /* best effort */ }
	}

	// ─── Consolidation View ─────────────────────────────────────────────

	private async _renderConsolidationView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `🔄 记忆固化 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());

		if (!memProvider?.getEpisodicMemories) {
			this._renderEmpty('暂无固化数据');
			return;
		}

		// Consolidation context summary
		try {
			const ctxResult: unknown = memProvider.getConsolidationContext?.(this._agentId);
			const ctxText = (ctxResult instanceof Promise ? await ctxResult : ctxResult) ?? '';
			if (ctxText) {
				const ctxBox = append(this._container, $('.md-card'));
				ctxBox.style.margin = '8px 20px';
				const ctxContent = append(ctxBox, $('.md-content'));
				ctxContent.style.maxHeight = '200px';
				ctxContent.textContent = ctxText;
				ctxContent.style.whiteSpace = 'pre-wrap';
			}
		} catch { /* best effort */ }

		const list = append(this._container, $('.md-list'));
		const tiers: Array<{ id: string; label: string; badge: string; fn: string }> = [
			{ id: 'episodic', label: 'Episodic', badge: 'l1', fn: 'getEpisodicMemories' },
			{ id: 'semantic', label: 'Semantic', badge: 'l2', fn: 'getSemanticMemories' },
			{ id: 'procedural', label: 'Procedural', badge: 'l3', fn: 'getProceduralMemories' },
		];
		for (const tier of tiers) {
			try {
				const result = (memProvider as any)[tier.fn]?.(this._agentId);
				const items = (result instanceof Promise ? await result : result) as Array<Record<string, unknown>> | undefined;
				if (!items || items.length === 0) { continue; }
				const sectionHeader = append(list, $('.md-card-header'));
				sectionHeader.style.borderBottom = '2px solid var(--vscode-widget-border)';
				append(sectionHeader, $(`.md-badge.${tier.badge}`)).textContent = tier.label;
				append(sectionHeader, $('.md-card-title')).textContent = `${items.length} 条`;
				for (const item of items) {
					const card = append(list, $('.md-card'));
					const cardHeader = append(card, $('.md-card-header'));
					append(cardHeader, $(`.md-badge.${tier.badge}`)).textContent = String(item['type'] ?? tier.id);
					append(cardHeader, $('.md-card-title')).textContent = String(item['content'] ?? item['narrative'] ?? '').slice(0, 80);
					if (item['timestamp']) {
						append(cardHeader, $('.md-card-time')).textContent = new Date(item['timestamp'] as number).toLocaleString();
					}
					const contentBox = append(card, $('.md-content-box'));
					const contentEl = append(contentBox, $('.md-content'));
					const content = String(item['content'] ?? item['narrative'] ?? '');
					contentEl.textContent = content;
					contentEl.style.whiteSpace = 'pre-wrap';
					// Render structured fields
					const fields = ['title', 'facts', 'concepts', 'files', 'importance', 'strength'];
					const meta = append(card, $('.md-meta'));
					for (const field of fields) {
						if (item[field] !== undefined && item[field] !== null) {
							const chip = append(meta, $('.md-meta-chip'));
							chip.textContent = `${field}: ${typeof item[field] === 'object' ? JSON.stringify(item[field]).slice(0, 60) : String(item[field])}`;
						}
					}
				}
			} catch { /* best effort per tier */ }
		}
	}

	// ─── Audit View ─────────────────────────────────────────────────────

	private async _renderAuditView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `📋 审计日志 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());

		if (!memProvider?.getAuditLog) {
			this._renderEmpty('当前记忆服务不支持审计 API');
			return;
		}

		// Audit summary（Opt1 异步转发到网关）
		try {
			let summary = memProvider.getAuditSummary?.();
			if (summary instanceof Promise) { summary = await summary; }
			if (summary && Object.keys(summary).length > 0) {
				const summaryDiv = append(this._container, $('.md-stats'));
				summaryDiv.style.padding = '8px 20px';
				for (const [key, value] of Object.entries(summary)) {
					this._addStat(summaryDiv, key, value, '');
				}
			}
		} catch { /* best effort */ }

		try {
			let log = memProvider.getAuditLog({ limit: 200 });
			if (log instanceof Promise) { log = await log; }
			if (!log || log.length === 0) {
				this._renderEmpty('暂无审计日志');
				return;
			}
			const list = append(this._container, $('.md-list'));
			for (const entry of log) {
				const card = append(list, $('.md-card'));
				const cardHeader = append(card, $('.md-card-header'));
				const op = String(entry['operation'] ?? 'unknown');
				const opBadge = append(cardHeader, $('.md-badge'));
				opBadge.textContent = op;
				opBadge.className = `md-badge ${op === 'write' ? 'l1' : op === 'delete' ? 'l3' : 'l0'}`;
				append(cardHeader, $('.md-card-title')).textContent = String(entry['agentId'] ?? '') + (entry['type'] ? ` · ${entry['type']}` : '');
				if (entry['timestamp']) {
					append(cardHeader, $('.md-card-time')).textContent = new Date(entry['timestamp'] as number).toLocaleTimeString();
				}
				const contentBox = append(card, $('.md-content-box'));
				card.classList.add('expanded');
				const contentEl = append(contentBox, $('.md-content'));
				contentEl.textContent = JSON.stringify(entry, null, 2);
				contentEl.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
				contentEl.style.fontSize = '11px';
			}
		} catch { this._renderEmpty('加载审计日志失败'); }
	}

	// ─── Hooks View ─────────────────────────────────────────────────────

	private async _renderHooksView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `🪝 Hook 系统 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());

		if (!memProvider?.getHookStats) {
			this._renderEmpty('暂无 Hook 数据');
			return;
		}

		try {
			// Opt1：真实 HookSystem 在网关进程，getHookStats 经代理返回 Promise。
			const stats = await memProvider.getHookStats();
			// Summary stats
			const summaryDiv = append(this._container, $('.md-stats'));
			summaryDiv.style.padding = '8px 20px';
			this._addStat(summaryDiv, '已注册钩子', stats.totalHooks, '');
			this._addStat(summaryDiv, '钩子类型数', Object.keys(stats.hooksByType).length, 'l1');

			// Hook types table
			const list = append(this._container, $('.md-list'));
			const hookTypes = ['session_start', 'prompt_submit', 'pre_tool_use', 'post_tool_use', 'post_tool_failure', 'pre_compact', 'task_completed', 'stop', 'session_end'];
			for (const ht of hookTypes) {
				const card = append(list, $('.md-card'));
				const cardHeader = append(card, $('.md-card-header'));
				const count = stats.hooksByType[ht] ?? 0;
				const calls = stats.callCounts[ht] ?? 0;
				const badge = append(cardHeader, $('.md-badge'));
				badge.textContent = ht;
				badge.className = `md-badge ${count > 0 ? 'l1' : ''}`;
				append(cardHeader, $('.md-card-title')).textContent = `${count} 个处理器`;
				append(cardHeader, $('.md-card-time')).textContent = `调用 ${calls} 次`;
				if (count === 0) {
					append(cardHeader, $('.md-card-strength.low')).textContent = '未注册';
				} else {
					append(cardHeader, $('.md-card-strength.high')).textContent = '活跃';
				}
			}
		} catch { this._renderEmpty('加载 Hook 统计失败'); }
	}

	// ─── Commits View (Git integration) ─────────────────────────────────

	private async _renderCommitsView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `🔀 Git 提交记录 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());

		if (!memProvider?.getRecentCommits) {
			this._renderEmpty('暂无 Git 提交数据');
			return;
		}

		// Commit stats summary（Opt1 异步转发到网关）
		try {
			let stats = memProvider.getCommitStats?.();
			if (stats instanceof Promise) { stats = await stats; }
			if (stats && typeof stats === 'object') {
				const statsDiv = append(this._container, $('.md-stats'));
				statsDiv.style.padding = '8px 20px';
				const s = stats as Record<string, unknown>;
				this._addStat(statsDiv, '总提交', String(s['totalCommits'] ?? 0), '');
				this._addStat(statsDiv, '新增行', String(s['totalInsertions'] ?? 0), 'l1');
				this._addStat(statsDiv, '删除行', String(s['totalDeletions'] ?? 0), 'l3');
				this._addStat(statsDiv, '平均文件/提交', String(s['avgFilesPerCommit'] ?? 0), 'l2');
			}
		} catch { /* best effort */ }

		try {
			let commits = memProvider.getRecentCommits(50);
			if (commits instanceof Promise) { commits = await commits; }
			if (!commits || commits.length === 0) {
				this._renderEmpty('暂无 Git 提交记录。提交代码后将自动捕获。');
				return;
			}
			const list = append(this._container, $('.md-list'));
			for (const commit of commits) {
				const card = append(list, $('.md-card'));
				const cardHeader = append(card, $('.md-card-header'));
				const c = commit as Record<string, unknown>;
				const md = (c['metadata'] as Record<string, unknown>) ?? {};
				append(cardHeader, $('.md-badge.l1')).textContent = String(md['sha'] ?? c['id'] ?? '').slice(0, 8);
				append(cardHeader, $('.md-card-title')).textContent = String(c['content'] ?? '').slice(0, 80);
				if (c['timestamp']) {
					append(cardHeader, $('.md-card-time')).textContent = new Date(c['timestamp'] as number).toLocaleString();
				}
				const imp = c['importance'] as number | undefined;
				if (typeof imp === 'number') {
					const strengthEl = append(cardHeader, $(`.md-card-strength.${imp >= 7 ? 'high' : imp >= 4 ? 'mid' : 'low'}`));
					strengthEl.textContent = `P${imp}`;
				}
				// Expanded content
				const contentBox = append(card, $('.md-content-box'));
				card.classList.add('expanded');
				const contentEl = append(contentBox, $('.md-content'));
				contentEl.textContent = String(c['content'] ?? '');
				contentEl.style.whiteSpace = 'pre-wrap';
				// Meta chips
				const meta = append(card, $('.md-meta'));
				if (md['author']) { append(meta, $('.md-meta-chip')).textContent = `👤 ${md['author']}`; }
				if (md['branch']) { append(meta, $('.md-meta-chip.scene')).textContent = `🌿 ${md['branch']}`; }
				const files = md['filesChanged'] as string[] | undefined;
				if (files?.length) { append(meta, $('.md-meta-chip.session')).textContent = `📄 ${files.length} files`; }
				const concepts = md['concepts'] as string[] | undefined;
				if (concepts?.length) {
					for (const concept of concepts.slice(0, 5)) {
						append(meta, $('.md-meta-chip')).textContent = `#${concept}`;
					}
				}
			}
		} catch { this._renderEmpty('加载提交记录失败'); }
	}

	// ─── Report View ────────────────────────────────────────────────────

	private _renderReportView(): void {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `📊 系统报告 (${this._agentId})`;

		const toolbar = append(this._container, $('.md-toolbar'));
		const reportTypes = [
			{ id: 'summary', label: '📋 摘要' },
			{ id: 'health', label: '🏥 健康' },
			{ id: 'performance', label: '⚡ 性能' },
			{ id: 'usage', label: '📈 使用' },
			{ id: 'detailed', label: '🔍 详细' },
		];
		for (const rt of reportTypes) {
			this._addToolbarBtn(toolbar, rt.label, '', async () => {
				this._generateAndDisplayReport(memProvider, rt.id);
			});
		}

		if (!memProvider?.generateReport) {
			this._renderEmpty('暂无报告数据');
			return;
		}

		// Auto-generate summary on first load
		this._generateAndDisplayReport(memProvider, 'summary');
	}

	private async _generateAndDisplayReport(memProvider: any, type: string): Promise<void> {
		if (!this._container) { return; }
		// Remove existing report content (keep header + toolbar)
		const existing = this._container.querySelector('.md-report-content');
		if (existing) { existing.remove(); }
		const content = append(this._container, $('.md-report-content'));
		content.classList.add('md-list');
		append(content, $('.md-loading')).textContent = `生成 ${type} 报告中...`;

		try {
			const report = await memProvider.generateReport(type, this._agentId);
			if (!report) {
				content.textContent = '报告为空';
				return;
			}
		content.replaceChildren();
		const r = report as Record<string, unknown>;

			// Overall health badge
			const health = String(r['overallHealth'] ?? 'unknown');
			const healthEl = append(content, $('.md-card'));
			healthEl.style.marginBottom = '12px';
			const healthHeader = append(healthEl, $('.md-card-header'));
			const healthBadge = append(healthHeader, $('.md-badge'));
			healthBadge.textContent = health.toUpperCase();
			healthBadge.className = `md-badge ${health === 'healthy' ? 'l1' : health === 'degraded' ? 'l2' : 'l3'}`;
			append(healthHeader, $('.md-card-title')).textContent = String(r['summary'] ?? '');

			// Recommendations
			const recs = r['recommendations'] as string[] | undefined;
			if (recs?.length) {
				const recCard = append(content, $('.md-card'));
				append(recCard, $('.md-card-header')).textContent = '💡 建议';
				const recContent = append(recCard, $('.md-content'));
				recContent.style.maxHeight = '200px';
				for (const rec of recs) {
					const li = append(recContent, $('div'));
					li.textContent = `• ${rec}`;
					li.style.margin = '4px 0';
				}
			}

			// Sections
			const sections = r['sections'] as Array<Record<string, unknown>> | undefined;
			if (sections?.length) {
				for (const section of sections) {
					const card = append(content, $('.md-card'));
					const cardHeader = append(card, $('.md-card-header'));
					const healthy = section['healthy'] !== false;
					const badge = append(cardHeader, $(`.md-badge.${healthy ? 'l1' : 'l3'}`));
					badge.textContent = healthy ? '✓' : '✗';
					append(cardHeader, $('.md-card-title')).textContent = String(section['name'] ?? 'unknown');

					const contentBox = append(card, $('.md-content-box'));
					card.classList.add('expanded');
					const sectionContent = append(contentBox, $('.md-content'));
					const metrics = section['metrics'] as Record<string, unknown> | undefined;
					if (metrics) {
						const metricsList = append(sectionContent, $('div'));
						metricsList.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
						metricsList.style.fontSize = '11px';
						for (const [key, value] of Object.entries(metrics)) {
							const row = append(metricsList, $('div'));
							row.style.display = 'flex';
							row.style.justifyContent = 'space-between';
							row.style.padding = '2px 0';
							row.style.borderBottom = '1px solid rgba(128,128,128,0.06)';
							append(row, $('span')).textContent = key;
							append(row, $('span')).textContent = String(value);
						}
					}

					// Warnings
					const warnings = section['warnings'] as string[] | undefined;
					if (warnings?.length) {
						for (const w of warnings) {
							const warnEl = append(sectionContent, $('blockquote'));
							warnEl.textContent = `⚠️ ${w}`;
							warnEl.style.color = '#cca75d';
						}
					}
				}
			}
	} catch (err) {
		content.replaceChildren();
		append(content, $('.md-empty')).textContent = `报告生成失败: ${err instanceof Error ? err.message : String(err)}`;
	}
}

// ─── Skills View ──────────────────────────────────────────────────────

	private async _renderSkillsView(): Promise<void> {
		if (!this._container) { return; }
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const header = append(this._container, $('.md-header'));
		append(header, $('h1')).textContent = `⚡ 技能 (${this._agentId})`;
		const subtitle = append(header, $('div'));
		subtitle.style.fontSize = '11px';
		subtitle.style.color = 'var(--vscode-descriptionForeground)';
		subtitle.style.marginBottom = '8px';
		subtitle.textContent = '从会话历史自动提取的可复用程序化技能 · 沉淀为标准 SKILL.md 格式 · 写入 ~/.vssaros/skills/';

		// Stats — Opt1：真实引擎在网关进程，方法为 async（agentId 为首参）。
		const stats = memProvider?.getSkillStats
			? await memProvider.getSkillStats(this._agentId)
			: undefined;

		// 技能使用追踪（读取 .usage.json sidecar）
		let usageSummary: { totalReads: number; totalPatches: number; recentUsed: number; pinnedCount: number } | undefined;
		try {
			const { URI } = await import('../../../../base/common/uri.js');
			const { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } = await import('../common/sarosPaths.js');
			const fs = await import('fs/promises');
			const path = await import('path');
			const home = process.env.USERPROFILE || process.env.HOME || '/';
			const skillsRoot = resolveSarosPath(
				userDataRootFromRoamingHome(URI.file(home)),
				SarosPath.skills,
			).fsPath;
			let totalReads = 0, totalPatches = 0, recentUsed = 0, pinnedCount = 0;
			const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
			const entries = await fs.readdir(skillsRoot, { withFileTypes: true }).catch(() => [] as any[]);
			for (const entry of (entries as any[])) {
				if (!entry.isDirectory()) { continue; }
				try {
					const usagePath = path.join(skillsRoot, entry.name, '.usage.json');
					const raw = await fs.readFile(usagePath, 'utf-8');
					const usage = JSON.parse(raw);
					totalReads += usage.readCount || 0;
					totalPatches += usage.patchCount || 0;
					if (usage.lastUsedAt && usage.lastUsedAt > monthAgo) { recentUsed++; }
					if (usage.pinned) { pinnedCount++; }
				} catch { /* .usage.json not found = no usage yet */ }
			}
			usageSummary = { totalReads, totalPatches, recentUsed, pinnedCount };
		} catch { /* usage tracking is best-effort */ }

		if (stats || usageSummary) {
			const statsEl = append(header, $('.md-stats'));
			if (stats) {
				this._addStat(statsEl, '总技能', stats.totalSkills, 'l3');
				this._addStat(statsEl, '平均置信度', stats.avgConfidence, 'confidence');
				this._addStat(statsEl, '总使用次数', stats.totalUsage, 'usage');
				this._addStat(statsEl, '已生成 SKILL.md', `${stats.writtenCount}/${stats.totalSkills}`, 'file');
			}
			if (usageSummary && usageSummary.totalReads > 0) {
				this._addStat(statsEl, 'read_skill 调用', usageSummary.totalReads, 'read');
				this._addStat(statsEl, 'Skill 修改次数', usageSummary.totalPatches, 'patch');
				this._addStat(statsEl, '近30天活跃', usageSummary.recentUsed, 'recent');
				if (usageSummary.pinnedCount > 0) {
					this._addStat(statsEl, '已钉选', usageSummary.pinnedCount, 'pinned');
				}
			}
		}

		// Info banner
		const banner = append(this._container, $('.md-card'));
		banner.style.margin = '0 20px 8px';
		banner.style.padding = '8px 12px';
		banner.style.background = 'rgba(86,156,214,0.08)';
		banner.style.border = '1px solid rgba(86,156,214,0.2)';
		banner.style.borderRadius = '6px';
		banner.style.fontSize = '11px';
		banner.style.color = '#569cd6';
		banner.textContent = '💡 技能提取后会自动生成 SKILL.md 文件到 ~/.vssaros/skills/<技能名>/SKILL.md，可在 Agent Studio 技能商城和 Claude Code 中直接使用';

		// Toolbar
		const toolbar = append(this._container, $('.md-toolbar'));
		this._addToolbarBtn(toolbar, '🔄 刷新', 'primary', () => this._renderFull());
		this._addToolbarBtn(toolbar, '➕ 手动新增', '', () => this._addSkill(memProvider));
		this._addToolbarBtn(toolbar, '📁 生成全部 SKILL.md', '', async () => {
			if (!memProvider?.writeAllSkillFiles) return;
			const result = await memProvider.writeAllSkillFiles(this._agentId);
			alert(`写入完成: ${result.written} 成功, ${result.failed} 失败${result.errors.length ? '\n' + result.errors.join('\n') : ''}`);
			this._renderFull();
		});
		this._addToolbarBtn(toolbar, '⬇ 导出 JSON', '', () => this._exportSkillsJson(memProvider));

		if (!memProvider?.listSkills) {
			this._renderEmpty('暂无技能数据');
			return;
		}

		try {
			const skills = await memProvider.listSkills(this._agentId);
		if (!skills || skills.length === 0) {
			this._renderEmpty('暂无技能记录。技能会在会话完成并执行固化后自动提取。');
			return;
		}

		// Filter bar
		const filterBar = append(this._container, $('.md-filter-bar'));
		append(filterBar, $('.md-filter-label')).textContent = '状态:';
		const allChip = append(filterBar, $('.md-filter-chip'));
		allChip.textContent = '全部'; allChip.classList.add('active');
		const writtenChip = append(filterBar, $('.md-filter-chip'));
		writtenChip.textContent = '已写入';
		const pendingChip = append(filterBar, $('.md-filter-chip'));
		pendingChip.textContent = '待写入';
		const search = document.createElement('input');
		search.className = 'md-search'; search.type = 'text'; search.placeholder = '🔍 搜索技能...';
		filterBar.appendChild(search);

		const list = append(this._container, $('.md-list'));
		const renderList = (filter: 'all' | 'written' | 'pending', query: string) => {
			list.replaceChildren();
			let filtered = skills;
			if (filter === 'written') filtered = filtered.filter((s: any) => s.skillMdWritten);
			if (filter === 'pending') filtered = filtered.filter((s: any) => !s.skillMdWritten);
			if (query) {
				const q = query.toLowerCase();
				filtered = filtered.filter((s: any) =>
					s.title.toLowerCase().includes(q) ||
					s.trigger.toLowerCase().includes(q) ||
					s.tags.some((t: string) => t.includes(q))
				);
			}
			for (const skill of filtered) {
				this._renderSkillCard(list, skill, memProvider);
			}
			if (filtered.length === 0) {
				append(list, $('.md-empty')).textContent = '无匹配技能';
			}
		};
		renderList('all', '');

		allChip.addEventListener('click', () => {
			allChip.classList.add('active'); writtenChip.classList.remove('active'); pendingChip.classList.remove('active');
			renderList('all', search.value);
		});
		writtenChip.addEventListener('click', () => {
			writtenChip.classList.add('active'); allChip.classList.remove('active'); pendingChip.classList.remove('active');
			renderList('written', search.value);
		});
		pendingChip.addEventListener('click', () => {
			pendingChip.classList.add('active'); allChip.classList.remove('active'); writtenChip.classList.remove('active');
			renderList('pending', search.value);
		});
		search.addEventListener('input', () => {
			const active = filterBar.querySelector('.md-filter-chip.active') as HTMLElement;
			const filter = active === writtenChip ? 'written' : active === pendingChip ? 'pending' : 'all';
			renderList(filter, search.value.toLowerCase().trim());
		});
	} catch { this._renderEmpty('加载技能失败'); }
}

private _renderSkillCard(list: HTMLElement, skill: any, memProvider: any): void {
	const card = append(list, $('.md-card'));
	if (!skill.skillMdWritten && skill.confidence >= 0.8) {
		card.style.borderColor = 'rgba(78,201,176,0.4)';
		card.style.borderLeft = '3px solid #4ec9b0';
	}

	// Header
	const headerEl = append(card, $('.md-card-header'));
	const badge = append(headerEl, $('.md-badge'));
	badge.textContent = skill.confidence >= 0.8 && !skill.skillMdWritten ? '⚡ NEW' : '⚡ 技能';
	badge.className = `md-badge ${skill.confidence >= 0.8 && !skill.skillMdWritten ? 'l1' : 'l3'}`;

	// Confidence
	const confEl = append(headerEl, $('span'));
	confEl.style.fontSize = '10px';
	confEl.style.fontWeight = '600';
	confEl.style.padding = '2px 6px';
	confEl.style.borderRadius = '8px';
	confEl.textContent = `置信度 ${skill.confidence.toFixed(2)}`;
	const confCls = skill.confidence >= 0.7 ? 'high' : skill.confidence >= 0.5 ? 'mid' : 'low';
	confEl.style.background = confCls === 'high' ? 'rgba(93,202,165,0.15)' : confCls === 'mid' ? 'rgba(240,160,75,0.15)' : 'rgba(244,63,94,0.12)';
	confEl.style.color = confCls === 'high' ? '#5dcaa5' : confCls === 'mid' ? '#f0a04b' : '#f43f5e';

	append(headerEl, $('.md-card-title')).textContent = skill.title;

	// SKILL.md status
	const statusEl = append(headerEl, $('span'));
	statusEl.style.fontSize = '10px';
	statusEl.style.padding = '2px 6px';
	statusEl.style.borderRadius = '4px';
	if (skill.skillMdWritten) {
		statusEl.textContent = '📄 SKILL.md ✓';
		statusEl.style.background = 'rgba(78,201,176,0.12)';
		statusEl.style.color = '#4ec9b0';
	} else {
		statusEl.textContent = '⏳ 待写入';
		statusEl.style.background = 'rgba(204,167,0,0.12)';
		statusEl.style.color = '#cca700';
	}

	// Usage + time
	const usageEl = append(headerEl, $('span'));
	usageEl.style.fontSize = '10px'; usageEl.style.color = '#569cd6'; usageEl.style.flexShrink = '0';
	usageEl.textContent = `◉ 使用 ${skill.usageCount} 次`;
	const timeEl = append(headerEl, $('span'));
	timeEl.style.fontSize = '10px'; timeEl.style.color = 'var(--vscode-descriptionForeground)'; timeEl.style.flexShrink = '0';
	timeEl.textContent = new Date(skill.createdAt).toISOString().slice(0, 10);
	const expand = append(headerEl, $('span'));
	expand.textContent = '▶'; expand.style.fontSize = '10px'; expand.style.color = 'var(--vscode-descriptionForeground)';

	// Expand/collapse
	headerEl.addEventListener('click', () => card.classList.toggle('expanded'));

	// Content (SKILL.md preview)
	const contentBox = append(card, $('.md-content-box'));
	card.classList.add('expanded');
	const content = append(contentBox, $('.md-content'));

	// Frontmatter
	const fmEl = append(content, $('div'));
	fmEl.style.background = 'rgba(128,128,128,0.06)';
	fmEl.style.padding = '8px 12px';
	fmEl.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
	fmEl.style.fontSize = '11px';
	fmEl.style.color = 'var(--vscode-descriptionForeground)';
	fmEl.style.lineHeight = '1.6';
	fmEl.style.borderBottom = '1px solid rgba(128,128,128,0.06)';
	// Frontmatter (CSP-safe: build with DOM nodes, no innerHTML)
	const fmLine = (label: string, value: string): HTMLElement => {
		const line = $('div');
		const l = append(line, $('span'));
		l.style.color = '#569cd6';
		l.textContent = label;
		const v = append(line, $('span'));
		v.style.color = '#ce9178';
		v.textContent = value;
		return line;
	};
	fmEl.appendChild(fmLine('name', skill.slug || '—'));
	const fmLine2 = append(fmEl, $('div'));
	const l2 = append(fmLine2, $('span')); l2.style.color = '#569cd6'; l2.textContent = 'description';
	const v2 = append(fmLine2, $('span')); v2.style.color = '#ce9178'; v2.textContent = `${skill.trigger}。${skill.expectedOutcome}`;
	fmEl.appendChild(fmLine('version', '1.0.0'));

	// Body
	const body = append(content, $('div'));
	body.style.padding = '8px 12px';
	const h1 = append(body, $('h1'));
	h1.textContent = skill.title;
	h1.style.fontSize = '15px'; h1.style.fontWeight = '600'; h1.style.margin = '0 0 8px';

	const triggerSection = append(body, $('div'));
	triggerSection.style.fontSize = '11px'; triggerSection.style.fontWeight = '600';
	triggerSection.style.color = 'var(--vscode-descriptionForeground)';
	triggerSection.style.marginBottom = '4px'; triggerSection.textContent = '触发条件';
	const triggerText = append(body, $('div'));
	triggerText.textContent = skill.trigger;
	triggerText.style.fontSize = '12px'; triggerText.style.color = '#4ec9b0';
	triggerText.style.padding = '6px 10px'; triggerText.style.background = 'rgba(78,201,176,0.08)';
	triggerText.style.borderRadius = '4px'; triggerText.style.borderLeft = '3px solid #4ec9b0';
	triggerText.style.marginBottom = '8px';

	const stepsLabel = append(body, $('div'));
	stepsLabel.style.fontSize = '11px'; stepsLabel.style.fontWeight = '600';
	stepsLabel.style.color = 'var(--vscode-descriptionForeground)';
	stepsLabel.style.marginBottom = '4px'; stepsLabel.textContent = '执行步骤';
	const ol = append(body, $('ol'));
	ol.style.paddingLeft = '20px';
	for (let i = 0; i < skill.steps.length; i++) {
		const li = append(ol, $('li'));
		li.textContent = skill.steps[i];
		li.style.fontSize = '12px'; li.style.lineHeight = '1.6'; li.style.margin = '2px 0';
	}

	const outcomeLabel = append(body, $('div'));
	outcomeLabel.style.fontSize = '11px'; outcomeLabel.style.fontWeight = '600';
	outcomeLabel.style.color = 'var(--vscode-descriptionForeground)';
	outcomeLabel.style.marginTop = '8px'; outcomeLabel.style.marginBottom = '4px';
	outcomeLabel.textContent = '预期结果';
	const outcomeText = append(body, $('div'));
	outcomeText.textContent = skill.expectedOutcome;
	outcomeText.style.fontSize = '12px'; outcomeText.style.color = 'var(--vscode-foreground)';
	outcomeText.style.padding = '6px 10px'; outcomeText.style.background = 'rgba(86,156,214,0.08)';
	outcomeText.style.borderRadius = '4px'; outcomeText.style.borderLeft = '3px solid #569cd6';

	// Meta + actions
	const meta = append(card, $('.md-meta'));
	if (skill.tags?.length) {
		for (const tag of skill.tags) {
			const chip = append(meta, $('.md-meta-chip'));
			chip.textContent = `#${tag}`;
			chip.className = 'md-meta-chip tag';
		}
	}
	const sessionChip = append(meta, $('.md-meta-chip'));
	sessionChip.textContent = `来源: ${skill.sourceSessionId?.slice(0, 20) ?? '—'}`;
	sessionChip.className = 'md-meta-chip session';
	if (skill.slug) {
		const pathChip = append(meta, $('.md-meta-chip'));
		pathChip.textContent = `~/.vssaros/skills/${skill.slug}/SKILL.md`;
		pathChip.className = 'md-meta-chip';
		pathChip.style.background = 'rgba(240,160,75,0.1)';
		pathChip.style.color = '#f0a04b';
		pathChip.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
	}

	// Action buttons
	const actions = append(meta, $('div'));
	actions.style.marginLeft = 'auto'; actions.style.display = 'flex'; actions.style.gap = '4px';
		this._addToolbarBtn(actions, '📁 写入 SKILL.md', '', async () => {
			if (!memProvider?.writeSkillFile) return;
			const result = await memProvider.writeSkillFile(this._agentId, skill.id);
			alert(result.ok ? `SKILL.md 已写入: ${result.path}` : `写入失败: ${result.error}`);
			this._renderFull();
		});
		this._addToolbarBtn(actions, '✏ 编辑', '', () => this._editSkill(memProvider, skill));
		this._addToolbarBtn(actions, '🗑 删除', 'danger', async () => {
			if (!confirm(`确定删除技能 "${skill.title}"？`)) return;
			if (skill.skillMdWritten && memProvider?.deleteSkillFile) {
				await memProvider.deleteSkillFile(this._agentId, skill.id);
			}
			memProvider?.deleteSkill?.(this._agentId, skill.id);
			this._renderFull();
		});
}

private async _addSkill(memProvider: any): Promise<void> {
	const title = prompt('技能标题:');
	if (!title) return;
	const trigger = prompt('触发条件:') || '';
	const stepsStr = prompt('执行步骤 (每行一步):') || '';
	const steps = stepsStr.split('\n').filter(Boolean);
	const outcome = prompt('预期结果 (可选):') || 'Task completed successfully';
	const tagsStr = prompt('标签 (逗号分隔, 可选):') || '';
	const tags = tagsStr ? tagsStr.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
	try {
		if (!memProvider?.addSkill) { alert('当前记忆提供者不支持手动新增技能'); return; }
		const skill = await memProvider.addSkill(this._agentId, {
			title, trigger, steps, expectedOutcome: outcome, tags,
		});
		if (!skill) { alert('技能新增失败'); return; }
		this._renderFull();
	} catch (err) { alert(`新增失败: ${err instanceof Error ? err.message : String(err)}`); }
}

private async _editSkill(memProvider: any, skill: any): Promise<void> {
	const title = prompt('技能标题:', skill.title);
	if (!title) return;
	const trigger = prompt('触发条件:', skill.trigger);
	const stepsStr = prompt('执行步骤 (每行一步):', skill.steps.join('\n'));
	const steps = stepsStr?.split('\n').filter(Boolean) ?? [];
	const outcome = prompt('预期结果:', skill.expectedOutcome);
	const tagsStr = prompt('标签 (逗号分隔):', skill.tags.join(','));
	const tags = tagsStr ? tagsStr.split(',').map((t: string) => t.trim()).filter(Boolean) : [];
	try {
		await memProvider?.updateSkill?.(this._agentId, skill.id, { title, trigger, steps, expectedOutcome: outcome, tags });
		this._renderFull();
	} catch (err) { alert(`编辑失败: ${err instanceof Error ? err.message : String(err)}`); }
}

/** Memory V2 可编辑：编辑长期记忆条目（标题/内容/概念），保存后重新加载记忆列表 */
private async _editMemory(memProvider: any, item: IMemoryEntry): Promise<void> {
	if (!memProvider?.updateMemory) { alert('当前记忆提供者不支持编辑'); return; }
	const currentTitle = (item.metadata?.['title'] as string) ?? '';
	const title = prompt('标题 (可选):', currentTitle);
	if (title === null) { return; }
	const content = prompt('内容:', item.content);
	if (content === null || !content.trim()) { return; }
	const currentConcepts = (item.metadata?.['concepts'] as string[] | undefined) ?? [];
	const conceptsStr = prompt('概念 (逗号分隔, 可选):', currentConcepts.join(','));
	if (conceptsStr === null) { return; }
	const concepts = conceptsStr ? conceptsStr.split(',').map((c: string) => c.trim()).filter(Boolean) : [];
	try {
		const updated = await memProvider.updateMemory(this._agentId, item.id, { title, content, concepts });
		if (!updated) { alert('编辑失败：记忆不存在'); return; }
		await this._loadMemory();
	} catch (err) { alert(`编辑失败: ${err instanceof Error ? err.message : String(err)}`); }
}

private async _exportSkillsJson(memProvider: any): Promise<void> {
	if (!memProvider?.listSkills) return;
	const skills = await memProvider.listSkills(this._agentId);
	const json = JSON.stringify(skills, null, 2);
	const blob = new Blob([json], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url; a.download = `skills_${this._agentId}_${Date.now()}.json`;
	a.click();
	URL.revokeObjectURL(url);
}

	private _addStat(parent: HTMLElement, label: string, value: string | number, cls: string): HTMLElement {
		const card = append(parent, $(`.md-stat.${cls}`));
		append(card, $('.label')).textContent = label;
		append(card, $('.value')).textContent = String(value);
		return card;
	}

	private _addLayerTab(parent: HTMLElement, layer: LayerFilter, label: string): void {
		const tab = append(parent, $('.md-layer-tab'));
		if (this._layerFilter === layer) { tab.classList.add('active'); }
		const count = this._countByTier(layer);
		const text = document.createElement('span'); text.textContent = label; tab.appendChild(text);
		const countEl = document.createElement('span'); countEl.className = 'count'; countEl.textContent = String(count); tab.appendChild(countEl);
		tab.addEventListener('click', () => { this._layerFilter = layer; this._renderFull(); });
	}

	private _countByTier(tier: LayerFilter): number {
		if (tier === 'all') { return this._allMemories.length; }
		return this._allMemories.filter(m => matchesTier(m, tier)).length;
	}

	private _getFiltered(): IMemoryEntry[] {
		let items = this._allMemories;
		if (this._layerFilter !== 'all') { items = items.filter(m => matchesTier(m, this._layerFilter)); }
		if (this._searchQuery) { items = items.filter(m => m.content.toLowerCase().includes(this._searchQuery)); }
		items = items.slice().sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
		return items;
	}

	private _renderList(): void {
		const oldList = this._container?.querySelector('.md-list');
		if (oldList) { oldList.remove(); }
		const oldMore = this._container?.querySelector('.md-load-more');
		if (oldMore) { oldMore.remove(); }
		if (!this._container) { return; }
		const list = append(this._container, $('.md-list'));
		const items = this._getFiltered();
		if (items.length === 0) {
			const emptyMsg = this._allMemories.length === 0
				? '暂无记忆数据（记忆服务可能未运行，请检查端口 3111）'
				: '暂无符合条件的记忆';
			append(list, $('.md-empty')).textContent = emptyMsg;
			return;
		}

		// 分页渲染：16K 条目一次性全部创建 DOM 会导致严重卡顿。
		// 首屏仅渲染 PAGE_SIZE（默认 200）条，其余通过"加载更多"按钮逐步展开。
		const PAGE_SIZE = 200;
		const displayItems = items.slice(0, PAGE_SIZE);
		this._renderMemoryCards(list, displayItems, items);

		if (items.length > PAGE_SIZE) {
			const moreDiv = append(this._container, $('.md-load-more'));
			moreDiv.style.textAlign = 'center';
			moreDiv.style.padding = '12px';
			const loadBtn = document.createElement('button');
			loadBtn.textContent = `加载更多（已显示 ${PAGE_SIZE} / ${items.length}）`;
			loadBtn.style.padding = '6px 20px';
			loadBtn.style.cursor = 'pointer';
			loadBtn.style.background = 'var(--vscode-button-background)';
			loadBtn.style.color = 'var(--vscode-button-foreground)';
			loadBtn.style.border = 'none';
			loadBtn.style.borderRadius = '4px';
			loadBtn.style.fontSize = '12px';
			let offset = PAGE_SIZE;
			const listEl = list;
			loadBtn.addEventListener('click', () => {
				const nextBatch = items.slice(offset, offset + PAGE_SIZE);
				this._renderMemoryCards(listEl, nextBatch, items, offset);
				offset += PAGE_SIZE;
				loadBtn.textContent = offset >= items.length
					? `全部已加载（${items.length} 条）`
					: `加载更多（已显示 ${offset} / ${items.length}）`;
				if (offset >= items.length) {
					loadBtn.disabled = true;
					loadBtn.style.opacity = '0.5';
				}
			});
			moreDiv.appendChild(loadBtn);
		}
	}

	/**
	 * 渲染一批记忆卡片到指定 DOM 容器。
	 */
	private _renderMemoryCards(list: HTMLElement, batch: IMemoryEntry[], allItems: IMemoryEntry[], indexOffset: number = 0): void {
		const typeLabels: Record<string, string> = {
			working: 'Working', episodic: 'Episodic', semantic: 'Semantic', procedural: 'Procedural',
			pattern: 'Pattern', preference: 'Preference', architecture: 'Architecture',
			bug: 'Bug', workflow: 'Workflow', fact: 'Fact', instruction: 'Instruction',
		};
		const typeClasses: Record<string, string> = {
			working: 'l0', episodic: 'l1', semantic: 'l2', procedural: 'l3',
			pattern: 'l1', preference: 'l1', architecture: 'l2', bug: 'l1', workflow: 'l3', fact: 'l1',
		};

		// targetContentPreview 查找（仅首屏执行一次）
		let targetItem: IMemoryEntry | null = null;
		if (indexOffset === 0 && this._targetContentPreview) {
			const preview = this._targetContentPreview.trim();
			for (const item of allItems) {
				if (typeof item.content === 'string' && item.content.startsWith(preview)) { targetItem = item; break; }
			}
			if (!targetItem) {
				const normalize = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
				const normPreview = normalize(preview);
				for (const item of allItems) {
					if (typeof item.content === 'string' && normalize(item.content).startsWith(normPreview)) { targetItem = item; break; }
				}
			}
			if (!targetItem && preview.length >= 20) {
				for (const item of allItems) {
					if (typeof item.content === 'string' && item.content.includes(preview.slice(0, 30))) { targetItem = item; break; }
				}
			}
		}

		let targetIndex = -1;
		// Memory V2 可编辑：提供者支持编辑/删除时在卡片头部显示操作按钮
		const memProvider = this._agentOSService.getActiveMemoryProvider();
		const canEdit = !!memProvider?.updateMemory;
		const canDelete = !!memProvider?.deleteMemory;
		for (let i = 0; i < batch.length; i++) {
			const item = batch[i];
			const globalIndex = indexOffset + i;
			const card = document.createElement('div');
			card.className = 'md-card';
			card.setAttribute('data-mem-index', String(globalIndex));

			const isTarget = targetItem && item.id === targetItem.id;
			if (isTarget) { targetIndex = globalIndex; }
			if (isTarget || (!targetItem && globalIndex === 0)) { card.classList.add('expanded'); }
			if (isTarget) { card.classList.add('target'); }

			// Header
			const header = document.createElement('div');
			header.className = 'md-card-header';
			const badge = document.createElement('span');
			badge.className = `md-badge ${typeClasses[item.type] || 'l0'}`;
			badge.textContent = typeLabels[item.type] ?? item.type;
			header.appendChild(badge);
			if (this._agentFilter === '__all__' && item.metadata?.['agentId']) {
				const agentBadge = document.createElement('span');
				agentBadge.className = 'md-badge';
				agentBadge.style.background = 'rgba(128,128,128,0.1)';
				agentBadge.style.color = 'var(--vscode-descriptionForeground)';
				agentBadge.textContent = String(item.metadata['agentId']);
				header.appendChild(agentBadge);
			}
			const title = document.createElement('span');
			title.className = 'md-card-title';
			title.textContent = item.content.slice(0, 80).replace(/\n/g, ' ');
			header.appendChild(title);
			if (item.timestamp) {
				const time = document.createElement('span');
				time.className = 'md-card-time';
				time.textContent = new Date(item.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
				header.appendChild(time);
			}
			const strength = item.metadata?.['strength'] as number | undefined;
			if (typeof strength === 'number') {
				const strengthEl = document.createElement('span');
				strengthEl.className = 'md-card-strength';
				const pct = Math.round(strength * 100);
				strengthEl.classList.add(strength > 0.5 ? 'high' : strength > 0.2 ? 'mid' : 'low');
				strengthEl.textContent = `${pct}%`;
				strengthEl.title = `强度: ${strength.toFixed(2)}\n访问: ${item.metadata?.['accessCount'] ?? 0} 次`;
				header.appendChild(strengthEl);
			}
			if (item.metadata?.['supersededBy']) {
				const supBadge = document.createElement('span');
				supBadge.className = 'md-badge superseded';
				supBadge.textContent = '已取代';
				header.appendChild(supBadge);
			}
			// 编辑/删除按钮（Memory V2 可编辑；stopPropagation 避免触发卡片展开）
			if (canEdit || canDelete) {
				const mkAction = (label: string, tip: string, onClick: () => void): HTMLSpanElement => {
					const btn = document.createElement('span');
					btn.className = 'md-card-action';
					btn.textContent = label;
					btn.title = tip;
					btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
					return btn;
				};
				if (canEdit) {
					header.appendChild(mkAction('✏', '编辑记忆', () => { void this._editMemory(memProvider, item); }));
				}
				if (canDelete) {
					header.appendChild(mkAction('🗑', '删除记忆', () => {
						if (!confirm(`确定删除该记忆？\n\n${item.content.slice(0, 80)}`)) { return; }
						void (async () => {
							await memProvider.deleteMemory?.(this._agentId, item.id);
							await this._loadMemory();
						})();
					}));
				}
			}
			const expand = document.createElement('span');
			expand.className = 'md-expand'; expand.textContent = '▶';
			header.appendChild(expand);
			header.addEventListener('click', () => card.classList.toggle('expanded'));
			card.appendChild(header);

			// Content box
			const contentBox = document.createElement('div');
			contentBox.className = 'md-content-box';
			const content = document.createElement('div');
			content.className = 'md-content';
			this._renderMarkdown(content, item.content);
			contentBox.appendChild(content);
			if (item.metadata) {
				const meta = document.createElement('div');
				meta.className = 'md-meta';
				for (const [k, v] of Object.entries(item.metadata).filter(([k]) => !['owner', 'userId', 'agentId'].includes(k))) {
					const chip = document.createElement('span');
					chip.className = this._getMetaChipClass(k);
					chip.textContent = `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`;
					meta.appendChild(chip);
				}
				if (meta.children.length > 0) { contentBox.appendChild(meta); }
			}
			card.appendChild(contentBox);
			list.appendChild(card);
		}

		// Scroll to target（仅首屏）
		if (indexOffset === 0 && targetIndex >= 0) {
			setTimeout(() => {
				const targetEl = list.querySelector(`[data-mem-index="${targetIndex}"]`);
				if (targetEl) { (targetEl as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' }); }
				this._targetContentPreview = null;
			}, 100);
		}
	}

	private _getMetaChipClass(key: string): string {
		if (key === 'priority') { return 'md-meta-chip priority'; }
		if (key === 'sceneName' || key === 'scene_name') { return 'md-meta-chip scene'; }
		if (key === 'role') { return 'md-meta-chip role'; }
		if (key === 'sessionId' || key === 'sessionKey') { return 'md-meta-chip session'; }
		if (key === 'source') { return 'md-meta-chip scene'; }
		if (key === 'strength' || key === 'accessCount') { return 'md-meta-chip priority'; }
		return 'md-meta-chip';
	}

	/** Simple markdown → DOM renderer (CSP-safe, no innerHTML) */
	private _renderMarkdown(container: HTMLElement, text: string): void {
		const lines = text.split('\n');
		let inCodeBlock = false;
		let codeLines: string[] = [];
		let listType: 'ul' | 'ol' | null = null;
		let listEl: HTMLElement | null = null;

		const flushList = () => { if (listEl && listType) { listType = null; listEl = null; } };

		for (const line of lines) {
			// Code block
			if (line.trim().startsWith('```')) {
				if (inCodeBlock) {
					const pre = document.createElement('pre');
					const code = document.createElement('code');
					code.textContent = codeLines.join('\n');
					pre.appendChild(code);
					container.appendChild(pre);
					inCodeBlock = false; codeLines = [];
				} else {
					flushList();
					inCodeBlock = true; codeLines = [];
				}
				continue;
			}
			if (inCodeBlock) { codeLines.push(line); continue; }

			// Headers
			if (/^###\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h3', line.slice(4))); continue; }
			if (/^##\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h2', line.slice(3))); continue; }
			if (/^#\s/.test(line)) { flushList(); container.appendChild(this._mkEl('h1', line.slice(2))); continue; }

			// Blockquote
			if (/^>\s/.test(line)) { flushList(); container.appendChild(this._mkEl('blockquote', line.slice(2))); continue; }

			// Lists
			if (/^\d+\.\s/.test(line)) {
				if (listType !== 'ol') { flushList(); listType = 'ol'; listEl = document.createElement('ol'); container.appendChild(listEl); }
				const li = this._mkEl('li', line.replace(/^\d+\.\s/, ''));
				listEl!.appendChild(li);
				continue;
			}
			if (/^[-*]\s/.test(line)) {
				if (listType !== 'ul') { flushList(); listType = 'ul'; listEl = document.createElement('ul'); container.appendChild(listEl); }
				const li = this._mkEl('li', line.replace(/^[-*]\s/, ''));
				listEl!.appendChild(li);
				continue;
			}

			// Empty line
			if (line.trim() === '') { flushList(); continue; }

			// Paragraph
			flushList();
			container.appendChild(this._mkEl('p', line));
		}

		// Flush remaining code block
		if (inCodeBlock && codeLines.length > 0) {
			const pre = document.createElement('pre');
			const code = document.createElement('code');
			code.textContent = codeLines.join('\n');
			pre.appendChild(code);
			container.appendChild(pre);
		}
	}

	/** Create element with inline markdown (bold/italic/code) rendered as child nodes */
	private _mkEl(tag: string, text: string): HTMLElement {
		const el = document.createElement(tag);
		// Parse inline: **bold**, *italic*, `code`
		const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
		let lastIdx = 0;
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			if (match.index > lastIdx) {
				el.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
			}
			if (match[2]) { // bold
				const strong = document.createElement('strong'); strong.textContent = match[2];
				el.appendChild(strong);
			} else if (match[3]) { // italic
				const em = document.createElement('em'); em.textContent = match[3];
				el.appendChild(em);
			} else if (match[4]) { // code
				const code = document.createElement('code'); code.textContent = match[4];
				el.appendChild(code);
			}
			lastIdx = match.index + match[0].length;
		}
		if (lastIdx < text.length) {
			el.appendChild(document.createTextNode(text.slice(lastIdx)));
		}
		return el;
	}

	/**
	 * 公共刷新方法：外部触发当前视图重新加载数据并渲染。
	 * 用于技能沉淀、记忆写入等操作完成后，自动刷新面板。
	 */
	async refreshCurrentView(): Promise<void> {
		if (this._loadMemoryPromise) {
			await this._loadMemoryPromise;
		}
		await this._loadMemory();
	}

	/**
	 * 公共导航方法：应用层级过滤并滚动到匹配 contentPreview 的条目。
	 * 用于系统栏点击记忆条目时跳转（即使编辑器已打开也能调用）。
	 */
	async navigateToTarget(layer?: string, targetContentPreview?: string): Promise<void> {
		if (layer) {
			this._layerFilter = layer as LayerFilter;
		}
		this._targetContentPreview = targetContentPreview ?? null;
		// 如果有 pending 的 _loadMemory，等待它完成（避免竞态：setInput 还在加载时 navigateToTarget 提前判断空列表）
		if (this._loadMemoryPromise) {
			await this._loadMemoryPromise;
		}
		if (this._allMemories.length > 0) {
			this._renderFull();
		} else {
			// 无缓存也无 pending，触发加载（完成后 _renderFull 会自动调用）
			await this._loadMemory();
		}
	}

	override layout(dimension: { width: number; height: number }): void {
		// No special layout needed
	}

	// ─── Action toolbar helpers ──────────────────────────────────────────────

	private _addToolbarBtn(parent: HTMLElement, label: string, cls: string, onClick: () => void | Promise<void>): void {
		const btn = append(parent, $(`.md-btn.${cls}`));
		btn.textContent = label;
		btn.addEventListener('click', () => { void onClick(); });
	}

	private _showDiagnostics(memProvider: { runExtendedDiagnostics?: (agentId: string) => Record<string, unknown>; getExtendedStats?: (agentId: string) => Record<string, unknown> }): void {
		if (!this._container) return;
		// Overlay
		const overlay = document.createElement('div');
		overlay.className = 'md-overlay';
		overlay.addEventListener('click', () => { overlay.remove(); panel.remove(); });
		this._container.appendChild(overlay);
		// Panel
		const panel = document.createElement('div');
		panel.className = 'md-diag-panel';
		const title = document.createElement('h2');
		title.textContent = '📊 记忆系统诊断';
		panel.appendChild(title);

		// Extended stats
		if (memProvider.getExtendedStats) {
			try {
				const stats = memProvider.getExtendedStats(this._agentId);
				const section = document.createElement('div');
				section.className = 'md-diag-section';
				const h3 = document.createElement('h3'); h3.textContent = '扩展统计'; section.appendChild(h3);
				for (const [key, value] of Object.entries(stats)) {
					const item = document.createElement('div');
					item.className = 'md-diag-item';
					const k = document.createElement('span'); k.className = 'key'; k.textContent = key;
					const v = document.createElement('span'); v.className = 'val'; v.textContent = String(value);
					item.appendChild(k); item.appendChild(v); section.appendChild(item);
				}
				panel.appendChild(section);
			} catch { /* best effort */ }
		}

		// Diagnostics
		if (memProvider.runExtendedDiagnostics) {
			try {
				const diag = memProvider.runExtendedDiagnostics(this._agentId);
				const section = document.createElement('div');
				section.className = 'md-diag-section';
				const h3 = document.createElement('h3'); h3.textContent = '健康检查'; section.appendChild(h3);
				for (const [key, value] of Object.entries(diag)) {
					const item = document.createElement('div');
					item.className = 'md-diag-item';
					const k = document.createElement('span'); k.className = 'key'; k.textContent = key;
					const v = document.createElement('span');
					const strVal = String(value);
					v.className = 'val ' + (strVal.includes('pass') ? 'pass' : strVal.includes('warn') ? 'warn' : strVal.includes('fail') ? 'fail' : '');
					v.textContent = strVal;
					item.appendChild(k); item.appendChild(v); section.appendChild(item);
				}
				panel.appendChild(section);
			} catch { /* best effort */ }
		}

		// Close button
		const closeBtn = document.createElement('button');
		closeBtn.className = 'md-btn primary';
		closeBtn.textContent = '关闭';
		closeBtn.addEventListener('click', () => { overlay.remove(); panel.remove(); });
		panel.appendChild(closeBtn);

		this._container.appendChild(panel);
	}

	private _exportMemory(format: 'json' | 'markdown'): void {
		const memories = this._allMemories;
		if (memories.length === 0) return;

		let content: string;
		let filename: string;

		if (format === 'json') {
			content = JSON.stringify({
				exportedAt: new Date().toISOString(),
				agentId: this._agentId,
				totalEntries: memories.length,
				entries: memories,
			}, null, 2);
			filename = `memory-export-${this._agentId}-${Date.now()}.json`;
		} else {
			const lines: string[] = [`# Memory Export: ${this._agentId}`, '', `> Exported at: ${new Date().toISOString()}`, `> Total: ${memories.length} entries`, ''];
			for (const mem of memories) {
				lines.push(`## [${mem.type}] ${new Date(mem.timestamp ?? Date.now()).toISOString()}`);
				lines.push('');
				lines.push(mem.content);
				lines.push('');
				lines.push('---');
				lines.push('');
			}
			content = lines.join('\n');
			filename = `memory-export-${this._agentId}-${Date.now()}.md`;
		}

		// Create download via blob
		const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url; a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	private _showSearchHistory(memProvider: { getExtendedStats?: (agentId: string) => Record<string, unknown> }): void {
		if (!this._container) return;
		if (!memProvider.getExtendedStats) return;

		const overlay = document.createElement('div');
		overlay.className = 'md-overlay';
		overlay.addEventListener('click', () => { overlay.remove(); panel.remove(); });
		this._container.appendChild(overlay);

		const panel = document.createElement('div');
		panel.className = 'md-diag-panel';
		const title = document.createElement('h2');
		title.textContent = '🔍 搜索历史 & 统计';
		panel.appendChild(title);

		try {
			const stats = memProvider.getExtendedStats(this._agentId);
			const section = document.createElement('div');
			section.className = 'md-diag-section';
			for (const [key, value] of Object.entries(stats)) {
				const item = document.createElement('div');
				item.className = 'md-diag-item';
				const k = document.createElement('span'); k.className = 'key'; k.textContent = key;
				const v = document.createElement('span'); v.className = 'val'; v.textContent = String(value);
				item.appendChild(k); item.appendChild(v); section.appendChild(item);
			}
			panel.appendChild(section);
		} catch { /* best effort */ }

		const closeBtn = document.createElement('button');
		closeBtn.className = 'md-btn primary';
		closeBtn.textContent = '关闭';
		closeBtn.addEventListener('click', () => { overlay.remove(); panel.remove(); });
		panel.appendChild(closeBtn);

		this._container.appendChild(panel);
	}

	/**
	 * 外部调用入口：触发代码库索引（若尚未索引），并打开独立的代码图谱 3D 可视化面板。
	 * 「代码图谱」页签已从 Memory 中移除，故不再内嵌渲染，而是直接打开独立面板。
	 * 供 `agentStudio.codebaseMemoryInit` 命令使用。
	 */
	async activateCodebaseViewAndIndex(): Promise<void> {
		// 自动触发索引（如果未在索引中且无图谱数据）
		if (!this._codebaseGraphService.isIndexing && !this._codebaseGraphService.hasGraphData()) {
			try {
				await this._cbmService.indexRepository();
			} catch (err: any) {
				this._notificationService.error(`自动索引失败: ${err?.message || err}`);
			}
		}
		// 打开独立的代码图谱 3D 可视化面板
		const input = CodebaseGraphViewerEditorInput.getOrCreate();
		await this._editorService.openEditor(input, { pinned: true });
	}
}
