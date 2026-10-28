// @vssaros/dsh-agents — IM 应用凭据（**dsh 侧唯一真源 · 多平台**，2026-10-27）
//
// ── 存储 ────────────────────────────────────────────────────────────────────
//   `<dataRoot>/agent-im-accounts.json`
//   { "version": 1, "accounts": { "feishu": { "appId": "…", "appSecret": "…" },
//                                 "telegram": { "botToken": "…" } } }
//
// ── 取值优先级（`resolvePlatform`）──────────────────────────────────────────
//   ① 这个文件（dsh 侧，用户在「设置 → 渠道」里填的）
//   ② `config.<platform>`（IDE 覆盖层注入的旧配置 —— 只有 feishu 有这条）
//   ③ 环境变量（只有 feishu：`VSSAROS_FEISHU_APP_ID/SECRET`）
//   一个字段都不缺才算 `configured`（半份凭据不算 —— 否则页面显示"已配置"却连不上）。
//
// ── 平台与字段的**定义**不在这里 ────────────────────────────────────────────
//   在 `imPlatforms.js`（单一真源，随 GET 接口发给客户端渲染表单）。
//   这里只负责"按定义存取"，不写死任何字段名 —— 加一个平台只改那一个文件。
//
// ── 安全 ────────────────────────────────────────────────────────────────────
//   · 文件 0600，只在本机用户数据根；
//   · 接口只回**掩码**（`hasSecret` + 打码后的非 secret 字段），永不回 secret 明文；
//   · 只有人能写（`kind:'bot'` ⇒ 403）。
import { renameWithRetry } from './atomicWrite.js';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { dataRootOf } from './store.js';
import { IM_PLATFORM_KEYS, platformDefOf } from './imPlatforms.js';

const FILE_NAME = 'agent-im-accounts.json';

/** 凭据文件路径（单测直接用）。 */
export function imAccountsPathOf(config) {
	return join(dataRootOf(config), FILE_NAME);
}

/** 读全部平台账号（缺文件/解析失败 ⇒ 空表，不抛）。 */
export async function readImAccounts(config) {
	try {
		const body = JSON.parse(await readFile(imAccountsPathOf(config), 'utf8'));
		return body && typeof body === 'object' && body.accounts && typeof body.accounts === 'object'
			? body.accounts
			: {};
	} catch {
		return {};
	}
}

/** 原子写 + 0600（半截文件会让"读不到凭据"变成随机行为）。 */
async function writeImAccounts(config, accounts) {
	const root = dataRootOf(config);
	await mkdir(root, { recursive: true });
	const text = JSON.stringify({ version: 1, accounts }, null, 2);
	const target = imAccountsPathOf(config);
	const tmp = target + '.tmp-' + String(process.pid) + '-' + Date.now().toString(36);
	await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
	await renameWithRetry(tmp, target);
	try { await chmod(target, 0o600); } catch { /* Windows 上 chmod 无意义，忽略 */ }
}

/** 打码：长值保留前后缀，短值只留前两位。用于**非 secret** 字段（如 appId 能认出是哪个应用）。 */
export function maskValue(value) {
	const s = String(value ?? '').trim();
	if (!s) { return ''; }
	if (s.length <= 6) { return s.slice(0, 2) + '***'; }
	return s.slice(0, 6) + '…' + s.slice(-2);
}

/** 兼容旧调用（只给 appId 打码时用过这个名字）。 */
export const maskAppId = maskValue;

/** 该平台的 `config` 回落（IDE 覆盖层）：目前只有 feishu 注入过。 */
function configSectionOf(config, platform) {
	if (platform !== 'feishu') { return {}; }
	return (config && config.feishu) || {};
}

/** 该平台的环境变量回落：目前只有 feishu。 */
function envSectionOf(env, platform) {
	if (platform !== 'feishu') { return {}; }
	return {
		appId: String(env.VSSAROS_FEISHU_APP_ID ?? '').trim(),
		appSecret: String(env.VSSAROS_FEISHU_APP_SECRET ?? '').trim(),
	};
}

/** 定义里所有必填字段是否都非空。 */
function isComplete(def, values) {
	return def.fields.every((f) => !f.required || String((values || {})[f.key] ?? '').trim());
}

