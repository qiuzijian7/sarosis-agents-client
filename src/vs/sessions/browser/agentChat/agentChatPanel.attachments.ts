import { addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IChatAttachment } from './agentChatTypes.js';
import { AgentChatPanelMessages } from './agentChatPanel.messages.js';

// Feature: attachments. Extracted from AgentChatPanelBase.
export class AgentChatPanelAttachments extends AgentChatPanelMessages {

protected override _handleFileSelection(): void {
		if (!this._fileInput?.files) { return; }
		this._addFiles(Array.from(this._fileInput.files));
		this._fileInput.value = ''; // reset so same file can be re-selected
	}

protected override _addFiles(files: File[], isPasted = false): void {
		const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB per image
		const MAX_FILE_SIZE = 30 * 1024 * 1024;  // 30MB per file
		const MAX_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB total

		for (const file of files) {
			const isImage = file.type.startsWith('image/');
			const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;

			if (file.size > maxSize) {
				// eslint-disable-next-line no-console
				console.warn(`[AgentChatPanel] File too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)}MB > ${(maxSize / 1024 / 1024).toFixed(0)}MB limit)`);
				continue;
			}

			if (isImage) {
				// Scale image before encoding
				this._resizeImage(file, 2048, 768).then(scaledDataUrl => {
					const base64 = scaledDataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'image',
						name: file.name,
						mimeType: file.type || 'image/png',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
					this._insertInlineAttachmentChip(att);
				}).catch(() => { /* ignore resize failures */ });
			} else {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = reader.result as string;
					const base64 = dataUrl.split(',')[1] || '';
					const att: IChatAttachment = {
						id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						type: 'file',
						name: file.name,
						mimeType: file.type || 'application/octet-stream',
						data: base64,
						size: file.size,
						isPasted,
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
					this._insertInlineAttachmentChip(att);
				};
				reader.readAsDataURL(file);
			}
		}
	}

protected override _resizeImage(file: File, maxWidth: number, maxHeight: number): Promise<string> {
		return new Promise((resolve, reject) => {
			const img = new Image();
			img.onload = () => {
				let { width, height } = img;
				if (width <= maxWidth && height <= maxHeight) {
					// No scaling needed, return original via FileReader
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result as string);
					reader.onerror = reject;
					reader.readAsDataURL(file);
					return;
				}
				const ratio = Math.min(maxWidth / width, maxHeight / height);
				width = Math.round(width * ratio);
				height = Math.round(height * ratio);
				const canvas = document.createElement('canvas');
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext('2d');
				if (!ctx) { reject(new Error('No canvas context')); return; }
				ctx.drawImage(img, 0, 0, width, height);
				resolve(canvas.toDataURL(file.type || 'image/png', 0.85));
			};
			img.onerror = reject;
			img.src = URL.createObjectURL(file);
		});
	}

protected override _insertInlineAttachmentChip(att: IChatAttachment): void {
		const root = this._textarea;
		if (!root) { return; }
		const chip = this._createAttachmentChipNode(att);
		const spaceBefore = document.createTextNode(' ');
		const spaceAfter = document.createTextNode(' ');
		root.focus();
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const frag = document.createDocumentFragment();
			frag.appendChild(spaceBefore);
			frag.appendChild(chip);
			frag.appendChild(spaceAfter);
			range.insertNode(frag);
			range.setStartAfter(spaceAfter);
			range.collapse(true);
			sel.removeAllRanges();
			sel.addRange(range);
		} else {
			root.appendChild(spaceBefore);
			root.appendChild(chip);
			root.appendChild(spaceAfter);
			this._focusComposerEnd();
		}
		// 触发 input 事件以更新自动高度与发送按钮状态
		root.dispatchEvent(new Event('input'));
	}

