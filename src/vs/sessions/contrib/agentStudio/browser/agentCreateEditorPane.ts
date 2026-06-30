/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentCreateEditorPane.css';

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { EditorPane } from '../../../../workbench/browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../../workbench/common/editor.js';
import { EditorInput } from '../../../../workbench/common/editor/editorInput.js';
import { IEditorGroup } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import * as DOM from '../../../../base/browser/dom.js';
import { IAgentStudioService } from '../common/agentStudio.js';
import type { Agent } from '../../../common/agentStudioTypes.js';
import { AgentCreateEditorInput } from './agentCreateEditorInput.js';
import { AgentSettingsEditorInput } from './agentSettingsEditorInput.js';

const { $: $$ } = DOM;

const ICON_OPTIONS = [
	'🤖', '👨‍💻', '🔬', '✍️', '🎨', '📋', '🧪', '🚀', '📊', '🦞', '📚', '🧠',
	'🔧', '⚙️', '🏗️', '🐛', '🔍', '💡', '🎯', '🤝', '📝', '🌐', '☁️', '🔒',
	'🎮', '🎵', '📷', '🎤', '🧩', '⚡', '🌟', '🔥', '💎', '🎪', '🏆', '🛠️',
];

const CATEGORY_OPTIONS = ['Development', 'Research', 'Creative', 'Management', 'DevOps', 'Analytics'];

/**
 * EditorPane for creating a new custom Agent.
 *
 * Renders a form-based DOM layout (no webview) with:
 *   - Basic info: name, role, description, category, icon
 *   - System prompt textarea
 *   - Live preview card
 *   - Create / Cancel actions
 */
export class AgentCreateEditorPane extends EditorPane {

	static readonly ID = 'workbench.editor.agentCreate';

	private _container: HTMLElement | undefined;
	private _nameInput: HTMLInputElement | undefined;
	private _slugInput: HTMLInputElement | undefined;
	private _roleInput: HTMLInputElement | undefined;
	private _descTextarea: HTMLTextAreaElement | undefined;
	private _categorySelect: HTMLSelectElement | undefined;
	private _promptTextarea: HTMLTextAreaElement | undefined;
	private _previewIcon: HTMLElement | undefined;
	private _previewName: HTMLElement | undefined;
	private _previewSlug: HTMLElement | undefined;
	private _previewRole: HTMLElement | undefined;
	private _selectedIcon: string = '🤖';
	private _createBtn: HTMLButtonElement | undefined;
	private _nameError: HTMLElement | undefined;
	private _slugError: HTMLElement | undefined;
	/** Tracks whether the user has manually edited the slug (to stop auto-sync). */
	private _slugEdited: boolean = false;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IAgentStudioService private readonly agentStudioService: IAgentStudioService,
		@INotificationService private readonly notificationService: INotificationService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(AgentCreateEditorPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this._container = $$('div.agent-create-editor');
		parent.appendChild(this._container);
	}

	override async setInput(
		input: EditorInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (!(input instanceof AgentCreateEditorInput) || !this._container) {
			return;
		}
		this._buildUI(this._container);
	}

