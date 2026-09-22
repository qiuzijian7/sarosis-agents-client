/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';
import type { IChatSendOptions } from '../common/agentStudio.js';
import type { IAgentDriverService } from '../common/agentDriver.js';
import {
	sliceAtCompactionBoundary, COMPACTION_METADATA_TYPE,
} from '../common/historyCompaction.js';
import type { AgentChatPaths, IAgentPaths } from './agentChatPaths.js';

/**
 * 压缩管线的**结果**（本模块自持的契约 ✓ —— 2026-09-22：原由 driver 接口提供 ✗，
 * 上游迁走后在此显式声明 ⇒ 本模块不再随 driver 接口漂移 ✓✓）。
 */
export interface ICompactionOutcome {
	didCompact: boolean;
	skipReason?: string;
	/** 参与压缩的原消息数 ✓ */
	originalCount: number;
	/** 压缩后摘要条数（通常 1 ✓） */
	compressedCount: number;
	tokensSaved: number;
	summary: string;
	/** 核心摘要字符数（摘要饥饿判据只认它 ✓） */
	summaryChars?: number;
	/** 压缩后**保留原文**的尾部条数（决定边界插在哪 ✓） */
	tailCount: number;
}

/** 宿主注入面（IO / 路径学 / driver / 两条历史读写 + 边界构造 ✓）。 */
export interface IContextMaintenanceDeps {
	logService: ILogService;
	fileService: IFileService;
	/** 路径学（cacheKey / sessionFileUri / sessionLogUri / resolveAgentPaths ✓）。 */
	paths: AgentChatPaths;
	/** 手动压缩走 driver 的同一条压缩管线（force=true ✓）。 */
	driverService: IAgentDriverService;
	/**
	 * ★ 2026-09-22：**压缩管线改为回调注入** ✓✓ —— 上游把 `compactMessagesForSession`
	 * 从 `IAgentDriverService` **迁走**了 ✗（迁往 `common/contextManager.ts` 的触发判定 +
	 * `browser/parts/turnContextCompaction.ts` 的 reducer 路径 ✓），原接口已不存在 ✗✓。
	 * ⇒ 本模块**不再依赖 driver 的具体形状** ✓：由宿主把"同一条管线"包成回调传进来 ✓
	 *   （手动压缩传 `force` 语义 ✓、推迟压缩走正常门槛 ✓）。
	 * ⚠ 保持 `driverService` 字段仅因**其它调用方**可能仍在用 ✓；若确认无人使用，可随后删除 ✓。
	 */
	compactMessages?: (args: {
		agentId: string;
		messages: readonly ChatMessage[];
		focus?: string;
		force?: boolean;
	}) => Promise<ICompactionOutcome>;
	/** 从会话文件装载历史（含惰性 scrub ✓）。 */
	loadFromSessionFile: (agentId: string, sessionId: string) => Promise<ChatMessage[]>;
	/** 整段改写落盘（命令回复作为操作记录留在 transcript 里 ✓）。 */
	persistToSessionFile: (agentId: string, sessionId: string | undefined, messages: ChatMessage[]) => Promise<void>;
	/** 回填内存桶（命令改写了历史 ⇒ 必须同步内存权威 ✗）。 */
	setCachedMessages: (key: string, messages: ChatMessage[]) => void;
	/** 压缩边界消息构造（实现在 `chatMessageMapper` ✓）。 */
	buildCompactionBoundaryMessage: (
		agentId: string,
		agentSessionId: string | undefined,
		pending: { originalCount: number; compressedCount: number; tokensSaved: number; summary: string; summaryChars?: number },
		currentMessage: string | undefined,
	) => ChatMessage;
	/** 会话写锁（追加/快照串行化 ✓；锁是 promise 链、**不可重入** ✗）。 */
	withSessionLogLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
	/** 锁内快照写（必须在 withSessionLogLock 内调用；严禁改用自带锁的 persistSnapshot ⇒ 死锁 ✗✓）。 */
	writeSessionSnapshotLocked: (agentId: string, sessionId: string, sessionsDirUri: URI, messages: readonly ChatMessage[]) => Promise<void>;
}

/** 失忆取证的最小依赖面（独立函数 ⇒ `agentChatService` 与 `ContextMaintenance` 共用同一份实现 ✓）。 */
export interface IPriorDiagDeps {
	readonly logService: ILogService;
	readonly fileService: IFileService;
	readonly resolveAgentPaths: (agentId: string) => Promise<IAgentPaths>;
	readonly sessionFileUri: (sessionsDirUri: URI, sessionId: string) => URI;
	readonly sessionLogUri: (sessionsDirUri: URI, sessionId: string) => URI;
	readonly cacheKey: (agentId: string, sessionId: string | undefined) => string;
}

