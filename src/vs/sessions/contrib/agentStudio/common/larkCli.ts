/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书 CLI（`@larksuite/cli`）的公共契约与**纯逻辑**。
 *
 * 为什么单列一层：
 *   · 状态文案、版本比较、群列表解析都是纯函数 ⇒ 能被单测覆盖（`test/browser/larkCli.test.ts`）；
 *   · 真正的“探测 / 安装”必须有 child_process，渲染进程没有 ⇒ 走主进程
 *     （`electron-main/larkCliChannel.ts`），渲染侧只经 `browser/larkCliService.ts` 调用。
 *
 * ⚠ 事实边界（2026-09-23 核对官方 README）：CLI 的安装方式是 `npx @larksuite/cli@latest install`，
 *   **重跑即升级** —— 官方文档未列出独立 upgrade 子命令，故「安装」与「升级」是同一条命令。
 *   若日后新增 upgrade 子命令，只需改 `LARK_CLI_INSTALL_COMMAND` 一处。
 */

/** npm 包名（官方 CLI）。 */
export const LARK_CLI_PACKAGE = '@larksuite/cli';

/** 安装 / 升级命令（同一条：重跑即升级）。 */
export const LARK_CLI_INSTALL_COMMAND = `npx ${LARK_CLI_PACKAGE}@latest install`;

/** 可执行文件名（安装后由 npm 放到全局 bin）。 */
export const LARK_CLI_BIN = 'lark-cli';

/** CLI 运行时状态（渲染层展示用）。 */
export interface ILarkCliStatus {
	/** 能否向主进程询问：非 Electron 宿主 / preload 未注入时为 false。 */
	readonly available: boolean;
	readonly installed: boolean;
	/** 已安装版本（`lark-cli --version` 解析结果）。 */
	readonly version?: string;
	/** 可执行文件路径（`where` / `which` 结果）。 */
	readonly path?: string;
	/** npm registry 上的最新版本（best-effort，取不到为 undefined ⇒ 不误报「可升级」）。 */
	readonly latestVersion?: string;
	readonly error?: string;
}

/** 一次 CLI 动作（安装/升级）的结果。 */
export interface ILarkCliRunResult {
	readonly ok: boolean;
	readonly message: string;
	/** 命令输出末尾若干行（失败时用于排障）。 */
	readonly output?: string;
}

// ─── 通用命令执行（2026-09-23：为「飞书文档 → markdown」导入新增）───────────────
//
// 背景：知识库「导入链接 / URL」遇到飞书云文档时，网页抓取只能拿到登录墙/骨架，
// 拿不到图片、画板（思维导图）、表格 ⇒ 改走官方 CLI：
//   · 正文（标题/列表/表格/超链接）：`docs +fetch --doc <url> --doc-format markdown`
//   · 图片 / 文件素材：正文里的 `<img token>` / `<source token>` → `docs +media-download --token <file_token>`
//   · 画板（思维导图）：正文里的 `<whiteboard token>` → `docs +media-download --type whiteboard --token <id>`
//（命令与返回值形态出自 CLI 自带参考：`lark-cli skills read lark-doc/references/lark-doc-fetch.md`）

/** 执行一条 `lark-cli …` 命令的 IPC 通道（真逻辑在主进程，需 child_process）。 */
export const LARK_CLI_RUN_CHANNEL = 'vscode:larkCliRun';

/** 探测 CLI 状态的 IPC 通道（渲染侧 `getLarkCliStatus()` 用）。 */
export const LARK_CLI_STATUS_CHANNEL = 'vscode:larkCliStatus';

/** 安装 / 升级 CLI 的 IPC 通道。 */
export const LARK_CLI_INSTALL_CHANNEL = 'vscode:larkCliInstall';

/** 单次命令执行的原始结果（**永不抛**：失败也返回结构化结果）。 */
export interface ILarkCliExecResult {
	readonly ok: boolean;
	readonly stdout: string;
	readonly stderr: string;
	/** 失败原因（超时 / 非零退出 / 参数非法）。成功时为 undefined。 */
	readonly error?: string;
}

/**
 * 从 CLI 的 stdout 里解析 JSON。
 *
 * 为什么不能直接 `JSON.parse(stdout)`：CLI 在 JSON 前后可能夹带杂项输出
 * （npm 警告、升级提示、进度行）。策略是「取第一个 `{` 到最后一个 `}`」——
 * 对单对象输出足够稳，且**失败只返回 undefined**（由调用方决定报什么错，不抛）。
 */
export function parseLarkCliJson<T = unknown>(stdout: string): T | undefined {
	const text = (stdout ?? '').trim();
	if (!text) { return undefined; }
	const tryParse = (s: string): T | undefined => {
		try { return JSON.parse(s) as T; } catch { return undefined; }
	};
	const direct = tryParse(text);
	if (direct !== undefined) { return direct; }
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start < 0 || end <= start) { return undefined; }
	return tryParse(text.slice(start, end + 1));
}

