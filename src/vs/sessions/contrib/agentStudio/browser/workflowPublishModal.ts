/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * WorkflowPublishModal —— 工作流上传到商城的 Modal 对话框（重新设计版）。
 *
 * UI 结构：
 *   - Header: 图标 + 标题 + 副标题 + 关闭按钮
 *   - Body (scrollable):
 *     - 工作流预览卡片（名称 + ID + 描述 + 元数据徽章）
 *     - 发布信息区（版本号 + 分类 双列，作者 单列）
 *     - 可见性切换（公开 / 私有）
 *     - 标签输入（Enter/逗号添加，×删除）
 *     - 使用说明（Markdown textarea）
 *     - 发布进度条 + 成功横幅
 *   - Footer: 提示文本 + 取消/发布按钮
 *
 * CSS 通过注入 <style> 块实现，使用 VS Code CSS 变量适配主题。
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { $ } from '../../../../base/browser/dom.js';
import { IMarketplaceService, IPublishOptions } from '../common/marketplace.js';
import { validatePublishVersion } from './publishVersioning.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkflowStorageService, IStoredWorkflow } from '../common/workflowStorage.js';
import { IWorkflowVersionService } from '../common/workflowVersionTypes.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { Event, Emitter } from '../../../../base/common/event.js';

// CSS 注入的唯一 ID，避免重复注入
const STYLE_ID = 'workflow-publish-modal-styles';

export class WorkflowPublishModal extends Disposable {

	private _overlay: HTMLElement | undefined;
	private _isPublishing = false;
	private _visibility: 'public' | 'private' = 'public';
	private _tags: string[] = [];

	private readonly _onDidPublish = this._register(new Emitter<IStoredWorkflow>());
	readonly onDidPublish: Event<IStoredWorkflow> = this._onDidPublish.event;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose: Event<void> = this._onDidClose.event;

	constructor(
		private readonly workflow: IStoredWorkflow,
		@IMarketplaceService private readonly marketplaceService: IMarketplaceService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkflowStorageService private readonly workflowStorage: IWorkflowStorageService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IWorkflowVersionService private readonly workflowVersionService: IWorkflowVersionService,
	) {
		super();
	}

	/** 显示 modal */
	show(): void {
		if (this._overlay) { return; }

		this._injectStyles();

		const overlay = $('div.wpm-overlay');
		overlay.onclick = (e: MouseEvent) => {
			if (e.target === overlay) { this.hide(); }
		};

		const dialog = this._buildDialog();
		overlay.appendChild(dialog);

		document.body.appendChild(overlay);
		this._overlay = overlay;
	}

	/** 隐藏 modal */
	hide(): void {
		if (this._overlay) {
			this._overlay.remove();
			this._overlay = undefined;
		}
		this._isPublishing = false;
		this._onDidClose.fire();
	}

	// ─── CSS 注入 ──────────────────────────────────────────────────

