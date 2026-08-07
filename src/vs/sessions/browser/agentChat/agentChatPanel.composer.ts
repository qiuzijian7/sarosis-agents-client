import { $, append, clearNode, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IChatAttachment, IContextUsage } from './agentChatTypes.js';
import { renderContextUsageRing } from './modules/contextRing.js';
import { AgentChatPanelMarkdown } from './agentChatPanel.markdown.js';

/** 内部剪贴板格式：选区含 chip 时用自定义 MIME 保存结构化内容（文本+技能+附件），
 *  粘贴时据此恢复 chip，避免 contenteditable=false 的 chip 被浏览器序列化成纯文本。 */
const COMPOSER_CLIPBOARD_MIME = 'application/vnd.vssaros-composer';

/** 选区剪贴板片段：文本 / 技能 chip / 附件（图片）chip。 */
interface IComposerClipSegment {
	type: 'text' | 'skill' | 'attachment';
	text?: string;
	id?: string;                  // skill id
	attId?: string;               // attachment id（序列化前）
	name?: string;                // attachment 文件名
	mimeType?: string;
	data?: string;                // base64
	size?: number;
	attType?: 'image' | 'file';
	isPasted?: boolean;
	filePath?: string;
}

// Feature: composer. Extracted from AgentChatPanelBase.
export class AgentChatPanelComposer extends AgentChatPanelMarkdown {

protected override _renderInputArea(): void {
		const emp = this._agent!;

		// Resize handle — drag to adjust composer height (placed above input area)
		// 已存在则跳过（_refreshInputArea 重复调用时不重建）
		let resizeHandle = this._container.querySelector('.composer-resize-handle') as HTMLElement | null;
		if (!resizeHandle) {
			resizeHandle = append(this._container, $(".composer-resize-handle"));
		}
		this._register(addDisposableListener(resizeHandle, EventType.MOUSE_DOWN, (downEv: MouseEvent) => {
			downEv.preventDefault();
			const startY = downEv.clientY;
			const startH = this._textarea?.offsetHeight ?? this._resizeMaxH;
			const onMove = (moveEv: MouseEvent) => {
				const newH = Math.max(60, Math.min(800, startH + (startY - moveEv.clientY)));
				this._resizeMaxH = newH;
				this._userHasAdjustedHeight = true; // 标记用户已调整过高度
				if (this._textarea) { this._textarea.style.height = `${newH}px`; }
				// 保存用户调整的高度到 localStorage
				try {
					localStorage.setItem('agentChatComposerHeight', newH.toString());
				} catch {
					// localStorage 不可用时忽略
				}
			};
			const onUp = () => {
				document.removeEventListener('mousemove', onMove);
				document.removeEventListener('mouseup', onUp);
			};
			document.addEventListener('mousemove', onMove);
			document.addEventListener('mouseup', onUp);
		}));


		// ── Tabbed panel（替代 system bar + queue bar）──
		this._tabbedPanel.createDom();

		const inputArea = append(this._container, $(".chat-input-area"));
		this._inputAreaEl = inputArea;

		// Composer box
		const composerBox = append(inputArea, $(".chat-composer-box"));

		// ContentEditable div（替代 textarea，支持文本+内联附件芯片混排）
		// 注意：skill chips 已改为内联芯片（span.inline-skill-chip），直接插入本 div 的文本流中，
		// 不再有独立的 chips bar。
		this._textarea = append(
			composerBox,
			$("div.chat-composer-textarea"),
		) as HTMLElement;
		this._textarea.setAttribute('contenteditable', 'true');
		this._textarea.setAttribute('tabindex', '0');
		this._textarea.setAttribute('data-placeholder', `Message ${emp.name}...`);
		this._textarea.setAttribute('role', 'textbox');
		this._textarea.setAttribute('aria-multiline', 'true');
		this._textarea.setAttribute('aria-label', `Message ${emp.name}...`);
		// 流式输出过程中不再禁用输入框——用户可继续输入新消息排队
		// this._textarea.disabled = this._isSending;  ← 已移除

		// 防御修复：流式期间 DOM 更新可能破坏 contentEditable 状态。
		// 每次用户点击/mousedown 显式确保 contentEditable=true + tabIndex=0。
		this._register(addDisposableListener(this._textarea, EventType.MOUSE_DOWN, () => {
			if (this._textarea.getAttribute('contenteditable') !== 'true') {
				this._textarea.setAttribute('contenteditable', 'true');
			}
			if (!this._textarea.hasAttribute('tabindex')) {
				this._textarea.setAttribute('tabindex', '0');
			}
		}));

		// 恢复保存的输入框高度
		try {
			const savedHeight = localStorage.getItem('agentChatComposerHeight');
			if (savedHeight) {
				const height = parseInt(savedHeight, 10);
				if (!isNaN(height) && height >= 60 && height <= 800) {
					this._resizeMaxH = height;
					this._userHasAdjustedHeight = true;
					this._textarea.style.height = `${height}px`;
				}
			}
		} catch {
			// localStorage 不可用时忽略
		}

		// Auto-resize + slash command detection + slash menu + mention
		this._register(
			addDisposableListener(this._textarea, EventType.INPUT, () => {
				const t = this._textarea;
				// 保存消息区滚动位置：输入框高度变化会挤压 flex 布局的消息区，
				// 浏览器自动调整 scrollTop 导致滚动条跳动。保存后恢复即可避免。
				const savedScrollTop = this._messagesContainer?.scrollTop ?? 0;
				t.style.height = "auto";
				const maxAllowed = 320;
				const newHeight = this._userHasAdjustedHeight
					? Math.min(Math.max(t.scrollHeight, this._resizeMaxH), maxAllowed)
					: Math.min(t.scrollHeight, this._resizeMaxH);
				t.style.height = newHeight + "px";
				if (this._messagesContainer && this._messagesContainer.scrollTop !== savedScrollTop) {
					this._messagesContainer.scrollTop = savedScrollTop;
				}

				// 获取纯文本（排除内联附件芯片内容）
				const val = this._getComposerText();

				// Detect /skill /command patterns — show slash menu
				const slashMatch = val.match(/^\/(\w*)$/);
				if (slashMatch) {
					t.style.color = 'var(--ec-accent, #60a5fa)';
					t.setAttribute('data-slash-command', slashMatch[1]);
					const filter = slashMatch[1];
					if (this._slashMenuEl) {
						this._renderSlashMenuItems(filter);
					} else {
						this._openSlashMenu(filter);
					}
				} else {
					t.style.color = '';
					t.removeAttribute('data-slash-command');
					this._closeSlashMenu();
				}

				// P0-2: @mention 文件搜索检测
				const cursorPos = this._getCaretOffset();
				const beforeCursor = val.slice(0, cursorPos);
				const atMatch = beforeCursor.match(/@(\w[^\s]*)$/);
				if (atMatch && this._onSearchFiles) {
					const query = atMatch[1];
					if (query !== this._mentionQuery) {
						this._mentionQuery = query;
						this._scheduleMentionSearch(query);
					}
				} else {
					this._closeMentionMenu();
				}

			// 更新字符计数器
			this._updateCharCounter(val);

			// 草稿持久化钩子（per-session，pane 侧 debounce 落 localStorage）
			this._onComposerTextChange?.(val);
		}),
	);


		// Hidden file input (for attach button + paste)
		this._fileInput = append(this._container, $("input.chat-file-input")) as HTMLInputElement;
		this._fileInput.type = "file";
		this._fileInput.multiple = true;
		this._fileInput.accept = "image/*,.txt,.md,.json,.js,.ts,.py,.go,.rs,.java,.cs,.html,.css";
		this._fileInput.style.display = "none";
		this._fileInput.addEventListener("change", () => this._handleFileSelection());

		// Drag & drop — 全聊天区域拖放（文件 + 代码选择）
		// 参考 Void SidebarChat 的拖放支持，扩展为整个聊天面板
		// 已存在则跳过（_refreshInputArea 重复调用时不重建 overlay 和事件监听器）
		if (this._container.querySelector('.chat-drag-overlay')) {
			// overlay 已存在，跳过创建
		} else {
		const dragOverlay = append(this._container, $('.chat-drag-overlay'));
		dragOverlay.style.display = 'none';
		let dragCounter = 0;
		this._register(addDisposableListener(this._container, 'dragenter', (e: DragEvent) => {
			e.preventDefault();
			dragCounter++;
			dragOverlay.style.display = 'flex';
		}));
		this._register(addDisposableListener(this._container, 'dragover', (e: DragEvent) => {
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		}));
		this._register(addDisposableListener(this._container, 'dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) { dragCounter = 0; dragOverlay.style.display = 'none'; }
		}));
		this._register(addDisposableListener(this._container, 'drop', (e: DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			dragCounter = 0;
			dragOverlay.style.display = 'none';
			const dt = e.dataTransfer;
			if (!dt) { return; }
			// 1. OS 文件拖放
			if (dt.files && dt.files.length > 0) {
				this._addFiles(Array.from(dt.files));
				return;
			}
			// 2. 代码/文本拖放（从编辑器选中代码拖入）
			const text = dt.getData('text/plain');
			if (text && text.trim().length > 0) {
				const att: IChatAttachment = {
					id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					type: 'file',
					name: `code-snippet.txt`,
					mimeType: 'text/plain',
					data: text,
					size: text.length,
					isPasted: false,
				};
				this._attachments.push(att);
				this._renderAttachmentPreviews();
				this._insertInlineAttachmentChip(att);
			}
		}));
		} // end else (drag overlay 已存在则跳过)

