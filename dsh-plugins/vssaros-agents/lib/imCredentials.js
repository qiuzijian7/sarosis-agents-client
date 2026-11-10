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
//   ④ ★ 2026-11-10：随包内置的 VsSaros助手（最低优先级，只补上面没填的字段 ⇒ 干净安装也连得上）
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

/**
 * ★ 2026-11-10：随包内置的飞书应用（VsSaros助手）。
 * 与 `vssaros-superagent/dev/src/sources/feishu-share.ts` 的 `BUNDLED_FEISHU_APP` 是同一个应用，
 * 两处必须逐字一致（`run-agents-check.mjs` 守卫会比对）；轮换密钥要同时改两边并 bump 版本。
 * ⚠ 最低优先级：用户填过的字段一律优先，这里只补缺的；Secret 只在 appId 就是内置应用时补，
 *   绝不把内置 Secret 配到用户自己的另一个 appId 上（会连错应用 / 401）。
 * ⚠ 明文编译在 lib/ 是既有产品形态（SuperAgent 侧同样）；只经 stdin 交给 lark-cli，不进接口、不进日志。
 */
export const BUNDLED_FEISHU_APP = Object.freeze({
	appId: 'cli_a860911d2e7f5013',
	appSecret: 'ieEN6Jp4m4l0RTUDBPPROfpo1n3sc7Iz',
});

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

	/* ★ 2026-11-10：内置应用是**最低优先级**回落 —— 干净安装 / 凭据被清空时也能连。
	   走到这里说明 dsh / config / env 都不完整：把用户填过的字段按优先级合并，只补缺的两项。
	   ⚠ Secret 只在 appId 等于内置应用时补，绝不把内置 Secret 配到用户自己的另一个 appId 上。
	   `source:'bundled'` 表示「用了内置回落」（可能同时含用户填的部分字段）。 */
	if (def.key === 'feishu') {
		const merged = {};
		for (const src of [envSec, cfg, dsh]) {
			for (const [k, v] of Object.entries(src || {})) {
				if (String(v ?? '').trim()) { merged[k] = v; }
			}
		}
		if (!merged.appId) { merged.appId = BUNDLED_FEISHU_APP.appId; }
		if (!merged.appSecret && String(merged.appId).trim() === BUNDLED_FEISHU_APP.appId) {
			merged.appSecret = BUNDLED_FEISHU_APP.appSecret;
		}
		if (isComplete(def, merged)) {
			return { platform: def.key, values: merged, configured: true, source: 'bundled' };
		}
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

/* ── 多飞书应用（2026-11-04）─────────────────────────────────────────────────
   需求：一个客户端里**不同 bot 用不同飞书应用**（各自 appId / appSecret）。
   设计（增量、零迁移）：
     · `accounts.feishu` 仍是**默认应用**（老绑定、老入站、设置页「渠道」原样工作）；
     · 额外应用存 `accounts.feishuApps = { [appId]: { appSecret, name, updatedAt } }`；
     · 绑定的 `appId` **留空 = 默认应用**（见 bindings.js）⇒ 改默认应用时老绑定跟着走，与以前一致。
   ⚠ 飞书长连接是**集群模式、不广播**：同一应用多条连接只有随机一条收到事件 ⇒ 每个 appId
     在整台机器上只能连一次（见 imFeishuAppLock.js），多个 bot 共用一个应用时在进程内按绑定分发。 */

/** 飞书 appId 形状（`cli_` + 字母数字）。只做形状校验，不联网。 */
export const FEISHU_APP_ID_RE = /^cli_[A-Za-z0-9]{4,64}$/;

async function feishuAppsOf(config) {
	const accounts = await readImAccounts(config).catch(() => ({}));
	const apps = accounts.feishuApps && typeof accounts.feishuApps === 'object' && !Array.isArray(accounts.feishuApps)
		? accounts.feishuApps : {};
	return { accounts, apps };
}

/**
 * 解析某个飞书应用。`appId` 为空或等于默认应用 ⇒ 默认应用（同 `resolveFeishu`）；
 * 否则查 `feishuApps`。返回 `{ appId, appSecret, configured, source, isDefault }`（含 secret，**只给 Host 用**）。
 */
export async function resolveFeishuApp(config, appId, deps = {}) {
	const want = String(appId ?? '').trim();
	const def = await resolveFeishu(config, deps);
	if (!want || (def.appId && want === def.appId)) {
		return { ...def, isDefault: true };
	}
	const { apps } = await feishuAppsOf(config);
	const hit = apps[want];
	const secret = String((hit && hit.appSecret) ?? '').trim();
	if (secret) {
		return { appId: want, appSecret: secret, configured: true, source: 'dsh-app', isDefault: false };
	}
	/* ★ 2026-11-10：内置应用即使没在凭据池里单独登记，也能作为「非默认应用」被选中使用。 */
	if (want === BUNDLED_FEISHU_APP.appId) {
		return { appId: want, appSecret: BUNDLED_FEISHU_APP.appSecret, configured: true, source: 'bundled', isDefault: false };
	}
	return { appId: want, appSecret: '', configured: false, source: 'none', isDefault: false };
}

/** 全部飞书应用（默认在前、额外的按 appId 排序；不含 secret 明文）。 */
export async function describeFeishuApps(config) {
	const def = await resolveFeishu(config);
	const { apps } = await feishuAppsOf(config);
	const out = [];
	if (def.appId) {
		out.push({ appId: def.appId, name: '', isDefault: true, configured: def.configured, hasSecret: !!def.appSecret, source: def.source });
	}
	for (const id of Object.keys(apps).sort()) {
		if (id === def.appId) { continue; }
		const a = apps[id] || {};
		out.push({ appId: id, name: String(a.name ?? ''), isDefault: false, configured: !!String(a.appSecret ?? '').trim(),
			hasSecret: !!String(a.appSecret ?? '').trim(), source: 'dsh-app' });
	}
	/* ⚠ 这里只反映凭据池；内置应用作为「下拉可选项」由 index.js 的 GET 合并，
	   不改本函数的既有契约（列表条数 / 顺序被多处测试与 UI 消费）。 */
	return out;
}

/**
 * 增改/删除一个**额外**飞书应用。只有人能写（同 `savePlatform`）。
 *   · `remove: true` ⇒ 删除；
 *   · `appSecret` 缺省/留空 ⇒ 保留原值（新建时必填）；
 *   · 默认应用不走这里（改默认应用用 `action:'credentials'`，避免出现两份同 appId 的记录）。
 */
export async function saveFeishuApp(config, input) {
	const kind = String((input && input.actor && input.actor.kind) || 'human').trim().toLowerCase();
	if (kind === 'bot') {
		throw Object.assign(new Error('只有人能配置 IM 应用凭据（bot 不能改写凭据）。'), { httpStatus: 403 });
	}
	const appId = String((input && input.appId) ?? '').trim();
	if (!FEISHU_APP_ID_RE.test(appId)) {
		throw Object.assign(new Error(`飞书 App ID 格式不对：${appId || '(空)'}（应形如 cli_xxxxxxxx）`), { httpStatus: 400 });
	}
	const def = await resolveFeishu(config);
	if (def.appId && appId === def.appId) {
		/* ★ 2026-11-10：内置默认应用统一叫「VsSaros助手」；旧的设置入口已下线，
		   指引改到 Bot 设置页的绑定卡。 */
		throw Object.assign(new Error('这是 VsSaros助手：请在 Bot 设置 → Channel 绑定里修改，不要再加一份。'), { httpStatus: 409 });
	}
	const { accounts, apps } = await feishuAppsOf(config);
	const next = { ...apps };
	if (input && input.remove === true) {
		delete next[appId];
	} else {
		const cur = next[appId] || {};
		const secret = String((input && input.appSecret) ?? '').trim() || String(cur.appSecret ?? '').trim();
		if (!secret) {
			throw Object.assign(new Error('缺少必填项：App Secret'), { httpStatus: 400 });
		}
		const name = input && input.name !== undefined ? String(input.name ?? '').trim().slice(0, 60) : String(cur.name ?? '');
		next[appId] = { appSecret: secret, ...(name ? { name } : {}), updatedAt: Date.now() };
	}
	if (Object.keys(next).length) { accounts.feishuApps = next; } else { delete accounts.feishuApps; }
	await writeImAccounts(config, accounts);
	return describeFeishuApps(config);
}

/* ── bot → 飞书应用（2026-11-09）─────────────────────────────────────────────
   各 Bot 设置页里的「飞书配置」选的是「这个 Bot 用哪个应用」。
   凭据池仍按 appId 全局共享（feishu / feishuApps），这里只存一层轻量映射：
     accounts.botFeishuApps = { [botId]: appId }（没有该项 / 空 = 默认应用）
   ⚠ 不存 secret；与 savePlatform / saveFeishuApp 一样整体读改写，保留其它键。
   ★ 下拉框的数据源是 describeFeishuApps(config)（全局），所以任一个 Bot 配过的应用，
     其它 Bot 的设置页都能看到并复用，不必重复填 App Secret。 */
export async function readBotFeishuApps(config) {
	const accounts = await readImAccounts(config).catch(() => ({}));
	const raw = accounts && typeof accounts.botFeishuApps === 'object' && accounts.botFeishuApps
		? accounts.botFeishuApps : {};
	const out = {};
	for (const [botId, appId] of Object.entries(raw)) {
		const b = String(botId ?? '').trim();
		const a = String(appId ?? '').trim();
		if (b && a) { out[b] = a; }
	}
	return out;
}

/** 设置某个 Bot 选用的飞书应用；`appId` 留空 = 回到默认应用。返回全量映射。 */
export async function saveBotFeishuApp(config, input) {
	const kind = String((input && input.actor && input.actor.kind) || 'human').trim().toLowerCase();
	if (kind === 'bot') {
		throw Object.assign(new Error('只有人能修改 Bot 的飞书应用配置。'), { httpStatus: 403 });
	}
	const botId = String((input && input.botId) ?? '').trim();
	if (!botId) { throw Object.assign(new Error('缺少 botId'), { httpStatus: 400 }); }
	const appId = String((input && input.appId) ?? '').trim();
	if (appId && !FEISHU_APP_ID_RE.test(appId)) {
		throw Object.assign(new Error(`飞书 App ID 格式不对：${appId}`), { httpStatus: 400 });
	}
	const apps = await describeFeishuApps(config);
	if (appId && !apps.some((a) => a.appId === appId)) {
		throw Object.assign(new Error(`这个飞书应用还没配置：${appId}（先在「新增飞书应用」里添加）`), { httpStatus: 400 });
	}
	const accounts = await readImAccounts(config).catch(() => ({}));
	const map = { ...(await readBotFeishuApps(config)) };
	if (appId) { map[botId] = appId; } else { delete map[botId]; }
	if (Object.keys(map).length) { accounts.botFeishuApps = map; } else { delete accounts.botFeishuApps; }
	await writeImAccounts(config, accounts);
	return map;
}
