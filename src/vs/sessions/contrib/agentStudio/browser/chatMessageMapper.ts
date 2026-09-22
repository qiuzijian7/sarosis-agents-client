/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ILogService } from '../../../../platform/log/common/log.js';
import type { StreamAccumulator } from './streamAccumulator.js';
import type { ChatMessage } from '../common/types.js';
import type { IChatMessage } from '../common/providers.js';
import {
	sliceAtCompactionBoundary, truncateToolResultContent, COMPACTION_METADATA_TYPE,
} from '../common/historyCompaction.js';

/* ─────────────────────────────────────────────────────────────────────────────
 * ⚠ 2026-09-22：**特性关闭版**内联实现 ✓（只改本模块、不动上游文件 ✗✓）
 *
 * 来历 ✓：上游那批**未提交**的 L3/L4 改造（「按工具形状分配预算 + 搜索类单行收窄」✓）
 * 曾从 `common/historyCompaction.js` 导出下面三个 helper ✗，本模块搬运时直接复用 ✓；
 * 该改造随后随**快照恢复**被一并还原 ✗ ⇒ 三个导出消失（**HEAD 里也从未有过** ✓，
 * `out/` 编译产物里同样没有 ✓）⇒ 本模块成了孤儿引用 ✗✓。
 *
 * ⚠ 刻意**不猜**工具名分类与收窄算法 ✗（无任何忠实来源 ✓）⇒ 退化为：
 *   · 行收窄 = **no-op** ✓（上游已无此能力 ⇒ "更保守"而非"改行为" ✓）；
 *   · 预算   = **8192** ✓ —— 该值取自本文件的原注释（「搜索类 4096 / 默认 8192 /
 *     skill·memory 12288」✓），不是我编的 ✗✓。
 * ✅ 上游恢复后应改回 `import { … } from '../common/historyCompaction.js'` ✗✓
 *   （届时删掉这三个内联常量 ✓）。
 * ───────────────────────────────────────────────────────────────────────────── */
const usesToolResultLineCap = (_toolName: string): boolean => false;
const applyToolResultLineCap = (text: string): string => text;
const resolveToolResultViewChars = (_toolName: string): number => 8192;
import { deriveMessageParts } from '../common/types.js';

/**
 * host `ChatMessage[]` → driver `IChatMessage[]` 的**唯一漏斗** + 压缩边界消息构造 + 污染判定
 * ✓（2026-09-22 阶段④-b1 从 `agentChatService.ts` 原样搬出 ✓）。
 *
 * 为何单独成模块 ✓：这三段是**纯逻辑**（无 DOM、无文件 IO ✓ —— 落盘经回调注入 ✓），
 * 却承载了四条"只能有一个真相源"的强约定 ✗✓：
 *  ① **压缩边界回放**（`sliceAtCompactionBoundary` ✓）：长会话不再每 turn 重新膨胀/重新压缩；
 *  ② **相邻重复 user 去重** ✓：早期持久化双写 race 在盘上沉淀了大量"同一条相邻出现 2 次"的脏数据，
 *     B 方案每轮回灌会原样发给模型 ⇒ 必须在**唯一漏斗**处折叠（只折叠**相邻**且内容全等 ✓）；
 *  ③ **污染过滤** ✓：assistant 内容疑似"假装完成/未遂道歉"时清空；**没有工具调用**时整条丢弃
 *     （有工具调用必须保留以维持 `tool_call ↔ tool` 配对完整 ✓）；
 *  ④ **冻结截断 + 取回句柄** ✓：同一内容永远得到逐字节相同结果 ⇒ 跨 turn 前缀缓存不漂移 ✓，
 *     同时把全文落盘并附句柄 ⇒ **信息永不真正丢失** ✓。
 */