/**
 * 从 CLI 的 JSON 结果里取一段可读的错误说明（`error.hint` 优先，其次 `error.message`、
 * `message`，再次原始 stderr 首行）。飞书的权限类错误主要靠 `hint` 给出可操作建议，
 * 只回 `code` 对用户没用。
 */
export function larkCliErrorText(parsed: unknown, fallbackText: string): string {
	// ⚠ `code` 在**真机输出里是数字**（如 `3380002`），不只字符串 ⇒ 必须一并接住，
	//   否则错误码会被静默丢掉（实测：无效文档返回 `"code": 3380002`，只有一个 message）。
	const pick = (v: unknown): string | undefined => {
		if (typeof v === 'string') { return v.trim() || undefined; }
		if (typeof v === 'number' || typeof v === 'boolean') { return String(v); }
		return undefined;
	};
	const obj = parsed as { error?: unknown; message?: unknown; msg?: unknown } | undefined;
	const err = obj?.error as { hint?: unknown; message?: unknown; msg?: unknown; code?: unknown } | undefined;
	const hint = pick(err?.hint) ?? pick(err?.message) ?? pick(err?.msg);
	if (hint) {
		const code = pick(err?.code);
		return code ? `${hint}（${code}）` : hint;
	}
	const direct = pick(obj?.message) ?? pick(obj?.msg);
	if (direct) { return direct; }
	return (fallbackText ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] ?? '未知错误';
}

export type LarkCliTone = 'ok' | 'warn' | 'bad' | 'dim';

/**
 * 状态徽章文案 + 色调（与设置页 `.as-channel-status` 的四态语义保持一致）。
 *
 * 纯函数：把「未安装 / 已安装 / 可升级 / 不可用」的判定集中在一处，
 * 避免 UI 里散落 if-else 导致两处口径不一致。
 */
export function larkCliStatusBadge(status: ILarkCliStatus | undefined): { label: string; tone: LarkCliTone } {
	if (!status || !status.available) { return { label: '不可用', tone: 'dim' }; }
	if (!status.installed) { return { label: '未安装', tone: 'bad' }; }
	if (isNewerVersion(status.version, status.latestVersion)) { return { label: `可升级 ${status.latestVersion}`, tone: 'warn' }; }
	return { label: status.version ? `已安装 ${status.version}` : '已安装', tone: 'ok' };
}

/** `latest` 是否比 `current` 新（任一侧缺失或不可解析 → false，宁可不提示）。 */
export function isNewerVersion(current?: string, latest?: string): boolean {
	const a = parseVersion(current);
	const b = parseVersion(latest);
	if (!a || !b) { return false; }
	for (let i = 0; i < 3; i++) {
		if (b[i] !== a[i]) { return b[i] > a[i]; }
	}
	return false;
}

/** 从任意版本字符串里抠出 `[major, minor, patch]`（`v0.4.2` / `0.4.2` / `@larksuite/cli@0.4.2` 均可）。 */
export function parseVersion(raw?: string): [number, number, number] | undefined {
	if (!raw) { return undefined; }
	const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
	if (!m) { return undefined; }
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ─── 以下类型是「聊天框 Channel 绑定页签」与 host 之间的共享契约 ───────────────
//
// ★ 为什么放 common：聊天框面板在 `sessions/browser` 层，**不能反向依赖**
//   `contrib/agentStudio` 的 browser 实现（见 `agentChatPanel.base.ts` 里的分层注释）；
//   但 common 层可以依赖（先例：`configHtmlConfig.ts` 被两边共用）。
//   ⇒ 面板只认这些结构类型，真正的实现由 host（`nativeChatEditorPane.ts`）注入回调完成。

/** 「获取 chat_id」列表里的一行（由 host 用渠道凭证查飞书群列表后给出）。 */
export interface IFeishuChatSummary {
	readonly chatId: string;
	readonly name: string;
	readonly memberCount?: number;
}

/**
 * 扫码创建机器人的进度回调载荷。
 *
 * 二维码由 host 生成（用离屏 canvas 画好后导出 PNG data URL），面板只负责 <img> 显示 ——
 * 这样面板既不需要 QR 库，也不需要知道飞书的 device-flow 协议细节。
 */
export interface IFeishuBotCreationUpdate {
	/** 给用户看的一行状态。 */
	readonly message: string;
	/** 授权二维码（PNG data URL）；无更新时为 undefined（保留上一次）。 */
	readonly qrDataUrl?: string;
	/** 流程结束（成功或失败）。 */
	readonly done?: boolean;
	/** 仅在 done 时有意义。 */
	readonly ok?: boolean;
}
