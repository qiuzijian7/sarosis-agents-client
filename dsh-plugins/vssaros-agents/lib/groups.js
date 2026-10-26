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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { presetIdOf } from './core/agents.js';
import { AGENT_MESSAGE_KIND, finalAssistantText, findOurSplices } from './core/relay.js';
import { isShownAgent } from './core/agents.js';
import { dataRootOf, scanAgentsFromConfig } from './store.js';

/**
 * 群聊能用的 agent 名单 = **内置 + 自定义**（`scanAgentsFromConfig`），去掉显式隐藏的。
 *
 * ⚠ 2026-10-19 修（用户问「这些 agent 是否支持群聊」时暴露的既有缺口）：
 *   这里原本用 `scanAgents(agentsRootOf(config))`（**只扫自定义根**）⇒ 内置 agent
 *   （knowledge-base-expert / coder / Tob …）加进群会被判 404「没有的 agent」，
 *   而它们的 preset 其实**都注册了**（派发完全可行）⇒ 纯属校验面写窄了。
 */
const groupAgentsOf = async (config) => {
	const scan = await scanAgentsFromConfig(config);
	// 2026-10-20：与页面同一条判定（内置按 `userFacing: true` 白名单 + 隐藏名单），
	// 不再各写一份 —— 群成员列表曾比名册宽/窄，都是"两处口径"造成的。
	return { ...scan, agents: (scan.agents ?? []).filter(a => isShownAgent(a)) };
};
import { outboxNote, outboxPendingFor, outboxResolve } from './outbox.js';

/** 群定义/ transcript 文件名（数据根下）。 */
const FILE_NAME = 'agent-groups.json';
/** transcript 封顶条数（超出裁最旧，裁切留痕）。 */
export const TRANSSCRIPT_KEEP = 200;
/** 群名/成员数上限（写口自卫）。 */
const MAX_GROUPS = 50;
const MAX_MEMBERS = 20;
/** 群名长度上限（与 DeepSeekBot 的 `GROUP_NAME_MAX = 120` 一致）。 */
const GROUP_NAME_MAX = 120;

function httpError(status, message, extra = {}) {
	return Object.assign(new Error(message), { httpStatus: status, ...extra });
}

async function readGroups(config) {
	const file = join(dataRootOf(config), FILE_NAME);
	const parse = (text) => {
		const parsed = JSON.parse(text);
		return Array.isArray(parsed?.groups) ? parsed.groups.filter(g => g && typeof g.id === 'string') : [];
	};
	try {
		return parse(await readFile(file, 'utf8'));
	} catch (e) {
		// 文件不存在 ⇒ 真的还没有群
		if (e && e.code === 'ENOENT') { return []; }
		/* ★★ 2026-10-26 真机报障「群聊发消息后黑屏」：
		   解析失败**不再直接返回空**。发消息走"读-改-整体覆盖写"，前端紧接着 `poll(true)`；
		   如果读到写了一半的文件，这里原先返回 `[]` ⇒ 前端 `S.groups=[]` ⇒ `activeGroup()`
		   变 null ⇒ 消息区被清空（= 黑屏）。
		   ⇒ 给一次 30ms 后的重试（覆盖写通常几十微秒就完成），仍失败才返回空。 */
		await new Promise(r => setTimeout(r, 30));
		try { return parse(await readFile(file, 'utf8')); } catch { return []; }
	}
}

async function writeGroups(config, groups) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, groups }, null, 2);
	JSON.parse(text); // 自证产物合法 ✓
	/* ★★ 原子写（2026-10-26）：先写临时文件再 `rename` 覆盖 ——
	   `writeFile` 直接覆盖会出现"文件已被截断、内容还没写完"的中间态，
	   而读方（前端 poll / 另一个请求）恰好那一刻读 ⇒ 解析失败 ⇒ 返回空群列表 ⇒ 黑屏。
	   POSIX / Windows 上同目录 `rename` 都是原子替换 ⇒ 读方要么看到旧内容、要么看到新内容。 */
	const target = join(root, FILE_NAME);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, 'utf8');
	await rename(tmp, target);
}