		// Paste handling — 文本走「格式化粘贴」（去除样式），图片/文件保持 chip 显示
		this._register(addDisposableListener(this._textarea, EventType.PASTE, (e) => {
			const clipboardData = (e as ClipboardEvent).clipboardData;
			if (!clipboardData) { return; }

			// 内部复制/剪切带 chip 的内容 → 恢复 chip（图片/技能），避免退化成纯文本
			const composerClip = clipboardData.getData(COMPOSER_CLIPBOARD_MIME);
			if (composerClip) {
				try {
					const parsed = JSON.parse(composerClip) as { v?: number; segments?: IComposerClipSegment[] };
					if (parsed && Array.isArray(parsed.segments) && parsed.segments.length) {
						e.preventDefault();
						this._restoreComposerPaste(parsed.segments);
						return;
					}
				} catch { /* 损坏的自定义数据 → 走默认逻辑 */ }
			}

			// 收集所有图片文件。复制的图片（截图、从图片软件复制等）通常以
			// clipboardData.items 中 kind==='file' 的形式存在，此时 clipboardData.files 为空；
			// 而从文件管理器/拖拽复制则在 files 中。两者都要覆盖，否则图片 chip 不显示。
			const imageFiles: File[] = [];
			if (clipboardData.files?.length) {
				for (const f of Array.from(clipboardData.files)) {
					if (f.type.startsWith("image/")) { imageFiles.push(f); }
				}
			}
			if (!imageFiles.length && clipboardData.items?.length) {
				for (const it of Array.from(clipboardData.items)) {
					if (it.kind === 'file' && it.type.startsWith("image/")) {
						const f = it.getAsFile();
						if (f) { imageFiles.push(f); }
					}
				}
			}

			// 有图片 → 保持本地图片 chip 显示（原逻辑），不做格式化、不受影响
			if (imageFiles.length > 0) {
				e.preventDefault();
				this._addFiles(imageFiles, true);
				return;
			}

			// 纯文本 / 富文本 → 格式化粘贴：剥离样式，只插入纯文本（不展示样式）。
			// 图片/文件 chip 由上面分支处理，本分支不会影响其显示。
			e.preventDefault();
			let plain = clipboardData.getData('text/plain');
			if (!plain) {
				const html = clipboardData.getData('text/html');
				if (html) { plain = html.replace(/<[^>]+>/g, ''); }
			}
			if (plain) {
				this._insertTextAtCaret(plain);
			}
		}));

		// Copy/Cut handling — 选区含 chip（技能/图片附件）时，浏览器默认会把
		// contenteditable=false 的 chip 序列化成纯文本（图标+名字），图片信息丢失。
		// 改为写入自定义剪贴板格式（含完整 base64 与技能 id），粘贴时恢复 chip。
		this._register(addDisposableListener(this._textarea, 'copy', (e) => {
			this._handleComposerCopyCut(e as ClipboardEvent, false);
		}));
		this._register(addDisposableListener(this._textarea, 'cut', (e) => {
			this._handleComposerCopyCut(e as ClipboardEvent, true);
		}));

		// Attachment preview area — 已移至内联芯片模式（附件直接嵌入 contentEditable 文本流中）
		// 旧 .chat-attachment-bar 不再需要，保留 class 选择器兼容旧逻辑

