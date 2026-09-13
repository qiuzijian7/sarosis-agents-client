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

/** 「写敏感路径」的拒绝结果。 */
export interface ISensitiveWriteRejection {
	/** 命中类别（设备 / 凭据目录 / 凭据文件名）。 */
	readonly kind: SensitiveMatchKind;
	/** 命中的表项（日志用）。 */
	readonly matched: string;
	/** 给模型的完整拒绝文案。 */
	readonly message: string;
}

/**
 * 「写敏感路径」的统一拒绝入口 —— **单一真源**（`file_write` 与 `patch` 共用）。
 *
 * ## 为什么收敛（2026-09-13）
 * 本模块头部契约写明「凭据路径：**写恒拦**（写凭据文件无合理场景）」，但此前
 * **只有 `file_write` 落实** —— `patch` 完全没有这一步（`compatibilityTools` 连本模块
 * 都没 import）→ **同一份敏感路径，`file_write` 硬拒，`patch` 只需用户点一次「允许」
 * 就能写**。而 `writeDenyList` 只覆盖「userHome / appData 之下」，**工作区内的**
 * `auth.json` / `.git-credentials` / `.npmrc` / `.pypirc` / `.anthropic_oauth.json`
 * 以及 `/dev/` `/proc/` `/sys/` 都不在其中 → `patch` 真能写进去。
 *
 * 与 `shellPreflightGuards` 同一手法：收敛成单一入口后，两条写路径**不可能再漂移**。
 *
 * @param resolvedPath 已解析的绝对路径（调用方须先过沙箱与写黑名单）。
 * @returns 拒绝结果；未命中返回 `undefined`。
 */
export function sensitiveWriteRejection(resolvedPath: string): ISensitiveWriteRejection | undefined {
	// 设备路径：读写都恒拦（读会阻塞 / 泄露内核信息，写更无道理）
	const device = detectDevicePath(resolvedPath);
	if (device) {
		return { kind: 'device', matched: device.matched, message: devicePathBlockedMessage(device, 'write') };
	}
	// 凭据 / 密钥路径：写恒拦，不提供放行开关
	const sensitive = detectSensitivePath(resolvedPath);
	if (sensitive) {
		return { kind: sensitive.kind, matched: sensitive.matched, message: sensitiveWriteBlockedMessage(sensitive) };
	}
	return undefined;
}

/**
 * 把本模块的两张表派生为 **ripgrep 排除 glob**（2026-09-13）。
 *
 * ## 为什么必须派生，而不是各处手抄
 *
 * `searchHelpers.DEFAULT_EXCLUDE_GLOBS` 里曾**手抄**一份敏感文件排除
 * （P4 2026-07-29，对齐 kimi `SENSITIVE_FILTER_RG_ARGS`），实测已落后于本模块：
 * 缺 `.ssh` / `.kube` / `.config/gcloud` / `.git-credentials` / `auth.json` /
 * `.npmrc` / `.pypirc` / `.anthropic_oauth.json`。
 *
 * 后果是**读守卫形同虚设**：`file_read` 拒绝读 `.npmrc`，而
 * `search_code "authToken"` 照样把它的内容返回给模型 —— 而 `.npmrc` 的 authToken、
 * `.pypirc` 的 password、`.git-credentials` 的 token 都是**工作区内真实存在**的形态，
 * 正是本模块注释里要防的那个泄露面（「内容随对话历史上传到模型提供方」）。
 *
 * 派生后，新增表项**自动**对所有搜索路径生效，结构上不可能再漂移。
 *
 * ⚠ 目录项必须同时给出「目录本身」与「目录内容」两种 glob：ripgrep 里只排除目录节点
 * 是不够的，其下文件仍需一条「目录 + 通配」的 glob（见下方循环里对每个目录 push 两次）。
 *
 * （本注释刻意不写 glob 字面量 —— 形如 `星号星号斜杠` 的写法里含有 `星号斜杠`，
 * 会**提前终止块注释**，是实测踩过的语法陷阱。）
 */
/**
 * 该 **basename**（文件或目录名）是否属于凭据 / 密钥 —— 供**目录遍历侧**使用
 * （如代码库索引的扫描器）。
 *
 * 与 {@link sensitiveExcludeGlobs} 的分工：那个产出 glob（供 ripgrep），
 * 本函数做**单名精确匹配**（供逐目录遍历）。两者派生自**同一对真源表**，
 * 新增表项对两侧自动生效。
 *
 * ⚠ 目录表项可能含多段（`.config/gcloud`），遍历时只能看到单层名字，
 * 故取**最后一段**做匹配。
 *
 * 由来（2026-09-13）：索引扫描器此前**没有**任何敏感名判定 —— 它靠「点开头的
 * 隐藏项跳过」+「扩展名白名单」两道规则**恰好**挡住了全部敏感名（敏感名要么是
 * 点文件，要么无扩展名）。那是**巧合而非控制**：一旦有人往
 * `EXTENSION_TO_WASM_LANG` 加上 `.json`（很自然的扩展），`auth.json` 的内容
 * 就会进图、并被 `search_graph` 返回给模型。
 */
export function isSensitiveName(name: string): boolean {
	if (!name) { return false; }
	const lower = name.toLowerCase();
	if (SENSITIVE_FILE_NAMES.some(n => lower === n)) { return true; }
	return SENSITIVE_DIR_SEGMENTS.some(d => lower === (d.split('/').pop() ?? d));
}

export function sensitiveExcludeGlobs(): string[] {
	const out: string[] = [];
	for (const name of SENSITIVE_FILE_NAMES) {
		out.push(`**/${name}`, `**/${name}.*`);
	}
	for (const dir of SENSITIVE_DIR_SEGMENTS) {
		out.push(`**/${dir}`, `**/${dir}/**`);
	}
	// 传统密钥文件名：本模块的 basename 表按**精确相等**匹配，而 grep 还需覆盖
	// `id_rsa.pub` / `id_ed25519_sk` 这类变体（`.ssh/` 目录本身已由上面的目录项排除，
	// 这里兜住密钥被放到工作区其它位置的情形）。
	out.push(
		'**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*',
		'**/id_ecdsa', '**/id_ecdsa.*',
	);
	return out;
}
