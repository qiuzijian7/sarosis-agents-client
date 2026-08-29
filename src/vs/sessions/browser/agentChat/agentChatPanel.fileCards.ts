import { $, append, addDisposableListener, EventType } from '../../../base/browser/dom.js';
import { IToolCall, IAgentChatMessage, IConfirmationData } from './agentChatTypes.js';
import { AgentChatPanelCodebaseCards } from './agentChatPanel.codebaseCards.js';
import { createSvgIcon, FILE_ICON_D, ERROR_ICON_D } from './agentChatPanel.toolCards.js';
import { parseToolArgsLoose } from './toolArgsJson.js';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { onTerminalLiveOutput, getTerminalLiveOutput, clearTerminalLiveOutput } from './terminalLiveOutput.js';

/**
 * 拆分 shell 命令的提示符前缀，用于终端卡片的命令行高亮显示。
 * 复制按钮仍复制完整命令（不经过本函数），仅显示层拆分。
 *
 * - `PS G:\path>` → prompt=`PS G:\path>`，body=其余（Windows PowerShell）
 * - `$ cmd` / `> cmd` → prompt=`$` / `>`，body=命令（Unix shell / 重定向）
 * - 无前缀 → prompt=''，body=原命令
 */
export function splitTerminalPrompt(commandText: string): { prompt: string; body: string } {
	if (!commandText) { return { prompt: '', body: '' }; }
	const psMatch = commandText.match(/^(PS\s+[A-Za-z]:[^>]*>)/);
	if (psMatch) {
		const prompt = psMatch[1];
		return { prompt, body: commandText.slice(prompt.length).replace(/^\s+/, '') };
	}
	const symMatch = commandText.match(/^([$>])\s+/);
	if (symMatch) {
		const prompt = symMatch[1];
		return { prompt, body: commandText.slice(prompt.length).replace(/^\s+/, '') };
	}
	return { prompt: '', body: commandText };
}

/** 终端运行期直播输出订阅生命周期管理（方案1：旁路通道，绕开生成器阻塞）。 */
const _liveTerminalSubs = new Map<string, IDisposable>();
function _disposeLiveTerminalSub(toolCallId: string | undefined): void {
	if (!toolCallId) { return; }
	const d = _liveTerminalSubs.get(toolCallId);
	if (d) { d.dispose(); _liveTerminalSubs.delete(toolCallId); }
}

/** 自 agentChatPanel.toolCards.ts 抽离（上帝对象拆分）。继承链见继承父类。 */
export abstract class AgentChatPanelFileCards extends AgentChatPanelCodebaseCards {
	protected override _createWriteFileToolCard(tc: IToolCall, key: string, confirmation?: IConfirmationData): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		// 沙箱确认内嵌：该工具调用因路径越界被沙箱拦截时，confirmation 带 toolCallId
		// 匹配到本卡片 → 在卡片底部渲染「询问用户」按钮（允许本次/允许此工作区/取消）。
		const isSandboxPending = !!confirmation && confirmation.status === 'pending'
			&& confirmation.toolCallId === tc.id;

			// 提取文件路径（fallback 链：tc.filePath → args.filePath → args.path）
			const filePath = this._extractFilePath(tc);

			// ── 状态驱动外壳 ──
			let statusClass = 'tool-card-success';
			if (isError) { statusClass = 'tool-card-error'; }
			else if (isRunning) { statusClass = 'tool-card-running'; }
			const wrapper = $(`.tool-header-wrapper.${statusClass}.write-file-tool-card`);
			if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

			// ── Body（默认折叠）—— 必须先创建 body，折叠按钮 handler 才能引用 ──
			const body = append(wrapper, $('.tool-header-children'));

			// ── Header（diff 风格）──
			const headerEl = append(wrapper, $('.tool-header.write-file-header'));
			const row = append(headerEl, $('.tool-header-row'));

			// 左侧：chevron + 标题（语言标签 + 文件名 + 修改标记 + diff 行数）
			const left = append(row, $('.tool-header-left'));
			const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable'));
			const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

			// 文件名 + 修改标记
			if (filePath) {
				// 语言标签（基于文件扩展名）
				const lang = this._getLanguageTag(filePath);
				if (lang) {
					const langEl = append(titleContainer, $('span.write-file-lang'));
					langEl.textContent = lang;
				}

				const fileName = filePath.split(/[\\/]/).pop() || filePath;
				const fileNameEl = append(titleContainer, $('span.write-file-name'));
				fileNameEl.textContent = fileName;

				const modEl = append(titleContainer, $('span.write-file-modified'));
				modEl.textContent = isRunning ? '(运行中)' : key === 'patch' ? '(修改)' : '(新建)';
			} else {
				// P0（2026-08-21，日志 1787311601345 + 用户截图）：路径提取失败时原实现
				// 整段跳过 → 标题区一个元素都不渲染，卡片视觉上完全空白（连工具名和状态
				// 都看不到）。任何提取失败都必须有兜底展示，否则缺陷只能靠截图发现。
				const fallbackEl = append(titleContainer, $('span.write-file-name'));
				fallbackEl.textContent = this._getToolTitle(key, tc.displayName, tc.name, isRunning);
				// `.write-file-path-unresolved` 是给 `_needsArgsDrivenRebuild` 的占位标记：
				// filePath 常在 tool_args delta 后到，届时需要补齐重建一次（2026-08-22）。
				const modEl = append(titleContainer, $('span.write-file-modified.write-file-path-unresolved'));
				modEl.textContent = isRunning ? '(运行中)' : '(路径未解析)';
			}

