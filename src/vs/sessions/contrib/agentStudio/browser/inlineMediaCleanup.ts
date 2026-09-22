/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ChatMessage } from '../common/types.js';

/** 宿主注入面（文件系统 / 日志 / 路径学 ✓ —— 三者都归宿主 ✓）。 */
export interface IInlineMediaCleanupDeps {
	fileService: IFileService;
	logService: ILogService;
	/** chat-history 根目录（路径学归 `AgentChatPaths` ✓）。 */
	getChatHistoryRoot: () => URI;
}

/**
 * 内联超长 data URI 的**存量收敛**（从 `agentChatService.ts` 原样搬出 ✓，2026-09-22 阶段④-c ✓）。
 *
 * ## 背景（日志 1789133432350 ✗）
 * `agentDriverService` 曾把 workflow 的全部媒体快照内联成
 * `![输出 N](data:image/jpeg;base64,…)` —— 42 张 ≈ **8.4MB 单条 content** ✗：
 * 既触发过 `marked.parse` 栈溢出（已由 `agentChatPanel.markdown.ts` 分片兜底 ✓），
 * 也让**历史文件本身**每条数十 MB ✗（拖慢加载、白占磁盘 ✓）。
 *
 * 写入侧已改为「单张 ≤200KB 且总数 ≤4」✓；本模块负责**存量**：
 *  ① `scrubOversizedInlineMedia` —— 磁盘读入时扫一遍，超限大图替换为一行占位 ✓（调用方回写 ✓）；
 *  ② `runBulkCleanup` —— 一次性、延迟、幂等的**全库**清理 ✓（那些**再也不会被打开**的旧会话
 *     靠惰性清理永远收敛不了 ✗）。
 *
 * ## 不可退化约定（注释随实现搬走 ✓）
 *  · **匹配必须宽松** ✗✓：事故现场数据比标准 Markdown 更松散（`!` 曾被吃掉、`]`/`(` 间有换行 ✗），
 *    严格正则**完全匹配不到** ⇒ 图片码原样显示给用户 ✗。
 *  · **占位判定必须宽松** ✗✓：老版本用**长文案**占位，若用 `endsWith` 严格后缀匹配，
 *    它们**永远折叠不了**（正是用户第二次截图里糊在一起的三列占位 ✗）。
 *  · **折叠不能挂在 `data:` 快速路径之后** ✗✓：清理过的历史已无 `data:`，但仍需折叠
 *    （否则 63 条占位永远排成一片 ✓）。
 *  · **整条清空判据** ✓：清理后若只剩「已完成 N 个输出」这类状态文案 ⇒ 整条清空
 *    （`getHistory` 会丢空消息 ✓；工作流卡片在**另一条**消息里，不受影响 ✓）。
 *  · **标记文件必须带版本后缀** ✗✓：清理规则一变就得换名（否则已写过标记的机器上新规则永不执行 ✗）。
 *  · **跳过"最近修改"文件** ✗✓：mtime 在窗口内的会话可能正被活跃会话写入 ⇒
 *    「读-改-写」会打架（用户下次打开时由惰性清理兜住 ✓）。
 *  · 日志前缀**保持 `[AgentChatService]`** ✓ —— 用户/排查手册是按这个前缀 grep 的 ✗。
 */
