// @vssaros/dsh-agents — assignments（委派运行时，2026-10-16，方案 D 的 P1）。
//
// 模型（BotHarness 的 Orchestrator / Assignment 分离在我们侧的对应物）：
//   ① 委派 = **开一条该 agent preset 的新会话** + steer 一条带头协议的任务消息（会话即执行单元，
//      身份/模型/工具都走 preset ⇒ 不另造运行时 ✓）；
//   ② 并发上限 MAX_CONCURRENT：**超限立即结构化报错**（HTTP 409 + code），**不排队** ✓
//      （排队 = 用户以为在跑实际没跑，最难查 ✗）；
//   ③ 报告 = 该会话回合结束（agent/turn-stopping）时验证真消费了任务消息（findOurSplices，与 relay
//      同一判据 ✓），取最终 assistant 文本登记为 report（截断保存，全文在会话日志 ✓）；
//   ④ 追问 = 往同一条会话再 steer 一条（status 回 running）；中断 = agent.cancel；
//   ⑤ 创建时给了 fromSession ⇒ 顺手登记 relay 的 pending，回复**同时**回传到来源会话 ✓。
//
// ⚠ 模块级 ASSIGNMENTS 是刻意的（与 relay 的 PENDING 同一判据：本包会被挂两次，闭包 state 会裂 ✗）。
// 持久化（2026-10-16 二期内）：台账写穿到 <数据根>/agent-assignments.json（每次变更即写，写队列串行
//    防竞态；启动时惰性读回）。重启后 running 的委派**直接恢复回收能力**——tracker 按 sessionId+running
//    过滤 ASSIGNMENTS 本身（messageIds 也在盘上 ✓），不需要重建登记 ✓。会话若已不在，用户可中断
//    （cancel 不依赖活会话 ✓）。记录封顶 KEEP_MAX 条：先裁最旧的**终态**（running 永不裁 ✓）。
// ⚠ 本段含模板串的地方没有，但注释里同样不许出现反引号（本仓纪律 ✓）。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { presetIdOf } from './core/agents.js';
import { AGENT_MESSAGE_KIND, finalAssistantText, findOurSplices } from './core/relay.js';
import { checkCwdGrant } from './grants.js';
import { notePendingReply } from './relay.js';
import { agentsRootOf, dataRootOf, scanAgents } from './store.js';
import { findAgent } from './tools.js';

/** 全局并发上限（BotHarness 默认 8 同构）。 */
export const MAX_CONCURRENT = 8;

/** 报告在台账里保存的上限（全文始终在该会话的日志里，这里只留摘要级长度）。 */
const REPORT_KEEP = 4000;

/** @type {Map<string, object>} 委派 id → 台账记录（模块级，理由见头注释 ⚠） */
const ASSIGNMENTS = new Map();

/** 单调序号：同一毫秒创建的委派 createdAt 相同 ⇒ 排序要拿它做次序键（否则列表顺序不稳、界面闪烁）。 */
let ASSIGN_SEQ = 0;

/* ── 持久化（写穿）────────────────────────────────────────────────── */
/** 台账文件名（数据根下；与群/模板同写口判据 ✓）。 */
const FILE_NAME = 'agent-assignments.json';
/** 记录封顶（先裁最旧终态；running 永不裁 ✓）。 */
export const KEEP_MAX = 100;

let loadedRoot = null; // 已读入的数据根（惰性一次）
let writeQueue = Promise.resolve(); // 写队列：串行，防并发写坏文件

/** 惰性读回（每个数据根一次）。坏 JSON/缺文件 ⇒ 空台账（不炸激活 ✓）。 */
async function ensureLoaded(config) {
	const root = dataRootOf(config);
	if (loadedRoot === root) {
		return;
	}
	loadedRoot = root;
	try {
		const text = await readFile(join(root, FILE_NAME), 'utf8');
		const parsed = JSON.parse(text);
		const items = Array.isArray(parsed?.items) ? parsed.items.filter(a => a && typeof a.id === 'string') : [];
		ASSIGNMENTS.clear();
		for (const item of items) {
			ASSIGNMENTS.set(item.id, item);
			if (typeof item.seq === 'number' && item.seq > ASSIGN_SEQ) {
				ASSIGN_SEQ = item.seq; // 序号接着盘上的走，不与旧记录撞次序 ✓
			}
		}
	} catch {
		/* 没有/坏了 ⇒ 空台账起步 ✓ */
	}
}

/** 写穿（串行队列；写失败只留日志——台账读面仍是内存这份，下下次变更再写 ✓）。 */
function persist(config) {
	const root = dataRootOf(config);
	const items = [...ASSIGNMENTS.values()];
	writeQueue = writeQueue.then(async () => {
		await mkdir(root, { recursive: true });
		const text = JSON.stringify({ version: 1, items }, null, 2);
		JSON.parse(text); // 自证产物合法 ✓
		await writeFile(join(root, FILE_NAME), text, 'utf8');
	}).catch(e => console.warn(`[vssaros-agents] 委派台账写盘失败：${String(e?.message ?? e)}`));
	return writeQueue;
}

