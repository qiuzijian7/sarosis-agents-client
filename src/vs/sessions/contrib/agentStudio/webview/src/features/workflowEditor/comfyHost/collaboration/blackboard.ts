/**
 * 共享黑板 —— 多 agent 的**共享工作记忆**（命名空间 KV + 摘要注入）。
 *
 * ## 问题（本项目现状）
 *
 * 画布上每个 agent 节点是独立子代理，彼此只通过「上游快照 → prompt」单向传递
 * （`workflowChildPort.ts` 只传 prompt）。没有跨 agent 共享内存：A 发现的结论 B
 * 无从知晓，除非在图上显式连线——而连线是**设计期**决定的，运行期发现的中间
 * 结论无处安放。
 *
 * ## 设计（来源：open-multi-agent `memory/shared.ts` + Swarm blackboard）
 *
 * 1. **命名空间**：写入键为 `<agent>/<key>`，读支持全限定键跨 agent 读取；
 * 2. **摘要注入而非全量**：`getSummary()` 产出 markdown 摘要、按 agent 分组、
 *    **每个值截断**（默认 200 字符）——全量注入会重演「全量历史捆绑」的上下文爆炸；
 * 3. **TTL 只过滤不删除**：过期项读取时跳过但保留在存储里，避免与并发写竞争
 *    （删除会丢失「曾经写过什么」的审计线索）；
 * 4. **保留前缀不可见**：`__` 开头的键不参与摘要（内部协调数据，如检查点）。
 *
 * 回合（turn）语义：调用方每完成一个任务调 `advanceTurn()`，TTL 以回合计而非
 * 墙钟时间——这样「3 回合后过期」在任意执行速度下语义一致。
 */

export interface BlackboardEntry {
	key: string;
	value: string;
	/** 写入者（agentId）。 */
	agent?: string;
	/** 写入时的回合号。 */
	turn: number;
	/** 过期回合（含）；undefined = 永不过期。 */
	expiresAtTurn?: number;
	metadata?: Record<string, unknown>;
}

export interface BlackboardWriteOptions {
	/** 存活回合数（相对当前回合）。 */
	ttlTurns?: number;
	metadata?: Record<string, unknown>;
}

export interface BlackboardSummaryFilter {
	/** 只取该 agent 命名空间。 */
	agent?: string;
	/** 只取 `task:<id>:result` 形式的键。 */
	taskId?: string;
}

export interface Blackboard {
	write(agent: string, key: string, value: string, opts?: BlackboardWriteOptions): BlackboardEntry;
	/** 精确读（需全限定或已带命名空间的键）。 */
	read(key: string): BlackboardEntry | undefined;
	/** 列举（可按 agent 前缀过滤），自动跳过已过期项。 */
	list(filter?: { agent?: string }): BlackboardEntry[];
	/** markdown 摘要：按 agent 分组、每值截断（注入下游用）。 */
	getSummary(filter?: BlackboardSummaryFilter): string;
	/** 回合推进（TTL 基准）。 */
	advanceTurn(): void;
	readonly turn: number;
	/** 持久化快照 / 恢复（跨会话或检查点用）。 */
	snapshot(): BlackboardEntry[];
	restore(entries: readonly BlackboardEntry[]): void;
	clear(): void;
}

/** 保留前缀：内部协调数据，不进摘要。 */
const RESERVED_PREFIX = '__';

export function createBlackboard(opts: { summaryValueChars?: number } = {}): Blackboard {
	const maxChars = Math.max(16, opts.summaryValueChars ?? 200);
	const store = new Map<string, BlackboardEntry>();
	let turn = 0;

	const qualified = (agent: string, key: string): string => `${agent}/${key}`;

	const isExpired = (e: BlackboardEntry): boolean =>
		e.expiresAtTurn !== undefined && turn > e.expiresAtTurn;

	const board: Blackboard = {
		write(agent, key, value, writeOpts) {
			const full = qualified(agent, key);
			const entry: BlackboardEntry = {
				key: full,
				value,
				agent,
				turn,
				...(writeOpts?.ttlTurns !== undefined ? { expiresAtTurn: turn + Math.max(0, writeOpts.ttlTurns) } : {}),
				...(writeOpts?.metadata ? { metadata: writeOpts.metadata } : {}),
			};
			store.set(full, entry);
			return entry;
		},
		read: (key) => {
			const e = store.get(key);
			return e && !isExpired(e) ? e : undefined;
		},
		list(filter) {
			const out: BlackboardEntry[] = [];
			for (const e of store.values()) {
				if (isExpired(e)) { continue; }
				if (filter?.agent && !e.key.startsWith(`${filter.agent}/`)) { continue; }
				out.push(e);
			}
			return out;
		},
		getSummary(filter) {
			const groups = new Map<string, BlackboardEntry[]>();
			for (const e of store.values()) {
				if (isExpired(e)) { continue; }
				if (e.key.startsWith(RESERVED_PREFIX)) { continue; }
				const slash = e.key.indexOf('/');
				const owner = e.agent ?? (slash > 0 ? e.key.slice(0, slash) : 'shared');
				if (filter?.agent && owner !== filter.agent) { continue; }
				if (filter?.taskId && !e.key.includes(`task:${filter.taskId}:`)) { continue; }
				const list = groups.get(owner);
				if (list) { list.push(e); } else { groups.set(owner, [e]); }
			}
			if (groups.size === 0) { return ''; }
			const lines: string[] = ['## Shared blackboard'];
			for (const [owner, entries] of groups) {
				lines.push('', `### ${owner}`);
				for (const e of entries) {
					const shortKey = e.key.startsWith(`${owner}/`) ? e.key.slice(owner.length + 1) : e.key;
					const val = e.value.length > maxChars ? `${e.value.slice(0, maxChars)}…` : e.value;
					lines.push(`- **${shortKey}**: ${val.replace(/\n+/g, ' ')}`);
				}
			}
			return lines.join('\n');
		},
		advanceTurn() { turn++; },
		get turn() { return turn; },
		snapshot: () => [...store.values()].map(e => ({ ...e })),
		restore(entries) {
			for (const e of entries) { store.set(e.key, { ...e }); }
			// 回合号取恢复项最大值，保证 TTL 语义不回退
			const maxTurn = entries.reduce((m, e) => Math.max(m, e.turn, e.expiresAtTurn ?? 0), turn);
			turn = maxTurn;
		},
		clear: () => { store.clear(); },
	};
	return board;
}