export class InlineMediaCleanup {
	/**
	 * ★ 2026-09-12：清理时**保留**的单张 data URI 上限（字符数）。
	 *
	 * 超过此值的图片不再内联，替换为指向工作流卡片的占位。
	 *
	 * ⚠ 二次修正：原值 `200 * 1024`（与写入侧 `INLINE_MEDIA_MAX_BYTES` 对齐）**太大** ✗ ——
	 * 用户报「切换会话后仍显示图片码」，实测那段 GIF base64 只有 **~2KB** ⇒ **根本没被清理** ✗。
	 * 现降到 1KB：工作流输出的图不会这么小（卡片已完整展示 ✓），1KB 以上 base64 内联无价值 ✓。
	 * 同时**移除**了原先的 512KB 文本门槛 —— 它让「只含一小段图片码」的消息**整条被跳过** ✗
	 * （正是漏网主因 ✓）；快速路径改为 `text.includes('data:')`（微秒级 ✓）。
	 */
	static readonly KEEP_MAX_URI = 1024;
	/**
	 * ★ 2026-09-12：存量批量清理的**标记文件名**（放在 chat-history 根目录）。
	 *
	 * 一次性清理跑完后写入，之后启动直接跳过 —— 避免「无 data URI 的大文件」
	 * （如巨型 ToolResult payload ✗）每次启动都被读一遍做无谓检查 ✓。
	 * 带版本后缀：清理规则变化时换新标记名即可再跑一轮 ✓。
	 * v1 → v2：匹配规则放宽 + 保留阈值 200KB → 1KB ⇒ **必须换名** ✗✓（否则老机器上新规则永不执行 ✓）。
	 */
	static readonly MARKER = '.inline-media-cleanup-v2';
	/** 批量清理的启动延迟（ms）—— 避开首屏渲染的 I/O 高峰 ✓。 */
	static readonly DELAY_MS = 15000;
	/** 批量清理的文件大小预筛阈值（字节）—— 只有超过此值的会话文件才值得解析 ✓。 */
	static readonly MIN_FILE_BYTES = 2 * 1024 * 1024;
	/** 批量清理单次最多处理的文件数 —— 避免启动后跑成长期任务 ✓。 */
	static readonly MAX_FILES = 200;
	/**
	 * 批量清理跳过「最近修改」文件的窗口（ms）。
	 *
	 * 防竞态 ✓：mtime 在此窗口内的会话文件可能正被活跃会话写入（内存权威 → 落盘 ✓），
	 * 批量清理的「读-改-写」会与之打架 ✗。跳过它们不影响最终收敛 —— 用户下次**打开**
	 * 该会话时由惰性清理兜住 ✓。
	 */
	static readonly SKIP_RECENT_MS = 5 * 60 * 1000;

	/** 批量清理是否已调度（`ensureHistoryLoaded` 可能被并发调用 ✓）。 */
	private _scheduled = false;

	constructor(private readonly deps: IInlineMediaCleanupDeps) { }

	/**
 * ★ 2026-09-12：存量历史脏数据清理 —— 移除已落盘消息里**内联的超长 data URI**。
 *
 * **背景**（日志 1789133432350）：`agentDriverService` 曾把 workflow 的全部媒体快照
 * 内联成 `![输出 N](data:image/jpeg;base64,…)`，42 张 ≈ **8.4MB 单条 content**。
 * 这既触发过 `marked.parse` 栈溢出（已由 `agentChatPanel.markdown.ts` 的
 * `_renderMarkdownSafe` 分片兜底修复），也让**历史文件本身**巨大（每条数十 MB JSON）
 * ——拖慢加载/解析、白占磁盘。
 *
 * 写入侧已改为「单张 ≤200KB 且总数 ≤4」（`agentDriverService.ts`），不再产生新巨物；
 * 本方法负责**存量收敛**：会话文件从磁盘读入时扫一遍，把超限的大图内联替换为一行
 * 占位，随后由调用方回写落盘。
 *
 * **为何可安全替换**：这些内联 base64 是**冗余副本** —— 媒体本身已由工作流卡片的
 * snapshot 机制完整展示，移除不丢信息。
 *
 * 成本：快速路径是 `text.includes('data:')`（native 子串扫描，微秒级）——绝大多数
 * 消息不含 data: 直接跳过；清理一次后文本不再含长 URI，后续加载自然零成本。
 */
scrubOversizedInlineMedia(messages: ChatMessage[]): { replaced: number; freedBytes: number } {
	let replaced = 0;
	let freedBytes = 0;
	const scrub = (text: string): string => {
		const PH_PREFIX = '📎 ';
		// 精简文案（2026-09-12）：原「（图片已由工作流卡片展示，历史记录中不再内联）」
		// 太长 —— 63 条折叠成一行后仍然啰嗦。
		const PH_SUFFIX = '（见上方工作流卡片）';
		/**
		 * 判断某行是否为「媒体占位」。
		 *
		 * ⚠ 必须**宽松**（只认前缀 + 含「工作流卡片」），不能用 `endsWith(PH_SUFFIX)`：
		 *   老版本写进历史的占位用的是**长文案**（「图片已由工作流卡片展示，历史记录中
		 *   不再内联」），严格后缀匹配会让它们**永远折叠不了**（正是用户第二次截图里
		 *   那片糊在一起的三列占位）。
		 */
		const isPlaceholder = (line: string): boolean =>
			line.startsWith(PH_PREFIX) && line.includes('工作流卡片');

		// ① 清理内联 base64 图片。
		//
		// 快速路径：绝大多数消息不含 data:（native 子串扫描，微秒级）。
		// ⚠ 折叠（②）**不能**挂在这个快速路径后面 —— 上次清理过的历史里已经没有
		//   `data:` 了，但仍需要折叠（否则 63 条占位永远排成一片）。
		//
		// 宽松匹配（2026-09-12 二次修正）—— 事故现场的实际数据比标准 Markdown
		// 图片语法更松散，原严格正则 `/!\[([^\]]*)\]\((data:[^)\s]+)\)/` 完全匹配
		// 不到，于是图片码原样显示给用户：
		//   `[输出 32]` + 换行 + `(data:image/gif;base64,...`
		// 四处放宽：① `!` 可选（前缀曾被吃掉）；② `]` 与 `(` 之间允许空白/换行；
		// ③ `(` 与 `data:` 之间允许空白；④ URI 与 `)` 之间允许空白
		// （实测：`...base64,AAAA )` 若不放开这一处会**完全匹配不到**）。
		// alt 上限 80 字符、URI 下限 64 字符 —— 避免误伤普通文本里的 data: 提及。
		// `[^)\s]` 保证 URI 内不含空白 → `\s*` 只吃空白，无回溯风险。
		let out = text;
		if (text.includes('data:')) {
			out = text.replace(
				/!?\[([^\]]{0,80})\]\s*\(\s*(data:[^)\s]{64,})\s*\)/g,
				(whole, alt: string, uri: string) => {
					if (uri.length <= InlineMediaCleanup.KEEP_MAX_URI) { return whole; }
					replaced++;
					freedBytes += uri.length;
					return `${PH_PREFIX}${alt || '输出'}${PH_SUFFIX}`;
				},
			);
		}

