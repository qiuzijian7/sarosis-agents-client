/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 飞书云文档工具族（读文档 / 评论）—— 2026-09-24，从 Hermes 的 `feishu_doc_tool.py` +
 * `feishu_drive_tool.py` 移植**能力**（不是照抄实现，见下）。
 *
 * ## 上游实现不能照抄的原因（读源码后的结论）
 *
 * 上游这 5 个工具的 lark client 是**由飞书评论事件处理器按线程注入**的：
 * `feishu_drive_tool.py:5` 写着 "The lark client is injected per-thread by the feishu_comment
 * event handler"，`feishu_doc_tool.py` 的报错文案也是 "not in a Feishu comment context"。
 * 也就是说它们**只在「机器人被 @ 到文档评论里」时可用** —— 那套上下文我们这边不存在
 * （`bridge/platforms/feishu.ts` 只处理消息与卡片事件，没有评论事件）。
 *
 * 我们改成**按需调用官方 CLI**（`lark-cli`）：CLI 自带登录态与 URL/Wiki 解析，
 * 与知识库「飞书文档 → markdown 导入」用的是同一条链路（`kbImportController` 的
 * `docs +fetch` / `docs +media-download`），因此**零新凭证管理**：不引 app_secret、
 * 不自建 tenant_access_token 缓存。
 *
 * 命令与参数形态出自 CLI 自带参考（本机 `lark-cli drive --help` 核对）：
 *   · `docs +fetch --doc <url|token> --doc-format markdown`
 *   · `drive +list-comments --url <url> [--comment-scope all|whole|partial] [--solved-status …]`
 *   · `drive +list-replies  --url <url> --comment-id <id>`
 *   · `drive +add-comment   --doc <url|token> --content <reply_elements JSON> [--block-id …]`
 *   · `drive +add-reply     --url <url> --comment-id <id> --content <reply_elements JSON>`
 *
 * ## 与上游的四处刻意差异（每处都是"上游那样在这边会误导模型"）
 *
 * 1. **参数名兼容**：bundled 定义（Hermes 迁移）用的是 `file_id`/`doc_id`，而上游真实
 *    schema 用 `file_token`/`doc_token`。两边都可能被模型沿用 ⇒ 这里**同时接受**，
 *    否则模型按另一种名字调用就会"参数缺失"（看起来像工具坏了）。
 * 2. **`--solved-status all` 作为默认**：CLI 默认只列**未解决**评论。若沿用该默认，
 *    模型会因为「没看到某条评论」而得出"没人提过这个问题"的错误结论（静默漏读）。
 *    读取类操作默认给全量，需要收窄时由调用方显式传 `solved_status`。
 * 3. **`--content` 收纯文本**：CLI 要的是 `[{"type":"text","text":"…"}]` JSON，模型很容易
 *    写成纯文本 ⇒ 这里做转换（也支持直接传 JSON 数组以使用 mention/link 元素）。
 * 4. **整篇评论/已解决评论不接受回复**：CLI 明确 "Whole-document comments (is_whole=true)
 *    and solved comments (is_solved=true) do not accept replies"（上游对应飞书错误码
 *    `1069302`）⇒ 失败时映射成**可执行**的指引（改用 `feishu_drive_add_comment`），
 *    而不是把裸错误码丢给模型。
 *
 * ## 可用性
 *
 * 依赖官方 CLI（`lark-cli`，安装命令见 `common/larkCli.ts` 的 `LARK_CLI_INSTALL_COMMAND`）。
 * 未安装时**不静默降级**：handler 返回 `LARK_CLI_MISSING_HINT`（与知识库导入同一文案）。
 * （上游用 `check_fn=_check_feishu` 在列表阶段就隐藏工具；我们这条"运行时可用性"还没接线，
 *   见 `toolAvailabilityEvaluator.ts` —— 已核实该模块目前**无任何消费方**。）
 */

import { ToolSecurityLevel } from '../../../common/providers.js';
import type { IToolResultContent } from '../../../common/providers.js';
import type { ILogService } from '../../../../../../platform/log/common/log.js';
import type { IBuiltinToolRegistration } from './toolRegistry.js';
import { parseLarkCliJson, larkCliErrorText, type ILarkCliExecResult } from '../../../common/larkCli.js';
import { LARK_CLI_MISSING_HINT } from '../../knowledge/feishuSyncCore.js';
import { CAP_FEISHU_LARK_CLI } from './toolAvailabilityNotes.js';
// 文档读取复用**既有解析器**（知识库「飞书文档 → markdown 导入」用的同一个）：
// `+fetch` 的输出是 JSON 包着 markdown（`data.document.content`），自己再写一份解析必然漂移。
import { parseFeishuDocFetch } from '../../views/knowledgeBase/kbFeishuDoc.js';