		// Enter to send / slash menu navigation
		this._register(
			addDisposableListener(
				this._textarea,
				EventType.KEY_DOWN,
				(e: KeyboardEvent) => {
					// Slash menu open: handle navigation keys
					if (this._slashMenuEl) {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							this._slashMenuIndex++;
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'ArrowUp') {
							e.preventDefault();
							this._slashMenuIndex = Math.max(0, this._slashMenuIndex - 1);
							this._highlightSlashMenuItem();
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							this._selectSlashMenuItem();
							return;
						}
					}
					// P0-2: @mention menu navigation
					if (this._mentionEl) {
						if (e.key === 'ArrowDown') {
							e.preventDefault();
							this._mentionIndex = Math.min(this._mentionResults.length - 1, this._mentionIndex + 1);
							this._highlightMentionItem();
							return;
						}
						if (e.key === 'ArrowUp') {
							e.preventDefault();
							this._mentionIndex = Math.max(0, this._mentionIndex - 1);
							this._highlightMentionItem();
							return;
						}
						if (e.key === 'Enter') {
							e.preventDefault();
							this._selectMentionItem();
							return;
						}
					}
					if (e.key === 'Escape') {
						e.preventDefault();
						if (this._slashMenuEl) {
							this._closeSlashMenu();
						} else if (this._mentionEl) {
							this._closeMentionMenu();
						} else if (this._isSending && this._onCancelExecution) {
							this._onCancelExecution();
						}
						return;
					}

				// Backspace: if cursor is right after an inline chip (attachment / skill), delete the chip
				if (e.key === 'Backspace') {
					const sel = window.getSelection();
					if (sel && sel.rangeCount > 0) {
						const range = sel.getRangeAt(0);
						const container = range.startContainer;
						const offset = range.startOffset;
						// 找到光标前紧邻的「有效节点」（跳过纯空白文本节点）
						let prevNode: Node | null = null;
						if (container.nodeType === Node.ELEMENT_NODE) {
							prevNode = container.childNodes[offset - 1] ?? null;
							// 若前一个是空白文本节点且再前一个是芯片，则定位到芯片（删除芯片）
							if (prevNode && prevNode.nodeType === Node.TEXT_NODE && /^\s*$/.test(prevNode.textContent ?? '') && offset - 2 >= 0) {
								const beforeThat = container.childNodes[offset - 2];
								if (beforeThat && (beforeThat as HTMLElement).classList?.contains('inline-attachment-chip')) {
									prevNode = beforeThat;
								}
							}
						} else if (container.nodeType === Node.TEXT_NODE && offset === 0) {
							prevNode = container.previousSibling;
						}
						if (prevNode && prevNode.nodeType === Node.ELEMENT_NODE) {
							const prevEl = prevNode as HTMLElement;
							if (prevEl.classList.contains('inline-attachment-chip')) {
								e.preventDefault();
								const attId = prevEl.dataset.attId;
								if (attId) {
									this._attachments = this._attachments.filter(a => a.id !== attId);
									prevEl.remove();
									this._updateSendButton();
								}
								return;
							}
							if (prevEl.classList.contains('inline-skill-chip')) {
								e.preventDefault();
								prevEl.remove();
								this._updateSendButton();
								return;
							}
						}
					}
				}

					// ── 编辑快捷键（contentEditable 内优先于 VS Code 宿主 keybinding）──
					// Ctrl+A：全选（选区覆盖整个 contentEditable 文本）
					if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
						e.preventDefault();
						e.stopPropagation();
						const sel = window.getSelection();
						const textarea = this._textarea;
						if (sel && textarea) {
							const range = document.createRange();
							range.selectNodeContents(textarea);
							sel.removeAllRanges();
							sel.addRange(range);
						}
						return;
					}
					// Ctrl+Z：撤销
					if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
						e.preventDefault();
						e.stopPropagation();
						document.execCommand('undo');
						return;
					}
					// Ctrl+Y / Ctrl+Shift+Z：重做
					if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
						e.preventDefault();
						e.stopPropagation();
						document.execCommand('redo');
						return;
					}
					// Ctrl+C / Ctrl+X：复制 / 剪切（contentEditable 内让浏览器默认行为生效，但要阻止 VS Code 捕获）
					if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'x' || e.key === 'v')) {
						// Ctrl+V 已有独立 PASTE 监听器处理格式化粘贴 / 图片 chip，此处不拦截
						// Ctrl+C / Ctrl+X 只用 stopPropagation 阻止 VS Code 宿主捕获，让浏览器默认行为生效
						if (e.key === 'c' || e.key === 'x') {
							e.stopPropagation(); // 阻止 VS Code 宿主 keybinding 拦截
						}
						// 不调 preventDefault，保留浏览器默认行为
						return;
					}

					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						this._handleSendMessage();
					}
				},
			),
		);

		// Toolbar
		const toolbar = append(composerBox, $(".chat-composer-toolbar"));
		const leftToolbar = append(toolbar, $(".chat-toolbar-left"));

		// Attach button — triggers file input dialog
		const attachBtn = this._appendToolbarBtn(leftToolbar, {
			title: "上传附件",
			svgPath:
				"M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13",
		});
		this._register(addDisposableListener(attachBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._fileInput?.click();
		}));

		// P1-3: 添加编辑器选中代码作为上下文
		const selectionBtn = this._appendToolbarBtn(leftToolbar, {
			title: "添加选中代码到聊天",
			svgPath: "M9 2h6a1 1 0 011 1v6h6a1 1 0 011 1v6a1 1 0 01-1 1h-6v6a1 1 0 01-1 1H9a1 1 0 01-1-1v-6H2a1 1 0 01-1-1V10a1 1 0 011-1h6V3a1 1 0 011-1z",
		});
		this._register(addDisposableListener(selectionBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			this._onAddSelectionToChat?.();
		}));

		// Voice button
		this._appendToolbarBtn(leftToolbar, {
			title: "语音输入",
			svgPath:
				"M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4M8 23h8",
		});

		// Divider
		append(leftToolbar, $(".chat-toolbar-divider"));

		// ── 工作区选择器（左侧） ──
		const wsLabel = this._workspaces.find(w => w.id === this._selectedWorkspaceId)?.name ||
			this._workspaces[0]?.name || '工作区';
		const workspaceBtn = this._appendToolbarBtn(leftToolbar, {
			title: '切换工作区',
			svgPath: 'M20.5 5.5H3.5a1 1 0 00-1 1v13a1 1 0 001 1h17a1 1 0 001-1v-13a1 1 0 00-1-1zM2 8.5h20M9 2.5v3M15 2.5v3',
			hasLabel: true,
			label: wsLabel,
			showChevron: true,
			cssClass: 'workspace-tag',
		});
		this._workspaceTrigger = workspaceBtn;
		this._register(addDisposableListener(workspaceBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._workspaceDropdownEl) {
				this._closeWorkspaceDropdown();
			} else {
				this._openWorkspaceDropdown();
			}
		}));

		// ── Worktree 选择器（右侧） ──
		const wtLabel = this._getWorktreeLabel();
		const worktreeBtn = this._appendToolbarBtn(leftToolbar, {
			title: '切换 Worktree',
			svgPath: 'M6 3v12M18 9v12M6 21l12-12',
			hasLabel: true,
			label: wtLabel,
			showChevron: true,
			cssClass: 'worktree-tag',
		});
		this._worktreeTrigger = worktreeBtn;
		this._register(addDisposableListener(worktreeBtn, EventType.CLICK, (e) => {
			e.stopPropagation();
			if (this._worktreeDropdownEl) {
				this._closeWorktreeDropdown();
			} else {
				this._openWorktreeDropdown();
			}
		}));

		// Divider
		append(leftToolbar, $(".chat-toolbar-divider"));

		// ChatOnly toggle (替代旧 chatMode 选择器，默认关闭)
		this._modeTrigger = this._appendToolbarBtn(leftToolbar, {
			title: this._chatOnly ? '纯聊模式：已开启（禁止工具执行）' : '干活模式：点击切换至纯聊',
			svgPath: this._chatOnly
				? 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z'
				: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
			hasLabel: true,
			label: this._chatOnly ? '纯聊' : '干活',
			showChevron: false,
			cssClass: this._chatOnly ? 'mode-tag mode-tag-chatonly-on' : 'mode-tag',
		});
		this._register(
			addDisposableListener(this._modeTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._chatOnly = !this._chatOnly;
				this._refreshInputArea();
			}),
		);

		// Provider chip
		this._providerTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择 Provider",
			svgPath: "M2 3h20v14H2zM8 21h8M12 17v4",
			hasLabel: true,
			label: this._providers.find(p => p.id === this._currentProvider)?.label || this._currentProvider || "Provider",
			showChevron: true,
			cssClass: "provider-tag",
		});
		this._register(
			addDisposableListener(this._providerTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._providerDropdownEl) {
					this._closeProviderDropdown();
				} else {
					this._openProviderDropdown();
				}
			}),
		);

		// Agent chip — only show when current provider supports agents (e.g. knot)
		const currentProviderInfo = this._providers.find(p => p.id === this._currentProvider);
		const supportsAgents = !!currentProviderInfo?.supportsAgents;
		
		if (supportsAgents) {
			const agentTag = this._appendToolbarBtn(leftToolbar, {
				title: '切换 Agent',
				svgPath: 'M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2M12 11a4 4 0 100-8 4 4 0 000 8z',
				hasLabel: true,
				label: this._agent?.name || 'Agent',
				showChevron: true,
				cssClass: 'agent-tag',
			});
			this._register(
				addDisposableListener(agentTag, EventType.CLICK, (e) => {
					e.stopPropagation();
					if (this._dropdownOpen) {
						this._closeAgentDropdown();
					} else {
						this._openAgentDropdown();
					}
				}),
			);
		}

		// Model chip
		this._modelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择模型",
			svgPath: "M4 17l6-6-6-6M12 19h8",
			hasLabel: true,
			label: this._models.find(m => m.id === this._currentModel)?.label || this._currentModel || "Model",
			showChevron: true,
			cssClass: "model-tag",
		});
		this._register(
			addDisposableListener(this._modelTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modelDropdownEl) {
					this._closeModelDropdown();
				} else {
					this._openModelDropdown();
				}
			}),
		);

		// Right wrap: context-usage ring + char counter + send circle
		const rightWrap = append(toolbar, $(".provider-model-chip-wrap"));
		this._renderContextUsageRing(rightWrap);

		// 字符计数器（在发送按钮左侧）
		this._charCounterEl = append(rightWrap, $('span.chat-char-counter'));

		// Send / Cancel button
		this._sendBtn = append(
			rightWrap,
			$(`.chat-send-circle${this._isSending ? ".chat-cancel-circle" : ""}`),
		);
		this._renderSendButtonSvg();
		this._register(
			addDisposableListener(this._sendBtn, EventType.CLICK, () => {
				if (this._isSending) {
					// 参考React：有输入/附件时发送新消息（自动停止当前），无输入时取消
				if (this._getComposerText().trim() || this._attachments.length > 0) {
					this._handleSendMessage();
					} else {
						this._onCancelExecution();
					}
				} else {
					this._handleSendMessage();
				}
			}),
		);
	}

