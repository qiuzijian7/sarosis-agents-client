// @vssaros/dsh-agents — groups（群聊，2026-10-16，二期；mockup doc/agents-groupchat-mockup.html）。
//
// ★ 承载面的关键决策（实现期发现，偏离 mockup 的右栏群会话，理由留痕）：
//   mockup 原案「群会话 = 普通 dsh 会话（standard preset）」有硬伤——用户消息进群会话 inbox 后，
//   **standard preset 自己会开回合抢答**；拦截（inbox/inserted → discard）与 loop 的 claim 是竞态，
//   不可靠 ✗。⇒ 群聊**自托管**在 agents 页「群聊」页签的对话区（编辑区），不占用任何 dsh 会话做
//   群本身；成员仍各用自己的 preset 会话干活 ✓。
//
// 机制映射（零新运行时）：
//   ① 派发 = 往成员会话 **steer** 一条带头协议的消息（admin 模式只发被 @ 的；open 模式发全员）——
//      成员没跑着会话就用 sessionController.create 现开一条（与 assignments 同一路径 ✓）；
//   ② 回复回收 = 自己的 agent/turn-stopping 监听（与 relay/assignments 同钩同判据：先验证这回合
//      真消费了那条消息 ⇒ findOurSplices，再取最终 assistant 文本 ✓）写回群的 transcript；
//   ③ 防环：v1 群消息只走"用户 → 成员 → transcript"，成员间的接力仍由 agent_message 工具自带的
//      MAX_HOPS=6 管（群里不做 agent→agent 自动接力 ✗——那是二期里的另一件事）；
//   ④ 存储 = <数据根>/agent-groups.json（定义 + transcript，同 templates 的写口判据：限尺寸读入 +
//      JSON 自校验 + 失败给可读原因 ✓）。transcript 封顶 TRANSSCRIPT_KEEP 条，超出裁最旧，
//      裁掉的事实在条目里如实标注 ✓。
// ⚠ 派发登记的真源在 **lib/outbox.js**（2026-10-16 二期起落盘，Host 重启读回 ✓；本文件曾有的
//    模块级 PENDING_DISPATCH 已撤——重启丢待回收回复的缺口由 outbox 补上 ✓）。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { presetIdOf } from './core/agents.js';
import { AGENT_MESSAGE_KIND, finalAssistantText, findOurSplices } from './core/relay.js';
import { dataRootOf, agentsRootOf, scanAgents } from './store.js';
import { outboxNote, outboxPendingFor, outboxResolve } from './outbox.js';

/** 群定义/ transcript 文件名（数据根下）。 */
const FILE_NAME = 'agent-groups.json';
/** transcript 封顶条数（超出裁最旧，裁切留痕）。 */
export const TRANSSCRIPT_KEEP = 200;
/** 群名/成员数上限（写口自卫）。 */
const MAX_GROUPS = 50;
const MAX_MEMBERS = 20;

function httpError(status, message, extra = {}) {
	return Object.assign(new Error(message), { httpStatus: status, ...extra });
}

async function readGroups(config) {
	try {
		const text = await readFile(join(dataRootOf(config), FILE_NAME), 'utf8');
		const parsed = JSON.parse(text);
		return Array.isArray(parsed?.groups) ? parsed.groups.filter(g => g && typeof g.id === 'string') : [];
	} catch {
		return []; // 缺文件/坏 JSON ⇒ 空（页面照常出，错误在 API 写操作时才会显形 ✓）
	}
}

async function writeGroups(config, groups) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, groups }, null, 2);
	JSON.parse(text); // 自证产物合法 ✓
	await writeFile(join(root, FILE_NAME), text, 'utf8');
}

/** API/页面用：清单（transcript 一并给；量已被 TRANSSCRIPT_KEEP 兜住 ✓）。 */
export async function listGroups(config) {
	return { groups: await readGroups(config), keep: TRANSSCRIPT_KEEP };
}

