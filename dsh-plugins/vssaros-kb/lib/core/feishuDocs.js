// @vssaros/dsh-kb — **飞书云文档（读侧）** 的纯逻辑：定位解析 + 参数拼装 + 输出解析（§R.7 第 ⑤ 项的落地 ✓）。
//
// 契约真源：IDE `browser/providers/tool/feishuDriveTools.ts`（2026-10-12 逐条核对 ✓）。照搬的关键点：
//   · 命令形态（真源头注释，按 `lark-cli drive --help` 核过 ✓）：
//     `docs +fetch --doc <url|token> --doc-format markdown --detail with-ids` ✓
//     `drive +list-comments --url|--token <…> [--comment-scope all|whole|partial] [--solved-status …]` ✓
//     `drive +list-replies  --url|--token <…> --comment-id <id>` ✓
//   · **参数名兼容**（真源差异①）：bundled 定义用 `file_id`/`doc_id`、上游真 schema 用 `file_token`/`doc_token`
//     ⇒ 两边都收 ✓（只收一边 ⇒ 模型按另一种名字调就会"参数缺失"，看起来像工具坏了 ✓）。
//   · **`--solved-status all` 当默认**（真源差异②）：CLI 默认只列**未解决**评论 ⇒ 模型会因"没看到某条"
//     得出"没人提过这个问题"的**错误结论** ✓（静默漏读 ✓）⇒ 读操作默认给全量 ✓。
//   · 裸 token 时 CLI 要求 `--type` ✓（URL 则由 CLI 自己识别类型并解 Wiki ✓）。
//   · ⚠ **评论正文不在评论对象自己的 `content` 里** ✗：它在 `reply_list.replies[0]`（评论本身就是这条
//     线程的首条回复 ✓）—— 直接读 `content` 会得到空串，表现为"列出了评论但每条都没内容" ✓（真源注释记着 ✓）。
//
// 纯函数：不 import `node:child_process` / `fs` ✓ ⇒ 解析与拼参数可直测（`p3-08` ✓）；真跑 CLI 在 `lib/index.js`
// 用**已有的** `runLarkCli` ✓（本模块早就有 lark-cli 机器 ✓，不重复造 ✓）。

// 失败文案里要带"缺 CLI ⇒ 怎么办" ✓（与 `kb_feishu_spaces` 共用同一句 ✓，不另写一份措辞 ✗）
import { LARK_CLI_MISSING_HINT } from './feishuSpaces.js';

/** 文档定位：URL 优先（交给 CLI 做类型识别与 Wiki 解包 ✓）；裸 token 时需要 `type` ✓。 */
const URL_RE = /^https?:\/\//i;

/** 把 `file_type` 归一到 CLI 取值（`base` 是 `bitable` 的兼容别名 ✓）。 */
export function normalizeDocType(raw) {
	const text = String(raw ?? '').trim().toLowerCase();
	if (!text) { return undefined; }
	if (text === 'base') { return 'bitable'; }
	return /^[a-z]+$/.test(text) ? text : undefined;
}

/**
 * 从任意一版参数名里取出文档定位（照真源 ✓）。
 * 接受的键：URL 类 `url`/`link`/`file_url`/`doc_url` ✓；token 类 `file_id`/`file_token`/`doc_id`/`doc_token`/`token`/`doc` ✓；
 * 类型类 `file_type`/`type`/`doc_type` ✓。
 * @returns `{ url?, token?, type? }`
 */