export interface IFeishuDriveToolContext {
	register(registration: IBuiltinToolRegistration): void;
	logService: ILogService;
	/**
	 * 探测 CLI 是否已安装（真实实现 = `larkCliService.getLarkCliStatus()`）。
	 * 缺省视为"未知 ⇒ 放行"，让 handler 走到真正的执行失败并获得原始错误（fail-open）。
	 */
	getCliStatus?: () => Promise<{ installed: boolean; error?: string }>;
	/** 执行 `lark-cli <args…>`（真实实现 = `larkCliService.runLarkCli`，走主进程）。 */
	runLarkCli?: (args: string[], opts?: { timeoutMs?: number }) => Promise<ILarkCliExecResult>;
	/**
	 * 把 `reply_elements` JSON 落到临时文件，返回**绝对路径**（随后以 `--content @<路径>` 传入）。
	 *
	 * ⚠ 为什么必须走文件而不是内联 JSON：主进程经 **cmd.exe** 调用 npm 的 `.cmd` shim
	 * （见 `electron-main/larkCliChannel.ts` 的 `quoteArg` 注释：`.cmd shim 只能这样调`），
	 * 而 cmd 会把 `\"` 里的 `"` 当成**引号开关** ⇒ 引号状态错乱后，值里的 `&` 被当作命令分隔符，
	 * `--content` 收到被截断的串（实测报 `--content is not valid JSON: unexpected end of JSON input`
	 * 且 stderr 出现「系统找不到指定的路径」）。
	 * 用 `@file` 后 argv 里只有路径（路径可能含空格，但**不含引号/&**）⇒ 实测稳定通过。
	 * 缺省（无此能力，如单测/非桌面宿主）退回内联 JSON。
	 */
	createTempJsonFile?: (json: string) => Promise<string>;
	/** 删除上面的临时文件（清理失败只记日志，不影响结果）。 */
	deleteTempFile?: (path: string) => Promise<void>;
}

/** 读操作的超时（文档可能很大）。 */
const READ_TIMEOUT_MS = 120_000;
/** 写操作的超时（评论很短，但网络抖动要有余量）。 */
const WRITE_TIMEOUT_MS = 60_000;

/**
 * CLI 状态探测的记忆化 TTL。
 *
 * 为什么需要：`getLarkCliStatus()` 在主进程要 spawn 一次 `lark-cli --version`（node CLI，
 * 数百毫秒）。一次对话里可能连续调用 5 个飞书工具 ⇒ 5 次无谓探测。
 * 为什么是 30s 而不是更长：用户可能在会话中间装好 CLI，过长的记忆化会让工具继续报"未安装"。
 */
export const LARK_CLI_STATUS_TTL_MS = 30_000;

// ─── 纯函数：输入归一化与参数拼装（可单测）──────────────────────────────────

/** 统一的文档定位（URL 优先交给 CLI 自己做类型识别与 Wiki 解包）。 */
export interface IFeishuDocTarget {
	/** 文档 URL（给了它就优先用它）。 */
	readonly url?: string;
	/** 裸 token（此时 CLI 需要 `--type`）。 */
	readonly token?: string;
	/** CLI 认识的文档类型（doc|docx|sheet|file|slides|bitable|base|apps|wiki）。 */
	readonly type?: string;
}

const URL_RE = /^https?:\/\//i;

/** 把调用方给的 `file_type` 归一到 CLI 取值（`base` 是 `bitable` 的兼容别名）。 */
export function normalizeDocType(raw: unknown): string | undefined {
	const t = String(raw ?? '').trim().toLowerCase();
	if (!t) { return undefined; }
	if (t === 'base') { return 'bitable'; }
	return /^[a-z]+$/.test(t) ? t : undefined;
}

/**
 * 从任意一版参数名里取出文档定位。
 *
 * 接受的键：URL 类 `url` / `link` / `file_url` / `doc_url`；
 * token 类 `file_id` / `file_token` / `doc_id` / `doc_token` / `token` / `doc`；
 * 类型 `file_type` / `type` / `doc_type`。
 */