/** 封顶：先裁最旧的终态记录（running 永不裁），返回是否变了。 */
function trimToCap() {
	if (ASSIGNMENTS.size <= KEEP_MAX) {
		return false;
	}
	const terminal = [...ASSIGNMENTS.values()]
		.filter(a => a.status !== 'running')
		.sort((a, b) => (a.createdAt - b.createdAt) || (a.seq - b.seq));
	let dirty = false;
	while (ASSIGNMENTS.size > KEEP_MAX && terminal.length) {
		ASSIGNMENTS.delete(terminal.shift().id);
		dirty = true;
	}
	return dirty;
}

/** 带 HTTP 语义的错误（index.js 的 API 层按它回状态码；与 kanban 的 refusal 同形）。 */
function httpError(status, message, extra = {}) {
	return Object.assign(new Error(message), { httpStatus: status, ...extra });
}

/** 快照（API/页面共用）：新→旧（createdAt 同毫秒时用单调序号决胜 ✓）；report 已在写入时截断。 */
export async function listAssignments(config) {
	await ensureLoaded(config);
	const items = [...ASSIGNMENTS.values()].sort((a, b) => (b.createdAt - a.createdAt) || (b.seq - a.seq));
	return {
		cap: MAX_CONCURRENT,
		running: items.filter(a => a.status === 'running').length,
		items,
	};
}

/** 诊断/测试用：清空台账内存并复位惰性读标记（下次 ensureLoaded 会从盘上读回 ⇒ 正好模拟重启 ✓）。 */
export function resetAssignments() {
	ASSIGNMENTS.clear();
	loadedRoot = null;
}

/**
 * 创建委派：开会话 → steer 任务消息 → 登记台账（+ 可选回传来源会话）。
 * @param config 本行 config（数据根解析）
 * @param state 顶层角色状态（sessionController / agents 服务槽位）
 * @param input `{ agent, task, fromSession?, fromName?, cwd? }`
 */
export async function createAssignment(config, state, input) {
	await ensureLoaded(config);
	const task = String(input?.task ?? '').trim();
	if (!task) {
		throw httpError(400, '任务不能为空（task）。');
	}
	const scan = await scanAgents(agentsRootOf(config));
	const { agent, error } = findAgent(scan.agents, input?.agent);
	if (error) {
		throw httpError(404, error);
	}
	const running = [...ASSIGNMENTS.values()].filter(a => a.status === 'running').length;
	if (running >= MAX_CONCURRENT) {
		// 结构化报错、不排队（理由见头注释 ②）
		throw httpError(409, `委派并发已满（${running}/${MAX_CONCURRENT}）：等运行中的委派结束，或先中断一条。`, { code: 'concurrency-cap', running, cap: MAX_CONCURRENT });
	}
	const sc = state.sessionController;
	if (typeof sc?.create !== 'function') {
		throw httpError(503, '这个 dsh 组合里没有 sessionController 服务，开不了委派会话（dsh 版本不匹配？）。');
	}
	const cwd = typeof input?.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : undefined;
	// Workspace Grant 闸（2026-10-16 二期，与 agent_open_session 同一判据 ✓）
	const grantRefusal = checkCwdGrant(agent, cwd);
	if (grantRefusal) {
		throw httpError(403, grantRefusal);
	}
	const wantPreset = presetIdOf(agent.id);
	const created = await sc.create({ ...(cwd ? { cwd } : {}), agentPreset: wantPreset });
	const sessionId = String(created?.sessionId ?? '').trim();
	if (!sessionId) {
		throw httpError(500, '会话创建成功但没回 sessionId（dsh 版本不匹配？）。');
	}
	const live = state.agents?.get?.(sessionId);
	if (!live) {
		throw httpError(503, `会话已建（${sessionId}）但没在运行注册表里——委派发不出去。会话本身还在，可到会话列表里找它。`);
	}
	const senderName = String(input?.fromName ?? '').trim() || 'agents 页';
	const fromSession = String(input?.fromSession ?? '').trim() || null;
	const message = {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: `[Assignment 委派 · 来自 ${senderName}]\n${task}\n\n完成后把结果作为你的最终答复文本产出——它会作为本次委派的报告登记（全文留在你的会话日志）。` }],
		source: { kind: AGENT_MESSAGE_KIND, from: fromSession, hop: 1, to: agent.id, assignment: true },
	};
	if (typeof live.steer === 'function') {
		live.steer(message);
	} else if (typeof live.followup === 'function') {
		live.followup(message);
	} else {
		throw httpError(503, '该会话的 agent 不支持 steer/followup（dsh 版本不匹配？）。');
	}
	const record = {
		id: randomUUID(),
		seq: ++ASSIGN_SEQ,
		agentId: agent.id,
		agentName: agent.name,
		task,
		sessionId,
		messageIds: [message.id],
		status: 'running',
		report: null,
		error: created?.agentPreset && created.agentPreset !== wantPreset
			? `实际跑的是 preset ${created.agentPreset} 而不是 ${wantPreset}（该 agent 的 preset 可能没注册成功）`
			: null,
		fromSession,
		createdAt: Date.now(),
		updatedAt: Date.now(),
	};
	ASSIGNMENTS.set(record.id, record);
	trimToCap();
	await persist(config);
	// 来源会话存在 ⇒ 回复同时回传到那里（relay 的既有通道；回复本身不登记 pending ⇒ 不会 ping-pong ✓）
	if (fromSession) {
		notePendingReply(config, sessionId, { messageId: message.id, from: fromSession, fromName: senderName, hop: 1 });
	}
	return record;
}