	private _injectStyles(): void {
		if (document.getElementById(STYLE_ID)) { return; }
		const style = document.createElement('style');
		style.id = STYLE_ID;
		style.textContent = `
.wpm-overlay {
	position: fixed; inset: 0;
	background: rgba(0,0,0,0.55);
	backdrop-filter: blur(6px);
	display: flex; align-items: center; justify-content: center;
	z-index: 10000; font-size: 13px;
}
.wpm-modal {
	background: var(--vscode-sideBar-background, #181825);
	border: 1px solid var(--vscode-panel-border, #313244);
	border-radius: 12px;
	width: 600px; max-width: 94vw; max-height: 88vh;
	display: flex; flex-direction: column;
	box-shadow: 0 20px 60px rgba(0,0,0,0.5);
	color: var(--vscode-foreground, #cdd6f4);
	overflow: hidden;
}

/* Header */
.wpm-header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 14px 20px; border-bottom: 1px solid var(--vscode-panel-border, #313244);
	flex-shrink: 0;
}
.wpm-header-left { display: flex; align-items: center; gap: 10px; }
.wpm-icon {
	width: 32px; height: 32px; border-radius: 8px;
	background: linear-gradient(135deg, #89b4fa, #cba6f7);
	display: flex; align-items: center; justify-content: center; font-size: 16px;
	flex-shrink: 0;
}
.wpm-title { font-size: 14px; font-weight: 700; color: var(--vscode-foreground); }
.wpm-subtitle { font-size: 11px; color: var(--vscode-descriptionForeground, #6c7086); margin-top: 1px; }
.wpm-close {
	width: 28px; height: 28px; border-radius: 6px;
	border: none; background: transparent;
	color: var(--vscode-descriptionForeground, #6c7086);
	cursor: pointer; font-size: 15px;
	display: flex; align-items: center; justify-content: center;
	transition: all .15s;
}
.wpm-close:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); color: var(--vscode-foreground); }

/* Body */
.wpm-body {
	padding: 18px 20px; overflow-y: auto; flex: 1;
	display: flex; flex-direction: column; gap: 16px;
}
.wpm-body::-webkit-scrollbar { width: 6px; }
.wpm-body::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background, #45475a); border-radius: 3px; }
.wpm-body::-webkit-scrollbar-track { background: transparent; }

/* Preview Card */
.wpm-preview {
	background: rgba(255,255,255,0.03);
	border: 1px solid var(--vscode-panel-border, #313244);
	border-radius: 8px; padding: 12px 14px;
	display: flex; gap: 12px; align-items: flex-start;
}
.wpm-preview-icon {
	width: 40px; height: 40px; border-radius: 8px;
	background: rgba(137,180,250,0.1);
	border: 1px solid rgba(137,180,250,0.15);
	display: flex; align-items: center; justify-content: center; font-size: 18px;
	flex-shrink: 0;
}
.wpm-preview-info { flex: 1; min-width: 0; }
.wpm-preview-name { font-size: 13px; font-weight: 700; color: var(--vscode-foreground); margin-bottom: 2px; }
.wpm-preview-id { font-size: 11px; color: var(--vscode-descriptionForeground, #6c7086); font-family: var(--vscode-editor-font-family, monospace); margin-bottom: 5px; }
.wpm-preview-desc { font-size: 12px; color: var(--vscode-descriptionForeground, #6c7086); line-height: 1.5; }
.wpm-preview-meta { display: flex; gap: 12px; margin-top: 7px; flex-wrap: wrap; }
.wpm-preview-meta-item { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--vscode-descriptionForeground, #6c7086); }
.wpm-preview-meta-item .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--vscode-textLink-foreground, #89b4fa); }
.wpm-preview-meta-val { color: var(--vscode-foreground); font-weight: 600; }

/* Section */
.wpm-section { display: flex; flex-direction: column; gap: 8px; }
.wpm-section-header {
	display: flex; align-items: center; gap: 6px;
	font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
	color: var(--vscode-descriptionForeground, #6c7086);
}
.wpm-section-header::after { content: ''; flex: 1; height: 1px; background: var(--vscode-panel-border, #313244); }

/* Form */
.wpm-form-row { display: flex; align-items: flex-start; gap: 10px; }
.wpm-form-row.col { flex-direction: column; align-items: stretch; gap: 3px; }
.wpm-form-split { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.wpm-label { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #6c7086); flex-shrink: 0; min-width: 60px; padding-top: 6px; }
.wpm-label-col { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground, #6c7086); }
.wpm-required { color: var(--vscode-errorForeground, #f38ba8); margin-left: 2px; }
.wpm-input, .wpm-textarea {
	flex: 1; padding: 6px 9px; font-size: 12px;
	font-family: var(--vscode-font-family, inherit);
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #313244));
	border-radius: 5px;
	background: var(--vscode-input-background, rgba(255,255,255,0.05));
	color: var(--vscode-input-foreground, var(--vscode-foreground));
	outline: none; transition: border-color .15s;
	box-sizing: border-box;
}
.wpm-input:focus, .wpm-textarea:focus {
	border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #89b4fa));
}
.wpm-input::placeholder, .wpm-textarea::placeholder { color: var(--vscode-input-placeholderForeground, #585b70); }
.wpm-textarea { min-height: 68px; resize: vertical; line-height: 1.5; }
.wpm-hint { font-size: 10px; color: var(--vscode-descriptionForeground, #6c7086); margin-top: 2px; }

/* Visibility Toggle */
.wpm-vis-toggle { display: flex; gap: 8px; }
.wpm-vis-option {
	flex: 1; display: flex; align-items: center; gap: 8px;
	padding: 9px 11px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #313244));
	border-radius: 6px; background: var(--vscode-input-background, rgba(255,255,255,0.04));
	cursor: pointer; transition: all .15s;
}
.wpm-vis-option:hover { border-color: var(--vscode-descriptionForeground, #6c7086); }
.wpm-vis-option.active {
	border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #89b4fa));
	background: var(--vscode-list-activeSelectionBackground, rgba(137,180,250,0.12));
}
.wpm-vis-radio {
	width: 14px; height: 14px; border-radius: 50%;
	border: 2px solid var(--vscode-panel-border, #45475a);
	flex-shrink: 0; display: flex; align-items: center; justify-content: center;
	transition: all .15s;
}
.wpm-vis-option.active .wpm-vis-radio { border-color: var(--vscode-textLink-foreground, #89b4fa); }
.wpm-vis-option.active .wpm-vis-radio::after {
	content: ''; width: 6px; height: 6px; border-radius: 50%;
	background: var(--vscode-textLink-foreground, #89b4fa);
}
.wpm-vis-icon { font-size: 15px; }
.wpm-vis-label { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
.wpm-vis-desc { font-size: 10px; color: var(--vscode-descriptionForeground, #6c7086); }

/* Tags */
.wpm-tags-container {
	display: flex; flex-wrap: wrap; gap: 4px;
	padding: 4px 7px;
	border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, #313244));
	border-radius: 5px; background: var(--vscode-input-background, rgba(255,255,255,0.04));
	min-height: 32px; align-items: center; flex: 1;
	transition: border-color .15s; cursor: text;
}
.wpm-tags-container:focus-within { border-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground, #89b4fa)); }
.wpm-tag {
	display: inline-flex; align-items: center; gap: 3px;
	padding: 2px 6px; font-size: 11px; font-weight: 500;
	background: var(--vscode-list-activeSelectionBackground, rgba(137,180,250,0.15));
	color: var(--vscode-textLink-foreground, #89b4fa);
	border-radius: 3px; white-space: nowrap;
}
.wpm-tag-remove {
	cursor: pointer; font-size: 12px; opacity: 0.6;
	border: none; background: none; color: inherit; padding: 0; line-height: 1;
	transition: opacity .1s;
}
.wpm-tag-remove:hover { opacity: 1; }
.wpm-tags-input {
	border: none; outline: none; background: transparent;
	color: var(--vscode-input-foreground, var(--vscode-foreground)); font-size: 12px;
	font-family: inherit; min-width: 80px; flex: 1; padding: 2px 0;
}
.wpm-tags-input::placeholder { color: var(--vscode-input-placeholderForeground, #585b70); }

/* Footer */
.wpm-footer {
	display: flex; align-items: center; justify-content: space-between;
	padding: 12px 20px; border-top: 1px solid var(--vscode-panel-border, #313244);
	flex-shrink: 0;
}
.wpm-footer-left { font-size: 11px; color: var(--vscode-descriptionForeground, #6c7086); }
.wpm-footer-right { display: flex; gap: 8px; }
.wpm-btn {
	padding: 6px 16px; font-size: 12px; font-weight: 600;
	border-radius: 5px; cursor: pointer; border: none;
	transition: all .15s; font-family: inherit;
}
.wpm-btn-ghost {
	background: transparent; color: var(--vscode-foreground);
	border: 1px solid var(--vscode-panel-border, #313244);
}
.wpm-btn-ghost:hover { background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.08)); }
.wpm-btn-primary {
	background: var(--vscode-button-background, #89b4fa); color: var(--vscode-button-foreground, #1e1e2e);
}
.wpm-btn-primary:hover { background: var(--vscode-button-hoverBackground, #a6d3fa); filter: brightness(1.08); }
.wpm-btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

/* Progress & Success */
.wpm-progress {
	display: none; align-items: center; gap: 8px;
	padding: 9px 13px;
	background: var(--vscode-list-activeSelectionBackground, rgba(137,180,250,0.1));
	border: 1px solid var(--vscode-panel-border, #313244);
	border-radius: 5px;
}
.wpm-progress.visible { display: flex; }
.wpm-spinner {
	width: 14px; height: 14px;
	border: 2px solid var(--vscode-panel-border, #45475a);
	border-top-color: var(--vscode-textLink-foreground, #89b4fa);
	border-radius: 50%;
	animation: wpm-spin 0.8s linear infinite;
}
@keyframes wpm-spin { to { transform: rotate(360deg); } }
.wpm-progress-text { font-size: 12px; color: var(--vscode-textLink-foreground, #89b4fa); font-weight: 500; }

.wpm-success {
	display: none; align-items: center; gap: 8px;
	padding: 9px 13px;
	background: var(--vscode-inputValidation-infoBackground, rgba(137,180,250,0.1));
	border: 1px solid var(--vscode-inputValidation-infoBorder, #45475a);
	border-radius: 5px;
}
.wpm-success.visible { display: flex; }
.wpm-error-banner {
	display: flex; align-items: center; gap: 8px;
	padding: 9px 13px;
	background: var(--vscode-inputValidation-errorBackground, rgba(243,139,168,0.12));
	border: 1px solid var(--vscode-inputValidation-errorBorder, rgba(243,139,168,0.35));
	border-radius: 5px;
	color: var(--vscode-inputValidation-errorForeground, #f38ba8);
	font-size: 12px; line-height: 1.5;
	margin-bottom: 12px;
}
.wpm-success-icon { font-size: 15px; }
.wpm-success-text { font-size: 12px; color: var(--vscode-foreground); font-weight: 500; }
`;
		document.head.appendChild(style);
	}