export function parseDocTarget(args: Record<string, unknown>): IFeishuDocTarget {
	const pick = (...keys: string[]): string | undefined => {
		for (const k of keys) {
			const v = args[k];
			if (typeof v === 'string' && v.trim()) { return v.trim(); }
		}
		return undefined;
	};
	const type = normalizeDocType(pick('file_type', 'type', 'doc_type'));
	const raw = pick('url', 'link', 'file_url', 'doc_url')
		?? pick('file_id', 'file_token', 'doc_id', 'doc_token', 'token', 'doc');
	if (!raw) { return { type }; }
	if (URL_RE.test(raw)) { return { url: raw, type }; }
	return { token: raw, type: type ?? 'docx' };
}

/** 把定位写进 `--url` 或 `--token`（+`--type`）—— CLI 对裸 token 要求 `--type`。 */
function pushTarget(argv: string[], target: IFeishuDocTarget, preferDocFlag: boolean): void {
	if (target.url) {
		argv.push(preferDocFlag ? '--doc' : '--url', target.url);
		return;
	}
	if (target.token) {
		argv.push('--token', target.token);
		if (target.type) { argv.push('--type', target.type); }
	}
}

/**
 * 把纯文本转成 CLI 要的 `reply_elements` JSON。
 *
 * 已传 JSON 数组时**原样透传**（模型要用 mention/link 元素时的逃生口）；
 * 否则包成一个 text 元素。空内容返回 undefined（由调用方报参数缺失，不喂空评论）。
 */
export function buildReplyElements(content: unknown): string | undefined {
	const text = String(content ?? '').trim();
	if (!text) { return undefined; }
	if (text.startsWith('[')) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (Array.isArray(parsed)) { return JSON.stringify(parsed); }
		} catch { /* 不是 JSON ⇒ 按纯文本处理 */ }
	}
	return JSON.stringify([{ type: 'text', text }]);
}

/** `docs +fetch`：读整篇文档（markdown + 评论 sidecar）。 */
export function buildDocReadArgs(args: Record<string, unknown>): string[] {
	const target = parseDocTarget(args);
	const doc = target.url ?? target.token;
	return ['docs', '+fetch', '--doc', String(doc), '--doc-format', 'markdown', '--detail', 'with-ids'];
}

/** `drive +list-comments`。 */
export function buildListCommentsArgs(args: Record<string, unknown>): string[] {
	const target = parseDocTarget(args);
	const argv = ['drive', '+list-comments'];
	pushTarget(argv, target, false);
	// 默认 all（见文件头差异 ②）：不静默漏掉已解决评论。
	const scope = String(args['comment_scope'] ?? '').trim();
	if (scope) { argv.push('--comment-scope', scope); }
	else if (args['is_whole'] === true) { argv.push('--comment-scope', 'whole'); }
	const solved = String(args['solved_status'] ?? 'all').trim();
	if (solved) { argv.push('--solved-status', solved); }
	if (args['page_size'] !== undefined) { argv.push('--page-size', String(args['page_size'])); }
	const pageToken = String(args['page_token'] ?? '').trim();
	if (pageToken) { argv.push('--page-token', pageToken); }
	return argv;
}

/** `drive +list-replies`。 */
export function buildListRepliesArgs(args: Record<string, unknown>): string[] {
	const target = parseDocTarget(args);
	const argv = ['drive', '+list-replies'];
	pushTarget(argv, target, false);
	argv.push('--comment-id', String(args['comment_id'] ?? '').trim());
	if (args['page_size'] !== undefined) { argv.push('--page-size', String(args['page_size'])); }
	const pageToken = String(args['page_token'] ?? '').trim();
	if (pageToken) { argv.push('--page-token', pageToken); }
	return argv;
}

/**
 * `drive +add-comment`（写）。`--content` 与 `--doc` 是它的参数名（不是 `--url`）。
 *
 * `contentFilePath` 给了就用 `--content @<路径>`（推荐的稳健方式，见 ctx 上的长注释），
 * 否则内联 JSON（仅测试/无临时文件能力时）。
 */
