// @vssaros/dsh-agents — core/live（纯函数，零 I/O、零 dsh 依赖）。
//
// 把 dsh 的会话投影缓存（projcache）折成"每个 agent 的实况"：
//   一条缓存记录 → 瘦会话行（sessionRowOf）→ 按 preset 聚合（aggregateByPreset）→ 接到 agent 上（liveForAgents）。
//
// 连接键是 **presetIdOf(agent.id)**：会话记录的是 preset（`rows.agentPreset.val`，如 `vssaros-standard` /
// `vssaros-ppt-slides-master`），不是 agent id——身份（preset）首回合锁定，所以缓存里的值就是归属。
//
// 防御口径（与 store.js 的 scanAgents 一致）：行缺 / val 为 null ⇒ 按"没有"计；record 畸形 ⇒ 返回 error，
// 绝不抛——缓存是 dsh 的可选物，坏一个文件不许拖垮整页。

import { presetIdOf } from './agents.js';

/** token 合计：输入 + 输出 + 读缓存 + 写缓存，四桶全算（读缓存也真实占过窗口）。非数/负数按 0。 */
export function tokenTotal(totals) {
	const t = totals && typeof totals === 'object' ? totals : {};
	const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
	return n(t.uncachedInputTokens) + n(t.outputTokens) + n(t.cacheReadTokens) + n(t.cacheWriteTokens);
}

/** 取一行投影的 val；行缺或 val 为 null/undefined ⇒ null。 */
const rowVal = (record, key) => {
	const row = record?.rows?.[key];
	return row && typeof row === 'object' ? (row.val ?? null) : null;
};

/**
 * 一条 projcache 记录 → 瘦会话行。
 * @param record 解析后的 JSON（期望 `{ record: { identity, rows } }`）
 * @param id 会话 id（= 文件名去掉 .json）
 * @param mtimeMs 缓存文件的 mtime——projcache 自己不记"最后活动"时间戳 ⇒ 如实用它（缓存落盘 ≈ 会话有动静）
 */
export function sessionRowOf(record, id, mtimeMs) {
	const rec = record && typeof record === 'object' ? record.record : undefined;
	if (!rec || typeof rec !== 'object') {
		return { error: `记录缺 record 段：${id}` };
	}
	const preset = rowVal(rec, 'agentPreset');
	const title = rowVal(rec, 'title');
	const tokenVal = rowVal(rec, 'tokenUsage');
	const statsVal = rowVal(rec, 'sessionStats');
	const personaVal = rowVal(rec, 'vssaros-persona');
	// 用量页要的两行（2026-10-13，P5）：模型选取（`lastUsed` 可能是 null ⇒ 如实 null）与
	// 最后一条用户输入的时间戳（`lastPromptAt`，比文件 mtime 更接近"最后活跃"的语义 ⇒ 优先）。
	const modelSel = rowVal(rec, 'modelSelection');
	const modelRef = modelSel?.lastUsed && typeof modelSel.lastUsed === 'object'
		&& typeof modelSel.lastUsed.provider === 'string' && typeof modelSel.lastUsed.model === 'string'
		? `${modelSel.lastUsed.provider}/${modelSel.lastUsed.model}` : null;
	const meta = rowVal(rec, 'sessionListMetadata');
	const lastPromptAt = Number.isFinite(meta?.lastPromptAt) ? meta.lastPromptAt : null;
	return {
		row: {
			id,
			presetId: typeof preset === 'string' && preset !== '' ? preset : null,
			title: typeof title === 'string' && title !== '' ? title : null,
			personaId: personaVal && typeof personaVal.personaId === 'string' ? personaVal.personaId : null,
			model: modelRef,
			tokens: tokenTotal(tokenVal?.totals),
			turns: Number.isFinite(statsVal?.turns) ? statsVal.turns : 0,
			lastActiveAt: lastPromptAt ?? (Number.isFinite(mtimeMs) ? mtimeMs : null),
		},
	};
}

/**
 * 瘦会话行 → `Map<presetId, 聚合>`。
 * presetId 为 null 的行进 `(none)` 桶——如实单列，不猜归属（旧会话/无 preset 的会话客观存在）。
 * `lastTitle` 跟随 `lastActiveAt` 最大的那一行（两者必须同源，否则"最近活跃"和"标题"会各说各话）。
 */
