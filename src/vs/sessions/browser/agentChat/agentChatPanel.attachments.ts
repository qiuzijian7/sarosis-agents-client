import { addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IChatAttachment } from './agentChatTypes.js';
import { AgentChatPanelMessages } from './agentChatPanel.messages.js';

/**
 * 文档类（需要「先转文本」才能被 LLM 读懂）的扩展名。
 *
 * 与主机侧 `KB_DOC_SOURCE_EXTENSIONS` 对齐；改这里时两边一起改（提取器不认的类型会被明确拒绝）。
 */
const DOCUMENT_EXTENSIONS = ['.pdf', '.epub', '.docx'];

/** 文本类扩展名（`file.type` 常为空 —— 例如某些来源拖入的 .md/.log ⇒ 不能只看 MIME）。 */
const TEXT_EXTENSIONS = [
	'.txt', '.md', '.markdown', '.json', '.jsonc', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
	'.log', '.csv', '.tsv', '.xml', '.html', '.htm', '.css', '.scss', '.less',
	'.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
	'.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.sh', '.ps1', '.bat', '.sql', '.vue', '.svelte',
];

/** 文件是否应按文本读取（MIME 优先，扩展名兜底）。 */
function isTextLikeFile(file: File): boolean {
	if (file.type.startsWith('text/')) { return true; }
	if (file.type === 'application/json' || file.type === 'application/xml') { return true; }
	const lower = file.name.toLowerCase();
	return TEXT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** 文件是否是需要「先转文本」的文档（pdf/epub/docx）。 */
function isDocumentFile(file: File): boolean {
	const lower = file.name.toLowerCase();
	return DOCUMENT_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/**
 * 取 `File` 对应的**本地绝对路径**（拿不到 ⇒ 空串）。
 *
 * 为什么不用 `file.path`：Electron ≥ 32 已移除该属性，改用 `webUtils.getPathForFile`
 * （本仓库 Electron 39）。走 `globalThis` 探测而不是 import globals：
 * 面板也可能跑在非 Electron 环境（web），直接 import `electron-browser/globals` 会因
 * 该模块顶层取全局而抛错。
 */
function resolveLocalFilePath(file: File): string {
	const utils = (globalThis as {
		vscode?: { webUtils?: { getPathForFile?: (f: File) => string } };
	}).vscode?.webUtils;
	try {
		return typeof utils?.getPathForFile === 'function' ? (utils.getPathForFile(file) || '') : '';
	} catch {
		return '';
	}
}

// Feature: attachments. Extracted from AgentChatPanelBase.
export class AgentChatPanelAttachments extends AgentChatPanelMessages {

protected override _handleFileSelection(): void {
		if (!this._fileInput?.files) { return; }
		this._addFiles(Array.from(this._fileInput.files));
		this._fileInput.value = ''; // reset so same file can be re-selected
	}

protected override _addFiles(files: File[], isPasted = false, pathByName?: Record<string, string>): void {
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
						filePath: pathByName?.[file.name],
					};
					const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
					if (currentTotal + file.size > MAX_TOTAL_SIZE) { return; }
					this._attachments.push(att);
					this._renderAttachmentPreviews();
					this._insertInlineAttachmentChip(att);
				}).catch(() => { /* ignore resize failures */ });
			} else if (isTextLikeFile(file)) {
				// ★ 2026-09-24：文本类**读原文**（此前与二进制一样走 readAsDataURL ⇒
				//   送给 LLM 的是一段 base64，模型还得自己解，纯属浪费上下文）。
				void file.text().then(
					text => this._pushFileAttachment(file, text, file.type || 'text/plain', isPasted, pathByName),
					() => { /* 读取失败：不静默 —— 下面 _attachDocumentText 之外的兜底由调用方日志可见 */ },
				);
			} else if (isDocumentFile(file)) {
				// ★ 2026-09-24（用户要求「epub/pdf/doc 能直接给 LLM 解读」）：文档类先**提取成文本**
				//   再作为文本附件送出；取不到路径/提取器不可用时给出可读提示，绝不 base64 内联。
				void this._attachDocumentText(file, isPasted, pathByName);
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
						filePath: pathByName?.[file.name],
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

	/**
	 * 文档（pdf/epub/docx）→ 文本附件。
	 *
	 * 三条分支都有明确出口，**不存在**「静默塞 base64」：
	 *   ① 有路径 + 注入了解析器 ⇒ 提取 Markdown，作为 `text/markdown` 文本附件；
	 *   ② 拿不到路径（粘贴/某些来源不给路径）⇒ 提示改用拖拽或走「知识库导入」；
	 *   ③ 提取失败/为空 ⇒ 附上**失败原因**（模型与用户都能看到，而不是一片空白）。
	 */
protected async _attachDocumentText(file: File, isPasted: boolean, pathByName?: Record<string, string>): Promise<void> {
		const filePath = resolveLocalFilePath(file) || pathByName?.[file.name] || '';
		const extract = this._extractDocumentText;
		if (!filePath || !extract) {
			this._pushFileAttachment(file, [
				`（未能提取文档「${file.name}」的正文：${filePath ? '当前环境不支持文档提取' : '拿不到文件路径'}。）`,
				'可改用**拖拽**把文件放进输入框；或先走「知识库 → 导入」把它转成笔记后再说。',
			].join('\n'), 'text/plain', isPasted, pathByName);
			return;
		}
		try {
			const text = await extract(filePath);
			if (!text || !text.trim()) {
				this._pushFileAttachment(file, `（文档「${file.name}」提取结果为空 —— 可能是扫描件/图片型文档。）`, 'text/plain', isPasted, pathByName);
				return;
			}
			this._pushFileAttachment(file, text, 'text/markdown', isPasted, pathByName);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			this._pushFileAttachment(file, `（提取文档「${file.name}」失败：${reason}）`, 'text/plain', isPasted, pathByName);
		}
	}

	/** 统一的「加入附件」出口（尺寸保护 + 渲染 chip）。`data` 为**文本或 base64**（由 mimeType 区分）。 */
protected _pushFileAttachment(file: File, data: string, mimeType: string, isPasted: boolean, pathByName?: Record<string, string>): void {
		const MAX_FILE_SIZE = 30 * 1024 * 1024;  // 30MB per file
		const MAX_TOTAL_SIZE = 30 * 1024 * 1024; // 30MB total
		// 文本附件按**文本长度**计入总量（LLM 的成本与上下文占用由它决定，而不是原始文件字节数）
		const size = data.length;
		if (size > MAX_FILE_SIZE) {
			// eslint-disable-next-line no-console
			console.warn(`[AgentChatPanel] Attachment too large after read: ${file.name} (${(size / 1024 / 1024).toFixed(1)}MB > ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB limit)`);
			return;
		}
		const currentTotal = this._attachments.reduce((sum, a) => sum + a.size, 0);
		if (currentTotal + size > MAX_TOTAL_SIZE) {
			// eslint-disable-next-line no-console
			console.warn(`[AgentChatPanel] Attachment total size limit reached; dropped: ${file.name}`);
			return;
		}
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'file',
			name: file.name,
			mimeType,
			data,
			size,
			isPasted,
			filePath: resolveLocalFilePath(file) || pathByName?.[file.name],
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
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
				const canvas = this._createEl('canvas');
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
		const spaceBefore = this._ownerDocument.createTextNode(' ');
		const spaceAfter = this._ownerDocument.createTextNode(' ');
		root.focus();
		const sel = this._ownerWindow?.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			range.deleteContents();
			const frag = this._ownerDocument.createDocumentFragment();
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
		const chip = this._createEl('span');
		chip.className = 'inline-attachment-chip message-attachment-chip';
		chip.dataset.attId = att.id;
		chip.setAttribute('contenteditable', 'false');

		const icon = this._createEl('span');
		icon.className = 'inline-attachment-chip-icon';
		icon.textContent = this._attachmentChipIcon(att);
		chip.appendChild(icon);

		const label = this._createEl('span');
		label.className = 'inline-attachment-chip-label';
		label.textContent = this._attachmentChipLabel(att);
		chip.appendChild(label);

		// 代码 / 日志片段：追加行数（与可编辑 chip 一致）
		if (att.kind && att.data) {
			const meta = this._createEl('span');
			meta.className = 'inline-attachment-chip-meta';
			meta.textContent = `${att.data.split(/\r\n|\r|\n/).length} 行`;
			chip.appendChild(meta);
		}

		// 点击 chip：有系统路径的资源在文件编辑器中打开；图片（含无路径的粘贴图）
		// 回退到 lightbox；文件夹除外（无对应资源可打开）。
		if (att.type !== 'folder') {
			this._register(addDisposableListener(chip, EventType.CLICK, () => {
				if (att.filePath && this._onOpenFile) {
					this._onOpenFile(att.filePath);
				} else if (att.type === 'image' && att.data) {
					this._showLightbox(`data:${att.mimeType};base64,${att.data}`);
				}
			}));
		}
		if (att.type === 'image' && att.data) {
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				this._showImageTooltip(att, chip);
			}));
			this._register(addDisposableListener(chip, EventType.MOUSE_LEAVE, () => this._hideImageTooltip()));
		}
		if (att.kind && att.data) {
			this._register(addDisposableListener(chip, EventType.MOUSE_ENTER, () => {
				this._showSnippetTooltip(att, chip);
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
		this._ownerDocument.querySelector('.chat-lightbox-overlay')?.remove();

		const overlay = this._createEl('div');
		overlay.className = 'chat-lightbox-overlay';

		const img = this._createEl('img');
		img.src = src;
		img.className = 'chat-lightbox-image';
		overlay.appendChild(img);

		const closeBtn = this._createEl('button');
		closeBtn.className = 'chat-lightbox-close';
		closeBtn.textContent = '✕';
		closeBtn.addEventListener('click', () => overlay.remove());
		overlay.appendChild(closeBtn);

		overlay.addEventListener('click', (e) => {
			if (e.target === overlay) { overlay.remove(); }
		});

		this._ownerDocument.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') { overlay.remove(); }
		}, { once: true });

		this._ownerDocument.body.appendChild(overlay);
	}

protected override _showImageTooltip(att: IChatAttachment, chip: HTMLElement): void {
		if (!att.data) { return; }
		this._hideImageTooltip();

		const tip = this._createEl('div');
		tip.className = 'inline-attachment-thumb-tip';

		const img = this._createEl('img');
		img.className = 'inline-attachment-thumb-tip-img';
		img.src = `data:${att.mimeType};base64,${att.data}`;
		tip.appendChild(img);

		const caption = this._createEl('div');
		caption.className = 'inline-attachment-thumb-tip-caption';
		caption.textContent = att.name;
		tip.appendChild(caption);

		this._imageTooltip = tip;
		this._ownerDocument.body.appendChild(tip);

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