	private _buildUI(container: HTMLElement): void {
		container.replaceChildren();

		// ── Header ──
		const header = $$('div.create-header');
		const headerIcon = $$('div.create-header-icon');
		headerIcon.textContent = '✏️';
		header.appendChild(headerIcon);
		const headerText = $$('div');
		const headerTitle = $$('div.create-header-title');
		headerTitle.textContent = '创建自定义 Agent';
		headerText.appendChild(headerTitle);
		const headerDesc = $$('div.create-header-desc');
		headerDesc.textContent = '配置 Agent 的基本信息和系统提示词，创建后可在 Agent 预设中使用';
		headerText.appendChild(headerDesc);
		header.appendChild(headerText);
		container.appendChild(header);

		// ── Form body ──
		const body = $$('div.create-form-body');

		// Section: Basic Info
		const section1 = $$('div.create-form-section');
		const title1 = $$('div.create-form-section-title');
		title1.textContent = '基本信息';
		section1.appendChild(title1);

		// Live preview card
		const preview = $$('div.create-preview-card');
		this._previewIcon = $$('div.create-preview-icon');
		this._previewIcon.textContent = this._selectedIcon;
		preview.appendChild(this._previewIcon);
		const previewInfo = $$('div.create-preview-info');
		this._previewName = $$('div.create-preview-name');
		this._previewName.textContent = 'My Agent';
		previewInfo.appendChild(this._previewName);
		this._previewSlug = $$('div.create-preview-slug');
		this._previewSlug.textContent = '@my-agent';
		previewInfo.appendChild(this._previewSlug);
		this._previewRole = $$('div.create-preview-role');
		this._previewRole.textContent = 'assistant';
		previewInfo.appendChild(this._previewRole);
		preview.appendChild(previewInfo);
		section1.appendChild(preview);

		// Name + Role
		const row1 = $$('div.create-form-row');
		const nameGroup = $$('div.create-form-group');
		const nameLabel = $$('label.create-form-label');
		nameLabel.textContent = '名称 *';
		nameGroup.appendChild(nameLabel);
		this._nameInput = document.createElement('input');
		this._nameInput.className = 'create-form-input';
		this._nameInput.type = 'text';
		this._nameInput.value = 'My Agent';
		this._nameInput.placeholder = '输入 Agent 名称';
		this._nameInput.oninput = () => {
			this._updatePreview();
			this._clearNameError();
			this._syncSlugFromName();
		};
		nameGroup.appendChild(this._nameInput);
		this._nameError = $$('div.create-form-error');
		this._nameError.style.display = 'none';
		nameGroup.appendChild(this._nameError);
		row1.appendChild(nameGroup);

		const roleGroup = $$('div.create-form-group create-form-group-half');
		const roleLabel = $$('label.create-form-label');
		roleLabel.textContent = '角色';
		roleGroup.appendChild(roleLabel);
		this._roleInput = document.createElement('input');
		this._roleInput.className = 'create-form-input';
		this._roleInput.type = 'text';
		this._roleInput.value = 'assistant';
		this._roleInput.placeholder = '如: Software Engineer';
		this._roleInput.oninput = () => this._updatePreview();
		roleGroup.appendChild(this._roleInput);
		row1.appendChild(roleGroup);
		section1.appendChild(row1);

		// Slug (unique identifier, used as agentId)
		const slugGroup = $$('div.create-form-group');
		const slugLabelRow = $$('div.create-slug-label-row');
		const slugLabel = $$('label.create-form-label');
		slugLabel.textContent = 'Slug *';
		slugLabelRow.appendChild(slugLabel);
		const slugHint = $$('span.create-form-hint');
		slugHint.textContent = '唯一标识符，用作 Agent ID';
		slugLabelRow.appendChild(slugHint);
		slugGroup.appendChild(slugLabelRow);
		this._slugInput = document.createElement('input');
		this._slugInput.className = 'create-form-input';
		this._slugInput.type = 'text';
		this._slugInput.value = 'my-agent';
		this._slugInput.placeholder = '输入唯一 slug（小写字母、数字、连字符、下划线）';
		this._slugInput.oninput = () => {
			this._slugEdited = true;
			this._updatePreview();
			this._clearSlugError();
		};
		slugGroup.appendChild(this._slugInput);
		this._slugError = $$('div.create-form-error');
		this._slugError.style.display = 'none';
		slugGroup.appendChild(this._slugError);
		section1.appendChild(slugGroup);

		// Description
		const descGroup = $$('div.create-form-group');
		const descLabel = $$('label.create-form-label');
		descLabel.textContent = '描述';
		descGroup.appendChild(descLabel);
		this._descTextarea = document.createElement('textarea');
		this._descTextarea.className = 'create-form-textarea';
		this._descTextarea.placeholder = 'Agent 的描述...';
		descGroup.appendChild(this._descTextarea);
		section1.appendChild(descGroup);

		// Category (full width, model removed)
		const catGroup = $$('div.create-form-group');
		const catLabel = $$('label.create-form-label');
		catLabel.textContent = '分类';
		catGroup.appendChild(catLabel);
		this._categorySelect = document.createElement('select');
		this._categorySelect.className = 'create-form-select';
		for (const c of CATEGORY_OPTIONS) {
			const opt = document.createElement('option');
			opt.value = c;
			opt.textContent = c;
			this._categorySelect.appendChild(opt);
		}
		catGroup.appendChild(this._categorySelect);
		section1.appendChild(catGroup);

		// Icon picker
		const iconGroup = $$('div.create-form-group');
		const iconLabel = $$('label.create-form-label');
		iconLabel.textContent = '图标';
		iconGroup.appendChild(iconLabel);
		const iconPicker = $$('div.create-icon-picker');
		for (const icon of ICON_OPTIONS) {
			const opt = $$('div.create-icon-option') as HTMLElement;
			opt.textContent = icon;
			if (icon === this._selectedIcon) { opt.classList.add('selected'); }
			opt.onclick = () => {
				this._selectedIcon = icon;
				iconPicker.querySelectorAll('.create-icon-option').forEach(el => el.classList.remove('selected'));
				opt.classList.add('selected');
				this._updatePreview();
			};
			iconPicker.appendChild(opt);
		}
		iconGroup.appendChild(iconPicker);
		section1.appendChild(iconGroup);

		body.appendChild(section1);

		// Section: System Prompt
		const section2 = $$('div.create-form-section');
		const title2 = $$('div.create-form-section-title');
		title2.textContent = '系统提示词';
		section2.appendChild(title2);
		this._promptTextarea = document.createElement('textarea');
		this._promptTextarea.className = 'create-form-textarea create-form-prompt';
		this._promptTextarea.placeholder = '输入 System Prompt...';
		this._promptTextarea.value = 'You are a helpful AI assistant. ';
		section2.appendChild(this._promptTextarea);
		body.appendChild(section2);

		container.appendChild(body);

		// ── Footer ──
		const footer = $$('div.create-form-footer');
		const cancelBtn = $$('button.create-btn') as HTMLButtonElement;
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = async () => {
			await this.editorService.closeEditor({ editor: AgentCreateEditorInput.getInstance(), groupId: this.group.id });
		};
		footer.appendChild(cancelBtn);

		this._createBtn = $$('button.create-btn create-btn-primary') as HTMLButtonElement;
		this._createBtn.textContent = '✓ 创建 Agent';
		this._createBtn.onclick = () => this._handleCreate();
		footer.appendChild(this._createBtn);
		container.appendChild(footer);

		// Initial preview update
		this._updatePreview();
	}