/** 建群。members 必须是真存在的 agent id（封闭集 = 当下扫描结果 ✓）。 */
export async function createGroup(config, input) {
	const name = String(input?.name ?? '').trim();
	if (!name) {
		throw httpError(400, '群名不能为空。');
	}
	const mode = input?.mode === 'open' ? 'open' : 'admin';
	const members = Array.isArray(input?.members) ? [...new Set(input.members.map(m => String(m ?? '').trim()).filter(Boolean))] : [];
	if (members.length === 0) {
		throw httpError(400, '至少要勾一个成员。');
	}
	if (members.length > MAX_MEMBERS) {
		throw httpError(400, `成员最多 ${MAX_MEMBERS} 个。`);
	}
	const scan = await scanAgents(agentsRootOf(config));
	const known = new Set(scan.agents.map(a => a.id));
	const unknown = members.filter(m => !known.has(m));
	if (unknown.length) {
		throw httpError(404, `成员里有没有的 agent：${unknown.join('、')}（现有：${[...known].join('、') || '(空)'}）`);
	}
	const groups = await readGroups(config);
	if (groups.length >= MAX_GROUPS) {
		throw httpError(409, `群数量到上限了（${MAX_GROUPS}）：先删掉不用的。`);
	}
	if (groups.some(g => g.name === name)) {
		throw httpError(409, `已有同名群：${name}`);
	}
	const group = { id: randomUUID(), name, mode, members, createdAt: Date.now(), updatedAt: Date.now(), transcript: [] };
	await writeGroups(config, [...groups, group]);
	return group;
}

/** 删群（幂等）。 */
export async function deleteGroup(config, input) {
	const id = String(input?.id ?? '').trim();
	const groups = await readGroups(config);
	const next = groups.filter(g => g.id !== id);
	if (next.length !== groups.length) {
		await writeGroups(config, next);
	}
	return { groups: next };
}

/** 从消息文本里解析被 @ 的成员（@id 或 @名字；名字含空格的先试最长匹配）。 */
export function parseMentions(text, members, agents) {
	const wanted = [];
	const pool = agents.filter(a => members.includes(a.id));
	for (const agent of pool) {
		const byId = new RegExp(`@${agent.id}(?![A-Za-z0-9._-])`).test(text);
		const byName = agent.name && text.includes(`@${agent.name}`);
		if (byId || byName) {
			wanted.push(agent);
		}
	}
	return wanted;
}

/** 找成员的活会话：没有就现开一条（与 assignments 同路径）。返回 { sessionId, created }。 */
async function ensureMemberSession(config, state, agent) {
	const wantPreset = presetIdOf(agent.id);
	const live = state.agents;
	// projcache 最近活跃的该 preset 会话 ∩ 运行注册表（与 agent_message 的选取同口径 ✓）
	const { readLiveSessions } = await import('./live.js');
	const liveRows = await readLiveSessions(config).catch(() => null);
	const liveIds = new Set((live?.roots?.() ?? []).map(a => a?.session?.id ?? a?.id).filter(Boolean));
	const candidate = (liveRows?.rows ?? [])
		.filter(r => r.presetId === wantPreset && liveIds.has(r.id))
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
	if (candidate) {
		return { sessionId: candidate.id, created: false };
	}
	const sc = state.sessionController;
	if (typeof sc?.create !== 'function') {
		throw httpError(503, '没有 sessionController 服务，开不了成员会话（dsh 版本不匹配？）。');
	}
	const created = await sc.create({ agentPreset: wantPreset });
	const sessionId = String(created?.sessionId ?? '').trim();
	if (!sessionId) {
		throw httpError(500, `给 ${agent.name} 开会话：创建成功但没回 sessionId。`);
	}
	return { sessionId, created: true };
}

function appendTranscript(group, entry) {
	group.transcript = [...(group.transcript ?? []), { id: randomUUID(), at: Date.now(), ...entry }];
	if (group.transcript.length > TRANSSCRIPT_KEEP) {
		const dropped = group.transcript.length - TRANSSCRIPT_KEEP;
		group.transcript = [
			{ id: randomUUID(), at: Date.now(), role: 'system', text: `（早期 ${dropped} 条已按上限 ${TRANSSCRIPT_KEEP} 裁掉）` },
			...group.transcript.slice(dropped),
		];
	}
	group.updatedAt = Date.now();
}

/**
 * 往群发消息：解析 @ → 派发成员（steer）→ 登记回收。
 * admin 模式：只发被 @ 的（一个都没 @ ⇒ 不落发、transcript 留一条系统提示，**如实** ✓）。
 * open 模式：发全员（@ 只是语气，不改变派发面）。
 */