protected override _appendToolbarBtn(
		parent: HTMLElement,
		opts: {
			title: string;
			svgPath: string;
			extraSvgElements?: SVGElement[];
			hasLabel?: boolean;
			label?: string;
			showChevron?: boolean;
			cssClass?: string;
		},
	): HTMLElement {
		const btn = append(
			parent,
			$(
				`.chat-toolbar-btn${opts.hasLabel ? ".has-label" : ""}${opts.cssClass ? "." + opts.cssClass : ""}`,
			),
		);
		btn.title = opts.title;

		// Extra SVG elements (like the globe for web search)
		if (opts.extraSvgElements) {
			const wrapper = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			wrapper.setAttribute("width", "16");
			wrapper.setAttribute("height", "16");
			wrapper.setAttribute("viewBox", "0 0 24 24");
			wrapper.setAttribute("fill", "none");
			wrapper.setAttribute("stroke", "currentColor");
			wrapper.setAttribute("stroke-width", "2");
			wrapper.setAttribute("stroke-linecap", "round");
			wrapper.setAttribute("stroke-linejoin", "round");
			// Append pre-created SVG elements (avoids TrustedHTML issues)
			for (const el of opts.extraSvgElements) {
				wrapper.appendChild(el);
			}
			btn.appendChild(wrapper);
		}

		// Main SVG
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
		path.setAttribute("d", opts.svgPath);
		svg.appendChild(path);
		btn.appendChild(svg);

		// Label
		if (opts.hasLabel && opts.label) {
			const labelEl = append(btn, $("span.toolbar-btn-label"));
			labelEl.textContent = opts.label;
		}

		// Chevron
		if (opts.showChevron) {
			const chevron = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			chevron.setAttribute("width", "10");
			chevron.setAttribute("height", "10");
			chevron.setAttribute("viewBox", "0 0 24 24");
			chevron.setAttribute("fill", "none");
			chevron.setAttribute("stroke", "currentColor");
			chevron.setAttribute("stroke-width", "2.5");
			const chevronPath = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			chevronPath.setAttribute("d", "M6 9l6 6 6-6");
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}

		return btn;
	}

protected override _renderSendButtonSvg(): void {
		clearNode(this._sendBtn);
		const hasInput = !!(this._getComposerText().trim() || this._attachments.length > 0);
		const isQueueing = this._isSending && hasInput;

		if (isQueueing) {
			// Queue icon — 双层堆叠文档（表示"追加到队列"）
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			// 下层文档
			const outer = document.createElementNS("http://www.w3.org/2000/svg", "path");
			outer.setAttribute("d", "M4 5h12l4 4v12H4z");
			svg.appendChild(outer);
			// 上层文档（偏移）
			const inner = document.createElementNS("http://www.w3.org/2000/svg", "path");
			inner.setAttribute("d", "M2 4h12l4 4v12H2z");
			svg.appendChild(inner);
			// 加号
			const plus = document.createElementNS("http://www.w3.org/2000/svg", "line");
			plus.setAttribute("x1", "12"); plus.setAttribute("y1", "8");
			plus.setAttribute("x2", "12"); plus.setAttribute("y2", "16");
			plus.setAttribute("stroke-width", "3");
			svg.appendChild(plus);
			const plusH = document.createElementNS("http://www.w3.org/2000/svg", "line");
			plusH.setAttribute("x1", "8"); plusH.setAttribute("y1", "12");
			plusH.setAttribute("x2", "16"); plusH.setAttribute("y2", "12");
			plusH.setAttribute("stroke-width", "3");
			svg.appendChild(plusH);
			this._sendBtn.appendChild(svg);
		} else if (this._isSending) {
			// Stop icon — 使用与发送箭头相同 14x14 尺寸，方块填充 viewBox 核心区域
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "currentColor");
			const rect = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"rect",
			);
			rect.setAttribute("x", "4");
			rect.setAttribute("y", "4");
			rect.setAttribute("width", "16");
			rect.setAttribute("height", "16");
			rect.setAttribute("rx", "3");
			svg.appendChild(rect);
			this._sendBtn.appendChild(svg);
		} else {
			// Arrow up icon
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "12");
			svg.setAttribute("height", "12");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			const line = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"line",
			);
			line.setAttribute("x1", "12");
			line.setAttribute("y1", "19");
			line.setAttribute("x2", "12");
			line.setAttribute("y2", "5");
			svg.appendChild(line);
			const polyline = document.createElementNS(
				"http://www.w3.org/2000/svg",
				"polyline",
			);
			polyline.setAttribute("points", "5 12 12 5 19 12");
			svg.appendChild(polyline);
			this._sendBtn.appendChild(svg);
		}
	}

protected override _updateSendButton(): void {
		if (!this._sendBtn) {
			return;
		}
		const text = this._getComposerText();
		const hasInput = !!(text.trim() || this._attachments.length > 0);

		// 流式输出过程中有输入内容 → 显示为「排队发送」按钮，不是「取消」按钮
		const isQueueing = this._isSending && hasInput;
		this._sendBtn.classList.toggle("chat-cancel-circle", this._isSending && !hasInput);
		this._sendBtn.classList.toggle("chat-queue-circle", isQueueing);

		// 流式输出过程中不再禁用输入框 (textarea.disabled 已在 _renderInputArea 移除)
		// 按钮禁用逻辑：无输入且非发送中 → 禁用
		const disabled = !hasInput && !this._isSending;
		(this._sendBtn as HTMLButtonElement).disabled = disabled;

		// 更新按钮标题
		if (isQueueing) {
			this._sendBtn.title = '排队发送 (Enter)';
		} else if (this._isSending) {
			this._sendBtn.title = '停止生成 (Escape)';
		} else {
			this._sendBtn.title = '发送 (Enter)';
		}

		// 更新字符计数器
		this._updateCharCounter(text);

		this._renderSendButtonSvg();
	}