/**
 * 解析某平台的凭据。返回 `{ platform, values, configured, source }`。
 * `values` 是**完整值**（含 secret 明文）—— 只给 Host 内部用，绝不直接回接口。
 * `source` = `'dsh' | 'config' | 'env' | 'none'`（页面上要显示"这条从哪来"）。
 */
export async function resolvePlatform(config, platform, deps = {}) {
	const def = platformDefOf(platform);
	if (!def) {
		return { platform: String(platform ?? ''), values: {}, configured: false, source: 'none' };
	}
	const env = deps.env || process.env;

	const accounts = await readImAccounts(config).catch(() => ({}));
	const dsh = accounts[def.key] || {};
	if (isComplete(def, dsh)) {
		return { platform: def.key, values: { ...dsh }, configured: true, source: 'dsh' };
	}

	const cfg = configSectionOf(config, def.key);
	if (isComplete(def, cfg)) {
		return { platform: def.key, values: { ...cfg }, configured: true, source: 'config' };
	}

	const envSec = envSectionOf(env, def.key);
	if (isComplete(def, envSec)) {
		return { platform: def.key, values: { ...envSec }, configured: true, source: 'env' };
	}

	return { platform: def.key, values: {}, configured: false, source: 'none' };
}

/** 飞书专用便捷包装（入站 transport 用；字段名固定 appId/appSecret）。 */
export async function resolveFeishu(config, deps = {}) {
	const r = await resolvePlatform(config, 'feishu', deps);
	return {
		appId: String(r.values.appId ?? ''),
		appSecret: String(r.values.appSecret ?? ''),
		configured: r.configured,
		source: r.source,
	};
}

/** 单个平台的**掩码视图**（绝不包含 secret 明文）。 */
export async function describePlatform(config, platform) {
	const def = platformDefOf(platform);
	if (!def) { return null; }
	const r = await resolvePlatform(config, def.key);
	const fields = {};
	let hasSecret = false;
	for (const f of def.fields) {
		const v = String(r.values[f.key] ?? '');
		if (f.secret) {
			if (v) { hasSecret = true; }
			continue; // secret 明文**不进**视图
		}
		fields[f.key] = maskValue(v);
	}
	return {
		key: def.key,
		label: def.label,
		icon: def.icon,
		implemented: !!def.implemented,
		note: def.note || '',
		configured: r.configured,
		source: r.source,
		hasSecret,
		fields,
	};
}

/** 所有平台的掩码视图（客户端直接渲染这棵树，不自己拼字段名）。 */
export async function describePlatforms(config) {
	const out = [];
	for (const key of IM_PLATFORM_KEYS) {
		const d = await describePlatform(config, key);
		if (d) { out.push(d); }
	}
	return out;
}

/**
 * 把**旧位置**（IDE 设置 `sessions.channel.feishu.*` → `--patch` 覆盖层 → `config.feishu`）
 * 的凭据**一次性**搬进 dsh 侧文件（2026-10-27「数据源统一」）。
 *
 * 为什么要迁移而不是直接删旧链路：
 *   用户可能已经在 IDE 里填过凭据。如果那天直接下线 IDE 侧，
 *   他会在下次启动发现自己"配好了却显示未配置"—— 而且原始值已被删掉的 UI 挡住，拿不回来。
 *   ⇒ 先搬（不丢），再下线（不歧义）。
 *
 * 语义：
 *   · dsh 文件里**已有** feishu ⇒ 什么都不做（dsh 侧是权威，绝不覆盖用户后来的修改）
 *   · dsh 文件里没有、而 `config.feishu` 两项齐全 ⇒ 写进文件，并记 `migratedFrom`
 *   · 半份凭据不搬（搬进去也连不上，只会让页面显示"已配置"却报 unavailable）
 *
 * 返回 `{ migrated, reason? }`，调用方只记日志（启动期不该因为它失败而中断）。
 */
export async function migrateLegacyFeishu(config, deps = {}) {
	const now = deps.now ? deps.now() : Date.now();
	const accounts = await readImAccounts(config).catch(() => ({}));
	const cur = accounts.feishu || {};
	if (String(cur.appId ?? '').trim() && String(cur.appSecret ?? '').trim()) {
		return { migrated: false, reason: 'already-in-dsh' };
	}
	const cfg = (config && config.feishu) || {};
	const appId = String(cfg.appId ?? '').trim();
	const appSecret = String(cfg.appSecret ?? '').trim();
	if (!appId || !appSecret) {
		return { migrated: false, reason: 'nothing-to-migrate' };
	}
	accounts.feishu = { appId, appSecret, updatedAt: now, migratedFrom: 'ide-overlay' };
	await writeImAccounts(config, accounts);
	return { migrated: true, reason: 'from-ide-overlay', appIdMasked: maskValue(appId) };
}