export function aggregateByPreset(rows) {
	const byPreset = new Map();
	for (const row of rows ?? []) {
		if (!row || typeof row !== 'object') {
			continue;
		}
		const key = row.presetId || '(none)';
		const cur = byPreset.get(key) ?? { presetId: key, sessions: 0, tokens: 0, turns: 0, lastActiveAt: null, lastTitle: null };
		cur.sessions += 1;
		cur.tokens += row.tokens ?? 0;
		cur.turns += row.turns ?? 0;
		if (row.lastActiveAt != null && (cur.lastActiveAt == null || row.lastActiveAt > cur.lastActiveAt)) {
			cur.lastActiveAt = row.lastActiveAt;
			cur.lastTitle = row.title ?? null;
		}
		byPreset.set(key, cur);
	}
	return byPreset;
}

/**
 * agents × 聚合表 → 每个 agent 一行实况，与 agents 同序。
 * 无会话的 agent 也给零值行（页面/探针按 agent 对齐，不缺席）。
 * 附带 `unmatched`：有会话但对应不到任何现存 agent 的 preset 名单（如源文件已删的 `vssaros-*`、
 * 官方 `standard`/`(none)` 不算——它们本来就不是某个 agent）。
 */
export function liveForAgents(agents, byPreset) {
	const used = new Set();
	const rows = (agents ?? []).map(agent => {
		const presetId = presetIdOf(agent.id);
		const cur = byPreset?.get(presetId);
		if (cur) {
			used.add(presetId);
		}
		return {
			agentId: agent.id,
			presetId,
			sessions: cur?.sessions ?? 0,
			tokens: cur?.tokens ?? 0,
			turns: cur?.turns ?? 0,
			lastActiveAt: cur?.lastActiveAt ?? null,
			lastTitle: cur?.lastTitle ?? null,
		};
	});
	const known = new Set((agents ?? []).map(a => presetIdOf(a.id)));
	const unmatched = [...(byPreset?.keys() ?? [])]
		.filter(key => key !== '(none)' && key.startsWith('vssaros-') && !known.has(key))
		.sort();
	return { rows, unmatched };
}

/**
 * 用量聚合（P5）：agents × 瘦会话行 → 每个 agent 的用量（会话数/token/回合/最近活跃/按模型拆分），
 * 外加 `unknown`（preset 不在名册的会话：官方 standard/(none)/已删 agent 的残留）与 `totals`。
 * 无会话的 agent 也给零值行（页面对齐用，不缺席）。
 */
export function usageByAgent(agents, rows) {
	const known = new Map((agents ?? []).map(a => [presetIdOf(a.id), a.id]));
	const perAgent = new Map();
	const zero = agentId => ({ agentId, presetId: presetIdOf(agentId), sessions: 0, tokens: 0, turns: 0, lastActiveAt: null, models: [] });
	const unknown = { sessions: 0, tokens: 0, turns: 0 };
	const totals = { sessions: 0, tokens: 0, turns: 0 };
	for (const row of rows ?? []) {
		if (!row || typeof row !== 'object') {
			continue;
		}
		totals.sessions += 1;
		totals.tokens += row.tokens ?? 0;
		totals.turns += row.turns ?? 0;
		const agentId = known.get(row.presetId);
		if (!agentId) {
			unknown.sessions += 1;
			unknown.tokens += row.tokens ?? 0;
			unknown.turns += row.turns ?? 0;
			continue;
		}
		const bucket = perAgent.get(agentId) ?? zero(agentId);
		perAgent.set(agentId, bucket);
		bucket.sessions += 1;
		bucket.tokens += row.tokens ?? 0;
		bucket.turns += row.turns ?? 0;
		if (row.lastActiveAt != null && (bucket.lastActiveAt == null || row.lastActiveAt > bucket.lastActiveAt)) {
			bucket.lastActiveAt = row.lastActiveAt;
		}
		if (row.model) {
			const m = bucket.models.find(entry => entry.ref === row.model);
			if (m) {
				m.sessions += 1;
				m.tokens += row.tokens ?? 0;
			} else {
				bucket.models.push({ ref: row.model, sessions: 1, tokens: row.tokens ?? 0 });
			}
		}
	}
	for (const bucket of perAgent.values()) {
		bucket.models.sort((a, b) => b.tokens - a.tokens);
	}
	return { agents: (agents ?? []).map(a => perAgent.get(a.id) ?? zero(a.id)), unknown, totals };
}