/**
 * `priorMessages` 为空时的决定性取证（三种成因分开；注释见 `ContextMaintenance.diagnoseEmptyPriorMessages`）。
 *
 * ★ 2026-09-22 第二轮真机修正（`sess_…` 首条消息的假警报复现）：日志计数必须排除**两类非内容行** ——
 *   ① 屏障行 `{"op":"base"}`（会话引导的结构标记 ✗）；
 *   ② **本轮自己的 user 消息** —— 发送方是 fire-and-forget 落盘（agentChatService.sendMessage
 *      不 await appendMessage）⇒ 本探针可能跑在"本条消息已写进 jsonl"之后，`logLines=1` 其实就是
 *      它自己 ✗✗。按 `"role":"user"` + `"content":<原文>` 双针排除（序列化由同一
 *      `serializeSessionLogAppends` 产出 ⇒ 子串精确匹配 ✓）。
 *   已知接受项：若盘上恰有一条**内容完全相同**的更早 user 消息，会被一并排除（计数偏少 1）——
 *   真 key 不匹配场景下其余行仍会触发 ③ ⇒ 漏报概率可忽略 ✓。
 *
 * ⚠ `historyLength` 的语义是「本轮之前的历史条数」—— 调用方必须先剔除当前 user 消息
 *   （sendMessage 里 `trimmed.pop()` 之后的长度），否则新会话首条会误报 ② ✗。
 */
export async function diagnoseEmptyPriorMessagesImpl(
	deps: IPriorDiagDeps,
	agentId: string,
	sessionId: string | undefined,
	historyLength: number,
	currentMessage?: string,
): Promise<void> {
	try {
		if (!sessionId) {
			deps.logService.warn(
				`[AgentChatService][PriorDiag] ⚠ priorMessages 为空且 **sessionId 缺失** ⇒ ` +
				`模型本轮看不到任何历史（若 UI 里已有对话，说明这是"新会话/未分配 session"路径 ✗）。agentId=${agentId}`,
			);
			return;
		}
		const paths = await deps.resolveAgentPaths(agentId);
		const countMessages = async (uri: URI): Promise<number> => {
			try {
				if (!(await deps.fileService.exists(uri))) { return -1; } // -1 = 文件不存在（与 0 条区分 ✓）
				const text = (await deps.fileService.readFile(uri)).value.toString();
				const parsed = JSON.parse(text) as unknown;
				return Array.isArray(parsed) ? parsed.length : -2; // -2 = 存在但解析失败 ✗
			} catch { return -3; }
		};
		// 本轮消息的排除针（见函数头注释 ②）；只在调用方给了原文时才构造。
		const currentContentNeedle = currentMessage !== undefined
			? `"content":${JSON.stringify(currentMessage)}`
			: undefined;
		const countLogLines = async (uri: URI): Promise<number> => {
			try {
				if (!(await deps.fileService.exists(uri))) { return -1; }
				const text = (await deps.fileService.readFile(uri)).value.toString();
				return text.split('\n').filter(l => {
					const t = l.trim();
					if (!t) { return false; }
					if (t.includes('"op":"base"')) { return false; } // 屏障行（结构标记 ✗）
					if (currentContentNeedle && t.includes('"role":"user"') && t.includes(currentContentNeedle)) {
						return false; // 本轮自己的 user 消息（fire-and-forget 竞态 ✗）
					}
					return true;
				}).length;
			} catch { return -3; }
		};
		const snapshotCount = await countMessages(deps.sessionFileUri(paths.sessionsDirUri, sessionId));
		const logLines = await countLogLines(deps.sessionLogUri(paths.sessionsDirUri, sessionId));
		const diskHasContent = snapshotCount > 0 || logLines > 0;
		const key = deps.cacheKey(agentId, sessionId);

		if (historyLength > 0) {
			// ② 历史有，但组装后为 0 ⇒ 被过滤/裁剪 ✗
			deps.logService.warn(
				`[AgentChatService][PriorDiag] ⚠ 历史共 ${historyLength} 条却组装出 **0** 条 prior ⇒ ` +
				`历史被**过滤/裁剪光**（压缩边界 sliceAtCompactionBoundary / 污染过滤 / 配对过滤 ✗）。key=${key} ` +
				`disk(snapshot=${snapshotCount}, logLines=${logLines}) ⇒ 请查本 turn 之前是否插入了 ` +
				`metadata.type='compaction' 的边界消息 ✗`,
			);
			return;
		}
		if (diskHasContent) {
			// ③ 桶空但盘上有 ⇒ key 不匹配 ✗✗（最严重）
			deps.logService.warn(
				`[AgentChatService][PriorDiag] ⚠⚠ **疑似 session key 不匹配**：本次 key=${key} 的历史为 0，` +
				`但盘上有内容（snapshot=${snapshotCount} 条, logLines=${logLines} 行）⇒ 模型将失去全部上下文 ✗✗。` +
				`请核对 sendMessage 的 agentSessionId 来源（pane 的 _currentSessionId / 任务执行的 session ✗）`,
			);
			return;
		}
		// ① 真空 ⇒ 正常 ✓（但仍记录，便于对照 ✓）
		deps.logService.info(
			`[AgentChatService][PriorDiag] priorMessages 为空且盘上也为空（snapshot=${snapshotCount}, logLines=${logLines}）` +
			` ⇒ 本会话确实还没有历史 ✓ key=${key}`,
		);
	} catch (err) {
		deps.logService.warn(`[AgentChatService][PriorDiag] 取证失败（不影响发送 ✓）：${err instanceof Error ? err.message : err}`);
	}
}