			// diff 行数统计（绿色 +N / 红色 -N）
			const diffStats = this._computeDiffStats(tc);
			if (diffStats.added > 0 || diffStats.removed > 0) {
				const diffEl = append(titleContainer, $('span.write-file-diff-stats'));
				if (diffStats.added > 0) {
					const addEl = append(diffEl, $('span.write-file-diff-add'));
					addEl.textContent = `+${diffStats.added}`;
				}
				if (diffStats.removed > 0) {
					const remEl = append(diffEl, $('span.write-file-diff-rem'));
					remEl.textContent = `-${diffStats.removed}`;
				}
			}

			// 点击标题区域（chevron + 文件名 + diff 统计）展开/折叠，不拦截内部按钮点击
			this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
				if ((e.target as HTMLElement)?.closest?.('button')) { return; }
				e.stopPropagation();
				const isExpanded = body.classList.toggle('tool-header-children-expanded');
				if (isExpanded) {
					this._toolCallExpandState.set(tc.id, true);
					chevron.classList.add('tool-header-chevron-expanded');
				} else {
					this._toolCallExpandState.set(tc.id, false);
					chevron.classList.remove('tool-header-chevron-expanded');
				}
			}));

		// 右侧：状态图标 + 「查看文件」按钮
		const right = append(row, $('.tool-header-right'));
		// 查看文件按钮（始终显示）
		if (this._onOpenFile && filePath && !isRunning) {
			const viewLink = append(right, $('button.tool-view-file-link'));
			viewLink.textContent = '查看文件';
			viewLink.title = `在编辑器中打开 ${filePath}`;
			this._register(addDisposableListener(viewLink, EventType.CLICK, (e) => {
				e.stopPropagation();
				this._onOpenFile?.(filePath);
			}));
		}
		// 「导入知识库」按钮：自动执行(入口落盘到库)+抽取(构建笔记)
		if (this._onImportFileToKnowledgeBase && filePath && !isRunning) {
			const kbImported = !!tc.id && this._importedKbFileToolIds.has(tc.id);
			const kbBtn = append(right, $('button.tool-import-kb-link')) as HTMLButtonElement;
			kbBtn.textContent = kbImported ? '已导入知识库' : '导入知识库';
			kbBtn.title = kbImported ? '已导入知识库' : `将 ${filePath} 导入知识库（入口+抽取）`;
			if (kbImported) { kbBtn.classList.add('tool-import-kb-done'); kbBtn.disabled = true; }
			this._register(addDisposableListener(kbBtn, EventType.CLICK, async (e) => {
				e.stopPropagation();
				if (!tc.id || this._importedKbFileToolIds.has(tc.id) || kbBtn.disabled) { return; }
				kbBtn.disabled = true;
				const original = kbBtn.textContent;
				kbBtn.textContent = '导入中…';
				try {
					const ok = await this._onImportFileToKnowledgeBase?.(filePath, tc.id);
					if (ok) {
						this._importedKbFileToolIds.add(tc.id);
						kbBtn.textContent = '已导入知识库';
						kbBtn.title = '已导入知识库';
						kbBtn.classList.add('tool-import-kb-done');
					} else {
						kbBtn.textContent = original;
						kbBtn.disabled = false;
					}
				} catch {
					kbBtn.textContent = original;
					kbBtn.disabled = false;
				}
			}));
		}

			// 展开/折叠 toggle 按钮（chevron-down SVG，旋转 180° 表示展开态）
			const collapseBtn = append(right, $('button.tool-collapse-btn')) as HTMLButtonElement;
			collapseBtn.title = '展开/折叠';
			this._svgChevronDown(collapseBtn, 'tool-collapse-icon');
			this._register(addDisposableListener(collapseBtn, EventType.CLICK, (e) => {
				e.stopPropagation();
				const isExpanded = body.classList.toggle('tool-header-children-expanded');
				if (isExpanded) {
					this._toolCallExpandState.set(tc.id, true);
					chevron.classList.add('tool-header-chevron-expanded');
					collapseBtn.classList.add('tool-collapse-expanded');
				} else {
					this._toolCallExpandState.set(tc.id, false);
					chevron.classList.remove('tool-header-chevron-expanded');
					collapseBtn.classList.remove('tool-collapse-expanded');
				}
			}));

			const inner = append(body, $('.tool-children-wrapper'));
			const innerBox = append(inner, $('.tool-children-wrapper-inner'));
			innerBox.classList.add('write-file-body');

			// 默认折叠（用户可点击展开查看 diff）
			const expanded = this._toolCallExpandState.get(tc.id) ?? false;
			// 写回记忆表：流式重建/运行结束后续渲染都按此恢复，避免被自动折叠
			if (tc.id && !this._toolCallExpandState.has(tc.id)) {
				this._toolCallExpandState.set(tc.id, expanded);
			}
			if (expanded) {
				body.classList.add('tool-header-children-expanded');
				chevron.classList.add('tool-header-chevron-expanded');
				collapseBtn.classList.add('tool-collapse-expanded');
			}

			// ── Body 内容：直接 diff 代码块（无 section 包装）──
			if (isRunning && !tc.result) {
				// 流式写入：把 tc.args 中已到达的 content/new_str/diff 增量刷入滚动预览区，
				// 避免 tool_end 时一次性渲染大文件 diff 卡住主线程（参考 CodeBuddy IDE 写文件流式卡片）。
				const streamPre = append(innerBox, $('pre.write-file-stream'));
				const textNode = wrapper.ownerDocument.createTextNode('');
				streamPre.appendChild(textNode);
				this._initWriteFileStreamState(wrapper, streamPre, textNode);
				if (!tc.args) {
					// tool_start 到达但参数还未开始生成 → 显示等待占位（含耗时计数，避免空白）
					streamPre.textContent = '正在生成文件内容…';
					streamPre.classList.add('write-file-stream-waiting');
				}
				this._updateWriteFileStream(wrapper, tc);
				// 运行期间默认展开，让用户实时看到写入内容（用户可手动折叠）
				if (!body.classList.contains('tool-header-children-expanded')) {
					body.classList.add('tool-header-children-expanded');
					chevron.classList.add('tool-header-chevron-expanded');
					collapseBtn.classList.add('tool-collapse-expanded');
				}
			} else if (tc.result) {
				const diffBlock = append(innerBox, $('.write-file-diff-block'));
				if (diffStats.lines && diffStats.lines.length > 0) {
					// 大文件封顶：只渲染前 MAX_DIFF_LINES 行，避免一次性构建上万 DOM 节点卡住主线程。
					// 完整内容通过右上角「查看文件」在编辑器中打开。
					const MAX_DIFF_LINES = 500;
					const total = diffStats.lines.length;
					const shown = Math.min(total, MAX_DIFF_LINES);
					for (let i = 0; i < shown; i++) {
						const line = diffStats.lines[i];
						const lineEl = append(diffBlock, $(`div.write-file-diff-line.write-file-diff-${line.type}`));
						append(lineEl, $('span.write-file-diff-marker')).textContent = line.type === 'add' ? '+' : line.type === 'rem' ? '-' : ' ';
						append(lineEl, $('span.write-file-diff-content')).textContent = line.text;
					}
					if (total > shown) {
						const more = append(diffBlock, $('.write-file-diff-more'));
						more.textContent = `… 其余 ${total - shown} 行已省略，点击「查看文件」查看完整内容`;
					}
				} else {
					// 退化为纯文本预览
					const pre = append(diffBlock, $('.write-file-diff-content'));
					pre.textContent = this._normalizeToolResultText(tc.result);
				}
			}

			// ── 错误详情（无 result 时）──
			if (isError && tc.error && !tc.result) {
				const bottom = append(wrapper, $('.tool-bottom-children'));
				const bh = append(bottom, $('.tool-bottom-children-header'));
				const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
				append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
				const bbody = append(bottom, $('.tool-bottom-children-body'));
				append(bbody, $('.tool-bottom-children-content')).textContent = this._normalizeToolResultText(tc.error);
				this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
					e.stopPropagation();
					const open = bbody.classList.toggle('tool-bottom-children-body-open');
					bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
				}));
			}

			// 取消通知
			if (tc.status === 'canceled') {
				this._appendCanceledNotice(wrapper);
			}

			// ── 沙箱确认内嵌询问按钮（2026-08-09 用户需求）──
			// 写文件/补丁目标路径越沙箱时，工具卡片内直接提供「允许本次 / 允许此工作区 /
			// 取消」按钮（无需用户另找独立的确认卡片）。点击后经 _onConfirmationAction
			// 派发 agentStudio.confirmationAction 命令，resolve agentTurnExecutor 挂起的
			// _awaitSandboxConfirmation，随后重执行或保留失败。
			if (isSandboxPending && confirmation && this._onConfirmationAction) {
				const bottom = append(wrapper, $('.tool-bottom-children'));
				const bh = append(bottom, $('.tool-bottom-children-header'));
				const sbChevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
				append(bh, $('span.tool-bottom-children-title')).textContent = '沙箱确认';
				const bbody = append(bottom, $('.tool-bottom-children-body'));
				bbody.classList.add('tool-bottom-children-body-open');
				sbChevron.classList.add('tool-bottom-children-chevron-open');
				// 说明文本
				append(bbody, $('p.confirmation-card-message')).textContent = confirmation.message;
				if (confirmation.detail) {
					append(bbody, $('pre.confirmation-card-detail')).textContent = confirmation.detail;
				}
				// 按钮行（复用确认卡片按钮样式）
				const actions = append(bbody, $('.confirmation-card-actions'));
				for (const btn of confirmation.buttons) {
					const el = append(actions, $(
						`button.confirmation-card-btn${btn.primary ? '.primary' : ''}${btn.danger ? '.danger' : ''}`,
						undefined,
						btn.label,
					));
					this._register(addDisposableListener(el, EventType.CLICK, (e) => {
						e.stopPropagation();
						this._onConfirmationAction?.(confirmation.id, btn.id);
						// 本地立即标记为已处理（防重复点击）
						(el as HTMLButtonElement).disabled = true;
						el.textContent = btn.label + ' ✓';
					}));
				}
			}

			return wrapper;
		}

	// ── 写文件流式渲染（参考 CodeBuddy IDE：写大文件时内容边生成边流入卡片，O(delta) 增量、不卡主线程）──
	/** 分帧追加的每帧字符数（rAF 频率约 16ms/帧，200 字符/帧 = 约 12000 字符/秒的流式速率） */
	private static readonly WRITE_FILE_CHUNK_SIZE = 200;

	private readonly _writeStreamStates = new WeakMap<HTMLElement, {
		pre: HTMLElement;
		textNode: Text;
		contentStart: number; // JSON 字符串值起点（开引号之后偏移），-1 表示尚未定位
		rawConsumed: number;  // 已消费的原始字符数（从 contentStart 起）
		done: boolean;
		/** 一次性收到大段完整 content 时，用分帧追加模拟流式效果（非增量场景兜底） */
		pendingText: string;    // 待分帧追加的文本
		chunkOffset: number;    // pendingText 中下一个待追加字符偏移
		/** 卡片进入等待态的时刻（Date.now()），用于显示已等待时长 */
		startedAt: number;
		/** 已到达的总字符数（用于 tool_progress 空心跳期间展示 args 长度感知） */
		totalChars: number;
	}>();

	/** 初始化某写文件卡片的流式状态。 */
	private _initWriteFileStreamState(wrapper: HTMLElement, pre: HTMLElement, textNode: Text): void {
		this._writeStreamStates.set(wrapper, { pre, textNode, contentStart: -1, rawConsumed: 0, done: false, pendingText: '', chunkOffset: 0, startedAt: Date.now(), totalChars: 0 });
	}

	/**
	 * 更新等待占位文本，显示已等待时长（供每帧轮询调用）。
	 * 仅有“等待态”卡片（contentStart < 0）需要刷新，已开始接收内容的卡片从此不再更新。
	 */
	private _updateWriteFileWaitingText(wrapper: HTMLElement): void {
		const st = this._writeStreamStates.get(wrapper);
		if (!st || st.contentStart >= 0 || st.done) { return; }
		const pre = st.pre;
		if (!pre.classList.contains('write-file-stream-waiting')) { return; }
		const elapsed = Math.floor((Date.now() - st.startedAt) / 1000);
		const elapsedStr = elapsed >= 60
			? `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`
			: `${elapsed} 秒`;
		const argsLen = st.totalChars;
		const charsStr = argsLen > 0 ? `，已生成参数 ${argsLen.toLocaleString()} 字符` : '';
		pre.textContent = `正在生成文件内容… (已等待 ${elapsedStr}${charsStr})`;
	}

	/**
	 * 增量把 tc.args 中已到达的 content/new_str/diff 值刷入卡片滚动区。
	 * 仅解码「上次消费位置 → 当前 args 末尾」的新增片段，整体 O(delta)。
	 *
	 * 兜底：CodeBuddy Provider 等实现会在 tool_start 时一次性返回完整 arguments
	 * 而非逐 tool_args delta 流式发送。此时解码后的文本可能一次就高达 15K+ 字符，
	 * 直接 appendData 会导致单帧大量 DOM 操作卡顿，且视觉上瞬间出现无流式效果。
	 * 对此类场景，改用 rAF 分帧分批追加（每帧 WRITE_FILE_CHUNK_SIZE 字符），
	 * 模拟流式写入体验。
	 */
	protected _updateWriteFileStream(wrapper: HTMLElement, tc: IToolCall): void {
		const st = this._writeStreamStates.get(wrapper);
		if (!st || st.done) { return; }
		const args = tc.args || '';
		if (!args) { return; }
		if (st.contentStart < 0) {
			// 内容字段尚未出现：追踪 args 长度变化，用于等待态进度展示
			st.totalChars = Math.max(st.totalChars, args.length);
			const start = this._locateWriteStreamFieldStart(args);
			if (start < 0) { return; }
			st.contentStart = start;
			st.rawConsumed = 0;
			// 首次定位到 content 字段 → 清除等待占位符，恢复 Text 节点用于流式追加
			if (st.pre.classList.contains('write-file-stream-waiting')) {
				st.pre.textContent = '';
				st.pre.classList.remove('write-file-stream-waiting');
				st.pre.appendChild(st.textNode);
			}
		}
		const from = st.contentStart + st.rawConsumed;
		if (from >= args.length) { return; }
		const scan = this._scanJsonStringEnd(args, from);
		const rawSlice = args.slice(from, scan.end);
		if (rawSlice) {
			const dec = this._decodeJsonChunk(rawSlice);
			if (dec.text) {
				if (dec.text.length > AgentChatPanelFileCards.WRITE_FILE_CHUNK_SIZE && st.chunkOffset === 0) {
					// 一次性收到的大段内容 → 分帧追加，模拟流式写入
					st.pendingText = dec.text;
					st.chunkOffset = 0;
					this._scheduleWriteFileChunk(st, wrapper);
				} else {
					// 小段增量或正在分帧中 → 直接追加或等待上一批分帧完成
					st.textNode.appendData(dec.text);
					const MAX = 400000;
					if (st.textNode.length > MAX) {
						st.textNode.deleteData(0, st.textNode.length - 300000);
					}
					st.pre.scrollTop = st.pre.scrollHeight;
				}
			}
			st.rawConsumed += dec.consumed;
		}
		if (scan.complete && st.contentStart + st.rawConsumed >= scan.end) {
			st.done = true;
		}
	}

	/** 用 rAF 分批将 pendingText 追加到 Text 节点，每帧 WRITE_FILE_CHUNK_SIZE 字符。 */
	private _scheduleWriteFileChunk(
		st: NonNullable<ReturnType<typeof this._writeStreamStates.get>>,
		wrapper: HTMLElement,
	): void {
		if (!st.pendingText || st.chunkOffset >= st.pendingText.length) {
			st.pendingText = '';
			st.chunkOffset = 0;
			return;
		}
		const end = Math.min(st.chunkOffset + AgentChatPanelFileCards.WRITE_FILE_CHUNK_SIZE, st.pendingText.length);
		const chunk = st.pendingText.slice(st.chunkOffset, end);
		st.chunkOffset = end;
		st.textNode.appendData(chunk);
		const MAX = 400000;
		if (st.textNode.length > MAX) {
			st.textNode.deleteData(0, st.textNode.length - 300000);
		}
		st.pre.scrollTop = st.pre.scrollHeight;

		if (st.chunkOffset < st.pendingText.length) {
			const win = (wrapper.ownerDocument || (typeof document !== 'undefined' ? document : undefined))?.defaultView;
			if (win) {
				win.requestAnimationFrame(() => this._scheduleWriteFileChunk(st, wrapper));
			} else {
				// 降级：一次性追加剩余全部
				st.textNode.appendData(st.pendingText.slice(st.chunkOffset));
				st.chunkOffset = st.pendingText.length;
				st.pre.scrollTop = st.pre.scrollHeight;
			}
		}
	}

	/** 批量刷新一条消息内所有「运行中」写文件卡片的流式内容（供 _updateMessageDom 每帧调用，幂等）。 */
	protected _updateActiveWriteFileStreams(el: HTMLElement, msg: IAgentChatMessage): void {
		const cards = el.querySelectorAll('.write-file-tool-card.tool-card-running[data-tool-id]');
		if (cards.length === 0) { return; }
		const list = msg.toolCalls;
		if (!list || list.length === 0) { return; }
		const byId = new Map<string, IToolCall>();
		for (const t of list) { if (t?.id) { byId.set(t.id, t); } }
		cards.forEach((node) => {
			const cardEl = node as HTMLElement;
			const id = cardEl.getAttribute('data-tool-id');
			if (!id) { return; }
			const tc = byId.get(id);
			if (!tc || tc.status !== 'running') { return; }
			this._updateWriteFileStream(cardEl, tc);
			// 等待态卡片：更新已等待时长显示
			this._updateWriteFileWaitingText(cardEl);
		});
	}

	/** 在（可能不完整的）JSON args 中定位首个可流式字段值的起点（开引号之后）。 */
	private _locateWriteStreamFieldStart(args: string): number {
		for (const key of ['content', 'new_str', 'newStr', 'diff', 'code']) {
			const re = new RegExp('"' + key + '"\\s*:\\s*"');
			const m = re.exec(args);
			if (m) { return m.index + m[0].length; }
		}
		return -1;
	}

	/**
	 * 从干净边界 from 扫描 JSON 字符串值的收尾未转义引号。
	 * 返回 end（绝对下标）与 complete（是否已遇到收尾引号）。尾部悬空反斜杠本轮不消费。
	 */
	private _scanJsonStringEnd(args: string, from: number): { end: number; complete: boolean } {
		const n = args.length;
		let i = from;
		while (i < n) {
			const c = args.charCodeAt(i);
			if (c === 92 /* \\ */) {
				if (i + 1 >= n) { return { end: i, complete: false }; }
				i += 2;
				continue;
			}
			if (c === 34 /* " */) { return { end: i, complete: true }; }
			i++;
		}
		return { end: n, complete: false };
	}

	/** 解码一段 JSON 字符串原始片段（不含未转义引号）。返回解码文本与实际消费的原始长度（尾部不完整转义会延迟到下轮）。 */
	private _decodeJsonChunk(raw: string): { text: string; consumed: number } {
		let out = '';
		let i = 0;
		const n = raw.length;
		while (i < n) {
			const ch = raw[i];
			if (ch === '\\') {
				if (i + 1 >= n) { break; }
				const e = raw[i + 1];
				switch (e) {
					case 'n': out += '\n'; i += 2; break;
					case 't': out += '\t'; i += 2; break;
					case 'r': out += '\r'; i += 2; break;
					case 'b': out += '\b'; i += 2; break;
					case 'f': out += '\f'; i += 2; break;
					case '"': out += '"'; i += 2; break;
					case '\\': out += '\\'; i += 2; break;
					case '/': out += '/'; i += 2; break;
					case 'u': {
						if (i + 6 > n) { return { text: out, consumed: i }; }
						const code = parseInt(raw.slice(i + 2, i + 6), 16);
						out += Number.isNaN(code) ? raw.slice(i, i + 6) : String.fromCharCode(code);
						i += 6;
						break;
					}
					default: out += e; i += 2; break;
				}
			} else {
				out += ch;
				i++;
			}
		}
		return { text: out, consumed: i };
	}

	protected override _createTerminalToolCard(tc: IToolCall, key: string): HTMLElement {
		const isRunning = tc.status === 'running';
		const isError = tc.status === 'error';
		const isApproval = tc.status === 'approval_required';
		const isRejected = tc.status === 'rejected';
		const isCanceled = tc.status === 'canceled';

			// 提取命令字符串（宽松修复链：命令里含 `\x` 等非法转义时原裸 parse
			// 会失败 → 终端卡片只显示状态前缀、命令行空白）
			// args 提到 if 外：命令未到时还要读 description 做占位展示（2026-08-22）
			//
			// 2026-08-29（日志 1787932864271）：兼容执行层字段名 `arguments`。
			// 渲染层 IToolCall 只声明 `args`（agentChatTypes.ts:230），而执行侧
			// （agentTurnExecutor 的 tc.arguments、agentChatService finalization 的
			// `tc.arguments = chunks.join('')`）写的是 `arguments` —— **两条独立链路**，
			// 工具执行成功 ≠ 卡片能渲染。当 tool_args delta 未到达或未匹配到卡片时
			// `tc.args` 恒为 ''，而持久化/同步过来的对象上可能已带 `arguments`。
			// 此处兼容读取，让「args 空但 arguments 有值」时仍能渲染出命令行，
			// 而不是退化成无参数的占位空卡。
			const rawArgs = tc.args || (tc as any).arguments;
			const args = rawArgs ? parseToolArgsLoose(rawArgs) : {};
			const commandText = typeof args['command'] === 'string' ? args['command']
				: typeof args['cmd'] === 'string' ? args['cmd']
				: typeof args['code'] === 'string' ? args['code'] : '';

			// 拆分 shell 提示符前缀（PS <path>> / $ / >）做高亮；复制仍用完整 commandText。
			const split = splitTerminalPrompt(commandText);
			const promptText = split.prompt;
			const cmdBody = split.body;

			// ── 状态驱动外壳 ──
			let statusClass = 'tool-card-success';
			if (isError) { statusClass = 'tool-card-error'; }
			else if (isRunning) { statusClass = 'tool-card-running'; }
			// 等待用户授权：黄色审批外壳（卡内审批区由 dispatcher 统一挂载）
			else if (isApproval) { statusClass = 'tool-card-approval'; }
			else if (isRejected || isCanceled) { statusClass = 'tool-card-rejected'; }
			const wrapper = $(`.tool-header-wrapper.${statusClass}.terminal-tool-card`);
			if (tc.id) { wrapper.setAttribute('data-tool-id', tc.id); }

			// ── Header：单行（终端图标 + 命令 + 右侧按钮 + 展开 chevron）──
			// 2026-08-21 重构：去掉「状态行 + pill」双行布局，改为单行命令展示，
			// 状态通过命令行前缀（⟳/✕/✓/⊘）隐式表达，与截图样式对齐。
			const headerEl = append(wrapper, $('.tool-header.terminal-header'));
			const row = append(headerEl, $('.tool-header-row.terminal-header-row'));

			const left = append(row, $('.tool-header-left.terminal-left'));
			const titleContainer = append(left, $('.tool-header-title-container.tool-header-title-clickable.terminal-title-container'));
			const chevron = this._svgChevron(titleContainer, 'tool-header-chevron', 14);

			// 终端 logo（单行左侧图标）
			this._svgTerminalLogo(titleContainer, 'terminal-logo');

			// 命令行：状态前缀 + 提示符 + 命令体（单行省略）
			const cmdLine = append(titleContainer, $('.terminal-cmd-line'));
			const statusPrefix = isRunning ? '⟳ '
				: isError ? '✕ '
				: isApproval ? '⚠ '
				: isRejected || isCanceled ? '⊘ '
				: '✓ ';
			append(cmdLine, $('span.terminal-cmd-status')).textContent = statusPrefix;
			if (commandText) {
				if (promptText) { append(cmdLine, $('span.terminal-cmd-prompt')).textContent = promptText; }
				append(cmdLine, $('span.terminal-cmd-body')).textContent = cmdBody;
			} else {
				// 命令文本尚未到达（tool_start 与 tool_args 是两个独立 delta）。
				// 2026-08-22：优先展示模型提供的 5-10 词 description —— 否则这里在整个
				// 命令执行期间都只有「执行中…」（实测一次 execute_code 跑了 30.5s）。
				// 仍保留 `.terminal-cmd-empty` 标记：args 到达后要靠它触发补齐重建
				// （见 toolCardArgsRefresh）。
				const intent = typeof args['description'] === 'string' ? args['description'].trim() : '';
				const el = append(cmdLine, $('span.terminal-cmd-body.terminal-cmd-empty'));
				el.textContent = intent
					? (isRunning ? `${intent}…` : intent)
					: (isRunning ? '执行中…' : '（无命令）');
			}

			// 点击标题区域（chevron + 两行文本）展开/折叠，但不拦截内部按钮点击
			this._register(addDisposableListener(titleContainer, EventType.CLICK, (e) => {
				if ((e.target as HTMLElement)?.closest?.('button')) { return; }
				e.stopPropagation();
				const isExpanded = body.classList.toggle('tool-header-children-expanded');
				if (isExpanded) {
					this._toolCallExpandState.set(tc.id, true);
					chevron.classList.add('tool-header-chevron-expanded');
				} else {
					this._toolCallExpandState.set(tc.id, false);
					chevron.classList.remove('tool-header-chevron-expanded');
				}
			}));

			// 右侧：继续执行（running）+ 复制 + 时长
			const right = append(row, $('.tool-header-right.terminal-right'));
			// 「继续执行」按钮：仅 running 态显示——中止当前长命令、不取消整个 turn。
			// 折叠态也常驻可见（避免用户折叠后找不到「跳过」入口）。
			if (isRunning && this._onSkipCurrentTool) {
				const skipBtn = append(right, $('button.terminal-continue-btn.terminal-continue-header')) as HTMLButtonElement;
				skipBtn.textContent = '继续执行';
				skipBtn.title = '不等待命令完成，跳过当前命令并继续后续步骤';
				this._register(addDisposableListener(skipBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					skipBtn.disabled = true;
					skipBtn.textContent = '已跳过';
					this._onSkipCurrentTool?.();
				}));
			}
			if (typeof tc.duration === 'number' && tc.duration >= 0 && !isRunning) {
				append(right, $('span.terminal-duration')).textContent = this._formatDuration(tc.duration);
			}
			// 复制按钮
			if (commandText) {
				const copyBtn = append(right, $('button.terminal-copy-btn'));
				copyBtn.title = '复制命令';
				const copySvg = this._svgCopyIcon();
				copyBtn.appendChild(copySvg);
				this._register(addDisposableListener(copyBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					void this._copyToClipboard(commandText);
					copyBtn.classList.add('terminal-copy-done');
					setTimeout(() => copyBtn.classList.remove('terminal-copy-done'), 1200);
				}));
			}
			// 独立终端按钮（「在终端中显示」：绿色框图标，非 running 态可点）
			if (this._onRunInTerminal && commandText && !isRunning) {
				const termBtn = append(right, $('button.terminal-open-btn'));
				termBtn.title = '在终端中显示';
				this._svgTerminalOpenIcon(termBtn, 'terminal-open-icon');
				this._register(addDisposableListener(termBtn, EventType.CLICK, (e) => {
					e.stopPropagation();
					this._onRunInTerminal?.(commandText);
				}));
			}
			// ── Body（默认折叠）—— 提前创建以便 header 点击事件引用 ──
			const body = append(wrapper, $('.tool-header-children'));
			const inner = append(body, $('.tool-children-wrapper'));
			const innerBox = append(inner, $('.tool-children-wrapper-inner'));
			innerBox.classList.add('terminal-body');

			const expanded = this._toolCallExpandState.get(tc.id) ?? false;
			// 写回记忆表：流式重建/运行结束后续渲染都按此恢复，避免被自动折叠
			if (tc.id && !this._toolCallExpandState.has(tc.id)) {
				this._toolCallExpandState.set(tc.id, expanded);
			}
			if (expanded) {
				body.classList.add('tool-header-children-expanded');
				chevron.classList.add('tool-header-chevron-expanded');
			}

			// ── Body 内容 ──
			// 先清理上一次同 tc.id 的直播订阅（防重建泄漏），running 分支会重新登记
			_disposeLiveTerminalSub(tc.id);
			if (isRunning && !tc.result) {
				// 运行中：等宽命令块 + 实时输出（方案1：旁路通道直播 PTY 清洗后的增量输出）
				if (commandText) {
					const cmdBlock = append(innerBox, $('.terminal-cmd-block'));
					cmdBlock.textContent = commandText;
				}
				// 运行中徽标（置于输出区上方）
				const badge = append(innerBox, $('.terminal-running-badge'));
				badge.textContent = '运行中 · 实时输出';
				// 实时输出区：先渲染已累计缓存（卡片可能因 tool_args 到达而重建），
				// 再订阅增量 chunk 就地追加并自动滚底。
				const liveOut = getTerminalLiveOutput(tc.id);
				const livePre = append(innerBox, $('pre.terminal-live-output')) as HTMLPreElement;
				livePre.textContent = liveOut;
				const sub = onTerminalLiveOutput((e) => {
					if (e.toolCallId !== tc.id) { return; }
					livePre.textContent = (livePre.textContent ?? '') + e.chunk;
					livePre.scrollTop = livePre.scrollHeight;
				});
				_liveTerminalSubs.set(tc.id, sub);
				// 尚无任何输出时仅保留加载动画（不显示占位文本，避免误导）
				if (!liveOut) {
					const explain = append(innerBox, $('.terminal-explain-row.running'));
					append(explain, $('span.codicon.codicon-loading', { style: 'animation:spin 1s linear infinite' }));
				}
			} else if (tc.result) {
				// 运行结束：清理直播订阅与缓存
				_disposeLiveTerminalSub(tc.id);
				clearTerminalLiveOutput(tc.id);
				// 完整命令块（展开后可见，反引号换行不丢）
				if (commandText) {
					const cmdBlock = append(innerBox, $('.terminal-cmd-block'));
					cmdBlock.textContent = commandText;
				}
				// ★ 2026-08-21 重构：每行加 `> ` 前缀（等宽字体 + 缩进），对齐截图样式。
				// tc.result 是 agentOS 层包出来的 [{type:"text",text:"..."}] 协议外壳，
				// 先剥掉再渲染。stderr 行用 `! ` 前缀 + warning 色。
				const output = append(innerBox, $('.terminal-output-block'));
				if (isError) { output.classList.add('terminal-output-error'); }
				const resultText = this._normalizeToolResultText(tc.result);
				const stderrText = tc.error ? this._normalizeToolResultText(tc.error) : '';
				const stdoutLines = resultText.split('\n');
				const stderrLines = stderrText ? stderrText.split('\n') : [];
				// 空结果时仍渲染一个空行占位
				if (stdoutLines.length === 1 && stdoutLines[0] === '' && stderrLines.length === 0) {
					stdoutLines.push('（无输出）');
				}
				const renderLines = (lines: string[], prefix: string, klass: string) => {
					for (const line of lines) {
						const row = append(output, $('div.terminal-output-line.' + klass));
						append(row, $('span.terminal-output-prefix')).textContent = prefix;
						append(row, $('span.terminal-output-text')).textContent = line.length > 0 ? line : '\u00A0';
					}
				};
				renderLines(stdoutLines, '> ', 'stdout');
				if (stderrLines.length) { renderLines(stderrLines, '! ', 'stderr'); }
				// exit bar：exit code + 输出统计
				const exitBar = append(innerBox, $('.terminal-exit-bar'));
				if (typeof tc.exitCode === 'number') {
					const ec = append(exitBar, $('span.terminal-exit-tag'));
					ec.textContent = `exit code ${tc.exitCode}`;
					ec.classList.add(tc.exitCode === 0 ? 'zero' : 'nonzero');
				}
				const lineCount = stdoutLines.length + stderrLines.length;
				append(exitBar, $('span.terminal-exit-meta')).textContent = `${lineCount} 行输出`;
			}

			// 错误详情（无 result 时的折叠错误面板，保留旧逻辑）
			if (isError && tc.error && !tc.result) {
				const bottom = append(wrapper, $('.tool-bottom-children'));
				const bh = append(bottom, $('.tool-bottom-children-header'));
				const bchevron = this._svgChevron(bh, 'tool-bottom-children-chevron', 12);
				append(bh, $('span.tool-bottom-children-title')).textContent = '错误详情';
				const bbody = append(bottom, $('.tool-bottom-children-body'));
				append(bbody, $('.tool-bottom-children-content')).textContent = this._normalizeToolResultText(tc.error);
				this._register(addDisposableListener(bh, EventType.CLICK, (e) => {
					e.stopPropagation();
					const open = bbody.classList.toggle('tool-bottom-children-body-open');
					bchevron.classList.toggle('tool-bottom-children-chevron-open', open);
				}));
			}

			// ── 取消通知（canceled 状态）──
			if (tc.status === 'canceled') {
				this._appendCanceledNotice(wrapper);
			}

			return wrapper;
		}

	/**
	 * 读取文件卡片：仅折叠态一行，点击打开编辑器跳转到指定行。
	 * 不渲染展开 body，不放代码预览。
	 */
	protected override _createReadFileCard(tc: IToolCall, key: string): HTMLElement {
		const isError = tc.status === 'error';
		const wrapper = $(`.chat-read-card${isError ? '.chat-read-card-error' : ''}`);

		// 图标
		const icon = append(wrapper, $('.chat-read-card-icon'));
		icon.appendChild(createSvgIcon(isError ? ERROR_ICON_D : FILE_ICON_D));

		// 正文：文件名 + 行号范围 + 元信息
		const body = append(wrapper, $('.chat-read-card-body'));
		const verb = append(body, $('span'));
		verb.textContent = isError ? '读取' : '读取';
		verb.style.cssText = 'color:var(--void-fg-3);font-size:12px;flex-shrink:0;';

		// 提取文件路径和行号（宽松修复链，避免 (未知文件) 误显示）
		const p = parseToolArgsLoose(tc.args);
		const fp = (tc.filePath || p.file_path || p.filePath || p.path || p.uri) as string | undefined;
		const startLine = (p.start_line ?? p.startLine ?? p.offset) as number | undefined;
		const endLine = (p.end_line ?? p.endLine) as number | undefined;

		const basename = (s: string) => {
			const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
			return parts[parts.length - 1] || s;
		};

		const fileName = append(body, $('.chat-read-card-file'));
		fileName.textContent = fp ? basename(fp) : '(未知文件)';

		if (startLine !== undefined && startLine !== null) {
			const range = append(body, $('.chat-read-card-range'));
			range.textContent = endLine ? `L${startLine}-${endLine}` : `L${startLine}`;
		}

		// 元信息
		if (tc.result) {
			const meta = append(body, $('.chat-read-card-meta'));
			meta.textContent = `${tc.result.length} chars`;
		} else if (typeof tc.duration === 'number') {
			const meta = append(body, $('.chat-read-card-meta'));
			meta.textContent = this._formatDuration(tc.duration);
		}

		// hover 提示 "↗ 打开"
		if (!isError && fp) {
			const hint = append(wrapper, $('.chat-read-card-hint'));
			hint.textContent = '↗ 打开';
		}

		// 点击 → 打开编辑器
		if (fp && !isError) {
			wrapper.addEventListener('click', (e) => {
				e.stopPropagation();
				// 传递行号：数字型 → onOpenFile 中按 _openFileInEditor(filePath, line) 跳转
				if (startLine !== undefined && startLine !== null) {
					this._onOpenFile?.(fp, startLine);
				} else {
					this._onOpenFile?.(fp);
				}
			});
		}

		return wrapper;
	}

	protected override _createCodebaseResultCard(key: string, resultText: string): HTMLElement | null {
			try {
				const data = JSON.parse(resultText);
				if (!data) { return null; }

				const card = $('.codebase-result-card');

				// ── search_graph: BM25 搜索结果列表 ──
				if (key === 'search_graph' && data.nodes && Array.isArray(data.nodes)) {
					return this._renderSearchGraphCard(card, data);
				}
				// ── search_code: 代码搜索 + 上下文 ──
				if (key === 'grep' && data.results && Array.isArray(data.results)) {
					return this._renderSearchCodeCard(card, data);
				}
				// ── get_architecture: 架构总览 ──
				if (key === 'get_architecture' && (data.totalNodes || data.languages)) {
					return this._renderArchitectureCard(card, data);
				}
				// ── trace_path: 调用链追踪 ──
				if (key === 'trace_path' && (data.hops || data.path)) {
					return this._renderTracePathCard(card, data);
				}
				// ── index_repository: 索引进度/完成 ──
				if (key === 'index_repository') {
					return this._renderIndexRepoCard(card, data);
				}
				// ── 其他 codebase 工具：紧凑统计卡 ──
				return this._renderCodebaseSummaryCard(card, key, data);
			} catch {
				return null;
			}
		}
}