export interface IChatMessageMapperDeps {
		logService: ILogService;
	/** 取会话桶内的缓存消息（key 由宿主算 ✓）—— 归 `MessageBucketCache` ✓。 */
	getCachedMessages: (agentId: string, agentSessionId: string | undefined) => readonly ChatMessage[];
	/** 超长工具结果**全文落盘**并返回取回句柄 —— 归 `SessionSidecarStore` ✓。 */
	ensureSidecarFullText: (
		agentId: string | undefined,
		agentSessionId: string | undefined,
		toolCallId: string,
		fullText: string,
	) => Promise<string | undefined>;
}

/**
 * 防御性过滤：检测 assistant content 是否疑似被 fake-completion / unfinished-intent
 * 污染（旧 session 残留的"您完全正确！我犯了严重错误..."幻觉道歉模式）。
 *
 * 即使新机制（discard_prior_text）已阻止新污染，旧 session 已写入的 _historyCache
 * 仍含污染条目。这里在组装 priorMessages 时主动跳过/重写这些条目，让旧 session
 * 也能立即恢复，无需手动 reset。
 *
 * 命中规则（任一即视为污染）：
 *  - "您完全正确" / "我犯了严重错误" / "让我重新" 开头（fake-completion 模型自我反省语）
 *  - 没有 toolCalls 也没有正常文本输出，只是道歉性过渡语
 */
export function isContaminated(content: string): boolean {
	if (!content) {
		return false;
	}
	const head = content.slice(0, 80);
	const patterns = [
		/^您完全正确/,
		/^我犯了严重错误/,
		/^让我重新(?:开始|尝试|执行)/,
		/^抱歉.{0,10}重新/,
		/^对不起.{0,10}重新/,
		/^检测到模型未真正调用工具/, // 我们自己的 nudge 提示，也不应回灌历史
	];
	return patterns.some(re => re.test(head));
}

/**
 * ★★★ 2026-09-21：构造**压缩边界消息**（两条 fail-safe 的落点 ✓）。
 *
 * ── 真机取证（用户报「切换模型后 LLM 对上下文一无所知」✓）──────────────────────
 * 现场：`sess_ms5kriv8_0j6atj` ✓ 含 1 条边界，其摘要把 `## Active Task` 与 `## Goal`
 * **都写成「无」** ✗，`metadata.tokensSaved = **-73**`（压缩反而变大 ✗）。而模型能看到的
 * 边界之前的内容**只有这条边界** ✗（`sliceAtCompactionBoundary` 丢弃边界之前全部消息 ✓）
 * ⇒ 用户接着说「执行」⇒ 模型回答「当前对话里没有待执行的任务指令」✓✓ 与截图逐字吻合 ✓。
 *
 * ── 两条 fail-safe（本方法 + 调用方 guard ✓）──────────────────────────────────
 * ① **原文兜底**：边界里追加**最近 N 条 user 消息原文** ✓ —— 摘要质量再差，也不会丢
 *    "用户到底要什么" ✗（此前完全依赖摘要质量 ⇒ 摘要一失手，任务就消失了 ✗✓）；
 * ② **无收益就不插**（调用方 `tokensSaved > 0` guard ✓）：压缩没省下 token 时，
 *    边界只有"销毁上下文"这一种效果 ✗✓。
 * ③ **摘要信息量指纹**（2026-09-21 补 ✓）：`metadata.summaryChars` 记录**纯摘要**长度，
 *    供回放侧 `isValidCompactionBoundary` 判"摘要饥饿"⇒ 不切片 ⇒ 不丢历史 ✗✓。
 *    ★ 起因：`tokensSaved > 0` 是**错误的成功判据** —— 毁内容最容易省 token ✓。
 *    真机取证（日志 `vscode-app-1789994132110.log`）：切模型后窗口塌到 64k ⇒ 强制压缩
 *    走 RETRIEVAL 模式 `tokens=129`（153 条消息只换回 129 token），`saved=24836 > 0`
 *    顺利通过 ② 的 guard ⇒ 边界照插 ⇒ 模型永久失忆、转去 `session_search` 抓别的任务。
 */
