// @vssaros/dsh-agents — core/rooms：多 bot 群聊的纯逻辑（零 I/O、零 dsh 依赖，可单测）。2026-11-05。
//
// ── 群是什么（移植 DeepSeek-Bot 的 room，见 ds-bot/src/host/groups.js、roster.js）──────────────
//   · 一个群 = 一条**专属 DSH 会话**（群 id 就是这条会话的 id）+ 成员 bot 名单 + 群日志。
//   · 群会话**不跑模型**：人在群里发言 ⇒ 它的回合里 `llm/stream` 被我们接管，合成一次
//     `group_relay` 工具调用（lib/rooms.js）⇒ 工具把消息转给成员、等成员回复，整轮结果作为工具结果
//     落回群会话，聊天页由 chat-surface 的 `group_relay` 工具卡画成成员气泡。
//   · 每个成员在**自己的群内影子会话**里思考（每成员每群一条，跑该 bot 的 preset），回复写回群日志。
//
// ── 谁来回答（DS Bot `openingCall` 同口径）────────────────────────────────────────
//   · 消息里 @ 了成员 ⇒ 只叫被 @ 的人，**并行**；
//   · 没 @、模式 `admin`（有管理员）⇒ 只叫管理员，由它再 @ 其他人；
//   · 模式 `everyone`，或 @所有人 ⇒ 全员；普通消息**轮流**（管理员先说），@所有人 并行。
//   · 成员回复里的 @ 会再叫人（只有管理员的 @所有人 有效）；一轮里每人至多被叫 2 次，
//     bot 叫 bot 至多 6 次（防止 bot 之间无限互相点名）。
//
// ⚠ 本文件的常量（记录类型 / 投影 key / 工具名）在 chat-surface 两个 chunk 里有逐字副本
//   （client.workspaces.js 过滤会话、client.conversationViews.js 画群卡与设置），改这里要同步改。

/** 群标记的 plugin record 类型（群会话写 role=room，成员影子会话写 role=member）。 */
export const ROOM_RECORD_TYPE = 'plugin:vssaros/room';
/** 群标记投影 key（带 wire ⇒ 页面 `projectionValues["vssaros-room"]` 可读）。 */
export const ROOM_PROJECTION_KEY = 'vssaros-room';
export const ROOM_PROJECTION_STATE_VERSION = 1;
/** 群会话里唯一的工具（合成调用；结果 JSON 由 chat-surface 的工具卡渲染）。 */
export const ROOM_RELAY_TOOL = 'group_relay';
/** 发给成员影子会话的那条消息的 source.kind（与 relay/assignment 的 kind 不同 ⇒ 不会触发自动回传）。 */
export const ROOM_TURN_KIND = 'vssaros/group-turn';
/** DSH 外壳「引用会话」事件的 source.kind；refs[].sessionId 可以直接指向群会话。 */
export const ROOM_REFERENCE_KIND = 'session-reference';
/** 从别的会话 @群 转投过来的人消息，落进群会话时用的 form（仍是 user，才能唤醒 group_relay）。 */
export const ROOM_POST_FORM = 'room-post';
/**
 * ★ 2026-11-06 跨插件群执行契约版本：`?active=1` / `?progress=` / `group_relay` 结果 / `vssaros-group-progress`
 * 广播都带 `schema`。消费方（chat-surface 两个 chunk、superagent GroupRuns）只认 `schema <= 这个值` 的字段。
 */
export const ROUND_SCHEMA = 1;
/** 一轮群执行对外的唯一状态词表（所有 UI 只读这个，不各自推断）。 */
export const ROUND_STATUSES = Object.freeze(['sent', 'replying', 'done', 'cut', 'failed']);
export const ROUND_STATUS_LABELS = Object.freeze({
	sent: '已发到群', replying: '正在回答', done: '已完成', cut: '已中断', failed: '执行失败',
});
/**
 * 统一状态机（纯函数）：中断优先于失败（重启收口时会同时带 error），未结束时有人在说话 ⇒ replying。
 * chat-surface 与 superagent 各有一份逐字副本作为旧数据兜底；check-bots-rooms.mjs 用同一张表钉三处一致。
 */
