// @vssaros/dsh-agents — DM 配对（**OpenClaw 同构**，2026-10-27）
//
// ── 它解决什么 ──────────────────────────────────────────────────────────────
// `dmPolicy: 'pairing'`（默认）意味着：**陌生人发消息不被处理，也不被静默丢弃**，
// 而是回一个配对码、消息挂起，等人在界面上批准。没有这一层，"默认 pairing" 只是
// 一个判定字符串 —— 陌生人永远进不来，也永远不知道自己该做什么。
//
// ── 与 OpenClaw 对齐的六条规则 ──────────────────────────────────────────────
//   ① 码 **8 位**、大写、**不含 `0 O 1 I`**（人要在手机上手抄/口述）
//   ② **1 小时**过期
//   ③ 每个渠道最多 **3 条**待处理；超出**忽略**（不无限堆积）
//   ④ 批准只写**DM 白名单**；绝不给群权限（群有独立的 `groupAllowFrom`/`rooms`）
//   ⑤ 没有"拒绝"动作（与上游一致）：只能忽略或等过期
//   ⑥ 批准表与 config 的 `allowFrom` **合并**使用（不是替换）
//
// ── 存储 ────────────────────────────────────────────────────────────────────
//   `<dataRoot>/agent-im-pairing.json`
//   { version:1, requests:[{code,platform,chatId,userId,userName,createdAt,expiresAt}],
//     allowed:[{platform,userId,userName,approvedAt}] }
//   ⚠ 原子写 + 0600（与凭据同口径）；每次读都**顺手清理过期**，避免无限增长。
import { renameWithRetry } from './atomicWrite.js';
import { randomInt } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';

export const PAIR_TTL_MS = 60 * 60 * 1000;   // ① 1 小时
export const PAIR_MAX_PENDING = 3;           // ③ 每渠道最多 3 条
export const PAIR_CODE_LEN = 8;              // ② 8 位
/** 去掉 `0 O 1 I`：这四个字符在等宽/手写里最容易看错。 */
export const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const FILE_NAME = 'agent-im-pairing.json';

export function pairingPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 生成一个码（crypto 随机；不用 Math.random —— 这是准入凭据）。 */
export function newPairCode(len = PAIR_CODE_LEN) {
	let out = '';
	for (let i = 0; i < len; i += 1) {
		out += PAIR_ALPHABET[randomInt(0, PAIR_ALPHABET.length)];
	}
	return out;
}

/** 用户输入的码：去空白/连字符、转大写（手抄容易带空格或小写）。 */
export function normalizeCode(input) {
	return String(input ?? '').replace(/[\s-]/g, '').toUpperCase();
}

async function readState(config) {
	try {
		const body = JSON.parse(await readFile(pairingPathOf(config), 'utf8'));
		const requests = Array.isArray(body?.requests) ? body.requests : [];
		const allowed = Array.isArray(body?.allowed) ? body.allowed : [];
		return { requests, allowed };
	} catch {
		return { requests: [], allowed: [] };
	}
}

async function writeState(config, state) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, ...state }, null, 2);
	const target = pairingPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
	await renameWithRetry(tmp, target);
	try { await chmod(target, 0o600); } catch { /* Windows 上 chmod 无意义 */ }
}

/** 清理过期请求（返回被清掉的数量 —— 调用方常用来决定要不要回写）。 */
export function pruneExpired(state, now = Date.now()) {
	const before = state.requests.length;
	state.requests = state.requests.filter((r) => Number(r.expiresAt) > now);
	return before - state.requests.length;
}

/**
 * 为一个陌生人登记配对请求。
 *
 * 返回：
 *   `{ code, expiresAt, reused }` —— 正常（同一人重复发消息 ⇒ **复用同一个码**，
 *     否则对方每发一句就收到一个新码，永远不知道该填哪个）
 *   `{ throttled: true, reason: 'too-many-pending' }` —— 该渠道待处理已满 3 条
 */