	private _updatePreview(): void {
		if (this._previewIcon) { this._previewIcon.textContent = this._selectedIcon; }
		if (this._previewName) { this._previewName.textContent = this._nameInput?.value || 'My Agent'; }
		if (this._previewSlug) { this._previewSlug.textContent = `@${this._slugInput?.value || 'my-agent'}`; }
		if (this._previewRole) { this._previewRole.textContent = this._roleInput?.value || 'assistant'; }
	}

	/** Converts a display name into a URL-safe slug (lowercase, hyphenated). */
	private _slugify(text: string): string {
		return text
			.toLowerCase()
			.trim()
			.replace(/[^a-z0-9\s-_]/g, '') // remove non-alphanumeric (keep spaces, hyphens, underscores)
			.replace(/[\s]+/g, '-')         // spaces → hyphen
			.replace(/-+/g, '-')            // collapse multiple hyphens
			.replace(/^-+|-+$/g, '');        // trim leading/trailing hyphens
	}

	/** Auto-syncs the slug from the name unless the user has manually edited it. */
	private _syncSlugFromName(): void {
		if (this._slugEdited) { return; }
		const nameVal = this._nameInput?.value || '';
		const slug = this._slugify(nameVal);
		if (this._slugInput) {
			this._slugInput.value = slug;
			this._clearSlugError();
		}
	}

