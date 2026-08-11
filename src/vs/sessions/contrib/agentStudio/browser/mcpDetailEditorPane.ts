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
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { BUNDLED_MCP_PRESETS } from '../common/bundled-tools/bundledMcpPresets.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarketplaceService } from '../common/marketplace.js';
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
}

const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** Resolve a detail model by market id, from bundled presets (synchronous). */
export function resolveMcpDetailModel(marketId: string): IMcpDetailModel | undefined {
	const preset = BUNDLED_MCP_PRESETS.find(p => p.id === marketId);
	if (preset) {
		return {
			id: preset.id,
			name: preset.id,
			displayName: preset.name,
			description: preset.description,
			useGuide: '',
			toolsDescription: '',
			icon: '',
			type: 'builtin',
			creator: '',
			transportType: preset.transportType === 'http' ? 'http' : 'stdio',
			url: preset.url ?? '',
			command: preset.command ?? '',
			args: preset.args,
			headers: preset.headers ? { ...preset.headers } : undefined,
			tags: preset.envKeys ? preset.envKeys.map(k => k) : [],
		};
	}
	return undefined;
}

/** Build an installable config from a detail model. */
export function buildInstallableConfig(model: IMcpDetailModel): IMcpServerConfiguration {
	const isRemote = model.transportType !== 'stdio' && (model.url?.length > 0);
	if (isRemote) {
		return {
			type: McpServerType.REMOTE,
			url: model.url,
			...(model.headers ? { headers: { ...model.headers } } : {}),
		};
	}
	return {
		type: McpServerType.LOCAL,
		command: model.command,
		...(model.args ? { args: [...model.args] } : {}),
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
		// 2. Fallback: read from ~/.vssaros/saros/mcp/{marketId}/config.json
		if (!this._model) {
			this._model = await this._resolveMcpDetailModelFromDisk(input.marketId);
		}
		this._marketSlug = input.marketId;
		await this._refreshInstallState();
		this._render();
	}

	/** Read MCP config from ~/.vssaros/saros/mcp/{marketId}/config.json and build a detail model. */
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
			const img = $('img') as HTMLImageElement;
			img.src = model.icon;
			img.style.width = '100%';
			img.style.height = '100%';
			img.style.objectFit = 'cover';
			img.onerror = () => { iconBox.textContent = '\u{1F50C}'; iconBox.style.fontSize = '28px'; };
			iconBox.appendChild(img);
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
			: model.type === 'knot' ? 'Knot'
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

	private async _uninstall(): Promise<void> {
		if (!this._marketSlug) { return; }
		try {
			console.log('[McpDetail] Uninstalling MCP:', this._marketSlug);
			// 1. Uninstall from marketplace (removes ~/.vssaros/saros/mcp/{slug}/ + installed-packages.json)
			await this.marketplaceService.uninstall(this._marketSlug, 'mcp');

			// 2. Remove from ~/.vssaros/saros/mcp.json
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

	/** Sync MCP config from ~/.vssaros/saros/mcp/{slug}/config.json to VS Code MCP config */
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

	/** Remove a server entry from ~/.vssaros/saros/mcp.json */
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
