/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ChatMessage } from '../common/types.js';
import type { IChatStreamDelta } from '../common/providers.js';   // ⚠ 必须与 driver 同源 ✓（见下注 ✓）
import type { ICompactionBoundaryInfo } from '../common/historyCompaction.js';

/** 单次 assignment 轮（Hermes 回合边界）的快照（见 `turns` 字段注释 ✓）。 */
interface ITurnSnapshot {
	content: string;
	toolCallIds: string[];
}

/**
 * 一轮流式的**累加器状态**（2026-09-22 阶段④-g B2 ✓ 从 `sendMessage` 外移 ✓）。
 *
 * ## 为什么是"类 + 公有字段"，而不是"对象字面量"
 * 字段名与原先**逐字一致** ✓ ⇒ 宿主侧 400+ 处 `acc.X` **零改动** ✓✓。
 * 这是本轮刻意选的**最小风险形态** ✓：先把"状态的家"搬出 757 行的方法 ✗，
 * 下一步 B3 再把 **delta 分发**（~224 行 ✓）搬进来变成 `applyDelta` ✓。
 *
 * ## 两条不可退化约定（随字段一起搬走 ✓）
 *  ① **文本用 chunk 数组累加、最后 join 一次** ✗✓（不是 `fullContent += ` ✓）：
 *     后者会在 V8 里堆出**每个 delta 一个节点**的 ConsString rope ✓，并被缓存长期持有 ⇒
 *     每次 send 后堆无界增长 ✗（P0-leak-fix ✓）。
 *  ② **usage 的两个 input 语义必须分开** ✗✓：`usageInput` = 本 turn **全程累加消费**
 *     （footer 展示 ✓）；`usagePromptTokens` = **最近一次** delta 的 input（= 当前 prompt 大小 ✓）。
 *     两者曾共用同一值 ⇒ 长 turn 后上下文环暴涨（实测 1,465,040 vs 真实 80,724 ✗）
 *     ⇒ 显示 100% 却**永不触发压缩** ✗（详见 DETAIL §44 ✓）。
 *
 * ⚠ 还有一件不能忘的事 ✓：`discard_prior_text` 必须同时丢弃 `_streamingParts` 里
 *   末尾连续的 text 段 ✓（`parts` 是重载渲染的真相源 ✓ —— 2026-09-22 由行为基线抓到的缺陷 ✓）。
 */
