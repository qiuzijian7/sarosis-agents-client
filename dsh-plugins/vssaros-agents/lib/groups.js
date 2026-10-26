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
import { normalizeFileRefs } from './groupFiles.js';

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
		const byId = new RegExp(`@${escapeRe(agent.id)}(?![A-Za-z0-9._-])`).test(text);
		/* ★ 2026-10-26 修：原来 `text.includes('@'+name)` **没有边界** ——
		   `@test` 会命中名为 `test1` 的 bot、`@12` 会命中群名/成员 `123`。
		   这会静默唤醒错人（比不唤醒更难查）。现在要求词尾边界，与 byId 同口径。 */
		const byName = agent.name
			&& new RegExp(`@${escapeRe(agent.name)}(?![A-Za-z0-9._-])`).test(text);
		if (byId || byName) {
			wanted.push(agent);
		}
	}
	return wanted;
}

/** 正则转义（id / name 里可能有 `.`、`-`、`(` 等）。 */
function escapeRe(text) {
	return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `@所有人` 的 token（与客户端 `mentions.js` 的 ALL_LABEL 一致）。 */
const AT_ALL_LABEL = '所有人';

/**
 * 校验客户端传来的 `mentions[]`（2026-10-26）。
 *
 * 为什么要传 offset 而不是让服务端再猜：客户端已经知道"哪些 `@` 是真正的 token"
 * （邮箱里的 `@`、引号里的 `@` 都不算）。服务端只做**防守性校验**：
 *   · `start/end` 必须是整数，且 `text.slice(start,end) === '@' + label`
 *   · `label` 必须是本群成员 id，或 `所有人`
 *   · 任一条不满足 ⇒ **丢弃那一条**（不影响其它条，也不拒绝整条消息）
 * ⇒ 老客户端只发 `text` 时，调用方回退到 `parseMentions`（字符串口径），行为不变。
 */
export function normalizeMentions(raw, text, members, agents) {
	const list = Array.isArray(raw) ? raw : [];
	const memberIds = new Set((Array.isArray(members) ? members : []).map(String));
	const agentIds = new Set((Array.isArray(agents) ? agents : []).map(a => String(a.id)));
	const out = [];
	const seen = new Set();
	for (const item of list) {
		if (!item || typeof item !== 'object') { continue; }
		const start = Number(item.start);
		const end = Number(item.end);
		const label = String(item.label || '').trim();
		if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) { continue; }
		if (!label || String(text).slice(start, end) !== '@' + label) { continue; }
		if (label === AT_ALL_LABEL) {
			const key = 'all';
			if (seen.has(key)) { continue; }
			seen.add(key);
			out.push({ start, end, label, kind: 'all' });
			continue;
		}
		// 只接受"确实是本群成员、且真的存在这只 agent"的 id
		if (!memberIds.has(label) || !agentIds.has(label) || seen.has(label)) { continue; }
		seen.add(label);
		out.push({ start, end, label, agentId: label });
	}
	return out.sort((a, b) => a.start - b.start);
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

/**
 * 追加一条 transcript（超上限裁最旧，并留一条"已裁掉 N 条"的说明）。
 *
 * ★ 2026-10-26：**返回新建的那条**（原来返回 undefined）。原因：投递状态要在派发之后
 * 补写到"这条用户消息"上，而这里会 `{...entry}` 新建对象 ⇒ 调用方必须拿到引用才改得到。
 * 现有调用方都忽略返回值 ⇒ 这个改动对它们是零影响。
 */
function appendTranscript(group, entry) {
	const created = { id: randomUUID(), at: Date.now(), ...entry };
	group.transcript = [...(group.transcript ?? []), created];
	if (group.transcript.length > TRANSSCRIPT_KEEP) {
		const dropped = group.transcript.length - TRANSSCRIPT_KEEP;
		group.transcript = [
			{ id: randomUUID(), at: Date.now(), role: 'system', text: `（早期 ${dropped} 条已按上限 ${TRANSSCRIPT_KEEP} 裁掉）` },
			...group.transcript.slice(dropped),
		];
	}
	group.updatedAt = Date.now();
	return created;
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

/**
 * 派一条文本给目标成员（steer + outbox 登记 + 单个失败如实入 transcript）。
 *
 * ★ 2026-10-26 返回 `{ dispatched, deliveries }`：
 *   `deliveries` 是给 UI 用的**逐成员投递状态**（`dispatched / replied / failed`），
 *   调用方把它挂到那条用户消息上，于是群头部能显示"3 人中 2 人已回"。
 *   以前只有 `dispatched`（且只含成功的），失败只在 transcript 里留一句话 ⇒ 用户看不出"谁没回"。
 */
async function dispatchText(config, state, group, text, targets) {
	const dispatched = [];
	const deliveries = [];
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
				/* ★ 派发正文的**唯一收敛点**（2026-10-26）：所有路径（普通 / digest 汇总 /
				   `@所有人`）最后都经过这里 ⇒ 预算只需加这一处，不会漏。
				   `transcript` 里存的是全文，这里只截"喂给成员的那份"。 */
				content: [{ type: 'text', text: `[群聊「${group.name}」· 来自用户]\n${clipDispatchText(text)}\n\n你的答复会回收进群聊记录（最终文本即群消息）。` }],
				source: { kind: AGENT_MESSAGE_KIND, from: null, hop: 1, to: agent.id, group: group.id },
			};
			live.steer(message);
			outboxNote(config, {
				kind: 'group', sessionId, groupId: group.id, messageId: message.id,
				// ★ 供投递状态回收用（回复回来时靠 messageId 反查这条 delivery）
				agentId: agent.id, agentName: agent.name,
			});
			dispatched.push({ agentId: agent.id, name: agent.name, sessionId });
			deliveries.push({
				id: message.id, agentId: agent.id, name: agent.name,
				state: 'dispatched', at: Date.now(),
			});
		} catch (e) {
			const why = String(e?.message ?? e);
			// 单个成员失败不拖垮整批：失败如实写进 transcript ✓
			appendTranscript(group, { role: 'system', text: `派发给 ${agent.name} 失败：${why}` });
			deliveries.push({
				id: '', agentId: agent.id, name: agent.name,
				state: 'failed', at: Date.now(), error: why,
			});
		}
	}
	if (dispatched.length) {
		appendTranscript(group, { role: 'system', text: `⇢ 已接力：${dispatched.map(d => d.name).join('、')}` });
	}
	return { dispatched, deliveries };
}

