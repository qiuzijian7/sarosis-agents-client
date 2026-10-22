/*---------------------------------------------------------------------------------------------
 *  dsh 会话索引（读 `<dshHome>/storages/session_projcache/sessions/*.json`）—— 纯逻辑
 *
 *  为什么需要（2026-10-19 用户报「新增的聊天框会话，在左侧会话历史中，没有实时同步更新」）：
 *  dsh 引擎下聊天**在 dsh 侧**开会话，而左侧「历史会话」侧栏读的是 IDE 自己的
 *  `chat-history/<agent>/sessions.json` 索引 —— 后者只有在 IDE 自己 `createAgentSession()` 时才写
 *  ⇒ **两套数据源互不相通**：dsh 里新建的会话永远不会出现在侧栏（截图："No sessions found"）。
 *
 *  本模块只做**解析**（不碰 fs / IPC），由主进程读文件后喂进来 ⇒ 坏数据/字段缺失都能单测钉住。
 *
 *  ⚠ 格式（本机实测，2026-10-19）：
 *    { version, record: { identity: { createdAt, cwd, … },
 *                         rows: { title: {ver,seq,val}, agentPreset: {…,val},
 *                                 sessionStats: {…,val:{turns,steps,…}},
 *                                 sessionListMetadata: {…,val:{blank,lastPromptAt}},
 *                                 workingDirectory: {…,val} } } }
 *    · 投影行一律 `{ver, seq, val}` 包装 —— **别把 seq 当时间**（它是事件序号，不是时间戳 ✗）
 *    · 最后活动时间优先 `sessionListMetadata.val.lastPromptAt`，回退 `identity.createdAt`
 *--------------------------------------------------------------------------------------------*/

/** 侧栏要的那几条事实（与 `AgentSessionMeta` 对齐到能直接渲染）。 */
export interface IDshSessionSummary {
	/** dsh 会话 id = 文件名（去 `.json`）。 */
	readonly id: string;
	readonly title: string;
	readonly cwd: string;
	readonly agentPreset?: string;
	/** 最后活动时间（epoch ms）。 */
	readonly updatedAt: number;
	/** `sessionStats.turns`（拿不到就是 undefined —— 不编 0）。 */
	readonly turns?: number;
	/**
	 * `sessionListMetadata.blank`：折叠前缀里**没有任何回合**（用户还没发过消息）。
	 * 2026-10-19 补：新开聊天页签时据此**复用**空白会话（对齐 dsh 官方 `session.create` 的复用语义），
	 * 否则每开一个页签就永久多一条空白会话。
	 */
	readonly blank?: boolean;
}

/** 投影行 `{ver,seq,val}` 取 `val`；形状不对 ⇒ undefined（不猜）。 */
function valOf(row: unknown): unknown {
	if (row && typeof row === 'object' && 'val' in (row as Record<string, unknown>)) {
		return (row as Record<string, unknown>).val;
	}
	return undefined;
}

function nonEmptyString(v: unknown): string | undefined {
	return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
}

function finiteNumber(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * 解析一个 projcache 文件。
 *
 * @param id  文件名（**含** `.json` 或不含都可 —— 这里统一剥掉后缀）
 * @param text 文件内容
 * @returns 坏 JSON / 没有 record / 连 cwd 都读不到 ⇒ `undefined`（坏文件只丢自己 ✓）
 */
export function parseDshSessionRecord(id: string, text: string): IDshSessionSummary | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined; // 半截文件（正在写）也会走到这里 —— 下一轮再读即可
	}
	const rec = (parsed as { record?: unknown } | null)?.record;
	if (!rec || typeof rec !== 'object') {
		return undefined;
	}
	const identity = (rec as { identity?: unknown }).identity;
	const rows = (rec as { rows?: unknown }).rows;
	if (!rows || typeof rows !== 'object') {
		return undefined;
	}
	const rowBag = rows as Record<string, unknown>;

	const cwd = nonEmptyString((identity as { cwd?: unknown } | undefined)?.cwd)
		?? nonEmptyString(valOf(rowBag.workingDirectory));
	// ⚠ cwd 是分组判据；没有它就落不了分组 ⇒ 丢弃（宁可不显示，也不塞进"未分组"制造假事实）
	if (!cwd) {
		return undefined;
	}

	const createdAt = finiteNumber((identity as { createdAt?: unknown } | undefined)?.createdAt);
	const listMeta = valOf(rowBag.sessionListMetadata) as { lastPromptAt?: unknown; blank?: unknown } | undefined;
	const lastPromptAt = finiteNumber(listMeta?.lastPromptAt);
	// ★ 2026-10-19（对齐 dsh 官方）：`blank` = 折叠前缀里**没有回合**（官方 schema 原文），
	//   dsh 的 `session.create({sessionId})` 就是拿它做"复用空白会话"的判据 ⇒ 我们也得读出来。
	const blank = typeof listMeta?.blank === 'boolean' ? listMeta.blank : undefined;
	const turns = finiteNumber((valOf(rowBag.sessionStats) as { turns?: unknown } | undefined)?.turns);

	const sessionId = id.replace(/\.json$/i, '');
	return {
		id: sessionId,
		title: nonEmptyString(valOf(rowBag.title)) ?? '',
		cwd,
		...(nonEmptyString(valOf(rowBag.agentPreset)) ? { agentPreset: nonEmptyString(valOf(rowBag.agentPreset))! } : {}),
		// 时间：优先"最近一次提示"，回退创建时间；两者都没有 ⇒ 0（排序时沉底，不伪造 now ✗）
		updatedAt: lastPromptAt ?? createdAt ?? 0,
		...(turns !== undefined ? { turns } : {}),
		...(blank !== undefined ? { blank } : {}),
	};
}

/**
 * 把一批文件内容解析成摘要列表（**按 updatedAt 降序**，同一时间按 id 稳定排序）。
 *
 * @param entries `{ id, text }` —— 由调用方读盘后给（本函数不碰 fs，便于单测）
 */
export function buildDshSessionList(entries: readonly { readonly id: string; readonly text: string }[]): IDshSessionSummary[] {
	const out: IDshSessionSummary[] = [];
	for (const e of entries) {
		const s = parseDshSessionRecord(e.id, e.text);
		if (s) {
			out.push(s);
		}
	}
	out.sort((a, b) => (b.updatedAt - a.updatedAt) || a.id.localeCompare(b.id));
	return out;
}