export class StreamAccumulator {
	fullContent = "";
	fullThinking = "";
	// P0-leak-fix: streamed text is accumulated in chunk arrays and joined ONCE
	// at finalization. The previous `fullContent += delta.content` built a V8
	// ConsString rope (one node per delta) that was retained in the cache,
	// causing unbounded heap growth after every send.
	_fullContentChunks = [] as string[];
	_fullThinkingChunks = [] as string[];
	_toolArgChunks = new Map<string, string[]>();
	toolCalls = undefined as ChatMessage["toolCalls"];
	// P0: chronological parts 跟踪——按 LLM 实际输出顺序记录 text→tool→text→tool，
	// 最终落盘时直接使用，避免 deriveMessageParts 依赖跨迭代失效的 textPosition。
	_streamingParts = [] as any[];
	// 阶段E：textPosition 仅作**落盘时切分 parts 的本地排序信号**，不再跨层依赖。
	// driver/agentOS 不下发 textPosition，由本侧在 tool_start 时按"当前 turn 内已累积
	// 文本长度"计算（assistant_turn 结算后归零）。最终 deriveMessageParts 用它把
	// turn.content 与 toolCalls 一次性切分成有序 parts 落盘，重载即按数组顺序渲染，
	// 不再有任何一层依赖 textPosition 的字符偏移（消除历史错位根因）。
	currentTurnTextLen = 0;
	// ─── Hermes-style 回合边界收集（2026-06-05 治本根因修复）────────────
	// agentOS 每个 iteration yield 一个 `assistant_turn` 边界事件。我们据此把
	// 这一回合（同一次用户请求）拆成多条 assistant 消息，每条只含**本 iteration**
	// 的 content + 本 iteration 发起的 toolCalls，紧跟其 tool 结果落在下一条之前。
	// 这样持久化的历史与 agentOS loop 内部结构一致，杜绝"先宣告成功、后调用工具"
	// 的因果倒置范例。为空（无边界事件，旧后端/直连模式 ✓）时回退单条逻辑。
	turns = [] as ITurnSnapshot[];
	// ─── P5: 压缩边界捕获（压缩状态跨 turn 持久化）───────────────────
	// executor 在 loop 内压缩后 yield context_compacted（含 compressionSummary）。
	// 记录边界信息（同一回合多次压缩取最后一次），完成落盘时把边界消息插入
	// 到压缩点位置；下一 turn 回灌从边界处重放（边界前历史由摘要承载）。
	pendingCompaction = undefined as ICompactionBoundaryInfo | undefined;
	// Accumulators for new card data (VS Code Copilot Chat pattern)
	references = undefined as ChatMessage["references"];
	progress = undefined as ChatMessage["progress"];
	confirmation = undefined as ChatMessage["confirmation"];
	todos = undefined as ChatMessage["todos"];
	tips = undefined as ChatMessage["tips"];
	questions = undefined as ChatMessage["questions"];
	// KV Cache: accumulated token usage across the turn.
	usageInput = 0;
	usageOutput = 0;
	usageCached = 0;
	usageCacheWrite = 0;
	usageCredit = 0;
	usageCreditSeen = false; // 2026-07-27：区分"网关返回 credit=0"与"网关根本未提供该字段"
	usageTotalReported = 0; // total_tokens as reported by the gateway (preferred over input+output)
	usageSeen = false;
	/**
	 * ★ 2026-09-21：**最近一次** usage delta 的 input（= 当前 prompt 大小，**非累加**）。
	 *
	 * 本 turn 全程累加消费（footer 展示用；多轮 agent loop 逐轮累加）；
	 * 上下文环需要的是「当前 prompt 多大」——两者此前共用同一个值 ⇒ 长 turn 后环暴涨
	 * （实测 1,465,040 vs 真实 prompt 80,724）⇒ 显示 100% 却永不触发压缩（压缩判定用
	 * ContextManager 的 real usage，一直远低于 140k 线）。详见 DETAIL §44。
	 *
	 * 落盘意义：重启/恢复会话时，环能用**真实占用**（而非对全部历史做字符估算）。
	 */
	usagePromptTokens = 0;
	// ★★★ 2026-09-21（用户报「tokens tip 显示内容不全 + **重启后数据丢失**」✓）：
	// 落盘路径此前只存 input/output/total/cached/cacheWrite ✗ —— 而 **live** 路径
	//（`nativeChatEditorPane` 的 usage delta 处理 ✓）还会写 `reasoning` / `cacheMiss` /
	// `cacheHitRate` / `providerId` / `model` ✓✓ ⇒ 重启后这些富字段全丢 ✗（明细浮层随之残缺 ✓）。
	// 现按 live 路径**同款字段集**落盘 ✓（含 0 ✓ —— 零值也是真实读数 ✗）。
	usageReasoning = 0;
	usageProviderId = undefined as string | undefined;
	usageModelId = undefined as string | undefined;
	/**
	 * 卡片数据类 delta（references / progress / confirmation(_resolved) / todos / tips / questions ✓）。
	 *
	 * 全是**纯赋值** ✓（零 IO、零回调 ✓）⇒ 从 `sendMessage` 的 delta 分发里原样搬出 ✓（2026-09-22 阶段④-g B3-a ✓）。
	 * ⚠ `confirmation_resolved` 必须**校验 id 匹配** ✗✓：否则别的卡片的审批结果会覆盖当前卡片 ✓。
	 */
	/**
	 * 文本三连：`text` / `thinking` / `content_replace`（2026-09-22 阶段④-g B3-b ✓ 原样搬出 ✓）。
	 *
	 * 三条必须一起搬 ✗✓ —— 它们**共同维护同一份文本状态**：
	 *  · `text` ⇒ 追加 chunk（**不是字符串 +=** ✓，见类头注释的 ConsString rope 事故 ✓）+ 更新/新建
	 *    末尾 text part ✓；
	 *  · `thinking` ⇒ 只追加 thinking chunk ✓（**不得混进 content** ✓）；
	 *  · `content_replace` ⇒ **重置** chunk 数组 ✓、**改写末尾 text part**（而非新建 ✓）、
	 *    并把 `currentTurnTextLen` 对齐到新文本长度 ✓（它决定 tool_start 的 textPosition ✓）。
	 * ⚠ 拆开搬会留下"状态只有一半被重置"的窗口 ✗✓（正是 `discard_prior_text` 那类缺陷的形态 ✓）。
	 */
	applyTextDelta(delta: IChatStreamDelta): void {
		if (delta.type === "text" && delta.content) {
			this._fullContentChunks.push(delta.content);
			// P0: chronological parts 跟踪——更新最后一个 text part 或创建新的
			const lastPart = this._streamingParts[this._streamingParts.length - 1];
			if (lastPart && lastPart.kind === 'text') {
				lastPart.text = (lastPart.text || '') + delta.content;
			} else {
				this._streamingParts.push({ kind: 'text', text: delta.content });
			}
		}
		if (delta.type === "thinking" && delta.content) {
			this._fullThinkingChunks.push(delta.content);
		}
		// content_replace: upstream extracted tool calls from text and wants
		// to replace the accumulated this.fullContent with the cleaned version.
		if (delta.type === "content_replace") {
			this._fullContentChunks.length = 0;
			if (delta.content) { this._fullContentChunks.push(delta.content); }
			// P0: chronological parts — content_replace 重置文本，更新最后一个 text part
			const lastPart = this._streamingParts[this._streamingParts.length - 1];
			if (lastPart && lastPart.kind === 'text') {
				lastPart.text = delta.content || '';
			} else {
				this._streamingParts.push({ kind: 'text', text: delta.content || '' });
			}
			this.currentTurnTextLen = (delta.content ?? "").length;
		}
	}