export function buildAddCommentArgs(args: Record<string, unknown>, contentFilePath?: string): string[] {
	const target = parseDocTarget(args);
	const argv = ['drive', '+add-comment', '--doc', String(target.url ?? target.token ?? '')];
	if (target.token && target.type) { argv.push('--type', target.type); }
	const content = contentFilePath ? `@${contentFilePath}` : buildReplyElements(args['content']);
	if (content) { argv.push('--content', content); }
	const blockId = String(args['block_id'] ?? '').trim();
	if (blockId) {
		argv.push('--block-id', blockId);
	} else {
		// 显式声明"整篇评论"：CLI 在没有定位时**默认**如此，但依赖默认值会让语义随 CLI 版本漂移
		// （工具描述承诺的是"默认整篇评论"），显式传更稳。
		argv.push('--full-comment');
	}
	return argv;
}

/** `drive +add-reply`（写）。`contentFilePath` 语义同 `buildAddCommentArgs`。 */
export function buildAddReplyArgs(args: Record<string, unknown>, contentFilePath?: string): string[] {
	const target = parseDocTarget(args);
	const argv = ['drive', '+add-reply'];
	pushTarget(argv, target, false);
	argv.push('--comment-id', String(args['comment_id'] ?? '').trim());
	const content = contentFilePath ? `@${contentFilePath}` : buildReplyElements(args['content']);
	if (content) { argv.push('--content', content); }
	return argv;
}

// ─── 纯函数：输出解析与渲染 ─────────────────────────────────────────────────

/** 从 CLI 输出里取条目列表（容错：`data.items` / `items` / 数组根 / 单对象）。 */
export function parseLarkItems(stdout: string): { items: unknown[]; parsed?: unknown } {
	const parsed = parseLarkCliJson<unknown>(stdout);
	if (parsed === undefined) { return { items: [] }; }
	if (Array.isArray(parsed)) { return { items: parsed, parsed }; }
	const obj = parsed as { items?: unknown; data?: unknown };
	if (Array.isArray(obj.items)) { return { items: obj.items, parsed }; }
	const data = obj.data as { items?: unknown } | undefined;
	if (Array.isArray(data?.items)) { return { items: data!.items as unknown[], parsed }; }
	// 单对象：`+add-comment` / `+add-reply` 常直接返回创建出来的对象
	if (obj.data && typeof obj.data === 'object') { return { items: [obj.data], parsed }; }
	return { items: [parsed], parsed };
}

/** 从评论/回复的 `content.elements[].text_run.text` 里拼出纯文本（多版本字段名容错）。 */
export function extractText(item: unknown): string {
	const obj = item as { content?: unknown; text?: unknown } | undefined;
	const content = obj?.content as { elements?: unknown; text?: unknown } | undefined;
	const elements = content?.elements;
	if (Array.isArray(elements)) {
		const parts = elements.map(el => {
			const e = el as { text_run?: { text?: unknown }; text?: unknown };
			return String(e?.text_run?.text ?? e?.text ?? '');
		}).filter(Boolean);
		if (parts.length) { return parts.join(''); }
	}
	if (typeof content?.text === 'string') { return content.text; }
	if (typeof obj?.text === 'string') { return obj.text; }
	return '';
}

/**
 * 取一条**评论**的正文。
 *
 * ⚠ 飞书评论列表里，评论正文位于 `reply_list.replies[0]`（评论本身就是这条线程的首条回复），
 *   评论对象**自己的** `content` 通常不存在 —— 直接 `extractText(item)` 会得到空串，
 *   表现为"列出了评论但每条都没内容"（模型只能看到 id 与引用文本）。
 */
function commentBodyText(o: Record<string, unknown>): { text: string; replyCount: number } {
	const replies = (o['reply_list'] as { replies?: unknown } | undefined)?.replies;
	if (Array.isArray(replies) && replies.length) {
		return { text: extractText(replies[0]), replyCount: replies.length };
	}
	// 有些端点把 replies 平铺在顶层（容错）
	if (Array.isArray(o['replies']) && (o['replies'] as unknown[]).length) {
		const list = o['replies'] as unknown[];
		return { text: extractText(list[0]), replyCount: list.length };
	}
	return { text: extractText(o), replyCount: 0 };
}

