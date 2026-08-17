/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 敏感路径单一真源（single source of truth）。
 *
 * 背景：此前读、写各自维护一份硬编码常量表，且两表长期漂移——写保护了
 * `.ssh/ .aws/ .kube/ .config/gcloud/ .git-credentials`，读却只挡了
 * `/dev/ /proc/ /sys/`，导致 `~/.ssh/id_rsa`、`~/.aws/credentials`、
 * `.env.local` 等**可被读取**，内容随对话历史上传到模型提供方。
 *
 * 本模块把两表合并为单一真源，并统一匹配语义（此前读用 startsWith、
 * 写用 includes('/'+prefix)，且 `.git-credentials` 这一文件名被错放进
 * 「目录前缀」表里靠 includes 侥幸生效）。
 *
 * 纯逻辑模块（无 VS Code 依赖，可独立单测），对齐 commandSafety.ts /
 * terminalCommandGuards.ts 的模式。
 *
 * 读写策略差异由调用方决定，不在本模块编码：
 *  - 设备路径：读写都应硬拦（读会阻塞、泄露内核信息）。
 *  - 凭据路径：写恒拦（写凭据文件无合理场景）；读受
 *    `chat.agent.sensitiveReadGuard` 配置控制（默认开启，允许用户显式放行）。
 */

/** 命中类别。 */
export type SensitiveMatchKind = 'device' | 'directory' | 'filename';

/** 一次命中的结果。 */
export interface ISensitivePathMatch {
	readonly kind: SensitiveMatchKind;
	/** 命中的表项（用于错误消息与日志）。 */
	readonly matched: string;
}

/**
 * 设备 / 内核伪文件系统前缀。读取可能阻塞（`/dev/random`）或泄露内核与
 * 进程信息（`/proc/`、`/sys/`）。以绝对路径前缀匹配。
 */
export const DEVICE_PATH_PREFIXES: readonly string[] = ['/dev/', '/proc/', '/sys/'];

/**
 * 凭据 / 密钥目录。路径中任意层级出现该目录即命中
 * （如 `C:/Users/x/.ssh/id_rsa`、`/home/x/.config/gcloud/creds.db`）。
 */
export const SENSITIVE_DIR_SEGMENTS: readonly string[] = [
	'.ssh',
	'.aws',
	'.kube',
	'.config/gcloud',
];

/**
 * 凭据 / 密钥文件名（basename 全等匹配）。
 *
 * 注意 `.npmrc` / `.pypirc` 常含 authToken，因此一并纳入；若项目里确实
 * 需要读取（例如排查 registry 配置），可关闭 `chat.agent.sensitiveReadGuard`。
 */
export const SENSITIVE_FILE_NAMES: readonly string[] = [
	'.env',
	'.env.local',
	'.env.production',
	'.env.development',
	'.git-credentials',
	'auth.json',
	'.anthropic_oauth.json',
	'.npmrc',
	'.pypirc',
];

/** 归一化：反斜杠 → 正斜杠、转小写（Windows 大小写不敏感，Linux 从严）。 */
function normalizePath(p: string): string {
	return p.replace(/\\/g, '/').toLowerCase();
}

/**
 * 检测设备 / 内核伪文件系统路径。命中返回匹配项，否则 undefined。
 */
export function detectDevicePath(resolvedPath: string): ISensitivePathMatch | undefined {
	if (!resolvedPath) { return undefined; }
	const normalized = normalizePath(resolvedPath);
	const hit = DEVICE_PATH_PREFIXES.find(prefix => normalized.startsWith(prefix));
	return hit ? { kind: 'device', matched: hit } : undefined;
}

/**
 * 检测凭据 / 密钥路径（目录或文件名）。命中返回匹配项，否则 undefined。
 *
 * 不含设备路径判定 —— 设备路径请用 {@link detectDevicePath}，因为两者的
 * 放行策略不同（设备恒拦，凭据读可由配置放行）。
 */
export function detectSensitivePath(resolvedPath: string): ISensitivePathMatch | undefined {
	if (!resolvedPath) { return undefined; }
	const normalized = normalizePath(resolvedPath);

	// 目录：任意层级命中（前后都要求路径分隔符，避免 `my.ssh-backup/` 误伤）
	for (const segment of SENSITIVE_DIR_SEGMENTS) {
		if (normalized.includes(`/${segment}/`)) {
			return { kind: 'directory', matched: segment };
		}
	}

	// 文件名：basename 全等
	const baseName = normalized.split('/').pop() ?? '';
	const fileHit = SENSITIVE_FILE_NAMES.find(name => baseName === name);
	return fileHit ? { kind: 'filename', matched: fileHit } : undefined;
}

/**
 * 生成读拒绝消息。提示用户可显式关闭守卫（避免模型反复重试）。
 */
export function sensitiveReadBlockedMessage(hit: ISensitivePathMatch): string {
	const what = hit.kind === 'directory'
		? `files under "${hit.matched}/"`
		: `"${hit.matched}" files`;
	return (
		`Cannot read ${what}. This path may contain credentials, and reading it would ` +
		`expose them in the conversation history (which is sent to the model provider). ` +
		`Do not retry. If this file is genuinely required, ask the user to disable ` +
		`"chat.agent.sensitiveReadGuard" in settings.`
	);
}

/**
 * 生成写拒绝消息。写凭据文件无合理场景，恒拦，不提供放行开关。
 */
export function sensitiveWriteBlockedMessage(hit: ISensitivePathMatch): string {
	const what = hit.kind === 'directory'
		? `files under "${hit.matched}/"`
		: `"${hit.matched}" files`;
	return `Cannot write to ${what}. This path is protected for security reasons. Do not retry.`;
}

/**
 * 生成设备路径拒绝消息（读写共用）。
 */
export function devicePathBlockedMessage(hit: ISensitivePathMatch, verb: 'read' | 'write'): string {
	return (
		`Cannot ${verb} ${hit.matched}... Device and kernel filesystem paths are blocked ` +
		`for security and stability reasons. Do not retry.`
	);
}