export async function requestPairing(config, input, deps = {}) {
	const now = deps.now ? deps.now() : Date.now();
	const platform = String(input?.platform ?? '').trim().toLowerCase();
	const userId = String(input?.userId ?? '').trim();
	if (!platform || !userId) {
		const e = new Error('配对请求缺少 platform / userId');
		e.httpStatus = 400;
		throw e;
	}

	const state = await readState(config);
	pruneExpired(state, now);

	const mine = state.requests.find((r) => r.platform === platform && r.userId === userId);
	if (mine) {
		// 复用：不重复发码，也不占额外配额
		await writeState(config, state);
		return { code: mine.code, expiresAt: mine.expiresAt, reused: true };
	}

	const pendingOfPlatform = state.requests.filter((r) => r.platform === platform).length;
	if (pendingOfPlatform >= PAIR_MAX_PENDING) {
		await writeState(config, state);
		return { throttled: true, reason: 'too-many-pending' };
	}

	const code = newPairCode();
	const expiresAt = now + PAIR_TTL_MS;
	state.requests.push({
		code,
		platform,
		chatId: String(input?.chatId ?? ''),
		userId,
		userName: String(input?.userName ?? ''),
		createdAt: now,
		expiresAt,
	});
	await writeState(config, state);
	return { code, expiresAt, reused: false };
}

/** 列出待批准（已顺手清理过期）。 */
export async function listPairings(config, deps = {}) {
	const now = deps.now ? deps.now() : Date.now();
	const state = await readState(config);
	const removed = pruneExpired(state, now);
	if (removed) { await writeState(config, state); }
	return {
		requests: state.requests.map((r) => ({
			code: r.code,
			platform: r.platform,
			chatId: r.chatId,
			userId: r.userId,
			userName: r.userName,
			createdAt: r.createdAt,
			expiresAt: r.expiresAt,
			expiresInMs: Math.max(0, Number(r.expiresAt) - now),
		})),
		allowed: state.allowed.map((a) => ({ ...a })),
	};
}

/**
 * 批准一个码：把它从待处理移到 **DM 白名单**。
 *
 * ⚠ 只写 DM 白名单（`allowed`），**不碰群** —— 群权限由 `groupAllowFrom` / `rooms` 单独控制。
 *   这与上游一致：批准一个人私聊，不等于让他在群里驱动 bot。
 */
export async function approvePairing(config, input, deps = {}) {
	const now = deps.now ? deps.now() : Date.now();
	const code = normalizeCode(input?.code);
	const platform = String(input?.platform ?? '').trim().toLowerCase();
	if (!code) {
		const e = new Error('缺少配对码');
		e.httpStatus = 400;
		throw e;
	}

	const state = await readState(config);
	pruneExpired(state, now);

	const idx = state.requests.findIndex((r) => r.code === code && (!platform || r.platform === platform));
	if (idx < 0) {
		const e = new Error(`没有这个待批准的配对码：${code}（可能已过期、已批准，或平台不符）`);
		e.httpStatus = 404;
		throw e;
	}
	const req = state.requests.splice(idx, 1)[0];
	const already = state.allowed.some((a) => a.platform === req.platform && a.userId === req.userId);
	if (!already) {
		state.allowed.push({
			platform: req.platform,
			userId: req.userId,
			userName: req.userName || '',
			approvedAt: now,
		});
	}
	await writeState(config, state);
	return { platform: req.platform, userId: req.userId, userName: req.userName || '', already };
}

/** 已批准的 userId 列表（喂给准入判定，与 config 的 allowFrom **合并**）。 */
export async function approvedUserIds(config, platform) {
	const p = String(platform ?? '').trim().toLowerCase();
	const state = await readState(config);
	return state.allowed.filter((a) => a.platform === p).map((a) => String(a.userId));
}

/** 撤销某个人的 DM 批准（运营动作；OpenClaw 用 CLI，我们给接口）。 */
export async function revokePairing(config, input) {
	const platform = String(input?.platform ?? '').trim().toLowerCase();
	const userId = String(input?.userId ?? '').trim();
	const state = await readState(config);
	const before = state.allowed.length;
	state.allowed = state.allowed.filter((a) => !(a.platform === platform && a.userId === userId));
	await writeState(config, state);
	return { removed: before - state.allowed.length };
}
