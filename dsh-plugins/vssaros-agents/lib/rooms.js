// @vssaros/dsh-agents — 多 bot 群聊的运行时（2026-11-05，用户要求恢复群聊；设计移植 DeepSeek-Bot 的 room）。
// 移植自 ds-bot/src/host/groups.js（接力调度、做完叫回、迟到回复新开一轮），Copyright 2026 Fei2411 and the DS Bot
// contributors，Apache License 2.0；见本插件的 NOTICE。
//
// 纯逻辑（谁来回答、@ 解析、成员提示、视图）在 core/rooms.js；这里是有状态的那一半：
//   · 存储：`<数据根>/agent-rooms.json`（群定义 + 群日志 + 成员影子会话）。与 2026-11-03 下线的旧群聊
//     （groups.js / agent-groups.json，自托管 transcript + 自绘页面）无关，两者不共享任何数据。
//   · 建群：开一条群会话（id = 群 id）登记进工作区 + 写群标记 plugin record + 会话改名为群名。
//   · 群会话**不调模型**：`llm/stream` 里遇到群会话 ⇒ 最后一条是人的消息时合成一次 `group_relay` 调用，
//     否则合成 stop（标题等辅助请求 `purpose` 照常放行）。⚠ 只认 source.kind==='user' 的消息：
//     插件塞的上下文（时间、附件说明）也是 user 角色，不能触发转发。
//   · `group_relay`：取出群收件箱里人的新消息 → 记日志 → 按 core/rooms.js 选人 → 逐个（或并行）把一轮
//     提示 followup 进成员的影子会话 → 等该会话回合结束取最终文本 → 写回日志与本轮结果；成员话里的 @ 再叫人。
//     结果 JSON 落回群会话（工具结果），chat-surface 的 `group_relay` 工具卡把它画成成员气泡；
//     跑的过程中工具卡按 callId 轮询 `GET /api/rooms?progress=<callId>`。
//   · 删群：群会话与成员影子会话都**归档**（不删日志，可找回），记录删除。
//
// 依赖全部注入（createRooms(deps)）⇒ test/rooms.test.mjs 用假会话跑完整一轮。

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry } from './atomicWrite.js';
import { finalAssistantText, findOurSplices } from './core/relay.js';
import { GOAL_IDLE_NUDGES, GOAL_NUDGE_TEXT, GOAL_TOOL_PARAMETERS, applyGoal, goalPromptBlock, goalView, markTask } from './core/goals.js';
import {
	RoomError, ROOM_IDLE_RELAY_LIMIT, ROOM_LIMITS, ROOM_POST_FORM, ROOM_RECORD_TYPE, ROOM_REFERENCE_KIND, ROOM_RELAY_TOOL, ROOM_TURN_KIND,
	ROUND_SCHEMA, ROUND_STATUS_LABELS,
	addressedRoomReference, autoRoomName, callsFrom, clipLine, isPass, mentionsIn, normalizeRoomInput, openingCall,
	roomPrompt, roomRecordData, roomReferenceOf, roomView, roundStatusOf, sortRooms, stripOwnName, stripRoomMention,
} from './core/rooms.js';

/** 成员一回合最长等多久（DS Bot ROOM_REPLY_TIMEOUT_MS 同值）。★ 2026-11-06 起是「毫无进展」的时长，见 waitFor。 */
export const ROOM_REPLY_TIMEOUT_MS = 240_000;
/** 成员一回合的硬上限：一直有进展也不超过它（写代码类任务常要十几分钟）。 */
export const ROOM_REPLY_MAX_MS = 30 * 60_000;
/** 本轮结果在内存里留多久（工具卡轮询用；结果本身已在群会话的工具结果里）。 */
const PROGRESS_KEEP_MS = 10 * 60_000;
/** ★ 2026-11-06：agent-rooms.json 当前格式；读到更高版本 ⇒ 只读冻结，绝不用旧代码覆盖新数据。 */
export const ROOMS_FILE_VERSION = 2;
/** 盘上最多留多少轮（运行中的永不裁）；超过 PROGRESS_KEEP_MS 的已结束轮次在载入时裁掉。 */
export const ROUNDS_KEEP_MAX = 50;
/** 每个群最多归档多少个被中断的轮次（它们不按时间删，见 pruneRounds）。 */
export const ROUNDS_ARCHIVE_PER_ROOM = 20;
/** 成员超过这个时间还没回 ⇒ 先上一条 `working` 状态节点，不让 UI 看起来像卡死。 */
export const ROOM_WORK_GRACE_MS = 15_000;
/**
 * ★ 2026-11-06（P2，对齐 DS Bot：成员开始调用工具后 15 秒这一轮就不等它）：本项目给 2 分钟 ——
 *   一问一答式的小活（读几个文件、跑一条命令）照旧在本轮里交回；写代码这类长活放行到后台，
 *   干完后结果记进群聊，并新开一轮叫回派活的人。
 */
export const ROOM_RELEASE_MS = 120_000;
/** 系统往群会话投的「新开一轮」消息的来源形态（成员干完了 / 目标检查）。 */
export const ROOM_CALLBACK_FORM = 'room-callback';
/** 群目标工具名（挂在成员影子会话上，只有管理员能用）。 */
export const ROOM_GOAL_TOOL = 'group_goal';
/** 群目标的一次操作写进群聊记录的那行字。 */
function goalLogText(reply, goal) {
	const title = goal?.title ? `「${goal.title}」` : '';
	switch (reply?.event) {
		case 'start': return `【群目标】设定了目标${title}，共 ${reply.stages} 个阶段，先做：${reply.next}`;
		case 'pass': return reply.next ? `【群目标】第 ${reply.stage - 1} 阶段通过，进入第 ${reply.stage}/${reply.stages} 阶段：${reply.next}` : `【群目标】最后一个阶段通过，等管理员收尾`;
		case 'rework': return `【群目标】第 ${reply.stage} 阶段打回（第 ${reply.reworks} 次）：${goal?.stages?.[goal.current]?.feedback ?? ''}`;
		case 'revise': return `【群目标】按用户的修正更新了目标${title}`;
		case 'complete': return `【群目标】目标${title}完成：${goal?.summary || goal?.evidence || ''}`;
		case 'stop': return `【群目标】停止了目标${title}`;
		default: return `【群目标】${title}`;
	}
}
/** DS Bot 同名的状态节点词表（只读 UI 用；`paused/resumed` 由新一轮抢占时补）。 */
const ROOM_STATUS_KINDS = Object.freeze(['working', 'missed', 'failed', 'passed', 'paused', 'resumed', 'cut', 'done', 'approval']);
/**
 * ★ 2026-11-06（对齐 DS Bot「等你审批」）：群成员影子会话里要人确认的工具调用。
 *   影子会话没人打开，DSH 自带的审批框画在那里没人看得见 ⇒ 成员只能干等到超时。现在由群接住：
 *   挂起这条请求、本轮插一个 `approval` 节点，群会话的工具卡与成员栏给出「允许 / 拒绝」。
 *   等审批期间不算「没有进展」（不触发 240 秒超时）；最多等 `ROOM_APPROVAL_MAX_MS`，过时按拒绝。
 */
export const ROOM_APPROVAL_MAX_MS = 15 * 60_000;
const approvalCode = () => Math.random().toString(16).slice(2, 6).padEnd(4, '0');

const textOutput = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] };

/** 转投消息的确定性 id：同一条来源消息转投到群里永远是同一个 id（幂等的依据）。 */
export const roomPostId = (fromSession, sourceMessageId) => `room-post:${fromSession}:${sourceMessageId}`;
/** 历史里最多往回查多少条事件（群会话的转投都很近，不必读全量）。 */
const POST_HISTORY_SCAN = 2000;
/**
 * 群会话是否已经有这条消息：待处理队列（nextTurn / nextStep）或已落盘的事件（user/message、被 splice 进回合）。
 * 读不到 ⇒ 按「没有」处理（宁可重发一次，也不吞掉人的指令）。
 */
export function holdsMessage(agent, id) {
	try {
		const inbox = agent?.inbox;
		if ([...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])].some(message => message?.id === id)) { return true; }
		const session = agent?.session;
		const to = typeof session?.seq === 'number' ? session.seq : 0;
		if (to > 0 && typeof session.snapshotEvents === 'function') {
			for (const event of session.snapshotEvents(Math.max(0, to - POST_HISTORY_SCAN), to)) {
				if (event?.type === 'user/message' && event.data?.id === id) { return true; }
				if (event?.type === 'agent/inbox/spliced' && (event.data?.inserted ?? []).some(message => message?.id === id)) { return true; }
			}
		}
	} catch { /* 读不到 ⇒ 当作没有 */ }
	return false;
}

/**
 * @param deps.file `agent-rooms.json` 的绝对路径
 * @param deps.roster `async () => [{ id, name }]` 可入群的 bot（不含隐藏 bot）
 * @param deps.presetOf `(botId) => presetId`
 * @param deps.sessions `() => sessionController`（create / rename / resolveAgent）
 * @param deps.agents `() => agents`（get(id)）
 * @param deps.workspaces `() => workspaceRegistry`（list / create / archiveSession），可缺
 * @param deps.append `async () => appendPluginRecord | null`
 * @param deps.fallbackCwd 没有任何工作区时群会话落在哪
 * @param deps.timeoutMs / deps.now / deps.uuid / deps.warn 测试可注入
 */
