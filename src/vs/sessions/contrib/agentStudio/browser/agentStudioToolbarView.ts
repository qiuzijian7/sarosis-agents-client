/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from '../../../../workbench/browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../../workbench/common/views.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';

/**
 * Agent Studio Toolbar View - renders the content for each toolbar icon.
 * Each icon in the Activity Bar opens a Sidebar panel with this view.
 */
export class AgentStudioToolbarView extends ViewPane {

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
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	getId(): string {
		return this.id;
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('agent-studio-toolbar-view');
		const viewId = this.id;
		const content = this._createContent(viewId);
		container.appendChild(content);
	}

	private _createContent(viewId: string): HTMLElement {
		const content = document.createElement('div');
		content.className = 'agent-studio-toolbar-content';
		content.style.padding = '12px';
		content.style.color = 'var(--vscode-foreground)';

		const viewTitles: { [key: string]: string } = {
			'agentStudio.clawChatView': 'Claw Chat',
			'agentStudio.workspaceView': 'Workspace',
			'agentStudio.presetAgentView': 'Preset Agent',
			'agentStudio.skillsView': 'Skills',
			'agentStudio.tasksView': 'Tasks',
			'agentStudio.scheduleView': 'Schedule',
			'agentStudio.toolsView': 'Tools',
			'agentStudio.changesView': 'Changes',
			'agentStudio.searchView': 'Search',
			'agentStudio.pluginsView': 'Plugins',
			'agentStudio.personalView': 'Personal',
			'agentStudio.settingsView': 'Settings',
		};

		const title = viewTitles[viewId] || 'Unknown';

		const header = document.createElement('h3');
		header.textContent = title;
		header.style.margin = '0 0 12px 0';
		header.style.color = 'var(--vscode-editor-foreground)';
		content.appendChild(header);

		const placeholder = document.createElement('div');
		placeholder.style.color = 'var(--vscode-descriptionForeground)';
		placeholder.textContent = `${title} content will be displayed here.`;
		content.appendChild(placeholder);

		return content;
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		const content = this.element?.querySelector('.agent-studio-toolbar-content');
		if (content) {
			(content as HTMLElement).style.width = `${width}px`;
		}
	}
}