export async function postGroupMessage(config, state, input) {
	const id = String(input?.id ?? '').trim();
	const text = String(input?.text ?? '').trim();
	if (!text) {
		throw httpError(400, '消息不能为空。');
	}
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	const scan = await scanAgents(agentsRootOf(config));
	const mentioned = parseMentions(text, group.members, scan.agents);
	const targets = group.mode === 'open'
		? scan.agents.filter(a => group.members.includes(a.id))
		: mentioned;
	appendTranscript(group, { role: 'user', text });
	if (targets.length === 0) {
		// admin 模式没 @ 到任何人：不派发，留系统提示（不静默 ✓）
		appendTranscript(group, { role: 'system', text: 'admin 模式：这条消息没有 @ 到任何成员，未派发。用 @成员名 指定响应者。' });
		await writeGroups(config, groups);
		return { group, dispatched: [] };
	}
	const dispatched = [];
	for (const agent of targets) {
		try {
			const { sessionId } = await ensureMemberSession(config, state, agent);
			const live = state.agents?.get?.(sessionId);
			if (!live || typeof live.steer !== 'function') {
				throw httpError(503, `会话不在运行或不支持 steer：${sessionId}`);
			}
			const message = {
				id: randomUUID(),
				role: 'user',
				content: [{ type: 'text', text: `[群聊「${group.name}」· 来自用户]\n${text}\n\n你的答复会回收进群聊记录（最终文本即群消息）。` }],
				source: { kind: AGENT_MESSAGE_KIND, from: null, hop: 1, to: agent.id, group: group.id },
			};
			live.steer(message);
			outboxNote(config, { kind: 'group', sessionId, groupId: group.id, messageId: message.id });
			dispatched.push({ agentId: agent.id, name: agent.name, sessionId });
		} catch (e) {
			// 单个成员失败不拖垮整批：失败如实写进 transcript ✓
			appendTranscript(group, { role: 'system', text: `派发给 ${agent.name} 失败：${String(e?.message ?? e)}` });
		}
	}
	if (dispatched.length) {
		appendTranscript(group, { role: 'system', text: `⇢ 已接力：${dispatched.map(d => d.name).join('、')}` });
	}
	await writeGroups(config, groups);
	return { group, dispatched };
}

/**
 * 装群回复回收（只装顶层角色，同 relay/assignments 的事件视野判据 ✓）。返回 dispose。
 * 成员会话回合结束 ⇒ 验证消费了我们的群消息 ⇒ 最终文本写回群 transcript（成员气泡）。
 */
export function installGroupTracker(ctx, config, _state) {
	const seenSeq = new Map();
	return ctx.on('agent/turn-stopping', async payload => {
		const session = payload?.agent?.session;
		if (!session?.id || typeof session.snapshotEvents !== 'function') {
			return;
		}
		const pending = outboxPendingFor(session.id).filter(e => e.kind === 'group');
		if (pending.length === 0) {
			return;
		}
		let events;
		try {
			const from = seenSeq.get(session.id) ?? 0;
			const to = typeof session.seq === 'number' ? session.seq : 0;
			events = to > from ? Array.from(session.snapshotEvents(from, to)) : [];
			seenSeq.set(session.id, to);
		} catch {
			return; // 读不动就留着下回合再判 ✓
		}
		const hits = findOurSplices(events, new Set(pending.map(p => p.messageId)));
		if (hits.length === 0) {
			return;
		}
		const final = finalAssistantText(events);
		const answered = new Set(hits.map(m => m.id));
		const groups = await readGroups(config);
		// 成员名：projcache 的 presetId 反查 agent（反查不到就如实写会话 id ✓）
		const { readLiveSession } = await import('./live.js');
		const row = await readLiveSession(config, session.id).catch(() => null);
		const preset = row?.row?.presetId ?? '';
		const scan = await scanAgents(agentsRootOf(config)).catch(() => null);
		const speaker = scan?.agents.find(a => presetIdOf(a.id) === preset);
		let dirty = false;
		for (const entry of pending.filter(p => answered.has(p.messageId))) {
			const group = groups.find(g => g.id === entry.groupId);
			if (!group) {
				continue; // 群已删 ⇒ 回复无处安放（成员会话日志里仍有 ✓）
			}
			appendTranscript(group, {
				role: 'member',
				agentId: speaker?.id,
				// ⚠ preset 可能是空串（projcache 没有）⇒ 用 || 兜底，?? 会把空串当真值留下 ✗
				name: speaker?.name ?? (preset || session.id),
				text: final ? final.text + (final.interrupted ? '（这条回合被打断了，内容可能不完整）' : '') : '（回合结束了但没有文本产出——可能被工具调用占满或被打断）',
				sessionId: session.id,
			});
			dirty = true;
		}
		// 写盘失败 ⇒ 条目留队下回合再试 ✓；群已删（没东西可写）⇒ 正常出队 ✓
		let writeFailed = false;
		if (dirty) {
			await writeGroups(config, groups).catch(e => {
				writeFailed = true;
				console.warn(`[vssaros-agents] 群 transcript 写盘失败：${String(e?.message ?? e)}`);
			});
		}
		if (!writeFailed) {
			outboxResolve(config, session.id, [...answered]);
		}
	});
}

/** 诊断/测试用：清 outbox 内存 + 复位惰性读（真源已外迁 outbox.js ✓）。 */
export { resetOutbox as resetGroupDispatch } from './outbox.js';