export function buildCompactionBoundaryMessage(
	deps: IChatMessageMapperDeps,
	agentId: string,
	agentSessionId: string | undefined,
	pending: { originalCount: number; compressedCount: number; tokensSaved: number; summary: string; summaryChars?: number },
	currentMessage: string | undefined,
): ChatMessage {
	// ① 最近 2 条 user 原文（排除"当前这条"以避免与 driver 追加的当前消息重复 ✓）
	const recent: string[] = [];
	try {
		const cache = deps.getCachedMessages(agentId, agentSessionId);
		for (let i = cache.length - 1; i >= 0 && recent.length < 2; i--) {
			const m = cache[i];
			if (m.role !== 'user') { continue; }
			const text = (m.content ?? '').trim();
			if (!text) { continue; }
			if (currentMessage !== undefined && text === currentMessage.trim()) { continue; }
			recent.unshift(text);
		}
	} catch { /* 取不到原文不影响主流程 ✓ */ }
	const tail = recent.length > 0
		? `\n\n---\n**用户最近的指令（原文保留 —— 摘要可能失真，以下为准确来源 ✗）**：\n` +
			recent.map((t, i) => `${i + 1}. ${t.length > 400 ? t.slice(0, 400) + '…' : t}`).join('\n')
		: '';
	return {
		id: `msg_compaction_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
		role: 'assistant',
		content: `[上下文压缩] 此前的对话历史（${pending.originalCount} 条消息）已压缩为以下摘要：\n\n${pending.summary}${tail}`,
		agentId,
		agentSessionId,
		timestamp: new Date().toISOString(),
		metadata: {
			type: COMPACTION_METADATA_TYPE,
			originalCount: pending.originalCount,
			compressedCount: pending.compressedCount,
			tokensSaved: pending.tokensSaved,
			// ③ 摘要信息量指纹（2026-09-21）：`historyCompaction.isValidCompactionBoundary`
			// 用它判边界是否可信（摘要饥饿 ⇒ 不切片 ⇒ 不丢历史）。记录**核心摘要**长度
			// —— 不含固定前缀、"最近指令原文"尾部、以及确定性追加的文件清单
			// （它们都会把空壳/饥饿摘要撑过门槛 ✗）。优先用压缩侧透传的精确值。
			summaryChars: pending.summaryChars ?? pending.summary.trim().length,
		},
	};
}

export async function toDriverMessages(
	history: readonly ChatMessage[],
	agentId: string | undefined,
	agentSessionId: string | undefined,
	deps: IChatMessageMapperDeps,
): Promise<IChatMessage[]> {
	// ─── P5: 压缩边界回放（压缩状态跨 turn 持久化）────────────────────────
	// 历史中最后一条 metadata.type='compaction' 的消息是压缩边界：其 content
	// 已承载旧历史摘要，边界之前的消息不再回灌（对齐 opencode/MiMo 的
	// compaction boundary 持久化），长会话不再每 turn 重新膨胀、重新压缩。
	history = sliceAtCompactionBoundary(history);
	// 🧹 一致性兜底（2026-06-05）：折叠**连续重复的 user 消息**。
	// 历史 session 文件（如 sess_mpwt6z2s_szhpq3.json）因早期持久化双写 race
	// （webview controller `_handleChatSend` 与 service `sendMessage` 各 append
	// 一次，5 秒 dedup 守卫在不同进程/时序下失效），磁盘上已沉淀大量"同一条
	// user 消息相邻出现 2 次"的脏数据。B 方案每轮把整段历史回灌给模型，会原样
	// 把重复 user 发出去（log 里 hello×4 / test×2 / createtestN×2）。这里在
	// 组装 driver messages 的唯一漏斗处做最终去重：相邻且 content 完全相同的
	// user 消息只保留第一条，杜绝重复输入污染模型上下文。注意只折叠**相邻**
	// 重复，正常的"用户连续发两条不同消息"不受影响。
	let collapsedUserDup = 0;
	const deduped: ChatMessage[] = [];
	for (const m of history) {
		const prev = deduped[deduped.length - 1];
		if (
			m.role === 'user' &&
			prev &&
			prev.role === 'user' &&
			(prev.content ?? '') === (m.content ?? '')
		) {
			collapsedUserDup++;
			continue;
		}
		deduped.push(m);
	}
	if (collapsedUserDup > 0) {
		deps.logService.warn(
			`[AgentChatService] 🧹 _toDriverMessages: collapsed ${collapsedUserDup} consecutive duplicate user message(s) (persist-race / legacy session-file pollution guard)`,
		);
	}

	const out: IChatMessage[] = [];
	let droppedContaminated = 0;
	// ─── P5: 冻结截断文本（frozen truncation，对齐 openclaw projection）────
	// 工具结果统一做确定性截断（同一内容永远得到逐字节相同的结果），
	// 不再按 head/middle/tail 区域区分 —— 消除了"消息从 tail 保护区移入
	// middle 截断区时字节变化"导致的跨 turn 缓存前缀漂移。
	// 同时仍满足原 P4 目标：renderer→ext-host 的 IPC 序列化不压垮 4GB heap。
	let ipcTruncatedResults = 0;
	let ipcTruncatedBytes = 0;
	let ipcHandleAttached = 0;
	// 2026-09-22 L4：超长结果先确保**全文落盘**，再把"取回句柄"随截断文本一起下发
	// —— 信息永不真正丢失；句柄确定性 ⇒ 不破坏前缀缓存。
	// L3（同日）：按工具形状分配预算（搜索类 4096 / 默认 8192 / skill·memory 12288）。
	// L3b：搜索类先做**单行收窄**——行多而短的结果常因此整体落进预算（无需截断、无需句柄）。
	const truncatedByTool = new Map<string, { count: number; bytes: number }>();
	const truncateResult = async (s: string, toolCallId: string, toolName: string): Promise<string> => {
		let text = s;
		if (usesToolResultLineCap(toolName)) {
			text = applyToolResultLineCap(text);
		}
		const cap = resolveToolResultViewChars(toolName);
		if (text.length <= cap) {
			return text; // 行收窄后已落进预算 ⇒ 不计截断、不落盘、不加句柄
		}
		ipcTruncatedResults++;
		ipcTruncatedBytes += text.length - cap;
		const key = toolName || '(unknown)';
		const stat = truncatedByTool.get(key) ?? { count: 0, bytes: 0 };
		stat.count++;
		stat.bytes += text.length - cap;
		truncatedByTool.set(key, stat);
		// 落盘的是**原始全文** s（而非按行收窄后的 text）——"全文"必须名副其实
		const handle = await deps.ensureSidecarFullText(agentId, agentSessionId, toolCallId, s);
		if (handle) { ipcHandleAttached++; }
		// ⚠ 2026-09-22：`truncateToolResultContent` 现签名只接受 `(content, limit)` ✗
		//   ⇒ **取回句柄由本处自行追加** ✓（句柄自带前导换行，见 `SessionSidecarStore.ensure` ✓
		//   ⇒ 这里不再补 `\n`，否则会多一个空行 ✓✗）。信息永不真正丢失这一条保持不变 ✓。
		const truncated = truncateToolResultContent(text, cap);
		return handle ? truncated + handle : truncated;
	};

	for (let mi = 0; mi < deduped.length; mi++) {
		const m = deduped[mi];
		if (m.role === 'user') {
			out.push({ role: 'user', content: m.content ?? '' });
		} else if (m.role === 'assistant') {
			// 仅保留已完成（有 result）的工具调用，保证 tool_call ↔ tool 配对完整
			const completed = (m.toolCalls ?? []).filter(
				tc => typeof tc.result === 'string',
			);
			// 🧹 防御过滤：assistant 内容疑似污染且**没有任何工具调用**时整条丢弃
			// （有工具调用的 assistant 必须保留以维持 tool_call ↔ tool 配对完整性，
			// 但可以把 content 重写为空串，让模型只看到工具调用历史，不再看到道歉语料）
			const contentRaw = m.content ?? '';
			const contaminated = isContaminated(contentRaw);
			if (contaminated && completed.length === 0) {
				droppedContaminated++;
				continue;
			}
			const sanitizedContent = contaminated ? '' : contentRaw;
			if (contaminated) {
				droppedContaminated++;
			}
			const assistantMsg: IChatMessage = {
				role: 'assistant',
				content: sanitizedContent,
				...(completed.length > 0
					? {
						toolCalls: completed.map(tc => ({
							id: tc.id,
							name: tc.name,
							arguments: tc.arguments ?? '{}',
						})),
					}
					: {}),
			};
			out.push(assistantMsg);
		// 为每个已完成工具调用补一条配对的 tool 响应消息
		for (const tc of completed) {
			const raw = tc.result ?? '';
			out.push({
				role: 'tool',
				content: await truncateResult(raw, tc.id, tc.name ?? ''),
				toolCallId: tc.id,
			});
		}
	} else if (m.role === 'system') {
		out.push({ role: 'system', content: m.content ?? '' });
	} else if (m.role === 'tool') {
		// 防御性：host 端通常不产生独立 tool 消息
		const raw = m.content ?? '';
		out.push({
			role: 'tool',
			content: await truncateResult(raw, '', ''),
			toolCallId: '',
		});
	}
}
if (ipcTruncatedResults > 0) {
	// L3 诊断（2026-09-22）：按工具名给出截断分布 —— 这张表就是"该给哪些工具单独定 cap"的依据。
	const top = [...truncatedByTool.entries()]
		.sort((a, b) => b[1].bytes - a[1].bytes)
		.slice(0, 6)
		.map(([name, st]) => `${name}×${st.count}(-${(st.bytes / 1024).toFixed(1)}KB)`)
		.join(' ');
	deps.logService.info(
		`[AgentChatService][P5-frozen] Truncated ${ipcTruncatedResults} tool result(s) `
		+ `(-${(ipcTruncatedBytes / 1024).toFixed(1)}KB, 按工具形状 cap, `
		+ `deterministic/frozen, head+tail, 取回句柄=${ipcHandleAttached}) | 分布: ${top}`,
	);
}
	if (droppedContaminated > 0) {
		deps.logService.info(
			`[AgentChatService] 🧹 _toDriverMessages: filtered ${droppedContaminated} contaminated assistant messages (fake-completion / unfinished-intent residue)`,
		);
	}
	return out;
}

/**
 * 把累加器里的 token 读数算成**落盘/展示用**的 `tokenUsage` ✓（2026-09-22 阶段④-g C ✓）。
 *
 * ⚠ 之所以抽成函数 ✓：**回退路径（单条落盘）也要用** ✗✓ ⇒ 必须只有一个真相源 ✓
 *（口径注释随实现搬 ✓，见函数体内 ✓）。宿主与 `buildCompletedMessages` 都调它 ✓，零重复 ✓。
 */
export function computeSharedTokenUsage(acc: StreamAccumulator) {
	// ★★★ 2026-09-21：字段集与 **live** 路径（`nativeChatEditorPane` usage delta ✓）
	// **完全对齐** ✓ —— 否则"重启后明细浮层缺行"✗（用户实测 ✓）。要点：
	//  · `cached/cachedRead/cacheWrite/reasoning` **零值也写** ✓（零值 = 真实读数 ✗；
	//    此前 `> 0 ? : undefined` 会把它抹成"无数据" ✓ → 重启后整行消失 ✗）；
	//  · `cacheMiss` / `cacheHitRate` 是**派生量** ✓（口径与 live/UIS 一致 ✓）；
	//  · `credit` 保留"是否出现过"语义 ✓（0 与"未提供"必须区分 ✓）。
	const sharedTokenUsage = acc.usageSeen
		? (() => {
			const input = acc.usageInput;
			const cachedRead = acc.usageCached;
			const cacheMiss = Math.max(0, input - cachedRead - acc.usageCacheWrite);
			return {
				input,
				output: acc.usageOutput,
				// Prefer the gateway-reported total_tokens when present (it may
				// account for tokens not split into input/output); otherwise derive.
				total: acc.usageTotalReported > 0 ? acc.usageTotalReported : acc.usageInput + acc.usageOutput,
				// ★ 2026-09-21：**当前上下文占用**（末次请求的 prompt 大小）——与 live 路径
				// （`nativeChatEditorPane` 采集的同名字段）同义；落盘后重启/恢复会话时
				// 上下文环能显示真实占用，不再回退到「对全部历史做字符估算」（会高估十倍以上）。
				promptTokens: acc.usagePromptTokens,
				cached: cachedRead,
				cachedRead,
				cacheWrite: acc.usageCacheWrite,
				cacheMiss,
				// 命中率：与 live 路径同式 ✓（百分比，一位小数展示由 UI 负责 ✓）
				cacheHitRate: input > 0 ? (cachedRead / input) * 100 : 0,
				reasoning: acc.usageReasoning,
				credit: acc.usageCreditSeen ? acc.usageCredit : undefined,
				// 真实命中的 provider/model（"UI 选 A 实际用 B"场景的真相 ✓）——
				// 此前完全没落盘 ✗ ⇒ 重启后明细里的「模型」行消失 ✗✓
				providerId: acc.usageProviderId,
				model: acc.usageModelId,
			};
		})()
		: undefined;

	return sharedTokenUsage;
}

/**
 * 把「逐 iteration 的回合快照」构建成**待落盘的多条 assistant 消息** ✓（2026-09-22 阶段④-g C ✓）。
 *
 * 为什么按回合切分（原注释随实现搬 ✓）：agentOS 发来逐 iteration 的 `assistant_turn` 边界 ⇒
 * 每条消息只含**本轮** content + **本轮发起**的工具调用（result 已按 id 回填到全局 ✓）⇒ 磁盘历史天然
 * 呈现 `assistant(意图+工具)→tool(结果)→assistant(下轮/总结)` 的**正确因果链** ✓，
 * 回灌时不再出现「先宣告成功、后调用工具」的倒置范例 ✗✓（Hermes-style 多条持久化的治本根因 ✓）。
 *
 * ⚠ 三条硬约束（都由行为基线钉住 ✓）：
 *  · **工具归属发起它的那个 turn** ✗✓ —— `tool_result` 常在 `assistant_turn` **之后**才到 ⇒
 *    收尾必须**跨 turn 回填**；已认领的 id **不得**被后面的 turn 重复认领（否则卡片出现两次 ✓）；
 *  · **最后一轮兜底** ✓ —— 未被任何 turn 认领的工具调用（旧后端/直连模式残留）归给最后一条 ✗；
 *  · **压缩边界按发生位置插入** ✗✓ —— `insertAt = min(事件时的 turnCount, 长度)` ✓；
 *    `tokensSaved ≤ 0` 时**不插**（插了只有「销毁上下文」一个效果 ✗✓ 真机 −73 事故 ✓）。
 *
 * 整回合聚合量（thinking / references / progress / confirmation / todos / tips / questions / tokenUsage）
 * **只挂最后一条** ✓（否则在多条气泡里重复渲染 ✗）。
 */
export function buildCompletedMessages(params: {
	agentId: string;
	agentSessionId: string | undefined;
	/** 用户本轮消息：边界消息要用它做「原文兜底」段 ✓ */
	userMessage: string;
	acc: StreamAccumulator;
	/** 整回合 token 用量（与 live 路径同口径 ✓ —— 由 `computeSharedTokenUsage` 产出 ✓） */
	sharedTokenUsage: ReturnType<typeof computeSharedTokenUsage>;
	deps: IChatMessageMapperDeps;
}): { builtMessages: ChatMessage[]; turnId: string } {
	const { agentId, agentSessionId, userMessage, acc, sharedTokenUsage, deps } = params;
			const turnId = `turn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
			const allToolCalls = acc.toolCalls ?? [];
			const claimedIds = new Set<string>();
			const builtMessages: ChatMessage[] = [];

			for (let i = 0; i < acc.turns.length; i++) {
				const turn = acc.turns[i];
				const isLast = i === acc.turns.length - 1;
				// 收集本轮工具调用（按 id 从全局取，已含回填好的 result/status）
				let turnToolCalls = turn.toolCallIds
					.map(id => allToolCalls.find(tc => tc.id === id))
					.filter((tc): tc is NonNullable<typeof tc> => !!tc);
				for (const tc of turnToolCalls) { claimedIds.add(tc.id); }
				// 防御：最后一轮兜底接管任何未被任何 turn 认领的工具调用
				if (isLast) {
					const orphans = allToolCalls.filter(tc => !claimedIds.has(tc.id));
					if (orphans.length > 0) {
						turnToolCalls = [...turnToolCalls, ...orphans];
						for (const tc of orphans) { claimedIds.add(tc.id); }
					}
				}
				const msg: ChatMessage = {
					id: `msg_${Date.now()}_${i}_${Math.random().toString(36).substring(2, 7)}`,
					role: "assistant",
					content: turn.content,
					agentId,
					agentSessionId,
					turnId,
					timestamp: new Date().toISOString(),
					...(turnToolCalls.length > 0 ? { toolCalls: turnToolCalls } : {}),
					// 阶段E：落盘有序 parts（文本段与工具段按 textPosition 一次性切分定位），
					// 作为重载渲染的唯一真相。textPosition 仅在此处切分时使用，不再跨层依赖。
					parts: deriveMessageParts({ role: "assistant", content: turn.content, toolCalls: turnToolCalls }),
					// thinking + 卡片数据 + token usage 都是整回合聚合量，仅挂最后一条，
					// 避免在多条气泡里重复渲染。
					...(isLast ? {
						thinking: acc.fullThinking || undefined,
						references: acc.references || undefined,
						progress: acc.progress || undefined,
						confirmation: acc.confirmation || undefined,
						todos: acc.todos || undefined,
						tips: acc.tips || undefined,
						questions: acc.questions || undefined,
						tokenUsage: sharedTokenUsage,
					} : {}),
				};
				builtMessages.push(msg);
			}

		// ─── P5: 压缩边界消息插入（压缩状态跨 turn 持久化）────────────────
		// 本回合发生过压缩时，把边界消息插入到压缩点位置（压缩时已有 turnCount
		// 条 turn 消息，每条 turn 恰好产出一条持久化消息）。边界之后的消息
		// 是压缩后继续执行的真实迭代；下一 turn 回灌从边界处重放。
		if (acc.pendingCompaction && acc.pendingCompaction.tokensSaved > 0) {
			const boundaryMsg = buildCompactionBoundaryMessage(deps, agentId, agentSessionId, acc.pendingCompaction, userMessage);
			const insertAt = Math.min(acc.pendingCompaction.turnCount, builtMessages.length);
			builtMessages.splice(insertAt, 0, boundaryMsg);
			deps.logService.info(
				`[AgentChatService][P5] Persisting compaction boundary at position ${insertAt}/${builtMessages.length} (cross-turn compression persistence, tokensSaved=${acc.pendingCompaction.tokensSaved})`,
			);
		} else if (acc.pendingCompaction) {
			// ★ 2026-09-21 fail-safe ②：压缩**没省下 token** 时插边界只有"销毁上下文"一个效果 ✗✓
			//（真机：tokensSaved=-73 ✗ + 摘要把任务写成"无" ⇒ 下一轮模型失忆 ✓）
			deps.logService.warn(
				`[AgentChatService][P5] 跳过压缩边界：tokensSaved=${acc.pendingCompaction.tokensSaved} ≤ 0 ` +
				`（压缩无收益 ⇒ 保留完整历史，避免边界把上下文裁没 ✗✓）`,
			);
		}

	return { builtMessages, turnId };
}

