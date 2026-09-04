/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { $, clearNode } from '../../../../base/browser/dom.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { getMcpPresets, type IMcpAutoInstall } from '../common/bundled-tools/bundledMcpPresets.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarketplaceService } from '../common/marketplace.js';
import { ITerminalService, type ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import type { ITerminalLaunchError } from '../../../../platform/terminal/common/terminal.js';
import { SarosPath, resolveSarosPath, userDataRootFromRoamingHome } from '../common/sarosPaths.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';

// ─── Unified detail model (from knot market OR bundled preset) ────────────────

interface IMcpDetailModel {
	id: string;
	name: string;
	displayName: string;
	description: string;
	useGuide: string;
	toolsDescription: string;
	icon: string;
	type: string;
	creator: string;
	transportType: string;
	url: string;
	command: string;
	args?: readonly string[];
	headers?: Record<string, string>;
	tags: string[];
	/** 一键"自动安装并配置"流程（内置 pip 型 MCP，如 Comfy MCP）。 */
	autoInstall?: IMcpAutoInstall;
	/** 「环境变量名 → 命令名」映射，自动安装时解析绝对路径注入 env。 */
	resolveEnv?: Record<string, string>;
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** Resolve a detail model by market id, from bundled presets (synchronous). */
export function resolveMcpDetailModel(marketId: string): IMcpDetailModel | undefined {
	const preset = getMcpPresets().find(p => p.id === marketId);
	if (preset) {
		return {
			id: preset.id,
			name: preset.id,
			displayName: preset.name,
			description: preset.description,
			useGuide: '',
			toolsDescription: '',
			icon: preset.icon ?? '',
			type: 'builtin',
			creator: '',
			transportType: preset.transportType === 'http' ? 'http' : 'stdio',
			url: preset.url ?? '',
			command: preset.command ?? '',
			args: preset.args,
			headers: preset.headers ? { ...preset.headers } : undefined,
			tags: preset.envKeys ? preset.envKeys.map(k => k) : [],
			autoInstall: preset.autoInstall ? { ...preset.autoInstall } : undefined,
			resolveEnv: preset.autoInstall?.resolveEnv ? { ...preset.autoInstall.resolveEnv } : undefined,
		};
	}
	return undefined;
}

/** Build an installable config from a detail model. */
export function buildInstallableConfig(
	model: IMcpDetailModel,
	extra?: { commandPath?: string; env?: Record<string, string> },
): IMcpServerConfiguration {
	const isRemote = model.transportType !== 'stdio' && (model.url?.length > 0);
	if (isRemote) {
		return {
			type: McpServerType.REMOTE,
			url: model.url,
			...(model.headers ? { headers: { ...model.headers } } : {}),
		};
	}
	// ★ LOCAL：优先用解析出的绝对路径（Windows 下 pip Scripts 目录常不在 PATH，
	//   用 `where.exe` 解析可避免 spawn ENOENT）；env 注入 resolveEnv 解析的
	//   COMFY_BIN 等（MCP host 环境不含 shell PATH）。
	return {
		type: McpServerType.LOCAL,
		command: extra?.commandPath || model.command,
		...(model.args ? { args: [...model.args] } : {}),
		...(extra?.env && Object.keys(extra.env).length > 0 ? { env: { ...extra.env } } : {}),
	};
}

// ─── EditorPane ───────────────────────────────────────────────────────────────

export class McpDetailEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.mcpDetail';

	private _container!: HTMLElement;
	private _model: IMcpDetailModel | undefined;
	private _installing = false;
	private _installed = false;
	private _localVersion: string | undefined;
	private _serverVersion: string | undefined;
	private _marketSlug: string | undefined;
	private readonly _renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
		@IFileService private readonly fileService: IFileService,
			@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super(McpDetailEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $('div.mcp-detail-editor');
		this._container.style.width = '100%';
		this._container.style.height = '100%';
		this._container.style.overflowY = 'auto';
		this._container.style.fontSize = '13px';
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof McpDetailEditorInput)) { return; }

		// 1. Try built-in presets (synchronous)
		this._model = resolveMcpDetailModel(input.marketId);
		// 2. Fallback: read from ~/.vssaros/mcp/{marketId}/config.json
		if (!this._model) {
			this._model = await this._resolveMcpDetailModelFromDisk(input.marketId);
		}
		this._marketSlug = input.marketId;
		await this._refreshInstallState();
		this._render();
	}

	/** Read MCP config from ~/.vssaros/mcp/{marketId}/config.json and build a detail model. */
	private async _resolveMcpDetailModelFromDisk(marketId: string): Promise<IMcpDetailModel | undefined> {
		try {
			const configUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcp, marketId, 'config.json');
			if (!await this.fileService.exists(configUri)) {
				return undefined;
			}
			const content = await this.fileService.readFile(configUri);
			const config = JSON.parse(content.value.toString());
			const transport = config.transport || 'stdio';
			return {
				id: marketId,
				name: config.name || marketId,
				displayName: config.name || marketId,
				description: config.description || '',
				useGuide: '',
				toolsDescription: '',
				icon: config.icon || '',
				type: 'installed',
				creator: config.author || '',
				transportType: transport === 'stdio' ? 'stdio' : 'http',
				url: config.url || '',
				command: config.command || '',
				args: config.args,
				headers: config.headers,
				tags: [],
			};
		} catch {
			return undefined;
		}
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  INSTALL STATE
	// ══════════════════════════════════════════════════════════════════════════

	private async _refreshInstallState(): Promise<void> {
		this._installed = false;
		this._localVersion = undefined;
		this._serverVersion = undefined;
		if (!this._marketSlug) { return; }

		// 1. Read local installed version from installed-packages.json
		try {
			const installed = await this.marketplaceService.getInstalled();
			const entry = installed.find(e => e.kind === 'mcp' && e.storeId === this._marketSlug);
			if (entry) {
				this._installed = true;
				this._localVersion = entry.version;
			}
		} catch { /* ignore */ }

		// 1b. Built-in auto-install type (Comfy MCP): "installed" = registered in
		// the MCP config (auto-install writes directly via mcpManagementService,
		// it never touches installed-packages.json).
		if (!this._installed && this._model?.autoInstall && this._marketSlug) {
			try {
				const registered = await this.mcpManagementService.getInstalled();
				const hit = registered.find(s => s.name === this._marketSlug || sanitize(s.name) === sanitize(this._marketSlug!));
				if (hit) {
					this._installed = true;
					this._localVersion = '已配置';
				}
			} catch { /* ignore */ }
		}

		// 2. Get server latest version
		try {
			const pkg = await this.marketplaceService.getPackage(this._marketSlug);
			this._serverVersion = pkg.latestVersion;
		} catch { /* ignore — may not be a marketplace package */ }
	}

	/** Compare semver versions: returns >0 if a>b, 0 if equal, <0 if a<b */
	private static _compareVersions(a: string, b: string): number {
		const pa = a.split('.').map(n => parseInt(n, 10) || 0);
		const pb = b.split('.').map(n => parseInt(n, 10) || 0);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const va = pa[i] || 0;
			const vb = pb[i] || 0;
			if (va > vb) return 1;
			if (va < vb) return -1;
		}
		return 0;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _render(): void {
		clearNode(this._container);
		this._renderDisposables.clear();

		if (!this._model) {
			const err = $('div');
			err.style.padding = '32px';
			err.style.color = 'var(--vscode-descriptionForeground)';
			err.textContent = 'MCP server not found.';
			this._container.appendChild(err);
			return;
		}

		const model = this._model;

		// ── Hero header ─────────────────────────────────────────────
		const hero = $('div.mcp-detail-hero');
		hero.style.display = 'flex';
		hero.style.alignItems = 'flex-start';
		hero.style.gap = '16px';
		hero.style.padding = '28px 32px 20px';
		hero.style.borderBottom = '1px solid var(--vscode-panel-border)';

		// Icon
		const iconBox = $('div.mcp-detail-icon');
		iconBox.style.width = '56px';
		iconBox.style.height = '56px';
		iconBox.style.flexShrink = '0';
		iconBox.style.borderRadius = '12px';
		iconBox.style.display = 'flex';
		iconBox.style.alignItems = 'center';
		iconBox.style.justifyContent = 'center';
		iconBox.style.overflow = 'hidden';
		iconBox.style.background = 'var(--vscode-sideBarSectionHeader-background)';
		iconBox.style.border = '1px solid var(--vscode-panel-border)';
		if (model.icon) {
			// Emoji icons (e.g. "🎨") are rendered as text — treating them as an
			// <img src> fired a bogus file:// request (net::ERR_FILE_NOT_FOUND).
			if (/^https?:\/\//i.test(model.icon) || /^data:/i.test(model.icon)) {
				const img = $('img') as HTMLImageElement;
				img.src = model.icon;
				img.style.width = '100%';
				img.style.height = '100%';
				img.style.objectFit = 'cover';
				img.onerror = () => { iconBox.textContent = '\u{1F50C}'; iconBox.style.fontSize = '28px'; };
				iconBox.appendChild(img);
			} else {
				iconBox.textContent = model.icon;
				iconBox.style.fontSize = '28px';
			}
		} else {
			iconBox.textContent = '\u{1F50C}';
			iconBox.style.fontSize = '28px';
		}
		hero.appendChild(iconBox);

		// Title block
		const titleBlock = $('div');
		titleBlock.style.flex = '1';
		titleBlock.style.minWidth = '0';

		const nameEl = $('h1');
		nameEl.textContent = model.displayName;
		nameEl.style.margin = '0 0 4px 0';
		nameEl.style.fontSize = '22px';
		nameEl.style.fontWeight = '600';
		titleBlock.appendChild(nameEl);

		// Meta row: type + creator + transport
		const metaRow = $('div');
		metaRow.style.display = 'flex';
		metaRow.style.flexWrap = 'wrap';
		metaRow.style.alignItems = 'center';
		metaRow.style.gap = '8px';
		metaRow.style.fontSize = '12px';
		metaRow.style.color = 'var(--vscode-descriptionForeground)';

		const typeLabel = model.type === 'official' ? '官方'
			: model.type === 'builtin' ? '内置' : '社区';
		metaRow.appendChild(this._chip(typeLabel, true));
		if (model.transportType) { metaRow.appendChild(this._chip(model.transportType.toUpperCase())); }
		if (model.creator) {
			const by = $('span');
			by.textContent = `by ${model.creator}`;
			metaRow.appendChild(by);
		}
		titleBlock.appendChild(metaRow);

		// Tags
		if (model.tags.length > 0) {
			const tagRow = $('div');
			tagRow.style.display = 'flex';
			tagRow.style.flexWrap = 'wrap';
			tagRow.style.gap = '6px';
			tagRow.style.marginTop = '8px';
			const uniqueTags = Array.from(new Set(model.tags)).slice(0, 8);
			for (const tag of uniqueTags) {
				tagRow.appendChild(this._chip(tag));
			}
			titleBlock.appendChild(tagRow);
		}

		hero.appendChild(titleBlock);

		// Action button (install / delete)
		hero.appendChild(this._buildActionButton());

		this._container.appendChild(hero);

		// Auto-install result strip (Comfy MCP etc.)
		if (this._lastAutoInstallLog) {
			const strip = $('div.mcp-detail-install-log');
			strip.style.margin = '0 32px 18px';
			strip.style.padding = '10px 14px';
			strip.style.borderRadius = '6px';
			strip.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
			strip.style.fontSize = '12px';
			strip.style.lineHeight = '1.5';
			strip.style.whiteSpace = 'pre-wrap';
			strip.style.wordBreak = 'break-all';
			strip.style.maxHeight = '200px';
			strip.style.overflowY = 'auto';
			strip.style.background = this._autoInstallFailed
				? 'var(--vscode-inputValidation-errorBackground, #5a1d1d)'
				: 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1))';
			strip.style.border = this._autoInstallFailed ? '1px solid var(--vscode-inputValidation-errorBorder, #be1100)' : '1px solid var(--vscode-panel-border)';
			strip.style.color = this._autoInstallFailed ? 'var(--vscode-errorForeground, #f48771)' : 'var(--vscode-foreground)';
			strip.textContent = this._lastAutoInstallLog;
			this._container.appendChild(strip);
		}

		// ── Body ────────────────────────────────────────────────────
		const body = $('div.mcp-detail-body');
		body.style.padding = '24px 32px 48px';
		body.style.maxWidth = '880px';

		// Description
		if (model.description) {
			body.appendChild(this._sectionTitle('简介'));
			const desc = $('p');
			desc.textContent = model.description;
			desc.style.margin = '0 0 20px 0';
			desc.style.fontSize = '13px';
			desc.style.lineHeight = '1.6';
			desc.style.color = 'var(--vscode-foreground)';
			body.appendChild(desc);
		}

		// Tools description
		if (model.toolsDescription) {
			body.appendChild(this._sectionTitle('工具说明'));
			body.appendChild(this._markdownBlock(model.toolsDescription));
		}

		// Usage guide
		if (model.useGuide) {
			body.appendChild(this._sectionTitle('使用指南'));
			body.appendChild(this._markdownBlock(model.useGuide));
		}

		// Connection info
		body.appendChild(this._sectionTitle('连接信息'));
		const connBox = $('div');
		connBox.style.background = 'var(--vscode-textCodeBlock-background, rgba(127,127,127,0.1))';
		connBox.style.borderRadius = '6px';
		connBox.style.padding = '12px 14px';
		connBox.style.fontFamily = 'var(--vscode-editor-font-family, monospace)';
		connBox.style.fontSize = '12px';
		connBox.style.whiteSpace = 'pre-wrap';
		connBox.style.wordBreak = 'break-all';
		connBox.style.lineHeight = '1.6';
		const isRemote = model.transportType !== 'stdio' && model.url;
		if (isRemote) {
			connBox.textContent = `transport: ${model.transportType}\nurl: ${model.url}`;
			if (model.headers && Object.keys(model.headers).length > 0) {
				connBox.textContent += `\nheaders: ${Object.keys(model.headers).join(', ')}`;
			}
		} else {
			connBox.textContent = `transport: stdio\ncommand: ${model.command} ${(model.args ?? []).join(' ')}`;
		}
		body.appendChild(connBox);

		this._container.appendChild(body);
	}

	private _chip(text: string, primary = false): HTMLElement {
		const chip = $('span');
		chip.textContent = text;
		chip.style.fontSize = '11px';
		chip.style.padding = '2px 8px';
		chip.style.borderRadius = '10px';
		chip.style.background = primary ? 'var(--vscode-badge-background)' : 'var(--vscode-input-background)';
		chip.style.color = primary ? 'var(--vscode-badge-foreground)' : 'var(--vscode-descriptionForeground)';
		chip.style.border = primary ? 'none' : '1px solid var(--vscode-panel-border)';
		return chip;
	}

	private _sectionTitle(text: string): HTMLElement {
		const h = $('h3');
		h.textContent = text;
		h.style.margin = '20px 0 10px 0';
		h.style.fontSize = '15px';
		h.style.fontWeight = '600';
		return h;
	}

	private _markdownBlock(text: string): HTMLElement {
		const wrap = $('div.mcp-detail-markdown');
		wrap.style.fontSize = '13px';
		wrap.style.lineHeight = '1.6';
		wrap.style.color = 'var(--vscode-foreground)';
		try {
			const rendered = renderMarkdown(new MarkdownString(text, { isTrusted: false, supportThemeIcons: true }));
			this._renderDisposables.add(rendered);
			rendered.element.style.overflowWrap = 'anywhere';
			wrap.appendChild(rendered.element);
		} catch {
			const pre = $('pre');
			pre.textContent = text;
			pre.style.whiteSpace = 'pre-wrap';
			wrap.appendChild(pre);
		}
		return wrap;
	}

	private _buildActionButton(): HTMLElement {
		const wrap = $('div');
		wrap.style.flexShrink = '0';
		wrap.style.display = 'flex';
		wrap.style.gap = '8px';

		if (this._installing) {
			const btn = $('button') as HTMLButtonElement;
			btn.textContent = '⏳ 安装中...';
			btn.disabled = true;
			btn.style.padding = '8px 22px';
			btn.style.fontSize = '13px';
			btn.style.fontWeight = '600';
			btn.style.border = 'none';
			btn.style.borderRadius = '6px';
			btn.style.cursor = 'not-allowed';
			btn.style.background = 'var(--vscode-button-secondaryBackground)';
			btn.style.color = 'var(--vscode-button-secondaryForeground)';
			wrap.appendChild(btn);
			return wrap;
		}

		if (!this._installed) {
			// Built-in pip 型 MCP（如 Comfy MCP）：一键"自动安装并配置"
			if (this._model?.autoInstall) {
				const btn = $('button') as HTMLButtonElement;
				btn.textContent = '⚙️ 自动安装并配置';
				btn.title = '检测并安装依赖（pip），完成后自动写入 MCP 服务器配置';
				btn.style.padding = '8px 22px';
				btn.style.fontSize = '13px';
				btn.style.fontWeight = '600';
				btn.style.border = 'none';
				btn.style.borderRadius = '6px';
				btn.style.cursor = 'pointer';
				btn.style.background = 'var(--vscode-button-background)';
				btn.style.color = 'var(--vscode-button-foreground)';
				btn.onclick = () => { void this._autoInstall(); };
				wrap.appendChild(btn);
			} else {
				// Not installed → Install button
				const btn = $('button') as HTMLButtonElement;
				btn.textContent = '⬇ 安装';
				btn.style.padding = '8px 22px';
				btn.style.fontSize = '13px';
				btn.style.fontWeight = '600';
				btn.style.border = 'none';
				btn.style.borderRadius = '6px';
				btn.style.cursor = 'pointer';
				btn.style.background = 'var(--vscode-button-background)';
				btn.style.color = 'var(--vscode-button-foreground)';
				btn.onclick = () => { void this._install(); };
				wrap.appendChild(btn);
			}
		} else {
			// Installed → check if upgrade available
			const canUpgrade = this._localVersion && this._serverVersion &&
				McpDetailEditorPane._compareVersions(this._serverVersion, this._localVersion) > 0;

			if (canUpgrade) {
				// Upgrade button
				const upBtn = $('button') as HTMLButtonElement;
				upBtn.textContent = `⬆ 升级到 v${this._serverVersion}`;
				upBtn.style.padding = '8px 22px';
				upBtn.style.fontSize = '13px';
				upBtn.style.fontWeight = '600';
				upBtn.style.border = 'none';
				upBtn.style.borderRadius = '6px';
				upBtn.style.cursor = 'pointer';
				upBtn.style.background = 'var(--vscode-button-background)';
				upBtn.style.color = 'var(--vscode-button-foreground)';
				upBtn.onclick = () => { void this._install(); };
				wrap.appendChild(upBtn);
			} else {
				// Already latest — show version badge
				const badge = $('span');
				badge.textContent = `✓ v${this._localVersion || '?'}`;
				badge.style.padding = '8px 14px';
				badge.style.fontSize = '13px';
				badge.style.fontWeight = '600';
				badge.style.background = 'rgba(78, 201, 176, 0.15)';
				badge.style.color = '#4ec9b0';
				badge.style.borderRadius = '6px';
				wrap.appendChild(badge);
			}

			// Delete button (always shown when installed)
			const delBtn = $('button') as HTMLButtonElement;
			delBtn.textContent = '🗑 删除';
			delBtn.style.padding = '8px 22px';
			delBtn.style.fontSize = '13px';
			delBtn.style.fontWeight = '600';
			delBtn.style.border = '1px solid var(--vscode-inputValidation-errorBorder, #be1100)';
			delBtn.style.borderRadius = '6px';
			delBtn.style.cursor = 'pointer';
			delBtn.style.background = 'var(--vscode-inputValidation-errorBackground, #5a1d1d)';
			delBtn.style.color = 'var(--vscode-errorForeground, #f48771)';
			delBtn.onclick = () => { void this._uninstall(); };
			wrap.appendChild(delBtn);
		}

		return wrap;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS
	// ══════════════════════════════════════════════════════════════════════════

	private async _install(): Promise<void> {
		if (!this._marketSlug || this._installing) { return; }
		this._installing = true;
		this._render();

		try {
			const version = this._serverVersion || 'latest';
			console.log('[McpDetail] Installing MCP:', this._marketSlug, version);
			const result = await this.marketplaceService.download(this._marketSlug, version, 'mcp');

			// Sync to VS Code MCP config
			await this._syncToVsCodeConfig(this._marketSlug);

			this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(this._marketSlug) });
			console.log('[McpDetail] Installed:', this._marketSlug, result.version);
		} catch (err) {
			console.error('[McpDetail] Install failed:', err);
		} finally {
			this._installing = false;
			await this._refreshInstallState();
			this._render();
		}
	}

	/**
	 * 一键"自动安装并配置"（内置 pip 型 MCP，如 Comfy MCP）：
	 *  1. checkCommands 任一在 PATH → 视为已安装，跳过安装步骤；
	 *  2. 否则依次执行 install 命令（shell）；
	 *  3. 成功后将 preset 配置写入 MCP 注册（~/.vssaros/mcp.json）。
	 */
	private async _autoInstall(): Promise<void> {
		const model = this._model;
		if (!model?.autoInstall || !this._marketSlug || this._installing) { return; }
		this._installing = true;
		this._render();

		const log: string[] = [];
		try {
			// 1. check
			const present = await this._checkCommands(model.autoInstall.checkCommands);
			if (present) {
				log.push(`✓ 已检测到 ${model.autoInstall.checkCommands.join(' / ')}，跳过安装。`);
			} else {
				// 2. install
				for (const cmd of model.autoInstall.install) {
					log.push(`$ ${cmd}`);
					const res = await this._runShell(cmd);
					if (res.code !== 0) {
						throw new Error(`命令执行失败 (exit ${res.code}): ${cmd}\n${res.output.slice(-400)}`);
					}
					log.push(res.output.trim() || '(无输出)');
				}
			}

			// 2.5 ★ 解析 command / resolveEnv 的绝对路径（Windows pip Scripts 目录
			//   常不在 PATH → 相对命令名 spawn 会 ENOENT；MCP host 环境也不含 shell
			//   PATH → 需把 comfy 等依赖命令绝对路径注入 env）。
			const commandPath = await this._resolveCommandPath(model.command);
			if (commandPath && commandPath !== model.command) {
				log.push(`✓ 已解析命令路径: ${commandPath}`);
			}
			const env: Record<string, string> = {};
			if (model.resolveEnv) {
				for (const [envVar, cmdName] of Object.entries(model.resolveEnv)) {
					const p = await this._resolveCommandPath(cmdName);
					if (p) {
						env[envVar] = p;
						log.push(`✓ 已解析 ${envVar}=${p}`);
					} else {
						log.push(`⚠ 未找到 ${cmdName} 绝对路径（${envVar} 未设置，依赖 PATH）`);
					}
				}
			}

			// 3. register to ~/.vssaros/mcp.json via MCP management service
			await this._syncToVsCodeConfigDirect(this._marketSlug, model, { commandPath, env });
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(this._marketSlug) });
			log.push('✓ 已写入 MCP 服务器配置。重启应用后生效。');
		} catch (err) {
			log.push(`✗ ${(err as Error).message}`);
		} finally {
			this._installing = false;
			await this._refreshInstallState();
			this._render();
			this._showAutoInstallResult(log.join('\n'));
		}
	}

	/** 任一命令存在即返回 true（win 用 where.exe，其余用 which）。 */
	private async _checkCommands(commands: readonly string[]): Promise<boolean> {
		for (const cmd of commands) {
			const p = await this._resolveCommandPath(cmd);
			if (p) { return true; }
		}
		return false;
	}

	/**
	 * 解析命令的绝对路径。Windows 用 `where.exe`（注意：不能用 `where`——那是
	 * PowerShell 的 Where-Object 别名），其余平台用 `which`。
	 * 返回绝对路径；找不到返回 undefined（调用方降级为原命令名 / 跳过 env）。
	 */
	private async _resolveCommandPath(command: string): Promise<string | undefined> {
		const isWin = typeof process !== 'undefined' && process.platform === 'win32';
		// where.exe / which 查找 PATH 中的可执行文件
		const finder = isWin ? 'where.exe' : 'which';
		try {
			const res = await this._runShell(`${finder} ${command}`);
			if (res.code === 0) {
				const firstLine = res.output.split('\n').map(s => s.trim()).find(Boolean);
				if (firstLine && !firstLine.toLowerCase().includes('could not find') && !firstLine.toLowerCase().includes('not found')) {
					return firstLine;
				}
			}
		} catch { /* 降级 */ }
		// ★ 兜底：pip 安装的 CLI 在 Python Scripts 目录，`where.exe` 找不到时
		//   用 python 探测 Scripts 目录拼 `<command>.exe`（Windows）。
		if (isWin) {
			try {
				const py = await this._runShell(
					`python -c "import sysconfig, os; print(os.path.join(sysconfig.get_path('scripts'), '${command}.exe'))"`,
				);
				if (py.code === 0) {
					const p = py.output.split('\n').map(s => s.trim()).find(Boolean);
					if (p && p.endsWith('.exe')) { return p; }
				}
			} catch { /* 降级 */ }
		}
		return undefined;
	}

	/**
	 * 在 shell 中执行一条命令，返回退出码与合并输出。
	 * 走主进程 terminal (pty)（复用 coreTools 的 executeTerminalCommand 模式）——
	 * editor pane 运行在 renderer 沙箱，`require('child_process')` 不可用
	 * （返回 undefined → "Cannot read properties of undefined (reading 'spawn')"）。
	 */
	private _runShell(command: string): Promise<{ code: number; output: string }> {
		return new Promise((resolve, reject) => {
			void (async () => {
				let instance: ITerminalInstance | undefined;
				try {
					instance = await this.terminalService.createTerminal({
						config: {
							type: 'Task',
							name: `MCP 安装: ${command.slice(0, 30)}`,
							isFeatureTerminal: true,
							hideFromUser: true,
						},
					});
					if (!instance) {
						reject(new Error('无法创建终端实例'));
						return;
					}

					// 等待 pty 就绪（PowerShell profile 加载 1.5–3s）后发送命令。
					try { await instance.processReady; } catch { /* 忽略 */ }
					await new Promise<void>((ok) => {
						const sub = instance!.onData(() => { sub.dispose(); ok(); });
						setTimeout(() => { sub.dispose(); ok(); }, 6000);
					});

					// 追加退出码标记，用于判定成败（VsSaros 默认 shell 为 PowerShell）。
					const exitMarker = 'SAROS_MCP_EXIT';
					const cmdWithMarker = `${command}; echo "${exitMarker}=$LASTEXITCODE"`;

					const chunks: string[] = [];
					const clean = (d: string) => d
						.replace(/\x1b\[[0-9;:?]*[a-zA-Z]/g, '')
						.replace(/\x1b\][^\x07]*\x07/g, '')
						.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
						.replace(/\r\n/g, '\n')
						.replace(/\r/g, '\n');

					let idle: ReturnType<typeof setTimeout>;
					let hardCap: ReturnType<typeof setTimeout>;
					let dataSub: IDisposable | undefined;
					let exitSub: IDisposable | undefined;
					let settled = false;

					const settle = (code: number) => {
						if (settled) { return; }
						settled = true;
						clearTimeout(idle); clearTimeout(hardCap);
						dataSub?.dispose(); exitSub?.dispose();
						const raw = chunks.join('');
						const m = raw.match(new RegExp(`${exitMarker}=(\\d+)`));
						const resolvedCode = m ? Number(m[1]) : code;
						const output = raw.replace(new RegExp(`${exitMarker}=\\d+`, 'g'), '').trim();
						resolve({ code: resolvedCode, output });
					};

					const markIdle = () => {
						clearTimeout(idle);
						idle = setTimeout(() => settle(0), 1500);
					};

					dataSub = instance.onData((data: string) => { chunks.push(clean(data)); markIdle(); });
					exitSub = instance.onExit((e: number | ITerminalLaunchError | undefined) => {
						settle(typeof e === 'number' ? e : -1);
					});
					// 总超时兜底（pip 安装可能较久，给 5 分钟）。
					hardCap = setTimeout(() => settle(-1), 5 * 60 * 1000);
					markIdle();

					await instance.sendText(cmdWithMarker, true);
				} catch (e) {
					reject(e as Error);
				}
			})();
		});
	}

	/** 将内置 preset 的服务器配置直接写入 MCP 注册（不走 marketplace 下载）。 */
	private async _syncToVsCodeConfigDirect(
		slug: string,
		model: IMcpDetailModel,
		extra?: { commandPath?: string; env?: Record<string, string> },
	): Promise<void> {
		const config = buildInstallableConfig(model, extra);
		const installable: IInstallableMcpServer = { name: slug, config };
		await this.mcpManagementService.install(installable);
	}

	/** 展示自动安装结果（成功→通知，失败→对话框）。 */
	private _showAutoInstallResult(log: string): void {
		const failed = log.includes('✗') || log.includes('失败');
		// detail pane 没有 notificationService —— 用 console + 渲染一个结果条。
		console.log(`[McpDetail] auto-install ${failed ? 'failed' : 'ok'}:\n${log}`);
		this._lastAutoInstallLog = log;
		this._autoInstallFailed = failed;
		this._render();
	}

	private _lastAutoInstallLog: string | undefined;
	private _autoInstallFailed = false;

	private async _uninstall(): Promise<void> {
		if (!this._marketSlug) { return; }
		// Built-in auto-install type (Comfy MCP): no marketplace package — only
		// remove the MCP registration from ~/.vssaros/mcp.json.
		if (this._model?.autoInstall) {
			try {
				console.log('[McpDetail] Uninstalling built-in MCP:', this._marketSlug);
				const installed = await this.mcpManagementService.getInstalled();
				const match = installed.find(s => s.name === this._marketSlug || sanitize(s.name) === sanitize(this._marketSlug!));
				if (match) { await this.mcpManagementService.uninstall(match); }
				this._lastAutoInstallLog = `已移除 MCP 服务器 "${this._marketSlug}" 配置。`;
				this._autoInstallFailed = false;
			} catch (e) {
				this._lastAutoInstallLog = `移除失败: ${(e as Error).message}`;
				this._autoInstallFailed = true;
			}
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(this._marketSlug) });
			this._installing = false;
			await this._refreshInstallState();
			this._render();
			return;
		}
		try {
			console.log('[McpDetail] Uninstalling MCP:', this._marketSlug);
			// 1. Uninstall from marketplace (removes ~/.vssaros/mcp/{slug}/ + installed-packages.json)
			await this.marketplaceService.uninstall(this._marketSlug, 'mcp');

			// 2. Remove from ~/.vssaros/mcp.json
			await this._removeFromMcpJson(this._marketSlug);

			// 3. Uninstall from VS Code MCP config
			try {
				const installed = await this.mcpManagementService.getInstalled();
				const match = installed.find(s => s.name === this._marketSlug || sanitize(s.name) === sanitize(this._marketSlug!));
				if (match) {
					await this.mcpManagementService.uninstall(match);
				}
			} catch (e) {
				console.warn('[McpDetail] VS Code config uninstall failed (non-fatal):', e);
			}

			this.eventBridgeService.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(this._marketSlug) });
			console.log('[McpDetail] Uninstalled:', this._marketSlug);
		} catch (err) {
			console.error('[McpDetail] Uninstall failed:', err);
		} finally {
			await this._refreshInstallState();
			this._render();
		}
	}

	/** Sync MCP config from ~/.vssaros/mcp/{slug}/config.json to VS Code MCP config */
	private async _syncToVsCodeConfig(slug: string): Promise<void> {
		try {
			const configUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcp, slug, 'config.json');
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
		} catch (e) {
			console.warn('[McpDetail] Failed to sync to VS Code config (non-fatal):', e);
		}
	}

	/** Remove a server entry from ~/.vssaros/mcp.json */
	private async _removeFromMcpJson(slug: string): Promise<void> {
		try {
			const mcpJsonUri = resolveSarosPath(this._getSarosRoot(), SarosPath.mcpConfig);
			if (!await this.fileService.exists(mcpJsonUri)) { return; }
			const content = await this.fileService.readFile(mcpJsonUri);
			const data = JSON.parse(content.value.toString());
			if (data.servers && slug in data.servers) {
				delete data.servers[slug];
				const VSBuffer = (await import('../../../../base/common/buffer.js')).VSBuffer;
				await this.fileService.writeFile(mcpJsonUri, VSBuffer.fromString(JSON.stringify(data, null, 2)));
			}
		} catch (e) {
			console.warn('[McpDetail] Failed to remove from mcp.json (non-fatal):', e);
		}
	}

	private _getSarosRoot(): URI {
		return userDataRootFromRoamingHome(this.environmentService.userRoamingDataHome);
	}
}