protected override _renderSessionInfo(): void {
		const info = this._sessionInfo!;
		const bar = append(this._container, $(".chat-session-info"));

		const modeBadge = append(bar, $(`.chat-mode-badge.mode-${info.mode}`));
		modeBadge.textContent = info.mode === 'craft' ? 'Craft' : info.mode === 'ask' ? 'Ask' : 'Plan';

		const hierarchy = append(bar, $(".session-info-hierarchy"));
		if (info.superior) {
			append(hierarchy, $("span.hierarchy-label", undefined, '上级'));
			append(hierarchy, $("span.hierarchy-agent", undefined, info.superior.name));
			if (info.subordinates && info.subordinates.length > 0) {
				append(hierarchy, $("span.hierarchy-comma", undefined, ' · '));
			}
		}
		if (info.subordinates && info.subordinates.length > 0) {
			append(hierarchy, $("span.hierarchy-label", undefined, '下级'));
			const names = info.subordinates.map(s => s.name).join('、');
			append(hierarchy, $("span.hierarchy-agent", undefined, names));
		}
		if (!info.superior && (!info.subordinates || info.subordinates.length === 0)) {
			append(hierarchy, $("span.hierarchy-label", undefined, '独立会话'));
		}

		const tasks = append(bar, $(".session-info-tasks"));
		tasks.textContent = `任务 ${info.taskCount}`;
	}

protected override _scheduleMentionSearch(query: string): void {
		if (this._mentionSearchTimer !== null) { clearTimeout(this._mentionSearchTimer); }
		// 300ms 防抖——参考 Void util/inputs.tsx L525-551
		this._mentionSearchTimer = window.setTimeout(async () => {
			this._mentionSearchTimer = null;
			if (!this._onSearchFiles) { return; }
			try {
				const results = await this._onSearchFiles(query);
				this._mentionResults = results.slice(0, 10);
				if (this._mentionResults.length > 0) {
					this._openMentionMenu();
				} else {
					this._closeMentionMenu();
				}
			} catch { /* ignore */ }
		}, 300) as unknown as number;
	}

	protected override _openMentionMenu(): void {
		this._closeMentionMenu();
		if (!this._textarea || this._mentionResults.length === 0) { return; }

		const rect = this._textarea.getBoundingClientRect();
		this._mentionEl = document.createElement('div');
		this._mentionEl.className = 'mention-menu';
		this._mentionEl.style.left = `${rect.left}px`;
		this._mentionEl.style.maxWidth = `${Math.max(rect.width, 320)}px`;
		// 智能定位：优先贴在 textarea 上方，空间不足则翻转到下方。
		// popout 独立窗口高度可能远小于主窗口，force above 会导致 dropdown
		// 超出视口顶部完全不可见（position:fixed 不会产生 body 滚动条）。
		this._positionDropdownRelativeTo(this._mentionEl, rect, 280);

		const list = document.createElement('div');
		list.className = 'mention-menu-list';
		this._mentionResults.forEach((r, i) => {
			const item = document.createElement('div');
			item.className = 'mention-menu-item';
			item.dataset.path = r.path;
			const icon = document.createElement('span');
			icon.className = 'mention-menu-item-icon';
			icon.textContent = '📄';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'mention-menu-item-info';
			const name = document.createElement('span');
			name.className = 'mention-menu-item-name';
			name.textContent = r.name;
			info.appendChild(name);
			const path = document.createElement('span');
			path.className = 'mention-menu-item-path';
			path.textContent = r.path;
			info.appendChild(path);
			item.appendChild(info);
			item.addEventListener('click', () => {
				this._mentionIndex = i;
				this._selectMentionItem();
			});
			list.appendChild(item);
		});

		this._mentionEl.appendChild(list);
		document.body.appendChild(this._mentionEl);
		this._mentionIndex = 0;
		this._highlightMentionItem();
	}

protected override _highlightMentionItem(): void {
		const items = this._mentionEl?.querySelectorAll('.mention-menu-item');
		if (!items?.length) { return; }
		items.forEach((el, i) => el.classList.toggle('selected', i === this._mentionIndex));
		const selected = items[this._mentionIndex] as HTMLElement | undefined;
		if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
	}

protected override _selectMentionItem(): void {
		if (!this._mentionEl || this._mentionIndex >= this._mentionResults.length) { return; }
		const selected = this._mentionResults[this._mentionIndex];
		if (!selected) { return; }

		// 替换 contentEditable 中的 @query 为 @filename
		const root = this._textarea;
		if (!root) { return; }
		const sel = window.getSelection();
		if (sel && sel.rangeCount > 0) {
			const range = sel.getRangeAt(0);
			const container = range.endContainer;
			if (container.nodeType === Node.TEXT_NODE) {
				const textNode = container as Text;
				const text = textNode.textContent ?? '';
				const caretOffset = range.endOffset;
				const beforeCursor = text.slice(0, caretOffset);
				const afterCursor = text.slice(caretOffset);
				// 找到最后一个 @query 并替换
				const atMatch = beforeCursor.match(/@(\w[^\s]*)$/);
				if (atMatch) {
					const replacement = `@${selected.name} `;
					const newBefore = beforeCursor.slice(0, beforeCursor.length - atMatch[0].length) + replacement;
					textNode.textContent = newBefore + afterCursor;
					// 光标移动到 replacement 之后
					const newPos = newBefore.length;
					const newRange = document.createRange();
					newRange.setStart(textNode, newPos);
					newRange.collapse(true);
					sel.removeAllRanges();
					sel.addRange(newRange);
				}
			} else {
				// 退化为直接插入文件名文本
				this._insertTextAtCaret(`@${selected.name} `);
			}
		}

		// 添加文件作为上下文
		this._onAddFileContext?.(selected.path);

		this._closeMentionMenu();
		// 触发 input 以更新高度/发送按钮
		root.dispatchEvent(new Event('input'));
	}

protected override _closeMentionMenu(): void {
		if (this._mentionEl) {
			this._mentionEl.remove();
			this._mentionEl = null;
		}
		this._mentionQuery = '';
		this._mentionResults = [];
		this._mentionIndex = 0;
	}

	/**
	 * 智能定位 dropdown popup 相对 textarea：优先贴在上方，空间不足（<120px 或
	 * 下方空间更大）时翻转到 textarea 下方显示。position:fixed 下超出视口时
	 * 不会产生滚动条，会导致 popout 独立窗口中完全不可见。
	 */
	private _positionDropdownRelativeTo(popup: HTMLElement, rect: DOMRect, defaultMaxHeight: number): void {
		const spaceAbove = rect.top;
		const spaceBelow = window.innerHeight - rect.bottom;
		const useAbove = spaceAbove >= 120 || spaceAbove >= spaceBelow;
		if (useAbove) {
			popup.style.bottom = `${window.innerHeight - rect.top + 4}px`;
			popup.style.top = '';
			popup.style.maxHeight = `${Math.min(defaultMaxHeight, spaceAbove - 8)}px`;
		} else {
			popup.style.top = `${rect.bottom + 4}px`;
			popup.style.bottom = '';
			popup.style.maxHeight = `${Math.min(defaultMaxHeight, spaceBelow - 8)}px`;
		}
	}

protected override _openSlashMenu(filter: string): void {
		this._closeSlashMenu();

		const skills = this._onListSkills();
		if (!skills.length) { return; }

		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;
		if (!filtered.length) { return; }

		const textarea = this._textarea;
		const rect = textarea.getBoundingClientRect();

		this._slashMenuEl = document.createElement('div');
		this._slashMenuEl.className = 'slash-menu';
		this._slashMenuEl.style.left = `${rect.left}px`;
		this._slashMenuEl.style.maxWidth = `${Math.max(rect.width, 260)}px`;
		// 智能定位（同上 _openMentionMenu）
		this._positionDropdownRelativeTo(this._slashMenuEl, rect, 280);

		// Items (render directly since we just created the element)
		const list = document.createElement('div');
		list.className = 'slash-menu-list';
		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			item.dataset.skillName = s.name || s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuEl.appendChild(list);
		document.body.appendChild(this._slashMenuEl);
		this._slashMenuIndex = 0;
		this._highlightSlashMenuItem();
	}