/**
 * 上下文维护：**失忆取证** + **手动压缩命令**（从 `agentChatService.ts` 原样搬出 ✓，2026-09-22 阶段④-d ✓）。
 *
 * 两件事同属"模型视野（context）"的运维面 ✓：
 *  · `diagnoseEmptyPriorMessages` —— `priorMessages` 为 0 时把**三种成因分开** ✗✓；
 *  · `handleCompactSlashCommand` —— `/compact [focus]` / `/compact-reset` **不产生 turn、不进 LLM 主链路** ✓。
 *
 * ⚠ 两条口径必须保持 ✗✓：
 *  ① 手动压缩与自动压缩走**同一条管线**（`compactMessagesForSession` ✓，只是 `force=true` 跳过触发门槛 ✓）
 *     ⇒ 要点守卫 / 饥饿守卫 / 窗口收缩守卫**全部照常生效** ✓；**摘要不合格就不落盘** ✓（不合格产物不落地 ✓）。
 *  ② 边界插在「原始历史倒数 `tailCount` 条之前」✓ ⇒ 回放时 boundary+tail 恰是模型视野 ✓；
 *     `/compact-reset` 只是**移除边界消息** ✓ —— 磁盘历史从未被删除（边界只是"模型视野"的投影 ✓）。
 */
export class ContextMaintenance {
	constructor(private readonly deps: IContextMaintenanceDeps) { }

	/**
 * ★★★ 2026-09-21：`priorMessages` 为空时的**决定性取证** ✓（三种成因必须分开 ✗✓）。
 *
 * 背景（用户实测：「切换模型后 LLM 对上下文一无所知」✓）：`priorMessages` 是模型能看到
 * 的全部历史 ✗ —— 它为 0 时模型只剩当前 user 消息 ✓，但既有日志只有一行 `priorMsgs=0` ✗，
 * **无法区分**下面三种成因，导致排查只能猜 ✗：
 *   ① `history.length === 0` 且盘上也空 ⇒ 本会话确实还没有历史（正常 ✓）；
 *   ② `history.length > 0` 但 prior 为 0 ⇒ 历史**被过滤/裁剪光了** ✗（压缩边界 `sliceAtCompactionBoundary`
 *      或污染过滤 `_isContaminated` ⇒ 前者通常是主因）；
 *   ③ `history.length === 0` 但**盘上有内容**（快照或日志非空）⇒ **key 不匹配** ✗✗
 *      —— 本次用的 `agentSessionId` 取到的桶是空的，而真实历史挂在别的 session 上 ✗
 *      （这正是"UI 里明明有对话、模型却失忆"的最可能形态 ✓）。
 *
 * 只在**为空**时调用（低频 ✓）+ 内部全 try/catch ✓ ⇒ 绝不影响发送主路径 ✓。
 */
async diagnoseEmptyPriorMessages(
	agentId: string,
	sessionId: string | undefined,
	historyLength: number,
	currentMessage?: string,
): Promise<void> {
	return diagnoseEmptyPriorMessagesImpl({
		logService: this.deps.logService,
		fileService: this.deps.fileService,
		resolveAgentPaths: a => this.deps.paths.resolveAgentPaths(a),
		sessionFileUri: (dir, sid) => this.deps.paths.sessionFileUri(dir, sid),
		sessionLogUri: (dir, sid) => this.deps.paths.sessionLogUri(dir, sid),
		cacheKey: (a, sid) => this.deps.paths.cacheKey(a, sid),
	}, agentId, sessionId, historyLength, currentMessage);
}