export function roundStatusOf(round) {
	const r = round && typeof round === 'object' ? round : {};
	const events = Array.isArray(r.events) ? r.events : [];
	if (r.interrupted || r.phase === 'cut' || events.some(event => event && event.kind === 'cut')) { return 'cut'; }
	if (!r.done) {
		const speaking = r.speaking instanceof Set ? r.speaking.size : Array.isArray(r.speaking) ? r.speaking.length : 0;
		return speaking > 0 ? 'replying' : 'sent';
	}
	return r.error ? 'failed' : 'done';
}
/** 「谁来回答」模式。 */
export const ROOM_MODES = Object.freeze(['admin', 'everyone']);
export const ROOM_LIMITS = Object.freeze({
	membersMin: 2,
	membersMax: 12,
	name: 60,
	notice: 2000,
	/** 群日志保留多少行（成员读上下文用；完整对话在群会话里）。 */
	log: 120,
	/** 每轮给成员看多少行「之前的上下文」/「新内容」。 */
	contextLines: 8,
	newLines: 24,
	/**
	 * 一轮里同一成员最多被叫几次。★ 2026-11-06：原来是 2 ⇒「开发→测试→打回开发→复测」一次打回就到顶；
	 * 现在真正的闸是「连续没干活的接力」（ROOM_IDLE_RELAY_LIMIT），这两个只是防失控的总上限。
	 */
	callsPerMember: 12,
	/** 一轮里 bot 叫 bot（含「做完了叫回派活的人」）最多几次（原来是 6）。 */
	botCalls: 40,
	/** 单条群消息文本上限（再长截断并注明）。 */
	line: 4000,
});
/**
 * 连续多少次「成员叫成员、但叫人的那位这一回合没调用任何工具」就停下（DS Bot ROOM_IDLE_RELAY_LIMIT 同值）。
 * 有人真干活（调用过工具）就清零 ⇒ 只拦互相附和、复读，不拦有效的多轮返工。
 */
export const ROOM_IDLE_RELAY_LIMIT = 6;

/** 群标记记录的数据体。 */
export function roomRecordData({ roomId, role, botId }) {
	return { v: 1, roomId: String(roomId ?? ''), role: role === 'member' ? 'member' : 'room', ...(botId ? { botId: String(botId) } : {}) };
}

/** 从一条会话事件读群标记；不是就 undefined。 */
export function roomOfEvent(event) {
	if (!event || event.type !== ROOM_RECORD_TYPE || event.ignorable !== true) { return undefined; }
	const data = event.data;
	const roomId = typeof data?.roomId === 'string' ? data.roomId.trim() : '';
	if (!roomId) { return undefined; }
	return { roomId, role: data.role === 'member' ? 'member' : 'room', ...(typeof data.botId === 'string' && data.botId ? { botId: data.botId } : {}) };
}

/** `sessionProjections` 单元：fold 群标记 → `{ roomId, role, botId? }`（没有 = null）。忽略的事件返回同一引用。 */
export function roomProjection() {
	return {
		key: ROOM_PROJECTION_KEY,
		stateSchema: { parse: value => value },
		init: () => null,
		apply(state, event) {
			const hit = roomOfEvent(event);
			return hit ? hit : state;
		},
		stateVersion: ROOM_PROJECTION_STATE_VERSION,
		wire: {
			viewSchema: { parse: value => value },
			view: state => (state ? { ...state } : null),
		},
	};
}

/** 群出错（校验失败、不存在）——调用方原样报给人或模型。 */
export class RoomError extends Error {
	constructor(message, status = 400) {
		super(message);
		this.status = status;
	}
}

/** 按成员命名的默认群名：「你、A、B」，人多时「你、A、B 等 5 人」。 */
export function autoRoomName(names) {
	const list = (Array.isArray(names) ? names : []).map(n => String(n ?? '').trim()).filter(Boolean);
	const shown = list.slice(0, 3);
	return ['你', ...shown].join('、') + (list.length > shown.length ? ` 等 ${list.length + 1} 人` : '');
}

/** 在名册里按 id 或名字（大小写不敏感）找 bot；找不到返回 undefined。 */
function findBot(roster, ref) {
	const key = String(ref ?? '').trim().toLowerCase();
	if (!key) { return undefined; }
	return roster.find(bot => String(bot.id).toLowerCase() === key)
		?? roster.find(bot => String(bot.name ?? '').toLowerCase() === key);
}

/**
 * 校验并规整建群输入。
 * @param input `{ members, name?, notice?, admin?, mode? }`：members 是 bot id 或名字
 * @param roster `[{ id, name }]`：可入群的 bot（不含隐藏 bot）
 * @returns `{ members, name, named, notice, admin, mode }`
 * @throws RoomError
 */
