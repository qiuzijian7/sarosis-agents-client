/*---------------------------------------------------------------------------------------------
 *  Session History — 会话人格标记的纯逻辑（无 DOM / 无服务）
 *
 *  ── 背景 ────────────────────────────────────────────────────────────────────
 *  「人格」是**会话内热切换**的提示词人设（dsh 侧投影 key `vssaros-persona`，
 *  见 `dsh-plugins/vssaros-agents/lib/core/persona.js`）：切人格留在当前会话、
 *  工具/模型不变；`personaId` 实际是**另一个 agent 的 id**。
 *
 *  本模块只负责两件事：
 *   ① 把持久化的人格表**安全地**解析出来（坏值降级，绝不让侧栏整体空白）；
 *   ② 标记的显示文案与字形回退（name → id；icon → 名字首字）。
 *
 *  ⚠ 事实来源（谁写这张表）尚未接通，见 `sessionHistoryView.ts` 的 `_getPersonaMap()`。
 *--------------------------------------------------------------------------------------------*/

/**
 * 这张表的存储键（PROFILE / USER）。
 *
 * ⚠ 与 `sessionHistoryView.ts` 的 `PERSONA_KEY`（私有静态字段，读过侧 :1815）**同字面量**：
 * pane 那边是私有字段、写入方在本模块，所以这里给写入方一个**可 import 的名字**。改一处必须改另一处。
 */
export const PERSONA_STORAGE_KEY = 'sessionHistoryView.personaBySession';

/** 一条人格事实。 */
export interface IPersonaFact {
	/** `personaId`（= 提供人设的那个 agent 的 id）。 */
	readonly id: string;
	/** 展示名（取自该 agent 的显示名）；缺失时调用方回退到 id。 */
	readonly name?: string;
}

/** 人格表的存储 key 语义：`agentId::sessionId`（与 `_sessionKey` 同形）。 */
export type PersonaSessionKey = string;

/**
 * 解析持久化的人格表：`{ "agentId::sessionId": { id, name } }`。
 *
 * 容错纪律（与 `parseStringArray` 一致并已单测）：坏 JSON、数组、缺 `id` 的条目、
 * 非字符串键值一律**丢弃该条**而不整体抛错 —— 一个坏条目不能让整个侧栏空白 ✗。
 */
export function parsePersonaMap(raw: string | undefined): ReadonlyMap<PersonaSessionKey, IPersonaFact> {
	const map = new Map<PersonaSessionKey, IPersonaFact>();
	if (!raw) { return map; }
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return map;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { return map; }

	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!key) { continue; }
		if (!value || typeof value !== 'object' || Array.isArray(value)) { continue; }
		const candidate = value as { id?: unknown; name?: unknown };
		if (typeof candidate.id !== 'string' || !candidate.id) { continue; }
		map.set(key, {
			id: candidate.id,
			name: typeof candidate.name === 'string' && candidate.name ? candidate.name : undefined,
		});
	}
	return map;
}

/** 人格表的键：`agentId::sessionId`（与 `sessionHistoryView._sessionKey` 同形）。 */
export function personaSessionKey(agentId: string, sessionId: string): PersonaSessionKey {
	return `${agentId}::${sessionId}`;
}

/**
 * 写入一条人格事实（**纯函数**：进出都是 JSON 文本 ⇒ 可单测，写入方不必懂格式）。
 *
 * `fact === undefined` ⇒ **删掉该条**（= 跟随 Agent 自带人设 —— 这是挂载期的事实，不是"未知"）。
 * 返回新的 JSON 文本（调用方负责落存储）；空表返回 `'{}'`，读侧解析成空表 ✓。
 *
 * ⚠ 读出→写回会**顺手清掉**表里本来就解析不出来的条目（`parsePersonaMap` 的容错口径使然）。
 * 这是刻意保留的自愈：那张表是**派生缓存**，任何条目都能由 dsh 侧再报一次，
 * 留着读不出来的条目只会让"谁写坏了"永远查不清楚。
 */
export function writePersonaFact(raw: string | undefined, key: PersonaSessionKey, fact: IPersonaFact | undefined): string {
	const map = new Map(parsePersonaMap(raw));
	if (key) {
		if (fact && fact.id) {
			map.set(key, fact.name ? { id: fact.id, name: fact.name } : { id: fact.id });
		} else {
			map.delete(key);
		}
	}
	return JSON.stringify(Object.fromEntries(map));
}

/** 人格的显示名：`name` → `id`（都没有 ⇒ 空串，调用方据此不渲染标记）。 */
export function personaLabelOf(fact: IPersonaFact | undefined): string {
	if (!fact) { return ''; }
	const name = (fact.name ?? '').trim();
	return name || fact.id;
}

/**
 * 人格 chip 的字形（**不是圆形头像**，只是 chip 里的一个字符）：
 * `Agent.icon`（emoji）→ 名字首字 → `'?'`。
 *
 * 用 `Array.from` 取首字是为了兼容非 BMP 字符（emoji / 生僻字），
 * 直接 `label[0]` 会把一个 emoji 拆成半个代理对 ✗。
 */
export function personaGlyphOf(label: string, icon?: string): string {
	const emoji = (icon ?? '').trim();
	if (emoji) { return emoji; }
	return Array.from(label.trim())[0] ?? '?';
}