protected override _renderSlashMenuItems(filter: string): void {
		if (!this._slashMenuEl) { return; }
		const skills = this._onListSkills();
		const filtered = filter
			? skills.filter(s =>
				s.id.toLowerCase().includes(filter.toLowerCase()) ||
				s.name.toLowerCase().includes(filter.toLowerCase()))
			: skills;

		const list = this._slashMenuEl.querySelector('.slash-menu-list') as HTMLElement | null;
		if (!list) { return; }
		clearNode(list);

		if (!filtered.length) {
			this._closeSlashMenu();
			return;
		}

		filtered.forEach((s, i) => {
			const item = document.createElement('div');
			item.className = 'slash-menu-item';
			item.dataset.skillId = s.id;
			const icon = document.createElement('span');
			icon.className = 'slash-menu-item-icon';
			icon.textContent = '/';
			item.appendChild(icon);
			const info = document.createElement('span');
			info.className = 'slash-menu-item-info';
			const name = document.createElement('span');
			name.className = 'slash-menu-item-name';
			name.textContent = s.id;
			info.appendChild(name);
			const desc = document.createElement('span');
			desc.className = 'slash-menu-item-desc';
			desc.textContent = s.name;
			info.appendChild(desc);
			item.appendChild(info);
			item.addEventListener('mousedown', (e) => {
				e.preventDefault();
				this._insertSlashSkill(s.id, s.name || s.id);
				this._closeSlashMenu();
			});
			list.appendChild(item);
		});

		this._slashMenuIndex = Math.min(this._slashMenuIndex, filtered.length - 1);
		this._highlightSlashMenuItem();
	}

protected override _highlightSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		items.forEach((el, i) => {
			el.classList.toggle('selected', i === this._slashMenuIndex);
		});
		// Scroll selected into view
		const selected = items[this._slashMenuIndex] as HTMLElement | undefined;
		if (selected) { selected.scrollIntoView({ block: 'nearest' }); }
	}

/** 创建内联 skill chip 节点：嵌在 contentEditable 文本流中，与文字混排。 */
protected _createSkillChipNode(id: string, name: string): HTMLElement {
	const chip = document.createElement('span');
	chip.className = 'inline-skill-chip';
	chip.dataset.skillId = id;
	chip.setAttribute('contenteditable', 'false');
	chip.title = `技能: ${name} (${id})`;

	const icon = document.createElement('span');
	icon.className = 'inline-skill-chip-icon';
	icon.textContent = '⚡';
	chip.appendChild(icon);

	const label = document.createElement('span');
	label.className = 'inline-skill-chip-name';
	label.textContent = name;
	chip.appendChild(label);

	const removeBtn = document.createElement('span');
	removeBtn.className = 'inline-skill-chip-remove';
	removeBtn.textContent = '✕';
	chip.appendChild(removeBtn);
	// mousedown 时阻止默认选中：chip 现为 user-select:all，避免点 ✕ 先触发整片选中
	this._register(addDisposableListener(removeBtn, EventType.MOUSE_DOWN, (e) => {
		e.preventDefault();
		e.stopPropagation();
	}));
	this._register(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
		e.stopPropagation();
		e.preventDefault();
		this._removeSkillChip(id);
	}));
	return chip;
}

/** 从 DOM 收集当前 composer 内的 skill id（DOM 是唯一真源）。 */
protected _getSkillChipIds(): string[] {
	const root = this._textarea;
	if (!root) { return []; }
	return Array.from(root.querySelectorAll('.inline-skill-chip'))
		.map(el => (el as HTMLElement).dataset.skillId ?? '')
		.filter(Boolean);
}

protected override _addSkillChip(id: string, name: string): void {
	const root = this._textarea;
	if (!root) { return; }
	// 去重：DOM 中已存在同 id chip 则跳过
	if (root.querySelector(`.inline-skill-chip[data-skill-id="${CSS.escape(id)}"]`)) { return; }
	const chip = this._createSkillChipNode(id, name);
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

protected override _removeSkillChip(id: string): void {
	const root = this._textarea;
	if (!root) { return; }
	root.querySelector(`.inline-skill-chip[data-skill-id="${CSS.escape(id)}"]`)?.remove();
	this._updateSendButton();
}

protected override _renderSkillChips(): void {
	// no-op：skill chips 已改为内联在 contentEditable 文本流中，
	// DOM 即真源，无需独立渲染函数。保留空实现以兼容 base 类声明。
}

protected override _selectSlashMenuItem(): void {
		const items = this._slashMenuEl?.querySelectorAll('.slash-menu-item');
		if (!items?.length) { return; }
		const selected = items[Math.min(this._slashMenuIndex, items.length - 1)] as HTMLElement | undefined;
		if (selected?.dataset.skillId) {
			this._insertSlashSkill(selected.dataset.skillId, selected.dataset.skillName || selected.dataset.skillId);
		}
		this._closeSlashMenu();
	}

protected override _insertSlashSkill(skillId: string, skillName: string): void {
	// slash 菜单仅在整段内容为 /xxx 时触发，直接清空后把 skill 内联 chip 插到末尾，
	// 光标落在 chip 之后，用户可继续输入文本。
	this._setComposerText('');
	this._textarea.style.color = '';
	this._textarea.removeAttribute('data-slash-command');
	// Add skill chip（内联插入到 composer 文本流末尾）
	this._addSkillChip(skillId, skillName);
	this._focusComposerEnd();
}

protected override _closeSlashMenu(): void {
		if (this._slashMenuEl) {
			this._slashMenuEl.remove();
			this._slashMenuEl = null;
		}
		this._slashMenuIndex = 0;
	}

protected override _renderContextUsageRing(parent: HTMLElement): void {
		renderContextUsageRing(parent, this._contextUsage);
	}

protected override _estimateTokens(text: string | undefined | null): number {
		if (!text) { return 0; }
		return Math.ceil(text.length / 4);
	}

protected override _computeInputBaselineTokens(): number {
		// 从后往前找到最近一条有真实 tokenUsage 的消息
		for (let i = this._messages.length - 1; i >= 0; i--) {
			const m = this._messages[i];
			if (m.tokenUsage && (m.tokenUsage.input > 0 || m.tokenUsage.total > 0)) {
				if (m.tokenUsage.input > 0) {
					return m.tokenUsage.input + (m.tokenUsage.output || 0);
				}
				return m.tokenUsage.total;
			}
		}
		// 无真实 usage（新对话或首条消息）：降级为逐条字符估算
		let total = 0;
		for (const m of this._messages) {
			total += this._estimateTokens(m.content);
			total += this._estimateTokens(m.thinking);
			if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) {
				for (const tc of m.toolCalls) {
					total += this._estimateTokens(tc.args);
					total += this._estimateTokens(tc.result);
					total += this._estimateTokens(tc.name);
				}
			}
		}
		return total;
	}

protected override _computeContextUsage(): IContextUsage | null {
		// 从当前模型获取 maxInputTokens（匹配 React：currentModel?.maxInputTokens）
		const currentModelInfo = this._models.find(m => m.id === this._currentModel);
		const limit = currentModelInfo?.maxInputTokens ?? 0;
		if (limit <= 0) {
			return null;
		}

		const isStreaming = this._streamPhase !== 'idle' && this._streamPhase !== 'error';

		const inputBaselineTokens = this._computeInputBaselineTokens();

		// effectiveBaseline: 如果有 compactedBaseline，使用它（取较小值）
		const effectiveBaseline = this._compactedBaseline > 0
			? Math.min(this._compactedBaseline, inputBaselineTokens)
			: inputBaselineTokens;

		let used: number;
		if (this._streamUsage?.seen) {
			// 3) 真值优先：已收到真实 usage chunk
			const real = (this._streamUsage.input ?? 0) + (this._streamUsage.output ?? 0);
			used = Math.max(real, effectiveBaseline);
		} else if (isStreaming) {
			// 2) 流式进行中且尚无真实 usage：输入基线 + 实时输出估算
			const outputEstimate = this._estimateTokens(this._streamTextBuffer) + this._estimateTokens(this._streamThinkingBuffer);
			used = effectiveBaseline + outputEstimate;
		} else {
			// 1) 空闲态：纯输入基线
			used = effectiveBaseline;
		}

		const ratio = Math.max(0, Math.min(1, used / limit));
		return {
			used,
			limit,
			ratio,
			percent: Math.round(ratio * 100),
		};
	}

