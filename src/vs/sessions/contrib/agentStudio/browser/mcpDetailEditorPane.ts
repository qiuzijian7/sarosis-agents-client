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
import { Dimension } from '../../../../base/browser/dom.js';
import { autorun } from '../../../../base/common/observable.js';
import { timeout } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { renderMarkdown } from '../../../../base/browser/markdownRenderer.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { McpDetailEditorInput } from './mcpDetailEditorInput.js';
import { IEventBridgeService } from '../common/eventBridge.js';
import { IMcpService } from '../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { startServerAndWaitForLiveTools } from '../../../../workbench/contrib/mcp/common/mcpTypesUtils.js';
import { IWorkbenchMcpManagementService } from '../../../../workbench/services/mcp/common/mcpWorkbenchManagementService.js';
import { IInstallableMcpServer } from '../../../../platform/mcp/common/mcpManagement.js';
import { IMcpServerConfiguration, McpServerType } from '../../../../platform/mcp/common/mcpPlatformTypes.js';
import { KNOT_MCP_MARKET, IKnotMcpMarketItem } from '../common/bundled-tools/knotMcpMarket.js';
import { BUNDLED_MCP_PRESETS } from '../common/bundled-tools/bundledMcpPresets.js';

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

/** Resolve a detail model by market id, from knot market first then bundled presets. */
export function resolveMcpDetailModel(marketId: string): IMcpDetailModel | undefined {
	const knot: IKnotMcpMarketItem | undefined = KNOT_MCP_MARKET.find(k => k.id === marketId);
	if (knot) {
		return {
			id: knot.id,
			name: knot.name,
			displayName: knot.displayName || knot.name,
			description: knot.description,
			useGuide: knot.useGuide,
			toolsDescription: knot.toolsDescription,
			icon: knot.icon,
			type: knot.type,
			creator: knot.creator,
			transportType: knot.transportType,
			url: knot.url,
			command: knot.command,
			args: knot.args,
			headers: knot.headers,
			tags: knot.tags ?? [],
		};
	}
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

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IEventBridgeService private readonly eventBridgeService: IEventBridgeService,
		@IMcpService private readonly mcpService: IMcpService,
		@IWorkbenchMcpManagementService private readonly mcpManagementService: IWorkbenchMcpManagementService,
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

		this._model = resolveMcpDetailModel(input.marketId);
		await this._refreshInstalledState();
		this._render();
	}

	override layout(dimension: Dimension): void {
		this._container.style.width = `${dimension.width}px`;
		this._container.style.height = `${dimension.height}px`;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  INSTALL STATE
	// ══════════════════════════════════════════════════════════════════════════

	private async _refreshInstalledState(): Promise<void> {
		this._installed = false;
		if (!this._model) { return; }
		try {
			const installed = await this.mcpManagementService.getInstalled();
			const norm = sanitize(this._model.name);
			this._installed = installed.some(s => s.name === this._model!.name || sanitize(s.name) === norm);
		} catch { /* ignore */ }
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  RENDER
	// ══════════════════════════════════════════════════════════════════════════

	private _render(): void {
		clearNode(this._container);

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

		const btn = $('button') as HTMLButtonElement;
		btn.style.padding = '8px 22px';
		btn.style.fontSize = '13px';
		btn.style.fontWeight = '600';
		btn.style.border = 'none';
		btn.style.borderRadius = '6px';
		btn.style.cursor = 'pointer';
		btn.style.whiteSpace = 'nowrap';

		if (this._installing) {
			btn.textContent = '⏳ 安装中...';
			btn.disabled = true;
			btn.style.background = 'var(--vscode-button-secondaryBackground)';
			btn.style.color = 'var(--vscode-button-secondaryForeground)';
		} else if (this._installed) {
			btn.textContent = '🗑 删除';
			btn.style.background = 'var(--vscode-inputValidation-errorBackground, #5a1d1d)';
			btn.style.color = 'var(--vscode-errorForeground, #f48771)';
			btn.style.border = '1px solid var(--vscode-inputValidation-errorBorder, #be1100)';
			btn.onclick = () => { void this._uninstall(); };
		} else {
			btn.textContent = '⬇ 安装';
			btn.style.background = 'var(--vscode-button-background)';
			btn.style.color = 'var(--vscode-button-foreground)';
			btn.onclick = () => { void this._install(); };
		}

		wrap.appendChild(btn);
		return wrap;
	}

	// ══════════════════════════════════════════════════════════════════════════
	//  ACTIONS
	// ══════════════════════════════════════════════════════════════════════════

	private async _install(): Promise<void> {
		if (!this._model || this._installing) { return; }
		const model = this._model;
		this._installing = true;
		this._render();

		try {
			const config = buildInstallableConfig(model);
			const installable: IInstallableMcpServer = { name: model.name, config };
			console.log('[McpDetail] Installing MCP server:', model.name);
			await this.mcpManagementService.install(installable);

			// Wait for IMcpService to discover & create the live server instance
			const server = await this._waitForMcpServer(model.name, 10000);
			if (server) {
				await startServerAndWaitForLiveTools(server, { promptType: 'all-untrusted', autoTrustChanges: true });
				console.log('[McpDetail] Server started:', model.name);
			} else {
				console.warn('[McpDetail] Server not discovered after install:', model.name);
			}
			this._installed = true;
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(model.name) });
		} catch (err) {
			console.error('[McpDetail] Install failed:', err);
		} finally {
			this._installing = false;
			await this._refreshInstalledState();
			this._render();
		}
	}

	private async _uninstall(): Promise<void> {
		if (!this._model) { return; }
		const model = this._model;
		try {
			const installed = await this.mcpManagementService.getInstalled();
			const norm = sanitize(model.name);
			const match = installed.find(s => s.name === model.name || sanitize(s.name) === norm);
			if (match) {
				await this.mcpManagementService.uninstall(match);
				console.log('[McpDetail] Uninstalled:', match.name);
			}
			this.eventBridgeService.emit('mcp:servers-changed', { action: 'remove', serverId: norm });
		} catch (err) {
			console.error('[McpDetail] Uninstall failed:', err);
		} finally {
			await this._refreshInstalledState();
			this._render();
		}
	}

	private async _waitForMcpServer(presetName: string, maxWaitMs: number): Promise<any> {
		const startTime = Date.now();
		while (Date.now() - startTime < maxWaitMs) {
			let found: any = undefined;
			const d = autorun(reader => {
				const currentServers = this.mcpService.servers.read(reader);
				for (const s of currentServers) {
					const defId = s.definition?.id ?? '';
					const label = s.definition?.label ?? '';
					if (label === presetName || defId === presetName || defId.endsWith('.' + presetName)) {
						found = s;
					}
				}
			});
			d.dispose();
			if (found) { return found; }
			await timeout(300);
		}
		return undefined;
	}
}
