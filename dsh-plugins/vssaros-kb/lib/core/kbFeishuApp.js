// @vssaros/dsh-kb — 知识库「飞书应用（appId / appSecret）」配置的纯逻辑（2026-11-10）
//
// 用户诉求：知识库设置页能指定自己的飞书应用；当前 lark-cli 用的是随包内置的
//   `cli_a860911d2e7f5013`（vssaros-superagent 的 BUNDLED_FEISHU_APP），不是他想要的那个。
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

/** 建/更新 profile 的参数；**secret 不在 argv 里**，由调用方写 stdin。 */
export function profileAddArgs(appId) {
	const id = sanitizeAppId(appId);
	return ['profile', 'add', '--name', id, '--app-id', id, '--app-secret-stdin', '--brand', 'feishu'];
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