/** 追问：往委派的同一条会话再 steer 一条（status 回 running，报告等新回合）。 */
export async function askAssignment(config, state, input) {
	await ensureLoaded(config);
	const id = String(input?.id ?? '').trim();
	const text = String(input?.message ?? '').trim();
	const record = ASSIGNMENTS.get(id);
	if (!record) {
		throw httpError(404, `没有这个委派：${id || '(没给 id)'}（Host 重启后台账会清空——会话本身还在）。`);
	}
	if (!text) {
		throw httpError(400, '追问内容不能为空（message）。');
	}
	if (record.status === 'cancelled') {
		throw httpError(409, `该委派已中断，不能追问（要继续就新建一条委派）。`);
	}
	const live = state.agents?.get?.(record.sessionId);
	if (!live || typeof live.steer !== 'function') {
		throw httpError(503, `委派会话不在运行：${record.sessionId}（追问发不出去；会话历史仍在盘上）。`);
	}
	const message = {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: `[Assignment 追问]\n${text}` }],
		source: { kind: AGENT_MESSAGE_KIND, from: record.fromSession, hop: 1, to: record.agentId, assignment: true },
	};
	live.steer(message);
	record.messageIds.push(message.id);
	record.status = 'running';
	record.updatedAt = Date.now();
	await persist(config);
	if (record.fromSession) {
		notePendingReply(config, record.sessionId, { messageId: message.id, from: record.fromSession, fromName: 'agents 页（追问）', hop: 1 });
	}
	return record;
}

/** 中断：停掉委派会话当前回合（幂等：已终态的再调只回当前状态）。 */
export async function cancelAssignment(config, state, input) {
	await ensureLoaded(config);
	const id = String(input?.id ?? '').trim();
	const record = ASSIGNMENTS.get(id);
	if (!record) {
		throw httpError(404, `没有这个委派：${id || '(没给 id)'}`);
	}
	if (record.status !== 'running') {
		return record; // 幂等 ✓
	}
	const live = state.agents?.get?.(record.sessionId);
	if (live && typeof live.cancel === 'function') {
		const reason = String(input?.reason ?? '').trim();
		live.cancel({ kind: 'hook', reason: `vssaros-agents/assignment-cancel${reason ? `：${reason}` : ''}` });
	}
	record.status = 'cancelled';
	record.updatedAt = Date.now();
	await persist(config);
	return record;
}

/**
 * 装台账跟踪（只装顶层角色，与 relay 同一事件视野判据 ✓）。返回 dispose。
 * 回合结束时：验证这回合真消费了该委派的**最新一条**消息 ⇒ 取最终 assistant 文本登记报告；
 * 没消费（比如用户自己在那条会话里开了回合）⇒ 保持 running，下回合再判 ✓。
 */
export function installAssignmentTracker(ctx, config, _state) {
	const seenSeq = new Map();
	return ctx.on('agent/turn-stopping', payload => {
		const session = payload?.agent?.session;
		if (!session?.id || typeof session.snapshotEvents !== 'function') {
			return;
		}
		const targets = [...ASSIGNMENTS.values()].filter(a => a.sessionId === session.id && a.status === 'running');
		if (targets.length === 0) {
			return; // 没有等它的委派：不看事件（与 relay 同一节省 ✓）
		}
		let events;
		try {
			const from = seenSeq.get(session.id) ?? 0;
			const to = typeof session.seq === 'number' ? session.seq : 0;
			events = to > from ? Array.from(session.snapshotEvents(from, to)) : [];
			seenSeq.set(session.id, to);
		} catch {
			return; // 读不动就保持 running（下回合再判 ✓）
		}
		for (const record of targets) {
			const latest = record.messageIds[record.messageIds.length - 1];
			const hits = findOurSplices(events, new Set([latest]));
			if (hits.length === 0) {
				continue; // 这回合没消费委派的最新消息 ⇒ 不算完成 ✓
			}
			const final = finalAssistantText(events);
			record.report = final
				? (final.text.length > REPORT_KEEP ? `${final.text.slice(0, REPORT_KEEP)}…（截断，全文在会话日志）` : final.text)
					+ (final.interrupted ? '\n\n（这条回合被打断了，内容可能不完整）' : '')
				: null;
			if (!final) {
				record.error = '回合结束了但没有文本产出（可能被工具调用占满或被打断；可追问）';
			}
			record.status = 'done';
			record.updatedAt = Date.now();
		}
		// 写穿（终态落盘 ⇒ 重启后报告还在 ✓）
		void persist(config);
	});
}