	/**
	 * 工具三连：`tool_start` / `tool_args` / `tool_result`（2026-09-22 阶段④-g B3-c ✓ 原样搬出 ✓）。
	 *
	 * **必须一起搬** ✗✓ —— 三者围绕同一份 `toolCalls` + `_toolArgChunks`：
	 *  · `tool_start` ⇒ 建卡片（`textPosition` 优先上游值 ✓，否则用 `currentTurnTextLen` ✓ ——
	 *    保证"文本/工具交织"重载后仍按原顺序渲染 ✓）+ 建 args 桶 + **push 一个 tool part** ✓；
	 *  · `tool_args` ⇒ 只**累加** chunk（参数可能分片到达 ✓）；
	 *  · `tool_result` ⇒ 回填 `result` 并**打 `status='done'`** ✗✓ —— 不打标记则刷新后卡片永远停在
	 *    loading 标题（webview mapPhase 无 status ⇒ 默认 pending ✓）。
	 * ⚠ 拆开搬会留下"卡片已建但参数/结果永远填不上"的窗口 ✗（tool_args dropped 那类故障形态 ✓）。
	 */
	applyToolDelta(delta: IChatStreamDelta): void {
		if (delta.type === "tool_start" && delta.toolCallId && delta.toolName) {
			if (!this.toolCalls) {
				this.toolCalls = [];
			}
			this.toolCalls.push({
				id: delta.toolCallId,
				name: delta.toolName,
				arguments: "",
				result: undefined,
				displayName: delta.displayName,
				renderType: delta.renderType,
				defaultShow: delta.defaultShow,
				serverExecuted: (delta as any).serverExecuted,
				// 记录卡片插入位置：优先用上游下发的 textPosition，否则用当前 turn 内
				// 已累积的文本长度。持久化后重载即可按位置交织渲染，而非全部排到末尾。
				textPosition: typeof (delta as any).textPosition === 'number'
					? (delta as any).textPosition
					: this.currentTurnTextLen,
			});
			this._toolArgChunks.set(delta.toolCallId, []);
			// P0: chronological parts 跟踪
			this._streamingParts.push({ kind: 'tool', tool: this.toolCalls[this.toolCalls.length - 1] });
		}
		if (
			delta.type === "tool_args" &&
			delta.toolCallId &&
			delta.content &&
			this.toolCalls
		) {
			const tc = this.toolCalls.find((t) => t.id === delta.toolCallId);
			if (tc) {
				let chunks = this._toolArgChunks.get(tc.id);
				if (!chunks) { chunks = []; this._toolArgChunks.set(tc.id, chunks); }
				chunks.push(delta.content);
			}
		}
		if (delta.type === "tool_result" && delta.toolCallId && this.toolCalls) {
			const tc = this.toolCalls.find((t) => t.id === delta.toolCallId);
			if (tc) {
				tc.result = delta.content;
				// Mark finished so the persisted card restores in a
				// completed (not loading) state after a window refresh.
				// Without this, the webview's mapPhase sees no status and
				// defaults to 'pending' → renders the loading title forever.
				tc.status = 'done';
			}
		}
	}