/** 单条评论/回复渲染成一行（认不出结构时退化为短 JSON，保证模型仍有可用信息）。 */
function renderEntry(item: unknown, kind: 'comment' | 'reply'): string {
	const o = item as Record<string, unknown> | undefined;
	if (!o || typeof o !== 'object') { return `· ${String(item).slice(0, 200)}`; }
	const id = String(o['comment_id'] ?? o['reply_id'] ?? o['id'] ?? '').trim();
	const author = String(o['user_id'] ?? o['open_id'] ?? o['user'] ?? '').trim();
	const body = kind === 'comment' ? commentBodyText(o) : { text: extractText(item), replyCount: 0 };
	const text = body.text.replace(/\s+/g, ' ').trim();
	const flags: string[] = [];
	if (o['is_whole'] === true) { flags.push('整篇'); }
	if (o['is_solved'] === true) { flags.push('已解决'); }
	if (o['is_whole'] === false) { flags.push('局部'); }
	// 回复数：>1 说明这条线程有讨论（模型可决定要不要 list-replies 展开）
	if (kind === 'comment' && body.replyCount > 1) { flags.push(`${body.replyCount} 条回复`); }
	const quote = (() => {
		const q = o['quote'] as { quote?: unknown } | undefined;
		const t = typeof q?.quote === 'string' ? q.quote : '';
		return t ? ` 引用「${t.replace(/\s+/g, ' ').slice(0, 60)}」` : '';
	})();
	const head = [id ? `${kind === 'comment' ? 'comment_id' : 'reply_id'}=${id}` : '(无 id)',
		flags.join('/'), author ? `by ${author}` : ''].filter(Boolean).join(' · ');
	if (!text && !quote) {
		// 认不出内容 ⇒ 给短 JSON（截断），比"空行"或"解析失败"更有用
		return `· ${head}  ${JSON.stringify(item).slice(0, 400)}`;
	}
	return `· ${head}${quote}\n    ${text || '(无文本)'}`;
}

/** 评论列表 → 可读文本（含数量与下一步提示）。 */
export function formatComments(items: readonly unknown[]): string {
	if (!items.length) { return '（没有评论）'; }
	const lines = items.map(i => renderEntry(i, 'comment'));
	// ⚠ 不要在这里嵌反引号：外层是模板字符串，嵌套反引号会截断它（已踩）
	return `共 ${items.length} 条评论（comment_id 用于 list-replies / reply）：\n${lines.join('\n')}`;
}

/** 回复列表 → 可读文本。 */
export function formatReplies(items: readonly unknown[], commentId: string): string {
	if (!items.length) { return `评论 ${commentId} 下没有回复。`; }
	const lines = items.map(i => renderEntry(i, 'reply'));
	return `评论 ${commentId} 的回复（${items.length} 条，首条为评论正文）：\n${lines.join('\n')}`;
}

/**
 * 失败 → 可执行文案。
 *
 * 三类失败各有对策，混成一句"执行失败"会让模型原地重试或改猜：
 *   · CLI 未装 ⇒ 安装指引；
 *   · 飞书权限/登录态（CLI 的 error.hint 会说明）⇒ 原样带回；
 *   · 回复被拒（整篇/已解决评论）⇒ 指向 `feishu_drive_add_comment`。
 */
export function describeCliFailure(action: string, result: ILarkCliExecResult, parsed?: unknown): string {
	const detail = parsed !== undefined
		? larkCliErrorText(parsed, `${result.stderr || result.stdout}`)
		: (result.error || `${result.stderr || result.stdout}`).split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0];
	// 「内容不存在 / 未找到命令」多半是 CLI 未安装或路径不在 PATH（与知识库导入同一判据）
	const raw = `${result.error ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`;
	if (/ENOENT|not recognized|not found|command not found|未安装|无法在主进程执行/i.test(raw) && !parsed) {
		return `${action}失败：${detail || 'lark-cli 不可用'}\n\n${LARK_CLI_MISSING_HINT}`;
	}
	if (/1069302|not.*accept.*repl|is_whole|is_solved/i.test(raw)) {
		return `${action}失败：${detail || '该评论不接受回复'}\n\n`
			+ '整篇评论（is_whole）与已解决评论（is_solved）**不接受回复** ⇒ '
			+ '改用 `feishu_drive_add_comment` 新发一条整篇评论，或换一条可回复的局部评论。';
	}
	return `${action}失败：${detail || '未知错误'}`;
}

// ─── 注册 ───────────────────────────────────────────────────────────────────

