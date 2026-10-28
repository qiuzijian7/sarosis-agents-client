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

import { renameWithRetry } from './atomicWrite.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { presetIdOf } from './core/agents.js';
import { AGENT_MESSAGE_KIND, finalAssistantContent, finalAssistantText, findOurSplices } from './core/relay.js';
import { isShownAgent } from './core/agents.js';
import { dataRootOf, scanAgentsFromConfig } from './store.js';
import { normalizeFileRefs } from './groupFiles.js';
// 提及解析的**唯一真源**（同时认显示名与 id、长串优先、词尾边界）——别再在这儿写第二套正则
import { collectMentions } from './mentions.js';

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
	await renameWithRetry(tmp, target);
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
	return {
		groups: groups.map(g => ({
			...g,
			unread: unreadOf(g),
			pending: pendingOf(g),
			/* ★ 2026-10-26 成员级策略：把**生效值**一并算好给前端。
			   客户端就不必重复"个人 > 群默认"的回落逻辑（两处实现必然漂移）——
			   它只用 `g.wakePolicies?.[id]` 判断是否「继承」用于显示。 */
			wakeEffective: Object.fromEntries(
				(Array.isArray(g.members) ? g.members : []).map(id => [String(id), effectiveModeFor(g, id)]),
			),
		})),
		keep: TRANSSCRIPT_KEEP,
	};
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
		assertMutable(group, input?.actor);   // 群主权限（2026-10-26）
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
	/* 建群时可指定群主（2026-10-26）：必须是成员；不指定 ⇒ 无群主（人管）。
	   ⚠ 只有**人**能在建群时指定群主（bot 建群不能给自己塞群主，避免提权）。 */
	let ownerAgentId = '';
	if (input?.ownerAgentId !== undefined && input.ownerAgentId !== null) {
		if (normalizeActor(input?.actor).kind !== 'human') {
			throw httpError(403, '只有人能在建群时指定群主。');
		}
		const owner = String(input.ownerAgentId).trim();
		if (owner) {
			if (!members.includes(owner)) {
				throw httpError(400, `群主必须是成员之一：${owner}`);
			}
			ownerAgentId = owner;
		}
	}
	const group = {
		id: randomUUID(), name, mode, wake, members,
		...(ownerAgentId ? { ownerAgentId } : {}),
		createdAt: Date.now(), updatedAt: Date.now(), transcript: [],
	};
	await writeGroups(config, [...groups, group]);
	return group;
}

