/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IFeedbackService, FeedbackType } from './feedbackService.js';
import { ITofAuthService } from '../common/tofAuth.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IAgentStudioLogService } from './agentStudioLogService.js';

let styleInjected = false;

function injectStyles(): void {
	if (styleInjected || document.getElementById('feedback-modal-styles')) {
		styleInjected = true;
		return;
	}
	const style = document.createElement('style');
	style.id = 'feedback-modal-styles';
	style.textContent = `
.feedback-overlay {
  position: fixed; inset: 0; z-index: 10000;
  background: rgba(0,0,0,0.55);
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: opacity 0.2s ease;
}
.feedback-overlay.active { opacity: 1; }
.feedback-modal {
  background: var(--vscode-sideBar-background, #252526);
  border: 1px solid var(--vscode-panel-border, #3c3c3c);
  border-radius: 6px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
  width: 480px; max-width: calc(100vw - 48px); max-height: calc(100vh - 64px);
  display: flex; flex-direction: column; overflow: hidden;
  transform: scale(0.96) translateY(8px); transition: transform 0.2s ease;
  font-family: var(--vscode-font-family, system-ui, sans-serif);
  font-size: 13px; color: var(--vscode-foreground, #cccccc);
}
.feedback-overlay.active .feedback-modal { transform: scale(1) translateY(0); }
.feedback-modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 14px; border-bottom: 1px solid var(--vscode-panel-border, #3c3c3c);
}
.feedback-modal-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; }
.feedback-modal-title .codicon { width: 18px; height: 18px; color: var(--vscode-textLink-foreground, #007acc); }
.feedback-close-btn {
  background: none; border: none; cursor: pointer; padding: 4px; border-radius: 4px;
  color: var(--vscode-descriptionForeground, #8b8b8b); display: flex; align-items: center;
}
.feedback-close-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); color: var(--vscode-foreground, #cccccc); }
.feedback-close-btn .codicon { width: 16px; height: 16px; }
.feedback-modal-body { padding: 14px; overflow-y: auto; flex: 1; position: relative; }
.feedback-login-required, .feedback-success {
  display: none; flex-direction: column; align-items: center; justify-content: center;
  text-align: center; padding: 40px 24px; gap: 14px;
}
.feedback-login-required.show, .feedback-success.show { display: flex; }
.feedback-login-icon, .feedback-success-icon {
  width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
}
.feedback-login-icon { background: rgba(204, 167, 0, 0.12); }
.feedback-login-icon .codicon { width: 24px; height: 24px; color: var(--vscode-editorWarning-foreground, #cca700); }
.feedback-success-icon { background: rgba(137, 209, 133, 0.12); }
.feedback-success-icon .codicon { width: 24px; height: 24px; color: var(--vscode-testing-iconPassed, #89d185); }
.feedback-login-required h3, .feedback-success h3 { font-size: 15px; font-weight: 600; margin: 0; }
.feedback-login-required p, .feedback-success p { font-size: 12px; color: var(--vscode-descriptionForeground, #8b8b8b); max-width: 320px; line-height: 1.5; margin: 0; }
.feedback-login-btn {
  padding: 6px 20px; background: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff);
  border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;
}
.feedback-login-btn:hover { background: var(--vscode-button-hoverBackground, #1f8ad2); }
.feedback-success .issue-link { color: var(--vscode-textLink-foreground, #007acc); text-decoration: none; font-size: 12px; cursor: pointer; }
.feedback-success .issue-link:hover { text-decoration: underline; }
.feedback-form { display: none; }
.feedback-form.show { display: block; }
.feedback-info-bar {
  display: flex; align-items: center; gap: 10px; padding: 6px 10px;
  background: var(--vscode-textBlockQuote-background, rgba(0,0,0,0.2));
  border: 1px solid var(--vscode-panel-border, #3c3c3c); border-radius: 4px; margin-bottom: 14px;
}
.feedback-info-item { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.feedback-info-item .label { color: var(--vscode-descriptionForeground, #8b8b8b); }
.feedback-info-item .value { color: var(--vscode-foreground, #cccccc); font-weight: 500; }
.feedback-info-divider { width: 1px; height: 14px; background: var(--vscode-panel-border, #3c3c3c); }
.feedback-form-group { margin-bottom: 14px; }
.feedback-form-group:last-child { margin-bottom: 0; }
.feedback-form-label { font-size: 12px; font-weight: 600; margin-bottom: 6px; display: flex; align-items: center; gap: 3px; }
.feedback-form-label .required { color: var(--vscode-errorForeground, #f48771); }
.feedback-type-selector { display: flex; gap: 8px; }
.feedback-type-option {
  flex: 1; display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  background: var(--vscode-input-background, #313131); border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px; cursor: pointer; transition: all 0.15s ease;
}
.feedback-type-option:hover { border-color: var(--vscode-descriptionForeground, #8b8b8b); }
.feedback-type-option.selected[data-type="bug"] { border-color: var(--vscode-errorForeground, #f48771); background: rgba(244,135,113,0.1); }
.feedback-type-option.selected[data-type="feature"] { border-color: var(--vscode-testing-iconPassed, #89d185); background: rgba(137,209,133,0.1); }
.feedback-radio-dot {
  width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--vscode-descriptionForeground, #6b6b6b);
  flex-shrink: 0; position: relative; transition: border-color 0.15s;
}
.feedback-type-option.selected[data-type="bug"] .feedback-radio-dot { border-color: var(--vscode-errorForeground, #f48771); }
.feedback-type-option.selected[data-type="feature"] .feedback-radio-dot { border-color: var(--vscode-testing-iconPassed, #89d185); }
.feedback-type-option.selected .feedback-radio-dot::after {
  content: ''; position: absolute; inset: 2px; border-radius: 50%;
}
.feedback-type-option.selected[data-type="bug"] .feedback-radio-dot::after { background: var(--vscode-errorForeground, #f48771); }
.feedback-type-option.selected[data-type="feature"] .feedback-radio-dot::after { background: var(--vscode-testing-iconPassed, #89d185); }
.feedback-type-icon .codicon { width: 16px; height: 16px; }
.feedback-type-option[data-type="bug"] .feedback-type-icon .codicon { color: var(--vscode-errorForeground, #f48771); }
.feedback-type-option[data-type="feature"] .feedback-type-icon .codicon { color: var(--vscode-testing-iconPassed, #89d185); }
.feedback-type-info { display: flex; flex-direction: column; gap: 1px; }
.feedback-type-label { font-size: 12px; font-weight: 600; }
.feedback-type-desc { font-size: 10px; color: var(--vscode-descriptionForeground, #8b8b8b); }
.feedback-textarea-wrapper { position: relative; }
.feedback-textarea {
  width: 100%; min-height: 90px; padding: 8px 10px;
  background: var(--vscode-input-background, #313131); border: 1px solid var(--vscode-input-border, #3c3c3c);
  border-radius: 4px; color: var(--vscode-input-foreground, #cccccc);
  font-family: inherit; font-size: 13px; line-height: 1.5; resize: vertical; outline: none;
  transition: border-color 0.15s; box-sizing: border-box;
}
.feedback-textarea:focus { border-color: var(--vscode-focusBorder, #007acc); }
.feedback-textarea::placeholder { color: var(--vscode-input-placeholderForeground, #6b6b6b); }
.feedback-char-counter {
  position: absolute; bottom: 6px; right: 10px; font-size: 10px;
  color: var(--vscode-descriptionForeground, #6b6b6b); pointer-events: none;
}
.feedback-upload-area {
  border: 2px dashed var(--vscode-input-border, #3c3c3c); border-radius: 4px;
  padding: 14px; text-align: center; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  display: flex; flex-direction: column; align-items: center; gap: 4px;
}
.feedback-upload-area:hover { border-color: var(--vscode-focusBorder, #007acc); background: var(--vscode-list-hoverBackground, #2a2d2e); }
.feedback-upload-area.dragover { border-color: var(--vscode-focusBorder, #007acc); background: rgba(0,122,204,0.08); }
.feedback-upload-area .codicon { width: 24px; height: 24px; color: var(--vscode-descriptionForeground, #8b8b8b); }
.feedback-upload-text { font-size: 12px; }
.feedback-upload-hint { font-size: 10px; color: var(--vscode-descriptionForeground, #6b6b6b); }
.feedback-preview-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.feedback-preview-item { position: relative; width: 72px; height: 72px; border-radius: 4px; overflow: hidden; border: 1px solid var(--vscode-panel-border, #3c3c3c); }
.feedback-preview-item img { width: 100%; height: 100%; object-fit: cover; }
.feedback-preview-remove {
  position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0,0,0,0.6); border: none; color: #fff; cursor: pointer;
  display: flex; align-items: center; justify-content: center; padding: 0;
}
.feedback-preview-remove:hover { background: var(--vscode-errorForeground, #f48771); }
.feedback-preview-remove .codicon { width: 10px; height: 10px; }
.feedback-submitting { display: none; position: absolute; inset: 0; background: rgba(30,30,30,0.7); align-items: center; justify-content: center; flex-direction: column; gap: 10px; z-index: 10; }
.feedback-submitting.show { display: flex; }
.feedback-spinner { width: 28px; height: 28px; border: 3px solid var(--vscode-panel-border, #3c3c3c); border-top-color: var(--vscode-focusBorder, #007acc); border-radius: 50%; animation: feedback-spin 0.8s linear infinite; }
@keyframes feedback-spin { to { transform: rotate(360deg); } }
.feedback-submitting-text { font-size: 12px; color: var(--vscode-descriptionForeground, #8b8b8b); }
.feedback-modal-footer {
  display: flex; align-items: center; justify-content: flex-end; gap: 8px;
  padding: 10px 14px; border-top: 1px solid var(--vscode-panel-border, #3c3c3c);
}
.feedback-footer-hint { margin-right: auto; font-size: 10px; color: var(--vscode-descriptionForeground, #6b6b6b); display: flex; align-items: center; gap: 3px; }
.feedback-footer-hint .codicon { width: 12px; height: 12px; }
.feedback-btn {
  padding: 5px 14px; border-radius: 4px; font-size: 13px; cursor: pointer;
  border: 1px solid var(--vscode-button-border, #3c3c3c); background: transparent;
  color: var(--vscode-foreground, #cccccc); transition: all 0.15s;
}
.feedback-btn:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
.feedback-btn.primary { background: var(--vscode-button-background, #007acc); border-color: var(--vscode-button-background, #007acc); color: var(--vscode-button-foreground, #fff); }
.feedback-btn.primary:hover { background: var(--vscode-button-hoverBackground, #1f8ad2); }
.feedback-btn.primary:disabled { opacity: 0.5; cursor: not-allowed; }
.feedback-toast {
  position: fixed; bottom: 24px; right: 24px; padding: 10px 14px;
  background: var(--vscode-sideBar-background, #252526); border: 1px solid var(--vscode-panel-border, #3c3c3c);
  border-left: 3px solid var(--vscode-errorForeground, #f48771); border-radius: 4px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4); font-size: 12px;
  display: flex; align-items: center; gap: 6px; z-index: 10001;
  transform: translateX(400px); transition: transform 0.3s ease;
}
.feedback-toast.show { transform: translateX(0); }
.feedback-toast .codicon { width: 14px; height: 14px; color: var(--vscode-errorForeground, #f48771); }
`;
	document.head.appendChild(style);
	styleInjected = true;
}