	private _showNameError(msg: string): void {
		if (this._nameError) {
			this._nameError.textContent = msg;
			this._nameError.style.display = 'block';
		}
		if (this._nameInput) {
			this._nameInput.classList.add('create-form-input-error');
		}
	}

	private _clearNameError(): void {
		if (this._nameError) {
			this._nameError.style.display = 'none';
		}
		if (this._nameInput) {
			this._nameInput.classList.remove('create-form-input-error');
		}
	}

	private _showSlugError(msg: string): void {
		if (this._slugError) {
			this._slugError.textContent = msg;
			this._slugError.style.display = 'block';
		}
		if (this._slugInput) {
			this._slugInput.classList.add('create-form-input-error');
		}
	}

	private _clearSlugError(): void {
		if (this._slugError) {
			this._slugError.style.display = 'none';
		}
		if (this._slugInput) {
			this._slugInput.classList.remove('create-form-input-error');
		}
	}

	private async _handleCreate(): Promise<void> {
		const name = this._nameInput?.value?.trim();
		if (!name) {
			this._showNameError('请输入 Agent 名称');
			this.notificationService.warn('请输入 Agent 名称');
			return;
		}

		const slug = this._slugInput?.value?.trim();
		if (!slug) {
			this._showSlugError('请输入 Slug');
			this.notificationService.warn('请输入 Slug');
			return;
		}
		// Validate slug format: only lowercase letters, numbers, hyphens, and underscores
		if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(slug)) {
			this._showSlugError('Slug 只能包含小写字母、数字、连字符和下划线（如 my-agent_01）');
			this.notificationService.warn('Slug 格式不正确');
			return;
		}

		// Validate: check for duplicate slug (used as agentId)
		try {
			const existingAgents = await this.agentStudioService.getAgents();
			const duplicate = existingAgents.find(a => a.id === slug);
			if (duplicate) {
				this._showSlugError(`Slug "${slug}" 已被占用，请使用其他 slug`);
				this.notificationService.warn(`Slug "${slug}" 已被占用`);
				return;
			}
		} catch (err) {
			console.warn('[AgentCreateEditorPane] Failed to check duplicate slugs:', err);
		}
		this._clearNameError();
		this._clearSlugError();

		const agentData: Partial<Agent> = {
			id: slug, // slug is used as the unique agentId
			name,
			role: this._roleInput?.value?.trim() || 'assistant',
			description: this._descTextarea?.value?.trim() || '',
			icon: this._selectedIcon,
			category: this._categorySelect?.value || 'Development',
			skills: [],
			tools: [],
			systemPrompt: this._promptTextarea?.value?.trim() || undefined,
			source: 'custom',
		};

		try {
			if (this._createBtn) {
				this._createBtn.disabled = true;
				this._createBtn.textContent = '创建中...';
			}
			const createdAgent = await this.agentStudioService.createAgent(agentData);
			this.notificationService.info(`Agent "${name}" 创建成功`);

			// Close the create pane, then open the settings pane for the new agent
			await this.editorService.closeEditor({ editor: AgentCreateEditorInput.getInstance(), groupId: this.group.id });

			// Open agent settings editor pane in the current group
			const settingsInput = new AgentSettingsEditorInput(createdAgent.id, createdAgent.name);
			await this.editorService.openEditor(settingsInput, { pinned: true }, this.group);
		} catch (err) {
			this.notificationService.error(
				`创建 Agent 失败: ${err instanceof Error ? err.message : String(err)}`
			);
			if (this._createBtn) {
				this._createBtn.disabled = false;
				this._createBtn.textContent = '✓ 创建 Agent';
			}
		}
	}

	override layout(dimension: DOM.Dimension): void {
		if (this._container) {
			this._container.style.width = `${dimension.width}px`;
			this._container.style.height = `${dimension.height}px`;
		}
	}
}