/** 删群（幂等）。 */
export async function deleteGroup(config, input) {
	const id = String(input?.id ?? '').trim();
	const groups = await readGroups(config);
	// 群主权限（2026-10-26）：删群是破坏性操作，有群主时只允许群主本人或人
	const target = groups.find(g => g.id === id);
	if (target) {
		assertMutable(target, input?.actor);
	}
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
	assertMutable(group, input?.actor);   // 群主权限（2026-10-26）
	/* 移交群主：只有**人**能做（`ownerAgentId: ''` = 取消群主）。
	   ⚠ 不能让群主 bot 自己移交 —— 那等于给了它"提权另一个 bot"的能力。 */
	if (input?.ownerAgentId !== undefined) {
		if (normalizeActor(input?.actor).kind !== 'human') {
			throw httpError(403, '只有人能移交群主（bot 不能改群主，避免互相提权）。');
		}
		const owner = String(input.ownerAgentId ?? '').trim();
		if (!owner) {
			delete group.ownerAgentId;
		} else {
			const members = Array.isArray(group.members) ? group.members.map(String) : [];
			if (!members.includes(owner)) {
				throw httpError(400, `群主必须是本群成员：${owner}`);
			}
			group.ownerAgentId = owner;
		}
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
	/* 派发方式（2026-10-26）：`steer`（抢断当前回合）/ `followup`（排队等回合结束）。
	   `turn` 当别名接受（那是 DeepSeekBot 的叫法，读代码的人容易顺手写）。 */
	if (input?.dispatchMode !== undefined) {
		const raw = String(input.dispatchMode ?? '').trim().toLowerCase();
		const next = raw === 'turn' ? 'followup' : raw;
		if (!DISPATCH_MODES.includes(next)) {
			throw httpError(400, `未知派发方式：${raw || '(空)'}（支持 ${DISPATCH_MODES.join('/')}）`);
		}
		group.dispatchMode = next;
	}
	/* 群内接力（2026-10-26）：**默认关闭**。开启后成员回复里 @ 到别人会转给对方，
	   四道闸（hop / 根事件去重 / 单根上限 / 只认显式 @）在 `planRelay` 里。 */
	if (input?.allowRelay !== undefined || input?.relayMaxHops !== undefined || input?.relayMaxPerRoot !== undefined) {
		const cur = relayOf(group);
		group.relay = {
			enabled: input.allowRelay !== undefined ? input.allowRelay === true : cur.enabled,
			maxHops: Number.isInteger(input.relayMaxHops) ? input.relayMaxHops : cur.maxHops,
			maxPerRoot: Number.isInteger(input.relayMaxPerRoot) ? input.relayMaxPerRoot : cur.maxPerRoot,
		};
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

/* ── 成员级唤醒策略（2026-10-26）────────────────────────────────────────────
   背景：原来一个群只有一个 `mode`（all/mentions/digest/silent）**一刀切** ——
   A bot 想"只 @ 才理"做不到，B bot 想"群里所有消息都跟"也做不到，只能整群迁就。

   现在：`group.wakePolicies = { [agentId]: 'all'|'mentions'|'digest'|'silent' }`，
   缺省（没有该 key）⇒ **继承群 `mode`**。`effectiveModeFor()` 是唯一判据。

   ⚠ 已知取舍（有意为之，不是遗漏）：
     · **digest 攒批仍是群级一份**（`group.digest.pending`）。成员级只决定
       "是否绕过攒批立刻收"（`all`）/"是否完全不收"（`silent`/`mentions`），
       不各自维护独立队列 —— 那是 DeepSeekBot（SQLite per-recipient admission）的做法，
       我们这点消息量不值得引入。
     · 改策略会**清空攒批**（同 `updateGroup` 的既有口径）：否则 digest ⇒ all 会
       莫名补发一批，all ⇒ digest 又会立刻触发一次超时冲刷。
*/
const MEMBER_POLICY_INHERIT = 'inherit';

/** 某成员在某群里**实际生效**的唤醒策略（没有个人配置 ⇒ 继承群）。 */
export function effectiveModeFor(group, agentId) {
	const own = group?.wakePolicies?.[String(agentId ?? '')];
	if (typeof own === 'string' && GROUP_MODES.includes(own)) {
		return own;
	}
	return normalizeGroupMode(group?.mode);
}

/**
 * 设置/清除某个成员的唤醒策略。
 * `mode: 'inherit'` ⇒ 删掉该成员的个人配置（回到继承群）。
 * 返回 `{ group, agentId, mode }`（`mode` 是**生效值**，方便 UI 直接回填）。
 */
export async function setGroupMemberPolicy(config, input) {
	const id = String(input?.id ?? '').trim();
	const agentId = String(input?.agentId ?? '').trim();
	const raw = String(input?.mode ?? '').trim();
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	assertMutable(group, input?.actor);   // 群主权限（2026-10-26）
	if (!agentId) {
		throw httpError(400, 'agentId 不能为空。');
	}
	const members = Array.isArray(group.members) ? group.members.map(String) : [];
	if (!members.includes(agentId)) {
		throw httpError(400, `不是本群成员：${agentId}`);
	}
	if (raw !== MEMBER_POLICY_INHERIT && !GROUP_MODES.includes(raw)) {
		throw httpError(400, `未知策略：${raw}（支持 inherit/${GROUP_MODES.join('/')}）`);
	}
	const next = { ...(group.wakePolicies ?? {}) };
	if (raw === MEMBER_POLICY_INHERIT) {
		delete next[agentId];
	} else {
		next[agentId] = raw;
	}
	group.wakePolicies = next;
	if (Object.keys(next).length === 0) {
		delete group.wakePolicies;
	}
	// 与 updateGroup 同口径：策略变了就把攒着的那批清掉（避免"补发"或"立刻触发超时"）
	group.digest = { count: 0, since: Date.now(), pending: [] };
	group.updatedAt = Date.now();
	await writeGroups(config, groups);
	return { group, agentId, mode: effectiveModeFor(group, agentId) };
}

/**
 * 把某成员在本群的会话绑定**切到一条已有会话**（2026-10-27，「切回旧会话」）。
 *
 * 与 `newGroupSessions` 的分工：那个是**新建**，这个是**改绑**。
 * 校验很关键：只接受"确实是该成员的 preset、且当前活着"的会话 ——
 * 绑到一条已归档/别人的会话上，派发会静默 503（用户只会看到"没反应"）。
 */
export async function bindGroupSession(config, state, input) {
	const id = String(input?.id ?? '').trim();
	const agentId = String(input?.agentId ?? '').trim();
	const sessionId = String(input?.sessionId ?? '').trim();
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	assertMutable(group, input?.actor);
	if (!agentId) {
		throw httpError(400, 'agentId 不能为空。');
	}
	const members = (Array.isArray(group.members) ? group.members : []).map(String);
	if (!members.includes(agentId)) {
		throw httpError(400, `不是本群成员：${agentId}`);
	}
	// 空 sessionId ⇒ 解绑（回到"跟随最近活跃"）
	if (!sessionId) {
		bindMemberSession(group, agentId, '');
		group.updatedAt = Date.now();
		await writeGroups(config, groups);
		return { group, agentId, sessionId: '', bound: false };
	}
	const wantPreset = presetIdOf(agentId);
	const { readLiveSessions } = await import('./live.js');
	const liveRows = await readLiveSessions(config).catch(() => null);
	const liveIds = new Set((state?.agents?.roots?.() ?? []).map(a => a?.session?.id ?? a?.id).filter(Boolean).map(String));
	const row = (liveRows?.rows ?? []).find(r => String(r.id) === sessionId);
	if (!row || String(row.presetId ?? '') !== wantPreset) {
		throw httpError(400, `这条会话不属于 ${agentId}：${sessionId}（只接受该成员自己的会话）`);
	}
	/* 只接受**活着**的会话：绑到一条已归档的会话上，派发会在 `dispatchText` 里 503，
	   而用户只看到"发了没反应" —— 这类错必须在这里拦住并说清原因。 */
	if (!liveIds.has(sessionId)) {
		throw httpError(409, `这条会话当前不在运行，切过去也收不到消息：${sessionId}（先在完整页打开它，或选别的）`);
	}
	bindMemberSession(group, agentId, sessionId);
	group.updatedAt = Date.now();
	await writeGroups(config, groups);
	return { group, agentId, sessionId, bound: true };
}

/**
 * 给群（或其成员）新建会话，并把绑定落到**本群**（2026-10-27）。
 *
 * `mode`：
 *   · `'group'`（默认，安全）：新会话**只绑到本群** —— 该 bot 在私聊/其它群的上下文不受影响。
 *   · `'all'`：新会话绑到本群，**同时清掉该成员在其它群的绑定**（那些群会回落到
 *     "最近活跃" = 这条新会话）⇒ 等价于"到处都换新"。
 *
 * ⚠ 与 DeepSeekBot 的 `/new` 有意不同：那边会 `archiveSession(旧)`，副作用波及该 bot 在
 * **别处**的会话；我们只改**绑定关系**，旧会话原样保留、可以再切回去（不破坏任何数据）。
 */
export async function newGroupSessions(config, state, input) {
	const id = String(input?.id ?? '').trim();
	const mode = String(input?.mode ?? 'group').trim().toLowerCase();
	const onlyAgent = String(input?.agentId ?? '').trim();
	if (mode !== 'group' && mode !== 'all') {
		throw httpError(400, `未知 mode：${mode}（支持 group / all）`);
	}
	const groups = await readGroups(config);
	const group = groups.find(g => g.id === id);
	if (!group) {
		throw httpError(404, `没有这个群：${id || '(没给 id)'}`);
	}
	assertMutable(group, input?.actor);   // 改群上下文属于群设置 ⇒ 走群主闸门
	const scan = await groupAgentsOf(config);
	const memberIds = (Array.isArray(group.members) ? group.members : []).map(String);
	const pool = scan.agents.filter(a => memberIds.includes(String(a.id)));
	const targets = onlyAgent ? pool.filter(a => String(a.id) === onlyAgent) : pool;
	if (!targets.length) {
		throw httpError(400, onlyAgent ? `不是本群成员：${onlyAgent}` : '这个群没有成员。');
	}
	const sc = state?.sessionController;
	if (typeof sc?.create !== 'function') {
		throw httpError(503, '没有 sessionController 服务，开不了会话（dsh 版本不匹配？）。');
	}
	const created = [];
	const failed = [];
	for (const agent of targets) {
		try {
			const res = await sc.create({ agentPreset: presetIdOf(agent.id) });
			const sessionId = String(res?.sessionId ?? '').trim();
			if (!sessionId) { throw new Error('创建成功但没回 sessionId'); }
			bindMemberSession(group, agent.id, sessionId);
			if (mode === 'all') {
				for (const other of groups) {
					if (other.id === group.id) { continue; }
					if (boundSessionOf(other, agent.id)) { bindMemberSession(other, agent.id, ''); }
				}
			}
			created.push({ agentId: String(agent.id), name: agent.name, sessionId });
		} catch (e) {
			failed.push({ agentId: String(agent.id), name: agent.name, error: String(e?.message ?? e) });
		}
	}
	appendTranscript(group, {
		role: 'system',
		text: `已为 ${created.length} 位成员新建会话（${mode === 'all' ? '并同步其它群' : '仅本群'}）`
			+ (failed.length ? `；失败：${failed.map(f => f.name || f.agentId).join('、')}` : ''),
	});
	group.updatedAt = Date.now();
	await writeGroups(config, groups);
	return { group, mode, created, failed };
}

/* ── 群内接力（2026-10-26）──────────────────────────────────────────────────
   目标：成员 A 的回复里 `@` 了 B ⇒ 把 A 的答复转给 B，B 可以接着补充。
   这是**放大器**，不设闸门一定变成刷屏机器，所以默认**关闭**，且四道闸同时生效：

     ① `hop`：用户消息 = 1，每接力一次 +1，超过 `maxHops`(4) 停
        （用户 → A(1) → B(2) → C(3) → D(4) → 停）
     ② **根事件去重**：同一个根消息**不会重复叫醒同一个 bot**
        —— 没有它，A↔B 会无限对答（这是最致命的一条，优先于 hop）
     ③ 单根上限：一个根事件最多触发 `maxPerRoot`(6) 次接力派发，限制了扇出宽度
     ④ 只认**显式 @ 成员**：`@所有人` 在接力里**不生效**（否则一条回复能叫醒全群，
        瞬间爆炸）。这条是靠 `parseMentions` 只匹配成员 id/name 天然实现的。

   ⚠ 为什么不用 DeepSeekBot 的 `MAX_BOT_HOPS=8`：他们群里有几十个 bot 且消息持久化，
     我们是单机小群，4 跳已经够表达"转给谁补充"，再深只会放大噪音。
*/
export const RELAY_MAX_HOPS = 4;
export const RELAY_MAX_PER_ROOT = 6;
const RELAY_LOG_KEEP = 200;

/** 群的接力配置（缺省=关闭；阈值收敛到安全区间，防止手改成 999）。 */
export function relayOf(group) {
	const r = (group && typeof group.relay === 'object' && group.relay) || {};
	const clamp = (v, def, lo, hi) => (Number.isInteger(v) ? Math.min(Math.max(v, lo), hi) : def);
	return {
		enabled: r.enabled === true,
		maxHops: clamp(r.maxHops, RELAY_MAX_HOPS, 1, 8),
		maxPerRoot: clamp(r.maxPerRoot, RELAY_MAX_PER_ROOT, 1, 20),
	};
}

/**
 * 纯决策：一条成员回复该不该触发接力？
 *
 * 返回 `{ targets, reason, nextHop }`：
 *   · `targets` 为空 ⇒ 不接力；`reason` 说明原因（用于系统提示与单测断言）
 *   · 只有 `reason === 'ok'` 才有 `nextHop`
 * 抽成纯函数的原因：这套闸门一旦写错就是**刷屏 / 死循环**，必须在单测里逐条钉住，
 * 而不是靠"上线看看"。
 */
export function planRelay({ group, replyText, hop, rootId, members, agents, log }) {
	const cfg = relayOf(group);
	if (!cfg.enabled) { return { targets: [], reason: 'relay-off' }; }
	const root = String(rootId || '');
	if (!root) { return { targets: [], reason: 'no-root' }; }
	const nextHop = (Number(hop) || 1) + 1;
	if (nextHop > cfg.maxHops) { return { targets: [], reason: 'hop-limit' }; }

	const entries = (Array.isArray(log) ? log : []).filter((e) => e && String(e.rootId || '') === root);
	if (entries.length >= cfg.maxPerRoot) { return { targets: [], reason: 'root-cap' }; }
	const woken = new Set(entries.map((e) => String(e.agentId || '')));

	// 只认成员：`parseMentions` 按 members 过滤，且带词尾边界（`@test` 不命中 `test1`）
	const mentioned = parseMentions(String(replyText || ''), Array.isArray(members) ? members : [],
		Array.isArray(agents) ? agents : []);
	const targets = mentioned.filter((a) => !woken.has(String(a.id)));
	if (!targets.length) {
		return { targets: [], reason: mentioned.length ? 'all-deduped' : 'no-mention' };
	}
	return { targets, reason: 'ok', nextHop };
}

/* ── 群主（2026-10-26）──────────────────────────────────────────────────────
   为什么需要：群现在有"改名 / 改策略 / 加人 / 移人 / 删群"这些**破坏性操作**，
   而以后若让成员 bot 也能动群（比如"群主 bot 拉人入群"），必须先有**权限主体**，
   否则任何一个 bot 都能把别人的群改掉。

   模型（比 DeepSeekBot 的 `ownerBotSlug` 简化，但语义对齐）：
     · `group.ownerAgentId`：群主是某个 agent；**空 = 无群主**（向后兼容：存量群谁都能改）
     · **人永远可以改**（当前只有一个人在用，不需要"人类管理员列表"）
     · 有群主时，**只有群主本人或人**能改
     · 群主**不能自己移交**群主（避免 bot 互相提权）；只有人能移交
*/
/** 把调用方归一成 `{ kind:'human' } | { kind:'bot', agentId }`（缺省 = 人）。 */
export function normalizeActor(input) {
	const raw = input && typeof input === 'object' ? input : {};
	const kind = String(raw.kind ?? 'human').trim().toLowerCase();
	if (kind === 'bot') {
		return { kind: 'bot', agentId: String(raw.agentId ?? '').trim() };
	}
	return { kind: 'human' };
}

/**
 * 纯判定：`null` = 允许改；否则返回**给人看的原因**（调用方抛 403）。
 * 单独抠成纯函数是为了能直接单测 —— 权限判定写错的代价很高（要么谁都能删群，要么谁都改不了）。
 */
export function groupMutableDenial(group, actor) {
	const owner = String(group?.ownerAgentId ?? '').trim();
	const a = normalizeActor(actor);
	if (!owner) { return null; }            // 无群主 ⇒ 不设限
	if (a.kind === 'human') { return null; } // 人永远可以
	if (a.agentId && a.agentId === owner) { return null; }  // 群主本人可以
	return `这个群有群主（${owner}），只有群主本人或人可以修改；当前调用方：${a.agentId || '(未署名 bot)'}`;
}

/** 写入口统一用这个：不允许就抛 403（消息里带原因，前端能直接显示）。 */
function assertMutable(group, actor) {
	const denial = groupMutableDenial(group, actor);
	if (denial) { throw httpError(403, denial); }
}

/* ── 派发方式：抢断 vs 排队（2026-10-26）───────────────────────────────────
   对应 dsh 的两种投递方法（`tools.js` 里的口径说得很清楚）：
     · `steer`    —— 注入**当前回合**："它在干活则下一 step 读到，空闲则直接开回合"
                     ⇒ 长回合会被打断/混进新指令（用户看到"话没说完就被插话"）
     · `followup` —— **等当前回合结束**再作为新回合处理（消息不会丢，只是排队）
   群级开关 `group.dispatchMode`：缺省 `steer`（保持既有行为，不惊扰存量群）。
   ⚠ 不需要自建队列 —— dsh 的 followup 本身就是排队语义，我们再排一层只会更难对账。
*/
export const DISPATCH_MODES = ['steer', 'followup'];

/** 群的派发方式（非法/缺省 ⇒ steer，与改动前行为一致）。 */
export function dispatchModeOf(group) {
	const raw = String(group?.dispatchMode ?? '').trim().toLowerCase();
	// `turn` 是给人读的别名（DeepSeekBot 的叫法），内部统一成 followup
	if (raw === 'turn') { return 'followup'; }
	return DISPATCH_MODES.includes(raw) ? raw : 'steer';
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
	assertMutable(group, input?.actor);   // 群主权限（2026-10-26）
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
	assertMutable(group, input?.actor);   // 群主权限（2026-10-26）
	if (!(group.members ?? []).includes(member)) {
		return { group, removed: false };
	}
	const scan = await groupAgentsOf(config).catch(() => ({ agents: [] }));
	const name = scan.agents.find(a => a.id === member)?.name ?? member;
	group.members = group.members.filter(m => m !== member);
	// ★ 2026-10-27：移出时清掉它的会话绑定，否则群数据里留一个悬空 id（再拉回来会莫名复用旧上下文）
	if (boundSessionOf(group, member)) { bindMemberSession(group, member, ''); }
	group.updatedAt = Date.now();
	appendTranscript(group, { role: 'system', text: `已移出：${name}` });
	await writeGroups(config, groups);
	return { group, removed: true };
}

/** 从消息文本里解析被 @ 的成员（@id 或 @名字；名字含空格的先试最长匹配）。 */
/**
 * 从文本猜收件人（**回退路径**：老客户端/独立页没带 `mentions[]` 时才用）。
 *
 * ★ 2026-10-26：不再自己写一套正则 —— 直接复用 `mentions.js` 的 `collectMentions`
 *   （它同时认显示名与 id、长串优先、词尾边界、丢弃重叠）。
 *   两套实现是漂移之源：之前这里 `includes('@'+name)` 没有边界，
 *   `@test` 会唤醒 `test1`（静默叫错人，比不叫更难查）。
 */
export function parseMentions(text, members, agents) {
	const memberSet = new Set((Array.isArray(members) ? members : []).map(String));
	const pool = (Array.isArray(agents) ? agents : []).filter(a => memberSet.has(String(a.id)));
	const hit = collectMentions(text, pool)
		.filter(m => m.agentId)
		.map(m => String(m.agentId));
	const wanted = new Set(hit);
	return pool.filter(a => wanted.has(String(a.id)));
}

/* （`escapeRe` 已删：解析统一走 `mentions.js`，本文件不再自建正则。） */

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
		/* ★ 2026-10-26：`label` 现在是**显示名**（可有空格），id 走 `agentId`。
		   · 新客户端：`{ start, end, label:'Code Architect', agentId:'code-architect' }`
		   · 老客户端：只给了 `{ label:'code-architect' }` ⇒ 回落成 agentId=label（向后兼容） */
		const agentId = String(item.agentId || '').trim()
			|| (memberIds.has(label) ? label : '');
		if (!agentId || !memberIds.has(agentId) || !agentIds.has(agentId) || seen.has(agentId)) { continue; }
		seen.add(agentId);
		out.push({ start, end, label, agentId });
	}
	return out.sort((a, b) => a.start - b.start);
}

/* ── 群级会话绑定（2026-10-27）──────────────────────────────────────────────
   问题：会话是**按 preset** 的（`ensureMemberSession` 取"该 preset 最近活跃的那条"），
   与群无关 ⇒ 同一个 bot 在 A 群、B 群、私聊里共用一条上下文。于是"给群新建会话"
   只能逐成员新开一条，副作用是该 bot 在**别处**的上下文也一起换了（用户看不到、也不可逆）。

   办法：群上存 `memberSessions = { [agentId]: sessionId }`，派发时**优先用它**：
     · 有绑定且会话还活着 ⇒ 就用它（本群上下文独立、稳定，不会被私聊抢走）
     · 有绑定但会话没了（被删/被归档）⇒ 清掉绑定，回落到"最近活跃"
     · 没有绑定 ⇒ 回落"最近活跃"（**不做自动采纳**：否则一旦绑定，用户改私聊也不会同步，
       反而更困惑；显式「新建会话」才建立绑定，语义清楚）
   参考实现（DeepSeekBot）没做到这一层 —— 它的 session 就是 bot 全局一条。
*/

/** 群内给某成员绑定的会话 id（没有则空串）。 */
export function boundSessionOf(group, agentId) {
	const sid = String((group && group.memberSessions && group.memberSessions[String(agentId ?? '')]) ?? '').trim();
	return sid;
}

/**
 * 纯函数：算出**新的** memberSessions（不改入参）。
 * `sessionId` 传空 ⇒ 删掉该成员的绑定。两者都清空 ⇒ 返回 `undefined`（不落空对象）。
 */
export function withMemberSession(current, agentId, sessionId) {
	const next = { ...(current && typeof current === 'object' ? current : {}) };
	const key = String(agentId ?? '').trim();
	if (!key) { return Object.keys(next).length ? next : undefined; }
	const sid = String(sessionId ?? '').trim();
	if (!sid) { delete next[key]; } else { next[key] = sid; }
	return Object.keys(next).length ? next : undefined;
}

/** 就地改 group 的绑定（调用方负责落盘）。 */
function bindMemberSession(group, agentId, sessionId) {
	const next = withMemberSession(group.memberSessions, agentId, sessionId);
	if (next === undefined) { delete group.memberSessions; } else { group.memberSessions = next; }
}

/**
 * 找成员的活会话：**群内绑定优先**，否则"最近活跃"，都没有就现开一条。
 * 返回 `{ sessionId, created, bound, staleBound }`：
 *   `bound` = 用的是群内绑定；`staleBound` = 绑定的会话已失效（已清掉，调用方该落盘）。
 */
export async function ensureMemberSession(config, state, agent, group) {
	const wantPreset = presetIdOf(agent.id);
	const live = state.agents;
	// projcache 最近活跃的该 preset 会话 ∩ 运行注册表（与 agent_message 的选取同口径 ✓）
	const { readLiveSessions } = await import('./live.js');
	const liveRows = await readLiveSessions(config).catch(() => null);
	const liveIds = new Set((live?.roots?.() ?? []).map(a => a?.session?.id ?? a?.id).filter(Boolean));

	const bound = group ? boundSessionOf(group, agent.id) : '';
	let staleBound = false;
	if (bound) {
		if (liveIds.has(bound)) {
			return { sessionId: bound, created: false, bound: true, staleBound: false };
		}
		// 绑定的会话已经不在了（被删/归档）⇒ 清掉绑定，继续走回落
		bindMemberSession(group, agent.id, '');
		staleBound = true;
	}

	const candidate = (liveRows?.rows ?? [])
		.filter(r => r.presetId === wantPreset && liveIds.has(r.id))
		.sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))[0];
	if (candidate) {
		return { sessionId: candidate.id, created: false, bound: false, staleBound };
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
	return { sessionId, created: true, bound: false, staleBound };
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

/**
 * 把某条投递标成「已回」（2026-10-26）。
 * 按派发时的 `messageId` 在 transcript 里反查 —— 这是唯一能把"成员的回包"对回
 * "当初派给它的那条投递"的键（outbox 条目里也带着同一个 id）。
 */
function markDeliveryReplied(group, messageId, agentId) {
	if (!messageId || !Array.isArray(group?.transcript)) { return false; }
	for (const m of group.transcript) {
		if (!Array.isArray(m?.deliveries)) { continue; }
		const d = m.deliveries.find(x => x && x.id === messageId);
		if (d) {
			d.state = 'replied';
			d.repliedAt = Date.now();
			if (!d.agentId && agentId) { d.agentId = String(agentId); }
			return true;
		}
	}
	return false;
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
async function dispatchText(config, state, group, text, targets, meta = {}) {
	const dispatched = [];
	const deliveries = [];
	/* 接力元信息（2026-10-26）：`hop` 是链路深度，`rootId` 是"这条链从哪条消息起头"。
	   两者都要落进 outbox —— 成员回复时靠它判断"还能不能再往下传"。 */
	const hop = Number(meta.hop) > 0 ? Number(meta.hop) : 1;
	const rootId = String(meta.rootId || '');
	const fromName = String(meta.fromName || '用户');
	for (const agent of targets) {
		try {
			// ★ 传 group：只有群内绑定能保证"本群上下文独立"（见 `ensureMemberSession` 头注释）
			const { sessionId } = await ensureMemberSession(config, state, agent, group);
			const live = state.agents?.get?.(sessionId);
			if (!live || (typeof live.steer !== 'function' && typeof live.followup !== 'function')) {
				throw httpError(503, `会话不在运行，或不支持 steer/followup：${sessionId}`);
			}
			const message = {
				id: randomUUID(),
				role: 'user',
				/* ★ 派发正文的**唯一收敛点**（2026-10-26）：所有路径（普通 / digest 汇总 /
				   `@所有人`）最后都经过这里 ⇒ 预算只需加这一处，不会漏。
				   `transcript` 里存的是全文，这里只截"喂给成员的那份"。 */
				content: [{
					type: 'text',
					text: hop > 1
						/* 接力消息：抬头要写清"这是谁的答复转给你的"，否则成员会以为是用户说话 */
						? `[群聊「${group.name}」· 接力自 ${fromName}（第 ${hop} 跳）]\n${clipDispatchText(text)}\n\n`
							+ '你的答复会回收进群聊记录（最终文本即群消息）。'
							+ '如果还需要别人补充，在答复里 @他；不需要就别 @（每次接力都会占用一次唤醒）。'
						: `[群聊「${group.name}」· 来自用户]\n${clipDispatchText(text)}\n\n`
							+ '你的答复会回收进群聊记录（最终文本即群消息）。',
				}],
				source: {
					kind: AGENT_MESSAGE_KIND, from: null, hop, to: agent.id, group: group.id,
					...(rootId ? { root: rootId } : {}),
				},
			};
			/* 按群的派发方式投递（2026-10-26）：
			   `followup` ⇒ 它跑完当前回合再开新回合（不打断）；`steer` ⇒ 注入当前回合。
			   只有一种方法可用时用它（dsh 版本差异），别因为缺一个就整条失败。 */
			const via = dispatchModeOf(group);
			if (via === 'followup' && typeof live.followup === 'function') {
				live.followup(message);
			} else if (typeof live.steer === 'function') {
				live.steer(message);
			} else {
				live.followup(message);
			}
			outboxNote(config, {
				kind: 'group', sessionId, groupId: group.id, messageId: message.id, via,
				// ★ 供投递状态回收用（回复回来时靠 messageId 反查这条 delivery）
				agentId: agent.id, agentName: agent.name,
				// ★ 接力用：回复回来时要据此判断"还能不能再往下传"
				hop, rootId,
			});
			dispatched.push({ agentId: agent.id, name: agent.name, sessionId });
			deliveries.push({
				id: message.id, agentId: agent.id, name: agent.name,
				state: 'dispatched', at: Date.now(), via,
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
			/* ★ 2026-10-26 成员级策略：群级 mode 不再是"要不要看"的唯一判据 ——
			   只要**有成员**按 digest 收（继承群 digest，或个人指定 digest），队列就该被检查。 */
			const d0 = digestPendingOf(group);
			if (!d0.pending.length) {
				continue;
			}
			const scan0 = await groupAgentsOf(config).catch(() => ({ agents: [] }));
			const pool0 = scan0.agents.filter(a => (group.members ?? []).includes(a.id));
			const digestMembers = pool0.filter(a => effectiveModeFor(group, a.id) === 'digest');
			if (!digestMembers.length) {
				// 没人按攒批收了（策略被改过）⇒ 清掉队列，别让它永远挂着
				group.digest = { count: 0, since: now, pending: [] };
				flushed.push({ groupId: group.id, count: 0, dropped: true });
				continue;
			}
			const d = d0;
			const wake = wakeOf(group);
			if (now - d.since < wake.intervalSeconds * 1000) {
				continue;
			}
			const text = digestText(d.pending);
			group.digest = { count: 0, since: now, pending: [] };
			appendTranscript(group, {
				role: 'system',
				text: `digest：等满 ${wake.intervalSeconds} 秒没攒够 ${wake.count} 条，先汇总派发 ${d.pending.length} 条（${digestMembers.length} 位成员按攒批接收）。`,
			});
			/* 接力的根 = 这批消息里**最新那条用户消息**（与投递状态挂同一处，语义一致） */
			const rootUser = [...(group.transcript ?? [])].reverse().find(m => m.role === 'user');
			const { deliveries } = await dispatchText(config, state, group, text, digestMembers,
				{ hop: 1, rootId: rootUser?.id || '' });
			/* digest 的投递状态挂到"最新那条用户消息"上（一次汇总派发对应一批消息，
			   挂最新一条是可接受的近似；UI 只拿它算"几人已回"）。 */
			const lastUser = [...(group.transcript ?? [])].reverse().find(m => m.role === 'user');
			if (lastUser && deliveries.length) { lastUser.deliveries = deliveries; }
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
		// ⚠ 不再整群取一个 `mode` 提前分支：逐成员生效策略见下面 `effectiveModeFor`
		const everyone = scan.agents.filter(a => group.members.includes(a.id));
		/* ★ 2026-10-26 `@` 提及：客户端给了带 offset 的 `mentions[]` 就用它（**精确**），
		   没给（老客户端/独立页）才回退字符串口径 —— 两条路的收件人集合一致，只是精度不同。 */
		const ats = normalizeMentions(input?.mentions, text, group.members, scan.agents);
		const atAll = ats.some(m => m.kind === 'all')
			|| new RegExp(`@${AT_ALL_LABEL}(?![A-Za-z0-9._-])`).test(text);
		const mentioned = ats.length
			? everyone.filter(a => ats.some(m => m.agentId === String(a.id)))
			: parseMentions(text, group.members, scan.agents);
		/* ★ 记住这条用户消息的引用：派发完成后要往它上面写 `deliveries`（逐成员投递状态），
		   供群头部显示"3 人中 2 人已回"。`appendTranscript` 会新建对象 ⇒ 必须用它返回的那份。 */
		const userEntry = appendTranscript(group, {
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
		/* ★★ 2026-10-26 成员级策略：不再「整群一个 mode」一刀切，而是**逐成员**算生效策略
		   （`effectiveModeFor`：个人配置 > 群默认）。
		   判定顺序（对每个成员）：
		     ① 个人策略是 `silent` ⇒ 永不被唤醒（连 @ 也不 —— 与群级 silent 的既有语义一致）
		     ② 被 @ 到（含 `@所有人`）⇒ 立刻派发（与群级无关，这是"点名"的最高优先级）
		     ③ 个人策略 `all` ⇒ 立刻派发（哪怕群是 mentions/digest）
		     ④ 个人策略 `digest` ⇒ 进攒批队列（攒满/超时再派）
		     ⑤ `mentions` 且没被 @ ⇒ 这条不派
		   ⇒ 于是同一群里可以"A 只 @ 才理、B 全跟、C 攒批看" (DeepSeekBot 的 per-member 效果)。
		   ⚠ 攒批**(队列仍是群级一份)**：只按"谁该收攒批"决定 flush 的收件人，见 `digestMembersOf`。 */
		const atHit = new Set((atAll ? everyone : mentioned).map(a => String(a.id)));
		const nowTargets = [];
		const digestTargets = [];
		const muted = [];
		for (const agent of everyone) {
			const eff = effectiveModeFor(group, agent.id);
			if (eff === 'silent') { muted.push(agent); continue; }
			if (atHit.has(String(agent.id))) { nowTargets.push(agent); continue; }
			if (eff === 'all') { nowTargets.push(agent); continue; }
			if (eff === 'digest') { digestTargets.push(agent); continue; }
			muted.push(agent);   // mentions 且没被 @
		}

		if (digestTargets.length) {
			// 攒条数：满 count 条**立刻**汇总派发，攒不满则等 tick 超时冲刷
			const wake = wakeOf(group);
			const d = digestPendingOf(group);
			d.count += 1;
			d.pending = [...d.pending, text].slice(-DIGEST_KEEP);
			group.digest = d;
			if (d.count < wake.count) {
				appendTranscript(group, {
					role: 'system',
					text: `digest：已攒 ${d.count}/${wake.count} 条（最多等 ${wake.intervalSeconds} 秒；`
						+ `${digestTargets.length} 位成员按攒批接收）；攒满或到点就汇总派发。`,
				});
				// 仍有成员要「立刻收」时不 return（下面继续派 nowTargets）
				if (!nowTargets.length) {
					await writeGroups(config, groups);
					return { group, dispatched: [], deliveries: [] };
				}
			} else {
				group.digest = { count: 0, since: Date.now(), pending: [] };
				appendTranscript(group, { role: 'system', text: `digest：攒满 ${wake.count} 条，汇总派发给 ${digestTargets.length} 位成员。` });
				// 汇总派发用汇总正文；立刻派发用原消息（两批人看到的内容本就不同）
				const { deliveries: digestDeliveries } = await dispatchText(
					config, state, group, digestText(d.pending), digestTargets,
					{ hop: 1, rootId: userEntry.id },
				);
				const lastUser = [...(group.transcript ?? [])].reverse().find(m => m.role === 'user');
				if (lastUser && digestDeliveries.length) { lastUser.deliveries = digestDeliveries; }
			}
		}

		targets = nowTargets;
		if (targets.length === 0) {
			// 没人该被立刻唤醒：不静默 —— 说清"为什么这条没派发"
			appendTranscript(group, {
				role: 'system',
				text: digestTargets.length
					? `这条已进攒批队列（${digestTargets.length} 位成员按攒批接收）。`
					: '没有成员需要这条消息（各自策略：静默 / 仅 @ / 攒批）。用 @成员名 或调「唤醒策略」可改变。',
			});
			await writeGroups(config, groups);
			return { group, dispatched: [], deliveries: [] };
		}
		/* 接力的根 = 这条用户消息的 transcript id（成员回复时带上它做去重） */
		const { dispatched, deliveries } = await dispatchText(config, state, group, dispatchBody, targets,
			{ hop: 1, rootId: userEntry.id });
		/* 逐成员投递状态挂在**这条**用户消息上（成员级策略后，"立刻收"的那批就是针对这条消息） */
		if (deliveries.length) { userEntry.deliveries = deliveries; }
		await writeGroups(config, groups);
		return { group, dispatched, deliveries };
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
		/* ★ 2026-10-27：`kind:'im'` 是 IM 绑定派出去的消息 —— 与群派发走**同一条**回复回收，
		   否则 IM 那条回合结束时这里看不见它（也就永远推不回 IM）。 */
		const pending = outboxPendingFor(session.id).filter(e => e.kind === 'group' || e.kind === 'im');
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
			/* ★ IM 绑定（2026-10-27）：这条回合是 IM 派发的 ⇒ 把最终文本推回那个 IM 会话。
			   不进 transcript（它不属于任何群），失败只记日志 + 交给 deliveries 侧后续展示。 */
			if (entry.kind === 'im') {
				/* ★ 2026-10-27 出站富媒体：IM 回传用**带图**的那份（`finalAssistantContent`），
				   群聊仍用 `final`（纯文本）—— 群 transcript 不该因为出现图就改变形状。 */
				const rich = finalAssistantContent(events);
				const text = (rich && rich.text) || '（这回合没产出文本）';
				const pics = (rich && Array.isArray(rich.images)) ? rich.images : [];
				const hub = state.bindingHub;
				if (hub && typeof hub.deliverForEntry === 'function') {
					hub.deliverForEntry(entry, text, pics)
						.then((r) => {
							if (r && r.ok === false) {
								console.warn(`[vssaros-agents] IM 回传失败（${entry.platform || '?'}:${entry.chatId || '?'}）：${r.reason}`
									+ (r.error ? ' · ' + String(r.error).slice(0, 120) : ''));
							}
						})
						.catch(() => undefined);
				}
				continue;
			}
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
			// ★ 投递状态：把"当初派给它的那条"标成 replied（群头部据此算"N 人中 M 人已回"）
			markDeliveryReplied(group, entry.messageId, entry.agentId);
			dirty = true;

			/* ★ 群镜像（2026-10-27）：这个群如果绑了 IM，成员答复**一并**推过去。
			   带【成员名】前缀 —— IM 那边看不出是谁说的（我们没有 IM 侧的身份映射）。
			   ⚠ 只推最终文本；system 消息（"已接力"等）不推，否则 IM 会被流程噪音淹没。 */
			{
				const hub = state.bindingHub;
				const body = final?.text ?? '';
				const who = speaker?.name ?? (preset || session.id);
				if (hub && typeof hub.deliverForTarget === 'function' && body) {
					hub.deliverForTarget('group', group.id, `【${who}】${body}`)
						.then((rs) => {
							for (const r of rs || []) {
								if (r.ok === false) {
									console.warn(`[vssaros-agents] 群镜像推送到 ${r.platform}:${r.chatId} 失败：${r.reason}`
										+ (r.error ? ' · ' + String(r.error).slice(0, 120) : ''));
								}
							}
						})
						.catch(() => undefined);
				}
			}

			/* ★★ 群内接力（2026-10-26）：这条成员答复里 `@` 了别人 ⇒ 转给对方。
			   四道闸全在 `planRelay` 里（默认关 / hop / 根事件去重 / 单根上限 / 只认显式 @）。
			   ⚠ 只在 `ok` 时派发；被规则挡住时**只在"确实有人被 @"的情况下**留一条系统提示，
			   否则 hop-limit 这种会每轮刷一行，把群记录淹了。 */
			const plan = planRelay({
				group,
				replyText: final ? final.text : '',
				hop: entry.hop,
				rootId: entry.rootId,
				members: group.members,
				agents: scan?.agents ?? [],
				log: group.relayLog,
			});
			if (plan.targets.length) {
				const speakerName = speaker?.name ?? (preset || session.id);
				group.relayLog = [
					...(group.relayLog ?? []),
					...plan.targets.map(a => ({ rootId: String(entry.rootId || ''), agentId: String(a.id), at: Date.now() })),
				].slice(-RELAY_LOG_KEEP);
				appendTranscript(group, {
					role: 'system',
					text: `↪ 接力（第 ${plan.nextHop} 跳）：${speakerName} 的答复转给 ${plan.targets.map(a => a.name || a.id).join('、')}`,
				});
				const relay = await dispatchText(
					config, state, group,
					String(final.text || ''),
					plan.targets,
					{ hop: plan.nextHop, rootId: entry.rootId, fromName: speakerName },
				).catch(e => ({ dispatched: [], deliveries: [], error: String(e?.message ?? e) }));
				if (relay.error) {
					appendTranscript(group, { role: 'system', text: `接力派发失败：${relay.error}` });
				}
			} else if (plan.reason === 'hop-limit' || plan.reason === 'root-cap' || plan.reason === 'all-deduped') {
				appendTranscript(group, {
					role: 'system',
					text: plan.reason === 'hop-limit'
						? `接力已到 ${relayOf(group).maxHops} 跳上限，这条不再往下传。`
						: plan.reason === 'root-cap'
							? `这个根消息已经触发 ${relayOf(group).maxPerRoot} 次接力，不再往下传（防刷屏）。`
							: '被 @ 的成员这一轮已经收到过了（同一根消息不重复唤醒）。',
				});
				dirty = true;
			}
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