/** digest 最多留多少条原文（再多只留计数，避免群文件膨胀）。 */
const DIGEST_KEEP = 50;

/* ── 派发正文预算（2026-10-26）─────────────────────────────────────────────
   为什么要有：`digest` 会把最多 `DIGEST_KEEP`(50) 条消息**拼成一条**派发给成员，
   单条消息也可能是几万字的日志粘贴 ⇒ 一次派发就能把成员的上下文撑爆（模型直接报错或
   静默丢历史）。参考 DeepSeekBot 的 `GROUP_PROMPT_CHARACTER_BUDGET=24k` /
   `GROUP_CONTEXT_BODY_LIMIT=1k`，但我们的派发**只含新消息**（不含整份 transcript），
   所以取更小的量级：整条 12k、digest 里单条 800。

   ⚠ 只在**派给成员的那份文本**上截断；`transcript` 里永远存全文（群记录是真相源，
     界面也要能看全）。截断处会显式写"省略了多少字"，成员不会被无声误导。 */
const DISPATCH_BUDGET_CHARS = 12_000;
const DISPATCH_BODY_LIMIT = 800;
const DIGEST_MAX_ROWS = DIGEST_KEEP;

/** 单条消息的正文截断：保留开头，末尾标出还剩多少字。 */
export function clipBody(text, limit = DISPATCH_BODY_LIMIT) {
	const s = String(text == null ? '' : text).replace(/\s+$/u, '');
	if (s.length <= limit) { return s; }
	return s.slice(0, limit) + `…（本条还有 ${s.length - limit} 字）`;
}

/**
 * 派发正文的总量预算：超了就**保头部 + 保尾部**（开头通常是诉求，结尾通常是结论/细节），
 * 中间显式标注省略量。返回字符串（可直接塞进 message.content）。
 */
export function clipDispatchText(text, budget = DISPATCH_BUDGET_CHARS) {
	const s = String(text == null ? '' : text);
	if (s.length <= budget) { return s; }
	const headLen = Math.floor(budget * 0.6);
	const tailLen = Math.max(0, budget - headLen);
	const omitted = s.length - headLen - tailLen;
	return s.slice(0, headLen)
		+ `\n\n…（正文过长：中间省略 ${omitted} 字；完整内容见群聊记录）…\n\n`
		+ (tailLen > 0 ? s.slice(s.length - tailLen) : '');
}

/** digest 攒着的状态（计数 / 起始时间 / 原文缓冲）。 */
function digestPendingOf(group) {
	const d = group.digest ?? {};
	return {
		count: Number.isInteger(d.count) ? d.count : 0,
		since: typeof d.since === 'number' ? d.since : Date.now(),
		pending: Array.isArray(d.pending) ? d.pending : [],
	};
}