protected override _updateContextRing(): void {
		// 流式期间防抖——context ring 不需要每帧更新，500ms 足够
		if (this._isSending) {
			if (this._contextRingTimer !== null) { return; } // 已有 pending
			this._contextRingTimer = window.setTimeout(() => {
				this._contextRingTimer = null;
				this._doUpdateContextRing();
			}, 500);
			return;
		}
		// 非流式：取消 pending 并立即更新
		if (this._contextRingTimer !== null) {
			clearTimeout(this._contextRingTimer);
			this._contextRingTimer = null;
		}
		this._doUpdateContextRing();
	}

protected override _doUpdateContextRing(): void {
		// 重新计算 contextUsage（3层逻辑，匹配 React）
		const computed = this._computeContextUsage();
		if (computed) {
			this._contextUsage = computed;
		}
		// 渲染环形进度条
		const ring = this._container.querySelector('.context-usage-ring') as HTMLElement | null;
		if (!ring) { return; }
		const parent = ring.parentElement;
		if (!parent) { return; }
		const sendBtn = parent.querySelector('.chat-send-circle');
		ring.remove();
		const tempParent = $('div');
		this._renderContextUsageRing(tempParent);
		const newRing = tempParent.firstElementChild;
		if (newRing && sendBtn) {
			parent.insertBefore(newRing, sendBtn);
		} else if (newRing) {
			parent.appendChild(newRing);
		}
	}

protected override _renderInlineAttachmentChips(): void {
		const root = this._textarea;
		if (!root) { return; }
		for (const att of this._attachments) {
			if (root.querySelector(`.inline-attachment-chip[data-att-id="${att.id}"]`)) { continue; }
			const spaceBefore = document.createTextNode(' ');
			const spaceAfter = document.createTextNode(' ');
			root.appendChild(spaceBefore);
			root.appendChild(this._createAttachmentChipNode(att));
			root.appendChild(spaceAfter);
		}
		if (this._attachments.length) { this._focusComposerEnd(); }
	}

protected override _getComposerText(): string {
		const root = this._textarea;
		if (!root) { return ''; }
		let out = '';
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				out += node.textContent ?? '';
				return;
			}
		if (node.nodeType !== Node.ELEMENT_NODE) { return; }
		const el = node as HTMLElement;
		if (el.classList.contains('inline-attachment-chip')) { return; }
		// skill chip → 内联标记 `/skill <id>`：保留 chip 在文本流中的位置，
		// 气泡渲染与历史恢复据此解析还原 chip pill。
		if (el.classList.contains('inline-skill-chip')) {
			const id = el.dataset.skillId;
			out += id ? `/skill ${id}` : '';
			return;
		}
		const tag = el.tagName;
			if (tag === 'BR') { out += '\n'; return; }
			if (tag === 'DIV' || tag === 'P') {
				if (out.length > 0 && !out.endsWith('\n')) { out += '\n'; }
			}
			for (const child of Array.from(el.childNodes)) { walk(child); }
			if ((tag === 'DIV' || tag === 'P') && !out.endsWith('\n')) { out += '\n'; }
		};
		for (const child of Array.from(root.childNodes)) { walk(child); }
		// 归一化不间断空格（contentEditable 常见）
		return out.replace(/\u00A0/g, ' ');
	}

protected override _updateCharCounter(text: string): void {
		if (!this._charCounterEl) { return; }
		this._charCounterEl.textContent = `${text.length}`;
	}

protected override _setComposerText(text: string): void {
		const root = this._textarea;
		if (!root) { return; }
		clearNode(root);
		if (text) {
			// 解析内联 skill 标记（/skill <id>）→ 重建 chip 节点（历史恢复/草稿恢复）
			const segments = text.split(/(\/skill\s+[\w-]+)/g);
			for (const seg of segments) {
				const m = seg.match(/^\/skill\s+([\w-]+)$/);
				if (m) {
					root.appendChild(this._createSkillChipNode(m[1], this._resolveSkillName(m[1])));
					continue;
				}
				if (seg) { root.appendChild(document.createTextNode(seg)); }
			}
		}
		// 重新计算高度，避免多行时被截断
		root.style.height = 'auto';
		const maxAllowed = 320;
		const newHeight = this._userHasAdjustedHeight
			? Math.min(Math.max(root.scrollHeight, this._resizeMaxH), maxAllowed)
			: Math.min(root.scrollHeight, this._resizeMaxH);
		root.style.height = newHeight + 'px';
		// 更新字符计数器
		this._updateCharCounter(text);
	}

	/** 按 skill id 查显示名（用于标记 → chip 还原）；查不到回退 id 本身。 */
	private _resolveSkillName(id: string): string {
		const skills = this._onListSkills();
		return skills.find(s => s.id === id)?.name || id;
	}

protected override _getCaretOffset(): number {
		const root = this._textarea;
		if (!root) { return 0; }
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) { return 0; }
		const range = sel.getRangeAt(0);
		const pre = range.cloneRange();
		pre.selectNodeContents(root);
		pre.setEnd(range.endContainer, range.endOffset);
		let offset = 0;
		pre.cloneContents().childNodes.forEach((n) => {
			if (n.nodeType === Node.TEXT_NODE) {
				offset += (n.textContent ?? '').length;
			} else if (n.nodeType === Node.ELEMENT_NODE) {
				const el = n as HTMLElement;
				if (!el.classList.contains('inline-attachment-chip') && !el.classList.contains('inline-skill-chip')) {
					offset += (el.textContent ?? '').length;
				}
			}
		});
		return offset;
	}

protected override _focusComposerEnd(): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		if (!sel) { return; }
		const range = document.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	}