protected override _createReadOnlyAttachmentChip(att: IChatAttachment): HTMLElement {
		const chip = document.createElement('span');
		chip.className = 'inline-attachment-chip message-attachment-chip';
		chip.dataset.attId = att.id;
		chip.setAttribute('contenteditable', 'false');

		const icon = document.createElement('span');
		icon.className = 'inline-attachment-chip-icon';
		icon.textContent = att.type === 'image' ? '\u{1F4F7}' : '\u{1F4C4}';
		chip.appendChild(icon);

		const label = document.createElement('span');
		label.className = 'inline-attachment-chip-label';
		label.textContent = att.name;
		chip.appendChild(label);

		if (att.type === 'image' && att.data) {
			this._register(addDisposableListener(chip, EventType.CLICK, () => {
				this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				this._showImageTooltip(att, chip);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_LEAVE, () => this._hideImageTooltip()));
		}
		return chip;
	}

protected override _renderAttachmentPreviews(): void {
		// no-op
	}

protected override _showLightbox(src: string): void {
		// Remove any existing lightbox
		document.querySelector('.chat-lightbox-overlay')?.remove();

		const overlay = document.createElement('div');
		overlay.className = 'chat-lightbox-overlay';

		const img = document.createElement('img');
		img.src = src;
		img.className = 'chat-lightbox-image';
		overlay.appendChild(img);

		const closeBtn = document.createElement('button');
		closeBtn.className = 'chat-lightbox-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', () => overlay.remove());
		overlay.appendChild(closeBtn);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { overlay.remove(); }
		});

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { overlay.remove(); }
		}, { once: true });

		document.body.appendChild(overlay);
	}

protected override _showImageTooltip(att: IChatAttachment, chip: HTMLElement): void {
		if (!att.data) { return; }
		this._hideImageTooltip();

		const tip = document.createElement('div');
		tip.className = 'inline-attachment-thumb-tip';

		const img = document.createElement('img');
		img.className = 'inline-attachment-thumb-tip-img';
		img.src = `data:${att.mimeType};base64,${att.data}`;
		tip.appendChild(img);

		const caption = document.createElement('div');
		caption.className = 'inline-attachment-thumb-tip-caption';
		caption.textContent = att.name;
		tip.appendChild(caption);

		this._imageTooltip = tip;
		document.body.appendChild(tip);

		const position = () => {
			const rect = chip.getBoundingClientRect();
			const tipRect = tip.getBoundingClientRect();
			let left = rect.left + rect.width / 2 - tipRect.width / 2;
			let top = rect.top - tipRect.height - 8;
			// 水平方向夹取到视口内
			left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
			// 若上方空间不足则翻转到 chip 下方
			if (top < 8) { top = rect.bottom + 8; }
			tip.style.left = `${Math.round(left)}px`;
			tip.style.top = `${Math.round(top)}px`;
		};
		// 图片加载完成后尺寸才确定，需重新定位
		if (img.complete) {
			position();
		} else {
			img.addEventListener('load', position, { once: true });
			// 兜底：若长时间未触发 load（如损坏图片），仍按默认尺寸定位
			setTimeout(position, 60);
		}
	}

protected override _hideImageTooltip(): void {
		if (this._imageTooltip) {
			this._imageTooltip.remove();
			this._imageTooltip = null;
		}
	}

override getAttachments(): ReadonlyArray<IChatAttachment> {
		return this._attachments;
	}

override clearAttachments(): void {
		this._attachments = [];
		this._renderAttachmentPreviews();
	}

override addFileContext(filePath: string, content: string): void {
		const fileName = filePath.split(/[\\/]/).pop() || filePath;
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name: fileName,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
			filePath,
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
	}

override addTextContext(name: string, content: string): void {
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name,
			mimeType: 'text/plain',
			data: content,
			size: content.length,
			isPasted: false,
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
	}

override injectPrompt(message: string): void {
		if (!this._textarea) { return; }
		this._setComposerText(message);
		this._textarea.dispatchEvent(new Event('input'));
		// Auto-send after a microtask so the textarea resize settles
		queueMicrotask(() => this._handleSendMessage());
	}
}