/** Create a Codicon icon element (VS Code built-in icon font, no innerHTML needed). */
function icon(name: string): HTMLElement {
	const span = document.createElement('span');
	span.className = `codicon codicon-${name}`;
	return span;
}

export class FeedbackModal extends Disposable {

	private overlay: HTMLElement | null = null;
	private selectedType: FeedbackType = 'bug';
	private images: string[] = [];
	private _disposed = false;

	constructor(
		@IFeedbackService private readonly feedbackService: IFeedbackService,
		@ITofAuthService private readonly tofAuthService: ITofAuthService,
		@IAgentStudioLogService private readonly logService: ILogService,
	) {
		super();
	}

	show(): void {
		if (this.overlay) { return; }
		injectStyles();
		this._buildDOM();
		// Force reflow then activate
		requestAnimationFrame(() => {
			this.overlay?.classList.add('active');
		});
		this._updateState();
	}

	hide(): void {
		if (!this.overlay) { return; }
		this.overlay.classList.remove('active');
		setTimeout(() => {
			this.overlay?.remove();
			this.overlay = null;
			this.images = [];
			if (!this._disposed) {
				this.dispose();
			}
		}, 200);
	}

	// ── DOM Construction ──────────────────────────────────────────────

	private _buildDOM(): void {
		const overlay = document.createElement('div');
		overlay.className = 'feedback-overlay';

		const modal = document.createElement('div');
		modal.className = 'feedback-modal';

		// Header
		const header = document.createElement('div');
		header.className = 'feedback-modal-header';
		const title = document.createElement('div');
		title.className = 'feedback-modal-title';
		title.appendChild(icon('comment'));
		title.appendChild(document.createTextNode('提交反馈'));
		const closeBtn = document.createElement('button');
		closeBtn.className = 'feedback-close-btn';
		closeBtn.appendChild(icon('close'));
		closeBtn.addEventListener('click', () => this.hide());
		header.appendChild(title);
		header.appendChild(closeBtn);

		// Body
		const body = document.createElement('div');
		body.className = 'feedback-modal-body';

		// Login required
		const loginReq = this._buildLoginRequired();
		// Form
		const form = this._buildForm();
		// Submitting
		const submitting = this._buildSubmitting();
		// Success
		const success = this._buildSuccess();
		body.appendChild(loginReq);
		body.appendChild(form);
		body.appendChild(submitting);
		body.appendChild(success);

		// Footer
		const footer = document.createElement('div');
		footer.className = 'feedback-modal-footer';
		const hint = document.createElement('div');
		hint.className = 'feedback-footer-hint';
		hint.appendChild(icon('info'));
		hint.appendChild(document.createTextNode('反馈将提交到工蜂 Issue'));
		const cancelBtn = document.createElement('button');
		cancelBtn.className = 'feedback-btn';
		cancelBtn.textContent = '取消';
		cancelBtn.addEventListener('click', () => this.hide());
		const submitBtn = document.createElement('button');
		submitBtn.className = 'feedback-btn primary';
		submitBtn.textContent = '提交反馈';
		submitBtn.addEventListener('click', () => this._submit());
		footer.appendChild(hint);
		footer.appendChild(cancelBtn);
		footer.appendChild(submitBtn);

		modal.appendChild(header);
		modal.appendChild(body);
		modal.appendChild(footer);
		overlay.appendChild(modal);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { this.hide(); }
		});

		this.overlay = overlay;
		document.body.appendChild(overlay);
	}

	private _buildLoginRequired(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'feedback-login-required';
		const iconWrap = document.createElement('div');
		iconWrap.className = 'feedback-login-icon';
		iconWrap.appendChild(icon('lock'));
		const h3 = document.createElement('h3');
		h3.textContent = '需要登录';
		const p = document.createElement('p');
		p.textContent = '提交反馈需要先登录 TOF 账号，以便我们更好地跟踪和回复您的问题。';
		const loginBtn = document.createElement('button');
		loginBtn.className = 'feedback-login-btn';
		loginBtn.textContent = '前往登录';
		loginBtn.addEventListener('click', async () => {
			try {
				await this.tofAuthService.login();
				this._updateState();
			} catch (err) {
				this.logService.warn('[FeedbackModal] Login failed:', err);
			}
		});
		div.appendChild(iconWrap);
		div.appendChild(h3);
		div.appendChild(p);
		div.appendChild(loginBtn);
		return div;
	}

	private _buildForm(): HTMLElement {
		const form = document.createElement('div');
		form.className = 'feedback-form show';

		// Info bar
		const infoBar = document.createElement('div');
		infoBar.className = 'feedback-info-bar';
		const userInfo = this.feedbackService.getUserInfo();
		const versionInfo = this.feedbackService.getVersionInfo();

		infoBar.appendChild(this._infoItem('提交者', userInfo ? `${userInfo.loginName}` : '未登录'));
		infoBar.appendChild(this._divider());
		infoBar.appendChild(this._infoItem('版本', `v${versionInfo.version}`));
		infoBar.appendChild(this._divider());
		infoBar.appendChild(this._infoItem('平台', versionInfo.platform));

		// Type selector
		const typeGroup = document.createElement('div');
		typeGroup.className = 'feedback-form-group';
		const typeLabel = document.createElement('div');
		typeLabel.className = 'feedback-form-label';
		typeLabel.appendChild(document.createTextNode('反馈类型 '));
		const required = document.createElement('span');
		required.className = 'required';
		required.textContent = '*';
		typeLabel.appendChild(required);
		const typeSelector = document.createElement('div');
		typeSelector.className = 'feedback-type-selector';
		typeSelector.appendChild(this._typeOption('bug', 'Bug 报告', '功能异常、崩溃、错误', 'bug', true));
		typeSelector.appendChild(this._typeOption('feature', '需求建议', '新功能、改进、优化', 'star-full', false));
		typeGroup.appendChild(typeLabel);
		typeGroup.appendChild(typeSelector);

		// Description
		const descGroup = document.createElement('div');
		descGroup.className = 'feedback-form-group';
		const descLabel = document.createElement('div');
		descLabel.className = 'feedback-form-label';
		descLabel.appendChild(document.createTextNode('问题描述 '));
		const descRequired = document.createElement('span');
		descRequired.className = 'required';
		descRequired.textContent = '*';
		descLabel.appendChild(descRequired);
		const textareaWrap = document.createElement('div');
		textareaWrap.className = 'feedback-textarea-wrapper';
		const textarea = document.createElement('textarea');
		textarea.className = 'feedback-textarea';
		textarea.placeholder = '请详细描述您遇到的问题或建议...';
		textarea.maxLength = 2000;
		const charCounter = document.createElement('span');
		charCounter.className = 'feedback-char-counter';
		charCounter.textContent = '0 / 2000';
		textarea.addEventListener('input', () => {
			charCounter.textContent = `${textarea.value.length} / 2000`;
		});
		textareaWrap.appendChild(textarea);
		textareaWrap.appendChild(charCounter);
		descGroup.appendChild(descLabel);
		descGroup.appendChild(textareaWrap);

		// Image upload
		const imgGroup = document.createElement('div');
		imgGroup.className = 'feedback-form-group';
		const imgLabel = document.createElement('div');
		imgLabel.className = 'feedback-form-label';
		imgLabel.textContent = '截图（可选）';
		const uploadArea = document.createElement('div');
		uploadArea.className = 'feedback-upload-area';
		uploadArea.appendChild(icon('cloud-upload'));
		const uploadText = document.createElement('span');
		uploadText.className = 'feedback-upload-text';
		uploadText.textContent = '点击或拖拽图片到此处';
		const uploadHint = document.createElement('span');
		uploadHint.className = 'feedback-upload-hint';
		uploadHint.textContent = '支持 PNG / JPG / GIF，单张最大 5MB';
		uploadArea.appendChild(uploadText);
		uploadArea.appendChild(uploadHint);
		const fileInput = document.createElement('input');
		fileInput.type = 'file';
		fileInput.accept = 'image/*';
		fileInput.multiple = true;
		fileInput.style.display = 'none';
		uploadArea.addEventListener('click', () => fileInput.click());
		fileInput.addEventListener('change', () => this._handleFiles(fileInput.files));
		uploadArea.addEventListener('dragover', (e) => {
			e.preventDefault();
			uploadArea.classList.add('dragover');
		});
		uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
		uploadArea.addEventListener('drop', (e) => {
			e.preventDefault();
			uploadArea.classList.remove('dragover');
			this._handleFiles(e.dataTransfer?.files);
		});
		const previewList = document.createElement('div');
		previewList.className = 'feedback-preview-list';
		imgGroup.appendChild(imgLabel);
		imgGroup.appendChild(uploadArea);
		imgGroup.appendChild(fileInput);
		imgGroup.appendChild(previewList);

		form.appendChild(infoBar);
		form.appendChild(typeGroup);
		form.appendChild(descGroup);
		form.appendChild(imgGroup);
		return form;
	}

	private _buildSubmitting(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'feedback-submitting';
		const spinner = document.createElement('div');
		spinner.className = 'feedback-spinner';
		const text = document.createElement('div');
		text.className = 'feedback-submitting-text';
		text.textContent = '正在提交反馈...';
		div.appendChild(spinner);
		div.appendChild(text);
		return div;
	}

	private _buildSuccess(): HTMLElement {
		const div = document.createElement('div');
		div.className = 'feedback-success';
		const iconWrap = document.createElement('div');
		iconWrap.className = 'feedback-success-icon';
		iconWrap.appendChild(icon('check'));
		const h3 = document.createElement('h3');
		h3.textContent = '反馈已提交';
		const p = document.createElement('p');
		p.textContent = '感谢您的反馈！我们会尽快处理。';
		const link = document.createElement('a');
		link.className = 'issue-link';
		link.textContent = '查看 Issue →';
		div.appendChild(iconWrap);
		div.appendChild(h3);
		div.appendChild(p);
		div.appendChild(link);
		return div;
	}

	// ── Helpers ───────────────────────────────────────────────────────

	private _infoItem(label: string, value: string): HTMLElement {
		const div = document.createElement('div');
		div.className = 'feedback-info-item';
		const l = document.createElement('span');
		l.className = 'label';
		l.textContent = `${label}:`;
		const v = document.createElement('span');
		v.className = 'value';
		v.textContent = value;
		div.appendChild(l);
		div.appendChild(v);
		return div;
	}

	private _divider(): HTMLElement {
		const d = document.createElement('div');
		d.className = 'feedback-info-divider';
		return d;
	}

	private _typeOption(type: FeedbackType, label: string, desc: string, iconName: string, selected: boolean): HTMLElement {
		const div = document.createElement('div');
		div.className = 'feedback-type-option' + (selected ? ' selected' : '');
		div.dataset.type = type;
		const dot = document.createElement('div');
		dot.className = 'feedback-radio-dot';
		const iconEl = document.createElement('div');
		iconEl.className = 'feedback-type-icon';
		iconEl.appendChild(icon(iconName));
		const info = document.createElement('div');
		info.className = 'feedback-type-info';
		const l = document.createElement('span');
		l.className = 'feedback-type-label';
		l.textContent = label;
		const d2 = document.createElement('span');
		d2.className = 'feedback-type-desc';
		d2.textContent = desc;
		info.appendChild(l);
		info.appendChild(d2);
		div.appendChild(dot);
		div.appendChild(iconEl);
		div.appendChild(info);
		div.addEventListener('click', () => {
			this.selectedType = type;
			this.overlay?.querySelectorAll('.feedback-type-option').forEach(el => {
				el.classList.toggle('selected', (el as HTMLElement).dataset.type === type);
			});
		});
		return div;
	}

	private _handleFiles(files: FileList | undefined | null): void {
		if (!files) { return; }
		for (const file of Array.from(files)) {
			if (!file.type.startsWith('image/')) { continue; }
			if (file.size > 5 * 1024 * 1024) {
				this._toast('图片不能超过 5MB');
				continue;
			}
			const reader = new FileReader();
			reader.onload = (e) => {
				const dataUrl = e.target?.result as string;
				if (dataUrl) {
					this.images.push(dataUrl);
					this._renderPreviews();
				}
			};
			reader.readAsDataURL(file);
		}
	}

	private _renderPreviews(): void {
		const list = this.overlay?.querySelector('.feedback-preview-list') as HTMLElement;
		if (!list) { return; }
		list.textContent = '';
		this.images.forEach((src, i) => {
			const item = document.createElement('div');
			item.className = 'feedback-preview-item';
			const img = document.createElement('img');
			img.src = src;
			img.alt = 'screenshot';
			const removeBtn = document.createElement('button');
			removeBtn.className = 'feedback-preview-remove';
			removeBtn.appendChild(icon('close'));
			removeBtn.addEventListener('click', () => {
				this.images.splice(i, 1);
				this._renderPreviews();
			});
			item.appendChild(img);
			item.appendChild(removeBtn);
			list.appendChild(item);
		});
	}

	private _updateState(): void {
		const user = this.feedbackService.getUserInfo();
		const isLoggedIn = user !== null;
		const form = this.overlay?.querySelector('.feedback-form') as HTMLElement;
		const loginReq = this.overlay?.querySelector('.feedback-login-required') as HTMLElement;
		if (form) { form.classList.toggle('show', isLoggedIn); }
		if (loginReq) { loginReq.classList.toggle('show', !isLoggedIn); }
	}

	private _toast(msg: string): void {
		const toast = document.createElement('div');
		toast.className = 'feedback-toast';
		toast.appendChild(icon('info'));
		const span = document.createElement('span');
		span.textContent = msg;
		toast.appendChild(span);
		document.body.appendChild(toast);
		requestAnimationFrame(() => toast.classList.add('show'));
		setTimeout(() => {
			toast.classList.remove('show');
			setTimeout(() => toast.remove(), 300);
		}, 3000);
	}

	private async _submit(): Promise<void> {
		const textarea = this.overlay?.querySelector('.feedback-textarea') as HTMLTextAreaElement;
		if (!textarea) { return; }
		const description = textarea.value.trim();
		if (!description) {
			this._toast('请填写问题描述');
			return;
		}
		if (description.length < 10) {
			this._toast('问题描述至少需要 10 个字符');
			return;
		}

		const submitting = this.overlay?.querySelector('.feedback-submitting') as HTMLElement;
		const form = this.overlay?.querySelector('.feedback-form') as HTMLElement;
		const submitBtn = this.overlay?.querySelector('.feedback-btn.primary') as HTMLButtonElement;
		if (submitting) { submitting.classList.add('show'); }
		if (submitBtn) { submitBtn.disabled = true; }

		try {
			const result = await this.feedbackService.submitFeedback({
				type: this.selectedType,
				description,
				images: this.images,
			});

			if (result.success) {
				if (form) { form.classList.remove('show'); }
				const success = this.overlay?.querySelector('.feedback-success') as HTMLElement;
				if (success) { success.classList.add('show'); }
				if (result.openedInBrowser) {
					const h3 = success?.querySelector('h3');
					if (h3) { h3.textContent = '已在浏览器中打开'; }
					const p = success?.querySelector('p');
					if (p) { p.textContent = '标题和描述已复制到剪贴板，请在浏览器中粘贴到对应输入框。'; }
					const link = success?.querySelector('.issue-link') as HTMLAnchorElement;
					if (link) { link.style.display = 'none'; }
				} else {
					const link = success?.querySelector('.issue-link') as HTMLAnchorElement;
					if (link && result.issueUrl) {
						link.textContent = `查看 Issue #${result.issueIid ?? ''} →`;
						link.href = result.issueUrl;
					}
				}
			} else {
				this._toast(result.error ?? '提交失败');
			}
		} catch (err) {
			this._toast(`提交失败: ${err}`);
		} finally {
			if (submitting) { submitting.classList.remove('show'); }
			if (submitBtn) { submitBtn.disabled = false; }
		}
	}

	override dispose(): void {
		this._disposed = true;
		if (this.overlay) {
			this.overlay.remove();
			this.overlay = null;
		}
		this.images = [];
		super.dispose();
	}
}