	// ─── Dialog 构建 ──────────────────────────────────────────────

	private _buildDialog(): HTMLElement {
		const dialog = $('div.wpm-modal');
		dialog.onclick = (e) => e.stopPropagation();

		// ── Header ──
		const header = $('div.wpm-header');
		const headerLeft = $('div.wpm-header-left');
		const icon = $('div.wpm-icon');
		icon.textContent = '📦';
		headerLeft.appendChild(icon);
		const titleWrap = $('div');
		const title = $('div.wpm-title');
		title.textContent = '发布工作流';
		titleWrap.appendChild(title);
		const subtitle = $('div.wpm-subtitle');
		subtitle.textContent = '上传到 Sarosis 工作流商城';
		titleWrap.appendChild(subtitle);
		headerLeft.appendChild(titleWrap);
		header.appendChild(headerLeft);

		const closeBtn = $('button.wpm-close');
		closeBtn.textContent = '✕';
		closeBtn.title = '关闭';
		closeBtn.onclick = () => this.hide();
		header.appendChild(closeBtn);
		dialog.appendChild(header);

		// ── Body ──
		const body = $('div.wpm-body');

		// Preview Card
		body.appendChild(this._buildPreviewCard());

		// Section: 发布信息
		const pubSection = $('div.wpm-section');
		pubSection.appendChild(this._makeSectionHeader('📋 发布信息'));

		const splitRow = $('div.wpm-form-split');
		// 版本号
		const versionCol = $('div.wpm-form-row.col');
		const versionLabel = $('span.wpm-label-col');
		versionLabel.append('版本号 ');
		const requiredMark = $('span.wpm-required');
		requiredMark.textContent = '*';
		versionLabel.appendChild(requiredMark);
		versionCol.appendChild(versionLabel);
		const versionInput = $('input.wpm-input') as HTMLInputElement;
		versionInput.type = 'text';
		versionInput.id = 'wpm-field-version';
		versionInput.value = this.workflow.version || '1.0.0';
		versionInput.placeholder = 'x.y.z';
		versionCol.appendChild(versionInput);
		const versionHint = $('div.wpm-hint');
		versionHint.textContent = '语义化版本，如 1.0.0';
		versionCol.appendChild(versionHint);
		splitRow.appendChild(versionCol);

		// 分类
		const catCol = $('div.wpm-form-row.col');
		const catLabel = $('span.wpm-label-col');
		catLabel.textContent = '分类';
		catCol.appendChild(catLabel);
		const catInput = $('input.wpm-input') as HTMLInputElement;
		catInput.type = 'text';
		catInput.id = 'wpm-field-category';
		catInput.value = this.workflow.category || '';
		catInput.placeholder = '如：通用、开发、测试';
		catCol.appendChild(catInput);
		splitRow.appendChild(catCol);
		pubSection.appendChild(splitRow);

		// 作者
		const authorRow = $('div.wpm-form-row.col');
		const authorLabel = $('span.wpm-label-col');
		authorLabel.textContent = '作者';
		authorRow.appendChild(authorLabel);
		const authorInput = $('input.wpm-input') as HTMLInputElement;
		authorInput.type = 'text';
		authorInput.id = 'wpm-field-author';
		authorInput.value = this.tofAuthService.currentUser?.login_name || this.workflow.author || '';
		authorInput.placeholder = '作者名称';
		authorRow.appendChild(authorInput);
		pubSection.appendChild(authorRow);

		// 更新说明（changelog，随版本发布到商城，版本历史与升级提示中展示）
		const changelogRow = $('div.wpm-form-row.col');
		const changelogLabel = $('span.wpm-label-col');
		changelogLabel.textContent = '更新说明';
		changelogRow.appendChild(changelogLabel);
		const changelogInput = $('input.wpm-input') as HTMLInputElement;
		changelogInput.type = 'text';
		changelogInput.id = 'wpm-field-changelog';
		changelogInput.placeholder = '本版本的变更摘要（可选），如：修复表格抽取越界';
		changelogRow.appendChild(changelogInput);
		pubSection.appendChild(changelogRow);
		body.appendChild(pubSection);

		// Section: 可见性
		body.appendChild(this._buildVisibilitySection());

		// Section: 标签
		body.appendChild(this._buildTagsSection());

		// Section: 使用说明
		body.appendChild(this._buildUseGuideSection());

		// Progress + Success
		const progress = $('div.wpm-progress');
		progress.id = 'wpm-progress';
		const spinner = $('div.wpm-spinner');
		progress.appendChild(spinner);
		const progressText = $('span.wpm-progress-text');
		progressText.textContent = '正在打包并上传工作流...';
		progress.appendChild(progressText);
		body.appendChild(progress);

		const success = $('div.wpm-success');
		success.id = 'wpm-success';
		const successIcon = $('span.wpm-success-icon');
		successIcon.textContent = '✅';
		success.appendChild(successIcon);
		const successText = $('span.wpm-success-text');
		successText.id = 'wpm-success-text';
		success.appendChild(successText);
		body.appendChild(success);

		dialog.appendChild(body);

		// ── Footer ──
		const footer = $('div.wpm-footer');
		const footerLeft = $('div.wpm-footer-left');
		footerLeft.textContent = '发布后可在工作流商城中被其他用户发现和安装';
		footer.appendChild(footerLeft);
		const footerRight = $('div.wpm-footer-right');

		const cancelBtn = $('button.wpm-btn.wpm-btn-ghost') as HTMLButtonElement;
		cancelBtn.textContent = '取消';
		cancelBtn.onclick = () => this.hide();
		footerRight.appendChild(cancelBtn);

		const publishBtn = $('button.wpm-btn.wpm-btn-primary') as HTMLButtonElement;
		publishBtn.textContent = '📤 发布到商城';
		publishBtn.id = 'wpm-publish-btn';
		publishBtn.onclick = () => { void this._handlePublish(); };
		footerRight.appendChild(publishBtn);
		footer.appendChild(footerRight);

		dialog.appendChild(footer);
		return dialog;
	}

