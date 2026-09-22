import { $, append, clearNode, addDisposableListener, addStandardDisposableListener, EventType } from '../../../base/browser/dom.js';
import { ContextManager } from '../../contrib/agentStudio/common/contextManager.js';
import { IChatAttachment, IContextUsage, CHAT_MODE_UI } from './agentChatTypes.js';
import { renderContextUsageRing } from './modules/contextRing.js';
import { chatPerf } from './agentChatPanel.perf.js';
import { focusTrace } from './focusTrace.js';
import { AgentChatPanelMarkdown } from './agentChatPanel.markdown.js';
import {
	filterWorkflowItems,
	serializeInlineWorkflowArgs,
	parseInlineWorkflowArgs,
	encodeWorkflowChipParams,
	decodeWorkflowChipParams,
	type IWorkflowChipItem,
} from './agentChatPanel.workflowChip.js';

/** 内部剪贴板格式：选区含 chip 时用自定义 MIME 保存结构化内容（文本+技能+附件），
 *  粘贴时据此恢复 chip，避免 contenteditable=false 的 chip 被浏览器序列化成纯文本。 */
// ★ 2026-09-19：剪贴板**格式契约**已抽到独立轻量模块（`agentChatPanel.composerClipboard.ts` ✓）——
// 这条格式的写端有**两处**（composer 内部复制/剪切 ✓、**消息气泡的复制按钮** ✓），读端在粘贴分支 ✓；
// 一旦漂移**不会报错、只会静默退化**（粘贴回来 pill 又丢 ✗）⇒ 必须共用一份定义 ✓，
// 且能被**不依赖 DOM** 的单测锁住 ✓（原先写在本文里，会让单测被迫 import 整个面板模块链 ✗）。
import { COMPOSER_CLIPBOARD_MIME } from './agentChatPanel.composerClipboard.js';

/** 选区剪贴板片段：文本 / 技能 chip / 附件（图片）chip。 */
interface IComposerClipSegment {
	type: 'text' | 'skill' | 'workflow' | 'attachment';
	text?: string;
	id?: string;                  // skill / workflow id
	params?: Record<string, string>;  // workflow 表单参数
	attId?: string;               // attachment id（序列化前）
	name?: string;                // attachment 文件名
	mimeType?: string;
	data?: string;                // base64
	size?: number;
	attType?: 'image' | 'file' | 'folder';
	isPasted?: boolean;
	filePath?: string;
	/**
	 * ★ 2026-09-19 补：文本片段种类（`'snippet' | 'log'` ✓）。
	 *
	 * 之前漏了它 ✗ ⇒ 代码片段复制/粘贴回来后，chip 会退化成**普通文件**（显示文件名
	 * `code-snippet.txt` 而不是「代码片段」✓，图标与名称都不对 ✗）。
	 * 内容（`data` ✓）一直都在，丢的只是"这是什么"这层语义 ✓。
	 */
	kind?: 'snippet' | 'log';
}

/**
 * 一帧输入性能采样器（见 `_startComposerDiag`）。
 *
 * `mark(name)` 结算「上一个打点到现在」的耗时并归入 name 段；
 * `end()` 结算总耗时后压入样本数组，重复调用无副作用。
 */
interface IComposerDiagFrame {
	mark(name: string): void;
	end(): void;
}

// Feature: composer. Extracted from AgentChatPanelBase.
export class AgentChatPanelComposer extends AgentChatPanelMarkdown {

protected override _renderInputArea(): void {
		// 允许 _agent 为 null（agent 加载失败/竞态）：用一个最小占位 agent 让输入框始终可渲染，
		// 避免 4 开聊天框时其中一个因 _agent=null 导致输入框丢失（详见 _render 修复）。
		const emp = this._agent ?? { id: '', name: 'Assistant', role: '', avatarUrl: '', description: '', skills: [] };

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
				this._ownerDocument.removeEventListener('mousemove', onMove);
				this._ownerDocument.removeEventListener('mouseup', onUp);
			};
			this._ownerDocument.addEventListener('mousemove', onMove);
			this._ownerDocument.addEventListener('mouseup', onUp);
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

		// ★ 2026-09-18 焦点轨迹埋点（用户报「多窗口切换到输入框卡顿」）：
		//   这里记录**输入框真正拿到焦点**的时刻 ⇒ 与窗口 focus 事件对比，
		//   差值就是用户"点了输入框却没反应"的**感知延迟** ✓
		//   （focusin 用捕获阶段 ✓：即使输入框内部有子元素先收到事件也能命中 ✓）
		this._register(addDisposableListener(this._textarea, 'focusin', () => {
			focusTrace.mark('input.focusin', 'composer');
		}, true));

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
				// ★ 2026-09-18 性能埋点：`window.__SAROSIS_COMPOSER_DIAG = true` 开启。
				//   分段计时定位「打字卡顿」的剩余来源；关闭时仅多一次布尔读取。
				const _cd = this._startComposerDiag();

				// ★ 2026-09-18 性能修复（用户报告「打字特别卡顿」）：
				//   原先此处同步执行 保存消息区 scrollTop → style.height='auto'
				//   → 读 scrollHeight → 写 height → 恢复 scrollTop，
				//   是典型的 read-write-read 交错，会强制浏览器同步布局（layout thrash）；
				//   且因为同时读写了【消息区】的 scrollTop，重排成本随消息区 DOM
				//   体积增长 —— 表现为「聊得越久越卡」。
				//   现把高度测量与滚动恢复整体移入 rAF：一帧内只做一次，
				//   且不再位于击键的同步路径上。
				this._scheduleComposerHeightSync();
				_cd?.mark('heightScheduled');

				// 获取纯文本（排除内联附件芯片内容）
				const val = this._getComposerText();
				_cd?.mark('getText');

				// Detect /skill /command patterns — show slash menu
				// 允许 `-`（工作流 id 形如 wf-xxx），使 `/wf-` 输入过程中菜单持续显示。
				// 2026-09-10：`[\w-]` 不含中文——`/表情包` 一输入中文菜单即被关闭，
				// 过滤形同虚设。改为 `[^\s]*`（任意非空白），支持中日韩等工作流名称；
				// 空格仍终止过滤阶段（进入 chip 后的自由文本），语义不变。
				const slashMatch = val.match(/^\/([^\s]*)$/);
				if (slashMatch) {
					t.style.color = 'var(--ec-accent, #60a5fa)';
					t.setAttribute('data-slash-command', slashMatch[1]);
					const filter = slashMatch[1];
					if (this._slashMenuEl) {
						// ★ 2026-09-18：菜单已打开 → 重渲染走防抖。
						//   连续输入 `/w` `/wf` `/wf-` 只会在停顿后渲染一次。
						this._scheduleSlashMenuRender(filter);
					} else {
						// 首次打开必须立即执行，否则菜单出现延迟会让输入有滞后感。
						this._openSlashMenu(filter);
					}
				} else {
					t.style.color = '';
					t.removeAttribute('data-slash-command');
					this._cancelSlashMenuRender();
					this._closeSlashMenu();
				}

				// P0-2: @mention 文件搜索检测
				const cursorPos = this._getCaretOffset();
				const beforeCursor = val.slice(0, cursorPos);
				_cd?.mark('caretOffset');
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

			// 同步提示词优化按钮可用态（无输入时禁用）
			this._updatePromptOptimizeBtn();