/** 文档定位参数的统一说明（5 个工具共用，避免各写一份而措辞漂移）。 */
const TARGET_DESC = '文档 URL 或 token（也可用 file_token / doc_id / doc_token 传；URL 会自动解析并解开 Wiki token）';

export function registerFeishuDriveTools(ctx: IFeishuDriveToolContext): void {
	const text = (s: string): IToolResultContent[] => [{ type: 'text', text: s }];
	const log = ctx.logService;

	/** 记忆化的 CLI 状态（TTL 见常量注释）。 */
	let statusMemo: { at: number; installed: boolean; error?: string } | undefined;
	const cliInstalled = async (): Promise<{ installed: boolean; error?: string }> => {
		if (!ctx.getCliStatus) { return { installed: true }; }   // 未知 ⇒ 放行，由真实执行给错误
		const now = Date.now();
		if (!statusMemo || now - statusMemo.at >= LARK_CLI_STATUS_TTL_MS || now < statusMemo.at) {
			try {
				const s = await ctx.getCliStatus();
				statusMemo = { at: now, installed: s.installed, error: s.error };
			} catch (err) {
				statusMemo = { at: now, installed: true, error: err instanceof Error ? err.message : String(err) };
			}
		}
		return { installed: statusMemo.installed, error: statusMemo.error };
	};

	/**
	 * 统一执行：CLI 可用性前置 + 执行 + 解析 + 失败映射。
	 * 返回 `{ ok, text }`，由各 handler 决定成功文案（列表要渲染、写操作只要确认）。
	 */
	const exec = async (
		action: string, argv: string[], timeoutMs: number,
	): Promise<{ ok: boolean; message: string; items: unknown[]; parsed?: unknown; stdout: string; stderr: string }> => {
		const availability = await cliInstalled();
		if (!availability.installed) {
			const why = availability.error ? `（${availability.error}）` : '';
			return { ok: false, message: `${action}失败：飞书 CLI 不可用${why}。\n\n${LARK_CLI_MISSING_HINT}`, items: [], stdout: '', stderr: '' };
		}
		if (!ctx.runLarkCli) {
			return { ok: false, message: `${action}失败：当前环境无法执行 lark-cli（非桌面版宿主）。`, items: [], stdout: '', stderr: '' };
		}
		const started = Date.now();
		const r = await ctx.runLarkCli(argv, { timeoutMs });
		log.info(`[feishu] ${action} exit=${r.ok ? 0 : 1} ${Date.now() - started}ms argv=${argv.slice(0, 3).join(' ')}`);
		const { items, parsed } = parseLarkItems(r.stdout);
		// 成功判定：退出码为 0 **且** 没有 `code != 0`（CLI 有时把业务错误写在 JSON 里而 exit 0）
		const code = parsed !== undefined && typeof parsed === 'object' && !Array.isArray(parsed)
			? (parsed as { code?: unknown }).code : undefined;
		const codeBad = typeof code === 'number' ? code !== 0 : undefined;
		if ((!r.ok && !items.length) || codeBad === true) {
			return { ok: false, message: describeCliFailure(action, r, parsed), items: [], stdout: r.stdout, stderr: r.stderr };
		}
		return { ok: true, message: '', items, parsed, stdout: r.stdout, stderr: r.stderr };
	};

	/**
	 * 带 `reply_elements` 的写操作统一入口：有临时文件能力就走 `--content @<路径>`
	 * （cmd + `.cmd` shim 下唯一稳的方式，见 ctx 注释），否则退回内联 JSON。
	 * 临时文件在 `finally` 里删除（清理失败只记日志 —— 不能让它盖掉真正的结果）。
	 */
	const execWithContent = async (
		action: string, build: (contentFilePath?: string) => string[],
		contentJson: string | undefined, timeoutMs: number,
	): Promise<ReturnType<typeof exec>> => {
		let filePath: string | undefined;
		try {
			if (contentJson && ctx.createTempJsonFile) {
				try {
					filePath = await ctx.createTempJsonFile(contentJson);
				} catch (err) {
					log.warn(`[feishu] ${action}：临时文件创建失败，退回内联 JSON（含引号/& 时可能被 cmd 解析破坏）：${err instanceof Error ? err.message : String(err)}`);
				}
			}
			return await exec(action, build(filePath), timeoutMs);
		} finally {
			if (filePath && ctx.deleteTempFile) {
				try { await ctx.deleteTempFile(filePath); }
				catch (err) { log.warn(`[feishu] ${action}：临时文件清理失败（不影响结果）：${err instanceof Error ? err.message : String(err)}`); }
			}
		}
	};

	// ① 读文档
	ctx.register({
		definition: {
			name: 'feishu_doc_read',
			description: '读取飞书/Lark 云文档的正文（转成 markdown，含标题/列表/表格/超链接；'
				+ '`--doc-format markdown` 还会带上评论 sidecar）。'
				+ '需要本机已安装官方 CLI（lark-cli）。适合「把这个飞书文档读进来看看/总结/落笔记」。',
			inputSchema: {
				type: 'object',
				properties: { doc_id: { type: 'string', description: TARGET_DESC } },
				required: ['doc_id'],
			},
			category: 'feishu',
			source: 'saros.builtin-tools',
			// ★ 2026-09-24（P1-4）：依赖官方 CLI（lark-cli，可选依赖）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注并给出安装命令（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			securityLevel: ToolSecurityLevel.Safe,
		},
		handler: async (args) => {
			const target = parseDocTarget(args);
			if (!target.url && !target.token) { return text('feishu_doc_read 需要 doc_id（文档 URL 或 token）。'); }
			const r = await exec('读取文档', buildDocReadArgs(args), READ_TIMEOUT_MS);
			if (!r.ok) { return text(r.message); }
			// ⚠ `+fetch` 的输出是 **JSON 包着 markdown**（`data.document.content`），不是裸 markdown ——
			//   必须走既有解析器；早期版本直接回传 stdout 会把正文丢掉（只剩一句"内容为空"）。
			const doc = parseFeishuDocFetch(r.stdout, r.stderr);
			if (!doc.ok) { return text(`读取文档失败：${doc.error ?? '未知错误'}`); }
			return text(String(doc.content ?? '').trim() || '文档内容为空。');
		},
	});

	// ② 列评论
	ctx.register({
		definition: {
			name: 'feishu_drive_list_comments',
			description: '列出飞书云文档上的评论（默认含**已解决**评论 —— 避免"没看到"被误当成"没人提过"）。'
				+ '返回每条评论的 comment_id（供 list-replies / reply-comment 使用）。',
			inputSchema: {
				type: 'object',
				properties: {
					file_id: { type: 'string', description: TARGET_DESC },
					file_type: { type: 'string', description: '文档类型（doc/docx/sheet/file/slides/bitable，缺省 docx）' },
					comment_scope: { type: 'string', enum: ['all', 'whole', 'partial'], description: '评论范围：all=全部（默认）/ whole=整篇 / partial=局部（划词）' },
					solved_status: { type: 'string', enum: ['all', 'true', 'false'], description: '解决状态过滤，默认 all' },
					page_size: { type: 'number', description: '每页条数 1-100（默认 50）' },
					page_token: { type: 'string', description: '上一页返回的分页 token' },
				},
				required: ['file_id'],
			},
			category: 'feishu',
			source: 'saros.builtin-tools',
			// ★ 2026-09-24（P1-4）：依赖官方 CLI（lark-cli，可选依赖）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注并给出安装命令（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			securityLevel: ToolSecurityLevel.Safe,
		},
		handler: async (args) => {
			const target = parseDocTarget(args);
			if (!target.url && !target.token) { return text('feishu_drive_list_comments 需要 file_id（文档 URL 或 token）。'); }
			const r = await exec('列出评论', buildListCommentsArgs(args), READ_TIMEOUT_MS);
			if (!r.ok) { return text(r.message); }
			return text(formatComments(r.items));
		},
	});

	// ③ 列回复
	ctx.register({
		definition: {
			name: 'feishu_drive_list_comment_replies',
			description: '列出某条评论下的回复（首条即评论正文本身）。comment_id 来自 feishu_drive_list_comments。',
			inputSchema: {
				type: 'object',
				properties: {
					file_id: { type: 'string', description: TARGET_DESC },
					comment_id: { type: 'string', description: '评论 ID（来自 list-comments）' },
					file_type: { type: 'string', description: '文档类型（缺省 docx）' },
					page_size: { type: 'number', description: '每页条数 1-100（默认 50）' },
					page_token: { type: 'string', description: '分页 token' },
				},
				required: ['file_id', 'comment_id'],
			},
			category: 'feishu',
			source: 'saros.builtin-tools',
			// ★ 2026-09-24（P1-4）：依赖官方 CLI（lark-cli，可选依赖）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注并给出安装命令（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			securityLevel: ToolSecurityLevel.Safe,
		},
		handler: async (args) => {
			const commentId = String(args['comment_id'] ?? '').trim();
			if (!commentId) { return text('feishu_drive_list_comment_replies 需要 comment_id（先从 list-comments 取）。'); }
			const r = await exec('列出回复', buildListRepliesArgs(args), READ_TIMEOUT_MS);
			if (!r.ok) { return text(r.message); }
			return text(formatReplies(r.items, commentId));
		},
	});

	// ④ 回复评论（写）
	ctx.register({
		definition: {
			name: 'feishu_drive_reply_comment',
			description: '回复飞书文档上**已有的**评论线程（只适用局部/未解决评论；整篇或已解决评论请改用 feishu_drive_add_comment）。'
				+ 'content 传纯文本即可（会自动转成 CLI 要的 reply_elements JSON）。',
			inputSchema: {
				type: 'object',
				properties: {
					file_id: { type: 'string', description: TARGET_DESC },
					comment_id: { type: 'string', description: '要回复的评论 ID' },
					content: { type: 'string', description: '回复纯文本（也可直接传 reply_elements JSON 数组以使用 mention/link）' },
					file_type: { type: 'string', description: '文档类型（缺省 docx）' },
				},
				required: ['file_id', 'comment_id', 'content'],
			},
			category: 'feishu',
			source: 'saros.builtin-tools',
			// ★ 2026-09-24（P1-4）：依赖官方 CLI（lark-cli，可选依赖）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注并给出安装命令（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			// 会在**别人的文档**上留下可见内容 ⇒ 与其它写操作同为 Cautious
			securityLevel: ToolSecurityLevel.Cautious,
		},
		handler: async (args) => {
			const commentId = String(args['comment_id'] ?? '').trim();
			if (!commentId) { return text('feishu_drive_reply_comment 需要 comment_id。'); }
			const contentJson = buildReplyElements(args['content']);
			if (!contentJson) { return text('feishu_drive_reply_comment 需要非空的 content。'); }
			const r = await execWithContent('回复评论', ref => buildAddReplyArgs(args, ref), contentJson, WRITE_TIMEOUT_MS);
			if (!r.ok) { return text(r.message); }
			return text(`已回复评论 ${commentId}。`);
		},
	});

	// ⑤ 发整篇评论（写）
	ctx.register({
		definition: {
			name: 'feishu_drive_add_comment',
			description: '在飞书文档上**新发**一条评论（默认整篇评论；给 block_id 可锚定到某个块）。'
				+ '整篇评论不接受回复 ⇒ 这是"回不了某条评论"时的正确出口。content 传纯文本即可。',
			inputSchema: {
				type: 'object',
				properties: {
					file_id: { type: 'string', description: TARGET_DESC },
					content: { type: 'string', description: '评论纯文本（也可直接传 reply_elements JSON 数组）' },
					file_type: { type: 'string', description: '文档类型（缺省 docx）' },
					block_id: { type: 'string', description: '可选：锚定到某个块（docx 的 block id；sheet 用 <sheetId>!<cell>）' },
				},
				required: ['file_id', 'content'],
			},
			category: 'feishu',
			source: 'saros.builtin-tools',
			// ★ 2026-09-24（P1-4）：依赖官方 CLI（lark-cli，可选依赖）。缺依赖时**不隐藏**工具，
			//   而是在描述里标注并给出安装命令（见 toolAvailabilityNotes.ts 头注释）。
			availability: [{ type: 'custom', condition: CAP_FEISHU_LARK_CLI }],
			securityLevel: ToolSecurityLevel.Cautious,
		},
		handler: async (args) => {
			const contentJson = buildReplyElements(args['content']);
			if (!contentJson) { return text('feishu_drive_add_comment 需要非空的 content。'); }
			const r = await execWithContent('发表评论', ref => buildAddCommentArgs(args, ref), contentJson, WRITE_TIMEOUT_MS);
			if (!r.ok) { return text(r.message); }
			return text('已在该文档上新增评论。');
		},
	});

	log.info('[FeishuDriveTools] Registered 5 feishu tools (doc read + comments)');
}