		// ② 折叠：把**连续多个**占位合并为一行摘要。
		//
		// 事故现场（2026-09-12 用户截图）：一条消息里有 63 个输出 → 逐项占位会排出
		// 63 条一模一样的啰嗦文案（排成三列糊成一片），比原来的图片码还难读。
		// 这些占位在原始数据里是 `\n` 分隔（`agentDriverService` 用 join('\n')），
		// Markdown 单换行渲染成软换行 → 视觉上连排，所以按行折叠即可命中。
		//
		// 单个占位**原样保留**（保留编号，信息不丢）；连续 ≥2 个才折叠成计数摘要。
		// 折叠也 `replaced++`：让调用方知道「有改动」从而回写落盘（否则已清理过的
		// 历史永远不会被折叠、也永远不会写回）。
		if (!out.includes(PH_PREFIX)) { return out; }
		const merged: string[] = [];
		let run = 0;
		let firstLine = '';
		const flushRun = () => {
			if (run === 0) { return; }
			if (run === 1) {
				merged.push(firstLine);		// 单个：保留编号
			} else {
				merged.push(`${PH_PREFIX}${run} 个输出${PH_SUFFIX}`);
				replaced++;
			}
			run = 0;
			firstLine = '';
		};
		for (const line of out.split('\n')) {
			const t = line.trim();
			if (isPlaceholder(t)) {
				if (run === 0) { firstLine = line; }
				run++;
				continue;
			}
			flushRun();
			merged.push(line);
		}
		flushRun();

		// ③ 整条清空判据（2026-09-12，用户反馈「已完成 42 个输出」也重复）：
		//   清理/折叠后若「除媒体占位外，只剩 `已完成 N 个输出` 这类状态文案」，
		//   则整条视为**纯媒体汇报** → 清空。
		//
		//   目的：让历史里那种「已完成 42 个输出 + 63 条占位」的独立文本消息彻底消失
		//   （`getHistory` 的空消息过滤会丢弃 content 为空且无 parts 的消息）。
		//   工作流卡片在**另一条**消息里，不受影响。
		//
		//   与生成侧对齐：`agentDriverService` 现在有卡片时也不再发这段文本。
		const residue = merged
			.filter(l => !isPlaceholder(l.trim()))
			.join('\n')
			.replace(/已完成\s*\d+\s*个输出/g, '')
			.trim();
		if (residue.length === 0) {
			replaced++;		// 计入「有改动」→ 触发调用方回写落盘
			return '';
		}
		return merged.join('\n');
	};
	for (const m of messages) {
		const anyM = m as unknown as Record<string, unknown>;
		if (typeof anyM['content'] === 'string') {
			const next = scrub(anyM['content']);
			if (next !== anyM['content']) { anyM['content'] = next; }
		}
		if (Array.isArray(anyM['parts'])) {
			for (const p of anyM['parts'] as Array<Record<string, unknown>>) {
				if (typeof p?.['text'] === 'string') {
					const next = scrub(p['text']);
					if (next !== p['text']) { p['text'] = next; }
				}
			}
		}
	}
	return { replaced, freedBytes };
}

	/**
 * ★ 2026-09-12：调度**存量历史批量清理**（一次性、延迟、幂等）。
 *
 * **为何需要**：`_loadFromSessionFile` 的惰性清理只在用户**打开**某会话时生效——
 * 历史里那些**再也不会被打开**的旧会话仍占着磁盘（每条数十 MB JSON）。
 *
 * **幂等**：跑完在 chat-history 根目录写标记文件（`BULK_CLEANUP_MARKER`），之后
 * 启动直接跳过。不用「按文件大小判断」代替标记，是因为巨型 ToolResult payload
 * 这类**无 data URI 的大文件**会每次启动都被白读一遍。
 */
