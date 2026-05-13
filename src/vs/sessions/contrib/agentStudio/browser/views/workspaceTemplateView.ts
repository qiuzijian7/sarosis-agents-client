/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

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
import { IWorkspaceTemplateService, ITemplateMetadata, TemplateType, ApplyStrategy, CaptureContentType } from '../../common/workspaceTemplate.js';
import { URI } from '../../../../../base/common/uri.js';
import { $ } from '../../../../../base/browser/dom.js';

// ------------------------------------------------------------------------------------
// Workspace Template 视图面板
// ------------------------------------------------------------------------------------

export class WorkspaceTemplateViewPane extends ViewPane {

	private _templatesContainer!: HTMLElement;
	private _templates: ITemplateMetadata[] = [];
	private _selectedTemplateId: string | null = null;

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
		@IWorkspaceTemplateService private readonly _templateService: IWorkspaceTemplateService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('workspace-template-view');

		// 创建整体布局
		const layout = $('div.workspace-template-layout');
		container.appendChild(layout);

		// 工具栏
		const toolbar = $('div.template-toolbar');
		
		const createBtn = $('button.template-action-btn');
		createBtn.textContent = '+ New Template';
		createBtn.onclick = () => this._createTemplate();
		toolbar.appendChild(createBtn);

		const refreshBtn = $('button.template-action-btn');
		refreshBtn.textContent = '🔄 Refresh';
		refreshBtn.onclick = () => this._loadTemplates();
		toolbar.appendChild(refreshBtn);

		layout.appendChild(toolbar);

		// 模板列表
		const listSection = $('div.section');
		const listTitle = $('div.section-title');
		listTitle.textContent = 'Templates';
		listSection.appendChild(listTitle);

		this._templatesContainer = $('div.templates-container');
		listSection.appendChild(this._templatesContainer);
		layout.appendChild(listSection);

		// 加载数据
		this._loadTemplates();
	}

	private async _loadTemplates(): Promise<void> {
		try {
			this._templates = await this._templateService.listTemplates();
			this._renderTemplates();
		} catch (error) {
			// 使用 DOM API 替代 innerHTML，避免 TrustedHTML CSP 阻塞
			this._templatesContainer.replaceChildren();
			const errorDiv = $('div.error');
			errorDiv.textContent = 'Failed to load templates';
			this._templatesContainer.appendChild(errorDiv);
		}
	}

	private _renderTemplates(): void {
		this._templatesContainer.replaceChildren();

		if (this._templates.length === 0) {
			const emptyDiv = $('div.empty-message');
			emptyDiv.textContent = 'No templates yet. Create one!';
			this._templatesContainer.appendChild(emptyDiv);
			return;
		}

		for (const template of this._templates) {
			const card = $('div.template-card');
			card.classList.toggle('selected', this._selectedTemplateId === template.id);
			card.onclick = () => this._selectTemplate(template.id);

			// 模板信息
			const info = $('div.template-info');
			
			const name = $('div.template-name');
			name.textContent = template.name;
			info.appendChild(name);

			const description = $('div.template-description');
			description.textContent = template.description;
			info.appendChild(description);

			const meta = $('div.template-meta');
			// 使用 DOM API 替代 innerHTML，避免 TrustedHTML CSP 阻塞
			const typeSpan = $('span');
			typeSpan.textContent = `Type: ${template.type}`;
			meta.appendChild(typeSpan);
			const scopeSpan = $('span');
			scopeSpan.textContent = `Scope: ${template.scope}`;
			meta.appendChild(scopeSpan);
			const sizeSpan = $('span');
			sizeSpan.textContent = `Size: ${this._formatSize(template.size)}`;
			meta.appendChild(sizeSpan);
			const appliedSpan = $('span');
			appliedSpan.textContent = `Applied: ${template.applyCount} times`;
			meta.appendChild(appliedSpan);
			info.appendChild(meta);

			card.appendChild(info);

			// 操作按钮
			const actions = $('div.template-actions');
			
			const applyBtn = $('button.template-action-small');
			applyBtn.textContent = 'Apply';
			applyBtn.onclick = (e) => { e.stopPropagation(); this._applyTemplate(template.id); };
			actions.appendChild(applyBtn);

			const deleteBtn = $('button.template-action-small danger');
			deleteBtn.textContent = 'Delete';
			deleteBtn.onclick = (e) => { e.stopPropagation(); this._deleteTemplate(template.id); };
			actions.appendChild(deleteBtn);

			card.appendChild(actions);

			this._templatesContainer.appendChild(card);
		}
	}

	private _selectTemplate(templateId: string): void {
		this._selectedTemplateId = templateId;
		this._renderTemplates();
		
		// TODO: 显示模板详情
	}

	private async _createTemplate(): Promise<void> {
		try {
			// TODO: 打开对话框收集模板信息
			const name = prompt('Enter template name:');
			if (!name) {
				return;
			}

			const description = prompt('Enter template description:') || '';
			
			await this._templateService.createTemplate(
				name,
				description,
				TemplateType.Project,
			);

			this._loadTemplates();
		} catch (error) {
			console.error('Failed to create template:', error);
		}
	}

	private async _applyTemplate(templateId: string): Promise<void> {
		try {
			// TODO: 选择目标工作区
			const targetWorkspace = URI.file('/tmp/test'); // 示例
			
			await this._templateService.applyTemplate(templateId, {
				targetWorkspace,
				strategy: ApplyStrategy.Overwrite,
				contentTypes: [CaptureContentType.Files, CaptureContentType.Layout, CaptureContentType.Environment],
				applyEnvironment: true,
				restoreTerminal: true,
				restoreLayout: true,
			});

			alert('Template applied successfully!');
		} catch (error) {
			console.error('Failed to apply template:', error);
		}
	}

	private async _deleteTemplate(templateId: string): Promise<void> {
		try {
			const confirmed = confirm('Are you sure you want to delete this template?');
			if (!confirmed) {
				return;
			}

			await this._templateService.deleteTemplate(templateId);
			this._loadTemplates();
		} catch (error) {
			console.error('Failed to delete template:', error);
		}
	}

	private _formatSize(bytes: number): string {
		if (bytes < 1024) {
			return `${bytes} B`;
		} else if (bytes < 1024 * 1024) {
			return `${(bytes / 1024).toFixed(1)} KB`;
		} else {
			return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
		}
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		// 可以在这里调整布局
	}
}