	/**
 * `/compact [focus]` / `/compact-reset`（2026-09-22，对齐 OpenClaw 手动压缩入口）。
 *
 * 背景：此前压缩只能被动等自动阈值触发，用户无法主动介入，也无法撤销一条
 * "坏但合法"的边界（§46/事故①②）。两个命令都**不产生 turn、不进 LLM 主链路**；
 * 结果消息直接落盘进会话文件（作为操作记录留在 transcript 里）。
 *
 * - `/compact [focus]`：以"模型当前视野"（可信边界切片后）为输入，走与自动压缩
 *   完全相同的管线（force=true 跳过触发门槛，要点守卫/饥饿守卫/窗口收缩守卫
 *   全部照常生效 ✓）；摘要不合格 ⇒ 不落盘（OpenClaw：不合格产物不落地 ✓）。
 *   边界插入位置 = 原始历史倒数 `tailCount` 条之前 ⇒ 回放时 boundary+tail
 *   恰是模型视野 ✓。
 * - `/compact-reset`：移除本会话全部压缩边界 ⇒ 下一条消息起模型重新看到完整
 *   历史（若超阈值，下一轮会走带全套守卫的自动压缩 ✓）。
 */
async handleCompactSlashCommand(
	agentId: string,
	command: 'compact' | 'compact-reset',
	focus: string,
	options: IChatSendOptions,
): Promise<ChatMessage> {
	const sessionId = options.agentSessionId;
	const makeReply = (content: string): ChatMessage => ({
		id: `msg_compact_cmd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
		role: 'assistant',
		content,
		agentId,
		agentSessionId: sessionId,
		timestamp: new Date().toISOString(),
	} as ChatMessage);
	const replyAndPersist = async (content: string, base: ChatMessage[]): Promise<ChatMessage> => {
		const msg = makeReply(content);
		const next = [...base, msg];
		await this.deps.persistToSessionFile(agentId, sessionId, next).catch(() => { });
		this.deps.setCachedMessages(this.deps.paths.cacheKey(agentId, sessionId), next);
		return msg;
	};

	if (!sessionId) {
		return makeReply('`/compact` 需要在已存在的会话中使用（当前消息没有会话上下文）。');
	}
	const raw = await this.deps.loadFromSessionFile(agentId, sessionId);
	if (raw.length === 0) {
		return makeReply('当前会话还没有历史消息，无需压缩。');
	}

	if (command === 'compact-reset') {
		const kept = raw.filter(m => m?.metadata?.type !== COMPACTION_METADATA_TYPE);
		const removed = raw.length - kept.length;
		if (removed === 0) {
			return makeReply('本会话没有压缩边界，无需重置。');
		}
		this.deps.logService.info(
			`[AgentChatService] /compact-reset: removed ${removed} compaction boundary(ies) ` +
			`from ${agentId}::${sessionId} (${raw.length}→${kept.length} msgs)`
		);
		return replyAndPersist(
			`已移除 ${removed} 条压缩边界 ✓ —— 下一条消息起，模型将重新看到完整历史（${kept.length} 条）。\n\n` +
			`注意：若历史超过当前模型的压缩阈值，下一轮仍会触发自动压缩（走完整守卫链 ✓）。`,
			kept
		);
	}

	// ── /compact [focus] ────────────────────────────────────────────────
	const visible = sliceAtCompactionBoundary(raw);
	if (visible.length < 4) {
		return makeReply(`当前模型可见消息仅 ${visible.length} 条，没什么可压缩的。`);
	}
	const result = await this.deps.compactMessages!({
		agentId,
		messages: visible,
		focus: focus || undefined,
	});
	if (!result.didCompact) {
		return makeReply(
			`未执行压缩：${result.skipReason ?? '压缩器判定无需压缩'}。\n\n` +
			`（手动 /compact 仍受要点守卫与信息量守卫保护 —— 摘要不合格时不会落盘 ✓）`
		);
	}
	const boundary = this.deps.buildCompactionBoundaryMessage(agentId, sessionId, {
		originalCount: result.originalCount,
		compressedCount: result.compressedCount,
		tokensSaved: result.tokensSaved,
		summary: result.summary,
		summaryChars: result.summaryChars,
	}, undefined);
	const insertAt = Math.max(0, raw.length - result.tailCount);
	const withBoundary = [...raw.slice(0, insertAt), boundary, ...raw.slice(insertAt)];
	this.deps.logService.info(
		`[AgentChatService] /compact: boundary at ${insertAt}/${withBoundary.length} ` +
		`(${result.originalCount}→${result.compressedCount}, saved=${result.tokensSaved}tok, ` +
		`summaryChars=${result.summaryChars}, focus=${focus ? 'yes' : 'no'})`
	);
	const focusNote = focus ? `\n\n压缩重点：${focus.slice(0, 200)}` : '';
	return replyAndPersist(
		`已手动压缩本会话 ✓ —— ${result.originalCount} 条消息压缩为摘要（${result.summaryChars} 字符），` +
		`保留最近 ${result.tailCount} 条原文，预计节省约 ${result.tokensSaved} tokens。${focusNote}\n\n` +
		`想撤销可用 \`/compact-reset\`（磁盘历史从未被删除，边界只是"模型视野"的投影 ✓）。`,
		withBoundary
	);
}

/**
 * 回复交付后的**推迟压缩**（2026-09-22，缺点③：摘要移出主链路关键路径）。
 *
 * 非高压压缩在 executor preflight 被 `deferred_post_turn` 跳过（本轮请求装得下，
 * 同步压缩只是为下轮保洁）⇒ 在这里补做：force=false 走**正常门槛**（它只是替
 * turn 内"该压没压"补上，不该在低于阈值时硬压 ✗）。
 * 由 chatService 在收尾处 fire-and-forget 调用（不阻塞 sendMessage 返回 ✓）。
 *
 * 竞态防护：摘要要跑数秒，期间若有新消息落盘（下一轮开始/并行写入），基于旧
 * 快照的插入点已失效 ⇒ 在**会话写锁内重读**并校验尾部未变才落盘；变了就放弃
 * （摘要丢弃无妨——下一轮 preflight 会基于新历史重新判定 ✓）。
 * 失败自愈：竞态/无效摘要 ⇒ 不写边界 ⇒ 最坏回到高压同步压缩（与推迟前一致）✓。
 */
async runDeferredCompaction(agentId: string, sessionId: string | undefined): Promise<void> {
	if (!sessionId) { return; }
	try {
		const raw = await this.deps.loadFromSessionFile(agentId, sessionId);
		if (raw.length < 4) { return; }
		const visible = sliceAtCompactionBoundary(raw);
		if (visible.length < 4) { return; }
		const lastId = raw[raw.length - 1]?.id;
		const result = await this.deps.compactMessages!({
			agentId,
			messages: visible,
			force: false,
		});
		if (!result.didCompact) {
			this.deps.logService.info(
				`[ContextMaintenance] deferred compaction ${agentId}::${sessionId}: skipped (${result.skipReason ?? 'no-op'})`
			);
			return;
		}
		const boundary = this.deps.buildCompactionBoundaryMessage(agentId, sessionId, {
			originalCount: result.originalCount,
			compressedCount: result.compressedCount,
			tokensSaved: result.tokensSaved,
			summary: result.summary,
			summaryChars: result.summaryChars,
		}, undefined);
		const key = this.deps.paths.cacheKey(agentId, sessionId);
		const wrote = await this.deps.withSessionLogLock(key, async () => {
			const fresh = await this.deps.loadFromSessionFile(agentId, sessionId);
			if (fresh.length !== raw.length || fresh[fresh.length - 1]?.id !== lastId) {
				this.deps.logService.warn(
					`[ContextMaintenance] deferred compaction write skipped (raced): ${agentId}::${sessionId} ` +
					`tail changed during summarization (${raw.length}→${fresh.length} msgs)`
				);
				return false;
			}
			const insertAt = Math.max(0, fresh.length - result.tailCount);
			const next = [...fresh.slice(0, insertAt), boundary, ...fresh.slice(insertAt)];
			const paths = await this.deps.paths.resolveAgentPaths(agentId);
			await this.deps.writeSessionSnapshotLocked(agentId, sessionId, paths.sessionsDirUri, next);
			this.deps.setCachedMessages(key, next);
			return true;
		});
		this.deps.logService.info(
			`[ContextMaintenance] deferred compaction ${agentId}::${sessionId}: ` +
			(wrote
				? `boundary written (${result.originalCount}→${result.compressedCount}, saved=${result.tokensSaved}tok)`
				: 'skipped (raced)')
		);
	} catch (err) {
		this.deps.logService.warn(
			`[ContextMaintenance] deferred compaction failed (下轮 preflight 重判，自愈 ✓): ` +
			`${err instanceof Error ? err.message : err}`
		);
	}
}
}