	/** 工作流预览卡片 */
	private _buildPreviewCard(): HTMLElement {
		const card = $('div.wpm-preview');
		const icon = $('div.wpm-preview-icon');
		icon.textContent = '⚙️';
		card.appendChild(icon);

		const info = $('div.wpm-preview-info');
		const name = $('div.wpm-preview-name');
		name.textContent = this.workflow.name;
		info.appendChild(name);

		const idEl = $('div.wpm-preview-id');
		idEl.textContent = this.workflow.id;
		info.appendChild(idEl);

		const desc = $('div.wpm-preview-desc');
		desc.textContent = this.workflow.description || '(无描述)';
		info.appendChild(desc);

		const meta = $('div.wpm-preview-meta');
		const nodeCount = this.workflow.nodes?.length ?? 0;
		const connCount = this.workflow.connections?.length ?? 0;
		const stepCount = this.workflow.steps?.length ?? 0;

		meta.appendChild(this._metaItem(undefined, '', String(nodeCount), '个节点'));

		if (connCount > 0) {
			meta.appendChild(this._metaItem('var(--vscode-terminal-ansiGreen)', '', String(connCount), '个连接'));
		}
		if (stepCount > 0) {
			meta.appendChild(this._metaItem('var(--vscode-terminal-ansiYellow)', '', String(stepCount), '个步骤'));
		}

		if (this.workflow.version) {
			meta.appendChild(this._metaItem('var(--vscode-terminal-ansiCyan)', '本地版本', 'v' + this.workflow.version, ''));
		}

		info.appendChild(meta);
		card.appendChild(info);
		return card;
	}