/** 兼容旧调用：飞书掩码视图（index.js 的 `feishu` 字段还在用）。 */
export async function describeFeishu(config) {
	const d = await describePlatform(config, 'feishu');
	return {
		configured: !!(d && d.configured),
		source: (d && d.source) || 'none',
		appIdMasked: (d && d.fields && d.fields.appId) || '',
		hasSecret: !!(d && d.hasSecret),
	};
}

/**
 * 写某平台凭据。
 *
 * 语义：
 *   · `secret` 字段**缺省**（undefined）⇒ 保留原值（用户只改 appId 时不会把 secret 清掉）；
 *   · `secret` 字段传 `null` ⇒ 清除该字段；
 *   · 传空串 ⇒ 视为"没改"（表单里留空就是没改，与 null 区分开）。
 *   · 所有字段都为空 ⇒ 删掉该平台的记录。
 *
 * ⚠ 允许写 `implemented:false` 的平台（结构上支持多渠道），但会带上
 *   `implemented:false`，界面据此标注"暂未接入，保存不会生效"。
 */
export async function savePlatform(config, platform, input) {
	/* 只有人能写凭据：bot 拿到写权 = 能把凭据换成自己的（数据外泄面）。
	   与 `bindings.js` 的 `assertHuman` 同口径：显式 `kind:'bot'` 才拒，缺省按人。 */
	const kind = String((input && input.actor && input.actor.kind) || 'human').trim().toLowerCase();
	if (kind === 'bot') {
		const e = new Error('只有人能配置 IM 应用凭据（bot 不能改写凭据）。');
		e.httpStatus = 403;
		throw e;
	}

	const def = platformDefOf(platform);
	if (!def) {
		const e = new Error(`未知平台：${String(platform ?? '')}（支持 ${IM_PLATFORM_KEYS.join(' / ')}）`);
		e.httpStatus = 400;
		throw e;
	}

	const accounts = await readImAccounts(config);
	const cur = accounts[def.key] || {};
	const next = { ...cur };

	for (const f of def.fields) {
		const raw = input ? input[f.key] : undefined;
		if (raw === undefined) { continue; }                 // 没给 ⇒ 不动
		if (raw === null) { delete next[f.key]; continue; }   // 显式清除
		const v = String(raw).trim();
		if (!v && f.secret) { continue; }                     // 表单留空 ⇒ 保留
		if (!v) { delete next[f.key]; continue; }
		next[f.key] = v;
	}

	const hasAny = def.fields.some((f) => String(next[f.key] ?? '').trim());
	if (!hasAny) {
		delete accounts[def.key];
		await writeImAccounts(config, accounts);
		return describePlatform(config, def.key);
	}

	/* 必填缺失 ⇒ 拒（别存半份：读取侧会静默回落，用户以为保存成功）。
	   ⚠ 但**显式 `null` 的字段不算缺失** —— 那是"我要清掉它"的明确意图，
	     允许保存（结果是该平台变成"未配置"，页面会如实显示），
	     不能反过来报"缺少必填项"把用户的清除操作挡回去（2026-10-27 单测抓到的）。 */
	const cleared = new Set(
		def.fields.filter((f) => input && input[f.key] === null).map((f) => f.key),
	);
	const missing = def.fields
		.filter((f) => f.required && !cleared.has(f.key) && !String(next[f.key] ?? '').trim())
		.map((f) => f.label);
	if (missing.length) {
		const e = new Error(`缺少必填项：${missing.join('、')}`);
		e.httpStatus = 400;
		throw e;
	}

	accounts[def.key] = { ...next, updatedAt: Date.now() };
	await writeImAccounts(config, accounts);
	return describePlatform(config, def.key);
}

/** 兼容旧调用：只写飞书。 */
export function saveFeishu(config, input) {
	return savePlatform(config, 'feishu', input);
}