	/**
	 * Hermes 回合边界：把本 iteration 的快照成一个 turn（2026-09-22 阶段④-g B3-d ✓ 原样搬出 ✓）。
	 *
	 * 为什么要这么多轮消息 ✗✓：agentOS 每个 iteration 结束发 `assistant_turn`（含**权威文本**与
	 * 本轮 `toolCallIds`）⇒ 我们据此把一次用户请求拆成**多条** assistant 消息 ✓（每条只含本 iteration
	 * 的 content + 它发起的工具，紧跟其工具结果 ✓）⇒ 持久化历史与 agentOS 内部结构一致 ✓，
	 * 杜绝"先宣告成功、后调用工具"的**因果倒置**范例（会教坏模型下一轮不再调工具 ✗）。
	 *
	 * 两处不可省 ✓：① `currentTurnTextLen = 0` —— 下一轮工具卡片的 textPosition 从 0 重记 ✓；
	 * ② `onDelta({type:'content_replace', content: turnContent})` —— 把 webview 的 textBuffer 对齐到
	 * **sanitized** 文本 ✓，否则多轮后 buffer 与宿主消息内容不一致（CONTENT MISMATCH ⇒ 渲染异常/卡死 ✗✓）。
	 *
	 * ⚠ `continue`（跳过本条 delta 的其余处理 ✓）**留在宿主** ✗✓ —— 控制流语义不由本方法承担 ✓。
	 */
	// ⚠ 回调形参刻意用 `any` ✗✓：仓里有两个同名 `IChatStreamDelta`（见类头注释 ✓）——
	//   宿主侧 `onDelta` 声明用的是 `common/agentStudio.js` 那个 ✓，本模块用 `providers.js` ✓，
	//   两者结构相同但**声明不同** ⇒ 显式标注会互不兼容 ✗。这里只需要"能接收本模块的 delta" ✓，
	//   故用 `any` 桥接 ✓（不改任何行为 ✓；真正要防的是**把类型导错**，已按铁律对齐 ✓）。
	applyAssistantTurn(delta: IChatStreamDelta, onDelta: (d: any) => void): void {
		const md = (delta as any).metadata ?? {};
		const ids = Array.isArray(md.toolCallIds) ? md.toolCallIds as string[] : [];
		const turnContent: string = (delta as any).content ?? "";
		this.turns.push({
			content: turnContent,
			toolCallIds: ids,
		});
			// 本轮结算：下一轮工具卡片的 textPosition 从 0 重新计起，
			// 与 _aggregateTurns 合并各 turn 时按 turn.content 长度累加 offset 对齐。
			this.currentTurnTextLen = 0;
			// 同步 webview 的 text buffer 为本轮 sanitized 文本
			if (turnContent) {
				onDelta({
					type: 'content_replace' as any,
					content: turnContent,
				});
			}
	}