	/** 构建预览卡片的元数据项（避免 innerHTML，使用受 TrustedHTML 策略允许的 DOM 构建） */
	private _metaItem(dotColor: string | undefined, prefix: string, value: string, suffix: string): HTMLElement {
		const item = $('div.wpm-preview-meta-item');
		const dot = $('span.dot');
		if (dotColor) { dot.style.background = dotColor; }
		item.appendChild(dot);
		if (prefix) {
			item.appendChild(document.createTextNode(' ' + prefix + ' '));
		}
		const val = $('span.wpm-preview-meta-val');
		val.textContent = value;
		item.appendChild(val);
		if (suffix) {
			item.appendChild(document.createTextNode(' ' + suffix));
		}
		return item;
	}

	/** 可见性切换区 */
	private _buildVisibilitySection(): HTMLElement {
		const section = $('div.wpm-section');
		section.appendChild(this._makeSectionHeader('👁️ 可见性'));

		const toggle = $('div.wpm-vis-toggle');

		// 初始化可见性
		this._visibility = this.workflow.visibility === 'private' ? 'private' : 'public';

		const publicOption = $('div.wpm-vis-option');
		publicOption.dataset.value = 'public';
		if (this._visibility === 'public') { publicOption.classList.add('active'); }
		publicOption.appendChild(this._visOptionContent('🌐', '公开', '所有人可见并可使用'));
		publicOption.onclick = () => {
			this._visibility = 'public';
			toggle.querySelectorAll('.wpm-vis-option').forEach(o => o.classList.remove('active'));
			publicOption.classList.add('active');
		};
		toggle.appendChild(publicOption);

		const privateOption = $('div.wpm-vis-option');
		privateOption.dataset.value = 'private';
		if (this._visibility === 'private') { privateOption.classList.add('active'); }
		privateOption.appendChild(this._visOptionContent('🔒', '私有', '仅自己可见'));
		privateOption.onclick = () => {
			this._visibility = 'private';
			toggle.querySelectorAll('.wpm-vis-option').forEach(o => o.classList.remove('active'));
			privateOption.classList.add('active');
		};
		toggle.appendChild(privateOption);

		section.appendChild(toggle);
		return section;
	}

