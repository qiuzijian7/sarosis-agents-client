/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { clearNode } from '../../../../base/browser/dom.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../../workbench/services/path/common/pathService.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer, decodeBase64 } from '../../../../base/common/buffer.js';
import { MarketplaceEditorInput } from './marketplaceEditorInput.js';
import { IMarketplaceService, PackageKind, IMarketplacePackage, IMarketplacePackageDetail } from '../common/marketplace.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { IPlaywrightService } from '../../../../platform/browserView/common/playwrightService.js';
import { ICodebaseMemoryMcpService } from './codebaseMemoryMcpService.js';
import { IBrowserViewWorkbenchService } from '../../../../workbench/contrib/browserView/common/browserView.js';
import { BrowserEditorInput } from '../../../../workbench/contrib/browserView/common/browserEditorInput.js';

const KIND_LABEL: Record<PackageKind, string> = {
	skill: 'Skill',
	agent: 'Agent',
	mcp: 'MCP',
	knowledge: '知识库',
	workflow: '工作流',
};

const KIND_ICON: Record<PackageKind, string> = {
	skill: '\u{1F4C4}',
	agent: '\u{1F916}',
	mcp: '\u{1F50C}',
	knowledge: '\u{1F4DA}',
	workflow: '\u{1F527}',
};

/** Inline CSS — matches mockup integration-marketplace-mockup.html */
const CSS_TEXT = `
.mp-page{height:100%;display:flex;flex-direction:column;background:var(--vscode-editor-background,#1e1e1e);color:var(--vscode-editor-foreground,#ccc);font-size:13px;font-family:'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;}
.mp-header{padding:14px 24px 12px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-sideBar-background,#252526);flex-shrink:0;}
.mp-title-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}
.mp-title-row h1{font-size:17px;font-weight:600;margin:0;display:flex;align-items:center;gap:8px;}
.mp-user{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.mp-user .avatar{width:24px;height:24px;border-radius:50%;background:var(--vscode-button-background,#007acc);display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;}
.mp-toolbar{display:flex;gap:8px;align-items:center;}
.mp-search{flex:1;display:flex;align-items:center;gap:8px;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:5px 10px;}
.mp-search:focus-within{border-color:var(--vscode-focusBorder,#007acc);}
.mp-search input{flex:1;background:none;border:none;outline:none;color:var(--vscode-input-foreground,#ccc);font-size:13px;}
.mp-search input::placeholder{color:var(--vscode-input-placeholderForeground,#6e6e6e);}
.mp-cats{display:flex;gap:4px;flex-wrap:wrap;}
.mp-cat{padding:4px 12px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:14px;font-size:12px;cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);background:var(--vscode-editor-background,#1e1e1e);transition:.15s;}
.mp-cat:hover{border-color:var(--vscode-button-background,#007acc);color:var(--vscode-editor-foreground,#ccc);}
.mp-cat.active{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-grid-scroll{flex:1;overflow-y:auto;}
.mp-grid-scroll::-webkit-scrollbar{width:8px;}
.mp-grid-scroll::-webkit-scrollbar-track{background:var(--vscode-editor-background,#1e1e1e);}
.mp-grid-scroll::-webkit-scrollbar-thumb{background:var(--vscode-panel-border,#3c3c3c);border-radius:4px;}
.mp-grid{padding:16px 24px;}
.mp-section-title{font-size:13px;font-weight:600;color:var(--vscode-editor-foreground,#ccc);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
.mp-section-title .count{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);font-weight:400;}
.mp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;}
.mp-card{background:var(--vscode-sideBar-background,#252526);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:6px;padding:14px;transition:.15s;cursor:pointer;}
.mp-card:hover{border-color:var(--vscode-button-background,#007acc);background:var(--vscode-list-hoverBackground,#2a2d2e);transform:translateY(-1px);}
.card-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:6px;}
.card-icon{font-size:24px;flex-shrink:0;}
.card-info{flex:1;min-width:0;}
.card-name{font-size:13px;font-weight:600;color:var(--vscode-editor-foreground,#ccc);margin-bottom:2px;}
.card-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}
.card-ver{font-size:10px;color:var(--vscode-textLink-foreground,#569cd6);font-family:monospace;}
.card-author{font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.card-desc{font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);line-height:1.5;margin-bottom:10px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}
.card-footer{display:flex;align-items:center;justify-content:space-between;}
.card-stats{font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);display:flex;gap:8px;}
.card-badge{font-size:9px;padding:2px 7px;border-radius:3px;font-weight:600;}
.badge-skill{background:rgba(86,156,214,.2);color:var(--vscode-textLink-foreground,#569cd6);}
.badge-agent{background:rgba(78,201,176,.15);color:#4ec9b0;}
.badge-mcp{background:rgba(206,145,120,.15);color:#ce9178;}
.badge-kb{background:rgba(197,134,192,.15);color:#c586c0;}
.badge-workflow{background:rgba(220,220,170,.15);color:#dcdcaa;}
.install-btn{padding:4px 14px;background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border:none;border-radius:3px;cursor:pointer;font-size:12px;font-weight:500;transition:.15s;}
.install-btn:hover{background:var(--vscode-button-hoverBackground,#1f8ad2);}
.install-btn.installed{background:#4ec9b0;cursor:default;}
.mp-pagination{display:flex;justify-content:center;gap:6px;padding:14px 0;border-top:1px solid var(--vscode-panel-border,#3c3c3c);margin-top:12px;}
.mp-page-btn{padding:4px 12px;border:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-sideBar-background,#252526);color:var(--vscode-descriptionForeground,#9d9d9d);border-radius:3px;cursor:pointer;font-size:12px;}
.mp-page-btn:hover{border-color:var(--vscode-button-background,#007acc);color:var(--vscode-editor-foreground,#ccc);}
.mp-page-btn.active{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-page-btn:disabled{opacity:.4;cursor:default;}
.mp-detail{display:none;position:absolute;inset:0;background:var(--vscode-editor-background,#1e1e1e);z-index:100;flex-direction:column;}
.mp-detail.show{display:flex;}
.md-back{padding:10px 24px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:13px;flex-shrink:0;}
.md-back:hover{color:var(--vscode-editor-foreground,#ccc);}
.md-content{flex:1;overflow-y:auto;padding:20px 24px;}
.md-content h2{font-size:18px;margin-bottom:6px;display:flex;align-items:center;gap:8px;}
.md-meta{display:flex;gap:10px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-bottom:14px;flex-wrap:wrap;align-items:center;}
.md-desc{font-size:13px;color:var(--vscode-descriptionForeground,#9d9d9d);line-height:1.7;margin-bottom:16px;padding:14px;background:var(--vscode-sideBar-background,#252526);border-radius:6px;border:1px solid var(--vscode-panel-border,#3c3c3c);}
.md-versions{margin-bottom:16px;}
.md-versions h3{font-size:13px;margin-bottom:6px;}
.ver-item{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:4px;margin-bottom:5px;}
.ver-item.latest{border-color:#4ec9b0;}
.md-install-bar{padding:14px 0;border-top:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;gap:8px;align-items:center;}
.install-overlay{display:none;position:absolute;inset:0;background:rgba(0,0,0,.5);z-index:200;align-items:center;justify-content:center;}
.install-overlay.show{display:flex;}
.install-dialog{background:var(--vscode-sideBar-background,#252526);border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:8px;width:400px;max-width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4);overflow:hidden;}
.id-head{padding:12px 18px;border-bottom:1px solid var(--vscode-panel-border,#3c3c3c);font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:space-between;}
.id-body{padding:16px 18px;}
.id-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(60,60,60,.3);}
.id-row:last-child{border-bottom:none;}
.id-label{font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-val{font-size:13px;color:var(--vscode-editor-foreground,#ccc);}
.id-progress{margin:14px 0;}
.id-bar{height:5px;background:var(--vscode-editorWidget-background,#2d2d2d);border-radius:3px;overflow:hidden;}
.id-fill{height:100%;background:var(--vscode-button-background,#007acc);border-radius:3px;transition:width .5s;width:0;}
.id-steps{font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:6px;}
.id-step{padding:2px 0;display:flex;align-items:center;gap:5px;}
.id-step.done{color:#4ec9b0;}
.id-step.done::before{content:'\u2713';color:#4ec9b0;}
.id-step.pending::before{content:'\u25CB';color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-step.active::before{content:'\u25CF';color:var(--vscode-button-background,#007acc);}
.id-actions{padding:12px 18px;border-top:1px solid var(--vscode-panel-border,#3c3c3c);display:flex;justify-content:flex-end;gap:8px;}
.id-btn{padding:5px 14px;border-radius:4px;cursor:pointer;font-size:13px;border:1px solid var(--vscode-panel-border,#3c3c3c);background:var(--vscode-editorWidget-background,#2d2d2d);color:var(--vscode-descriptionForeground,#9d9d9d);}
.id-btn:hover{border-color:var(--vscode-button-background,#007acc);}
.id-btn.primary{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,#fff);border-color:var(--vscode-button-background,#007acc);}
.mp-empty{text-align:center;padding:40px;color:var(--vscode-descriptionForeground,#9d9d9d);}
`;

/**
 * EditorPane that renders the VsSaros Marketplace page inside the editor area.
 * Uses native DOM with CSS classes matching the mockup design.
 */

/** Knot 认证错误 — 携带页面 URL 和资源信息供登录流程使用 */
class KnotAuthError extends Error {
	constructor(
		public readonly pageUrl: string,
		public readonly resourceType: string,
		public readonly resourceId: string,
		public readonly originalUrl: string,
	) {
		super('Knot 需要登录认证');
		this.name = 'KnotAuthError';
	}
}

