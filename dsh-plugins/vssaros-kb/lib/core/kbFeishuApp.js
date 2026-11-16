// @vssaros/dsh-kb — 知识库「飞书应用（appId / appSecret）」配置的纯逻辑（2026-11-10）
//
// 用户诉求：知识库设置页能指定自己的飞书应用；原先 lark-cli 用的是产品随包的共享应用，
//   2026-11-11 起产品不再内置任何飞书应用凭据 ⇒ 必须由用户在「设置 → 渠道」配置自己的应用。
//
// 仓内已验证的 lark-cli 应用切换方式（照 vssaros-superagent/lib/environment-YhSAne6L.js:284-305）：
//   lark-cli profile add --name <appId> --app-id <appId> --app-secret-stdin --brand feishu
//       stdin = "<appSecret>\n"
//   之后每条命令前置 `--profile <appId>`（同文件 :1252-1256 的 larkArgv）。
// ⚠ 全仓 0 处证据表明 lark-cli 读 LARK_APP_ID/LARK_APP_SECRET 环境变量 ⇒ 不要走 env 传密钥 ✗。
//
// 安全红线：appSecret 不进 argv、不进 .kb-settings.json、不进日志、不回显；
//   只进宿主凭据库（ctx.credentials ⇒ <dshHome>/.credentials.yaml）与 lark-cli 的 stdin。
//
// 纯函数：不 import fs / child_process，便于守卫直测。

/** 凭据引用名前缀（与 kbGitRemote.js 的 KB_GIT_TOKEN_REF_PREFIX 同口径，必须是 POSIX 标识符）。 */
export const APP_SECRET_REF_PREFIX = 'VSSAROS_KB_FEISHU_APP_SECRET_';
/** 飞书 appId 形态（照 superagent 的 Feishu Source 校验；空串 = 未配置）。 */
const APP_ID_RE = /^(cli_[A-Za-z0-9]+)?$/;

export function sanitizeAppId(raw) {
	return String(raw ?? '').trim();
}

export function isValidAppId(raw) {
	return APP_ID_RE.test(sanitizeAppId(raw));
}

/** appId ⇒ 凭据引用名；按 appId 区分 ⇒ 切回旧应用时不用重填 secret。 */
export function credentialRefForApp(appId) {
	let s = sanitizeAppId(appId).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
	if (!s) { return ''; }
	if (!/^[A-Z]/.test(s)) { s = 'V' + s; }
	return APP_SECRET_REF_PREFIX + s;
}

/** 每条 lark-cli 命令前置的全局参数；没配应用 ⇒ 空数组（保持旧的默认 profile 行为）。 */
export function profileArgsOf(appId) {
	const id = sanitizeAppId(appId);
	return isValidAppId(id) && id ? ['--profile', id] : [];
}

/** 建 profile 的参数；**secret 不在 argv 里**，由调用方写 stdin。 */
export function profileAddArgs(appId) {
	const id = sanitizeAppId(appId);
	return ['profile', 'add', '--name', id, '--app-id', id, '--app-secret-stdin', '--brand', 'feishu'];
}

/**
 * ★ 2026-11-11 真机事故：`profile add` 对**已存在**的 profile 会直接失败。
 *   superagent 的 `larkProfiles.create` 注释早就写明「Profiles that already exist are
 *   never changed; setup only checks them」—— KB 侧原来每次保存都无条件 add ⇒ 重复添加
 *   必然失败，还误报「命令可能仍用旧应用」，而实际 profile 已 active/effective ✗。
 *   ⇒ 建之前先 `profile list`，已存在就沿用。
 */
export const PROFILE_LIST_ARGS = ['profile', 'list'];

/**
 * 从 `profile list` 输出里判断某个 appId 的 profile 是否已存在。
 * ⚠ 不依赖严格 JSON：CLI 可能在 JSON 前后混日志行 / 通知块，只抓 `"name"` / `"appId"` 字段值。
 */
export function hasLarkProfile(raw, appId) {
	const id = sanitizeAppId(appId);
	if (!id) { return false; }
	const text = String(raw ?? '');
	for (const m of text.matchAll(/"(?:name|appId)"\s*:\s*"([^"]+)"/g)) {
		if (String(m[1]).trim() === id) { return true; }
	}
	return false;
}

/**
 * POST /api/kb-settings 里 `feishu.appSecret` 的三种语义（照 imCredentials.savePlatform）：
 *   缺失/空串 = 不改；null = 清除；非空字符串 = 写入凭据库并重建 profile。
 */
export function secretIntentOf(raw) {
	if (raw === null) { return 'clear'; }
	if (typeof raw === 'string' && raw.trim()) { return 'set'; }
	return 'keep';
}