scheduleBulkCleanup(): void {
	if (this._scheduled) { return; }
	this._scheduled = true;
	setTimeout(() => { void this.runBulkCleanup(); }, InlineMediaCleanup.DELAY_MS);
}

/**
 * 遍历 chat-history/{agentId}/sessions/*.json，清理内联的超长 data URI。
 *
 * 三层成本控制：① 延迟 15s 执行，避开首屏 I/O；② `stat.size` 预筛（< 2MB 直接跳过，
 * 不读文件）；③ 单次处理上限（`BULK_CLEANUP_MAX_FILES`）。单文件失败不影响其余。
 */
async runBulkCleanup(): Promise<void> {
	try {
		const root = this.deps.getChatHistoryRoot();
		if (!(await this.deps.fileService.exists(root))) { return; }
		const markerUri = URI.joinPath(root, InlineMediaCleanup.MARKER);
		if (await this.deps.fileService.exists(markerUri)) { return; }	// 已跑过

		// resolveMetadata: 预筛与竞态防护依赖 size/mtime，而它们只在
		// IFileStatWithMetadata 上（裸 IFileStat 不含）。
		const rootStat = await this.deps.fileService.resolve(root, { resolveMetadata: true });
		let scanned = 0;			// 遍历到的 .json 总数
		let processed = 0;			// 实际解析过的大文件数（受上限约束）
		let cleanedFiles = 0;		// 有清理动作的文件数
		let totalReplaced = 0;
		let totalFreed = 0;

		for (const agentEntry of rootStat.children ?? []) {
			if (!agentEntry.isDirectory) { continue; }
			if (processed >= InlineMediaCleanup.MAX_FILES) { break; }
			const sessionsDir = URI.joinPath(agentEntry.resource, 'sessions');
			let dirStat;
			try {
				if (!(await this.deps.fileService.exists(sessionsDir))) { continue; }
				dirStat = await this.deps.fileService.resolve(sessionsDir, { resolveMetadata: true });
			} catch { continue; }
			for (const f of dirStat.children ?? []) {
				if (processed >= InlineMediaCleanup.MAX_FILES) { break; }
				if (f.isDirectory || !f.name.endsWith('.json')) { continue; }
				scanned++;
				// 大小预筛：stat 已带 size，避免为小文件付解析成本。
				if ((f.size ?? 0) < InlineMediaCleanup.MIN_FILE_BYTES) { continue; }
				// 竞态防护：最近修改过的文件可能正被活跃会话使用，跳过（详见常量注释）。
				if (f.mtime && Date.now() - f.mtime < InlineMediaCleanup.SKIP_RECENT_MS) { continue; }
				processed++;
				try {
					const content = await this.deps.fileService.readFile(f.resource);
					const messages = JSON.parse(content.value.toString()) as ChatMessage[];
					const scrubbed = this.scrubOversizedInlineMedia(messages);
					if (scrubbed.replaced > 0) {
						await this.deps.fileService.writeFile(
							f.resource,
							VSBuffer.fromString(JSON.stringify(messages, null, 2)),
						);
						cleanedFiles++;
						totalReplaced += scrubbed.replaced;
						totalFreed += scrubbed.freedBytes;
					}
				} catch { /* 单文件失败不影响其余 */ }
			}
		}

		if (totalReplaced > 0) {
			this.deps.logService.info(
				`[AgentChatService] Bulk inline-media cleanup: scrubbed ${totalReplaced} oversized data URI(s) ` +
				`(${(totalFreed / 1024 / 1024).toFixed(1)}MB) across ${cleanedFiles} session file(s) ` +
				`(scanned ${scanned}, parsed ${processed}).`,
			);
		} else {
			this.deps.logService.trace(
				`[AgentChatService] Bulk inline-media cleanup: scanned ${scanned}, parsed ${processed}, nothing to scrub.`,
			);
		}
		// 写标记：无论是否有清理都写，避免每次启动重扫。
		await this.deps.fileService.writeFile(markerUri, VSBuffer.fromString(new Date().toISOString()));
	} catch (err) {
		this.deps.logService.warn('[AgentChatService] Bulk inline-media cleanup failed:', err);
	}
}
}