export function normalizeRoomInput(input, roster) {
	const list = Array.isArray(roster) ? roster : [];
	const refs = Array.isArray(input?.members) ? input.members : [];
	const members = [];
	for (const ref of refs) {
		const bot = findBot(list, ref);
		if (!bot) {
			throw new RoomError(`没有叫「${String(ref)}」的 Bot。可选：${list.map(b => b.name).slice(0, 20).join('、') || '（名册为空）'}`);
		}
		if (!members.includes(bot.id)) { members.push(bot.id); }
	}
	if (members.length < ROOM_LIMITS.membersMin) {
		throw new RoomError(`群里至少要有 ${ROOM_LIMITS.membersMin} 个 Bot（现在 ${members.length} 个）。`);
	}
	if (members.length > ROOM_LIMITS.membersMax) {
		throw new RoomError(`群里最多 ${ROOM_LIMITS.membersMax} 个 Bot（现在 ${members.length} 个）。`);
	}
	// ★ 2026-11-06：群里靠名字认人（@名字、正在说话的人、跳过的人都只有名字）⇒ 两个同名成员会互相错配。
	const seenNames = new Map();
	for (const id of members) {
		const shown = String(list.find(b => b.id === id)?.name ?? id).trim().toLowerCase();
		if (seenNames.has(shown)) {
			throw new RoomError(`「${list.find(b => b.id === id)?.name ?? id}」有两个同名的 Bot（${seenNames.get(shown)} 和 ${id}），群里会分不清谁是谁。先给其中一个改名再建群。`);
		}
		seenNames.set(shown, id);
	}
	const name = String(input?.name ?? '').trim();
	if (name.length > ROOM_LIMITS.name) { throw new RoomError(`群名最多 ${ROOM_LIMITS.name} 个字。`); }
	const notice = String(input?.notice ?? '').trim();
	if (notice.length > ROOM_LIMITS.notice) { throw new RoomError(`群公告最多 ${ROOM_LIMITS.notice} 个字（现在 ${notice.length}）。`); }
	let admin = null;
	if (input?.admin !== undefined && input?.admin !== null && String(input.admin).trim()) {
		const bot = findBot(list, input.admin);
		if (!bot || !members.includes(bot.id)) { throw new RoomError(`管理员必须是群成员：${String(input.admin)}`); }
		admin = bot.id;
	} else {
		admin = members[0];
	}
	const mode = input?.mode === undefined || input?.mode === null || input?.mode === '' ? 'admin' : String(input.mode);
	if (!ROOM_MODES.includes(mode)) { throw new RoomError(`「谁来回答」只能是 ${ROOM_MODES.join(' / ')}。`); }
	const names = members.map(id => findBot(list, id)?.name ?? id);
	return { members, name: name || autoRoomName(names), named: !!name, notice, admin, mode };
}

// ── @ 点名 ──────────────────────────────────────────────────────────────────────

const ALL_WORDS = ['所有人', '全体成员', '全体', 'all', 'everyone'];

/** 去掉不该算点名的片段：代码、链接、邮箱。 */
function scrub(text) {
	return String(text ?? '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/`[^`]*`/g, ' ')
		.replace(/https?:\/\/\S+/g, ' ')
		.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ' ');
}

/**
 * 消息里点了谁。名字最长优先（「Code Reviewer」先于「Code」）；@所有人 / @all 记为 all。
 * @param members `[{ id, name }]`
 * @returns `{ ids: string[], all: boolean }`（ids 按首次出现顺序）
 */
export function mentionsIn(text, members) {
	const body = scrub(text);
	const found = [];
	let all = false;
	const names = [];
	for (const m of Array.isArray(members) ? members : []) {
		for (const label of [m.name, m.id]) {
			const s = String(label ?? '').trim();
			if (s) { names.push({ id: m.id, label: s }); }
		}
	}
	names.sort((a, b) => b.label.length - a.label.length);
	const lower = body.toLowerCase();
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== '@' && body[i] !== '＠') { continue; }
		// ★ 2026-11-07（真机：Coder 写「@ Designer 请你出像素版视觉 spec」，Designer 从没被叫到）：@ 后允许一个空格
		const rest = lower.slice(i + 1).replace(/^[ \u3000]/, '');
		const word = ALL_WORDS.find(w => rest.startsWith(w.toLowerCase()));
		if (word) { all = true; continue; }
		const hit = names.find(n => rest.startsWith(n.label.toLowerCase()));
		if (hit && !found.some(f => f.id === hit.id)) { found.push({ id: hit.id, at: i }); }
	}
	return { ids: found.map(f => f.id), all };
}