export function createRooms(deps) {
	const now = deps.now ?? (() => Date.now());
	const uuid = deps.uuid ?? (() => randomUUID());
	const warn = deps.warn ?? (message => console.warn(`[vssaros-agents][rooms] ${message}`));
	const timeoutMs = deps.timeoutMs ?? ROOM_REPLY_TIMEOUT_MS;
	const maxWaitMs = deps.maxWaitMs ?? ROOM_REPLY_MAX_MS;
	const workGraceMs = deps.workGraceMs ?? ROOM_WORK_GRACE_MS;
	/** ★ 2026-11-06（P2）：成员开始调用工具后这一轮最多等它多久就放行（0 = 不放行，一直等）。 */
	const releaseMs = deps.releaseMs ?? ROOM_RELEASE_MS;
	/** 群 id → 等着「新开一轮」的系统消息（成员干完了 / 目标检查），`relay` 取走。 */
	const callbacks = new Map();
	/** @type {Map<string, any>} */
	const rooms = new Map();
	/** 群会话 id → 人的新消息文本（user/message 事件进来、group_relay 取走）。 */
	const inbox = new Map();
	/** 影子会话 id → 等它回合结束的 `[{ messageId, resolve, touch, idle, cap }]`。 */
	const waiters = new Map();
	/** 影子会话 id → 群这一轮已经不等了、但成员还在干的那条（`[{ messageId, roomId, botId, name, at }]`）。 */
	const late = new Map();
	/** 审批 id → 群成员一条等人确认的工具调用（`settle` 不对外）。 */
	const approvals = new Map();
	const approvalMaxMs = deps.approvalMaxMs ?? ROOM_APPROVAL_MAX_MS;
	/** 影子会话 id → 上次读到的事件 seq。 */
	const seenSeq = new Map();
	/** callId → 本轮进度（工具卡轮询）。★ 2026-11-06：写穿到 agent-rooms.json，重启可恢复执行过程。 */
	const rounds = new Map();
	/** 群 id → 最近一次 @群 转投的来源（relay 取走后挂到本轮上，作为与 SuperAgent trigger 的关联键）。 */
	const postMeta = new Map();
	let loaded = null;
	let writing = Promise.resolve();
	/** 已排队、还没开始的那次写（同一拍内的多次 save() 合并成一次整文件写）。 */
	let queuedWrite = null;
	/**
	 * 只读冻结：① 读到比本代码新的文件格式（future）；② 另一个 Host 接管了群记录（superseded）。
	 * 两种情况都绝不再写，避免旧实例用过期的内存整文件覆盖别人的数据。
	 */
	let frozen = false;
	let frozenReason = '';
	let frozenWarned = false;
	/**
	 * ★ 2026-11-06 单写者租约（`<file>.owner`）。问题不是「写一半」（原子 rename 已解决），而是**丢更新**：
	 * 两个 Host（旧 Host 没死 / 插件热重载）各自在内存里持有完整状态，谁后写谁整文件覆盖对方。
	 * 规则：**最新载入的实例接管**（载入时写入自己的 token）；每次落盘前核对 token，不是自己 ⇒ 转只读。
	 * token 用独立的 randomUUID（不走 deps.uuid，测试注入的确定性 uuid 会让两个实例撞同一个 token）。
	 */
	const leaseFile = deps.leaseFile ?? `${deps.file}.owner`;
	const leaseToken = randomUUID();
	const leasePid = deps.pid ?? process.pid;
	function freeze(reason, message) {
		if (frozen) { return; }
		frozen = true;
		frozenReason = reason;
		frozenWarned = true;
		warn(message);
	}
	async function readLease() {
		try {
			const raw = JSON.parse(await readFile(leaseFile, 'utf8'));
			return raw && typeof raw === 'object' ? raw : null;
		} catch { return null; }
	}
	async function claimLease() {
		try {
			await mkdir(dirname(leaseFile), { recursive: true });
			await writeFile(leaseFile, JSON.stringify({ format: 1, token: leaseToken, pid: leasePid, at: now() }), 'utf8');
		} catch (error) {
			warn(`写群记录租约失败（照常读写，但无法阻止另一个 Host 覆盖）：${String(error?.message ?? error)}`);
		}
	}
	async function releaseLease() {
		const cur = await readLease();
		if (cur && cur.token === leaseToken) { await rm(leaseFile, { force: true }).catch(() => undefined); }
	}

	const CORRELATION_KEYS = ['originTriggerId', 'fromSession', 'sourceMessageId'];
	const correlationOf = (item) => Object.fromEntries(CORRELATION_KEYS
		.filter(key => typeof item?.[key] === 'string' && item[key]).map(key => [key, item[key]]));

	/** 进度快照：Set 展平、数组复制；和 `progress()/active()` 的字段保持同口径。 */
	function roundSnapshot(round) {
		if (!round) { return null; }
		return {
			callId: String(round.callId ?? ''), roomId: String(round.roomId ?? ''),
			replies: Array.isArray(round.replies) ? round.replies : [],
			passed: Array.isArray(round.passed) ? round.passed : [],
			failed: Array.isArray(round.failed) ? round.failed : [],
			events: Array.isArray(round.events) ? round.events : [],
			speaking: round.speaking instanceof Set ? [...round.speaking] : Array.isArray(round.speaking) ? round.speaking : [],
			startedAt: Number(round.startedAt ?? 0), finishedAt: Number(round.finishedAt ?? 0),
			done: !!round.done, error: String(round.error ?? ''),
			phase: String(round.phase ?? (round.done ? 'done' : 'running')), interrupted: !!round.interrupted,
			persisted: !!round.persisted, ...correlationOf(round),
		};
	}
	function restoreRound(raw) {
		const item = raw && typeof raw === 'object' ? raw : {};
		return {
			callId: String(item.callId ?? ''), roomId: String(item.roomId ?? ''),
			replies: Array.isArray(item.replies) ? item.replies : [],
			passed: Array.isArray(item.passed) ? item.passed : [],
			failed: Array.isArray(item.failed) ? item.failed : [],
			events: Array.isArray(item.events) ? item.events : [],
			speaking: new Set(Array.isArray(item.speaking) ? item.speaking.map(String) : []),
			startedAt: Number(item.startedAt ?? 0) || now(), finishedAt: Number(item.finishedAt ?? 0) || 0,
			done: !!item.done, error: String(item.error ?? ''),
			phase: String(item.phase ?? (item.done ? 'done' : 'running')), interrupted: !!item.interrupted,
			persisted: true, ...correlationOf(item),
		};
	}
	/**
	 * 裁剪：运行中永不裁。
	 * · 正常结束的轮次：超过保留期就删（结果已在会话的工具结果里，永久可重绘）；总数封顶 ROUNDS_KEEP_MAX。
	 * · ★ 被中断（cut）的轮次**不按时间删**：DSH 重启后给悬空调用补的是一条英文错误结果，真实回复只在这里，
	 *   删了工具卡就再也画不出这一轮。改为每个群只留最近 ROUNDS_ARCHIVE_PER_ROOM 轮；删群时一起删。
	 */
	function pruneRounds() {
		const at = now();
		const archived = (round) => round.done && (round.interrupted || round.phase === 'cut');
		for (const [id, round] of rounds) {
			if (!rooms.has(round.roomId) && round.done) { rounds.delete(id); continue; }
			if (round.done && !archived(round) && at - (round.finishedAt || round.startedAt) > PROGRESS_KEEP_MS) { rounds.delete(id); }
		}
		const byNewest = (a, b) => b[1].startedAt - a[1].startedAt;
		const perRoom = new Map();
		for (const [id, round] of [...rounds.entries()].filter(([, round]) => archived(round)).sort(byNewest)) {
			const kept = perRoom.get(round.roomId) ?? 0;
			if (kept >= ROUNDS_ARCHIVE_PER_ROOM) { rounds.delete(id); } else { perRoom.set(round.roomId, kept + 1); }
		}
		const ended = [...rounds.entries()].filter(([, round]) => round.done && !archived(round)).sort(byNewest);
		const running = [...rounds.values()].filter(round => !round.done).length;
		for (const [id] of ended.slice(Math.max(0, ROUNDS_KEEP_MAX - running))) { rounds.delete(id); }
	}

	async function readRaw() {
		try { return JSON.parse(await readFile(deps.file, 'utf8')); } catch (error) {
			if (error?.code !== 'ENOENT') { warn(`读群记录失败（按空处理）：${String(error?.message ?? error)}`); }
			return null;
		}
	}
	async function load() {
		loaded ??= (async () => {
			let dirty = false;
			let raw = await readRaw();
			const version = Number(raw?.version ?? 1);
			if (raw && Number.isFinite(version) && version > ROOMS_FILE_VERSION) {
				// 新版本的 Host 多半还在用这份文件 ⇒ 不接管租约，只读
				freeze('future', `群记录文件是 v${version}（本代码只懂 v${ROOMS_FILE_VERSION}）⇒ 只读，不会写回，避免覆盖新版本数据`);
			} else {
				await claimLease();
				// 接管后重读：上一任实例在「我们读文件 → 接管」之间落下的最后一次写也要吃进来
				const again = await readRaw();
				if (again && Number(again.version ?? 1) <= ROOMS_FILE_VERSION) { raw = again; }
			}
			try {
				for (const room of Array.isArray(raw?.rooms) ? raw.rooms : []) {
					if (room && typeof room.id === 'string' && Array.isArray(room.members)) {
						rooms.set(room.id, { log: [], seq: 0, seen: {}, sessions: {}, ...room });
					}
				}
				for (const rawRound of Array.isArray(raw?.rounds) ? raw.rounds : []) {
					const round = restoreRound(rawRound);
					if (!round.callId || !round.roomId) { dirty = true; continue; }
					if (!round.done) {
						// DS Bot 的 `resumed/cut` 口径：重启不重跑旧 tool-call，如实收口为被中断。
						// finishedAt 取「被发现中断」的时刻：只在这一次重启时出现在活动列表里，之后按它自然过期。
						round.done = true;
						round.finishedAt = now();
						round.phase = 'cut';
						round.interrupted = true;
						round.error = round.error || '执行被重启打断';
						round.speaking = new Set(); // 重启后没有活的成员回合，不能继续显示「正在输入」
						round.events.push({ kind: 'cut', at: now(), text: '群聊本轮被重启中断' });
						dirty = true;
					} else {
						round.phase = round.phase === 'cut' ? 'cut' : 'done';
					}
					round.persisted = true;
					rounds.set(round.callId, round);
				}
				const before = rounds.size;
				pruneRounds();
				if (rounds.size !== before) { dirty = true; }
			} catch (error) {
				warn(`解析群记录失败（按空处理）：${String(error?.message ?? error)}`);
			}
			if (dirty) { await save(); }
		})();
		return loaded;
	}
	/**
	 * 写穿：同一拍内多次调用合并成一次；序列化发生在真正写的那一刻（拿到的是最新状态）。
	 * 冻结（未来版本 / 被别的 Host 接管）时不写；每次真正落盘前先核对租约。返回这次写完成的 Promise。
	 */
	function save() {
		if (frozen) {
			if (!frozenWarned) { frozenWarned = true; warn(`群记录处于只读冻结（${frozenReason}），本次改动不落盘`); }
			return writing;
		}
		if (queuedWrite) { return queuedWrite; }
		const job = writing.then(async () => {
			queuedWrite = null;
			if (frozen) { return; }
			const owner = await readLease();
			if (owner && owner.token && owner.token !== leaseToken) {
				freeze('superseded', `另一个实例（pid ${String(owner.pid ?? '?')}）已接管群记录 ⇒ 本实例转只读，改动不再落盘（重启这个 Host 即可恢复）`);
				return;
			}
			if (!owner) { await claimLease(); }
			pruneRounds();
			const body = JSON.stringify({ version: ROOMS_FILE_VERSION, rooms: [...rooms.values()],
				rounds: [...rounds.values()].map(roundSnapshot).filter(Boolean) }, null, '\t');
			await mkdir(dirname(deps.file), { recursive: true });
			const tmp = `${deps.file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
			await writeFile(tmp, body, 'utf8');
			try { await renameWithRetry(tmp, deps.file); } catch (error) { await rm(tmp, { force: true }); throw error; }
		}).catch(error => { warn(`写群记录失败：${String(error?.message ?? error)}`); });
		queuedWrite = job;
		writing = job;
		return job;
	}
	/** 等所有排队的写落盘（测试用来断言盘上状态）。 */
	async function flush() {
		let last;
		do { last = writing; await last; } while (last !== writing);
	}
	/** 卸载：写完排队的改动，再交还租约（只删自己的；已被接管就不动）。 */
	async function close() {
		await flush();
		await releaseLease();
	}
	/**
	 * ★ 跨插件契约（schema=ROUND_SCHEMA）：一轮对外的全部字段。工具结果、`?progress=`、`?active=1` 共用，
	 * 所以 status / statusLabel 只在这里算一次，五处 UI 不再各自推断。
	 */
	function roundOutput(round) {
		const status = roundStatusOf(round);
		return {
			schema: ROUND_SCHEMA, callId: String(round.callId ?? ''),
			replies: round.replies, passed: round.passed, failed: round.failed, events: round.events || [],
			speaking: [...(round.speaking ?? [])],
			startedAt: round.startedAt, finishedAt: round.finishedAt || 0, done: !!round.done,
			phase: round.phase || (round.done ? 'done' : 'running'), interrupted: !!round.interrupted,
			status, statusLabel: ROUND_STATUS_LABELS[status], ...correlationOf(round),
			approvals: approvalsOf(round.roomId),
		};
	}
	/** 这个群里正在等人确认的请求（对外视图，最早的在前）。 */
	function approvalsOf(roomId) {
		return [...approvals.values()].filter(item => item.roomId === roomId)
			.map(({ settle: _settle, sessionId: _sessionId, ...view }) => view).sort((a, b) => a.at - b.at);
	}
	function roundView(round) {
		return { ...roundOutput(round), roomId: round.roomId, roomName: rooms.get(round.roomId)?.name ?? round.roomId, error: round.error || '' };
	}
	async function names() {
		const roster = await deps.roster().catch(() => []);
		return { roster, map: new Map(roster.map(bot => [bot.id, bot.name])) };
	}
	function need(id) {
		const room = rooms.get(String(id ?? '').trim());
		if (!room) { throw new RoomError(`没有这个群：${String(id ?? '')}`, 404); }
		return room;
	}
	function appendLog(room, line) {
		room.seq += 1;
		const entry = { seq: room.seq, at: now(), ...line };
		room.log.push(entry);
		if (room.log.length > ROOM_LIMITS.log) { room.log.splice(0, room.log.length - ROOM_LIMITS.log); }
		room.updatedAt = entry.at;
		return entry;
	}
	async function resolveAgent(sessionId) {
		const live = deps.agents()?.get?.(sessionId);
		if (live) { return live; }
		const sc = deps.sessions();
		const got = sc && typeof sc.resolveAgent === 'function' ? await sc.resolveAgent(sessionId) : undefined;
		if (got && 'agent' in got && got.agent) { return got.agent; }
		throw new RoomError(`会话不可用：${sessionId}`, 503);
	}
	async function mark(agent, data) {
		const append = await deps.append();
		if (typeof append !== 'function' || !agent?.session) { return false; }
		try { append(agent.session, ROOM_RECORD_TYPE, roomRecordData(data)); return true; } catch (error) {
			warn(`群标记没写上（${String(error?.message ?? error)}）`);
			return false;
		}
	}
	async function renameSession(sessionId, title) {
		try { await deps.sessions()?.rename?.({ sessionId, title }); } catch (error) { warn(`会话改名失败：${String(error?.message ?? error)}`); }
	}
	/** 新会话放进哪：指定工作区 > 指定目录 > 第一个工作区 > 兜底目录。 */
	async function placeOf({ workspaceId, cwd }) {
		if (workspaceId) { return { workspaceId }; }
		const reg = deps.workspaces?.();
		if (cwd && reg && typeof reg.create === 'function') {
			const ws = await reg.create(cwd);
			if (ws?.id) { return { workspaceId: ws.id }; }
		}
		const first = reg && typeof reg.list === 'function' ? reg.list().find(ws => ws && ws.id) : undefined;
		if (first) { return { workspaceId: first.id }; }
		return { cwd: cwd || deps.fallbackCwd };
	}
	async function openSession(place, agentPreset) {
		const sc = deps.sessions();
		if (typeof sc?.create !== 'function') { throw new RoomError('这个 dsh 组合里没有 sessionController，建不了群会话。', 503); }
		const created = await sc.create({ ...place, ...(agentPreset ? { agentPreset } : {}) });
		const sessionId = String(created?.sessionId ?? '').trim();
		if (!sessionId) { throw new RoomError('会话建好了但没回 sessionId（dsh 版本不匹配？）。', 500); }
		return sessionId;
	}

	/** 成员在这个群里的影子会话（没有就建；跑该 bot 的 preset，与群同一工作区）。 */
	async function memberSession(room, botId, name) {
		const known = room.sessions[botId];
		if (known) {
			try {
				const agent = await resolveAgent(known);
				api.attachMember?.(agent, room.id, botId);
				return { sessionId: known, agent };
			} catch { /* 会话没了 ⇒ 重建 */ }
		}
		const sessionId = await openSession(room.workspaceId ? { workspaceId: room.workspaceId } : { cwd: room.cwd || deps.fallbackCwd }, deps.presetOf(botId));
		const agent = await resolveAgent(sessionId);
		await mark(agent, { roomId: room.id, role: 'member', botId });
		await renameSession(sessionId, `${name} · ${room.name}`);
		room.sessions[botId] = sessionId;
		api.attachMember?.(agent, room.id, botId);
		void save();
		return { sessionId, agent };
	}
	/**
	 * 等影子会话消费掉 `messageId` 的那个回合结束。
	 * ★ 2026-11-06（真机：「开始制作番茄钟 H5」Coder 写了 12 分钟代码，群在第 240 秒就判它没回答，它的回复随后丢失）：
	 *   超时改成**看进展**——成员会话每产生一个事件（工具调用、步骤）就重新计时（`noteActivity`），
	 *   `timeoutMs` 内毫无动静才算超时；另有硬上限 `maxWaitMs`。超时后仍登记为迟到（`late`），
	 *   成员之后干完时把回复记进群聊记录，不再丢失。
	 * @returns 成员最后一段话；超时 ⇒ `{ timeout: 'idle' | 'cap' }`
	 */
	function waitFor(sessionId, messageId, meta = {}) {
		return new Promise(resolve => {
			const drop = () => { waiters.set(sessionId, (waiters.get(sessionId) ?? []).filter(item => item !== entry)); };
			const giveUp = (kind) => {
				clearTimeout(entry.idle);
				clearTimeout(entry.cap);
				clearTimeout(entry.grace);
				drop();
				late.set(sessionId, [...(late.get(sessionId) ?? []).filter(item => now() - item.at < maxWaitMs), { messageId, at: now(), ...meta, ...(kind === 'working' ? { released: true } : {}) }]);
				resolve({ timeout: kind });
			};
			const entry = {
				messageId,
				resolve: (value) => { clearTimeout(entry.idle); clearTimeout(entry.cap); clearTimeout(entry.grace); resolve(value); },
				touch: (event) => {
					clearTimeout(entry.idle);
					// 等人审批时成员不会产生事件，但不是「没有进展」⇒ 到点了再看一眼，有待审批就接着等
					const idle = () => { if (pendingFor(sessionId)) { entry.idle = setTimeout(idle, timeoutMs); } else { giveUp('idle'); } };
					entry.idle = setTimeout(idle, timeoutMs);
					// ★ 2026-11-06（P2，对齐 DS Bot ROOM_WORK_GRACE_MS）：成员开始调用工具后再等 `releaseMs` 还没干完 ⇒
					//   这一轮不再等它（`working`），它在后台接着干；干完时 noteTurnEnd 把结果记进群聊并新开一轮叫回派活的人。
					if (releaseMs > 0 && meta.releasable && !entry.grace && event?.type === 'tool/call') {
						entry.grace = setTimeout(() => { if (!pendingFor(sessionId)) { giveUp('working'); } else { entry.grace = undefined; } }, releaseMs);
					}
				},
			};
			entry.touch();
			entry.cap = setTimeout(() => giveUp('cap'), Math.max(timeoutMs, maxWaitMs));
			waiters.set(sessionId, [...(waiters.get(sessionId) ?? []), entry]);
		});
	}

	const pendingFor = (sessionId) => [...approvals.values()].some(item => item.sessionId === sessionId);
	/** 这个会话（或它的子代理，最多往上 4 层）是哪个群的哪位成员；不是群成员 ⇒ undefined。 */
	function memberOfSession(agent) {
		let id = agent?.id ?? agent?.session?.id;
		let current = agent;
		for (let depth = 0; id && depth < 5; depth += 1) {
			for (const room of rooms.values()) {
				const botId = Object.keys(room.sessions ?? {}).find(key => room.sessions[key] === id);
				if (botId) { return { room, botId }; }
			}
			const parent = current?.session?.header?.parentSession;
			if (!parent) { return undefined; }
			id = String(parent);
			current = deps.agents()?.get?.(id);
		}
		return undefined;
	}
	/** 这次调用要做什么（给人看）：命令 / 路径 / 地址，取工具调用的参数。 */
	function callDetailOf(agent, callId) {
		try {
			const session = agent?.session;
			const to = typeof session?.seq === 'number' ? session.seq : 0;
			const events = to > 0 && typeof session.snapshotEvents === 'function' ? Array.from(session.snapshotEvents(Math.max(0, to - 200), to)) : [];
			for (let index = events.length - 1; index >= 0; index -= 1) {
				const data = events[index]?.type === 'tool/call' ? events[index].data : undefined;
				if (!data || (callId && data.callId !== callId && data.id !== callId)) { continue; }
				let args = data.arguments ?? data.input ?? {};
				if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = { text: args }; } }
				const pick = ['command', 'cmd', 'script', 'file_path', 'path', 'url', 'text'].map(key => args?.[key]).find(value => typeof value === 'string' && value.trim());
				return pick ? clipLine(String(pick)).slice(0, 400) : '';
			}
		} catch { /* 读不到就不写 */ }
		return '';
	}
	/**
	 * DSH `approval/request`（排在 DSH 自带的审批框之前）：群成员的请求由群接住，其余照常往下交。
	 * @returns DSH 的审批结果：`allowed-once` / `rejected` / `cancelled`
	 */
	async function decideApproval(request, next) {
		await load();
		const found = memberOfSession(request?.agent);
		if (!found) { return next(); }
		if (request.signal?.aborted) { return 'cancelled'; }
		const { room, botId } = found;
		const { map } = await names();
		const name = map.get(botId) ?? botId;
		const id = uuid();
		const code = approvalCode();
		const tool = String(request.toolName ?? '工具');
		const detail = callDetailOf(request.agent, request.callId) || String(request.reason ?? '').slice(0, 400);
		const round = [...rounds.values()].find(item => item.roomId === room.id && !item.done);
		return new Promise(resolve => {
			let timer;
			const settle = (outcome, text) => {
				if (!approvals.delete(id)) { return false; }
				clearTimeout(timer);
				request.signal?.removeEventListener?.('abort', aborted);
				if (round && text) { pushEvent(round, outcome === 'allowed-once' ? 'working' : 'failed', { name, text }); }
				void save();
				resolve(outcome);
				return true;
			};
			const aborted = () => { settle('cancelled'); };
			approvals.set(id, { id, code, roomId: room.id, botId, name, tool, detail, reason: String(request.reason ?? '').slice(0, 300),
				at: now(), sessionId: String(request.agent?.id ?? ''), settle });
			request.signal?.addEventListener?.('abort', aborted, { once: true });
			timer = setTimeout(() => { settle('rejected', `${name} 的「${detail || tool}」等了 ${Math.round(approvalMaxMs / 60_000)} 分钟没人批，已拒绝`); }, approvalMaxMs);
			timer.unref?.();
			if (round) { pushEvent(round, 'approval', { name, approvalId: id, code, text: `${name} 要运行「${detail || tool}」，等你批准` }); }
			void save();
		});
	}

	/** 状态节点单独放 `round.events`，不混进 `replies` ⇒ 旧的成员气泡/结果 JSON 口径不变。 */
	function pushEvent(round, kind, data = {}) {
		const type = ROOM_STATUS_KINDS.includes(kind) ? kind : 'failed';
		const event = { kind: type, at: now(), ...data };
		(round.events ??= []).push(event);
		void save(); // ★ 每条状态节点即时落盘，重启后不丢执行过程（DS Bot appendRoom + rt.save() 同口径）
		return event;
	}

	/** 一个成员说一次。返回它说的话（沉默 / 失败 ⇒ null）。 */
	async function turn(room, slot, round, members, place, signal) {
		const member = members.find(m => m.id === slot.id) ?? { id: slot.id, name: slot.id };
		round.speaking.add(member.name);
		void save();
		const started = now();
		let workTimer;
		try {
			if (signal?.aborted) { return null; }
			const { sessionId, agent } = await memberSession(room, member.id, member.name);
			const nameOf = (id) => members.find(m => m.id === id)?.name ?? id;
			const goal = goalPromptBlock(room.goal, member.id, member.id === room.admin, nameOf);
			const text = roomPrompt({ room, member, members, log: room.log, seen: room.seen[member.id], place, calledBy: slot.by, note: slot.note })
				+ (goal ? `\n\n${goal}` : '');
			room.seen[member.id] = room.seq;
			// 管理员 @ 它 ⇒ 它在当前阶段的任务「进行中」
			if (room.goal && slot.byId === room.admin && markTask(room.goal, member.id, ['pending'], 'working')) { touchGoal(room); }
			const messageId = uuid();
			const done = waitFor(sessionId, messageId, { roomId: room.id, botId: member.id, name: member.name,
				releasable: true, askedBy: slot.byId && slot.byId !== member.id ? slot.byId : undefined });
			const grace = Math.max(1, Math.min(workGraceMs, timeoutMs));
			workTimer = setTimeout(() => pushEvent(round, 'working', { name: member.name, text: `${member.name} 开始做了，还在工作…` }), grace);
			workTimer.unref?.();
			const message = { id: messageId, role: 'user', content: [{ type: 'text', text }], source: { kind: ROOM_TURN_KIND, room: room.id } };
			if (typeof agent.followup === 'function') { agent.followup(message); } else if (typeof agent.steer === 'function') { agent.steer(message); } else {
				throw new RoomError('成员会话不支持 followup（dsh 版本不匹配？）');
			}
			const final = await done;
			if (final && typeof final === 'object' && final.timeout === 'working') {
				// 放行到后台：不算失败，这一轮照常往下走
				slot.worked = true;
				slot.released = true;
				round.working = [...(round.working ?? []), member.name];
				pushEvent(round, 'working', { name: member.name, text: `${member.name} 还在干活，这一轮先不等它；干完后会把结果发到群里并接着往下走` });
				return null;
			}
			if (final && typeof final === 'object' && final.timeout) {
				const reason = final.timeout === 'cap'
					? `超过 ${Math.round(maxWaitMs / 60_000)} 分钟仍未完成`
					: `${Math.round(timeoutMs / 1000)} 秒没有任何进展`;
				round.failed.push({ botId: member.id, name: member.name, reason });
				pushEvent(round, 'missed', { name: member.name, text: `${member.name} 没能按时回答（${reason}；它干完后的回复会记进群聊记录）` });
				return null;
			}
			slot.worked = final?.worked === true;
			const said = stripOwnName(final?.text ?? '', member.name);
			if (isPass(said)) {
				round.passed.push(member.name);
				pushEvent(round, 'passed', { name: member.name, text: `${member.name} 没有补充` });
				return null;
			}

			const line = appendLog(room, { who: member.name, botId: member.id, text: clipLine(said) });
			room.seen[member.id] = room.seq;
			// 管理员派的活交回了 ⇒ 它在当前阶段的任务「已交付」
			if (room.goal && slot.byId === room.admin && member.id !== room.admin && markTask(room.goal, member.id, ['pending', 'working'], 'reported')) { touchGoal(room); }
			round.replies.push({ botId: member.id, name: member.name, text: line.text, at: line.at, ms: line.at - started,
				...(final?.interrupted ? { interrupted: true } : {}) });
			void save();
			return said;
		} catch (error) {
			const reason = String(error?.message ?? error).slice(0, 300);
			round.failed.push({ botId: member.id, name: member.name, reason });
			pushEvent(round, 'failed', { name: member.name, text: `${member.name} 没能回答：${reason}` });
			return null;
		} finally {
			if (workTimer) { clearTimeout(workTimer); }
			round.speaking.delete(member.name);
			void save();
		}
	}

	/** 群目标改了：记修订、落盘（UI 读 room.goal）。 */
	function touchGoal(room) {
		if (!room.goal) { return; }
		room.goal.updatedAt = now();
		room.goal.revision = (room.goal.revision ?? 0) + 1;
		void save();
	}
	/**
	 * ★ 2026-11-06：系统要群「新开一轮」叫回某位成员（后台成员干完了 / 目标检查）。
	 * 做法与 `postToRoom` 一样：往群会话写一条消息，relayStream 合成 group_relay，relay 从 `callbacks` 取到要叫的人。
	 * 消息走 `source.kind='user'` + `form: room-callback`，用户消息收件箱会跳过它（只靠 callbacks 驱动）。
	 * 同一个群同时只排一条（后来的合并进去）；群会话没在这个 Host 上 ⇒ 不叫（只记日志里已有的结果）。
	 */
	async function kickRoom(room, call) {
		const list = callbacks.get(room.id) ?? [];
		const merged = list.some(item => item.id === call.id);
		callbacks.set(room.id, merged ? list : [...list, call]);
		if (list.length) { return; }
		try {
			const agent = await resolveAgent(room.id);
			api.attach?.(agent);
			const message = { id: uuid(), role: 'user', content: [{ type: 'text', text: call.text }],
				source: { kind: 'user', form: ROOM_CALLBACK_FORM, roomId: room.id } };
			if (typeof agent?.followup === 'function') { await Promise.resolve(agent.followup(message)); }
			else if (typeof agent?.steer === 'function') { await Promise.resolve(agent.steer(message)); }
		} catch (error) {
			callbacks.delete(room.id);
			warn(`群「${room.name}」新开一轮失败：${String(error?.message ?? error)}`);
		}
	}
	/**
	 * ★ 2026-11-06（P1，对齐 DS Bot goalDrive）：一轮结束、群里没人在干活、目标还没完成 ⇒ 叫醒管理员做目标检查。
	 * 有进展（用户说话、成员干了活）就把计数清零；连续 GOAL_IDLE_NUDGES 次没有进展 ⇒ 标成 idle，停下等用户。
	 * 管理员在目标检查里回 [PASS]（在等用户）⇒ 同样停下。
	 */
	function driveGoal(room, round) {
		const goal = room.goal;
		if (!goal || goal.status !== 'active' || goal.idle || !room.admin || !room.members.includes(room.admin)) { return; }
		if (round.interrupted || round.error) { return; }
		const adminName = round.adminName;
		if (round.goalNudge && round.passed.includes(adminName)) { goal.idle = true; touchGoal(room); return; }
		if (round.userMessage || round.memberWorked) { goal.nudges = 0; }
		if (busyIn(room) || (callbacks.get(room.id) ?? []).length || (inbox.get(room.id) ?? []).length) { return; }
		if ((goal.nudges ?? 0) >= GOAL_IDLE_NUDGES) { goal.idle = true; touchGoal(room); return; }
		goal.nudges = (goal.nudges ?? 0) + 1;
		touchGoal(room);
		void kickRoom(room, { id: room.admin, goalNudge: true, text: '【目标检查】', note: GOAL_NUDGE_TEXT, event: '目标检查：群里没人在干活，目标还没完成' });
	}
	/**
	 * ★ 2026-11-06：迟到回复里 @ 到的其他成员 ⇒ 新开一轮叫他们（`from` = 说这句话的成员，relay 里成一批，做完叫回它）。
	 * 和本轮内的接力用同一个判据（`callsFrom`：只叫群里的人、不叫自己，管理员的 @所有人 有效）。
	 */
	async function callNamed(room, item, said) {
		try {
			const { map } = await names();
			const members = room.members.map(id => ({ id, name: map.get(id) ?? id }));
			const ids = callsFrom(room, item.botId, said, members, new Map());
			// 同步地一个接一个排进 callbacks（kickRoom 只在第一条时发消息）⇒ 这一批人在同一轮里被叫到
			await Promise.all(ids.map(id => kickRoom(room, { id, from: item.botId, text: `【${item.name} 点了 ${map.get(id) ?? id}】`,
				note: `${item.name} 在群里点了你（它刚才在后台干活，发言在上面的群聊记录里）：按它说的做，做完在群里回复。`,
				event: `${item.name} 在迟到回复里点了 ${map.get(id) ?? id}` })));
		} catch (error) { warn(`群「${room.name}」叫迟到回复里点到的成员失败：${String(error?.message ?? error)}`); }
	}
	/** 这个群有成员在后台干活（被放行、还没交回）。 */
	function busyIn(room) {
		return Object.values(room.sessions ?? {}).some(sid => (late.get(sid) ?? []).some(item => item.roomId === room.id && item.released));
	}

	/**
	 * 叫这个名字的群（去首尾空白、不分大小写；已经有多个同名的取最近改过的那个）。空名 ⇒ undefined。
	 * ★ 2026-11-06：建群时用它把「同名再建」变成「在已有的群里编辑」，改名时用它拒绝撞名。
	 */
	function sameNameRoom(name) {
		const key = String(name ?? '').trim().toLowerCase();
		if (!key) { return undefined; }
		return [...rooms.values()].filter(room => String(room.name ?? '').trim().toLowerCase() === key)
			.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0))[0];
	}
	/**
	 * 在已有的同名群里按这次建群的要求编辑：成员换成这次给的（加进新的、移出没列的），给了公告 / 模式 / 管理员才改；
	 * 原管理员还在群里就留着。群如果被藏起来了，重新露出来。
	 * @returns 群视图，另带 `reused: true` 与 `added` / `removed`（成员名）
	 */
	async function reuseRoom(room, input, norm, map) {
		const before = [...room.members];
		const given = (value) => value !== undefined && value !== null && String(value).trim() !== '';
		const admin = given(input?.admin) ? input.admin : norm.members.includes(room.admin) ? room.admin : '';
		await api.update(room.id, {
			members: norm.members, admin, name: room.name,
			...(given(input?.notice) ? { notice: input.notice } : {}),
			...(given(input?.mode) ? { mode: input.mode } : {}),
		});
		if (room.hidden) { room.hidden = false; await save(); }
		const nameOf = (id) => map.get(id) ?? id;
		return { ...roomView(room, map), reused: true,
			added: room.members.filter(id => !before.includes(id)).map(nameOf),
			removed: before.filter(id => !room.members.includes(id)).map(nameOf) };
	}

	const api = {
		load,
		/** 等所有排队的写落盘（测试用来断言盘上状态）。 */
		flush,
		/** 卸载：写完再交还租约（installRooms 的 dispose 调）。 */
		close,
		/** 存储状态诊断：是否可写、为什么只读。 */
		storage: () => ({ writable: !frozen, reason: frozenReason || null, leaseFile }),
		/** installRooms 设置：给群会话的 agent 挂 group_relay。 */
		attach: deps.attach,
		/** 群会话 / 成员影子会话的判定（同步；install 时已 load）。 */
		isRoom: (sessionId) => rooms.has(String(sessionId ?? '')),
		/** 纯文本 `@群名` 的兜底：按群名找群（大小写不敏感）。 */
		roomByName(name) {
			const key = String(name ?? '').trim().toLowerCase();
			if (!key) { return undefined; }
			for (const room of rooms.values()) {
				if (String(room.name ?? '').trim().toLowerCase() === key) { return room.id; }
			}
			return undefined;
		},
		ownerOf(sessionId) {
			for (const room of rooms.values()) {
				for (const [botId, sid] of Object.entries(room.sessions ?? {})) {
					if (sid === sessionId) { return { roomId: room.id, botId }; }
				}
			}
			return undefined;
		},
		async list() {
			await load();
			const { map } = await names();
			return sortRooms([...rooms.values()].map(room => roomView(room, map)));
		},
		async get(id) {
			await load();
			const { map } = await names();
			return roomView(need(id), map);
		},
		/**
		 * 建群。
		 * @param input `{ members, name?, notice?, admin?, mode? }`
		 * @param options `{ createdBy?, workspaceId?, cwd?, originTriggerId? }`
		 * ★ 2026-11-05 P0：带 `originTriggerId` 时按它幂等 —— 同一个 SuperAgent trigger 的
		 *   desk 自动 intake / superagent_submit / 主管模型工具调用只会在第一次真的建会话。
		 */
		async create(input, options = {}) {
			await load();
			const { roster, map } = await names();
			const origin = typeof options.originTriggerId === 'string' && options.originTriggerId ? options.originTriggerId : '';
			if (origin) {
				const existing = [...rooms.values()].find(room => room.originTriggerId === origin);
				if (existing) { return roomView(existing, map); }
			}
			const norm = normalizeRoomInput(input, roster);
			// ★ 2026-11-06（真机：两个「番茄钟 H5 开发团队」并排）：给了群名且已有同名群 ⇒ 在那个群里编辑（加 / 减成员、
			//   公告、模式），不再另建。没给群名（自动起名）的照常新建。
			const same = sameNameRoom(input?.name);
			if (same) { return reuseRoom(same, input, norm, map); }
			const place = await placeOf(options);
			const sessionId = await openSession(place);
			const agent = await resolveAgent(sessionId);
			const at = now();
			const room = {
				id: sessionId, ...norm, pinned: false, hidden: false, createdAt: at, updatedAt: at,
				createdBy: options.createdBy ? String(options.createdBy) : null,
				...(origin ? { originTriggerId: origin } : {}),
				...(place.workspaceId ? { workspaceId: place.workspaceId } : { cwd: place.cwd }),
				log: [], seq: 0, seen: {}, sessions: {},
			};
			rooms.set(room.id, room);
			await mark(agent, { roomId: room.id, role: 'room' });
			api.attach?.(agent);
			await renameSession(sessionId, room.name);
			await save();
			return roomView(room, map);
		},
		/** 改群名 / 公告 / 模式 / 管理员 / 成员（只改给了的字段）。 */
		async update(id, patch = {}) {
			await load();
			const room = need(id);
			if (patch.name !== undefined) {
				const clash = sameNameRoom(patch.name);
				if (clash && clash.id !== room.id) { throw new RoomError(`已经有一个叫「${clash.name}」的群了，换个名字。`, 409); }
			}
			const { roster, map } = await names();
			const next = normalizeRoomInput({
				members: Array.isArray(patch.members) ? patch.members : room.members,
				name: patch.name !== undefined ? patch.name : (room.named ? room.name : ''),
				notice: patch.notice !== undefined ? patch.notice : room.notice,
				admin: patch.admin !== undefined ? patch.admin : room.admin,
				mode: patch.mode !== undefined ? patch.mode : room.mode,
			}, roster.concat(room.members.filter(mid => !roster.some(bot => bot.id === mid)).map(mid => ({ id: mid, name: map.get(mid) ?? mid }))));
			const removed = room.members.filter(mid => !next.members.includes(mid));
			const renamed = next.name !== room.name;
			Object.assign(room, next, { updatedAt: now() });
			for (const mid of removed) {
				const sid = room.sessions[mid];
				delete room.sessions[mid];
				delete room.seen[mid];
				if (sid) { await deps.workspaces?.()?.archiveSession?.(sid).catch?.(() => undefined); }
			}
			if (renamed) { await renameSession(room.id, room.name); }
			await save();
			return roomView(room, map);
		},
		/** 置顶 / 从侧栏隐藏。 */
		async setFlags(id, flags = {}) {
			await load();
			const room = need(id);
			if (typeof flags.pinned === 'boolean') { room.pinned = flags.pinned; }
			if (typeof flags.hidden === 'boolean') { room.hidden = flags.hidden; }
			await save();
			const { map } = await names();
			return roomView(room, map);
		},
		/** 删群：群会话与成员影子会话归档（日志留着），记录删除。 */
		async remove(id) {
			await load();
			const room = need(id);
			rooms.delete(room.id);
			inbox.delete(room.id);
			for (const [callId, round] of rounds) { if (round.roomId === room.id && round.done) { rounds.delete(callId); } }
			const reg = deps.workspaces?.();
			for (const sid of [room.id, ...Object.values(room.sessions ?? {})]) {
				try { await reg?.archiveSession?.(sid); } catch (error) { warn(`归档 ${sid} 失败：${String(error?.message ?? error)}`); }
			}
			await save();
			return { ok: true, id: room.id };
		},
		/** 群会话里人的新消息（`session/event` 的 user/message，source.kind==='user'）。 */
		noteUserMessage(sessionId, text) {
			if (!rooms.has(sessionId)) { return; }
			const body = String(text ?? '').trim();
			if (body) { inbox.set(sessionId, [...(inbox.get(sessionId) ?? []), body]); }
		},
		/**
		 * ★ 2026-11-05（对齐 DS Bot `post_to_group`）：把别的会话 `@群 / 引用会话` 的指令**真正写进群会话**。
		 * 落进去的是 source.kind='user' 的 user/message ⇒ installRooms 自动进群收件箱、relayStream 自动合成
		 * group_relay；不直接塞 inbox，避免「界面没消息、工具卡也没得画」。不会唤醒主管模型。
		 */
		async postToRoom(roomId, text, meta = {}) {
			await load();
			const room = need(roomId);
			const body = String(text ?? '').trim() || '开始协作';
			const agent = await resolveAgent(room.id);
			api.attach?.(agent);
			// ★ 2026-11-06 幂等：同一条来源消息转投到同一个群只算一次（多窗口 / 事件重放 / 两条路径都想转投）。
			//   id 由来源决定，转投前先查群会话的待处理队列和已落盘历史——与 SuperAgent AgentDelivery 同一做法。
			const fromSession = meta.fromSession ? String(meta.fromSession) : '';
			const sourceMessageId = meta.sourceMessageId ? String(meta.sourceMessageId) : '';
			const messageId = fromSession && sourceMessageId ? roomPostId(fromSession, sourceMessageId) : uuid();
			if (fromSession && sourceMessageId && holdsMessage(agent, messageId)) {
				return { ok: true, duplicate: true, roomId: room.id, name: room.name, messageId, text: body };
			}
			const message = {
				id: messageId, role: 'user', content: [{ type: 'text', text: body }],
				source: {
					kind: 'user', form: ROOM_POST_FORM, roomId: room.id,
					...(meta.fromSession ? { fromSession: String(meta.fromSession) } : {}),
					...(meta.sourceMessageId ? { sourceMessageId: String(meta.sourceMessageId) } : {}),
					...(meta.roomLabel ? { roomLabel: String(meta.roomLabel) } : {}),
				},
			};
			if (typeof agent?.followup === 'function') { await Promise.resolve(agent.followup(message)); }
			else if (typeof agent?.steer === 'function') { await Promise.resolve(agent.steer(message)); }
			else { throw new RoomError('群会话不支持 followup（dsh 版本不匹配？）', 503); }
			postMeta.set(room.id, correlationOf({ fromSession, sourceMessageId }));
			return { ok: true, roomId: room.id, name: room.name, messageId, text: body };
		},
		/** DSH `approval/request` 的处理（installRooms 以 prepend 挂上）。 */
		decideApproval,
		/** 群里正在等人确认的请求（不传 roomId = 全部）。 */
		pendingApprovals(roomId) {
			return roomId ? approvalsOf(roomId) : [...new Set([...approvals.values()].map(item => item.roomId))].flatMap(approvalsOf);
		},
		/**
		 * 人回答一条审批：`allow` 允许这一次，`reject` 拒绝。
		 * @throws RoomError 404 —— 已经回答过、超时或成员已停下
		 */
		answerApproval(id, choice) {
			const item = approvals.get(String(id ?? ''));
			if (!item) { throw new RoomError('这条审批已经不在等了（可能已处理、超时，或成员已停下）。', 404); }
			const allow = choice === 'allow';
			item.settle(allow ? 'allowed-once' : 'rejected', `${item.name} 的「${item.detail || item.tool}」${allow ? '已允许，继续执行' : '已拒绝'}`);
			const { settle: _settle, sessionId: _sessionId, ...view } = item;
			return { ...view, choice: allow ? 'allow' : 'reject' };
		},
		/** 成员影子会话有新事件（工具调用、步骤…）：它还在干活 ⇒ 等它的那条重新计时。 */
		noteActivity(sessionId, event) {
			for (const entry of waiters.get(sessionId) ?? []) { entry.touch?.(event); }
		},
		/** 影子会话回合结束：把等它的那条结果交出去；群已经不等了的（迟到）记进群聊记录。 */
		noteTurnEnd(session) {
			const list = waiters.get(session?.id) ?? [];
			const overdue = late.get(session?.id) ?? [];
			if ((!list.length && !overdue.length) || typeof session.snapshotEvents !== 'function') { return; }
			let events;
			try {
				const from = seenSeq.get(session.id) ?? 0;
				const to = typeof session.seq === 'number' ? session.seq : 0;
				events = to > from ? Array.from(session.snapshotEvents(from, to)) : [];
				seenSeq.set(session.id, to);
			} catch { return; }
			const left = [];
			for (const entry of list) {
				if (findOurSplices(events, new Set([entry.messageId])).length) {
					const final = finalAssistantText(events);
					entry.resolve(final ? { ...final, worked: turnWorked(events) } : final);
				} else { left.push(entry); }
			}
			waiters.set(session.id, left);
			const stillLate = [];
			const finished = [];
			for (const item of overdue) {
				if (!findOurSplices(events, new Set([item.messageId])).length) { stillLate.push(item); continue; }
				const room = rooms.get(item.roomId);
				const said = stripOwnName(finalAssistantText(events)?.text ?? '', item.name);
				if (!room) { continue; }
				if (said && !isPass(said)) {
					appendLog(room, { who: item.name, botId: item.botId, text: clipLine(said), late: true });
					room.seen[item.botId] = room.seq;
					if (room.goal && item.askedBy === room.admin && markTask(room.goal, item.botId, ['pending', 'working'], 'reported')) { touchGoal(room); }
					void save();
					// ★ 2026-11-06（真机：「@番茄钟 H5 开发团队 开发H5 番茄钟」管理员 Coder 干了 5 分钟、迟到回复里 @Designer @Tester
					//   派活，两人从没被叫到，需求停在半路）：对齐 DS Bot lateRoomReply「派活的人**和它点到的人**接着答」——
					//   迟到回复里 @ 到的成员新开一轮去做；他们做完再叫回这位成员看结果（relay 里按 `from` 成批）。
					void callNamed(room, item, said);
				}
				if (item.released) { finished.push({ room, item, said: said && !isPass(said) ? said : '' }); }
				}
				if (stillLate.length) { late.set(session.id, stillLate); } else { late.delete(session.id); }
			// ★ 2026-11-06（P2，对齐 DS Bot lateRoomReply）：放行到后台的成员干完了 ⇒ 新开一轮，叫回派活的人
			//   （没有派活人 / 派活人已不在群里 ⇒ 有进行中的目标时叫管理员，否则只记进群聊）。
			for (const { room, item, said } of finished) {
				const by = item.askedBy && room.members.includes(item.askedBy) ? item.askedBy
					: room.goal?.status === 'active' && room.admin && room.admin !== item.botId ? room.admin : undefined;
				if (!by) { continue; }
				const done = said ? `${item.name} 完成了工作` : `${item.name} 干完了，没有补充`;
				void kickRoom(room, { id: by, text: `【${done}】`, note: `${done}（它刚才在后台干活，结果在上面的群聊记录里）。看结果再决定下一步：需要返工就 @ 对方说清问题。`,
					event: `${done}，接着往下走` });
			}
		},
		/**
		 * 一轮转发（`group_relay` 的实现）。
		 * @returns 本轮结果 `{ room, replies, passed, failed }`
		 */
		async relay(roomId, callId, signal) {
			await load();
			const room = need(roomId);
			const texts = inbox.get(room.id) ?? [];
			inbox.delete(room.id);
			for (const text of texts) { appendLog(room, { who: '用户', text: clipLine(text) }); }
			// ★ 2026-11-06：系统要「新开一轮」叫回的人（后台成员干完了 / 目标检查），与人的消息一起处理
			const calls = callbacks.get(room.id) ?? [];
			callbacks.delete(room.id);
			const { map } = await names();
			const members = room.members.map(id => ({ id, name: map.get(id) ?? id }));
			const round = { callId, roomId: room.id, replies: [], passed: [], failed: [], events: [], error: '',
				speaking: new Set(), startedAt: now(), finishedAt: 0, done: false, phase: 'running', interrupted: false, persisted: false,
				...correlationOf({ originTriggerId: room.originTriggerId }), ...(postMeta.get(room.id) ?? {}) };
			postMeta.delete(room.id);
			const previous = [...rounds.values()].find(item => item.roomId === room.id && !item.done);
			if (previous) { pushEvent(previous, 'paused', { text: '新的群消息到达，上一轮暂停' }); }
			rounds.set(String(callId ?? ''), round);
			if (previous) { pushEvent(round, 'resumed', { text: '接上新一轮群消息' }); }
			pushEvent(round, 'working', { text: '正在把消息交给群成员…' });
			void save();
			try {
				if (texts.length || calls.length) {
					const open = texts.length ? openingCall(room, mentionsIn(texts.join('\n'), members)) : { ids: [], ordered: false };
					const counts = new Map();
					const pending = open.ids.map((id, index) => ({ id, by: '用户', index }));
					// 系统回叫：人的消息没有点到它时才加（点到了就和人的消息一起答）
					// ★ 2026-11-06：迟到回复点到的人（`from` = 点人的成员）按点人的成员成批，这批做完叫回它（settleBatch）。
					const lateBatches = new Map();
					for (const call of calls) {
						if (!room.members.includes(call.id) || pending.some(slot => slot.id === call.id)) { continue; }
						if (call.from && room.members.includes(call.from) && call.from !== call.id) {
							const batch = lateBatches.get(call.from) ?? { by: call.from, pending: new Set(), done: [], worked: false, answered: false };
							lateBatches.set(call.from, batch);
							const slot = { id: call.id, by: map.get(call.from) ?? call.from, byId: call.from, note: call.note, batch };
							batch.pending.add(slot);
							pending.push(slot);
						} else {
							pending.push({ id: call.id, by: '群', note: call.note });
						}
						pushEvent(round, 'working', { name: map.get(call.id) ?? call.id, text: call.from ? call.event : `${call.event}（叫回 ${map.get(call.id) ?? call.id}）` });
					}
					round.userMessage = texts.length > 0;
					round.goalNudge = calls.some(call => call.goalNudge) && !texts.length;
					round.adminName = map.get(room.admin) ?? room.admin;
					for (const slot of pending) { counts.set(slot.id, (counts.get(slot.id) ?? 0) + 1); }
					// ★ 2026-11-06（对齐 DS Bot groups.js callFrom / batch）：
					//   · 不再写死「每人 2 次、bot 互叫 6 次」：只拦**连续 ROOM_IDLE_RELAY_LIMIT 次没干活的接力**（附和、复读），
					//     有人真干活（调用过工具）就清零 ⇒ 「测试→打回开发→复测」可以走多轮；另有总上限 ROOM_LIMITS.botCalls 防失控。
					//   · 批次：成员 @ 了一批人，这批人都说完、有人干过活、且都没再 @ 人 ⇒ 自动把派活的人叫回来看结果。
					let botCalls = 0;
					let idleRelays = 0;
					const nameOf = id => map.get(id) ?? id;
					const settleBatch = (slot) => {
						const batch = slot.batch;
						if (!batch) { return; }
						batch.pending.delete(slot);
						if (slot.posted) { batch.done.push(nameOf(slot.id)); }
						if (slot.worked) { batch.worked = true; }
						if (slot.calledOthers) { batch.answered = true; }
						// 放行到后台的成员还没干完：这批人里有它 ⇒ 不在本轮叫回，等它干完时新开一轮再叫（noteTurnEnd）
						if (slot.released) { batch.released = true; }
						if (batch.pending.size || batch.released || !batch.done.length || !batch.worked || batch.answered || signal?.aborted) { return; }
						if (!room.members.includes(batch.by) || pending.some(item => item.id === batch.by)) { return; }
						if (botCalls >= ROOM_LIMITS.botCalls) { return; }
						botCalls += 1;
						pending.push({ id: batch.by, by: '群', note: `${batch.done.join('、')} 完成了你交代的工作，看结果再决定下一步（需要返工就 @ 对方说清问题）。` });
						pushEvent(round, 'working', { name: nameOf(batch.by), text: `${batch.done.join('、')} 完成了 ${nameOf(batch.by)} 交代的工作，叫回 ${nameOf(batch.by)}` });
					};
					let paused = false;
					await new Promise(resolveRound => {
						const running = new Set();
						const pump = () => {
							while (pending.length && (!open.ordered || running.size === 0) && !signal?.aborted) {
								const slot = pending.shift();
								const place = open.ordered && slot.by === '用户'
									? { ordered: true, index: slot.index, total: open.ids.length }
									: { ordered: false, with: open.ordered ? [] : open.ids.filter(id => id !== slot.id).map(nameOf) };
								const job = turn(room, slot, round, members, place, signal).then(said => {
									running.delete(job);
									slot.posted = !!said;
									if (slot.worked && slot.id !== room.admin) { round.memberWorked = true; }
									const callees = said && !paused ? callsFrom(room, slot.id, said, members, counts) : [];
									if (callees.length && slot.by !== '用户' && !slot.worked) { idleRelays += 1; } else if (slot.worked) { idleRelays = 0; }
									if (callees.length && idleRelays >= ROOM_IDLE_RELAY_LIMIT) {
										paused = true;
										pushEvent(round, 'paused', { name: nameOf(slot.id),
											text: `成员之间连续 ${ROOM_IDLE_RELAY_LIMIT} 次只是互相接话、没有干活，先停下；你发一条消息就继续` });
									} else if (callees.length) {
										const batch = { by: slot.id, pending: new Set(), done: [], worked: false, answered: false };
										for (const id of callees) {
											if (botCalls >= ROOM_LIMITS.botCalls) { break; }
											botCalls += 1;
											counts.set(id, (counts.get(id) ?? 0) + 1);
											const next = { id, by: nameOf(slot.id), byId: slot.id, batch };
											batch.pending.add(next);
											pending.push(next);
										}
										if (batch.pending.size) { slot.calledOthers = true; }
									}
									settleBatch(slot);
									pump();
								});
								running.add(job);
							}
							if (!running.size && (!pending.length || signal?.aborted)) { resolveRound(); }
						};
						pump();
					});
					if (botCalls >= ROOM_LIMITS.botCalls) {
						pushEvent(round, 'paused', { text: `本轮成员之间已经互叫 ${ROOM_LIMITS.botCalls} 次，先停下；你发一条消息就继续` });
					}
				}
			} catch (error) {
				round.error = String(error?.message ?? error).slice(0, 500);
				pushEvent(round, 'failed', { text: `群聊执行失败：${round.error}` });
			} finally {
				if (signal?.aborted) { round.interrupted = true; pushEvent(round, 'cut', { text: '群聊本轮被中断' }); }
				pushEvent(round, 'done', { text: round.error ? '群聊本轮结束（有失败）' : '群聊本轮完成' });
				round.done = true;
				round.finishedAt = now();
				round.phase = round.interrupted ? 'cut' : 'done';
				if (!round.interrupted) {
					setTimeout(() => { if (rounds.get(String(callId ?? '')) === round) { rounds.delete(String(callId ?? '')); void save(); } }, PROGRESS_KEEP_MS).unref?.();
				}
				await save();
				if (round.adminName) { driveGoal(room, round); }
			}
			return { room: { id: room.id, name: room.name }, ...roundOutput(round),
				...(round.error ? { error: round.error } : {}) };
		},
		/** 工具卡轮询：本轮已有的回复与正在说话的人。 ★ 重启后读的是盘上恢复的 round。 */
		progress(callId) {
			const round = rounds.get(String(callId ?? ''));
			return round ? roundView(round) : null;
		},
		/** 全局执行浮层：运行中 + 刚完成 15s；重启恢复的 persisted/cut 轮次保留 10min，避免执行内容重启即消失。 */
		active() {
			const at = now();
			// 群里有成员在等人审批（包括群已不等它、它还在干的迟到成员）⇒ 那个群最近一轮要一直可见，按钮才有地方出
			const waitingRooms = new Set([...approvals.values()].map(item => item.roomId));
			const latestOf = new Map();
			for (const round of rounds.values()) {
				const seen = latestOf.get(round.roomId);
				if (!seen || round.startedAt > seen.startedAt) { latestOf.set(round.roomId, round); }
			}
			const visible = (round) => {
				if (!round.done) { return true; }
				if (waitingRooms.has(round.roomId) && latestOf.get(round.roomId) === round) { return true; }
				const ended = round.finishedAt || round.startedAt;
				if (at - ended < 15_000) { return true; }
				return !!round.persisted && at - ended < PROGRESS_KEEP_MS;
			};
			const shown = [...rounds.values()].filter(visible);
			// 那一轮早已结束并被清理（结束超过保留期）而成员还在等审批 ⇒ 补一条只带审批的活动项（callId 以 approvals: 开头）
			for (const roomId of waitingRooms) {
				if (shown.some(round => round.roomId === roomId) || !rooms.has(roomId)) { continue; }
				const since = Math.min(...[...approvals.values()].filter(item => item.roomId === roomId).map(item => item.at));
				shown.push({ callId: `approvals:${roomId}`, roomId, replies: [], passed: [], failed: [], events: [], speaking: new Set(),
					startedAt: since, finishedAt: since, done: true, phase: 'done', error: '' });
			}
			return shown.map(roundView).sort((a, b) => b.startedAt - a.startedAt);
		},
		/**
		 * ★ 2026-11-06（P1，对齐 DS Bot group_goal）：群目标工具，挂在每位成员的影子会话上，但只有**当前管理员**能用
		 * （管理员会换人 ⇒ 每次调用时核对，而不是按挂载时判断）。
		 */
		goalTool(roomId, botId) {
			return {
				name: ROOM_GOAL_TOOL,
				description: '群目标（只有群管理员能用）：用户要这个群完成一件需要多步的事时，用 action=start 写下目标、怎样算完成、规则和按顺序的阶段'
					+ '（每个阶段有完成标准和分给成员的任务）；之后按阶段 @ 成员派活，检查结果后 pass（附证据）进入下一阶段，不过就 rework（写明缺什么）再 @ 成员返工，'
					+ '全部阶段通过后 complete。status 看账本，revise 记下用户的修正，stop 放弃。',
				parameters: GOAL_TOOL_PARAMETERS,
				output: textOutput,
				async execute(args) {
					await load();
					const room = rooms.get(roomId);
					if (!room) { return JSON.stringify({ error: '这个群已经不在了。' }); }
					if (room.admin !== botId) { return JSON.stringify({ error: '只有群管理员能设定和推进群目标；你可以在群里 @ 管理员提建议。' }); }
					const { map } = await names();
					const memberOf = (ref) => {
						const text = String(ref ?? '').trim().toLowerCase();
						return room.members.find(id => id.toLowerCase() === text || String(map.get(id) ?? '').trim().toLowerCase() === text);
					};
					const result = applyGoal(room, args, { by: botId, memberOf, nameOf: id => map.get(id) ?? id, now: now() });
					if (result.error) { return JSON.stringify({ error: result.error }); }
					appendLog(room, { who: map.get(botId) ?? botId, botId, kind: 'goal', text: clipLine(goalLogText(result.reply, room.goal)) });
					touchGoal(room);
					return JSON.stringify({ ...result.reply, goal: goalView(room.goal, id => map.get(id) ?? id) });
				},
			};
		},
		/** 群目标的对外视图（Bots 页签 / 工作台读）。 */
		goalOf(roomId) {
			const room = rooms.get(String(roomId ?? ''));
			return room?.goal ? goalView(room.goal) : undefined;
		},
		/** 群会话里唯一的工具（注册到群会话的 agent 上）。 */
		relayTool() {
			const self = this;
			return {
				name: ROOM_RELAY_TOOL,
				description: '群聊转发（内部）：把群里人的新消息交给被叫到的成员 Bot，收集它们的回复。只在群聊会话里使用。',
				parameters: { type: 'object', properties: {} },
				output: textOutput,
				async execute(_args, exec) {
					const roomId = exec?.agent?.id ?? exec?.agent?.session?.id;
					if (!roomId || !rooms.has(roomId)) { return JSON.stringify({ error: '这不是群聊会话' }); }
					try {
						return JSON.stringify(await self.relay(roomId, exec?.callId, exec?.signal));
					} catch (error) {
						const text = String(error?.message ?? error).slice(0, 500);
						return JSON.stringify({ schema: ROUND_SCHEMA, callId: String(exec?.callId ?? ''), error: text, replies: [], passed: [], failed: [],
							done: true, status: 'failed', statusLabel: ROUND_STATUS_LABELS.failed,
							events: [{ kind: 'failed', at: now(), text: `群聊执行失败：${text}` }] });
					}
				},
			};
		},
	};
	return api;
}

/**
 * 群会话的模型请求一律由我们合成（见文件头）。返回 `llm/stream` 处理器。
 * @param rooms createRooms 的结果
 */
/**
 * ★ 2026-11-06 群这一轮的结果 → 助手正文（纯函数）。
 * DSH 聊天视图在回合结束后把过程（含 `group_relay` 工具卡）折叠成「已完成，用时 …」，只留最后一步的助手正文；
 * 群会话原来正文是空的 ⇒ 一折叠，成员回复就看不见了（真机：连发三次「开始制作」，界面上什么都没有）。
 * @param message 群会话里 `group_relay` 的 tool 消息（`{ role:'tool', content:[{type:'text',text}], isError }`）
 * @returns 要显示的 markdown；结果读不出时给一句如实说明
 */
export function relayAnswerText(message) {
	const parts = Array.isArray(message?.content) ? message.content : typeof message?.content === 'string' ? [{ type: 'text', text: message.content }] : [];
	const raw = parts.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('').trim();
	let result = null;
	try { result = raw.startsWith('{') ? JSON.parse(raw) : null; } catch { result = null; }
	if (!result || typeof result !== 'object') {
		return message?.isError ? '群聊这一轮被中断，没有拿到成员的回复。' : '群聊这一轮没有可显示的结果。';
	}
	const lines = [];
	for (const reply of Array.isArray(result.replies) ? result.replies : []) {
		const text = String(reply?.text ?? '').trim();
		if (text) { lines.push(`**${String(reply?.name ?? reply?.botId ?? '成员')}**：${text}`); }
	}
	for (const failure of Array.isArray(result.failed) ? result.failed : []) {
		lines.push(`> ${String(failure?.name ?? failure?.botId ?? '成员')} 没能回答：${String(failure?.reason ?? '')}`);
	}
	if (result.error && !lines.length) { lines.push(`> 群聊执行失败：${String(result.error)}`); }
	if (!lines.length) {
		const passed = Array.isArray(result.passed) ? result.passed.filter(Boolean) : [];
		lines.push(passed.length ? `${passed.join('、')} 没有补充。` : '这一轮没有成员回复。');
	}
	if (result.interrupted || result.status === 'cut') { lines.push('> 群聊本轮被中断。'); }
	return lines.join('\n\n');
}

/**
 * ★ 2026-11-06（对齐 DS Bot `onWork`）：成员这一回合有没有真的干活（调用过工具）。
 * 判据：会话里有 `tool/call` 事件，或助手消息里有 tool-call 块。纯函数。
 */
export function turnWorked(events) {
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type === 'tool/call') { return true; }
		if (event?.type !== 'assistant/message') { continue; }
		const content = event.data?.message?.content;
		if (Array.isArray(content) && content.some(part => part?.type === 'tool-call')) { return true; }
	}
	return false;
}

export function relayStream(rooms, uuid = randomUUID) {
	return (options, next) => {
		if (!options || !options.sessionId || options.purpose !== undefined || !rooms.isRoom(options.sessionId)) { return next(); }
		return (async function* relayOrStop() {
			const opens = message => message?.role === 'user' && message.source?.kind === 'user';
			const latest = [...(options.messages ?? [])].reverse().find(message => message?.role === 'assistant' || message?.role === 'tool' || opens(message));
			if (latest?.role === 'tool') {
				// group_relay 刚返回：把本轮回复写成正文（回合折叠后仍可见）
				const text = relayAnswerText(latest);
				yield { type: 'block-start', index: 0, blockType: 'text' };
				yield { type: 'text-delta', index: 0, text };
				yield { type: 'block-end', index: 0, block: { type: 'text', text } };
				yield { type: 'finish', reason: { kind: 'stop' } };
				return;
			}
			if (latest?.role !== 'user') {
				yield { type: 'finish', reason: { kind: 'stop' } };
				return;
			}
			if (!(options.tools ?? []).some(tool => tool?.name === ROOM_RELAY_TOOL)) {
				const text = '这个群暂时转发不了消息：群聊工具没挂上。重启 VsSaros 后再试；一直这样请反馈。';
				yield { type: 'block-start', index: 0, blockType: 'text' };
				yield { type: 'text-delta', index: 0, text };
				yield { type: 'block-end', index: 0, block: { type: 'text', text } };
				yield { type: 'finish', reason: { kind: 'stop' } };
				return;
			}
			const id = `toolu_relay_${uuid().replace(/-/g, '')}`;
			yield { type: 'block-start', index: 0, blockType: 'tool-call' };
			yield { type: 'tool-call-delta', index: 0, id, name: ROOM_RELAY_TOOL, argumentsDelta: '{}' };
			yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: ROOM_RELAY_TOOL, arguments: '{}' } };
			yield { type: 'finish', reason: { kind: 'tool-calls' } };
		})();
	};
}

/**
 * `/x/agents/api/rooms` 的分派（index.js 的路由与守卫共用这一份）：
 *   GET  → { rooms } ；GET ?id= → { room } ；GET ?progress=<callId> → { progress }；GET ?active=1 → { active }
 *   POST { action:'create', members, name?, notice?, admin?, mode?, workspaceId?, cwd?, createdBy? }
 *   POST { action:'update', id, name?, notice?, admin?, mode?, members? } / { action:'flags', id, pinned?, hidden? } / { action:'delete', id }
 * @returns `{ status, body }`（不抛：RoomError ⇒ 它的 status，其它 ⇒ 500）
 */
export async function roomsApi(rooms, { method, query, body }) {
	try {
		if (method === 'GET') {
			const active = query?.get?.('active');
			const progressId = query?.get?.('progress');
			const id = query?.get?.('id');
			if (active) { await rooms.load(); return { status: 200, body: { ok: true, active: rooms.active() } }; }
			if (progressId) { await rooms.load(); return { status: 200, body: { ok: true, progress: rooms.progress(progressId) } }; }
			if (id) { return { status: 200, body: { ok: true, room: await rooms.get(id) } }; }
			return { status: 200, body: { ok: true, rooms: await rooms.list() } };
		}
		if (method !== 'POST') { return { status: 405, body: { ok: false, error: 'GET or POST' } }; }
		const action = String(body?.action ?? '').trim();
		const id = String(body?.id ?? '').trim();
		const pick = (keys) => Object.fromEntries(keys.filter(k => body?.[k] !== undefined).map(k => [k, body[k]]));
		if (action === 'create') {
			const originTriggerId = typeof body.originTriggerId === 'string' && body.originTriggerId ? body.originTriggerId
				: typeof body.triggerId === 'string' && body.triggerId ? body.triggerId : undefined;
			const room = await rooms.create(pick(['members', 'name', 'notice', 'admin', 'mode']), {
				createdBy: typeof body.createdBy === 'string' && body.createdBy ? body.createdBy : 'user',
				workspaceId: typeof body.workspaceId === 'string' && body.workspaceId ? body.workspaceId : undefined,
				cwd: typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined,
				originTriggerId,
			});
			return { status: 200, body: { ok: true, room } };
		}
		if (action === 'update') { return { status: 200, body: { ok: true, room: await rooms.update(id, pick(['name', 'notice', 'admin', 'mode', 'members'])) } }; }
		if (action === 'flags') { return { status: 200, body: { ok: true, room: await rooms.setFlags(id, pick(['pinned', 'hidden'])) } }; }
		if (action === 'delete') { return { status: 200, body: await rooms.remove(id) }; }
		// ★ 2026-11-06：群成员等人确认的工具调用（POST { action:'approve', id: 审批 id, choice: 'allow'|'reject' }）
		if (action === 'approve') {
			const choice = body?.choice === 'allow' ? 'allow' : body?.choice === 'reject' ? 'reject' : '';
			if (!choice) { return { status: 400, body: { ok: false, error: 'choice 只能是 allow 或 reject' } }; }
			return { status: 200, body: { ok: true, approval: rooms.answerApproval(id, choice) } };
		}
		return { status: 400, body: { ok: false, error: `未知 action：${action || '(空)'}（支持 create/update/flags/delete/approve）` } };
	} catch (error) {
		return { status: error instanceof RoomError ? error.status : 500, body: { ok: false, error: String(error?.message ?? error) } };
	}
}

/** 从 user/message 事件取人写的文本（不是人写的 ⇒ undefined）。 */
export function userTextOf(event) {
	if (event?.type !== 'user/message') { return undefined; }
	const message = event.data;
	if (message?.source?.kind !== 'user') { return undefined; }
	// 系统为「新开一轮」写进群会话的消息不是人说的话（由 callbacks 驱动，不进群收件箱、不进群聊记录）
	if (message.source.form === ROOM_CALLBACK_FORM) { return undefined; }
	const content = message.content;
	const text = typeof content === 'string' ? content : Array.isArray(content)
		? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
	return text.trim() || undefined;
}

/**
 * 接线（顶层角色调用一次；返回 dispose）：
 *   · 群会话的模型请求由 `relayStream` 合成；
 *   · 群会话里人的消息进群收件箱；成员影子会话回合结束交出结果；
 *   · 群会话的 agent（新建 / 恢复）挂上 `group_relay`（只挂这一个，挂过不重复）。
 */
export function installRooms(ctx, rooms) {
	const offs = [];
	const attached = new WeakSet();
	const attach = (agent) => {
		if (!agent?.ctx?.tools || typeof agent.ctx.tools.register !== 'function' || attached.has(agent)) { return; }
		attached.add(agent);
		try {
			const dispose = agent.ctx.tools.register(rooms.relayTool());
			if (typeof dispose === 'function') { offs.push(dispose); }
		} catch (error) {
			console.warn(`[vssaros-agents][rooms] 群会话 ${agent.id} 挂 group_relay 失败：${String(error?.message ?? error)}`);
		}
	};
	rooms.attach = attach;
	// ★ 2026-11-06：成员影子会话挂 group_goal（每个会话挂一次；只有当前管理员调用时生效）
	const goalAttached = new WeakSet();
	rooms.attachMember = (agent, roomId, botId) => {
		if (!agent?.ctx?.tools || typeof agent.ctx.tools.register !== 'function' || goalAttached.has(agent) || typeof rooms.goalTool !== 'function') { return; }
		goalAttached.add(agent);
		try {
			const dispose = agent.ctx.tools.register(rooms.goalTool(roomId, botId));
			if (typeof dispose === 'function') { offs.push(dispose); }
		} catch (error) {
			console.warn(`[vssaros-agents][rooms] 成员会话 ${agent.id} 挂 group_goal 失败：${String(error?.message ?? error)}`);
		}
	};
	offs.push(ctx.on('llm/stream', relayStream(rooms)));
	// ★ 2026-11-05（对齐 DS Bot `post_to_group` / `session-reference`）：别的会话里 `@群 / 引用会话`
	//   会拆成「真消息 + 引用事件」两条 user/message；把真消息转投到群会话，群 UI 才会开始执行。
	//   只在消息确实以 @群名 开头时转投，避免把「引用一下群聊当背景资料」误当派活。
	const lastUser = new Map();
	const routed = new Set();
	offs.push(ctx.on('session/event', (session, event) => {
		const sid = String(session?.id ?? '');
		const text = userTextOf(event);
		if (text) {
			if (rooms.isRoom(sid)) { rooms.noteUserMessage(sid, text); return; }
			lastUser.set(sid, { id: String(event.data?.id ?? ''), text, at: Date.now() });
			return;
		}
		if (event?.type !== 'user/message' || event.data?.source?.kind !== ROOM_REFERENCE_KIND || rooms.isRoom(sid)) { return; }
		const ref = roomReferenceOf(event, id => rooms.isRoom(id), name => rooms.roomByName(name));
		if (!ref) { return; }
		const cached = lastUser.get(sid);
		if (!cached || Date.now() - cached.at > 15_000 || !addressedRoomReference(cached.text, ref)) { return; }
		const key = `${sid}:${cached.id || event.data?.id || ''}:${ref.roomId}`;
		if (routed.has(key)) { return; }
		routed.add(key);
		lastUser.delete(sid);
		const body = stripRoomMention(cached.text, ref.label) || '开始协作';
		void rooms.postToRoom(ref.roomId, body, {
			fromSession: sid, sourceMessageId: cached.id, roomLabel: ref.label,
		}).catch(error => console.warn(`[vssaros-agents][rooms] @群转投失败：${String(error?.message ?? error)}`));
		if (routed.size > 200) { const oldest = routed.values().next().value; if (oldest) { routed.delete(oldest); } }
	}));
	offs.push(ctx.on('agent/turn-stopping', payload => { rooms.noteTurnEnd(payload?.agent?.session); }));
	// 成员影子会话每个事件都算「还在干活」：等待按进展计时，而不是从派活起固定 240 秒
	offs.push(ctx.on('session/event', (session, event) => { rooms.noteActivity?.(session?.id, event); }));
	// 群成员的工具审批由群接住（排在 DSH 自带审批框之前；不是群成员的请求原样往下交）
	if (typeof rooms.decideApproval === 'function') {
		offs.push(ctx.on('approval/request', (request, next) => rooms.decideApproval(request, next), { prepend: true }));
	}
	offs.push(ctx.on('agent/created', ({ agent }) => {
		void rooms.load().then(() => { if (rooms.isRoom(agent?.id ?? agent?.session?.id)) { attach(agent); } });
	}));
	void rooms.load();
	return () => {
		for (const off of offs.splice(0)) { try { off(); } catch { /* 已撤 */ } }
		void (rooms.close ?? rooms.flush)?.(); // ★ 卸载前把排队的执行过程写完，再交还租约
	};
}

export { autoRoomName };