	/**
	 * 阶段卡合并：`work_mode_changed` 带 `planPhase` 时并入最近的 plan_enter（优先）/plan_explore 卡片 ✓
	 * （2026-09-22 阶段④-g B3-d ✓ 原样搬出 ✓）。
	 *
	 * 合并语义 = **字段级** ✗✓（`currentStep`/`planFilePath`/`completedAt` 各自缺省保留旧值 ✓）
	 * ⇒ 支持 `plan_exit` 只带 `completedAt` 就定格完成态 ✓。共享引用随 parts 落盘 ⇒ 刷新后
	 * `adaptPersistedToolCall` 透传 planPhase，阶段卡不丢 ✓。
	 */
	applyWorkModeDelta(delta: IChatStreamDelta): void {
		if (delta.type === 'work_mode_changed' && (delta as any).planPhase && this.toolCalls) {
			const phase = (delta as any).planPhase as { currentStep?: number; planFilePath?: string; completedAt?: number };
			let planHostTc: any;
			for (let i = this.toolCalls.length - 1; i >= 0; i--) {
				const n = this.toolCalls[i]?.name;
				if (n === 'plan_enter') { planHostTc = this.toolCalls[i]; break; }
				if (n === 'plan_explore' && !planHostTc) { planHostTc = this.toolCalls[i]; }
			}
			if (planHostTc) {
				planHostTc.planPhase = {
					...(planHostTc.planPhase ?? {}),
					...(phase.currentStep !== undefined ? { currentStep: phase.currentStep } : {}),
					...(phase.planFilePath !== undefined ? { planFilePath: phase.planFilePath } : {}),
					...(phase.completedAt !== undefined ? { completedAt: phase.completedAt } : {}),
				};
			}
		}
	}

	/**
	 * 丢弃本轮已累计的**幻觉文本**（2026-09-22 阶段④-g B3-e ✓ 原样搬出 ✓ —— 含当日由行为基线
	 * 首跑抓到的缺陷修复 ✓）。
	 *
	 * 为什么必须连 `parts` 一起丢 ✗✓：`parts` 是「落盘有序段：文本段 + 工具段，**重载渲染的真相源**」✓
	 * —— 只清 `_fullContentChunks` 时，幻觉文本仍会被**渲染并落盘** ✗（实测 `parts[0].text` =
	 * "我刚才假装完成了任务真正执行" ✗）⇒ 正是本机制要防的 conversation rot 污染 ✓。
	 *
	 * 为何不能指望 `content_replace` 兜底 ✗✓：pi 路径（`piLoop/eventAdapter.ts:65` ✓）收到
	 * `discard_streamed_text` 时**只发这一个 delta、不伴随 content_replace** ✗ ⇒ 这里不丢就等于没丢 ✓。
	 *
	 * 语义 ✓：丢弃**末尾连续**的 text 段 —— XML 泄漏重试时它就是本轮那段文本 ✓；
	 * 工具段之前的文本属于更早的 iteration ⇒ **不动** ✓（避免误删已确认的工具前文 ✓）。
	 *
	 * ⚠ 本方法**零依赖** ✗✓：不打日志、不转发（二者留在宿主 ✓）⇒ 只返回被丢弃的字符数 ✓，
	 * 宿主据此打日志（含 `parts N→M` ✓）。
	 *
	 * @returns 被丢弃的字符数（content + thinking 之和 ✓）
	 */
	discardPriorText(): number {
		// ★ 2026-09-22（D-5 单测实测抓出的修复 ✓）：**分片侧也只丢尾部** ✗✓。
		//   旧实现 pop 掉尾部 text part，却把 `_fullContentChunks` **整体清空** ✗ ⇒ 两份真相源口径不一致 ✓：
		//   工具段**之前**的文本仍在 `parts`（会被渲染并落盘 ✓）却已从分片消失（宿主 join 出的全文不含它 ✗）
		//   ⇒ 与本方法 docblock「丢弃**末尾连续**的 text 段；工具段之前的文本属于更早的 iteration ⇒ 不动」**不符** ✓✗。
		//   现在：先量出尾部连续 text 段的长度 ✓，再**从分片尾部**移除同样多的字符 ✓ ⇒ 与 parts 同步 ✓。
		let trailingTextLen = 0;
		while (this._streamingParts.length > 0
			&& (this._streamingParts[this._streamingParts.length - 1] as any)?.kind === 'text') {
			trailingTextLen += String((this._streamingParts.pop() as any)?.text ?? '').length;
		}
		let remain = trailingTextLen;
		while (remain > 0 && this._fullContentChunks.length > 0) {
			const last = this._fullContentChunks[this._fullContentChunks.length - 1];
			if (last.length <= remain) {
				remain -= last.length;
				this._fullContentChunks.pop();
			} else {
				this._fullContentChunks[this._fullContentChunks.length - 1] = last.slice(0, last.length - remain);
				remain = 0;
			}
		}
		// thinking **没有独立 parts**（不参与渲染 ✓）⇒ 重试时它同样无效 ⇒ 整段作废更安全 ✓（不影响一致性 ✓）
		const discardedThinking = this._fullThinkingChunks.reduce((a, s) => a + s.length, 0);
		this._fullThinkingChunks.length = 0;
		this.currentTurnTextLen = 0;
		// 返回量 = **真正丢弃的**字符数（content 尾段 + 全部 thinking ✓）⇒ 宿主日志据此报数 ✓
		return trailingTextLen + discardedThinking;
	}