/**
 * 人发言后叫谁、怎么叫。
 * @returns `{ ids, ordered }`：ordered=true 表示依次说（前一个说完下一个才开始）
 */
export function openingCall(room, mention) {
	const members = Array.isArray(room?.members) ? room.members : [];
	const ids = (mention?.ids ?? []).filter(id => members.includes(id));
	if (ids.length && !mention.all) { return { ids, ordered: false }; }
	const admin = room?.admin && members.includes(room.admin) ? room.admin : null;
	if (!mention?.all && room?.mode === 'admin' && admin) { return { ids: [admin], ordered: false }; }
	const order = admin ? [admin, ...members.filter(id => id !== admin)] : [...members];
	return { ids: order, ordered: !mention?.all && order.length > 1 };
}

/**
 * 成员发言里又叫了谁（不含自己；只有管理员的 @所有人 有效）。
 * @param counts `Map<botId, number>` 本轮已被叫的次数
 */
export function callsFrom(room, speakerId, text, members, counts) {
	const mention = mentionsIn(text, members);
	const ids = new Set(mention.ids);
	if (mention.all && speakerId === room?.admin) {
		for (const id of room.members ?? []) { ids.add(id); }
	}
	ids.delete(speakerId);
	const taken = counts instanceof Map ? counts : new Map();
	return [...ids].filter(id => (room?.members ?? []).includes(id) && (taken.get(id) ?? 0) < ROOM_LIMITS.callsPerMember);
}

/** 成员选择沉默（`[PASS]` 或空）。 */
export function isPass(text) {
	const s = String(text ?? '').trim();
	return !s || /^\[?\s*pass\s*\]?\.?$/i.test(s);
}

/** 去掉回复开头自报的名字（「Designer：」「**Designer**:」「【Designer】」）。 */
export function stripOwnName(text, name) {
	const s = String(text ?? '').trim();
	const n = String(name ?? '').trim();
	if (!n) { return s; }
	const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return s.replace(new RegExp(`^(?:【${esc}】|\\[${esc}\\]|(?:\\*\\*)?${esc}(?:\\*\\*)?\\s*[:：])\\s*`), '').trim();
}

/** 群日志里的一行，给成员看的形态：「名字：内容」。 */
export function lineText(line) {
	return `${line.who}：${line.text}`;
}

/**
 * ★ 2026-11-07（对齐 DS Bot `ds-bot/src/host/tools.js:16-30, 954-992`）：群成员会话里不给用的工具。
 * `ask_user_question` 会把成员的回合一直挂着等用户回答，而它的提问卡只出现在成员自己的会话里、群里看不到 ⇒
 * 群这一轮按超时放行、显示「本轮完成」，成员却永远卡住（真机：番茄钟团队 Coder，11-07 16:26）。
 * 群里要问用户 ⇒ 调 `group_ask`（`lib/core/asks.js`，不阻塞，输入框上方出选择卡）。
 */
export const ROOM_MEMBER_DENIED_TOOLS = Object.freeze(['ask_user_question']);
/** 成员硬调被拒时给模型的话。 */
export const ROOM_ASK_REFUSAL = '群聊里不能用 ask_user_question（提问卡只在你自己的会话里，群里看不到，你会一直卡着）。'
	+ '要用户决定的事调 group_ask：群聊输入框上方会弹选择卡，你这一轮随即结束，用户答了会叫你回来。';

/** 文本截到群消息上限（截了就注明）。 */
export function clipLine(text) {
	const s = String(text ?? '');
	return s.length > ROOM_LIMITS.line ? `${s.slice(0, ROOM_LIMITS.line)}…（太长，后面省略了）` : s;
}

/**
 * 给成员的这一轮提示（成员影子会话里收到的那条消息）。
 * @param input.room 群
 * @param input.member `{ id, name }`
 * @param input.members `[{ id, name }]`
 * @param input.log 群日志行 `[{ seq, who, botId?, text }]`
 * @param input.seen 该成员上次读到的 seq（没有 = 首次进群）
 * @param input.place `{ ordered, index, total, with: string[] }` 本轮位次
 * @param input.calledBy 叫他的人（人 / 成员名）
 */