export class MarketplaceEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.marketplace';

	private _container!: HTMLElement;
	private _gridEl!: HTMLElement;
	private _searchInput!: HTMLInputElement;
	private _userEl!: HTMLElement;
	private _resultCountEl!: HTMLElement;
	private _detailEl!: HTMLElement;
	private _detailContentEl!: HTMLElement;
	private _overlayEl!: HTMLElement;

	private _packages: IMarketplacePackage[] = [];
	private _loading = false;
	private _activeCategory: PackageKind | 'all' | 'graph' = 'all';
	private _searchQuery = '';
	private _installingIds: Set<string> = new Set();
	private _crawlPageId: string | null = null;
	private _crawlBrowserInput: BrowserEditorInput | null = null;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@INotificationService private readonly notificationService: INotificationService,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ICodebaseMemoryMcpService private readonly cbmService: ICodebaseMemoryMcpService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IPlaywrightService private readonly playwrightService: IPlaywrightService,
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@ILogService private readonly logService: ILogService,
	) {
		super(MarketplaceEditorPane.ID, group, telemetryService, themeService, storageService);

		// 监听商城登录状态变化 → 更新用户信息 + 重新加载资源列表
		this._register(this.marketplaceService.onDidChangeLogin(() => {
			this._refreshUserDisplay();
			this._loadPackages().catch(() => { /* ignore */ });
		}));

		// 监听 TOF 登录状态变化 → 更新显示（商城会自动同步，但先更新 UI 显示 TOF 状态）
		this._register(this.tofAuthService.onDidChangeUser(() => {
			this._refreshUserDisplay();
		}));
	}

	/** 刷新用户信息显示区域 */
	private _refreshUserDisplay(): void {
		if (!this._userEl) { return; }
		clearNode(this._userEl); // 不用 innerHTML（TrustedHTML CSP 拦截）
		const user = this.marketplaceService.getCurrentUser();
		const tofUser = this.tofAuthService.currentUser;

		if (user) {
			// 商城已登录 → 显示用户名 + 已连接
			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			avatar.textContent = (user.username || '?').charAt(0).toUpperCase();
			this._userEl.appendChild(avatar);
			const nameSpan = document.createElement('span');
			nameSpan.textContent = user.username;
			this._userEl.appendChild(nameSpan);
			const sep = document.createElement('span');
			sep.style.color = 'var(--vscode-descriptionForeground,#9d9d9d)';
			sep.textContent = '|';
			this._userEl.appendChild(sep);
			const status = document.createElement('span');
			status.style.color = '#4ec9b0';
			status.textContent = '\u25CF \u5DF2\u8FDE\u63A5'; // ● 已连接
			this._userEl.appendChild(status);
		} else if (tofUser) {
			// 商城未登录但 TOF 已登录 → 显示 TOF 用户名 + 同步中（可点击重试）
			const avatar = document.createElement('div');
			avatar.className = 'avatar';
			avatar.style.background = 'var(--vscode-descriptionForeground,#9d9d9d)';
			avatar.textContent = (tofUser.login_name || '?').charAt(0).toUpperCase();
			this._userEl.appendChild(avatar);
			const nameSpan = document.createElement('span');
			nameSpan.textContent = tofUser.login_name;
			this._userEl.appendChild(nameSpan);
			const sep = document.createElement('span');
			sep.style.color = 'var(--vscode-descriptionForeground,#9d9d9d)';
			sep.textContent = '|';
			this._userEl.appendChild(sep);
			const syncBtn = document.createElement('span');
			syncBtn.style.cssText = 'color:#dcdcaa;cursor:pointer;text-decoration:underline;';
			syncBtn.textContent = '\u26A1 \u540C\u6B65\u4E2D(\u70B9\u51FB\u91CD\u8BD5)'; // ⚡ 同步中(点击重试)
			syncBtn.onclick = () => {
				this.notificationService.info('\u6B63\u5728\u540C\u6B65\u5546\u57CE\u767B\u5F55\u6001...'); // 正在同步商城登录态...
				this.marketplaceService.loginWithTof().then(() => {
					this._refreshUserDisplay();
				}).catch(err => {
					this.notificationService.error(`\u540C\u6B65\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`); // 同步失败: ...
				});
			};
			this._userEl.appendChild(syncBtn);
		} else {
			// 均未登录 → 显示未登录（可点击登录）
			const loginLink = document.createElement('span');
			loginLink.style.cssText = 'cursor:pointer;text-decoration:underline;';
			loginLink.textContent = '\u26A0 \u672A\u767B\u5F55(\u70B9\u51FB\u767B\u5F55)'; // ⚠ 未登录(点击登录)
			loginLink.onclick = () => this._triggerLogin();
			this._userEl.appendChild(loginLink);
		}
	}

	protected createEditor(parent: HTMLElement): void {
		// Inject CSS once
		const styleEl = document.createElement('style');
		styleEl.textContent = CSS_TEXT;
		document.head.appendChild(styleEl);
		this._register({ dispose: () => styleEl.remove() });

		this._container = document.createElement('div');
		this._container.className = 'mp-page';
		this._container.style.cssText = 'width:100%;height:100%;overflow:hidden;position:relative;';

		// ── Header ──────────────────────────────────────
		const header = document.createElement('div');
		header.className = 'mp-header';

		const titleRow = document.createElement('div');
		titleRow.className = 'mp-title-row';
		const h1 = document.createElement('h1');
		h1.textContent = '\u{1F6D2} VsSaros \u5546\u57CE'; // 🛒 VsSaros 商城
		titleRow.appendChild(h1);

		const userEl = document.createElement('div');
		userEl.className = 'mp-user';
		this._userEl = userEl;
		this._refreshUserDisplay(); // 使用统一方法填充内容
		titleRow.appendChild(userEl);

		// 爬取按钮
		const crawlBtn = document.createElement('button');
		crawlBtn.className = 'install-btn';
		crawlBtn.style.cssText = 'font-size:12px;padding:4px 12px;';
		crawlBtn.textContent = '\u{1F310} \u722C\u53D6'; // 🌐 爬取
		crawlBtn.onclick = () => this._showCrawlOverlay();
		titleRow.appendChild(crawlBtn);

		header.appendChild(titleRow);

		// Toolbar: search + categories
		const toolbar = document.createElement('div');
		toolbar.className = 'mp-toolbar';
		const searchBox = document.createElement('div');
		searchBox.className = 'mp-search';
		const searchIcon = document.createElement('span');
		searchIcon.textContent = '\u{1F50D}';
		searchBox.appendChild(searchIcon);
		this._searchInput = document.createElement('input');
		this._searchInput.placeholder = '\u641C\u7D22\u8D44\u6E90\u540D\u79F0\u3001\u63CF\u8FF0\u3001\u6807\u7B7E...'; // 搜索资源名称、描述、标签...
		this._searchInput.oninput = () => {
			this._searchQuery = this._searchInput.value.trim().toLowerCase();
			this._renderGrid();
		};
		searchBox.appendChild(this._searchInput);
		toolbar.appendChild(searchBox);

		const cats = document.createElement('div');
		cats.className = 'mp-cats';
		const catOptions: { id: PackageKind | 'all' | 'graph'; label: string }[] = [
			{ id: 'all', label: '\u5168\u90E8' }, // 全部
			{ id: 'skill', label: '\u{1F4C4} \u6280\u80FD' }, // 📄 技能
			{ id: 'agent', label: '\u{1F916} Agent' },
			{ id: 'mcp', label: '\u{1F50C} MCP' },
			{ id: 'knowledge', label: '\u{1F4DA} \u77E5\u8BC6\u5E93' }, // 📚 知识库
			{ id: 'workflow', label: '\u{1F527} \u5DE5\u4F5C\u6D41' }, // 🔧 工作流
			{ id: 'graph', label: '\u{1F9E0} Graph' }, // 🧠 Graph
		];
		for (const opt of catOptions) {
			const chip = document.createElement('div');
			chip.className = 'mp-cat' + (opt.id === 'all' ? ' active' : '');
			chip.dataset.cat = String(opt.id);
			chip.textContent = opt.label;
			chip.onclick = () => {
				this._activeCategory = opt.id;
				cats.querySelectorAll('.mp-cat').forEach(c => c.classList.remove('active'));
				chip.classList.add('active');
				this._renderGrid();
			};
			cats.appendChild(chip);
		}
		toolbar.appendChild(cats);
		header.appendChild(toolbar);
		this._container.appendChild(header);

		// ── Grid scroll area ────────────────────────────
		const gridScroll = document.createElement('div');
		gridScroll.className = 'mp-grid-scroll';
		const grid = document.createElement('div');
		grid.className = 'mp-grid';

		const sectionTitle = document.createElement('div');
		sectionTitle.className = 'mp-section-title';
		sectionTitle.textContent = '\u{1F4E6} \u5546\u57CE\u8D44\u6E90 '; // 📦 商城资源
		this._resultCountEl = document.createElement('span');
		this._resultCountEl.className = 'count';
		sectionTitle.appendChild(this._resultCountEl);
		grid.appendChild(sectionTitle);

		this._gridEl = document.createElement('div');
		this._gridEl.className = 'mp-cards';
		grid.appendChild(this._gridEl);

		// Pagination (static, matching mockup)
		const pagination = document.createElement('div');
		pagination.className = 'mp-pagination';
		const prevBtn = document.createElement('div');
		prevBtn.className = 'mp-page-btn';
		prevBtn.textContent = '\u2039 \u4E0A\u4E00\u9875'; // ‹ 上一页
		(prevBtn as HTMLDivElement).style.opacity = '0.4';
		(prevBtn as HTMLDivElement).style.cursor = 'default';
		pagination.appendChild(prevBtn);
		const page1 = document.createElement('div');
		page1.className = 'mp-page-btn active';
		page1.textContent = '1';
		pagination.appendChild(page1);
		const page2 = document.createElement('div');
		page2.className = 'mp-page-btn';
		page2.textContent = '2';
		pagination.appendChild(page2);
		const nextBtn = document.createElement('div');
		nextBtn.className = 'mp-page-btn';
		nextBtn.textContent = '\u4E0B\u4E00\u9875 \u203A'; // 下一页 ›
		pagination.appendChild(nextBtn);
		grid.appendChild(pagination);

		gridScroll.appendChild(grid);
		this._container.appendChild(gridScroll);

		// ── Detail panel (hidden) ───────────────────────
		this._detailEl = document.createElement('div');
		this._detailEl.className = 'mp-detail';
		const back = document.createElement('div');
		back.className = 'md-back';
		back.textContent = '\u2190 \u8FD4\u56DE\u5546\u57CE\u5217\u8868'; // ← 返回商城列表
		back.onclick = () => { this._detailEl.classList.remove('show'); };
		this._detailEl.appendChild(back);
		this._detailContentEl = document.createElement('div');
		this._detailContentEl.className = 'md-content';
		this._detailEl.appendChild(this._detailContentEl);
		this._container.appendChild(this._detailEl);

		// ── Install overlay (hidden) ────────────────────
		this._overlayEl = document.createElement('div');
		this._overlayEl.className = 'install-overlay';
		this._container.appendChild(this._overlayEl);

		parent.appendChild(this._container);

		// Immediately load packages (also re-triggered via setInput)
		this._loadPackages();
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof MarketplaceEditorInput)) { return; }

		// Apply one-shot deep-link state (e.g. jump to TAPD MCP), then clear it.
		if (input.initialSearch !== undefined || input.initialCategory !== undefined) {
			this._applyInit(input.initialSearch, input.initialCategory);
			input.initialSearch = undefined;
			input.initialCategory = undefined;
		}

		await this._loadPackages();
	}

	/**
	 * Apply a deep-link navigation (search query + category filter) requested by
	 * the caller before the pane opened. Re-renders the grid if packages are
	 * already loaded, and seeds the search box + active category chip.
	 */
	private _applyInit(search?: string, category?: PackageKind): void {
		if (category) {
			this._activeCategory = category;
			this._container?.querySelectorAll<HTMLElement>('.mp-cat').forEach(c => {
				c.classList.toggle('active', c.dataset.cat === String(category));
			});
		}
		if (search !== undefined) {
			this._searchQuery = search.toLowerCase();
			if (this._searchInput) { this._searchInput.value = search; }
		}
		if (this._packages.length > 0) {
			this._renderGrid();
		}
	}

	/** Helper: show an empty-state message in the grid (avoids innerHTML / TrustedHTML CSP) */
	private _showEmptyMessage(msg: string): void {
		clearNode(this._gridEl);
		const el = document.createElement('div');
		el.className = 'mp-empty';
		el.textContent = msg;
		this._gridEl.appendChild(el);
	}

	private _autoSyncAttempted = false;

	private async _loadPackages(): Promise<void> {
		if (this._loading) { return; }

		// ── 后台静默同步商城登录态（不阻塞数据加载）──
		// 服务端 /packages 使用 optionalAuth，允许匿名浏览公开资源。
		// 登录态仅用于下载/上传操作，因此不阻塞列表加载。
		if (!this.marketplaceService.isLoggedIn() && !this._autoSyncAttempted) {
			this._autoSyncAttempted = true;
			this.marketplaceService.loginWithTof().then(() => {
				// 同步成功 → onDidChangeLogin 会触发 _refreshUserDisplay + _loadPackages
			}).catch(() => {
				// 同步失败（无 TOF 票据/网关不可达）→ 不阻塞浏览，header 显示"未登录"
			});
		}

		this._loading = true;
		this._showEmptyMessage('\u52A0\u8F7D\u4E2D...'); // 加载中...
		try {
			// pageSize 设为较大值以获取所有类型的资源（skill/agent/mcp/knowledge）
			// 避免因分页只取到部分类型（如仅 MCP）
			const result = await this.marketplaceService.listPackages({ pageSize: 1000, sort: 'popular' });
			this._packages = [...result.items];
			if (!this._packages || this._packages.length === 0) {
				this._showEmptyMessage('\u5546\u57CE\u4E2D\u6682\u65E0\u53EF\u7528\u8D44\u6E90'); // 商城中暂无可用资源
				this._resultCountEl.textContent = '0 \u4E2A\u8D44\u6E90';
				return;
			}
			this._renderGrid();
		} catch (err) {
			console.error('[Marketplace] API error:', err);
			this._showEmptyMessage(`\u52A0\u8F7D\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`); // 加载失败: ...
			this._resultCountEl.textContent = '';
		} finally {
			this._loading = false;
		}
	}

	/** 触发 VsSaros TOF 登录（完整 OAuth 流程，打开浏览器） */
	private async _triggerLogin(): Promise<void> {
		try {
			// 调用 agentStudio.tofLogin 命令发起完整 TOF OAuth 登录（打开浏览器）
			// 登录成功后 onDidChangeUser → marketplaceService._syncTofLogin → onDidChangeLogin → _loadPackages
			await this.commandService.executeCommand('agentStudio.tofLogin');
		} catch (err) {
			this.notificationService.error(`\u767B\u5F55\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`); // 登录失败: ...
		}
	}

	private _renderGrid(): void {
		if (!this._gridEl) { return; }
		clearNode(this._gridEl);

		// Graph tab — special rendering (fetches from Git remote)
		if (this._activeCategory === 'graph') {
			this._renderGraphGrid();
			return;
		}

		let filtered = this._packages;
		if (!filtered || filtered.length === 0) {
			this._showEmptyMessage('\u6CA1\u6709\u53EF\u7528\u7684\u8D44\u6E90'); // 没有可用的资源
			this._resultCountEl.textContent = '0 \u4E2A\u8D44\u6E90';
			return;
		}
		if (this._activeCategory !== 'all') {
			filtered = filtered.filter(p => p.kind === this._activeCategory);
		}
		if (this._searchQuery) {
			filtered = filtered.filter(p =>
				p.name.toLowerCase().includes(this._searchQuery) ||
				((p.description ?? '').toLowerCase().includes(this._searchQuery)) ||
				(p.tags && p.tags.some(t => t.toLowerCase().includes(this._searchQuery)))
			);
		}
		this._resultCountEl.textContent = `${filtered.length} \u4E2A\u8D44\u6E90`; // X 个资源

		if (filtered.length === 0) {
			this._showEmptyMessage('\u6CA1\u6709\u5339\u914D\u7684\u8D44\u6E90'); // 没有匹配的资源
			return;
		}

		for (const pkg of filtered) {
			this._gridEl.appendChild(this._createCard(pkg));
		}
	}

	// ── Graph tab: fetch from remote Git repo ──────────────────────────────

	private static readonly GRAPH_REMOTE = 'https://git.woa.com/zijianqiu/vssaros-codebase-memory.git';

	private async _renderGraphGrid(): Promise<void> {
		if (!this._gridEl) { return; }
		this._resultCountEl.textContent = '加载中...';
		this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-descriptionForeground,#9d9d9d);">⏳ 正在从远程仓库获取 Graph 列表...</div>';

		const cp = (globalThis as any).require?.('child_process');
		if (!cp) {
			this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:#f48771;">✗ 无法访问文件系统</div>';
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		let branches: { name: string; hash: string }[] = [];
		try {
			const output = cp.execSync(`git ls-remote --heads ${MarketplaceEditorPane.GRAPH_REMOTE}`, {
				encoding: 'utf-8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
			}).trim();
			branches = output.split('\n').filter((l: string) => l.trim()).map((line: string) => {
				const [hash, ref] = line.split('\t');
				return { name: ref.replace('refs/heads/', ''), hash };
			});
		} catch (err: any) {
			this._gridEl.innerHTML = `<div style="padding:40px;text-align:center;color:#f48771;">✗ 获取失败: ${err?.message || err}<br><br>请确保远程仓库存在且网络可达。</div>`;
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		if (branches.length === 0) {
			this._gridEl.innerHTML = '<div style="padding:40px;text-align:center;color:var(--vscode-descriptionForeground,#9d9d9d);">📦 远程仓库中暂无 Graph 数据<br><br>先在 Codebase Memory 中索引项目并"同步到团队"。</div>';
			this._resultCountEl.textContent = '0 个 Graph';
			return;
		}

		this._resultCountEl.textContent = `${branches.length} 个 Graph`;
		for (const b of branches) {
			this._gridEl.appendChild(this._createGraphCard(b.name, b.hash));
		}
	}

	private _createGraphCard(projectName: string, hash: string): HTMLElement {
		const card = document.createElement('div');
		card.className = 'mp-card';
		card.style.cursor = 'default';

		const top = document.createElement('div');
		top.className = 'card-top';
		const icon = document.createElement('div');
		icon.className = 'card-icon';
		icon.textContent = '\u{1F9E0}'; // 🧠
		top.appendChild(icon);
		const info = document.createElement('div');
		info.className = 'card-info';
		const nameEl = document.createElement('div');
		nameEl.className = 'card-name';
		nameEl.textContent = projectName;
		info.appendChild(nameEl);
		const meta = document.createElement('div');
		meta.className = 'card-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge';
		badge.style.cssText = 'background:rgba(197,134,192,.15);color:#c586c0;font-size:9px;padding:2px 7px;border-radius:3px;font-weight:600;';
		badge.textContent = 'Graph';
		meta.appendChild(badge);
		const ver = document.createElement('span');
		ver.className = 'card-ver';
		ver.textContent = hash.substring(0, 7);
		meta.appendChild(ver);
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		const desc = document.createElement('div');
		desc.className = 'card-desc';
		desc.textContent = `\u56E2\u961F\u5171\u4EAB\u7684\u4EE3\u7801\u5E93\u77E5\u8BC6\u56FE\u8C31\u3002\u9879\u76EE: ${projectName}`;
		card.appendChild(desc);

		const footer = document.createElement('div');
		footer.className = 'card-footer';
		const stats = document.createElement('div');
		stats.className = 'card-stats';
		stats.textContent = '\u{1F4E6} graph.db.zst';
		footer.appendChild(stats);

		const btn = document.createElement('button');
		btn.className = 'install-btn';
		btn.textContent = '\u2B07 \u4E0B\u8F7D'; // ⬇ 下载
		btn.onclick = async (e: Event) => {
			e.stopPropagation();
			btn.disabled = true;
			btn.textContent = '\u23F3 \u4E0B\u8F7D\u4E2D...'; // ⏳ 下载中...
			try {
				const result = await this.cbmService.syncGraph();
				if (result.success) {
					btn.textContent = '\u2713 \u5DF2\u540C\u6B65'; // ✓ 已同步
					btn.classList.add('installed');
					this.notificationService.info(result.message);
				} else {
					btn.textContent = '\u2B07 \u4E0B\u8F7D';
					btn.disabled = false;
					this.notificationService.warn(result.message);
				}
			} catch (err: any) {
				btn.textContent = '\u2B07 \u4E0B\u8F7D';
				btn.disabled = false;
				this.notificationService.error(`\u4E0B\u8F7D\u5931\u8D25: ${err?.message || err}`);
			}
		};
		footer.appendChild(btn);
		card.appendChild(footer);

		return card;
	}

	private _createCard(pkg: IMarketplacePackage): HTMLElement {
		const card = document.createElement('div');
		card.className = 'mp-card';
		card.onclick = () => this._openDetail(pkg);

		// Top: icon + name + meta
		const top = document.createElement('div');
		top.className = 'card-top';
		const icon = document.createElement('div');
		icon.className = 'card-icon';
		icon.textContent = pkg.icon ?? KIND_ICON[pkg.kind];
		top.appendChild(icon);
		const info = document.createElement('div');
		info.className = 'card-info';
		const name = document.createElement('div');
		name.className = 'card-name';
		name.textContent = pkg.name;
		info.appendChild(name);
		const meta = document.createElement('div');
		meta.className = 'card-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge ' + this._kindBadgeClass(pkg.kind);
		badge.textContent = KIND_LABEL[pkg.kind];
		meta.appendChild(badge);
		if (pkg.latestVersion) {
			const ver = document.createElement('span');
			ver.className = 'card-ver';
			ver.textContent = `v${pkg.latestVersion}`;
			meta.appendChild(ver);
		}
		info.appendChild(meta);
		top.appendChild(info);
		card.appendChild(top);

		// Description
		const desc = document.createElement('div');
		desc.className = 'card-desc';
		desc.textContent = pkg.description ?? '\u65E0\u63CF\u8FF0'; // 无描述
		card.appendChild(desc);

		// Footer: stats + install button
		const footer = document.createElement('div');
		footer.className = 'card-footer';
		const stats = document.createElement('div');
		stats.className = 'card-stats';
		if (pkg.downloads !== undefined) {
			stats.textContent = `\u2B07 ${pkg.downloads}`;
		}
		footer.appendChild(stats);
		const installBtn = document.createElement('button');
		installBtn.className = 'install-btn';
		installBtn.textContent = '\u5B89\u88C5'; // 安装
		installBtn.onclick = (e) => { e.stopPropagation(); this._startInstall(pkg); };
		footer.appendChild(installBtn);
		card.appendChild(footer);

		return card;
	}

	private _kindBadgeClass(kind: PackageKind): string {
		switch (kind) {
			case 'skill': return 'badge-skill';
			case 'agent': return 'badge-agent';
			case 'mcp': return 'badge-mcp';
			case 'knowledge': return 'badge-kb';
			case 'workflow': return 'badge-workflow';
		}
	}

	private async _openDetail(pkg: IMarketplacePackage): Promise<void> {
		clearNode(this._detailContentEl);
		this._detailEl.classList.add('show');

		// Basic info first
		const h2 = document.createElement('h2');
		h2.textContent = `${pkg.icon ?? KIND_ICON[pkg.kind]} ${pkg.name} `;
		if (pkg.latestVersion) {
			const ver = document.createElement('span');
			ver.style.cssText = 'font-size:14px;color:var(--vscode-textLink-foreground,#569cd6);font-family:monospace;';
			ver.textContent = `v${pkg.latestVersion}`;
			h2.appendChild(ver);
		}
		this._detailContentEl.appendChild(h2);

		const meta = document.createElement('div');
		meta.className = 'md-meta';
		const badge = document.createElement('span');
		badge.className = 'card-badge ' + this._kindBadgeClass(pkg.kind);
		badge.textContent = KIND_LABEL[pkg.kind];
		meta.appendChild(badge);
		if (pkg.downloads !== undefined) {
			meta.appendChild(document.createTextNode(`\u2B07 ${pkg.downloads} \u6B21\u4E0B\u8F7D`)); // ⬇ X 次下载
		}
		if (pkg.tags.length > 0) {
			meta.appendChild(document.createTextNode(`\u6807\u7B7E: ${pkg.tags.map(t => '#' + t).join(' ')}`)); // 标签:
		}
		this._detailContentEl.appendChild(meta);

		const descBox = document.createElement('div');
		descBox.className = 'md-desc';
		descBox.textContent = pkg.description ?? '\u65E0\u63CF\u8FF0'; // 无描述
		this._detailContentEl.appendChild(descBox);

		// Version history (fetch detail)
		const versionsSection = document.createElement('div');
		versionsSection.className = 'md-versions';
		const versionsTitle = document.createElement('h3');
		versionsTitle.textContent = '\u{1F4DC} \u7248\u672C\u5386\u53F2'; // 📜 版本历史
		versionsSection.appendChild(versionsTitle);
		const loadingVer = document.createElement('div');
		loadingVer.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		loadingVer.textContent = '\u52A0\u8F7D\u4E2D...';
		versionsSection.appendChild(loadingVer);
		this._detailContentEl.appendChild(versionsSection);

		// Install bar
		const installBar = document.createElement('div');
		installBar.className = 'md-install-bar';
		const installBtn = document.createElement('button');
		installBtn.className = 'install-btn';
		installBtn.style.cssText = 'font-size:13px;padding:7px 20px;';
		installBtn.textContent = '\u2B07 \u4E0B\u8F7D\u5E76\u5B89\u88C5'; // ⬇ 下载并安装
		installBtn.onclick = () => this._startInstall(pkg);
		installBar.appendChild(installBtn);
		const hint = document.createElement('span');
		hint.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		hint.textContent = '\u5B89\u88C5\u5230 ~/.saros/ \u76EE\u5F55\uFF0C\u81EA\u52A8\u542F\u7528'; // 安装到 ~/.saros/ 目录，自动启用
		installBar.appendChild(hint);
		this._detailContentEl.appendChild(installBar);

		// Fetch version history
		try {
			const detail: IMarketplacePackageDetail = await this.marketplaceService.getPackage(pkg.slug);
			loadingVer.remove();
			for (const ver of detail.versions) {
				const verItem = document.createElement('div');
				verItem.className = 'ver-item' + (ver.isLatest ? ' latest' : '');
				const left = document.createElement('div');
				const verLabel = document.createElement('strong');
				verLabel.textContent = `v${ver.version}`;
				left.appendChild(verLabel);
				if (ver.isLatest) {
					const latestTag = document.createElement('span');
					latestTag.style.cssText = 'color:#4ec9b0;font-size:12px;margin-left:8px;';
					latestTag.textContent = '(\u6700\u65B0)'; // (最新)
					left.appendChild(latestTag);
				}
				const verMeta = document.createElement('div');
				verMeta.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:3px;';
				const date = new Date(ver.createdAt);
				verMeta.textContent = `${date.toISOString().split('T')[0]} \u00B7 ${this._formatSize(ver.size)}`;
				left.appendChild(verMeta);
				verItem.appendChild(left);

				if (ver.isLatest) {
					const verInstallBtn = document.createElement('button');
					verInstallBtn.className = 'install-btn';
					verInstallBtn.textContent = '\u5B89\u88C5'; // 安装
					verInstallBtn.onclick = () => this._startInstall(pkg);
					verItem.appendChild(verInstallBtn);
				}
				versionsSection.appendChild(verItem);
			}
		} catch {
			loadingVer.textContent = '\u7248\u672C\u5386\u53F2\u52A0\u8F7D\u5931\u8D25'; // 版本历史加载失败
		}
	}

	private _formatSize(bytes: number): string {
		if (bytes < 1024) { return `${bytes} B`; }
		if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	private async _startInstall(pkg: IMarketplacePackage): Promise<void> {
		if (this._installingIds.has(pkg.id)) { return; }
		if (!pkg.latestVersion) {
			this.notificationService.warn(`\u8D44\u6E90 "${pkg.name}" \u6CA1\u6709\u53EF\u7528\u7248\u672C\u3002`);
			return;
		}
		if (!this.marketplaceService.isLoggedIn()) {
			this.notificationService.info('\u6B63\u5728\u540C\u6B65\u767B\u5F55\u6001\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u5B89\u88C5...'); // 正在同步登录态，请稍后重试安装...
			// 尝试同步登录态，成功后 onDidChangeLogin 会触发刷新
			this._triggerLogin();
			return;
		}

		this._installingIds.add(pkg.id);
		this._showInstallOverlay(pkg);

		try {
			const result = await this.marketplaceService.download(pkg.slug, pkg.latestVersion, pkg.kind);

			// MCP install 副作用：注册到 mcpManagementService + 通知 Integration view 刷新
			// 使用 result.kind（而非 pkg.kind）判断：商城 API 可能把 MCP 包错误返回为 kind=skill，
			// 但 _installMcpFromManifest 已在 download() 内按 manifest 内容正确路由并返回 kind=mcp
			if (result.kind === 'mcp') {
				this.logService.info(`[MarketplaceEditor] Install succeeded as mcp, syncing to VS Code config... slug=${pkg.slug}`);
				await this._syncMcpToVsCode(pkg.slug);
				const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
				this.logService.info(`[MarketplaceEditor] Emitting mcp:servers-changed (add, presetId=${sanitize(pkg.slug)})`);
				this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(pkg.slug) });
			} else {
				this.logService.info(`[MarketplaceEditor] Install succeeded as kind=${result.kind}, skipping MCP sync.`);
			}

			this._showInstallSuccess(pkg, result.version);
			this.notificationService.info(`\u2705 ${pkg.name} v${result.version} \u5B89\u88C5\u6210\u529F\u3002`);
		} catch (err) {
			this._showInstallError(pkg, err instanceof Error ? err.message : String(err));
			this.notificationService.error(`\u5B89\u88C5\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this._installingIds.delete(pkg.id);
		}
	}

	/**
	 * 同步 MCP config 到 VS Code mcpManagementService（注册到 mcpService.servers）
	 * —— 参照 mcpServerEditorPane._syncMcpToVsCode，确保 Integration view 能识别。
	 */
	private async _syncMcpToVsCode(slug: string): Promise<void> {
		try {
			const userHome = await this.pathService.userHome();
			const configUri = URI.joinPath(userHome, '.saros', 'mcp', slug, 'config.json');
			if (!await this.fileService.exists(configUri)) { return; }
			const content = await this.fileService.readFile(configUri);
			const config = JSON.parse(content.value.toString());
			const transport = config.transport || 'stdio';
			let serverConfig: IMcpServerConfiguration;
			if (transport === 'stdio') {
				serverConfig = {
					type: McpServerType.LOCAL,
					command: config.command || '',
					...(config.args ? { args: config.args } : {}),
					...(config.env ? { env: config.env } : {}),
				};
			} else {
				serverConfig = {
					type: McpServerType.REMOTE,
					url: config.url || '',
					...(config.headers ? { headers: config.headers } : {}),
				};
			}
			const installable: IInstallableMcpServer = { name: slug, config: serverConfig };
			await this.mcpManagementService.install(installable);
			this.logService.info(`[MarketplaceEditor] Successfully installed MCP "${slug}" to VS Code config (transport=${transport})`);
		} catch (e) {
			this.logService.warn(`[MarketplaceEditor] Failed to sync MCP "${slug}" to VS Code config (non-fatal):`, e);
		}
	}

	private _showInstallOverlay(pkg: IMarketplacePackage): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';

		// Head
		const head = document.createElement('div');
		head.className = 'id-head';
		const headTitle = document.createElement('span');
		headTitle.textContent = `\u5B89\u88C5 ${pkg.name}`; // 安装 X
		head.appendChild(headTitle);
		const closeX = document.createElement('span');
		closeX.style.cssText = 'cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:18px;';
		closeX.textContent = '\u2715';
		closeX.onclick = () => { this._overlayEl.classList.remove('show'); };
		head.appendChild(closeX);
		dialog.appendChild(head);

		// Body
		const body = document.createElement('div');
		body.className = 'id-body';

		const rows: [string, string][] = [
			['\u540D\u79F0', `${pkg.icon ?? KIND_ICON[pkg.kind]} ${pkg.name}`], // 名称
			['\u7248\u672C', `v${pkg.latestVersion}`], // 版本
			['\u7C7B\u578B', KIND_LABEL[pkg.kind]], // 类型
			['\u5B89\u88C5\u4F4D\u7F6E', `~/.saros/${pkg.kind === 'knowledge' ? 'knowledge-base' : pkg.kind === 'mcp' ? 'mcp' : pkg.kind === 'agent' ? 'agents/custom' : 'skills'}/${pkg.slug}/`], // 安装位置
		];
		for (const [label, val] of rows) {
			const row = document.createElement('div');
			row.className = 'id-row';
			const l = document.createElement('span');
			l.className = 'id-label';
			l.textContent = label;
			const v = document.createElement('span');
			v.className = 'id-val';
			if (label === '\u7248\u672C') { v.style.color = 'var(--vscode-textLink-foreground,#569cd6)'; }
			if (label === '\u5B89\u88C5\u4F4D\u7F6E') { v.style.cssText = 'font-family:monospace;font-size:11px;'; }
			v.textContent = val;
			row.appendChild(l); row.appendChild(v);
			body.appendChild(row);
		}

		// Progress
		const progress = document.createElement('div');
		progress.className = 'id-progress';
		const bar = document.createElement('div');
		bar.className = 'id-bar';
		const fill = document.createElement('div');
		fill.className = 'id-fill';
		bar.appendChild(fill);
		progress.appendChild(bar);

		const stepsEl = document.createElement('div');
		stepsEl.className = 'id-steps';
		const stepLabels = [
			'\u4E0B\u8F7D\u8D44\u6E90\u5305', // 下载资源包
			'\u89E3\u538B\u6587\u4EF6', // 解压文件
			'\u5B89\u88C5\u5230\u672C\u5730\u76EE\u5F55', // 安装到本地目录
			'\u6CE8\u518C\u5E76\u91CD\u65B0\u52A0\u8F7D', // 注册并重新加载
		];
		const stepEls: HTMLElement[] = [];
		for (const label of stepLabels) {
			const step = document.createElement('div');
			step.className = 'id-step pending';
			step.textContent = label;
			stepsEl.appendChild(step);
			stepEls.push(step);
		}
		progress.appendChild(stepsEl);
		body.appendChild(progress);
		dialog.appendChild(body);

		// Actions
		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'id-btn';
		cancelBtn.textContent = '\u53D6\u6D88'; // 取消
		cancelBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
		actions.appendChild(cancelBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);

		// Animate progress steps
		let step = 0;
		const tick = () => {
			if (step < stepEls.length && this._overlayEl.classList.contains('show')) {
				stepEls[step].classList.remove('pending');
				stepEls[step].classList.add('active');
				fill.style.width = `${((step + 1) / stepEls.length) * 100}%`;
				setTimeout(() => {
					if (!this._overlayEl.classList.contains('show')) { return; }
					stepEls[step].classList.remove('active');
					stepEls[step].classList.add('done');
					stepEls[step].textContent = `\u2713 ${stepEls[step].textContent}`;
					step++;
					tick();
				}, 700);
			}
		};
		setTimeout(tick, 400);
	}

	private _showInstallSuccess(pkg: IMarketplacePackage, version: string): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';

		const body = document.createElement('div');
		body.className = 'id-body';
		body.style.textAlign = 'center';
		body.style.padding = '20px 18px';

		const icon = document.createElement('div');
		icon.style.cssText = 'font-size:40px;margin-bottom:8px;';
		icon.textContent = '\u2705';
		body.appendChild(icon);

		const title = document.createElement('div');
		title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px;';
		title.textContent = `${pkg.name} \u5B89\u88C5\u6210\u529F\uFF01`; // X 安装成功！
		body.appendChild(title);

		const ver = document.createElement('div');
		ver.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		ver.textContent = `\u7248\u672C v${version} \u00B7 \u5DF2\u5B89\u88C5\u5230\u672C\u5730`; // 版本 vX · 已安装到本地
		body.appendChild(ver);

		const hint = document.createElement('div');
		hint.style.cssText = 'font-size:11px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-top:6px;';
		hint.textContent = '\u8D44\u6E90\u5DF2\u81EA\u52A8\u542F\u7528\uFF0C\u53EF\u5728 Integration \u9762\u677F\u4E2D\u4F7F\u7528'; // 资源已自动启用，可在 Integration 面板中使用
		body.appendChild(hint);

		dialog.appendChild(body);

		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const doneBtn = document.createElement('button');
		doneBtn.className = 'id-btn';
		doneBtn.textContent = '\u5B8C\u6210'; // 完成
		doneBtn.onclick = () => { this._overlayEl.classList.remove('show'); this._detailEl.classList.remove('show'); this._renderGrid(); };
		actions.appendChild(doneBtn);
		const okBtn = document.createElement('button');
		okBtn.className = 'id-btn primary';
		okBtn.textContent = '\u6253\u5F00\u8D44\u6E90'; // 打开资源
		okBtn.onclick = () => { this._overlayEl.classList.remove('show'); this._detailEl.classList.remove('show'); this._renderGrid(); };
		actions.appendChild(okBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);
	}

	private _showInstallError(pkg: IMarketplacePackage, errorMsg: string): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';
		dialog.style.borderColor = 'var(--vscode-errorForeground,#f48771)';

		const body = document.createElement('div');
		body.className = 'id-body';
		body.style.textAlign = 'center';
		body.style.padding = '20px 18px';

		const icon = document.createElement('div');
		icon.style.cssText = 'font-size:40px;margin-bottom:8px;';
		icon.textContent = '\u274C';
		body.appendChild(icon);

		const title = document.createElement('div');
		title.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:6px;color:var(--vscode-errorForeground,#f48771);';
		title.textContent = '\u5B89\u88C5\u5931\u8D25'; // 安装失败
		body.appendChild(title);

		const msg = document.createElement('div');
		msg.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);';
		msg.textContent = errorMsg;
		body.appendChild(msg);
		dialog.appendChild(body);

		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const closeBtn = document.createElement('button');
		closeBtn.className = 'id-btn primary';
		closeBtn.textContent = '\u5173\u95ED'; // 关闭
		closeBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
		actions.appendChild(closeBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);
	}

	// ── 爬取功能 ──────────────────────────────────────────────────

	/** 显示 Knot 登录流程：在内置浏览器中登录 → 重新抓取 */
	private _showKnotAuthFlow(
		statusEl: HTMLElement, previewEl: HTMLElement,
		authErr: KnotAuthError,
		crawlBtn: HTMLElement, cancelBtn: HTMLElement,
		originalUrl: string,
	): void {
		clearNode(statusEl);
		statusEl.style.color = '';
		statusEl.style.display = 'block';

		// 提示
		const hint = document.createElement('div');
		hint.style.cssText = 'margin-bottom:10px;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:12px;line-height:1.6;';
		hint.innerHTML = '检测到 Knot 需要登录认证。<br>已在编辑器中打开 Knot 页面，请在编辑器窗口中完成 OA 登录（扫码），登录完成后返回此处点击"已完成登录，开始抓取"。';
		statusEl.appendChild(hint);

		// 按钮行
		const btnRow = document.createElement('div');
		btnRow.style.cssText = 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;';

		const retryBtn = document.createElement('button');
		retryBtn.className = 'id-btn';
		retryBtn.textContent = '已完成登录，开始抓取';
		statusEl.appendChild(btnRow);
		btnRow.appendChild(retryBtn);

		// 日志区域（在按钮下方）
		const logArea = document.createElement('div');
		logArea.style.cssText = 'margin-top:8px;max-height:200px;overflow-y:auto;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:8px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;display:none;';
		statusEl.appendChild(logArea);

		const appendLog = (msg: string, type: 'info' | 'success' | 'error' | 'step' = 'info') => {
			logArea.style.display = 'block';
			const entry = document.createElement('div');
			const colors: Record<string, string> = {
				step: 'color:#569cd6;font-weight:600;',
				success: 'color:#4ec9b0;',
				error: 'color:#f48771;',
				info: 'color:var(--vscode-descriptionForeground,#9d9d9d);',
			};
			entry.style.cssText = colors[type] || colors.info;
			const time = new Date().toLocaleTimeString();
			entry.textContent = '[' + time + '] ' + msg;
			logArea.appendChild(entry);
			logArea.scrollTop = logArea.scrollHeight;
		};

		retryBtn.onclick = async () => {
			retryBtn.disabled = true;
			retryBtn.textContent = '抓取中...';
			clearNode(logArea);
			logArea.style.display = 'block';
			appendLog('开始抓取流程...', 'step');

			// 页面已在编辑器中打开且用户已登录，直接重新抓取
			// _crawlPageId 保持不变，_crawlPreview 会重新导航到详情页
			try {
				const preview = await this._crawlPreview(originalUrl, appendLog);
				appendLog('抓取成功，正在自动保存到本地...', 'step');
				crawlBtn.textContent = '\u{1F4BE} 保存中...';
				// 直接自动保存到 ~/.saros/skills/
				const crawlData = {
					url: preview.url,
					kind: preview.kind as PackageKind,
					slug: preview.slug,
					name: preview.name,
					description: preview.description,
					version: preview.version,
					tags: preview.tags || [],
					category: preview.category,
					icon: preview.icon,
					mcpConfig: preview.mcpConfig,
					skillContent: preview.skillContent,
					useGuide: preview.useGuide,
					toolsDescription: preview.toolsDescription,
					files: preview.files,
					versions: preview.versions,
				author: preview.author,
				wikiUrl: preview.wikiUrl,
				_zipPath: preview._zipPath,
			};
			const localPath = await this._saveCrawlLocally(crawlData);
			appendLog('已保存到: ' + localPath, 'success');
			// 保存成功后关闭爬取页面（后台页面）
				this._closeCrawlPage().catch(() => { /* ignore */ });
				// 显示完成按钮，保留日志
				retryBtn.disabled = true;
				retryBtn.textContent = '\u2705 完成';
				retryBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
				retryBtn.disabled = false;
			} catch (err) {
				appendLog('抓取失败: ' + (err instanceof Error ? err.message : String(err)), 'error');
				retryBtn.disabled = false;
				retryBtn.textContent = '已完成登录，重新抓取';
			}
		};
	}

	/** 显示爬取 URL 输入弹窗 */
	private _showCrawlOverlay(): void {
		clearNode(this._overlayEl);
		this._overlayEl.classList.add('show');

		const dialog = document.createElement('div');
		dialog.className = 'install-dialog';
		dialog.style.maxWidth = '500px';

		// Head
		const head = document.createElement('div');
		head.className = 'id-head';
		const headTitle = document.createElement('span');
		headTitle.textContent = '\u{1F310} \u8D44\u6E90\u722C\u53D6'; // 🌐 资源爬取
		head.appendChild(headTitle);
		const closeX = document.createElement('span');
		closeX.style.cssText = 'cursor:pointer;color:var(--vscode-descriptionForeground,#9d9d9d);font-size:18px;';
		closeX.textContent = '\u2715';
		closeX.onclick = () => { this._overlayEl.classList.remove('show'); };
		head.appendChild(closeX);
		dialog.appendChild(head);

		// Body
		const body = document.createElement('div');
		body.className = 'id-body';
		body.style.maxHeight = '60vh';
		body.style.overflowY = 'auto';

		const desc = document.createElement('div');
		desc.style.cssText = 'font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);margin-bottom:12px;';
		desc.textContent = '\u8F93\u5165\u8D44\u6E90\u9875\u9762 URL\uFF0C\u81EA\u52A8\u722C\u53D6\u5E76\u5BFC\u5165\u5546\u57CE\u3002\u5F53\u524D\u652F\u6301 knot.woa.com'; // 输入资源页面 URL...
		body.appendChild(desc);

		const urlInput = document.createElement('input');
		urlInput.type = 'text';
		urlInput.placeholder = 'https://knot.woa.com/mcp/detail/1566';
		urlInput.style.cssText = 'width:100%;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:8px 10px;color:var(--vscode-input-foreground,#ccc);font-size:13px;font-family:Consolas,monospace;outline:none;';
		body.appendChild(urlInput);

		// 示例 URL
		const examples = document.createElement('div');
		examples.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:4px;';
		const exampleUrls = [
			'https://knot.woa.com/mcp/detail/1566',
			'https://knot.woa.com/skills/detail/1980',
		];
		for (const exUrl of exampleUrls) {
			const chip = document.createElement('span');
			chip.style.cssText = 'font-size:10px;color:var(--vscode-descriptionForeground,#9d9d9d);padding:2px 8px;border:1px solid var(--vscode-panel-border,#3c3c3c);border-radius:10px;cursor:pointer;font-family:Consolas,monospace;';
			chip.textContent = exUrl.split('/').slice(-2).join('/');
			chip.onclick = () => { urlInput.value = exUrl; };
			examples.appendChild(chip);
		}
		body.appendChild(examples);

		// 状态区域
		const statusEl = document.createElement('div');
		statusEl.style.cssText = 'margin-top:12px;font-size:12px;color:var(--vscode-descriptionForeground,#9d9d9d);display:none;';
		body.appendChild(statusEl);

		// 预览区域
		const previewEl = document.createElement('div');
		previewEl.setAttribute('data-preview', 'true');
		previewEl.style.cssText = 'margin-top:12px;display:none;';
		body.appendChild(previewEl);

		dialog.appendChild(body);

		// Actions
		const actions = document.createElement('div');
		actions.className = 'id-actions';
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'id-btn';
		cancelBtn.textContent = '\u53D6\u6D88'; // 取消
		cancelBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
		actions.appendChild(cancelBtn);

		const crawlBtn = document.createElement('button');
		crawlBtn.className = 'id-btn primary';
		crawlBtn.textContent = '\u{1F50D} \u5F00\u59CB\u722C\u53D6'; // 🔍 开始爬取
		crawlBtn.onclick = async () => {
			const url = urlInput.value.trim();
			if (!url) { return; }
			crawlBtn.disabled = true;
			crawlBtn.textContent = '\u722C\u53D6\u4E2D...'; // 爬取中...
			previewEl.style.display = 'none';

			// 禁用关闭按钮，防止爬取过程中意外关闭
			closeX.style.pointerEvents = 'none';
			closeX.style.opacity = '0.5';
			cancelBtn.disabled = true;

			// 创建日志区域
			clearNode(statusEl);
			statusEl.style.display = 'block';
			statusEl.style.color = '';

			const logArea = document.createElement('div');
			logArea.style.cssText = 'max-height:300px;overflow-y:auto;background:var(--vscode-input-background,#1e1e1e);border:1px solid var(--vscode-input-border,#3c3c3c);border-radius:4px;padding:8px;font-size:11px;font-family:Consolas,monospace;line-height:1.6;display:none;';
			statusEl.appendChild(logArea);

			const appendLog = (msg: string, type: 'info' | 'success' | 'error' | 'step' = 'info') => {
				logArea.style.display = 'block';
				const entry = document.createElement('div');
				const colors: Record<string, string> = {
					step: 'color:#569cd6;font-weight:600;',
					success: 'color:#4ec9b0;',
					error: 'color:#f48771;',
					info: 'color:var(--vscode-descriptionForeground,#9d9d9d);',
				};
				entry.style.cssText = colors[type] || colors.info;
				const time = new Date().toLocaleTimeString();
				entry.textContent = '[' + time + '] ' + msg;
				logArea.appendChild(entry);
				logArea.scrollTop = logArea.scrollHeight;
			};

			try {
				const preview = await this._crawlPreview(url, appendLog);
				appendLog('抓取成功，正在自动保存到本地...', 'step');
				crawlBtn.textContent = '\u{1F4BE} 保存中...';
				// 直接自动保存到 ~/.saros/skills/
				const crawlData = {
					url: preview.url,
					kind: preview.kind as PackageKind,
					slug: preview.slug,
					name: preview.name,
					description: preview.description,
					version: preview.version,
					tags: preview.tags || [],
					category: preview.category,
					icon: preview.icon,
					mcpConfig: preview.mcpConfig,
					skillContent: preview.skillContent,
					useGuide: preview.useGuide,
					toolsDescription: preview.toolsDescription,
					files: preview.files,
					versions: preview.versions,
					author: preview.author,
					wikiUrl: preview.wikiUrl,
					_zipPath: preview._zipPath,
				};
				const localPath = await this._saveCrawlLocally(crawlData);
				appendLog('已保存到: ' + localPath, 'success');
				// 保存成功后关闭爬取页面（后台页面）
				this._closeCrawlPage().catch(() => { /* ignore */ });
				// 显示完成按钮，保留日志
				crawlBtn.disabled = true;
				crawlBtn.textContent = '\u2705 完成';
				// 重新启用关闭按钮
				closeX.style.pointerEvents = '';
				closeX.style.opacity = '';
				cancelBtn.disabled = false;
				crawlBtn.onclick = () => { this._overlayEl.classList.remove('show'); };
				crawlBtn.disabled = false;
			} catch (err) {
				crawlBtn.disabled = false;
				crawlBtn.textContent = '\u{1F50D} \u5F00\u59CB\u722C\u53D6';
				// 重新启用关闭按钮
				closeX.style.pointerEvents = '';
				closeX.style.opacity = '';
				cancelBtn.disabled = false;
				// 如果是 Knot 认证错误，显示登录流程
				if (err instanceof KnotAuthError) {
					this._showKnotAuthFlow(statusEl, previewEl, err, crawlBtn, cancelBtn, url);
				} else {
					appendLog('错误: ' + (err instanceof Error ? err.message : String(err)), 'error');
				}
			}
		};
		actions.appendChild(crawlBtn);
		dialog.appendChild(actions);

		this._overlayEl.appendChild(dialog);
		urlInput.focus();
	}

	/** 通过 Playwright 抓取 Knot 页面数据：设置 header → 导航 → 提取数据 → 下载 zip */
	private async _crawlPreview(url: string, onLog?: (msg: string, type?: 'info' | 'success' | 'error' | 'step') => void): Promise<any> {
		const log = (msg: string, type: 'info' | 'success' | 'error' | 'step' = 'info') => {
			console.log('[Crawl] ' + msg);
			onLog?.(msg, type);
		};

		// 解析 URL
		let parsedUrl: URL;
		try { parsedUrl = new URL(url); } catch { throw new Error('URL 格式无效'); }
		if (parsedUrl.hostname !== 'knot.woa.com') { throw new Error('当前仅支持 knot.woa.com'); }

		// 提取资源类型和 ID
		let resourceType = 'unknown';
		let resourceId = '';
		const skillMatch = parsedUrl.pathname.match(/\/skills\/detail\/(\d+)/);
		const mcpMatch = parsedUrl.pathname.match(/\/mcp\/detail\/(\d+)/);
		if (skillMatch) { resourceType = 'skill'; resourceId = skillMatch[1]; }
		else if (mcpMatch) { resourceType = 'mcp'; resourceId = mcpMatch[1]; }
		if (!resourceId) { throw new Error('无法从 URL 提取资源 ID'); }

		const sessionId = 'marketplace-crawl';
		log('开始抓取: type=' + resourceType + ', id=' + resourceId, 'step');

		// 在可见的编辑器窗口中打开页面（用户可以看到页面，需要时可登录）
		if (!this._crawlPageId) {
			log('在内置浏览器中打开页面...', 'step');
			const browserId = 'knot-crawl-' + Date.now();
			this._crawlBrowserInput = this.browserViewWorkbenchService.getOrCreateLazy(browserId, {
				url, title: 'Knot - ' + resourceType + ' ' + resourceId, favicon: '',
			});
			await this.editorService.openEditor(this._crawlBrowserInput, { pinned: true });
			this._crawlPageId = browserId;
			log('已在编辑器中打开页面', 'info');
			log('等待页面加载 (3秒)...', 'step');
			await new Promise(resolve => setTimeout(resolve, 3000));
		}

		const viewId = this._crawlPageId!;
		log('连接 Playwright...', 'step');
		try {
			await this.playwrightService.startTrackingPage(viewId);
			log('Playwright 连接成功', 'success');
		} catch (e) {
			log('Playwright 连接失败: ' + (e as Error).message, 'error');
		}

		// Step 1: 设置 header + 导航 + 等待加载 + 检查登录（合并为一次调用）
		log('设置请求头并导航...', 'step');
		const navResult = await this.playwrightService.invokeFunction(sessionId, viewId,
			`async (page, targetUrl) => {
				// 设置模拟 Chrome 的请求头
				try {
					await page.setExtraHTTPHeaders({
						'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
						'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
						'Accept-Encoding': 'gzip, deflate, br',
						'Cache-Control': 'no-cache',
						'Pragma': 'no-cache',
						'Sec-Fetch-Dest': 'document',
						'Sec-Fetch-Mode': 'navigate',
						'Sec-Fetch-Site': 'none',
						'Sec-Fetch-User': '?1',
						'Upgrade-Insecure-Requests': '1'
					});
				} catch(e) {}

				// 导航到目标 URL
				await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

				// 等待详情页内容加载（等待"说明"文本出现，这是详情页特有的标签）
				try {
					await page.waitForFunction(() => {
						const t = document.body.innerText || '';
						// "说明" 和 "介绍" 同时出现表示详情页已加载
					 return t.includes('说明') && t.includes('介绍');
					}, { timeout: 15000 });
				} catch(e) {
					// fallback: 等待带 primary class 的安装按钮
					try {
						await page.waitForSelector('button[class*="bg-primary"]', { timeout: 5000 });
					} catch(e2) {}
				}

				// 模拟人类行为：延迟
				await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));

				// 获取页面状态
				const pageUrl = page.url();
				const pageText = await page.evaluate(() => (document.body.innerText || '').slice(0, 500));
				return JSON.stringify({ url: pageUrl, text: pageText });
			}`,
			[url], 30000);

		if (navResult.error) {
			log('导航失败: ' + navResult.error, 'error');
		}

		// 检查登录页
		let pageState: { url: string; text: string } = { url: '', text: '' };
		try { pageState = JSON.parse(String(navResult.result || '{}')); } catch { /* ignore */ }
		log('当前页面 URL: ' + pageState.url, 'info');
		log('页面文本前100字: ' + (pageState.text || '').slice(0, 100), 'info');

		const isLoginPage =
			pageState.url.includes('passport.woa.com') ||
			pageState.url.includes('signin.ashx') ||
			pageState.url.includes('/_auth_login') ||
			pageState.text.includes('iOA Mobile') ||
			pageState.text.includes('Scan the QR code') ||
			pageState.text.includes('扫码') ||
			pageState.text.includes('请使用企业微信') ||
			(pageState.text.includes('confirm') && pageState.text.includes('phone'));

		if (isLoginPage) {
			log('检测到登录页: ' + pageState.url, 'error');
			throw new KnotAuthError(pageState.url || url, resourceType, resourceId, url);
		}
		log('页面已加载（非登录页）', 'success');

		// Step 2: 提取数据（用精确 CSS 选择器，基于详情页 HTML 结构）
		log('提取页面数据...', 'step');

		// 2a. 等待详情页 sheet 加载 + 提取基本信息
		const basicResult = await this.playwrightService.invokeFunction(sessionId, viewId,
			`async (page) => {
				var data = {};

				// 等待详情页 sheet 出现（[data-slot="sheet-content"] 或 [role="dialog"]）
				try {
					await page.waitForSelector('[data-slot="sheet-content"]', { timeout: 10000 });
				} catch(e) {
					try { await page.waitForSelector('[role="dialog"]', { timeout: 5000 }); } catch(e2) {}
				}

				// 提取标题: h2[data-slot="sheet-title"] 或 .truncate.text-lg.font-semibold
				data.name = await page.evaluate(() => {
					var h2 = document.querySelector('[data-slot="sheet-title"]');
					if (h2 && h2.textContent.trim()) return h2.textContent.trim();
					var titleEl = document.querySelector('.truncate.text-lg.font-semibold');
					if (titleEl && titleEl.textContent.trim()) return titleEl.textContent.trim();
					return '';
				});

				// 提取作者、安装量、更新时间: 从 span.font-medium 标签中查找
				data.author = await page.evaluate(() => {
					var spans = document.querySelectorAll('span.font-medium');
					for (var i = 0; i < spans.length; i++) {
						if (spans[i].textContent.includes('作者')) {
							var next = spans[i].nextElementSibling;
							if (next) return next.textContent.trim();
						}
					}
					return '';
				});

				data.installCount = await page.evaluate(() => {
					var spans = document.querySelectorAll('span.font-medium');
					for (var i = 0; i < spans.length; i++) {
						if (spans[i].textContent.includes('安装量')) {
							var next = spans[i].nextElementSibling;
							if (next) return next.textContent.trim();
						}
					}
					return '';
				});

				data.updatedAt = await page.evaluate(() => {
					var spans = document.querySelectorAll('span.font-medium');
					for (var i = 0; i < spans.length; i++) {
						if (spans[i].textContent.includes('更新')) {
							var next = spans[i].nextElementSibling;
							if (next) return next.textContent.trim();
						}
					}
					return '';
				});

				// 提取说明: .md-editor-preview p（"使用说明" tab 的内容）
				data.description = await page.evaluate(() => {
					var p = document.querySelector('.md-editor-preview p');
					if (p) {
						var text = p.textContent.trim();
						// 移除 "介绍: url" 部分
						var desc = text.split(/介绍\s*[:：]/)[0].trim();
						return desc;
					}
					return '';
				});

				// 提取标签
				data.tags = await page.evaluate(() => {
					var badges = document.querySelectorAll('[data-slot="badge"]');
					var tags = [];
					for (var i = 0; i < badges.length; i++) {
						var t = badges[i].textContent.trim();
						if (t && t.length > 0 && t.length < 20) tags.push(t);
					}
					return tags;
				});

				// 提取页面文本（用于 fallback 解析）
				data.bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 5000));

				return JSON.stringify(data);
			}`,
			undefined, 20000);

		let extracted: any = {};
		if (basicResult.error) {
			log('基本信息提取失败: ' + basicResult.error, 'error');
		} else {
			try { extracted = JSON.parse(String(basicResult.result || '{}')); } catch { /* ignore */ }
		}

		const skillName = extracted.name || '';
		const description = extracted.description || '';
		const wikiUrl = extracted.wikiUrl || '';
		const author = extracted.author || '';
		const installCount = extracted.installCount || '';
		const updatedAt = extracted.updatedAt || '';
		const tags: string[] = extracted.tags || [];

		log('  名称: ' + (skillName || '(未找到)'), skillName ? 'success' : 'error');
		log('  描述: ' + (description ? description.slice(0, 80) + '...' : '(未找到)'), 'info');
		log('  作者: ' + (author || '(未找到)'), 'info');
		log('  安装量: ' + (installCount || '(未找到)'), 'info');
		log('  更新时间: ' + (updatedAt || '(未找到)'), 'info');
		if (tags.length > 0) { log('  标签: ' + tags.join(', '), 'info'); }

		// 2b. 点击"文件"tab
		log('切换到文件 tab...', 'step');
		await this.playwrightService.invokeFunction(sessionId, viewId,
			'async (page) => { await page.evaluate(() => { var tabs = document.querySelectorAll("[role=tab], button"); for (var i = 0; i < tabs.length; i++) { if (tabs[i].textContent.trim() === "文件") { tabs[i].click(); break; } } }); }',
			undefined, 5000);
		await new Promise(resolve => setTimeout(resolve, 2000));

		// 2c. 获取 SKILL.md 内容
		const skillMdResult = await this.playwrightService.invokeFunction(sessionId, viewId,
			'async (page) => { return await page.evaluate(() => { var main = document.querySelector("main"); if (main) { var t = main.innerText.trim(); if (t.length > 50) return t; } return ""; }); }',
			undefined, 10000);
		if (skillMdResult.error) { log('SKILL.md 提取失败: ' + skillMdResult.error, 'error'); }
		const skillMdContent = (skillMdResult.result as string) || '';
		if (skillMdContent.length > 50) {
			log('  SKILL.md: ' + skillMdContent.length + ' 字符', 'success');
		} else {
			log('  SKILL.md: 获取失败', 'error');
		}

		// 2d. 点击"版本历史"tab
		log('切换到版本历史 tab...', 'step');
		await this.playwrightService.invokeFunction(sessionId, viewId,
			'async (page) => { await page.evaluate(() => { var tabs = document.querySelectorAll("[role=tab], button"); for (var i = 0; i < tabs.length; i++) { if (tabs[i].textContent.trim().indexOf("版本历史") >= 0) { tabs[i].click(); break; } } }); }',
			undefined, 5000);
		await new Promise(resolve => setTimeout(resolve, 1500));

		// 2e. 获取版本历史
		const verResult = await this.playwrightService.invokeFunction(sessionId, viewId,
			'async (page) => { return await page.evaluate(() => { var items = document.querySelectorAll("li"); var vers = []; for (var i = 0; i < items.length; i++) { var t = items[i].textContent.trim(); var m = t.match(/v(\\d+\\.\\d+\\.\\d+)/); if (m) { vers.push({version: m[1], isLatest: t.indexOf("最新") >= 0, date: (t.match(/20\\d{2}-\\d{2}-\\d{2}[\\s\\d:]*/) || [""])[0]}); } } return JSON.stringify(vers.slice(0, 10)); }); }',
			undefined, 8000);
		if (verResult.error) { log('版本历史提取失败: ' + verResult.error, 'error'); }
		let versions: any[] = [];
		try { versions = JSON.parse((verResult.result as string) || '[]'); } catch { /* ignore */ }
		if (versions.length > 0) {
			log('  版本历史: ' + versions.length + ' 个版本', 'success');
			for (const v of versions.slice(0, 3)) {
				log('    v' + v.version + (v.isLatest ? ' (最新)' : '') + (v.date ? ' ' + v.date : ''), 'info');
			}
		} else {
			log('  版本历史: (未找到)', 'error');
		}

		// Step 3: 构建最终数据
		const finalData: any = {
			display_name: skillName || ('Knot ' + resourceType + ' ' + resourceId),
			description: description || '',
			author: author || '',
			install_count: installCount ? parseInt(installCount.replace(/,/g, '')) : undefined,
			updated_at: updatedAt || '',
			wiki_url: wikiUrl,
			tags: tags,
			version: versions[0]?.version || '1.0.0',
		};
		if (skillMdContent.length > 50) {
			finalData.skill_content = skillMdContent;
			finalData.use_guide = skillMdContent;
		}
		if (versions.length > 0) { finalData._versions = versions; }
		log('技能数据提取完成: ' + finalData.display_name, 'success');

		// Step 4: 下载 zip 文件
		log('下载技能 zip 文件...', 'step');
		await this._highlightInPage(sessionId, viewId, '下载技能文件...');
		const downloadSlug = (finalData.display_name || 'unnamed').replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'unnamed';
		const zipPath = await this._downloadSkillZip(sessionId, viewId, downloadSlug, log);
		if (zipPath) {
			finalData._zipPath = zipPath;
			log('zip 下载成功: ' + zipPath, 'success');
		} else {
			log('zip 下载失败，使用 CDP 提取的文本作为 fallback', 'error');
		}

		const result = this._buildCrawlResult(url, resourceType, resourceId, finalData, 'cdp-extract');
		log('抓取完成: ' + result.name + ' v' + result.version, 'success');
		await this._highlightInPage(sessionId, viewId, '抓取完成: ' + result.name, true);
		return result;
	}

	/** 通过 Playwright 下载技能 zip 文件：page.on('response') 捕获 zip 响应体（解决 CORS 问题） */
	/** 通过 Playwright 下载技能 zip：page.on('response') 捕获 zip 响应体（解决 CORS） */
	private async _downloadSkillZip(sessionId: string, viewId: string, skillSlug: string, log: (msg: string, type?: 'info' | 'success' | 'error' | 'step') => void): Promise<string | null> {
		const userHome = await this.pathService.userHome();
		const downloadDir = URI.joinPath(userHome, '.saros', 'skills', '.downloads');
		try { await this.fileService.createFolder(downloadDir); } catch { /* ignore */ }

		try {
			log('点击安装 → 下载到本地 → 捕获 zip 响应...', 'step');

			// 用 page.on('response') 捕获 zip 响应体（解决 CORS 问题）
			const downloadResult = await this.playwrightService.invokeFunction(sessionId, viewId,
				`async (page) => {
					var zipBase64 = null;
					var zipUrl = null;
					var downloadApiResp = null;
					var resolved = false;

					// 设置 response 监听器，捕获 zip 文件响应
					var responsePromise = new Promise(function(resolve) {
						page.on('response', async function(response) {
							var url = response.url();
							try {
								// 捕获 DownloadSkill API 响应
								if (url.indexOf('DownloadSkill') >= 0) {
									var body = await response.text();
									downloadApiResp = body;
								}
								// 捕获 zip 文件响应（来自 mirrors.tencent.com 或其他 CDN）
								if ((url.indexOf('.zip') >= 0 || url.indexOf('mirrors.tencent') >= 0) && response.status() === 200 && !resolved) {
									var buf = await response.body();
									if (buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4B) {
										zipUrl = url;
										// 将 buffer 转 base64
										var arr = Array.from(new Uint8Array(buf));
										zipBase64 = await page.evaluate(function(bytes) {
											var binary = '';
											for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
											return btoa(binary);
										}, arr);
										resolved = true;
										resolve(zipBase64);
									}
								}
							} catch(e) {}
						});
					});

					// 点击"安装"按钮（优先选择带 primary class 的）
					var installBtnText = await page.evaluate(function() {
						var btns = document.querySelectorAll('button');
						var target = null;
						for (var i = 0; i < btns.length; i++) {
							var t = btns[i].textContent.trim();
							if (t === '安装' && btns[i].className.indexOf('primary') >= 0) { target = btns[i]; break; }
						}
						if (!target) {
							for (var i = btns.length - 1; i >= 0; i--) {
								if (btns[i].textContent.trim() === '安装') { target = btns[i]; break; }
							}
						}
						if (target) { target.click(); return target.textContent.trim(); }
						return '';
					});

					await page.evaluate(() => new Promise(r => setTimeout(r, 1000)));

					// 点击"下载到本地"
					var dlClicked = await page.evaluate(function() {
						var items = document.querySelectorAll('[role=menuitem], button, a, li, div, span');
						for (var i = 0; i < items.length; i++) {
							var t = items[i].textContent.trim();
							if (t === '下载到本地') { items[i].click(); return true; }
						}
						return false;
					});

					// 等待 zip 响应（最多 15 秒）- 用 page.evaluate 中的 setTimeout
					var waitPromise = page.evaluate(() => new Promise(r => setTimeout(r, 15000))).then(function() { return null; });
					var result = await Promise.race([responsePromise, waitPromise]);

					return JSON.stringify({
						installBtn: installBtnText,
						downloadClicked: dlClicked,
						zipBase64: zipBase64,
						zipUrl: zipUrl,
						downloadApiResp: downloadApiResp
					});
				}`,
				undefined, 30000);

			if (downloadResult.error) {
				log('下载失败: ' + downloadResult.error, 'error');
				return null;
			}

			let dlOutcome: any = {};
			try { dlOutcome = JSON.parse(String(downloadResult.result || '{}')); } catch { /* ignore */ }

			log('  安装按钮: ' + (dlOutcome.installBtn || '未找到'), dlOutcome.installBtn ? 'success' : 'error');
			log('  下载到本地: ' + (dlOutcome.downloadClicked ? '已点击' : '未找到'), dlOutcome.downloadClicked ? 'success' : 'error');

			if (dlOutcome.zipUrl) {
				log('  ZIP URL: ' + dlOutcome.zipUrl.slice(0, 100), 'info');
			}
			if (dlOutcome.downloadApiResp) {
				log('  DownloadSkill API: ' + dlOutcome.downloadApiResp.slice(0, 200), 'info');
			}

			// 方案1: 如果 page.on('response') 捕获到了 zip base64
			if (dlOutcome.zipBase64) {
				const zipName = skillSlug.replace(/\(.*\)/, '').trim().toLowerCase() + '.zip';
				const zipUri = URI.joinPath(downloadDir, zipName);
				log('写入文件: ' + zipUri.fsPath, 'step');
				await this.fileService.writeFile(zipUri, decodeBase64(dlOutcome.zipBase64));
				const stat = await this.fileService.stat(zipUri);
				log('下载完成: ' + zipName + ' (' + stat.size + ' bytes)', 'success');
				return zipUri.fsPath;
			}

			// 方案2: 从 DownloadSkill API 解析 file_url，从浏览器默认下载目录复制文件
			if (dlOutcome.downloadApiResp) {
				try {
					const apiResp = JSON.parse(dlOutcome.downloadApiResp);
					const fileUrl = apiResp?.data?.file_url;
					if (fileUrl) {
						log('  从 API 获取下载 URL: ' + fileUrl.slice(0, 100), 'info');
						// 从 file_url 提取文件名
						const urlFileName = fileUrl.split('?')[0].split('/').pop() || 'download.zip';
						log('  文件名: ' + urlFileName, 'info');

						// 浏览器点击"下载到本地"后文件会下载到默认目录（如 D:/Downloads 或 ~/Downloads）
						// 等待文件出现在下载目录中
						log('等待浏览器下载完成...', 'step');
						const possibleDownloadDirs = [
							URI.file('D:/Downloads'),
							URI.joinPath(userHome, 'Downloads'),
						];
						let foundZip: URI | null = null;
						for (let attempt = 0; attempt < 20; attempt++) {
							for (const dir of possibleDownloadDirs) {
								const zipUri = URI.joinPath(dir, urlFileName);
								try {
									if (await this.fileService.exists(zipUri)) {
										const stat = await this.fileService.stat(zipUri);
										if (stat.size > 100) {
											foundZip = zipUri;
											break;
										}
									}
								} catch { /* ignore */ }
							}
							if (foundZip) break;
							await new Promise(resolve => setTimeout(resolve, 1000));
						}

						if (foundZip) {
							// 复制到 .downloads 目录
							const zipName = urlFileName;
							const targetZipUri = URI.joinPath(downloadDir, zipName);
							log('复制文件: ' + foundZip.fsPath + ' → ' + targetZipUri.fsPath, 'step');
							const content = await this.fileService.readFile(foundZip);
							await this.fileService.writeFile(targetZipUri, content.value);
							const stat = await this.fileService.stat(targetZipUri);
							log('下载完成: ' + zipName + ' (' + stat.size + ' bytes)', 'success');
							return targetZipUri.fsPath;
						} else {
							log('未在默认下载目录找到文件: ' + urlFileName, 'error');
						}
					}
				} catch (e) {
					log('解析下载 URL 失败: ' + (e as Error).message, 'error');
				}
			}

			// Fallback: 检查下载目录
			log('检查下载目录 (' + downloadDir.fsPath + ')...', 'step');
			const possibleNames = [skillSlug + '.zip', skillSlug.replace(/\(.*\)/, '').trim().toLowerCase() + '.zip', 'download.zip'];
			for (const name of possibleNames) {
				try {
					const zipUri = URI.joinPath(downloadDir, name);
					if (await this.fileService.exists(zipUri)) {
						const stat = await this.fileService.stat(zipUri);
						if (stat.size > 100) { log('找到: ' + name + ' (' + stat.size + ' bytes)', 'success'); return zipUri.fsPath; }
					}
				} catch { /* ignore */ }
			}

			log('下载失败，未找到 zip 文件', 'error');
			return null;
		} catch (e) {
			log('下载异常: ' + (e as Error).message, 'error');
			return null;
		}
	}

	/** 通过 Playwright 在页面上注入高亮覆盖层 */
	private async _highlightInPage(sessionId: string, pageId: string, message: string, isDone = false): Promise<void> {
		try {
			const color = isDone ? 'rgba(78,201,176,.92)' : 'rgba(0,122,204,.92)';
			const icon = isDone ? '\\u2705 ' : '\\u23F3 ';
			await this.playwrightService.invokeFunction(sessionId, pageId,
				'async (page, msg, color, icon) => { await page.evaluate((m, c, i) => { var e = document.getElementById("saros-crawl-overlay"); if (e) e.remove(); var o = document.createElement("div"); o.id = "saros-crawl-overlay"; o.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999999;padding:8px 16px;font-size:13px;color:#fff;background:" + c; o.textContent = i + m; document.body.appendChild(o); }, msg, color, icon); }',
				[message, color, icon], 5000);
		} catch { /* ignore */ }
	}





	/** 关闭爬取用的 BrowserEditor 页面 */
	private async _closeCrawlPage(): Promise<void> {
		if (!this._crawlPageId) { return; }
		const viewId = this._crawlPageId;
		this._crawlPageId = null;
		try { await this.playwrightService.stopTrackingPage(viewId); } catch { /* ignore */ }
		try { await this.playwrightService.disposeSession('marketplace-crawl'); } catch { /* ignore */ }
		// 关闭编辑器窗口并释放 input
		try {
			if (this._crawlBrowserInput) {
				// editorService.closeEditor expects IEditorIdentifier ({ groupId, editor })
				const editors = this.editorService.getEditors(0 /* EditorsOrder.SEQUENTIAL */);
				const target = editors.find(e => e.editor === this._crawlBrowserInput);
				if (target) {
					await this.editorService.closeEditor(target);
				}
				this._crawlBrowserInput.dispose();
				this._crawlBrowserInput = null;
			}
		} catch { /* ignore */ }
	}















	/** 构建爬取结果对象 */
	private _buildCrawlResult(url: string, resourceType: string, resourceId: string, data: any, source: string): any {
		const name = data.display_name || data.title || data.server_name || data.name || `Knot ${resourceType} ${resourceId}`;
		const description = (data.description || data.desc || '').toString().slice(0, 500);
		// version 可能是占位符（如 Knot 数据中 version 字段值为 "version"），需校验
		const rawVersion = data.ver || data.version || '';
		let version = /^\d+\.\d+/.test(rawVersion) ? rawVersion : '';
		// 如果没有有效版本号，从版本历史中取最新版本
		if (!version && data._versions?.length) {
			const latest = data._versions.find((v: any) => v.isLatest) || data._versions[0];
			if (latest?.version && /^\d+\.\d+/.test(latest.version)) {
				version = latest.version;
			}
		}
		if (!version) { version = '1.0.0'; }
		const tags = Array.isArray(data.tags)
			? data.tags.map((t: any) => typeof t === 'string' ? t : (t.display_name || t.tag_name || String(t))).filter(Boolean).slice(0, 5)
			: [];
		const category = tags[0] || data.type || data.category || 'other';
		const icon = data.display_icon && !String(data.display_icon).startsWith('http') ? data.display_icon : undefined;

		// Knot MCP/Skill 特有字段
		const useGuide = (data.use_guide || '').toString().slice(0, 10000);
		const toolsDescription = (data.tools_description || data.tool_desc || '').toString().slice(0, 5000);

		// 文件列表
		let files: Array<{ name: string; size?: string; type?: string }> | undefined;
		if (data._files?.length) { files = data._files; }
		else if (Array.isArray(data.files)) { files = data.files.map((f: any) => ({ name: typeof f === 'string' ? f : f.name || f.file_name || '', size: f.size, type: f.type })); }

		// 版本历史
		let versions: any[] | undefined;
		if (data._versions?.length) { versions = data._versions; }
		else if (Array.isArray(data.versions)) { versions = data.versions.map((v: any) => ({ version: v.version || v.ver, date: v.created_at || v.updated_at, size: v.size, isLatest: v.is_latest })); }
		else if (data.version_list || data.versionList) { versions = data.version_list || data.versionList; }

		// 作者信息
		const author = data.author || data.creator || data.author_name || data.owner || '';

		// 安装量/下载量
		const downloads = data.install_count || data.download_count || data.installs || data.hot || undefined;

		// iWiki 文档链接
		const wikiUrl = (data.wiki_url || data.doc_url || data.iwiki_link || '').toString();

		// SKILL.md 内容（如果 Knot 提供了完整内容）
		let skillContent = '';
		if (resourceType === 'skill') {
			skillContent = (data.skill_content || data.content || data.markdown_content || data.raw || '').toString();
			// 如果没有 skill content 但有 use guide，用 use guide 作为主要内容
			if (!skillContent && useGuide) {
				skillContent = `# ${name}\n\n${description}\n\n## 使用指南\n\n${useGuide}\n`;
			}
			// 如果还是没有，生成基础模板
			if (!skillContent) {
				skillContent = `# ${name}\n\n${description}\n`;
			}
		}

		let mcpConfig: any = undefined;
		if (resourceType === 'mcp' && data.config) {
			try { mcpConfig = typeof data.config === 'string' ? JSON.parse(data.config) : data.config; } catch { /* ignore */ }
		}

		const kind = resourceType === 'mcp' ? 'mcp' : resourceType === 'skill' ? 'skill' : resourceType === 'agent' ? 'agent' : resourceType === 'knowledge' ? 'knowledge' : 'mcp';
		// slug 直接用技能名称（保留中文，去除文件系统非法字符）
		const slug = name.replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || ('knot-' + resourceType + '-' + resourceId);

		return {
			url, platform: 'knot', resourceType, resourceId,
			name, description, slug, version, kind, tags, category, icon,
			mcpConfig, useGuide, toolsDescription, source,
			author, downloads, wikiUrl,
			files, versions, skillContent,
		};
	}

	/** 各 kind 的本地安装子目录 */
	private static readonly KIND_SUBDIR: Record<PackageKind, string> = {
		agent: 'agents',
		skill: 'skills',
		mcp: 'mcp',
		knowledge: 'knowledge-base',
		workflow: 'workflows',
	};

	/** 用 fileService + DecompressionStream 在渲染进程中解压 zip 文件 */
	private async _extractZipFile(zipUri: URI, targetDir: URI): Promise<boolean> {
		try {
			const content = await this.fileService.readFile(zipUri);
			const data = content.value.buffer;

			let offset = 0;
			while (offset < data.length - 30) {
				// Local file header signature: PK\x03\x04
				if (data[offset] !== 0x50 || data[offset + 1] !== 0x4B || data[offset + 2] !== 0x03 || data[offset + 3] !== 0x04) {
					offset++;
					continue;
				}

				const compMethod = data[offset + 8] | (data[offset + 9] << 8);
				const compSize = (data[offset + 18] | (data[offset + 19] << 8) | (data[offset + 20] << 16) | (data[offset + 21] << 24)) >>> 0;
				const nameLen = data[offset + 26] | (data[offset + 27] << 8);
				const extraLen = data[offset + 28] | (data[offset + 29] << 8);
				const nameStart = offset + 30;
				const name = new TextDecoder('utf-8').decode(data.subarray(nameStart, nameStart + nameLen));
				const dataStart = nameStart + nameLen + extraLen;

				if (name && !name.endsWith('/') && compSize > 0) {
					let fileData: Uint8Array;

					if (compMethod === 0) {
						// Stored (no compression)
						fileData = data.subarray(dataStart, dataStart + compSize);
					} else if (compMethod === 8) {
						// Deflate
						const compressed = new Uint8Array(data.subarray(dataStart, dataStart + compSize));
						const ds = new DecompressionStream('deflate');
						const writer = ds.writable.getWriter();
						writer.write(compressed);
						writer.close();
						const decompressed = await new Response(ds.readable).arrayBuffer();
						fileData = new Uint8Array(decompressed);
					} else {
						offset = dataStart + compSize;
						continue;
					}

					// 创建父目录
					const pathParts = name.split('/');
					if (pathParts.length > 1) {
						let dir = targetDir;
						for (let i = 0; i < pathParts.length - 1; i++) {
							dir = URI.joinPath(dir, pathParts[i]);
							try { await this.fileService.createFolder(dir); } catch { /* ignore */ }
						}
					}

					// 写入文件
					await this.fileService.writeFile(URI.joinPath(targetDir, name), VSBuffer.wrap(fileData));
				}

				offset = dataStart + (compSize > 0 ? compSize : 1);
			}
			return true;
		} catch {
			return false;
		}
	}

	/** 将爬取的资源保存到本地 ~/.saros/{subdir}/{slug}/ */
	private async _saveCrawlLocally(data: {
		kind: PackageKind; slug: string; name: string; description: string;
		version: string; tags: string[]; category?: string; icon?: string;
		mcpConfig?: any; skillContent?: string;
		useGuide?: string; toolsDescription?: string;
		files?: Array<{ name: string; size?: string; type?: string }>;
		versions?: Array<{ version: string; date: string; size?: string; isLatest?: boolean }>;
		author?: string; wikiUrl?: string;
		_zipPath?: string;
	}	): Promise<string> {
		const userHome = await this.pathService.userHome();
		const subdir = MarketplaceEditorPane.KIND_SUBDIR[data.kind];
		const targetDir = URI.joinPath(userHome, '.saros', subdir, data.slug);
		console.log('[Crawl] 保存到: ' + targetDir.fsPath);

		// 创建目录
		await this.fileService.createFolder(targetDir);

		// 如果有 zip 文件，解压到目标目录（保留完整文件结构）
		if (data._zipPath) {
			console.log('[Crawl] 解压 zip: ' + data._zipPath + ' → ' + targetDir.fsPath);
			const zipUri = URI.file(data._zipPath);
			const extracted = await this._extractZipFile(zipUri, targetDir);

			if (extracted && await this.fileService.exists(URI.joinPath(targetDir, 'SKILL.md'))) {
				console.log('[Crawl] 解压成功，SKILL.md 已找到');
			} else {
				console.log('[Crawl] 解压失败或 SKILL.md 未找到，尝试 PowerShell fallback');
				// 解压失败，尝试 PowerShell Expand-Archive 作为 fallback
				try {
					const targetPath = targetDir.fsPath.replace(/'/g, "''");
					const zipPath = data._zipPath.replace(/'/g, "''");
					await this.commandService.executeCommand('agentStudio.proxyRequest', {
						url: '', method: 'PS',
						body: 'Expand-Archive -Path \'' + zipPath + '\' -DestinationPath \'' + targetPath + '\' -Force',
					});
					console.log('[Crawl] PowerShell 解压完成');
				} catch {
					console.log('[Crawl] PowerShell 解压失败，尝试 child_process');
					try {
						const cp = (globalThis as any).require?.('child_process');
						if (cp) {
							cp.execSync('powershell -Command "Expand-Archive -Path \'' + data._zipPath + '\' -DestinationPath \'' + targetDir.fsPath + '\' -Force"', { timeout: 15000 });
							console.log('[Crawl] child_process 解压完成');
						}
					} catch { /* ignore */ }
				}
			}

			// 写入 manifest.json（补充元数据）
			const manifest: Record<string, unknown> = {
				kind: data.kind, id: data.slug, name: data.name,
				version: data.version || '1.0.0', description: data.description,
				category: data.category, author: data.author || 'crawl',
				source: 'knot-crawl', tags: data.tags, sourceUrl: data.wikiUrl,
			};
			await this.fileService.writeFile(URI.joinPath(targetDir, 'manifest.json'), VSBuffer.fromString(JSON.stringify(manifest, null, 2)));

			await this._recordInstalled(data.kind, data.slug, data.version || '1.0.0');
			return targetDir.fsPath;
		}

		// 没有 zip 文件，使用原有逻辑生成文件
		// 生成 manifest.json
		const files: string[] = ['manifest.json'];
		if (data.kind === 'mcp') { files.push('server.json'); }
		if (data.kind === 'skill') { files.push('SKILL.md'); }
		files.push('README.md');
		if (data.files?.length) { files.push('files.json'); }
		if (data.versions?.length) { files.push('versions.json'); }

		const manifest: Record<string, unknown> = {
			kind: data.kind,
			id: data.slug,
			name: data.name,
			version: data.version || '1.0.0',
			description: data.description,
			category: data.category,
			author: data.author || 'crawl',
			source: 'knot-crawl',
			tags: data.tags,
			files,
		};

		// 写入 manifest.json
		await this.fileService.writeFile(
			URI.joinPath(targetDir, 'manifest.json'),
			VSBuffer.fromString(JSON.stringify(manifest, null, 2))
		);

		// 写入 README.md（完整文档：描述 + 使用指南 + 工具说明 + 来源信息 + 文件列表 + 版本历史）
		let readmeParts: string[] = [`# ${data.name}`, '', data.description || ''];
		if (data.author) { readmeParts.push('', `- **作者**: ${data.author}`); }
		if (data.tags?.length) { readmeParts.push(`- **标签**: ${data.tags.map(t => '#' + t).join(' ')}`); }
		readmeParts.push('', '---');

		if (data.useGuide) {
			readmeParts.push('', '## 使用指南', '', data.useGuide);
		}
		if (data.toolsDescription) {
			readmeParts.push('', '## 工具说明', '', data.toolsDescription);
		}
		if (data.wikiUrl) {
			readmeParts.push('', '## 相关文档', '', `[iWiki 文档](${data.wikiUrl})`);
		}
		if (data.files?.length) {
			readmeParts.push('', '## 文件列表', '');
			data.files.forEach(f => {
				let fileLine = `- **${f.name}**`;
				if (f.size) { fileLine += ` (${f.size})`; }
				if (f.type) { fileLine += ` [${f.type}]`; }
				readmeParts.push(fileLine);
			});
		}
		if (data.versions?.length) {
			readmeParts.push('', '## 版本历史', '');
			data.versions.forEach(v => {
				let verLine = `- **v${v.version}**`;
				if (v.isLatest) { verLine += ' *(最新)*'; }
				verLine += ` \u2014 ${v.date}`;
				if (v.size) { verLine += ` (${v.size})`; }
				readmeParts.push(verLine);
			});
		}
		readmeParts.push('', '---', '', `_爬取来源: Knot 平台 | 版本: v${data.version || '1.0.0'}_`);

		await this.fileService.writeFile(
			URI.joinPath(targetDir, 'README.md'),
			VSBuffer.fromString(readmeParts.join('\n'))
		);

		// 写入 SKILL.md (Skill) - 带完整 frontmatter
		if (data.kind === 'skill') {
			const skillMd = this._generateSkillMd(data);
			await this.fileService.writeFile(
				URI.joinPath(targetDir, 'SKILL.md'),
				VSBuffer.fromString(skillMd)
			);
		}

		// 写入 server.json (MCP)
		if (data.kind === 'mcp' && data.mcpConfig) {
			const serverJson = this._buildMcpServerJson(data.mcpConfig, data.slug, data.name, data.description);
			await this.fileService.writeFile(
				URI.joinPath(targetDir, 'server.json'),
				VSBuffer.fromString(JSON.stringify(serverJson, null, 2))
			);
		}

		// 写入 files.json（文件列表元数据）
		if (data.files?.length) {
			await this.fileService.writeFile(
				URI.joinPath(targetDir, 'files.json'),
				VSBuffer.fromString(JSON.stringify(data.files, null, 2))
			);
		}

		// 写入 versions.json（版本历史元数据）
		if (data.versions?.length) {
			await this.fileService.writeFile(
				URI.joinPath(targetDir, 'versions.json'),
				VSBuffer.fromString(JSON.stringify(data.versions, null, 2))
			);
		}

		// 记录到 installed-packages.json
		await this._recordInstalled(data.kind, data.slug, data.version || '1.0.0');

		return targetDir.fsPath;
	}

	/**
	 * 生成完整的 SKILL.md 内容（带 frontmatter）
	 * CodeBuddy 技能格式要求 frontmatter 包含 name + description
	 */
	private _generateSkillMd(data: {
		name: string; description: string; version: string;
		skillContent?: string; useGuide?: string; toolsDescription?: string;
		tags?: string[]; author?: string; wikiUrl?: string;
	}): string {
		const lines: string[] = [];

		// Frontmatter
		lines.push('---');
		lines.push(`name: ${data.name}`);
		lines.push(`description: ${(data.description || '').replace(/\n/g, ' ').slice(0, 200)}`);
		if (data.version) { lines.push(`version: "${data.version}"`); }
		if (data.author) { lines.push(`author: "${data.author}"`); }
		if (data.tags?.length) {
			const tagsStr = data.tags.map(t => '"' + t + '"').join(', ');
			lines.push('tags: [' + tagsStr + ']');
		}
		lines.push('---');
		lines.push('');

		// 如果有原始 skill content，直接使用（去掉可能的重复标题）
		if (data.skillContent && data.skillContent.length > 20) {
			// 清理内容，移除可能重复的 # 标题行
			let content = data.skillContent.trim();
			// 如果第一行就是 "# name" 且和我们的名字匹配，跳过它
			const firstLineMatch = content.match(/^#\s+.+/m);
			if (firstLineMatch && firstLineMatch[0].includes(data.name)) {
				content = content.replace(/^#.+(\r?\n)/, '').trim();
			}
			lines.push(content);
		} else {
			// 从 useGuide 和 description 生成
			lines.push(`# ${data.name}`, '');
			if (data.description) { lines.push(data.description, ''); }

			if (data.useGuide) {
				lines.push('## 使用说明', '', data.useGuide, '');
			}
			if (data.toolsDescription) {
				lines.push('## 工具/能力说明', '', data.toolsDescription, '');
			}

			// 添加通用技能使用指引
			lines.push('## 使用方式', '', `这是一个从 Knot 平台爬取的技能资源（v${data.version || '1.0.0'}）。`, '');
			if (data.wikiUrl) {
				lines.push(`详细文档请参考: [iWiki](${data.wikiUrl})`, '');
			}
		}

		return lines.join('\n');
	}

	/** 构建 MCP server.json */
	private _buildMcpServerJson(config: any, slug: string, name: string, description: string): Record<string, unknown> {
		const transportType = (config.transportType || config.transport_type || 'http').toLowerCase();
		// streamable-http 归类为 http 传输
		let transport = 'http';
		if (transportType === 'sse') { transport = 'sse'; }
		else if (transportType === 'stdio') { transport = 'stdio'; }
		else if (transportType === 'streamable-http' || transportType === 'http') { transport = 'http'; }

		const server: Record<string, unknown> = { id: slug, name, description, transport };
		if (transport === 'stdio') {
			if (config.command) { server.command = config.command; }
			if (config.args) { server.args = Array.isArray(config.args) ? config.args : [config.args]; }
		} else {
			if (config.url) { server.url = config.url; }
		}
		if (config.headers && typeof config.headers === 'object') {
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(config.headers)) { env[k] = String(v); }
			if (Object.keys(env).length > 0) { server.env = env; }
		}
		if (config.timeout) { server.timeout = config.timeout; }
		return server;
	}

	/** 记录到 installed-packages.json */
	private async _recordInstalled(kind: PackageKind, storeId: string, version: string): Promise<void> {
		const userHome = await this.pathService.userHome();
		const fileUri = URI.joinPath(userHome, '.saros', 'installed-packages.json');
		let entries: Array<{ kind: string; storeId: string; version: string; installedAt: string }> = [];
		try {
			if (await this.fileService.exists(fileUri)) {
				const content = await this.fileService.readFile(fileUri);
				entries = JSON.parse(content.value.toString());
			}
		} catch { /* ignore */ }
		entries = entries.filter(e => !(e.kind === kind && e.storeId === storeId));
		entries.push({ kind, storeId, version, installedAt: new Date().toISOString() });
		await this.fileService.createFolder(URI.joinPath(fileUri, '..'));
		await this.fileService.writeFile(fileUri, VSBuffer.fromString(JSON.stringify(entries, null, 2)));
	}

	override layout(_dimension: Dimension): void {
		// Container uses flex, auto-fills.
	}

	override clearInput(): void {
		this._detailEl.classList.remove('show');
		this._overlayEl.classList.remove('show');
		super.clearInput();
	}
}