/**
 * 未读数（2026-10-21）：上次读过之后新增的**成员回复**条数。
 *
 * 口径（刻意窄）：
 *   · 只数 `role === 'member'` —— 自己的话（user）当然算读过，system（已接力/失败提示）不算"消息"；
 *   · `readAt` 缺省 = 0 ⇒ 一个从未打开过的群，历史成员回复全算未读（与 DSB 一致：首次进群才清）；
 *   · **不落盘**：每次 listGroups 现算（transcript 本来就在手边，O(n) 且 n ≤ 200）。
 */
export function unreadOf(group) {
	const since = typeof group?.readAt === 'number' ? group.readAt : 0;
	return (group?.transcript ?? []).filter(e => e.role === 'member' && (e.at ?? 0) > since).length;
}

/** API/页面用：清单（transcript 一并给；量已被 TRANSSCRIPT_KEEP 兜住 ✓；`unread` 现算）。 */
export async function listGroups(config) {
	const groups = await readGroups(config);
	return { groups: groups.map(g => ({ ...g, unread: unreadOf(g), pending: pendingOf(g) })), keep: TRANSSCRIPT_KEEP };
}

/**
 * 群头像（2026-10-21，对齐 DSB 的 `GroupAvatarCropModal` / `pickGroupAvatar`）。
 *
 * 口径与 DSB 一致：
 *   · 只收 `data:image/(png|jpeg|webp);base64,`；
 *   · **解码后 ≤ 96KB**（页面侧会先居中裁成方形、缩到 256×256，再按质量重压到 96KB 以内）；
 *   · 字符串 ≤ 128KB（防止有人绕过解码直接塞超长串）。
 * `avatar: null / ''` ⇒ 移除头像（回落到首字 + 哈希色）。
 */
export const GROUP_AVATAR_MAX_BYTES = 96 * 1024;
const GROUP_AVATAR_MAX_CHARS = 131072;
const AVATAR_DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;

function avatarBytesOf(dataUrl) {
	const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
	const pad = b64.endsWith('==') ? 2 : (b64.endsWith('=') ? 1 : 0);
	return Math.floor(b64.length * 3 / 4) - pad;
}

/** 校验（非法直接抛 400，带可读原因）。返回规范化后的值（`null` = 移除）。 */
export function normalizeGroupAvatar(value) {
	const raw = String(value ?? '').trim();
	if (!raw) {
		return null;
	}
	if (raw.length > GROUP_AVATAR_MAX_CHARS) {
		throw httpError(400, `头像字符串超长（上限 ${Math.round(GROUP_AVATAR_MAX_CHARS / 1024)}KB）`);
	}
	if (!AVATAR_DATA_URL_RE.test(raw)) {
		throw httpError(400, '头像必须是 data:image/(png|jpeg|webp);base64,… 形式');
	}
	const bytes = avatarBytesOf(raw);
	if (bytes > GROUP_AVATAR_MAX_BYTES) {
		throw httpError(400, `头像太大：${Math.round(bytes / 1024)}KB（上限 96KB）`);
	}
	return raw;
}

/** 设置 / 移除群头像（`avatar: null` ⇒ 删掉这个字段）。 */
export async function setGroupAvatar(config, input) {
	const id = String(input?.id ?? '').trim();
	if (!id) {
		throw httpError(400, 'avatar 需要 id');
	}
	const avatar = normalizeGroupAvatar(input?.avatar);
	return locked(async () => {
		const groups = await readGroups(config);
		const group = groups.find(g => g.id === id);
		if (!group) {
			throw httpError(404, `没有这个群：${id}`);
		}
		if (avatar) {
			group.avatar = avatar;
		} else {
			delete group.avatar;
		}
		group.updatedAt = Date.now();
		await writeGroups(config, groups);
		return { group: { ...group, unread: unreadOf(group) } };
	});
}

/** 标记已读（把人看过的时间点写进 `readAt`，下次 unread 从这里开始算）。 */
export async function markGroupRead(config, input) {
	const id = String(input?.id ?? '').trim();
	if (!id) {
		throw httpError(400, 'read 需要 id');
	}
	return locked(async () => {
		const groups = await readGroups(config);
		const group = groups.find(g => g.id === id);
		if (!group) {
			throw httpError(404, `没有这个群：${id}`);
		}
		group.readAt = Date.now();
		await writeGroups(config, groups);
		return { id: group.id, readAt: group.readAt, unread: 0 };
	});
}