	/** 构建可见性选项的内部内容（避免 innerHTML） */
	private _visOptionContent(icon: string, label: string, desc: string): DocumentFragment {
		const frag = document.createDocumentFragment();
		const radio = $('div.wpm-vis-radio');
		frag.appendChild(radio);
		const iconEl = $('div.wpm-vis-icon');
		iconEl.textContent = icon;
		frag.appendChild(iconEl);
		const textWrap = $('div');
		const labelEl = $('div.wpm-vis-label');
		labelEl.textContent = label;
		const descEl = $('div.wpm-vis-desc');
		descEl.textContent = desc;
		textWrap.appendChild(labelEl);
		textWrap.appendChild(descEl);
		frag.appendChild(textWrap);
		return frag;
	}

	/** 标签输入区 */
	private _buildTagsSection(): HTMLElement {
		const section = $('div.wpm-section');
		section.appendChild(this._makeSectionHeader('🏷️ 标签'));

		// 初始化已有标签
		this._tags = [...(this.workflow.tags || [])];

		const row = $('div.wpm-form-row');
		const label = $('span.wpm-label');
		label.textContent = '标签';
		row.appendChild(label);

		const container = $('div.wpm-tags-container');
		container.id = 'wpm-tags-container';

		// 渲染已有标签
		for (const tag of this._tags) {
			container.appendChild(this._createTagElement(tag));
		}

		const input = $('input.wpm-tags-input') as HTMLInputElement;
		input.id = 'wpm-tags-input';
		input.placeholder = '输入标签后回车...';
		input.onkeydown = (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ',') {
				e.preventDefault();
				const val = input.value.trim().replace(/,/g, '');
				if (val && !this._tags.includes(val)) {
					this._tags.push(val);
					container.insertBefore(this._createTagElement(val), input);
				}
				input.value = '';
			} else if (e.key === 'Backspace' && !input.value && this._tags.length > 0) {
				// Backspace 删除最后一个标签
				const lastTag = this._tags.pop();
				if (lastTag) {
					const tagEls = container.querySelectorAll('.wpm-tag');
					tagEls[tagEls.length - 1]?.remove();
				}
			}
		};
		container.appendChild(input);
		container.onclick = () => input.focus();