protected override _insertTextAtCaret(text: string): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		const existing = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (existing && root.contains(existing.startContainer)) {
			// 用「纯文本偏移量」定位光标：先记下插入点（选区起点）的偏移，插入后把光标
			// 放到 insertOffset + text.length。偏移量基于 DOM 字符计数、不依赖插入的
			// textNode 引用——浏览器把新文本节点与相邻文本节点合并后引用会失效，
			// setStartAfter(detachedNode) 会落错位置（打包版曾因此光标不在尾部）。
			const insertOffset = this._computeCaretOffset(true);
			existing.deleteContents();
			existing.insertNode(document.createTextNode(text));
			this._setCaretOffset(insertOffset + text.length);
		} else {
			root.appendChild(document.createTextNode(text));
			this._focusComposerEnd();
		}
		root.dispatchEvent(new Event('input'));
	}

	/** 计算当前选区端点处的「纯文本」偏移（跳过 chip 内文本）。useStart=true 取选区起点。 */
	private _computeCaretOffset(useStart: boolean): number {
		const root = this._textarea;
		if (!root) { return 0; }
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) { return 0; }
		const range = sel.getRangeAt(0);
		const pre = range.cloneRange();
		pre.selectNodeContents(root);
		if (useStart) { pre.setEnd(range.startContainer, range.startOffset); }
		else { pre.setEnd(range.endContainer, range.endOffset); }
		let offset = 0;
		pre.cloneContents().childNodes.forEach((n) => {
			if (n.nodeType === Node.TEXT_NODE) {
				offset += (n.textContent ?? '').length;
			} else if (n.nodeType === Node.ELEMENT_NODE) {
				const el = n as HTMLElement;
				if (!el.classList.contains('inline-attachment-chip') && !el.classList.contains('inline-skill-chip')) {
					offset += (el.textContent ?? '').length;
				}
			}
		});
		return offset;
	}

	/** 把光标折叠到 composer 内第 target 个「纯文本」字符之后（跳过 chip 内文本）。 */
	private _setCaretOffset(target: number): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		if (!sel) { return; }
		let remaining = Math.max(0, target);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => {
				const p = (n as Text).parentElement;
				return (p && p.closest('.inline-attachment-chip, .inline-skill-chip')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			},
		});
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const t = node as Text;
			if (remaining <= t.length) {
				const r = document.createRange();
				r.setStart(t, remaining);
				r.collapse(true);
				sel.removeAllRanges();
				sel.addRange(r);
				return;
			}
			remaining -= t.length;
		}
		// 超出末尾 → 折叠到最后
		const r = document.createRange();
		r.selectNodeContents(root);
		r.collapse(false);
		sel.removeAllRanges();
		sel.addRange(r);
	}

	/** 选区含 chip 时拦截复制/剪切：写入自定义格式 + 可读纯文本，避免图片信息丢失。 */
	private _handleComposerCopyCut(e: ClipboardEvent, isCut: boolean): void {
		const serialized = this._serializeComposerClipboard();
		if (!serialized) { return; } // 无 chip 或空选区 → 走浏览器默认行为

		e.preventDefault();
		const cd = e.clipboardData;
		if (cd) {
			cd.setData('text/plain', serialized.text);
			cd.setData(COMPOSER_CLIPBOARD_MIME, serialized.json);
		}
		if (isCut) {
			const sel = window.getSelection();
			const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
			if (range && this._textarea.contains(range.startContainer)) {
				range.deleteContents();
			}
			this._syncAttachmentsFromDom();
			this._updateSendButton();
			this._textarea.dispatchEvent(new Event('input'));
		}
	}

	/** 把当前选区序列化为片段数组；仅当包含 chip 时才返回（否则交给浏览器默认复制）。 */
	private _serializeComposerClipboard(): { json: string; text: string } | null {
		const root = this._textarea;
		const sel = window.getSelection();
		if (!sel || sel.rangeCount === 0) { return null; }
		const range = sel.getRangeAt(0);
		if (range.collapsed || !root.contains(range.startContainer)) { return null; }

		const fragment = range.cloneContents();
		const segments: IComposerClipSegment[] = [];
		let hasChip = false;

		const pushText = (t: string) => {
			if (!t) { return; }
			const last = segments[segments.length - 1];
			if (last && last.type === 'text') { last.text = (last.text ?? '') + t; }
			else { segments.push({ type: 'text', text: t }); }
		};
		const walk = (node: Node) => {
			if (node.nodeType === Node.TEXT_NODE) {
				pushText(node.textContent ?? '');
				return;
			}
			if (node.nodeType !== Node.ELEMENT_NODE) { return; }
			const el = node as HTMLElement;
			if (el.tagName === 'BR') { pushText('\n'); return; }
			if (el.classList.contains('inline-skill-chip')) {
				const id = el.dataset.skillId;
				if (id) {
					segments.push({ type: 'skill', id });
					hasChip = true;
				}
				return;
			}
			if (el.classList.contains('inline-attachment-chip')) {
				const attId = el.dataset.attId;
				const att = attId ? this._attachments.find(a => a.id === attId) : undefined;
				if (att) {
					segments.push({
						type: 'attachment', attId, name: att.name, mimeType: att.mimeType,
						data: att.data, size: att.size, attType: att.type, isPasted: att.isPasted, filePath: att.filePath,
					});
					hasChip = true;
				}
				return;
			}
			if (el.tagName === 'DIV' || el.tagName === 'P') { pushText('\n'); }
			for (const child of Array.from(el.childNodes)) { walk(child); }
		};
		for (const child of Array.from(fragment.childNodes)) { walk(child); }

		if (!segments.length || !hasChip) { return null; }

		// 可读纯文本（复制到外部程序时用）：技能用 /skill 标记、附件用文件名
		let text = '';
		for (const s of segments) {
			if (s.type === 'text') { text += s.text; }
			else if (s.type === 'skill') { text += `/skill ${s.id}`; }
			else if (s.type === 'attachment') { text += `[${s.name ?? '附件'}]`; }
		}
		return { json: JSON.stringify({ v: 1, segments }), text };
	}

	/** 恢复内部剪贴板片段：在光标处重建文本 + 技能 chip + 附件（图片）chip。 */
	private _restoreComposerPaste(segments: IComposerClipSegment[]): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = window.getSelection();
		const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (range && root.contains(range.startContainer)) { range.deleteContents(); }

		const frag = document.createDocumentFragment();
		let lastWasChip = false;
		for (const seg of segments) {
			if (seg.type === 'text') {
				if (seg.text) { frag.appendChild(document.createTextNode(seg.text)); }
				lastWasChip = false;
			} else if (seg.type === 'skill' && seg.id) {
				if (!lastWasChip) { frag.appendChild(document.createTextNode(' ')); }
				frag.appendChild(this._createSkillChipNode(seg.id, this._resolveSkillName(seg.id)));
				frag.appendChild(document.createTextNode(' '));
				lastWasChip = true;
			} else if (seg.type === 'attachment' && seg.name && seg.mimeType) {
				const att: IChatAttachment = {
					id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					type: seg.attType ?? (seg.mimeType.startsWith('image/') ? 'image' : 'file'),
					name: seg.name,
					mimeType: seg.mimeType,
					data: seg.data ?? '',
					size: seg.size ?? 0,
					isPasted: true,
					filePath: seg.filePath,
				};
				this._attachments.push(att);
				if (!lastWasChip) { frag.appendChild(document.createTextNode(' ')); }
				frag.appendChild(this._createAttachmentChipNode(att));
				frag.appendChild(document.createTextNode(' '));
				lastWasChip = true;
			}
		}

		const lastNode = frag.lastChild ?? null;
		if (range && root.contains(range.startContainer)) {
			range.insertNode(frag);
			// 光标移到插入内容之后（片段末尾）。insertNode 后 range 位置不可靠，
			// 显式 setStartAfter(lastNode)；节点被浏览器合并时回退到 collapse(false)。
			if (lastNode) {
				try {
					const caret = document.createRange();
					caret.setStartAfter(lastNode);
					caret.collapse(true);
					sel?.removeAllRanges();
					sel?.addRange(caret);
				} catch {
					range.collapse(false);
					sel?.removeAllRanges();
					sel?.addRange(range);
				}
			} else {
				range.collapse(false);
				sel?.removeAllRanges();
				sel?.addRange(range);
			}
		} else {
			root.appendChild(frag);
			this._focusComposerEnd();
		}
		this._updateSendButton();
		root.dispatchEvent(new Event('input'));
	}

	/** 让 _attachments 与 DOM 中的附件 chip 对齐（剪切/删除 chip 后清理数组）。 */
	private _syncAttachmentsFromDom(): void {
		const root = this._textarea;
		const kept = this._attachments.filter(a => root.querySelector(`.inline-attachment-chip[data-att-id="${CSS.escape(a.id)}"]`));
		if (kept.length !== this._attachments.length) {
			this._attachments = kept;
		}
	}
}
