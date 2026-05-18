/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/channelView.css';

import { IViewPaneOptions, ViewPane } from '../../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { $ } from '../../../../../base/browser/dom.js';
import { CHANNEL_DEFINITIONS, IChannelDefinition } from '../../common/constants.js';
import { ChannelEditorInput } from '../channelEditorInput.js';
import { IEditorService, SIDE_GROUP } from '../../../../../workbench/services/editor/common/editorService.js';
import { IEditorGroupsService } from '../../../../../workbench/services/editor/common/editorGroupsService.js';

export class ChannelViewPane extends ViewPane {

	private _body: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService override readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = container;
		this._body.classList.add('channel-view');
		this._renderChannelList();
	}

	private _renderChannelList(): void {
		if (!this._body) {
			return;
		}
		this._body.replaceChildren();

		// ─── Header ──────────────────────────────────────
		const header = $('div.channel-view-header');
		const titleRow = $('div.channel-view-title-row');
		const title = $('h3.channel-view-title');
		title.textContent = '📡 渠道管理';
		titleRow.appendChild(title);
		const countEl = $('span.channel-view-count');
		const enabledCount = CHANNEL_DEFINITIONS.filter(d => {
			const enabledKey = d.configFields.find(f => f.key.endsWith('.enabled'));
			return enabledKey && this.configurationService.getValue<boolean>(enabledKey.key);
		}).length;
		countEl.textContent = `${enabledCount}/${CHANNEL_DEFINITIONS.length}`;
		titleRow.appendChild(countEl);
		header.appendChild(titleRow);
		this._body.appendChild(header);

		// ─── Channel List ────────────────────────────────
		const list = $('div.channel-list');

		for (const def of CHANNEL_DEFINITIONS) {
			const item = this._renderChannelItem(def);
			list.appendChild(item);
		}

		this._body.appendChild(list);
	}

	private _renderChannelItem(def: IChannelDefinition): HTMLElement {
		const item = document.createElement('button');
		item.className = 'channel-item';
		item.type = 'button';

		// Check enabled status
		const enabledField = def.configFields.find(f => f.key.endsWith('.enabled'));
		const enabled = enabledField ? (this.configurationService.getValue<boolean>(enabledField.key) ?? false) : false;
		if (enabled) {
			item.classList.add('channel-item-enabled');
		}

		// Icon
		const icon = $('span.channel-item-icon');
		icon.textContent = def.icon;
		item.appendChild(icon);

		// Info
		const info = $('div.channel-item-info');
		const name = $('span.channel-item-name');
		name.textContent = def.label;
		info.appendChild(name);
		const desc = $('span.channel-item-desc');
		desc.textContent = def.description;
		info.appendChild(desc);
		item.appendChild(info);

		// Status dot
		const statusDot = $('span.channel-item-status');
		statusDot.classList.add(enabled ? 'active' : 'inactive');
		item.appendChild(statusDot);

		// Chevron
		const chevron = $('span.channel-item-chevron');
		chevron.textContent = '›';
		item.appendChild(chevron);

		// Click handler: open channel config in editor area
		item.onclick = () => this._openChannelConfig(def);

		return item;
	}

	private _openChannelConfig(def: IChannelDefinition): void {
		const input = ChannelEditorInput.getOrCreate(def.key);
		const groups = this.editorGroupsService.getGroups(0 /* GroupsOrder.CREATION_TIME */);
		if (groups.length <= 1) {
			this.editorService.openEditor(input, { pinned: true }, SIDE_GROUP);
		} else {
			this.editorService.openEditor(input, { pinned: true }, groups[0]);
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
	}
}