export function parseDocTarget(args) {
	const pick = (...keys) => {
		for (const key of keys) {
			const value = args?.[key];
			if (typeof value === 'string' && value.trim()) { return value.trim(); }
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

/** 把定位写进 `--url` / `--token`（+`--type`）——**裸 token 必须带 `--type`** ✓（真源同款 ✓）。 */
export function pushTargetArgs(argv, target, preferDocFlag) {
	if (target?.url) {
		argv.push(preferDocFlag ? '--doc' : '--url', target.url);
		return argv;
	}
	if (target?.token) {
		argv.push('--token', target.token);
		if (target.type) { argv.push('--type', target.type); }
	}
	return argv;
}

/** `docs +fetch`：读整篇文档（markdown ✓；`--detail with-ids` 让后续能按 id 追问 ✓）。 */
export function buildDocReadArgs(args) {
	const target = parseDocTarget(args);
	const doc = target.url ?? target.token;
	return ['docs', '+fetch', '--doc', String(doc ?? ''), '--doc-format', 'markdown', '--detail', 'with-ids'];
}

/** `drive +list-comments`（**默认 `--solved-status all`** ✓ —— 不静默漏读已解决评论 ✓）。 */
export function buildListCommentsArgs(args) {
	const target = parseDocTarget(args);
	const argv = pushTargetArgs(['drive', '+list-comments'], target, false);
	const scope = String(args?.comment_scope ?? '').trim();
	if (scope) { argv.push('--comment-scope', scope); }
	else if (args?.is_whole === true) { argv.push('--comment-scope', 'whole'); }
	const solved = String(args?.solved_status ?? 'all').trim();
	if (solved) { argv.push('--solved-status', solved); }
	if (args?.page_size !== undefined) { argv.push('--page-size', String(args.page_size)); }
	const pageToken = String(args?.page_token ?? '').trim();
	if (pageToken) { argv.push('--page-token', pageToken); }
	return argv;
}

/** `drive +list-replies`（comment_id 必填 ✓ —— 调用方先校验 ✓）。 */
export function buildListRepliesArgs(args) {
	const target = parseDocTarget(args);
	const argv = pushTargetArgs(['drive', '+list-replies'], target, false);
	argv.push('--comment-id', String(args?.comment_id ?? '').trim());
	if (args?.page_size !== undefined) { argv.push('--page-size', String(args.page_size)); }
	const pageToken = String(args?.page_token ?? '').trim();
	if (pageToken) { argv.push('--page-token', pageToken); }
	return argv;
}

/** 剥 ANSI（CLI 在 tty 下会带色 ✓）+ 抠出第一个 JSON（前后可能混着日志行 ✓）。 */
function parseLooseJson(raw) {
	const text = String(raw ?? '').replace(/\u001b\[[0-9;]*m/g, '').trim();
	if (!text) { return undefined; }
	try { return JSON.parse(text); } catch { /* 继续兜底 */ }
	for (const [open, close] of [['{', '}'], ['[', ']']]) {
		const start = text.indexOf(open);
		if (start < 0) { continue; }
		let depth = 0;
		for (let i = start; i < text.length; i += 1) {
			if (text[i] === open) { depth += 1; }
			else if (text[i] === close) {
				depth -= 1;
				if (depth === 0) {
					try { return JSON.parse(text.slice(start, i + 1)); } catch { return undefined; }
				}
			}
		}
	}
	return undefined;
}

/** 从 CLI 输出里取条目列表（照真源 ✓：数组根 / `items` / `data.items` / 单对象都认 ✓）。 */
export function parseLarkItems(stdout) {
	const parsed = parseLooseJson(stdout);
	if (parsed === undefined) { return { items: [] }; }
	if (Array.isArray(parsed)) { return { items: parsed, parsed }; }
	if (Array.isArray(parsed.items)) { return { items: parsed.items, parsed }; }
	if (Array.isArray(parsed.data?.items)) { return { items: parsed.data.items, parsed }; }
	if (parsed.data && typeof parsed.data === 'object') { return { items: [parsed.data], parsed }; }
	return { items: [parsed], parsed };
}

/** 从 `content.elements[].text_run.text` 拼纯文本（真源同款多版本字段容错 ✓）。 */
export function extractText(item) {
	const content = item?.content;
	if (Array.isArray(content?.elements)) {
		const parts = content.elements
			.map(el => String(el?.text_run?.text ?? el?.text ?? ''))
			.filter(Boolean);
		if (parts.length) { return parts.join(''); }
	}
	if (typeof content?.text === 'string') { return content.text; }
	if (typeof item?.text === 'string') { return item.text; }
	return '';
}

/**
 * 取一条**评论**的正文与回复数（照真源 ✓：正文在 `reply_list.replies[0]` ✓）。
 * 顶层平铺 `replies` 也认 ✓（有些端点如此 ✓）。
 */
export function commentBody(o) {
	const replies = o?.reply_list?.replies;
	if (Array.isArray(replies) && replies.length) { return { text: extractText(replies[0]), replyCount: replies.length }; }
	if (Array.isArray(o?.replies) && o.replies.length) { return { text: extractText(o.replies[0]), replyCount: o.replies.length }; }
	return { text: extractText(o), replyCount: 0 };
}

/** 归一化一条评论/回复成**结构化**条目（渲染留给调用方 ✓ ⇒ 断言直接打在字段上 ✓，不用去抠字符串 ✗）。 */
export function summarizeEntry(item, kind) {
	if (!item || typeof item !== 'object') { return { raw: String(item).slice(0, 200) }; }
	const body = kind === 'comment' ? commentBody(item) : { text: extractText(item), replyCount: 0 };
	return {
		id: String(item.comment_id ?? item.reply_id ?? item.id ?? '').trim(),
		author: String(item.user_id ?? item.open_id ?? item.user ?? '').trim(),
		text: body.text.replace(/\s+/g, ' ').trim(),
		isWhole: item.is_whole === true,
		isSolved: item.is_solved === true,
		replyCount: kind === 'comment' ? body.replyCount : 0,
		quote: typeof item.quote?.quote === 'string' ? item.quote.quote.replace(/\s+/g, ' ').slice(0, 60) : '',
	};
}

/**
 * 把纯文本转成 CLI 要的 `reply_elements` JSON（照真源 ✓）。
 * 已传 JSON 数组时**原样透传** ✓（模型要用 mention/link 元素时的逃生口 ✓）；空内容 ⇒ `undefined`（调用方报参数缺失 ✓，不喂空评论 ✓）。
 */
export function buildReplyElements(content) {
	const text = String(content ?? '').trim();
	if (!text) { return undefined; }
	if (text.startsWith('[')) {
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) { return JSON.stringify(parsed); }
		} catch { /* 不是 JSON ⇒ 按纯文本处理 ✓ */ }
	}
	return JSON.stringify([{ type: 'text', text }]);
}

/**
 * `drive +add-comment`（写 ✓）。
 * `contentRef` 给了就用 `--content @<路径>` ✓ —— **在我们这儿也走文件** ✓：虽然本模块 spawn **不经 shell**（内联 JSON
 * 本来安全 ✓），但 `@file` 顺带绕开"Windows 上 npm 的 `.cmd` shim"那条路的一切引号/`&` 风险 ✓（真源在 cmd 下踩过 ✓）。
 */
export function buildAddCommentArgs(args, contentRef) {
	const target = parseDocTarget(args);
	const argv = ['drive', '+add-comment', '--doc', String(target.url ?? target.token ?? '')];
	if (target.token && target.type) { argv.push('--type', target.type); }
	const content = contentRef ? `@${contentRef}` : buildReplyElements(args?.content);
	if (content) { argv.push('--content', content); }
	const blockId = String(args?.block_id ?? '').trim();
	if (blockId) { argv.push('--block-id', blockId); }
	// 没给 block_id ⇒ **显式**声明"整篇评论" ✓：CLI 无定位时默认如此，但依赖默认值会让语义随 CLI 版本漂移 ✗（真源同款 ✓）
	else { argv.push('--full-comment'); }
	return argv;
}

/** `drive +add-reply`（写 ✓；`contentRef` 语义同 `buildAddCommentArgs` ✓）。 */
export function buildAddReplyArgs(args, contentRef) {
	const target = parseDocTarget(args);
	const argv = pushTargetArgs(['drive', '+add-reply'], target, false);
	argv.push('--comment-id', String(args?.comment_id ?? '').trim());
	const content = contentRef ? `@${contentRef}` : buildReplyElements(args?.content);
	if (content) { argv.push('--content', content); }
	return argv;
}

/**
 * 成功判定（照真源 ✓）：退出码 0 **且** JSON 里没有 `code != 0` ——
 * CLI 有时把**业务错误**写进 JSON 却仍然 `exit 0` ✓ ⇒ 只看退出码会把"权限不足/评论不存在"当成成功 ✗。
 */
export function isCliFailure({ exitCode, parsed, items } = {}) {
	if (typeof exitCode === 'number' && exitCode !== 0 && !(items?.length)) { return true; }
	const code = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.code : undefined;
	return typeof code === 'number' ? code !== 0 : false;
}

/**
 * 失败 → **可执行**文案（照真源 ✓：三类失败各有对策，混成一句"执行失败"会让模型原地重试或开始猜 ✗）：
 *   · CLI 未装/不在 PATH ⇒ 安装 + 登录指引 ✓；
 *   · 飞书权限/登录态 ⇒ 原样带回 ✓；
 *   · **整篇 / 已解决评论不接受回复**（真源记的飞书错误码 `1069302` ✓）⇒ 指路 `feishu_drive_add_comment` ✓。
 */
export function describeCliFailure(action, { stdout = '', stderr = '', error = '' } = {}, parsed) {
	const raw = `${error}\n${stderr}\n${stdout}`;
	const firstLine = String(stderr || stdout || error).split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] ?? '';
	const detail = firstLine.slice(0, 200);
	// ⚠ 把 **shim** 也算进来 ✓：Windows 上 npm 装的 `lark-cli` 是 `.cmd`，Node 不经 shell 不能执行它 ⇒
	//   报的是 ENOENT / "不能直接 spawn .cmd" ✓ —— 与"真的没装"**对策不同**，但都该带上安装/指路指引 ✓。
	if (/ENOENT|not recognized|not found|command not found|未安装|无法执行|\.cmd|\.bat|shim/i.test(raw) && parsed === undefined) {
		return `${action}失败：${detail || 'lark-cli 不可用'}\n\n${LARK_CLI_MISSING_HINT}`;
	}
	if (/1069302|not.*accept.*repl|is_whole|is_solved/i.test(raw)) {
		return `${action}失败：${detail || '该评论不接受回复'}\n\n`
			+ '整篇评论（is_whole）与已解决评论（is_solved）**不接受回复** ✓ ⇒ '
			+ '改用 `feishu_drive_add_comment` 新发一条整篇评论，或换一条可回复的局部评论 ✓。';
	}
	return `${action}失败：${detail || '未知错误'}`;
}

/** 解析 `docs +fetch` 的输出 ⇒ markdown 正文（真源契约：JSON 包着 markdown `data.document.content` ✓）。 */
export function parseDocFetch(stdout, stderr) {
	const parsed = parseLooseJson(stdout) ?? parseLooseJson(stderr);
	if (parsed === undefined) {
		return { ok: false, error: '输出里没有 JSON（CLI 可能没成功，或没登录 ✓）' };
	}
	const content = parsed?.data?.document?.content ?? parsed?.document?.content ?? parsed?.content;
	if (typeof content !== 'string') {
		return { ok: false, error: 'JSON 里没有 `data.document.content` ⇒ 契约变了或这不是文档响应 ✓（**不要**把原样 stdout 当正文 ✗）' };
	}
	return { ok: true, content: content.trim(), title: typeof parsed?.data?.document?.title === 'string' ? parsed.data.document.title : undefined };
}