	/**
	 * P5：捕获**压缩边界**事件（`context_compacted` ✓，2026-09-22 阶段④-g B3-f ✓ 原样搬出 ✓）。
	 *
	 * 语义 ✓：executor 在 loop 内压缩成功后 yield 它（含 `compressionSummary` ✓）⇒ 这里**只记录边界** ✓，
	 * **不转发、不消费** ✗✓（原有 onDelta 转发链不变 ✓），供最终落盘时把边界消息插到压缩点位置 ✓；
	 * 下一 turn 回灌从边界处重放 ⇒ 边界之前的历史由摘要承载 ✓（长会话不再每轮重新膨胀 ✗）。
	 *
	 * ⚠ 两条：① 同一回合多次压缩 —— **后到的覆盖先到的**（取最后一次 ✓）；
	 * `summaryChars` 是**核心摘要字符数** ✓（由 compressContext 产出、emit 透传 ✓）—— 摘要饥饿判据
	 * **只认它** ✗✓（不含确定性追加的文件清单 ✓）。② 本方法**零依赖** ✓：不打日志，改为**返回**
	 * 日志所需字段（宿主打印 ✓，日志文案逐字未变 ⇒ 按前缀 grep 的排查手册不受影响 ✓）。
	 *
	 * @returns 捕获到的边界摘要字段 ✓；未捕获（无 summary）返回 `undefined` ✓
	 */
	applyContextCompacted(delta: IChatStreamDelta):
		{ turnCount: number; originalCount: number; compressedCount: number; tokensSaved: number } | undefined {
		const summary = (delta as any).compressionSummary;
		if (!(typeof summary === 'string' && summary.length > 0)) { return undefined; }
		this.pendingCompaction = {
			summary,
			turnCount: this.turns.length,
			originalCount: (delta as any).compressionOriginalCount ?? 0,
			compressedCount: (delta as any).compressionCompressedCount ?? 0,
			tokensSaved: (delta as any).compressionTokensSaved ?? 0,
			// 核心摘要字符数（2026-09-21）：由 compressContext 产出、emit 透传；
			// 摘要饥饿判据只认它（不含确定性追加的文件清单）。
			summaryChars: (delta as any).compressionSummaryChars,
		};
		return {
			turnCount: this.turns.length,
			originalCount: this.pendingCompaction.originalCount,
			compressedCount: this.pendingCompaction.compressedCount,
			tokensSaved: this.pendingCompaction.tokensSaved,
		};
	}

	applyCardData(delta: IChatStreamDelta): void {
		// Handle new card data delta types (VS Code Copilot Chat pattern)
		if (delta.type === 'references' && delta.references) {
			this.references = delta.references as unknown as ChatMessage['references'];
		}
		if (delta.type === 'progress' && delta.progressData) {
			this.progress = delta.progressData as unknown as ChatMessage['progress'];
		}
		if (delta.type === 'confirmation' && delta.confirmationData) {
			this.confirmation = delta.confirmationData as unknown as ChatMessage['confirmation'];
		}
		if (delta.type === 'confirmation_resolved' && this.confirmation && (delta as any).confirmationId === this.confirmation.id) {
			// Persist approval resolution: approved/rejected/reverted status survives reload
			this.confirmation = {
				...this.confirmation,
				status: ((delta as any).confirmationStatus as any) || 'rejected',
			};
		}
		if (delta.type === 'todos' && delta.todosData) {
			this.todos = delta.todosData as unknown as ChatMessage['todos'];
		}
		if (delta.type === 'tips' && delta.tipsData) {
			this.tips = delta.tipsData as unknown as ChatMessage['tips'];
		}
		if (delta.type === 'questions' && delta.questionsData) {
			this.questions = delta.questionsData as unknown as ChatMessage['questions'];
		}
	}