export function roomPrompt({ room, member, members, log, seen, place, calledBy, note, workDir }) {
	const lines = Array.isArray(log) ? log : [];
	const first = typeof seen !== 'number';
	const fresh = first ? lines.slice(-12) : lines.filter(line => line.seq > seen).slice(-ROOM_LIMITS.newLines);
	const before = first ? [] : lines.filter(line => line.seq <= seen).slice(-ROOM_LIMITS.contextLines);
	const others = (members ?? []).filter(m => m.id !== member.id)
		.map(m => `${m.name}${m.id === room.admin ? '（管理员）' : ''}`);
	const parts = [
		`[群聊「${room.name}」· 轮到你（${member.name}${member.id === room.admin ? '，管理员' : ''}）]`,
		`群成员：你、${others.join('、')}，还有用户。`,
	];
	if (room.notice) { parts.push(`群公告（每位成员都要遵守）：\n${room.notice}`); }
	// ★ 2026-11-07：成员各自 cd 到别处 ⇒ 同一个项目出现两份代码、测的不是改的那份（真机：番茄钟团队）
	if (workDir) { parts.push(`本群的项目目录：${workDir}\n所有文件都放在这个目录里，读写、跑命令、起服务都在这里；不要另找或另建别的目录放同一个项目（用户另有指定除外）。`); }
	if (before.length) { parts.push(`之前的消息：\n${before.map(lineText).join('\n')}`); }
	parts.push(`${first ? '最近的消息' : '新消息'}：\n${fresh.length ? fresh.map(lineText).join('\n') : '（没有新消息）'}`);
	if (note) { parts.push(String(note)); } else if (calledBy) { parts.push(`是${calledBy}叫你的。`); }
	if (place?.ordered && place.total > 1) {
		parts.push(`本轮大家依次发言，你是第 ${place.index + 1} 位（共 ${place.total} 位）。`);
	} else if (place?.with?.length) {
		parts.push(`和你同时回答的还有：${place.with.join('、')}。`);
	}
	// ★ 2026-11-06（对齐 DS Bot groups.js ROOM_REPLY / ROOM_CALLS）：接力规则写给每位成员，链条才接得上。
	parts.push([
		'直接写你要在群里说的话（不用自报姓名）。',
		'要别的成员做事或回答，就在话里 @他的名字，他会立刻开始。同一条里 @ 的几位同时开始、看不到彼此的结果；要用到某人的结果时，先 @ 他，并请他做完后 @ 下一位。',
		'你 @ 的人做完后，系统会把结果交回给你，由你接着处理：检查、继续派活，或向用户汇报。发现问题要返工，就 @ 对方说清问题和复现步骤。',
		'被要求做事时，在同一步就开始调用工具去做，不要只回一句「我来做」；结尾写结果和证据（改了哪些文件、跑了什么命令、看到了什么），不要承诺稍后再做。',
		// ★ 2026-11-07：群里的选择卡（`lib/core/asks.js`）；只写文字用户点不了，也没有任何提醒
		'需要用户决定的事（方案取舍、范围、风格等）调 group_ask：输入框上方会弹选择卡（每题标上你推荐的选项），你这一轮随即结束，用户答了会叫你回来；不要把选项写成文字等人回复，也不要用 ask_user_question。能自己查清的事先查清，不要问用户。',
		member.id === room.admin ? '你是管理员：用户没点名时由你先回应，需要谁就 @谁；@所有人 会叫全员。' : '',
		'没有要补充的就只回 [PASS]。',
	].filter(Boolean).join('\n'));
	return parts.join('\n\n');
}

/** 对外（HTTP / 团队总线）的群视图：不含日志、影子会话等运行时字段。 */
export function roomView(room, names) {
	const nameOf = id => (names && typeof names.get === 'function' ? names.get(id) : undefined) ?? id;
	const last = Array.isArray(room.log) && room.log.length ? room.log[room.log.length - 1] : null;
	return {
		id: room.id,
		sessionId: room.id,
		name: room.name,
		named: room.named === true,
		// ★ 2026-11-06：成员在这个群里的会话（开过才有）⇒ 侧栏点「正在群里干活」的 bot 时直接打开它这条，
		//   而不是它最近一条私聊（用户报「正在执行任务的 bot，点 item 没有打开对应的对话窗口」）。
		members: room.members.map(id => ({ id, name: nameOf(id), ...(room.sessions?.[id] ? { sessionId: room.sessions[id] } : {}) })),
		admin: room.admin ?? null,
		mode: room.mode,
		notice: room.notice ?? '',
		pinned: room.pinned === true,
		hidden: room.hidden === true,
		createdAt: room.createdAt,
		createdBy: room.createdBy ?? null,
		...(room.originTriggerId ? { originTriggerId: room.originTriggerId } : {}),
		updatedAt: room.updatedAt ?? room.createdAt,
		preview: last ? `${last.who}：${String(last.text).slice(0, 80)}` : '',
	};
}