/** 建群。members 必须是真存在的 agent id（封闭集 = 当下扫描结果 ✓）。 */
export async function createGroup(config, input) {
	const name = String(input?.name ?? '').trim().slice(0, GROUP_NAME_MAX);
	if (!name) {
		throw httpError(400, '群名不能为空。');
	}
	const mode = normalizeGroupMode(input?.mode);
	// digest 的两个阈值：非法/缺省 ⇒ 官方默认（5 条 / 30 秒）
	const wake = wakeOf({ wake: input?.wake });
	const members = Array.isArray(input?.members) ? [...new Set(input.members.map(m => String(m ?? '').trim()).filter(Boolean))] : [];
	if (members.length === 0) {
		throw httpError(400, '至少要勾一个成员。');
	}
	if (members.length > MAX_MEMBERS) {
		throw httpError(400, `成员最多 ${MAX_MEMBERS} 个。`);
	}
	const scan = await groupAgentsOf(config);
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
	const group = { id: randomUUID(), name, mode, wake, members, createdAt: Date.now(), updatedAt: Date.now(), transcript: [] };
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

/**
 * 改群设置（2026-10-21，对齐 DSB 的「频道设置 → 群管理」）：群名 / 唤醒策略。
 *
 * 只动**显式给了的字段**（`undefined` 一律忽略 ⇒ 页面可以只发改名，不会顺手把策略冲掉）。
 * 校验口径与 createGroup 一致：群名非空且不重名、mode 收敛到四档、阈值走 wakeOf。
 */
export async function updateGroup(config, input) {
	const id = String(input?.id ?? '').trim();
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	if (input?.name !== undefined) {
		const name = String(input.name).trim().slice(0, GROUP_NAME_MAX);
		if (!name) {
			throw httpError(400, '群名不能为空。');
		}
		if (groups.some(g => g.id !== group.id && g.name === name)) {
			throw httpError(409, `已有同名群：${name}`);
		}
		group.name = name;
	}
	if (input?.mode !== undefined) {
		group.mode = normalizeGroupMode(input.mode);
	}
	// 加入需确认（2026-10-21）：开关本身不碰待确认队列 —— 队列里的条目仍由人逐条决定
	if (input?.requireApproval !== undefined) {
		group.requireApproval = input.requireApproval === true;
	}
	// 换策略 / 换阈值都要把攒着的那几条清掉：否则 digest ⇒ all 会莫名其妙"补发"一批；
	// 反过来 all ⇒ digest 时若留着旧的 `since`，第一次超时会立刻触发 ✗
	if (input?.mode !== undefined || input?.wake !== undefined) {
		group.digest = { count: 0, since: Date.now(), pending: [] };
	}
	if (input?.wake !== undefined) {
		group.wake = wakeOf({ wake: input.wake });
	}
	group.updatedAt = Date.now();
	await writeGroups(config, groups);
	return group;
}

/**
 * 待确认成员（2026-10-21）。
 *
 * 群级开关 `requireApproval` 打开时，邀请**先进待确认区**，人工确认后才进 `members`。
 * 这是 DSB「入群申请 / 审批」在本地单用户场景下的等价物：那边是 bot 主动申请、人批准；
 * 我们这边没有"申请发起方"，但**防误拉**是真需求（随手把 8 个 agent 拉进群不可逆地开始派发）。
 */
export function pendingOf(group) {
	return Array.isArray(group?.pending) ? group.pending : [];
}

/** 邀请/加成员。群里开了 `requireApproval` ⇒ 进待确认区（不进 members）。 */
export async function addGroupMembers(config, input) {
	const id = String(input?.id ?? '').trim();
	const wanted = Array.isArray(input?.members)
		? [...new Set(input.members.map(m => String(m ?? '').trim()).filter(Boolean))]
		: [];
	if (!wanted.length) {
		throw httpError(400, 'members 不能为空。');
	}
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	const scan = await groupAgentsOf(config);
	const known = new Set(scan.agents.map(a => a.id));
	const unknown = wanted.filter(m => !known.has(m));
	if (unknown.length) {
		throw httpError(404, `这些 agent 不存在：${unknown.join('、')}`);
	}
	const before = new Set(group.members ?? []);
	const pendSet = new Set(pendingOf(group).map(p => p.agentId));
	const fresh = wanted.filter(m => !before.has(m) && !pendSet.has(m));

	if (group.requireApproval === true) {
		if (!fresh.length) {
			return { group, pending: [], added: [] };
		}
		const rows = fresh.map(m => ({ id: randomUUID(), agentId: m, requestedAt: Date.now() }));
		group.pending = [...pendingOf(group), ...rows];
		group.updatedAt = Date.now();
		const names = rows.map(r => scan.agents.find(a => a.id === r.agentId)?.name ?? r.agentId);
		appendTranscript(group, { role: 'system', text: `待确认加入：${names.join('、')}（本群设了「加入需确认」）` });
		await writeGroups(config, groups);
		return { group, pending: rows, added: [] };
	}

	const added = fresh;
	if (before.size + added.length > MAX_MEMBERS) {
		throw httpError(400, `成员最多 ${MAX_MEMBERS} 个（现在 ${before.size} 个）。`);
	}
	if (added.length) {
		group.members = [...before, ...added];
		group.updatedAt = Date.now();
		const names = added.map(m => scan.agents.find(a => a.id === m)?.name ?? m);
		appendTranscript(group, { role: 'system', text: `已加入：${names.join('、')}` });
		await writeGroups(config, groups);
	}
	return { group, added };
}

/**
 * 处理一条待确认：确认 ⇒ 进成员；拒绝 ⇒ 只留痕。
 * （没有待确认项 ⇒ 404；达成员上限 ⇒ 400）
 */
export async function decideGroupJoin(config, input) {
	const id = String(input?.id ?? '').trim();
	const agentId = String(input?.agentId ?? '').trim();
	const accept = input?.accept === true;
	if (!agentId) {
		throw httpError(400, 'join-decide 需要 agentId');
	}
	return locked(async () => {
		const groups = await readGroups(config);
		const group = groups.find(g => g.id === id);
		if (!group) {
			throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
		}
		const pending = pendingOf(group);
		if (!pending.some(p => p.agentId === agentId)) {
			throw httpError(404, `没有待确认的成员：${agentId}`);
		}
		group.pending = pending.filter(p => p.agentId !== agentId);
		group.updatedAt = Date.now();
		const scan = await groupAgentsOf(config).catch(() => ({ agents: [] }));
		const name = scan.agents.find(a => a.id === agentId)?.name ?? agentId;
		if (accept) {
			if (!(group.members ?? []).includes(agentId)) {
				if ((group.members?.length ?? 0) >= MAX_MEMBERS) {
					throw httpError(400, `成员最多 ${MAX_MEMBERS} 个，先移出一些再确认。`);
				}
				group.members = [...(group.members ?? []), agentId];
			}
			appendTranscript(group, { role: 'system', text: `已确认加入：${name}` });
		} else {
			appendTranscript(group, { role: 'system', text: `已拒绝加入：${name}` });
		}
		await writeGroups(config, groups);
		return { group, decided: agentId, accept };
	});
}

/** 移出成员（幂等）。允许把群移空 —— 空群仍可改名/邀请，不会被自动删掉。 */
export async function removeGroupMember(config, input) {
	const id = String(input?.id ?? '').trim();
	const member = String(input?.member ?? '').trim();
	if (!member) {
		throw httpError(400, 'member 不能为空。');
	}
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	if (!(group.members ?? []).includes(member)) {
		return { group, removed: false };
	}
	const scan = await groupAgentsOf(config).catch(() => ({ agents: [] }));
	const name = scan.agents.find(a => a.id === member)?.name ?? member;
	group.members = group.members.filter(m => m !== member);
	group.updatedAt = Date.now();
	appendTranscript(group, { role: 'system', text: `已移出：${name}` });
	await writeGroups(config, groups);
	return { group, removed: true };
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

/** 唤醒策略四档（2026-10-21，对齐 DeepSeekBot 的 GroupWakePolicy）。 */
export const GROUP_MODES = ['all', 'mentions', 'digest', 'silent'];
/** 旧值兼容：`open` ⇒ 全员、`admin` ⇒ 仅 @（存量群文件不迁移也能读）。 */
const MODE_ALIASES = { open: 'all', admin: 'mentions' };
export const DEFAULT_WAKE = Object.freeze({ count: 5, intervalSeconds: 30 });

/** 把任意存量值收敛成四档之一（非法值 ⇒ mentions，最保守）。 */
export function normalizeGroupMode(value) {
	const raw = String(value ?? '').trim().toLowerCase();
	const mode = MODE_ALIASES[raw] ?? raw;
	return GROUP_MODES.includes(mode) ? mode : 'mentions';
}

/** digest 的两个阈值（条数 1..100 / 秒 1..3600）。 */
export function wakeOf(group) {
	const w = group?.wake ?? {};
	const count = Number.isInteger(w.count) && w.count >= 1 ? Math.min(w.count, 100) : DEFAULT_WAKE.count;
	const intervalSeconds = Number.isInteger(w.intervalSeconds) && w.intervalSeconds >= 1 ? Math.min(w.intervalSeconds, 3600) : DEFAULT_WAKE.intervalSeconds;
	return { count, intervalSeconds };
}

/**
 * 往群发消息：解析 @ → 按**唤醒策略**决定派发面 → steer → 登记回收。
 *
 * 四档（对齐 DSB 的 `all / mentions / digest / silent`）：
 *   · `all`      —— 每条都派给全体成员；
 *   · `mentions` —— 只派给被 @ 的（一个都没 @ ⇒ 不派发、留系统提示，**如实** ✓）；
 *   · `digest`   —— 普通消息先攒着，**满 `wake.count` 条或等满 `wake.intervalSeconds` 秒**
 *                   就汇总派发一次（超时由 `installGroupTracker` 里的 5s tick 兜底，
 *                   见 `flushDueGroups` —— 2026-10-21 补齐，此前只有按条数触发）；
 *   · `silent`   —— 只进群记录，不唤醒任何成员（`@` 也不唤醒）。
 *
 * 并发：本文件的写口都是「整份读 → 改 → 整份写」，而超时冲刷是在**定时器**里跑的
 * ⇒ 两处必须串行，否则会互相覆盖（丢一条群消息）。所以 `postGroupMessage` 与
 * `flushDueGroups` 都走模块级 `locked()`（同一进程内的 promise 链）。
 */
/* ── 进程内串行（超时冲刷 vs HTTP 写入） ────────────────────────────────── */
let writeChain = Promise.resolve();
/** 把「整份读 → 改 → 整份写」串起来；前一个失败不阻断后续。 */
function locked(fn) {
	const next = writeChain.then(fn, fn);
	writeChain = next.then(() => undefined, () => undefined);
	return next;
}

/** 派一条文本给目标成员（steer + outbox 登记 + 单个失败如实入 transcript）。 */
async function dispatchText(config, state, group, text, targets) {
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
	return dispatched;
}

/** digest 最多留多少条原文（再多只留计数，避免群文件膨胀）。 */
const DIGEST_KEEP = 50;

/** digest 攒着的状态（计数 / 起始时间 / 原文缓冲）。 */
function digestPendingOf(group) {
	const d = group.digest ?? {};
	return {
		count: Number.isInteger(d.count) ? d.count : 0,
		since: typeof d.since === 'number' ? d.since : Date.now(),
		pending: Array.isArray(d.pending) ? d.pending : [],
	};
}

/** 攒着的几条 → 一条汇总文本（1 条原样，多条编号）。 */
function digestText(pending) {
	if (pending.length <= 1) {
		return pending[0] ?? '';
	}
	return `（汇总 ${pending.length} 条群消息）\n\n` + pending.map((t, i) => `${i + 1}. ${t}`).join('\n');
}

/**
 * 超时冲刷：digest 群里「等满 `intervalSeconds` 还没攒够」的，先汇总派发一次。
 *
 * 由 `installGroupTracker` 的 5s tick 调用；也**导出给探针直接调**（不必真等 30 秒）。
 * 返回 `{ flushed: [{ groupId, count }] }`。
 */
export async function flushDueGroups(config, state) {
	return locked(async () => {
		const groups = await readGroups(config);
		const now = Date.now();
		const flushed = [];
		for (const group of groups) {
			if (normalizeGroupMode(group.mode) !== 'digest') {
				continue;
			}
			const d = digestPendingOf(group);
			if (!d.pending.length) {
				continue;
			}
			const wake = wakeOf(group);
			if (now - d.since < wake.intervalSeconds * 1000) {
				continue;
			}
			const scan = await groupAgentsOf(config).catch(() => ({ agents: [] }));
			const everyone = scan.agents.filter(a => (group.members ?? []).includes(a.id));
			const text = digestText(d.pending);
			group.digest = { count: 0, since: now, pending: [] };
			appendTranscript(group, {
				role: 'system',
				text: `digest 模式：等满 ${wake.intervalSeconds} 秒没攒够 ${wake.count} 条，先汇总派发 ${d.pending.length} 条。`,
			});
			await dispatchText(config, state, group, text, everyone);
			flushed.push({ groupId: group.id, count: d.pending.length });
		}
		if (flushed.length) {
			await writeGroups(config, groups);
		}
		return { flushed };
	});
}

export async function postGroupMessage(config, state, input) {
	const id = String(input?.id ?? '').trim();
	const text = String(input?.text ?? '').trim();
	if (!text) {
		throw httpError(400, '消息不能为空。');
	}
	return locked(async () => {
		const groups = await readGroups(config);
		const group = groups.find(g => g.id === id);
		if (!group) {
			throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
		}
		const scan = await groupAgentsOf(config);
		const mentioned = parseMentions(text, group.members, scan.agents);
		const mode = normalizeGroupMode(group.mode);
		const everyone = scan.agents.filter(a => group.members.includes(a.id));
		appendTranscript(group, { role: 'user', text });

		let targets = [];
		// 派发用的正文：digest 攒满时要换成"汇总文本"，其余档就是原消息
		let dispatchBody = text;
		if (mode === 'all') {
			targets = everyone;
		} else if (mode === 'mentions') {
			targets = mentioned;
		} else if (mode === 'silent') {
			appendTranscript(group, { role: 'system', text: 'silent 模式：这条只进群记录，不唤醒成员（改「唤醒策略」才会派发）。' });
			await writeGroups(config, groups);
			return { group, dispatched: [] };
		} else {
			// digest：攒条数；满 count 条**立刻**汇总派发，攒不满则等 tick 超时冲刷
			const wake = wakeOf(group);
			const d = digestPendingOf(group);
			d.count += 1;
			d.pending = [...d.pending, text].slice(-DIGEST_KEEP);
			group.digest = d;
			if (d.count < wake.count) {
				appendTranscript(group, {
					role: 'system',
					text: `digest 模式：已攒 ${d.count}/${wake.count} 条（最多等 ${wake.intervalSeconds} 秒）；攒满或到点就汇总派发。`,
				});
				await writeGroups(config, groups);
				return { group, dispatched: [] };
			}
			group.digest = { count: 0, since: Date.now(), pending: [] };
			appendTranscript(group, { role: 'system', text: `digest 模式：攒满 ${wake.count} 条，汇总派发一次。` });
			dispatchBody = digestText(d.pending);
			targets = everyone;
		}

		if (targets.length === 0) {
			// mentions 模式没 @ 到任何人：不派发，留系统提示（不静默 ✓）
			appendTranscript(group, { role: 'system', text: '仅 @ 派发模式：这条消息没有 @ 到任何成员，未派发。用 @成员名 指定响应者。' });
			await writeGroups(config, groups);
			return { group, dispatched: [] };
		}
		const dispatched = await dispatchText(config, state, group, dispatchBody, targets);
		await writeGroups(config, groups);
		return { group, dispatched };
	});
}

/**
 * 装群回复回收（只装顶层角色，同 relay/assignments 的事件视野判据 ✓）。返回 dispose。
 * 成员会话回合结束 ⇒ 验证消费了我们的群消息 ⇒ 最终文本写回群 transcript（成员气泡）。
 */
export function installGroupTracker(ctx, config, state) {
	const seenSeq = new Map();
	// digest 超时冲刷（2026-10-21）：每 5 秒看一遍有没有「等满了还没攒够」的群。
	// 5s 只是检测粒度，真正的到期判据在 flushDueGroups 里（`wake.intervalSeconds`）。
	// `unref()`：别让这个定时器拖住 dsh Host 进程退出。
	const digestTimer = setInterval(() => {
		void flushDueGroups(config, state).catch(() => undefined);
	}, 5000);
	if (typeof digestTimer.unref === 'function') {
		digestTimer.unref();
	}
	const disposeEvent = ctx.on('agent/turn-stopping', async payload => {
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
		const scan = await groupAgentsOf(config).catch(() => null);
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
	return () => {
		clearInterval(digestTimer);
		disposeEvent?.();
	};
}

/** 诊断/测试用：清 outbox 内存 + 复位惰性读（真源已外迁 outbox.js ✓）。 */
export { resetOutbox as resetGroupDispatch } from './outbox.js';