			// 草稿持久化钩子（per-session，pane 侧 debounce 落 localStorage）
			this._onComposerTextChange?.(val);
			_cd?.end();
		}),
	);


		// Hidden file input — feeds the shared _addFiles pipeline (drag & drop / paste)
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
		const hideDragOverlay = () => {
			dragCounter = 0;
			dragOverlay.style.display = 'none';
		};
		/**
		 * 只有「从聊天框之外拖入文件」才点亮遮罩。
		 *
		 * 面板内部也存在可拖拽元素（任务队列 `.tbp-task-item`），它们挂在同一个
		 * `.chat-container` 上，其 dragenter 会冒泡到这里。若不做类型判定，
		 * 拖动任务项就会误显示「拖放文件」遮罩。内部拖拽只写入 'text/plain'，
		 * 故以 'Files' 是否存在作为唯一判据。
		 */
		const isFileDrag = (e: DragEvent): boolean => {
			const types = e.dataTransfer?.types;
			if (!types) { return false; }
			return Array.from(types).indexOf('Files') !== -1;
		};
		this._register(addDisposableListener(this._container, 'dragenter', (e: DragEvent) => {
			if (!isFileDrag(e)) { return; }
			e.preventDefault();
			dragCounter++;
			dragOverlay.style.display = 'flex';
		}));
		this._register(addDisposableListener(this._container, 'dragover', (e: DragEvent) => {
			if (!isFileDrag(e)) { return; }
			e.preventDefault();
			if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
		}));
		this._register(addDisposableListener(this._container, 'dragleave', () => {
			dragCounter--;
			if (dragCounter <= 0) { hideDragOverlay(); }
		}));
		// dragend 兜底：拖拽在面板外结束时不会有配对的 dragleave，
		// 计数器会残留导致遮罩卡住不消失。
		this._register(addDisposableListener(this._container, 'dragend', () => {
			hideDragOverlay();
		}));
		this._register(addDisposableListener(this._container, 'drop', (e: DragEvent) => {
			if (!isFileDrag(e)) { return; }
			e.preventDefault();
			e.stopPropagation();
			hideDragOverlay();
			const dt = e.dataTransfer;
			if (!dt) { return; }
			// 1. 文件夹拖放：出于安全浏览器不暴露目录内容（dt.files 为空），
			//    通过 webkitGetAsEntry().isDirectory 判定目录，再用 text/uri-list 取系统路径
			const folderPaths = this._collectFolderPathsFromDataTransfer(dt);
			if (folderPaths.length > 0) {
				this._addFolderAttachments(folderPaths);
			}
			// 2. OS 文件/图片拖放
			if (dt.files && dt.files.length > 0) {
				this._addFiles(Array.from(dt.files), false);
			} else if (folderPaths.length === 0) {
				// 3. 代码/文本拖放（从编辑器选中代码拖入）
				// 2026-09-18：改为复用 _addTextSnippetAttachment，与粘贴分支共用
				// 同一判定/构建/图标链路（原实现硬编码 code-snippet.txt，日志片段
				// 也被标成代码，且与粘贴行为不一致）。
				const text = dt.getData('text/plain');
				if (text && text.trim().length > 0) {
					this._addTextSnippetAttachment(text, this._classifyTextSnippet(text));
				}
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

			// 收集粘贴的文件（图片 + 普通文件）。复制的图片（截图、从图片软件复制等）
			// 通常以 clipboardData.items 中 kind==='file' 的形式存在，此时 clipboardData.files
			// 为空；而从文件管理器/拖拽复制则在 files 中。两者都要覆盖，否则图片/文件
			// chip 不显示。普通文件（.txt/.md/.js 等）也必须收集——否则粘贴文件会被
			// 下方「格式化粘贴」分支丢弃（只粘出纯文本、无 chip）。
			const pastedFiles: File[] = [];
			if (clipboardData.files?.length) {
				for (const f of Array.from(clipboardData.files)) {
					pastedFiles.push(f);
				}
			}
			if (!pastedFiles.length && clipboardData.items?.length) {
				for (const it of Array.from(clipboardData.items)) {
					if (it.kind === 'file') {
						const f = it.getAsFile();
						if (f) { pastedFiles.push(f); }
					}
				}
			}

			// 有文件（图片/普通文件）→ 保持本地 chip 显示（_addFiles 内部按类型创建
			// image chip 或 file chip），不做格式化、不受影响。
			if (pastedFiles.length > 0) {
				e.preventDefault();
				this._addFiles(pastedFiles, true);
				return;
			}

			// 粘贴文件夹：操作系统通常以 file:// 路径（text/uri-list）暴露目录，而非二进制
			// 文件内容（此时 pastedFiles 为空）。解析为文件夹 chip（📁 图标，data 为系统路径）。
			const folderPaths = this._collectFolderPathsFromDataTransfer(clipboardData as unknown as DataTransfer);
			if (folderPaths.length > 0) {
				e.preventDefault();
				this._addFolderAttachments(folderPaths);
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
				// 2026-09-18：长片段（代码 / 日志）折叠为 chip，避免整段塞进
				// 输入框把其撑高、与提问文字混在一起难以阅读。
				// 与下方拖放代码分支共用 _addTextSnippetAttachment，行为一致。
				if (this._shouldFoldTextToChip(plain)) {
					this._addTextSnippetAttachment(plain, this._classifyTextSnippet(plain));
				} else {
					this._insertTextAtCaret(plain);
				}
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
						} else if (this._isSending) {
							// ⚠ `_onCancelExecution` 是否注入由 `_requestCancelExecution()` 内部守卫 ✓
							// （类型把它声明成必有，但 `:826` 注释明说"未注入时回退为普通发送" ✗ —
							//  在此再查一次会触发 TS2774「恒真」✗ ⇒ 守卫收进统一入口 ✓）
							this._requestCancelExecution();
						}
						return;
					}

				// Backspace: if cursor is right after an inline chip (attachment / skill), delete the chip
				if (e.key === 'Backspace') {
					const sel = this._ownerWindow?.getSelection();
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
								if (beforeThat && (beforeThat as HTMLElement).classList) {
									const bc = (beforeThat as HTMLElement).classList;
									if (bc.contains('inline-attachment-chip') || bc.contains('inline-skill-chip') || bc.contains('inline-workflow-chip')) {
										prevNode = beforeThat;
									}
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
							if (prevEl.classList.contains('inline-workflow-chip')) {
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
						const sel = this._ownerWindow?.getSelection();
						const textarea = this._textarea;
						if (sel && textarea) {
							const range = this._ownerDocument.createRange();
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
						this._ownerDocument.execCommand('undo');
						return;
					}
					// Ctrl+Y / Ctrl+Shift+Z：重做
					if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
						e.preventDefault();
						e.stopPropagation();
						this._ownerDocument.execCommand('redo');
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

		// ChatMode 下拉框（2026-08-21，替代旧的「干活/纯聊」布尔开关）：
		// Craft / Ask / Plan 三档，仅 Plan 档位向 LLM 暴露 plan_* 工具。
		const modeMeta = CHAT_MODE_UI[this._chatMode];
		this._modeTrigger = this._appendToolbarBtn(leftToolbar, {
			title: `${modeMeta.label} — ${modeMeta.description}（点击切换模式）`,
			svgPath: modeMeta.svgPath,
			hasLabel: true,
			label: modeMeta.label,
			showChevron: true,
			cssClass: `mode-tag mode-tag-${this._chatMode}`,
		});
		this._register(
			addDisposableListener(this._modeTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._modeDropdownEl) {
					this._closeModeDropdown();
				} else {
					this._openModeDropdown();
				}
			}),
		);

		// 「对话模型」chip（2026-09-10：由原 Provider + Model 两个 chip 合并而来）
		// 只显示模型名，provider 归属在下拉的一级列表里体现（见 _openChatModelDropdown）。
		this._chatModelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择对话模型（Provider / 模型）",
			svgPath: "M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z",
			hasLabel: true,
			label: this._models.find(m => m.id === this._currentModel)?.label || this._currentModel || "模型",
			showChevron: true,
			cssClass: "chat-model-tag",
		});
		this._register(
			addDisposableListener(this._chatModelTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._chatModelDropdownEl) {
					this._closeChatModelDropdown();
				} else {
					this._openChatModelDropdown();
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

		// 「图片模型」chip（2026-09-10 新增）——只显示所选模型名，默认「自动」。
		this._imageModelTrigger = this._appendToolbarBtn(leftToolbar, {
			title: "选择图片模型（图片生成）",
			svgPath: "M3 3h18v18H3zM8.5 10a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM21 15l-5-5L5 21",
			hasLabel: true,
			label: this._getImageModelLabel(),
			showChevron: true,
			cssClass: "image-model-tag",
		});
		this._register(
			addDisposableListener(this._imageModelTrigger, EventType.CLICK, (e) => {
				e.stopPropagation();
				if (this._imageModelDropdownEl) {
					this._closeImageModelDropdown();
				} else {
					this._openImageModelDropdown();
				}
			}),
		);

		// Right wrap：字符计数 → 上下文环 → ✨ 提示词优化 → 发送
		// （2026-09-11 调整顺序：优化按钮置于「发送按钮左侧、上下文进度条右侧」）
		const rightWrap = append(toolbar, $(".provider-model-chip-wrap"));

		// 字符计数器
		this._charCounterEl = append(rightWrap, $('span.chat-char-counter'));

		// 上下文用量环
		this._renderContextUsageRing(rightWrap);

		// 提示词优化按钮（2026-09-10，发送按钮左侧）：把输入框文本交给 LLM 改写。
		// 方案移植自 prompt-optimizer（见 agentChat/promptOptimize.ts 头注释）：
		// 一次性 chat 调用，不进入会话历史、不触发 agent loop。
		this._promptOptimizeBtn = append(rightWrap, $<HTMLButtonElement>('button.chat-prompt-optimize-btn'));
		this._renderPromptOptimizeSvg();
		this._updatePromptOptimizeBtn();
		this._register(
			addDisposableListener(this._promptOptimizeBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				void this._handleOptimizePrompt();
			}),
		);

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
						this._requestCancelExecution();
					}
				} else {
					this._handleSendMessage();
				}
			}),
		);
	}

	/** 渲染提示词优化按钮的 ✨ 图标（双四角星，stroke 风格与工具栏其它图标一致）。 */
	protected _renderPromptOptimizeSvg(): void {
		const btn = this._promptOptimizeBtn;
		if (!btn) { return; }
		const NS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(NS, 'svg');
		svg.setAttribute('width', '14');
		svg.setAttribute('height', '14');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('fill', 'none');
		svg.setAttribute('stroke', 'currentColor');
		svg.setAttribute('stroke-width', '1.7');
		svg.setAttribute('stroke-linecap', 'round');
		svg.setAttribute('stroke-linejoin', 'round');
		const big = document.createElementNS(NS, 'path');
		big.setAttribute('d', 'M12 2.6l2.2 5.8 5.8 2.2-5.8 2.2L12 18.6l-2.2-5.8L4 10.6l5.8-2.2L12 2.6z');
		const small = document.createElementNS(NS, 'path');
		small.setAttribute('d', 'M18.6 15.4l.85 2.2 2.2.85-2.2.85-.85 2.2-.85-2.2-2.2-.85 2.2-.85.85-2.2z');
		svg.appendChild(big);
		svg.appendChild(small);
		btn.replaceChildren(svg);
	}

	/**
	 * 同步提示词优化按钮的可用 / loading 态。
	 * 无输入时禁用（避免空调用）；优化进行中禁用并显示转圈。
	 */
	protected _updatePromptOptimizeBtn(): void {
		const btn = this._promptOptimizeBtn;
		if (!btn) { return; }
		const hasText = !!this._getComposerText().trim();
		const busy = this._optimizeInFlight;
		btn.classList.toggle('loading', busy);
		btn.classList.toggle('disabled', !busy && !hasText);
		(btn as HTMLButtonElement).disabled = busy || !hasText;
		btn.title = busy
			? '正在优化提示词…'
			: (hasText ? '优化提示词（AI 改写输入内容）' : '先输入内容再优化');
	}

	/**
	 * 提示词优化（2026-09-10）：取输入框文本 → 一次性 LLM 改写 → 回填输入框。
	 * 失败/取消（回调返回 undefined）时保持原内容不变 —— 失败原因由宿主 notify。
	 */
	protected async _handleOptimizePrompt(): Promise<void> {
		if (this._optimizeInFlight || !this._onOptimizePrompt) { return; }
		const original = this._getComposerText().trim();
		if (!original) { return; }

		this._optimizeInFlight = true;
		this._updatePromptOptimizeBtn();
		try {
			const optimized = await this._onOptimizePrompt(original);
			const next = optimized?.trim();
			if (!next || next === original) { return; }
			// 用户在优化期间改动了输入框（含发送后清空）→ 不覆盖其新内容。
			if (this._getComposerText().trim() !== original) {
				this._logService?.info('[AgentChatPanel] optimize result discarded: composer changed during optimization');
				return;
			}
			this._setComposerText(next);
			// 回填后把光标放到末尾，便于用户继续编辑
			this._textarea?.focus();
		} finally {
			this._optimizeInFlight = false;
			this._updatePromptOptimizeBtn();
		}
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
			const wrapper = this._ownerDocument.createElementNS(
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
		const svg = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("width", "16");
		svg.setAttribute("height", "16");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "2");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const path = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
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
			const chevron = this._ownerDocument.createElementNS(
				"http://www.w3.org/2000/svg",
				"svg",
			);
			chevron.setAttribute("width", "10");
			chevron.setAttribute("height", "10");
			chevron.setAttribute("viewBox", "0 0 24 24");
			chevron.setAttribute("fill", "none");
			chevron.setAttribute("stroke", "currentColor");
			chevron.setAttribute("stroke-width", "2.5");
			const chevronPath = this._ownerDocument.createElementNS(
				"http://www.w3.org/2000/svg",
				"path",
			);
			chevronPath.setAttribute("d", "M6 9l6 6 6-6");
			chevron.appendChild(chevronPath);
			btn.appendChild(chevron);
		}

		return btn;
	}

	/** ★ 2026-09-19：优雅停止待办态（`true` ⇒ 已点一次 Stop，等服务在边界处收尾 ✓）。 */
	private _gracefulStopPending = false;

	/**
	 * 请求取消（**统一入口**：按钮点击 ✓ / Escape ✓）。
	 *
	 * ★ 2026-09-19：服务端的**第一次**取消是「优雅停止」（等当前 iteration 跑完 ⇒ 已生成内容不丢 ✓，
	 * 见 `agentChatService._gracefulStopRequested` ✓）—— 但它会让用户误以为"点了没反应" ✗。
	 * ⇒ 立刻给出**可感知**反馈：按钮脉冲 + 处理中指示旁的小条 ✓。
	 */
	private _requestCancelExecution(): void {
		if (!this._onCancelExecution) { return; }
		this._markGracefulStopPending();
		this._onCancelExecution();
	}

	/**
	 * 优雅停止态的可感知反馈（幂等 ✓）。
	 * 清除：`_renderSendButtonSvg()` 在 `_isSending=false` 时复位 ✓（turn 完成 / 硬停都会到 ✓）；
	 * 小条随「处理中」指示一起在 turn 结束时移除 ✓。
	 */
	private _markGracefulStopPending(): void {
		this._gracefulStopPending = true;
		if (this._sendBtn) {
			this._sendBtn.classList.add('chat-stopping-circle');
			this._sendBtn.title = '正在停止：等当前这一步跑完（再次点击 = 立即停）';
		}
		// 处理中指示旁加小条（幂等 ✓；turn 结束移除整个指示时一并带走 ✓）
		// ⚠ 泛型 `<HTMLElement>` 不能省 ✗ —— `append()` 的形参是 `HTMLElement`，而裸
		//   `querySelector` 返回 `Element` ⇒ TS2769（实测 ✓）
		const proc = this._messagesContainer?.querySelector<HTMLElement>('.chat-footer-processing');
		if (proc && !proc.querySelector('.chat-footer-stopping')) {
			const chip = append(proc, $('span.chat-footer-stopping'));
			chip.textContent = '正在停止…（再点 = 立即停）';
		}
	}

	protected override _renderSendButtonSvg(): void {
		clearNode(this._sendBtn);
		// ★ 2026-09-19：优雅停止态复位 —— turn 结束（`_isSending=false`）⇒ 撤掉"正在停止"脉冲 ✓
		this._gracefulStopPending = this._gracefulStopPending && this._isSending;
		this._sendBtn.classList.toggle('chat-stopping-circle', this._gracefulStopPending);
		const hasInput = !!(this._getComposerText().trim() || this._attachments.length > 0);
		const isQueueing = this._isSending && hasInput;

		if (isQueueing) {
			// Queue icon — 双层堆叠文档（表示"追加到队列"）
			const svg = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			// 下层文档
			const outer = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
			outer.setAttribute("d", "M4 5h12l4 4v12H4z");
			svg.appendChild(outer);
			// 上层文档（偏移）
			const inner = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
			inner.setAttribute("d", "M2 4h12l4 4v12H2z");
			svg.appendChild(inner);
			// 加号
			const plus = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "line");
			plus.setAttribute("x1", "12"); plus.setAttribute("y1", "8");
			plus.setAttribute("x2", "12"); plus.setAttribute("y2", "16");
			plus.setAttribute("stroke-width", "3");
			svg.appendChild(plus);
			const plusH = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "line");
			plusH.setAttribute("x1", "8"); plusH.setAttribute("y1", "12");
			plusH.setAttribute("x2", "16"); plusH.setAttribute("y2", "12");
			plusH.setAttribute("stroke-width", "3");
			svg.appendChild(plusH);
			this._sendBtn.appendChild(svg);
		} else if (this._isSending) {
			// Stop icon — 使用与发送箭头相同 14x14 尺寸，方块填充 viewBox 核心区域
			const svg = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "14");
			svg.setAttribute("height", "14");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "currentColor");
			const rect = this._ownerDocument.createElementNS(
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
			const svg = this._ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("width", "12");
			svg.setAttribute("height", "12");
			svg.setAttribute("viewBox", "0 0 24 24");
			svg.setAttribute("fill", "none");
			svg.setAttribute("stroke", "currentColor");
			svg.setAttribute("stroke-width", "2.5");
			svg.setAttribute("stroke-linecap", "round");
			svg.setAttribute("stroke-linejoin", "round");
			const line = this._ownerDocument.createElementNS(
				"http://www.w3.org/2000/svg",
				"line",
			);
			line.setAttribute("x1", "12");
			line.setAttribute("y1", "19");
			line.setAttribute("x2", "12");
			line.setAttribute("y2", "5");
			svg.appendChild(line);
			const polyline = this._ownerDocument.createElementNS(
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

	/**
	 * 防抖重渲染 slash 菜单（80ms）。
	 *
	 * 首次打开由 `_openSlashMenu` 立即完成；本方法只服务于「菜单已打开、
	 * 过滤词继续变化」的场景 —— 此时全量重建菜单 DOM 若每次击键都做，
	 * 连续快速输入会重建多次而用户只看得到最后一次。
	 */
	private _scheduleSlashMenuRender(filter: string): void {
		this._cancelSlashMenuRender();
		this._slashMenuTimer = window.setTimeout(() => {
			this._slashMenuTimer = null;
			this._renderSlashMenuItems(filter);
		}, 80) as unknown as number;
	}

	/**
	 * 取消待执行的 slash 菜单重渲染。
	 *
	 * 菜单关闭时必须调用，否则一个已排程的渲染会在关闭后又把菜单建回来。
	 */
	private _cancelSlashMenuRender(): void {
		if (this._slashMenuTimer !== null) {
			clearTimeout(this._slashMenuTimer);
			this._slashMenuTimer = null;
		}
	}

	protected override _openMentionMenu(): void {
		this._closeMentionMenu();
		if (!this._textarea || this._mentionResults.length === 0) { return; }

		const rect = this._textarea.getBoundingClientRect();
		this._mentionEl = this._createEl('div');
		this._mentionEl.className = 'mention-menu';
		this._mentionEl.style.left = `${rect.left}px`;
		this._mentionEl.style.maxWidth = `${Math.max(rect.width, 320)}px`;
		// 智能定位：优先贴在 textarea 上方，空间不足则翻转到下方。
		// popout 独立窗口高度可能远小于主窗口，force above 会导致 dropdown
		// 超出视口顶部完全不可见（position:fixed 不会产生 body 滚动条）。
		this._positionDropdownRelativeTo(this._mentionEl, rect, 280);

		const list = this._createEl('div');
		list.className = 'mention-menu-list';
		this._mentionResults.forEach((r, i) => {
			const item = this._createEl('div');
			item.className = 'mention-menu-item';
			item.dataset.path = r.path;
			const icon = this._createEl('span');
			icon.className = 'mention-menu-item-icon';
			icon.textContent = '📄';
			item.appendChild(icon);
			const info = this._createEl('span');
			info.className = 'mention-menu-item-info';
			const name = this._createEl('span');
			name.className = 'mention-menu-item-name';
			name.textContent = r.name;
			info.appendChild(name);
			const path = this._createEl('span');
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
		this._ownerDocument.body.appendChild(this._mentionEl);
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
		const sel = this._ownerWindow?.getSelection();
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
					const newRange = this._ownerDocument.createRange();
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

	const items = this._collectSlashItems(filter);
	if (!items.length) { return; }

	const textarea = this._textarea;
	const rect = textarea.getBoundingClientRect();

	this._slashMenuEl = this._createEl('div');
	this._slashMenuEl.className = 'slash-menu';
	this._slashMenuEl.style.left = `${rect.left}px`;
	this._slashMenuEl.style.maxWidth = `${Math.max(rect.width, 260)}px`;
	// 智能定位（同上 _openMentionMenu）
	this._positionDropdownRelativeTo(this._slashMenuEl, rect, 280);

	// Items (render directly since we just created the element)
	const list = this._createEl('div');
	list.className = 'slash-menu-list';
	this._renderSlashItems(list, items);

	this._slashMenuEl.appendChild(list);
	this._ownerDocument.body.appendChild(this._slashMenuEl);
	this._slashMenuIndex = 0;
	this._highlightSlashMenuItem();
}

/**
 * 收集 slash 菜单条目：**命令 + skills + workflows** ✓（2026-09-22 新增命令 ✓）。
 *
 * ⚠ 命令排在最前 ✓：它们与 skill/workflow 的**语义不同** —— skill/workflow 是"插入一个 chip
 * 组成提示词"✗，命令是"**立即执行**一个动作"✓（如 `/compact`）⇒ 放前面既能被优先看到 ✓，
 * 也避免用户误以为命令也会被插成 chip ✓。
 * ⚠ 命令列表**缺失/为空就不出现** ✗✓（宿主拿不到执行器时不应给出死条目 ✓）。
 *
 * ⚠ 条目类型**用内联结构类型** ✗✓：本类是模块内的类，**不能**在类体里声明 `interface`/`type`
 * （会导致整份文件语法错 ✓ —— 我第一版就这么写错了一次 ✓）。
 */
private _collectSlashItems(filter: string): Array<{ kind: 'skill' | 'workflow' | 'command'; id: string; label: string; description: string; command?: string }> {
	const skills = this._onListSkills();
	const workflows: ReadonlyArray<IWorkflowChipItem> = this._onListWorkflows?.() ?? [];
	const commands = this._onListSlashCommands?.() ?? [];

	const f = filter.toLowerCase();
	const cmdFiltered = filter
		? commands.filter(c => c.command.toLowerCase().includes(f) || c.label.toLowerCase().includes(f))
		: commands;
	const skillFiltered = filter
		? skills.filter(s =>
			s.id.toLowerCase().includes(f) ||
			s.name.toLowerCase().includes(f))
		: skills;
	const wfFiltered = filterWorkflowItems(
		workflows.map(w => ({ id: w.id, name: w.name, description: w.description })),
		filter,
	);

	const items: Array<{ kind: 'skill' | 'workflow' | 'command'; id: string; label: string; description: string; command?: string }> = [];
	for (const c of cmdFiltered) {
		items.push({ kind: 'command', id: c.command, label: `/${c.command}`, description: c.description, command: c.command });
	}
	for (const s of skillFiltered) {
		items.push({ kind: 'skill', id: s.id, label: s.id, description: s.name || s.id });
	}
	for (const w of wfFiltered) {
		items.push({ kind: 'workflow', id: w.id, label: w.name || w.id, description: w.description || w.id });
	}
	return items;
}

/** 渲染 slash 菜单条目到列表容器（command / skill / workflow 混排，靠 dataset 区分 ✓）。 */
private _renderSlashItems(
	list: HTMLElement,
	items: Array<{ kind: 'skill' | 'workflow' | 'command'; id: string; label: string; description: string; command?: string }>,
): void {
	for (const it of items) {
		const item = this._createEl('div');
		item.className = 'slash-menu-item';
		// 2026-09-10：skill 与 workflow 可能同名（如「表情包工作流」既有 skill 又有
		// workflow），此前菜单无任何 kind 标识，用户会误以为重复。加 --skill/--workflow
		// 修饰类 + 右侧 kind badge，让两类条目一眼可辨（skill 蓝 / workflow 橙）。
		// 2026-09-22：新增 --command（紫）+ 「command」badge ⇒ 三类一眼可辨 ✓。
		item.classList.add(
			it.kind === 'workflow' ? 'slash-menu-item--workflow'
				: it.kind === 'command' ? 'slash-menu-item--command'
					: 'slash-menu-item--skill');
		if (it.kind === 'skill') {
			item.dataset.skillId = it.id;
			item.dataset.skillName = it.label;
		} else if (it.kind === 'command') {
			// ⚠ 命令**不插 chip**，而是执行 ✓ ⇒ dataset 只存命令名 ✓
			item.dataset.commandId = it.command ?? it.id;
		} else {
			item.dataset.workflowId = it.id;
			item.dataset.workflowName = it.label;
		}
		const icon = this._createEl('span');
		icon.className = 'slash-menu-item-icon';
		icon.textContent = it.kind === 'workflow' ? '▶' : '/';
		item.appendChild(icon);
		const info = this._createEl('span');
		info.className = 'slash-menu-item-info';
		const name = this._createEl('span');
		name.className = 'slash-menu-item-name';
		name.textContent = it.label;
		info.appendChild(name);
		const desc = this._createEl('span');
		desc.className = 'slash-menu-item-desc';
		desc.textContent = it.description;
		info.appendChild(desc);
		item.appendChild(info);
		const kindBadge = this._createEl('span');
		kindBadge.className = 'slash-menu-item-kind';
		kindBadge.textContent = it.kind === 'workflow' ? 'workflow' : it.kind === 'command' ? 'command' : 'skill';
		item.appendChild(kindBadge);
		item.addEventListener('mousedown', (e) => {
			e.preventDefault();
			if (it.kind === 'workflow') {
				this._insertSlashWorkflow(it.id, it.label);
			} else if (it.kind === 'command') {
				this._runSlashCommand(it.command ?? it.id, '');
			} else {
				this._insertSlashSkill(it.id, it.label);
			}
			this._closeSlashMenu();
		});
		list.appendChild(item);
	}
}

/**
 * 执行一条斜杠命令 ✓（2026-09-22）：清空输入框 → 交给宿主执行 ✓。
 *
 * ⚠ 面板**不**关心命令语义 ✗✓（`/compact` 的实现在宿主/服务侧 ✓）：面板只做
 * 「识别 → 清空 → 调用」三件事 ✓ ⇒ 新增命令**不需要动面板** ✓✓。
 * ⚠ 宿主缺失执行器 ⇒ 静默返回 ✓（菜单本来就不会显示这类命令 ✓，双保险 ✓）。
 */
protected _runSlashCommand(command: string, arg: string): void {
	const run = this._onRunSlashCommand;
	if (!run) { return; }
	this._setComposerText?.('');
	this._closeSlashMenu();
	void Promise.resolve(run(command, arg.trim())).catch(() => { /* 执行失败由宿主自行提示 ✓ */ });
}


protected override _renderSlashMenuItems(filter: string): void {
	if (!this._slashMenuEl) { return; }
	const items = this._collectSlashItems(filter);

	const list = this._slashMenuEl.querySelector('.slash-menu-list') as HTMLElement | null;
	if (!list) { return; }
	clearNode(list);

	if (!items.length) {
		this._closeSlashMenu();
		return;
	}

	this._renderSlashItems(list, items);

	this._slashMenuIndex = Math.min(this._slashMenuIndex, items.length - 1);
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

/** 创建内联 workflow chip 节点：嵌在 contentEditable 文本流中，与文字混排。 */
protected _createWorkflowChipNode(id: string, name: string, params?: Record<string, string>): HTMLElement {
	const chip = this._createEl('span');
	chip.className = 'inline-workflow-chip';
	chip.dataset.workflowId = id;
	chip.setAttribute('contenteditable', 'false');
	chip.title = `工作流: ${name} (${id})`;

	const icon = this._createEl('span');
	icon.className = 'inline-workflow-chip-icon';
	icon.textContent = '▶';
	chip.appendChild(icon);

	const label = this._createEl('span');
	label.className = 'inline-workflow-chip-name';
	label.textContent = name;
	chip.appendChild(label);

	// 已设参数徽标（点击 chip 主体可重新编辑）
	if (params && Object.keys(params).length > 0) {
		const badge = this._createEl('span');
		badge.className = 'inline-workflow-chip-badge';
		badge.textContent = `· ${Object.keys(params).length} 参数`;
		chip.appendChild(badge);
		chip.dataset.params = encodeWorkflowChipParams(params);
	}

	const removeBtn = this._createEl('span');
	removeBtn.className = 'inline-workflow-chip-remove';
	removeBtn.textContent = '✕';
	chip.appendChild(removeBtn);
	this._register(addDisposableListener(removeBtn, EventType.MOUSE_DOWN, (e) => {
		e.preventDefault();
		e.stopPropagation();
	}));
	this._register(addDisposableListener(removeBtn, EventType.CLICK, (e) => {
		e.stopPropagation();
		e.preventDefault();
		this._removeWorkflowChip(id);
	}));
	// 点击 chip 主体（非 ✕）→ 打开参数表单
	this._register(addDisposableListener(chip, EventType.CLICK, (e) => {
		e.stopPropagation();
		e.preventDefault();
		this._openWorkflowParamsPanel(chip);
	}));
	return chip;
}

/** 从 DOM 收集当前 composer 内的 workflow id（DOM 是唯一真源；最多取首个）。 */
protected _getWorkflowChipId(): string | undefined {
	const root = this._textarea;
	if (!root) { return undefined; }
	const el = root.querySelector('.inline-workflow-chip') as HTMLElement | null;
	return el?.dataset.workflowId || undefined;
}

/** 从 DOM 读取指定 workflow chip 的表单参数（data-params）。 */
protected _getWorkflowChipParams(id: string): Record<string, string> | undefined {
	const root = this._textarea;
	if (!root) { return undefined; }
	const el = root.querySelector(`.inline-workflow-chip[data-workflow-id="${CSS.escape(id)}"]`) as HTMLElement | null;
	return decodeWorkflowChipParams(el?.dataset.params);
}

/** 读取指定工作流需填写的模板变量（排除 {{input}}——input 由 chip 后聊天文本提供）。 */
private _getWorkflowFormVariables(id: string): ReadonlyArray<{ name: string; defaultValue: string }> {
	const wf = this._onListWorkflows?.().find(w => w.id === id);
	if (!wf?.variables) { return []; }
	return wf.variables.filter(v => v.name !== 'input');
}

/** 打开工作流参数表单面板（点击 chip 主体触发；无变量则不弹）。 */
protected _openWorkflowParamsPanel(chip: HTMLElement): void {
	this._closeWorkflowParamsPanel();
	const id = chip.dataset.workflowId;
	if (!id) { return; }
	const variables = this._getWorkflowFormVariables(id);
	if (variables.length === 0) { return; }

	const rect = chip.getBoundingClientRect();
	const current = decodeWorkflowChipParams(chip.dataset.params) ?? {};

	const panel = this._createEl('div');
	panel.className = 'workflow-params-panel';
	panel.style.left = `${rect.left}px`;
	this._positionDropdownRelativeTo(panel, rect, 360);

	const header = this._createEl('div');
	header.className = 'workflow-params-header';
	header.textContent = '工作流参数';
	panel.appendChild(header);

	const body = this._createEl('div');
	body.className = 'workflow-params-body';

	// 预填字段（变量 → input 映射，供提交时收集）
	const fields: Array<{ name: string; input: HTMLInputElement }> = [];
	for (const v of variables) {
		const row = this._createEl('div');
		row.className = 'workflow-params-row';
		const label = this._createEl('label');
		label.className = 'workflow-params-label';
		label.textContent = v.name;
		label.title = v.name;
		const input = this._createEl('input') as HTMLInputElement;
		input.className = 'workflow-params-input';
		input.type = 'text';
		input.placeholder = v.defaultValue || `请输入 {{${v.name}}}`;
		input.value = current[v.name] ?? '';
		row.appendChild(label);
		row.appendChild(input);
		body.appendChild(row);
		fields.push({ name: v.name, input });
	}

	const actions = this._createEl('div');
	actions.className = 'workflow-params-actions';
	const cancelBtn = this._createEl('button');
	cancelBtn.className = 'workflow-params-btn';
	cancelBtn.textContent = '取消';
	const okBtn = this._createEl('button');
	okBtn.className = 'workflow-params-btn workflow-params-btn-primary';
	okBtn.textContent = '确定';
	actions.appendChild(cancelBtn);
	actions.appendChild(okBtn);
	body.appendChild(actions);

	panel.appendChild(body);
	this._ownerDocument.body.appendChild(panel);
	this._workflowParamsEl = panel;

	const submit = () => {
		const values: Record<string, string> = {};
		for (const f of fields) {
			const v = f.input.value;
			// 保留用户显式填写的值；空值也保留（避免丢键），但空字符串由序列化 `--k=` 承载
			values[f.name] = v;
		}
		// 去掉全空值（用户未填任何内容时不写入 data-params，避免空徽标）
		const nonEmpty: Record<string, string> = {};
		for (const [k, v] of Object.entries(values)) {
			if (v !== '') { nonEmpty[k] = v; }
		}
		chip.dataset.params = encodeWorkflowChipParams(nonEmpty);
		// 刷新徽标
		const oldBadge = chip.querySelector('.inline-workflow-chip-badge');
		oldBadge?.remove();
		if (Object.keys(nonEmpty).length > 0) {
			const badge = this._createEl('span');
			badge.className = 'inline-workflow-chip-badge';
			badge.textContent = `· ${Object.keys(nonEmpty).length} 参数`;
			chip.appendChild(badge);
		}
		this._closeWorkflowParamsPanel();
		this._updateSendButton();
		this._textarea?.dispatchEvent(new Event('input'));
	};

	this._register(addDisposableListener(cancelBtn, EventType.CLICK, () => this._closeWorkflowParamsPanel()));
	this._register(addDisposableListener(okBtn, EventType.CLICK, submit));

	// 外部点击关闭（capture 阶段；点击面板/chip 内部不关闭）
	const onDocMouseDown = (e: MouseEvent) => {
		const target = e.target as Node | null;
		if (!target) { return; }
		if (panel.contains(target) || chip.contains(target)) { return; }
		this._closeWorkflowParamsPanel();
	};
	this._workflowParamsDisposable = addStandardDisposableListener(this._ownerDocument, EventType.MOUSE_DOWN, onDocMouseDown, true);
	this._register(this._workflowParamsDisposable);

	// 首个输入框自动聚焦
	requestAnimationFrame(() => fields[0]?.input.focus());
}

/** 关闭工作流参数表单面板。 */
protected _closeWorkflowParamsPanel(): void {
	if (this._workflowParamsDisposable) {
		this._workflowParamsDisposable.dispose();
		this._workflowParamsDisposable = null;
	}
	if (this._workflowParamsEl) {
		this._workflowParamsEl.remove();
		this._workflowParamsEl = null;
	}
}

/** 从拖放/粘贴的 DataTransfer 中提取文件夹的系统路径（文件夹附件 chip 用）。 */
protected _collectFolderPathsFromDataTransfer(dtf: DataTransfer | null): string[] {
	if (!dtf) { return []; }
	const items = (dtf as unknown as { items?: DataTransferItem[] }).items;
	if (!items || items.length === 0) { return []; }
	const dirNames: string[] = [];
	for (const it of Array.from(items)) {
		if (it.kind !== 'file') { continue; }
		// webkitGetAsEntry 非标准，但 Chromium/Electron 支持，用于区分目录
		const entry = (it as unknown as { webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null }).webkitGetAsEntry?.();
		if (entry && entry.isDirectory) {
			dirNames.push(entry.name);
		}
	}
	if (dirNames.length === 0) {
		// 拖放普通文件时 dtf.files 有内容，走 _addFiles；仅当无 files 且 uri-list 含 file:// 路径时按文件夹处理。
		const noFiles = !dtf.files || dtf.files.length === 0;
		if (!noFiles) { return []; }
		const uriList = dtf.getData('text/uri-list') ?? '';
		return uriList
			.split(/\r\n|\r|\n/)
			.map(s => s.trim())
			.filter(Boolean)
			.filter(s => s.startsWith('file://'))
			.map(s => decodeURIComponent(s.replace(/^file:\/\//, '')).replace(/^\/+/, ''));
	}

	const uriList = dtf.getData('text/uri-list') ?? '';
	const paths = uriList
		.split(/\r\n|\r|\n/)
		.map(s => s.trim())
		.filter(Boolean)
		.filter(s => s.startsWith('file://'))
		.map(s => decodeURIComponent(s.replace(/^file:\/\//, '')).replace(/^\/+/, ''));

	const result: string[] = [];
	for (const name of dirNames) {
		const matched = paths.find(p => p.endsWith('/' + name) || p.endsWith('\\' + name) || p === name);
		result.push(matched ?? name);
	}
	return result;
}

/**
 * 从拖放的 DataTransfer 中提取「文件名 → 系统路径」映射（来自 text/uri-list 的
 * file:// 路径）。文件路径用于点击 chip 时在文件编辑器中打开对应资源。
 * 说明：Chromium 出于安全限制不会在 File 对象上暴露真实路径，但拖放时
 * text/uri-list 会携带 file:// 完整路径，故按文件名匹配。
 */
protected _collectFilePathsFromDataTransfer(dtf: DataTransfer | null): Record<string, string> {
	const map: Record<string, string> = {};
	if (!dtf) { return map; }
	const uriList = dtf.getData('text/uri-list') ?? '';
	for (const line of uriList.split(/\r\n|\r|\n/)) {
		const t = line.trim();
		if (!t.startsWith('file://')) { continue; }
		const p = decodeURIComponent(t.replace(/^file:\/\//, '')).replace(/^\/+/, '');
		if (!p) { continue; }
		const name = p.split(/[\\/]/).pop() || p;
		if (!map[name]) { map[name] = p; }
	}
	return map;
}

/** 给定文件夹系统路径数组，逐个生成文件夹附件 chip（📁 图标，data 为路径）。 */
protected _addFolderAttachments(paths: string[]): void {
	for (const p of paths) {
		const name = p.split(/[\\/]/).pop() || p;
		const att: IChatAttachment = {
			id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			type: 'folder',
			name,
			mimeType: 'application/x-folder',
			data: p,
			filePath: p,
			size: 0,
			isPasted: false,
		};
		this._attachments.push(att);
		this._renderAttachmentPreviews();
		this._insertInlineAttachmentChip(att);
	}
}

/** 内联插入 workflow chip（去重 + 光标后置）。 */
protected _addWorkflowChip(id: string, name: string): void {
	const root = this._textarea;
	if (!root) { return; }
	if (root.querySelector(`.inline-workflow-chip[data-workflow-id="${CSS.escape(id)}"]`)) { return; }
	const chip = this._createWorkflowChipNode(id, name);
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
	root.dispatchEvent(new Event('input'));
}

/** 从 DOM 移除指定 workflow chip。 */
protected _removeWorkflowChip(id: string): void {
	const root = this._textarea;
	if (!root) { return; }
	root.querySelector(`.inline-workflow-chip[data-workflow-id="${CSS.escape(id)}"]`)?.remove();
	this._updateSendButton();
}

/** 按 workflow id 查显示名；查不到回退 id 本身。 */
private _resolveWorkflowName(id: string): string {
	const workflows = this._onListWorkflows?.() ?? [];
	return workflows.find(w => w.id === id)?.name || id;
}

/** 创建内联 skill chip 节点：嵌在 contentEditable 文本流中，与文字混排。 */
protected _createSkillChipNode(id: string, name: string): HTMLElement {
	const chip = this._createEl('span');
	chip.className = 'inline-skill-chip';
	chip.dataset.skillId = id;
	chip.setAttribute('contenteditable', 'false');
	chip.title = `技能: ${name} (${id})`;

	const icon = this._createEl('span');
	icon.className = 'inline-skill-chip-icon';
	icon.textContent = '⚡';
	chip.appendChild(icon);

	const label = this._createEl('span');
	label.className = 'inline-skill-chip-name';
	label.textContent = name;
	chip.appendChild(label);

	const removeBtn = this._createEl('span');
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
		// 命令条目：**执行**命令（不是插 chip ✓）—— 2026-09-22 ✓
		if (selected?.dataset.commandId) {
			this._runSlashCommand(selected.dataset.commandId, '');
			this._closeSlashMenu();
			return;
		}
		if (selected?.dataset.workflowId) {
			this._insertSlashWorkflow(selected.dataset.workflowId, selected.dataset.workflowName || selected.dataset.workflowId);
		} else if (selected?.dataset.skillId) {
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

/** slash 菜单选中工作流：清空输入后插入 workflow chip，光标落在 chip 之后。 */
protected _insertSlashWorkflow(workflowId: string, workflowName: string): void {
	this._setComposerText('');
	this._textarea.style.color = '';
	this._textarea.removeAttribute('data-slash-command');
	this._addWorkflowChip(workflowId, workflowName);
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
				// ★ 2026-09-21：优先用「最近一次请求的 prompt 大小」——`input` 的语义是**本 turn 累加消费**
				// （多轮 agent loop 每轮 LLM 调用各发一次 usage delta 并累加，供 footer 展示总消耗），
				// 拿它当上下文占用会让长 turn 后环暴涨：实测 1,465,040 vs 真实 prompt 80,724
				// ⇒ 环显示 100%/danger，而压缩判定（real usage < 140k 线）永不触发 —— 用户观感"超标却不压缩"。
				if (m.tokenUsage.promptTokens && m.tokenUsage.promptTokens > 0) {
					return m.tokenUsage.promptTokens;
				}
				if (m.tokenUsage.input > 0) {
					return m.tokenUsage.input + (m.tokenUsage.output || 0);
				}
				return m.tokenUsage.total;
			}
		}
		// 无真实 usage（新对话或首条消息）：降级为逐条字符估算。
		// 2026-09-17 性能修复：该分支对**全部消息的完整文本**做 length 扫描
		// （content + thinking + 每个 toolCall 的 args/result/name），而
		// _computeContextUsage 在每次 _updateMessageDom 时都会被调用（流式期间
		// 每个 delta 一次）⇒ 历史越长每帧越慢（用户报「历史多了发消息卡顿」）。
		// 估算结果只依赖消息集合本身，故按「消息数 + 末条 id（内容变更时 id 不变
		// 但长度/内容会变，故叠加末条内容长度）+ 最后一条的文本指纹」做缓存，
		// 命中则直接复用，避免重复扫描全部历史。
		const cacheKey = this._buildBaselineEstimateCacheKey();
		if (this._baselineEstimateCache?.key === cacheKey) {
			return this._baselineEstimateCache.value;
		}

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
		this._baselineEstimateCache = { key: cacheKey, value: total };
		return total;
	}

	/**
	 * 为「逐条字符估算」构建缓存键。
	 *
	 * 仅凭 messages.length 不足以保证结果不变：同一条消息在流式期间会被就地
	 * 更新（content 增长、toolCalls 追加），此时长度与 id 都不变。因此额外纳入
	 * 最后一条消息的文本量（content + thinking + toolCalls 数）作为变更信号。
	 * 成本 O(1)（只读最后一条 + toolCalls 长度），远低于全量扫描。
	 */
	private _buildBaselineEstimateCacheKey(): string {
		const count = this._messages.length;
		if (count === 0) { return '0'; }
		const last = this._messages[count - 1];
		const toolCallCount = Array.isArray(last.toolCalls) ? last.toolCalls.length : 0;
		return `${count}|${last.id}|${last.content?.length ?? 0}|${last.thinking?.length ?? 0}|${toolCallCount}`;
	}

protected override _computeContextUsage(): IContextUsage | null {
		// 从当前模型获取 maxInputTokens（匹配 React：currentModel?.maxInputTokens）
		const currentModelInfo = this._models.find(m => m.id === this._currentModel);
		const declaredLimit = currentModelInfo?.maxInputTokens ?? 0;
		if (declaredLimit <= 0) {
			return null;
		}
		// 分母对齐压缩判定（2026-09-04）：优先用 host 推送的 effectiveWindow
		// （ContextManager.resolveEffectiveWindow 唯一真源：clamp(模型窗口, 64k, 200k)）。
		// 大窗口模型（contextWindow>200k，如 1M 模型解析出 936000）此前分母用原始
		// maxInputTokens → 环显示 60601/936000≈6%，实际判定 30% 触发压缩——
		// 即「UI 显示没满却压缩」的主因。无推送（空闲/刷新后）回退模型声明值。
		// ★ 2026-09-21：兜底分母也必须与压缩判定同口径（clamp(声明窗口, 64k, 200k)）。
		// 此前直接回退 declaredLimit（1M 模型 ⇒ 1,000,000）⇒ 推送缺失时（守卫失败 / 刚重载窗口）
		// 环的满刻度与压缩线错位，出现「146% 却不压缩」的观感。
		const limit = this._contextUsage?.effectiveWindow
			?? (declaredLimit > 0 ? ContextManager.resolveEffectiveWindowDefault(declaredLimit).effectiveWindow : 0);

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
			// 2026-09-05 修复：computed 只含本地面板三层估算（used/limit/ratio/percent），
			// 不含 host 推送的 effectiveWindow/thresholdTokens（setContextUsage 自
			// 2026-09-04 起携带的压缩判定口径字段）。原实现整体覆盖 _contextUsage，
			// 推送字段只存活到下一次重算即丢失 → 分母回落模型声明 maxInputTokens、
			// 压缩线消失，2026-09-04 的「环 6% 实际 30%」对齐修复实际失效。
			// 改为字段级合并：估值以 computed 为准，保留推送的对齐口径
			// （_computeContextUsage 的 limit 优先级恰好依赖此处的 effectiveWindow 存续）。
			const pushed = this._contextUsage;
			const pushedEffectiveWindow = pushed?.effectiveWindow;
			const pushedThresholdTokens = pushed?.thresholdTokens;
			this._contextUsage = {
				...computed,
				...(pushedEffectiveWindow !== undefined && pushedEffectiveWindow > 0
					? { effectiveWindow: pushedEffectiveWindow }
					: {}),
				...(pushedThresholdTokens !== undefined && pushedThresholdTokens > 0
					? { thresholdTokens: pushedThresholdTokens }
					: {}),
			};
		}
		// 渲染环形进度条
		const ring = this._container.querySelector('.context-usage-ring') as HTMLElement | null;
		if (!ring) { return; }
		const parent = ring.parentElement;
		if (!parent) { return; }
		const sendBtn = parent.querySelector('.chat-send-circle');
		// 2026-09-11：环的重排锚点从「发送按钮之前」改为「提示词优化按钮之前」——
		// 目标顺序为 字符计数 → 上下文环 → ✨ 优化 → 发送；若优化按钮不存在（CLI 等）
		// 再回退到发送按钮之前。
		const ringAnchor = this._promptOptimizeBtn ?? sendBtn;
		ring.remove();
		const tempParent = $('div');
		this._renderContextUsageRing(tempParent);
		const newRing = tempParent.firstElementChild;
		if (!newRing) { return; }
		// 2026-09-11 修复：本方法可由 500ms 防抖回调触发（_updateContextRing 流式期间），
		// 回调执行时 DOM 可能已重排——ringAnchor 被移除或挂到了其它容器。
		// insertBefore 要求参照节点是 parent 的直接子节点，否则抛 NotFoundError
		// （未捕获，用户日志实测崩溃）。插入前校验，失配则回退 appendChild。
		if (ringAnchor && ringAnchor.parentElement === parent) {
			parent.insertBefore(newRing, ringAnchor);
		} else {
			parent.appendChild(newRing);
		}
	}

protected override _renderInlineAttachmentChips(): void {
		const root = this._textarea;
		if (!root) { return; }
		for (const att of this._attachments) {
			if (root.querySelector(`.inline-attachment-chip[data-att-id="${att.id}"]`)) { continue; }
			const spaceBefore = this._ownerDocument.createTextNode(' ');
			const spaceAfter = this._ownerDocument.createTextNode(' ');
			root.appendChild(spaceBefore);
			root.appendChild(this._createAttachmentChipNode(att));
			root.appendChild(spaceAfter);
		}
		if (this._attachments.length) { this._focusComposerEnd(); }
	}

	/**
	 * 排程一次输入框高度同步（rAF 合并，同一帧内多次输入只执行一次）。
	 *
	 * 拆成独立方法的原因见 `agentChatPanel.base.ts` 中 `_composerHeightRaf` 的注释：
	 * 高度测量会强制同步布局，绝不能留在击键的同步路径上。
	 */
protected _scheduleComposerHeightSync(): void {
	if (this._composerHeightRaf) { return; }
	this._composerHeightRaf = requestAnimationFrame(() => {
		this._composerHeightRaf = 0;
		// ★ 2026-09-18 性能埋点：`_applyComposerHeight` 会**读写消息区 scrollTop**
		//（成本 ∝ 消息区 DOM 体积）⇒ 计时以便确认它在大历史会话里是否仍是可感知成本 ✓
		chatPerf.span('composer.applyHeight', () => this._applyComposerHeight());
	});
}

	/**
	 * 按内容高度自适应输入框（含消息区滚动位置补偿）。
	 *
	 * 读取顺序刻意保持「先写 auto、再读 scrollHeight」——这是测量
	 * `scrollHeight` 的必要手段（否则读到的是当前固定高度）。但与旧实现
	 * 的区别是：它现在只在 rAF 回调里跑，一帧至多一次，不再每次击键都触发。
	 */
protected _applyComposerHeight(): void {
		const t = this._textarea;
		if (!t) { return; }

		// 保存消息区滚动位置：输入框高度变化会挤压 flex 布局的消息区，
		// 浏览器自动调整 scrollTop 导致滚动条跳动。保存后恢复即可避免。
		const savedScrollTop = this._messagesContainer?.scrollTop ?? 0;

		t.style.height = 'auto';
		const measured = t.scrollHeight;
		const target = this._computeComposerHeight(measured);

		// ★★ 2026-09-18 修复（用户报「输入文本时高度会被自动调整成 1 行」✗）：
		//   上面 `height='auto'` 是测量 `scrollHeight` 的必要手段 ✓（元素有固定高度时
		//   `scrollHeight` 会返回"固定高度"而不是内容高度 ⇒ 不重置就量不到真实内容高 ✓），
		//   但它**把 inline 高度清空了** ✗ —— 于是这一步的写回是**必需**的，绝不是冗余优化 ✗。
		//   旧代码写成「只有 `target !== _lastComposerHeight` 才写回」✗✗，于是当**目标高度没变**
		//   时直接跳过 ⇒ inline 高度**永久停在 `auto`** ⇒ 塌成内容高度（**1 行** ✓✓）。
		//   触发条件（与用户现象完全吻合）：用户拖高过输入框 / localStorage 恢复过高度 ⇒
		//   `_userHasAdjustedHeight=true` ⇒ `target = min(max(内容高, 拖动高), 320)` = **拖动高**；
		//   而"打字"通常不改变内容高度 ⇒ `target` 恒等于上次值 ⇒ **每次击键都跳过写回** ✗
		//   ⇒ 输入框塌成 1 行且不恢复 ✓（CSS 无 transition ⇒ 瞬间塌 ✓，与真机现象一致 ✓）
		//   修法：**无条件写回**（把值设成同一个 px 不会触发额外重排：`auto` 那次已经弄脏布局，
		//   同一任务内写回只合并为一次 layout ✓）。
		// ★ 2026-09-22 修复判据（完整说明见下方恢复段的注释 ✓）：**真正的扰动信号是 `auto` 那次
		//   测量**，而不是"最终目标高度是否变化" ✗✓。
		//   判据取自**已有值**（`measured` = 本帧刚量到的内容高 ✓；`_lastComposerHeight` = 本次测量
		//   前生效的 inline 高 ✓）⇒ **零额外布局读取** ✓ ⇒ 2026-09-19 的性能修复收益不变 ✓。
		const autoDisturbed = measured !== this._lastComposerHeight;
		t.style.height = target + 'px';
		this._lastComposerHeight = target;

		// ★★ 2026-09-19 性能修复：**只在布局真的被扰动过**时才去动消息区的滚动位置。
		// 下面那句读 `_messagesContainer.scrollTop` 会**强制一次同步布局** ✗，而上一行刚写完
		// `height` 已把布局弄脏 ⇒ 这一次 layout 是**整文档级**的。真机实测（日志 `[ChatPerf]`）：
		//   `composer.applyHeight ×174 total=11766ms avg=67.6ms max=83ms` ✗✗（每次击键 ~68ms！）
		//   同时 `[MemSnap] dom nodes=106137`（93 条消息 ⇒ ~1140 节点/条 ✗）⇒ layout 成本 ∝ DOM ✓。
		// ⚠⚠ 2026-09-22 **修正上面那句推理** ✗✓：「最终目标高度没变」**不等于**「消息区尺寸没变」✗✗ ——
		//   因为 `:2081` 的 `height='auto'` 会先**真实压扁**输入框（清掉 inline 高 ⇒ 塌到内容高 ✓）⇒
		//   消息区 `clientHeight` 瞬时**变大** ⇒ `maxScroll` 变小 ⇒ `:2082` 那次读 `scrollHeight` 触发的
		//   强制布局会把 `scrollTop` **钳制下调** ✗ ⇒ 这正是用户报的「输入文字过程中上方滚动条莫名
		//   向上滚一下」✓✓。
		//   命中它的典型场景恰恰是 `heightChanged === false` ✗：用户拖高过输入框（`_userHasAdjustedHeight` ✓）
		//   时 `target` 恒等于拖动高 ⇒ 每次击键都被判"没变" ⇒ 钳制造成的上跳**永不恢复** ✗✗
		//   （一次可跳数十~数百 px ✓ 与用户"莫名向上滚一下"的描述完全吻合 ✓）。
		//   ⇒ 门控改用 `autoDisturbed`（= `auto` 这一步是否真的改变了高度 ✓）：它才是"消息区尺寸被
		//     扰动过"的**充要信号** ✓；常见情形（未拖高 + 打字不换行 ⇒ measured === _lastComposerHeight）
		//     仍走**零成本快路径** ✓ ⇒ 2026-09-19 的收益保持不变 ✓✓。
		//   代价（刻意接受 ✓）：拖高过输入框的用户每次击键会多做一次恢复（一次布局 ✓）—— 这是为
		//     正确性付的有限代价 ✓。彻底解法是"在**离屏克隆**上测量内容高"（改动面大 ✗ 未在本轮做 ✓）。
		if (autoDisturbed && this._messagesContainer) {
			// ★★★ 2026-09-21（用户报「**输入框输入过程中，上方聊天框滚动条会滚动**」✗✓）：
			//   输入框变高 ⇒ flex 列挤压 ⇒ 消息区 `clientHeight` 变小 ⇒ `scrollHeight` 不变而
			//   **maxScroll 变大** ⇒ `scrollTop` 不变 ⇒ **视窗相对内容下滑** ⇒ 每敲出一个新行，
			//   聊天内容就"被顶上去"一截 ✗✓（用户看到的"打字引发滚动" ✓）。
			//   ⇒ 分两种语义处理 ✓：
			//     · **贴底用户**（`_isAtBottom` ✓）：必须**重新钉底**（scrollTop = scrollHeight ✓）
			//       —— 只恢复 savedScrollTop（旧 maxScroll）会**永久偏离底部 Δh** ✗✓；
			//     · **上滚阅读的用户**：恢复 savedScrollTop ✓（保住阅读锚点 ✓）。
			if (this._isAtBottom) {
				this._messagesContainer.scrollTop = this._messagesContainer.scrollHeight;
			} else if (this._messagesContainer.scrollTop !== savedScrollTop) {
				this._messagesContainer.scrollTop = savedScrollTop;
			}
		}
	}

	/**
	 * 由内容高度计算输入框目标高度（唯一实现，供 composer / send 复用）。
	 *
	 * 用户手动拖拽过高度时，其设定值作为下限生效（`Math.max`），
	 * 避免输入内容变少后输入框塌回默认高度。
	 */
protected _computeComposerHeight(contentHeight: number): number {
		const maxAllowed = 320;
		return this._userHasAdjustedHeight
			? Math.min(Math.max(contentHeight, this._resizeMaxH), maxAllowed)
			: Math.min(contentHeight, this._resizeMaxH);
	}
	/**
	 * 开启一次输入框性能采样（仅当 `window.__SAROSIS_COMPOSER_DIAG` 为真）。
	 *
	 * 用于实测「打字卡顿」的剩余来源 —— 把一次击键的同步耗时拆成若干阶段，
	 * 累积后按样本数输出统计，避免逐次击键刷屏。
	 *
	 * 关闭时返回 null，调用方用 `_cd?.mark(...)` 的可选链，开销仅一次布尔读取。
	 *
	 * 用法（DevTools Console）：
	 *   window.__SAROSIS_COMPOSER_DIAG = true    // 开启采样
	 *   window.__SAROSIS_COMPOSER_DIAG = false   // 关闭并打印最终汇总
	 *   window.__SAROSIS_COMPOSER_DIAG_DUMP()    // 手动打印并清零当前汇总
	 */
private _startComposerDiag(): IComposerDiagFrame | null {
		if (!(this._ownerWindow as any).__SAROSIS_COMPOSER_DIAG) {
			// 关闭瞬间若仍有累积样本，打印汇总后清零，便于「测完即关」。
			if (this._composerDiagSamples.length > 0) { this._flushComposerDiag(); }
			return null;
		}
		return this._newComposerDiagFrame();
	}

	/**
	 * 构造一帧采样器。分段边界由调用方通过 `mark(name)` 打点，
	 * `end()` 计算总耗时与各段耗时后压入样本数组。
	 */
private _newComposerDiagFrame(): IComposerDiagFrame {
		const t0 = performance.now();
		let last = t0;
		const segments: Record<string, number> = {};
		let ended = false;

		return {
			mark: (name: string) => {
				const now = performance.now();
				segments[name] = (segments[name] ?? 0) + (now - last);
				last = now;
			},
			end: () => {
				if (ended) { return; }
				ended = true;
				const total = performance.now() - t0;
				segments['__total'] = total;
				this._composerDiagSamples.push({ total, segments });
				// 每 50 次击键汇总一次，避免逐次刷屏淹没日志。
				if (this._composerDiagSamples.length >= 50) { this._flushComposerDiag(); }
			},
		};
	}

	/**
	 * 汇总并打印采样结果，然后清零。
	 *
	 * 输出各阶段的 avg / max，以及超过 16ms（一帧预算）的样本占比 ——
	 * 后者直接对应「能感知到的卡顿」。
	 */
private _flushComposerDiag(): void {
		const samples = this._composerDiagSamples;
		this._composerDiagSamples = [];
		if (samples.length === 0) { return; }

		const totals = samples.map(s => s.total);
		const avgTotal = totals.reduce((a, b) => a + b, 0) / totals.length;
		const maxTotal = Math.max(...totals);
		const overFrame = totals.filter(t => t > 16).length;

		const stageNames = new Set<string>();
		for (const s of samples) { for (const k of Object.keys(s.segments)) { stageNames.add(k); } }
		const stageStats: Record<string, { avg: number; max: number }> = {};
		for (const name of stageNames) {
			const vals = samples.map(s => s.segments[name] ?? 0);
			stageStats[name] = {
				avg: vals.reduce((a, b) => a + b, 0) / vals.length,
				max: Math.max(...vals),
			};
		}

		console.info(
			`[ComposerDiag] samples=${samples.length} ` +
			`total avg=${avgTotal.toFixed(2)}ms max=${maxTotal.toFixed(2)}ms ` +
			`over16ms=${overFrame}/${samples.length} (${((overFrame / samples.length) * 100).toFixed(1)}%)`,
		);
		const rows = Object.entries(stageStats)
			.sort((a, b) => b[1].avg - a[1].avg)
			.map(([name, st]) => ({ 阶段: name, 'avg(ms)': +st.avg.toFixed(3), 'max(ms)': +st.max.toFixed(3) }));
		console.table(rows);
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
		// workflow chip → 内联标记 `/workflow <id>`（+ 参数 `--k=v`）：保留 chip 位置，气泡/历史恢复据此还原。
		if (el.classList.contains('inline-workflow-chip')) {
			const id = el.dataset.workflowId;
			if (!id) { return; }
			out += `/workflow ${id}`;
			const params = decodeWorkflowChipParams(el.dataset.params);
			if (params && Object.keys(params).length > 0) {
				out += ' ' + serializeInlineWorkflowArgs(params);
			}
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
			// 解析内联 skill / workflow 标记（/skill <id>、/workflow <id>）→ 重建 chip 节点（历史恢复/草稿恢复）
			const segments = text.split(/(\/skill\s+[\w-]+|\/workflow\s+wf-[\w-]+)/g);
			for (let i = 0; i < segments.length; i++) {
				const seg = segments[i];
				const wm = seg.match(/^\/workflow\s+(wf-[\w-]+)$/);
				if (wm) {
					// 消费 mark 之后紧跟的 `--k=v` 参数（序列化格式 `/workflow <id> --k=v input`）
					let params: Record<string, string> | undefined;
					if (i + 1 < segments.length) {
						const parsed = parseInlineWorkflowArgs(segments[i + 1]);
						if (Object.keys(parsed.variables).length > 0) {
							params = parsed.variables;
							segments[i + 1] = parsed.input; // 剩余文本作为 input 保留
						}
					}
					root.appendChild(this._createWorkflowChipNode(wm[1], this._resolveWorkflowName(wm[1]), params));
					continue;
				}
				const m = seg.match(/^\/skill\s+([\w-]+)$/);
				if (m) {
					root.appendChild(this._createSkillChipNode(m[1], this._resolveSkillName(m[1])));
					continue;
				}
				if (seg) { root.appendChild(this._ownerDocument.createTextNode(seg)); }
			}
		}
		// 重新计算高度，避免多行时被截断（复用统一实现，见 _computeComposerHeight）
		root.style.height = 'auto';
		const newHeight = this._computeComposerHeight(root.scrollHeight);
		root.style.height = newHeight + 'px';
		this._lastComposerHeight = newHeight;
		// 更新字符计数器
		this._updateCharCounter(text);
		// 文本被程序性改写（草稿恢复 / 优化回填 / 发送后清空）时同步优化按钮态
		this._updatePromptOptimizeBtn();
	}

	/** 按 skill id 查显示名（用于标记 → chip 还原）；查不到回退 id 本身。 */
	private _resolveSkillName(id: string): string {
		const skills = this._onListSkills();
		return skills.find(s => s.id === id)?.name || id;
	}

protected override _getCaretOffset(): number {
		const root = this._textarea;
		if (!root) { return 0; }
		const sel = this._ownerWindow?.getSelection();
		if (!sel || sel.rangeCount === 0) { return 0; }
		const range = sel.getRangeAt(0);
		// 光标不在输入框内 → 偏移无意义（也避免下面的 comparePoint 抛错）。
		if (!root.contains(range.endContainer)) { return 0; }

		// ★ 2026-09-18 性能修复：原实现用
		//     pre.selectNodeContents(root) + pre.setEnd(...) + pre.cloneContents()
		//   再遍历克隆结果累加长度 —— `cloneContents()` 会【深拷贝整段 DOM 子树】，
		//   只为算出一个字符偏移量。输入框内文本越长，每次击键的分配与拷贝越贵。
		//
		//   现改用 TreeWalker 顺序遍历文本节点，用 `comparePoint` 判断该节点是否
		//   位于光标之前 —— 零拷贝、零中间 DOM 分配。
		//   注意 chip（inline-attachment/skill/workflow）不贡献偏移量，与旧实现一致。
		let offset = 0;
		const walker = this._ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			if (node === range.endContainer) {
				// 光标就落在本文本节点内 → 加上节点内偏移后结束
				return offset + range.endOffset;
			}
			// comparePoint < 0 表示该节点起点在光标之前
			if (range.comparePoint(node, 0) < 0 && !this._isChipTextNode(node)) {
				offset += (node.textContent ?? '').length;
			}
			node = walker.nextNode();
		}
		return offset;
	}

	/**
	 * 判断文本节点是否属于 chip（内联附件 / skill / workflow）。
	 *
	 * chip 在 `_getComposerText` 中以整体标记形式贡献文本，不按字符计入光标偏移，
	 * 故 `_getCaretOffset` 必须跳过它们的内部文本节点，保持与旧实现语义一致。
	 */
private _isChipTextNode(node: Node): boolean {
		const parent = node.parentElement;
		if (!parent) { return false; }
		return parent.classList.contains('inline-attachment-chip')
			|| parent.classList.contains('inline-skill-chip')
			|| parent.classList.contains('inline-workflow-chip');
	}

protected override _focusComposerEnd(): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = this._ownerWindow?.getSelection();
		if (!sel) { return; }
		const range = this._ownerDocument.createRange();
		range.selectNodeContents(root);
		range.collapse(false);
		sel.removeAllRanges();
		sel.addRange(range);
	}

protected override _insertTextAtCaret(text: string): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = this._ownerWindow?.getSelection();
		const existing = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (existing && root.contains(existing.startContainer)) {
			// 用「纯文本偏移量」定位光标：先记下插入点（选区起点）的偏移，插入后把光标
			// 放到 insertOffset + text.length。偏移量基于 DOM 字符计数、不依赖插入的
			// textNode 引用——浏览器把新文本节点与相邻文本节点合并后引用会失效，
			// setStartAfter(detachedNode) 会落错位置（打包版曾因此光标不在尾部）。
			const insertOffset = this._computeCaretOffset(true);
			existing.deleteContents();
			existing.insertNode(this._ownerDocument.createTextNode(text));
			this._setCaretOffset(insertOffset + text.length);
		} else {
			root.appendChild(this._ownerDocument.createTextNode(text));
			this._focusComposerEnd();
		}
		root.dispatchEvent(new Event('input'));
	}

	/** 计算当前选区端点处的「纯文本」偏移（跳过 chip 内文本）。useStart=true 取选区起点。 */
	private _computeCaretOffset(useStart: boolean): number {
		const root = this._textarea;
		if (!root) { return 0; }
		const sel = this._ownerWindow?.getSelection();
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
				if (!el.classList.contains('inline-attachment-chip') && !el.classList.contains('inline-skill-chip') && !el.classList.contains('inline-workflow-chip')) {
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
		const sel = this._ownerWindow?.getSelection();
		if (!sel) { return; }
		let remaining = Math.max(0, target);
		const walker = this._ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (n) => {
				const p = (n as Text).parentElement;
				return (p && p.closest('.inline-attachment-chip, .inline-skill-chip, .inline-workflow-chip')) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
			},
		});
		let node: Node | null;
		while ((node = walker.nextNode())) {
			const t = node as Text;
			if (remaining <= t.length) {
				const r = this._ownerDocument.createRange();
				r.setStart(t, remaining);
				r.collapse(true);
				sel.removeAllRanges();
				sel.addRange(r);
				return;
			}
			remaining -= t.length;
		}
		// 超出末尾 → 折叠到最后
		const r = this._ownerDocument.createRange();
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
			const sel = this._ownerWindow?.getSelection();
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
		const sel = this._ownerWindow?.getSelection();
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
			if (el.classList.contains('inline-workflow-chip')) {
				const id = el.dataset.workflowId;
				if (id) {
					const params = decodeWorkflowChipParams(el.dataset.params);
					segments.push({ type: 'workflow', id, params });
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
						// ★ 2026-09-19：带上 `kind` ⇒ 片段在复制/粘贴后仍是「代码片段 / 日志片段」✓
						// （漏了它就退化成普通文件 chip ✗，虽然内容 `data` 不丢 ✓）
						kind: att.kind,
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

		// 可读纯文本（复制到外部程序时用）：技能用 /skill 标记、工作流带参数、附件用文件名
		let text = '';
		for (const s of segments) {
			if (s.type === 'text') { text += s.text; }
			else if (s.type === 'skill') { text += `/skill ${s.id}`; }
			else if (s.type === 'workflow') {
				text += `/workflow ${s.id}`;
				if (s.params && Object.keys(s.params).length > 0) { text += ' ' + serializeInlineWorkflowArgs(s.params); }
			}
			else if (s.type === 'attachment') { text += `[${s.name ?? '附件'}]`; }
		}
		return { json: JSON.stringify({ v: 1, segments }), text };
	}

	/** 恢复内部剪贴板片段：在光标处重建文本 + 技能 chip + 附件（图片）chip。 */
	private _restoreComposerPaste(segments: IComposerClipSegment[]): void {
		const root = this._textarea;
		if (!root) { return; }
		root.focus();
		const sel = this._ownerWindow?.getSelection();
		const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
		if (range && root.contains(range.startContainer)) { range.deleteContents(); }

		const frag = this._ownerDocument.createDocumentFragment();
		let lastWasChip = false;
		for (const seg of segments) {
			if (seg.type === 'text') {
				if (seg.text) { frag.appendChild(this._ownerDocument.createTextNode(seg.text)); }
				lastWasChip = false;
			} else if (seg.type === 'skill' && seg.id) {
				if (!lastWasChip) { frag.appendChild(this._ownerDocument.createTextNode(' ')); }
				frag.appendChild(this._createSkillChipNode(seg.id, this._resolveSkillName(seg.id)));
				frag.appendChild(this._ownerDocument.createTextNode(' '));
				lastWasChip = true;
			} else if (seg.type === 'workflow' && seg.id) {
				if (!lastWasChip) { frag.appendChild(this._ownerDocument.createTextNode(' ')); }
				frag.appendChild(this._createWorkflowChipNode(seg.id, this._resolveWorkflowName(seg.id), seg.params));
				frag.appendChild(this._ownerDocument.createTextNode(' '));
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
					// ★ 2026-09-19：还原片段语义（缺它则 chip 显示成普通文件 ✗）
					kind: seg.kind,
				};
				this._attachments.push(att);
				if (!lastWasChip) { frag.appendChild(this._ownerDocument.createTextNode(' ')); }
				frag.appendChild(this._createAttachmentChipNode(att));
				frag.appendChild(this._ownerDocument.createTextNode(' '));
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
					const caret = this._ownerDocument.createRange();
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