	/**
	 * 累计 token usage（KV Cache 口径 ✓）。
	 *
	 * ⚠ 两条口径不能混 ✗✓（本类头注释亦记 ✓）：
	 *  · `usageInput` **累加**（footer 展示本轮总消费 ✓）；
	 *  · `usagePromptTokens` 只**覆盖**为最近一次的 input（= 当前上下文占用 ✓）。
	 * 曾经两者共用一值 ⇒ 长 turn 后上下文环暴涨（实测 1,465,040 vs 真实 80,724 ✗）⇒ 显示 100%
	 * 却**永不触发压缩** ✗✓。
	 * 另外 BYOK provider 可能在**流式块**或**非流式回退**任一路径发 usage ⇒ 一律**求和**（不覆盖 ✓）。
	 *
	 * ⚠ **同名类型陷阱（2026-09-22 迁移实测 ✓✓）**：仓里存在**两个同名 `IChatStreamDelta`** ✗ ——
	 * `common/providers.ts`（**driver 真正 yield 的那个** ✓，联合类型更宽 ✓，含 `confirmation_resolved`、`usage.providerId/modelId` ✓）
	 * 与 `sessions/common/agentStudioService`（经 `common/agentStudio.ts` 再导出 ✓，字段更少 ✗）。
	 * 从**错误的那个**导入 ⇒ 类型被静默收窄 ⇒ `delta.type === 'confirmation_resolved'` 之类会报"无重叠" ✗✓，
	 * 而**症状极其误导**：看起来像"联合类型缺了运行时事件" ✗，实际只是**导入源不同** ✓✓。
	 * 处置 ✓：本模块**与 `agentDriver.ts` 同源**（都从 `providers.js` 导入 ✓）—— 类型必须与"事件的产生方"对齐 ✓。
	 */
	applyUsage(delta: IChatStreamDelta): void {
		// KV Cache: aggregate per-chunk usage so the persisted ChatMessage
		// carries the final token totals (BYOK providers may emit usage on
		// either the streaming chunk path or the fallback non-streaming path,
		// so we sum defensively rather than overwrite).
		if (delta.type === 'usage' && delta.usage) {
			this.usageSeen = true;
			if (typeof delta.usage.inputTokens === 'number') { this.usageInput += delta.usage.inputTokens; }
			// ★ 2026-09-21：同时记录**最近一次**的 input（= 当前上下文占用）——只覆盖、不累加。
			if (typeof delta.usage.inputTokens === 'number') { this.usagePromptTokens = delta.usage.inputTokens; }
			if (typeof delta.usage.outputTokens === 'number') { this.usageOutput += delta.usage.outputTokens; }
			if (typeof delta.usage.cachedTokens === 'number') { this.usageCached += delta.usage.cachedTokens; }
			if (typeof delta.usage.cacheWriteTokens === 'number') { this.usageCacheWrite += delta.usage.cacheWriteTokens; }
			// ★ 与 live 路径对齐 ✓：推理 token（OpenAI reasoning_tokens 系 ✓）与真实命中的 provider/model ✓
			if (typeof delta.usage.reasoning === 'number') { this.usageReasoning += delta.usage.reasoning; }
			if (delta.usage.providerId) { this.usageProviderId = delta.usage.providerId; }
			if (delta.usage.modelId) { this.usageModelId = delta.usage.modelId; }
			if (typeof delta.usage.totalTokens === 'number') { this.usageTotalReported += delta.usage.totalTokens; }
			if (typeof delta.usage.credit === 'number') { this.usageCredit += delta.usage.credit; this.usageCreditSeen = true; }
		}
	}

}