/**
 * 攒着的几条 → 一条汇总文本。
 *
 * 2026-10-26 起**受预算约束**（原来是无脑 join，50 条长消息能拼出几十万字符）：
 *   · 单条先按 `bodyLimit` 截断（默认 800 字）
 *   · 只带**最近** `maxRows` 条，更早的在抬头里写明"未附上 N 条"
 *   · 总量到 `budget` 就停，剩下的同样在抬头里标注
 * 编号保持**原始序号**（从被丢掉的那些之后开始），这样成员看到 "151. …" 就知道前面还有。
 */
export function digestText(pending, opts = {}) {
	const rows = Array.isArray(pending) ? pending.map((t) => String(t == null ? '' : t)) : [];
	const budget = Number.isInteger(opts.budget) ? opts.budget : DISPATCH_BUDGET_CHARS;
	const bodyLimit = Number.isInteger(opts.bodyLimit) ? opts.bodyLimit : DISPATCH_BODY_LIMIT;
	const maxRows = Number.isInteger(opts.maxRows) ? opts.maxRows : DIGEST_MAX_ROWS;
	if (rows.length === 0) { return ''; }
	// 单条：走同一个总量预算（不必编号）
	if (rows.length === 1) { return clipDispatchText(rows[0], budget); }

	const tail = rows.slice(-maxRows);
	const droppedRows = rows.length - tail.length;
	const lines = [];
	let used = 0;
	let budgetStopped = 0;
	for (let i = 0; i < tail.length; i += 1) {
		const line = `${i + 1 + droppedRows}. ${clipBody(tail[i], bodyLimit)}`;
		if (used + line.length > budget) { budgetStopped = tail.length - i; break; }
		lines.push(line);
		used += line.length + 1;
	}
	// 预算小到一条都放不下时，至少给第一条（截断到预算），否则成员收到的是个空壳
	if (lines.length === 0 && tail.length) {
		lines.push(`${1 + droppedRows}. ` + clipBody(tail[0], Math.max(80, budget - 24)));
		budgetStopped = tail.length - 1;
	}
	const head = `（汇总 ${rows.length} 条群消息`
		+ (droppedRows ? `；只附最近 ${tail.length} 条、更早 ${droppedRows} 条未附上` : '')
		+ (budgetStopped ? `；另有 ${budgetStopped} 条因篇幅未附上` : '')
		+ '）';
	return `${head}\n\n${lines.join('\n')}`;
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
	/* ★ 2026-10-26 附件：允许「只有附件、没有文字」的消息。
	   `files[]` 只保留 id/name/size/mime（`normalizeFileRefs` 会把非法 id 丢掉）⇒
	   前端塞什么额外字段都不会落盘。 */
	const files = normalizeFileRefs(input?.files);
	if (!text && !files.length) {
		throw httpError(400, '消息不能为空。');
	}
	return locked(async () => {
		const groups = await readGroups(config);
		const group = groups.find(g => g.id === id);
		if (!group) {
			throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
		}
		const scan = await groupAgentsOf(config);
		const mode = normalizeGroupMode(group.mode);
		const everyone = scan.agents.filter(a => group.members.includes(a.id));
		/* ★ 2026-10-26 `@` 提及：客户端给了带 offset 的 `mentions[]` 就用它（**精确**），
		   没给（老客户端/独立页）才回退字符串口径 —— 两条路的收件人集合一致，只是精度不同。 */
		const ats = normalizeMentions(input?.mentions, text, group.members, scan.agents);
		const atAll = ats.some(m => m.kind === 'all')
			|| new RegExp(`@${AT_ALL_LABEL}(?![A-Za-z0-9._-])`).test(text);
		const mentioned = ats.length
			? everyone.filter(a => ats.some(m => m.agentId === String(a.id)))
			: parseMentions(text, group.members, scan.agents);
		appendTranscript(group, {
			role: 'user',
			text,
			...(files.length ? { files } : {}),
			// 落盘给气泡高亮用（渲染前会再校验 slice===@label，脏 offset 不会显示成错位 chip）
			...(ats.length ? { mentions: ats } : {}),
		});

		let targets = [];
		/* 派发用的正文：digest 攒满时要换成"汇总文本"，其余档就是原消息。
		   ★ 附件：agent 看不到文件字节（只有名字），所以纯附件消息要补一句说明，
		     否则派发出去是一条空正文 ⇒ 成员会把"空消息"当成异常。 */
		let dispatchBody = text || (files.length
			? `（发来 ${files.length} 个附件：${files.map(f => f.name).join('、')}）`
			: '');
		if (mode === 'all') {
			targets = everyone;
		} else if (mode === 'mentions') {
			/* `@所有人` ⇒ 唤醒全群（这是"仅 @ 派发"模式下唯一能一次叫醒所有人的方式） */
			targets = atAll ? everyone : mentioned;
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