/** 侧栏顺序：置顶在前，其余按最近活动倒序。 */
export function sortRooms(rooms) {
	return [...(Array.isArray(rooms) ? rooms : [])].sort((a, b) => (Number(b.pinned === true) - Number(a.pinned === true))
		|| ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)) || String(a.id).localeCompare(String(b.id)));
}

// ── 从别的会话「@群 / 引用会话」转投到群里（2026-11-05，对齐 DS Bot 的 post_to_group）──────────
//   DSH 外壳把 `@[群名](dsh-session:<base64url of JSON sessionId>)` 同时拆成两条 user/message：
//   ① source.kind='user'（真正的指令文本）；② source.kind='session-reference'（references[].sessionId）。
//   Host 侧以 ② 认出目标群，以 ① 作为要投给群的文本；不能只看 ① 的纯文本 @群名。
const escapeRegExp = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `dsh-session:<base64url>` 里装的通常是 JSON 字符串（会话 id）；坏标记返回空串。 */
export function decodeDshSessionToken(token) {
	try {
		if (typeof Buffer === 'undefined' || !token) { return ''; }
		const value = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
		return typeof value === 'string' ? value : typeof value?.sessionId === 'string' ? value.sessionId : '';
	} catch { return ''; }
}
/** 文本里的 `@[label](dsh-session:……)` 引用（DSH 输入框插入到 agent/inbox 的原始形态）。 */
export function sessionReferencesOf(text) {
	const out = [];
	for (const match of String(text ?? '').matchAll(/@\[([^\]]+)\]\(dsh-session:([A-Za-z0-9_-]+)\)/g)) {
		const sessionId = decodeDshSessionToken(match[2]);
		if (sessionId) { out.push({ label: match[1], sessionId }); }
	}
	return out;
}
/**
 * 从「引用会话」事件里找第一个指向群聊的引用。
 * @param event DSH `user/message` 事件
 * @param isRoom `(sessionId) => boolean`
 * @param byName `(label) => string | undefined` 纯文本 `@群名` 的兜底
 */
export function roomReferenceOf(event, isRoom, byName) {
	if (event?.type !== 'user/message') { return undefined; }
	const source = event.data?.source;
	const refs = [];
	if (source?.kind === ROOM_REFERENCE_KIND && Array.isArray(source.references)) {
		for (const ref of source.references) {
			if (ref && typeof ref.sessionId === 'string') { refs.push({ label: String(ref.label ?? ''), sessionId: ref.sessionId }); }
		}
	}
	const content = event.data?.content;
	const text = typeof content === 'string' ? content : Array.isArray(content)
		? content.filter(part => part?.type === 'text').map(part => part.text).join('\n') : '';
	refs.push(...sessionReferencesOf(text));
	for (const ref of refs) {
		const direct = isRoom?.(ref.sessionId) ? ref.sessionId : '';
		const roomId = direct || byName?.(ref.label) || '';
		if (roomId) { return { ...ref, roomId: String(roomId) }; }
	}
	return undefined;
}
/** 是否真的在「呼叫」这个群，而不是把群会话当背景材料引用一下。 */
export function addressedRoomReference(text, ref) {
	if (!ref?.label) { return false; }
	const body = String(text ?? '').trim();
	return body.startsWith('@') && (body.includes(`@${ref.label}`) || body.includes(`@[${ref.label}]`));
}
/** 转投到群时去掉 `@群名` / `@[群名](...)`，只把真正的指令交给成员。 */
export function stripRoomMention(text, label) {
	let out = String(text ?? '');
	if (label) {
		out = out.replace(new RegExp(`@\\[${escapeRegExp(label)}\\]\\(dsh-session:[A-Za-z0-9_-]+\\)`, 'g'), '');
		out = out.replace(new RegExp(`@${escapeRegExp(label)}`, 'g'), '');
	}
	return out.replace(/\s+/g, ' ').trim();
}