		row.appendChild(container);
		section.appendChild(row);
		return section;
	}

	/** 创建单个标签 DOM */
	private _createTagElement(tagText: string): HTMLElement {
		const tag = $('span.wpm-tag');
		tag.textContent = tagText + ' ';

		const removeBtn = $('button.wpm-tag-remove');
		removeBtn.textContent = '×';
		removeBtn.onclick = (e: MouseEvent) => {
			e.stopPropagation();
			this._tags = this._tags.filter(t => t !== tagText);
			tag.remove();
		};
		tag.appendChild(removeBtn);
		return tag;
	}

	/** 使用说明区 */
	private _buildUseGuideSection(): HTMLElement {
		const section = $('div.wpm-section');
		section.appendChild(this._makeSectionHeader('📖 使用说明'));

		const row = $('div.wpm-form-row.col');
		const textarea = $('textarea.wpm-textarea') as HTMLTextAreaElement;
		textarea.id = 'wpm-field-useGuide';
		textarea.value = this.workflow.useGuide || '';
		textarea.placeholder = '工作流的使用说明（支持 Markdown）...\n\n例如：\n## 使用方法\n1. 配置环境变量\n2. 运行工作流';
		row.appendChild(textarea);

		const hint = $('div.wpm-hint');
		hint.textContent = '支持 Markdown 格式，将展示在商城的"使用指南"标签页中';
		row.appendChild(hint);

		section.appendChild(row);
		return section;
	}

	/** 创建分区标题 */
	private _makeSectionHeader(text: string): HTMLElement {
		const header = $('div.wpm-section-header');
		header.textContent = text;
		return header;
	}

	/** 获取字段值 */
	private _getFieldValue(fieldName: string): string {
		const el = document.getElementById(`wpm-field-${fieldName}`) as HTMLInputElement | HTMLTextAreaElement | null;
		return el?.value?.trim() || '';
	}

	// ─── 发布处理 ──────────────────────────────────────────────────

	private async _handlePublish(): Promise<void> {
		if (this._isPublishing) { return; }
		this._isPublishing = true;

		const version = this._getFieldValue('version');
		const category = this._getFieldValue('category');
		const author = this._getFieldValue('author');
		const useGuide = this._getFieldValue('useGuide');
		const changelog = this._getFieldValue('changelog');

		if (!version) {
			this.notificationService.warn('请输入版本号');
			this._isPublishing = false;
			return;
		}

		if (!/^\d+\.\d+\.\d+/.test(version)) {
			this.notificationService.warn('版本号格式不正确，应为 x.y.z 格式（如 1.0.0）');
			this._isPublishing = false;
			return;
		}

		// 商城版本预检：历史版本查重 + 必须大于 latest（无包则跳过）
		const remote = await this.marketplaceService.getPackage(this.workflow.id).catch(() => undefined);
		const versionError = validatePublishVersion(version, remote);
		if (versionError) {
			this.notificationService.warn(versionError);
			this._isPublishing = false;
			return;
		}

		// 显示进度
		// 清除旧错误横幅
		const oldError = document.getElementById('wpm-error');
		if (oldError) { oldError.remove(); }

		const progress = document.getElementById('wpm-progress');
		const successBanner = document.getElementById('wpm-success');
		const publishBtn = document.getElementById('wpm-publish-btn') as HTMLButtonElement;
		if (publishBtn) {
			publishBtn.textContent = '⏳ 发布中...';
			publishBtn.disabled = true;
		}
		if (progress) { progress.classList.add('visible'); }

		try {
			const opts: IPublishOptions = {
				version,
				category: category || undefined,
				author: author || undefined,
				visibility: this._visibility,
				tags: this._tags.length > 0 ? this._tags : undefined,
				useGuide: useGuide || undefined,
				changelog: changelog || undefined,
			};

			const result = await this.marketplaceService.publish(this.workflow.id, 'workflow', opts);

			// 保存到本地工作流
			try {
				await this.workflowStorage.updateWorkflow(this.workflow.id, {
					version: result.version,
					category: category || undefined,
					author: author || undefined,
					visibility: this._visibility,
					tags: this._tags.length > 0 ? this._tags : undefined,
					useGuide: useGuide || undefined,
				});
			} catch {
				// 非致命 — 商城已发布成功
			}

			// 发布锚点：autoCommit + git tag，关联商城版本与本地 git 历史（best-effort）
			try {
				await this.workflowVersionService.autoCommit(this.workflow.id, `publish: v${result.version} to marketplace`);
				await this.workflowVersionService.tag(this.workflow.id, `v${result.version}`);
			} catch {
				// 非致命 — 商城已发布成功
			}

			// 显示成功横幅
			if (progress) { progress.classList.remove('visible'); }
			if (successBanner) {
				const successText = successBanner.querySelector('#wpm-success-text');
				if (successText) { successText.textContent = `工作流已成功发布到商城！v${result.version} 现已可用。`; }
				successBanner.classList.add('visible');
			}
			if (publishBtn) {
				publishBtn.textContent = '✅ 已发布';
				publishBtn.style.background = 'var(--vscode-terminal-ansiGreen, #4ec9b0)';
			}

			this.notificationService.info(`工作流 "${this.workflow.name}" 已成功发布到商城 (v${result.version})`);
			this._onDidPublish.fire(this.workflow);

			// 延迟关闭
			setTimeout(() => { this.hide(); }, 1500);

		} catch (err) {
			if (progress) { progress.classList.remove('visible'); }

			const errMsg = err instanceof Error ? err.message : String(err);
			// 提取服务端返回的可读错误信息
			const friendlyMsg = this._formatPublishError(errMsg);

			// 通知
			this.notificationService.error(`发布工作流失败: ${friendlyMsg}`);

			// 内联错误横幅
			this._showErrorBanner(friendlyMsg);

			if (publishBtn) {
				publishBtn.textContent = '📤 发布到商城';
				publishBtn.disabled = false;
			}
		} finally {
			this._isPublishing = false;
		}
	}

	/**
	 * 将服务端返回的原始错误信息格式化为用户可读的提示。
	 *
	 * 常见服务器端错误码：
	 * - slug conflict (409): "slug already exists" / "slug 'xxx' already in use"
	 * - 校验失败 (400): "invalid slug format" / "version required"
	 */
	private _formatPublishError(rawMsg: string): string {
		// slug 冲突
		if (/slug.*(?:already|conflict|exist)/i.test(rawMsg) || /conflict/i.test(rawMsg)) {
			return `Slug 冲突：“${this.workflow.id}”已存在于商城，请更换工作流 Slug 后重试`;
		}
		if (/already exists/i.test(rawMsg)) {
			return `“${this.workflow.id}”已存在，请更换 Slug 或递增版本号`;
		}
		// HTTP 错误码
		const httpMatch = rawMsg.match(/HTTP (\d{3})/);
		if (httpMatch) {
			switch (httpMatch[1]) {
				case '409': return `Slug 冲突：“${this.workflow.id}”已被占用`;
				case '400': return `请求参数不合法，请检查工作流配置`;
				case '401': return '认证失败，请检查登录状态';
				case '403': return '无权限执行此操作';
				case '413': return '工作流包体过大，请精简后重试';
				default: return `服务器错误 (HTTP ${httpMatch[1]})`;
			}
		}
		// 直接透传（可能已经是可读消息）
		return rawMsg;
	}

	/** 在对话框底部显示红色错误横幅 */
	private _showErrorBanner(message: string): void {
		// 移除旧的错误横幅
		const existing = document.getElementById('wpm-error');
		if (existing) { existing.remove(); }

		const banner = document.createElement('div');
		banner.id = 'wpm-error';
		banner.className = 'wpm-error-banner';
		banner.appendChild(document.createTextNode(message));

		// 插入到 footer 之前（body 的最后一个子元素是 footer）
		const body = document.querySelector('.wpm-body');
		const footer = document.querySelector('.wpm-footer');
		if (body && footer) {
			body.insertBefore(banner, footer);
		}
	}
}
