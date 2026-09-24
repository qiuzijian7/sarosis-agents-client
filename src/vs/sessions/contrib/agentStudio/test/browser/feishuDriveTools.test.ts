/*---------------------------------------------------------------------------------------------
 *  飞书云文档工具族单元测试 —— 2026-09-24
 *
 *  这些工具**不会**在单测里真调飞书（那需要登录态与真实文档），所以测的是两件真正会出错的事：
 *   ① **参数拼装**：CLI 的参数名/取值很挑（裸 token 必须配 `--type`、`+add-comment` 用 `--doc`
 *      而不是 `--url`、`--content` 要 reply_elements JSON）—— 拼错会表现为"工具没用"；
 *   ② **解析与失败映射**：读不到内容时得说清为什么（权限/未登录/CLI 未装/"整篇评论不接受回复"），
 *      而不是把裸错误码或一句"执行失败"丢给模型 —— 那会让模型原地重试或改猜。
 *
 *  ⚠ 局部 helper 命名 `makeTool` 而非 `setup`：`setup` 是 mocha(tdd) 的 beforeEach 全局，
 *    同名会把它遮蔽（2026-09-24 实际踩过，见 videoFrameTools.test.ts 同名注释）。
 *
 *  运行（仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/feishuDriveTools.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	registerFeishuDriveTools, parseDocTarget, normalizeDocType, buildReplyElements,
	buildDocReadArgs, buildListCommentsArgs, buildListRepliesArgs, buildAddCommentArgs, buildAddReplyArgs,
	parseLarkItems, extractText, formatComments, formatReplies, describeCliFailure,
	type IFeishuDriveToolContext,
} from '../../browser/providers/tool/feishuDriveTools.js';
import { LARK_CLI_MISSING_HINT } from '../../browser/knowledge/feishuSyncCore.js';
import type { IBuiltinToolRegistration } from '../../browser/providers/tool/toolRegistry.js';
import type { ILarkCliExecResult } from '../../browser/common/larkCli.js';

const DOC_URL = 'https://xxx.feishu.cn/docx/Abc123xyz';
const WIKI_URL = 'https://xxx.feishu.cn/wiki/Wik987';

/** 一次可用的注册（默认 CLI 已装、可执行）。 */
function makeTool(opts: {
	installed?: boolean;
	statusError?: string;
	run?: (args: string[]) => ILarkCliExecResult | Promise<ILarkCliExecResult>;
	noRunner?: boolean;
	/** 提供"写临时 JSON"能力（产品的真实形态：`--content @file`）。 */
	withTempFile?: boolean;
	/** 临时文件创建失败（验证退回内联 JSON）。 */
	tempFileFails?: boolean;
}) {
	const registered: IBuiltinToolRegistration[] = [];
	const calls: string[][] = [];
	const created: string[] = [];
	const deleted: string[] = [];
	let statusCalls = 0;
	const ctx: IFeishuDriveToolContext = {
		register: d => { registered.push(d); },
		logService: { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as never,
		getCliStatus: async () => { statusCalls++; return { installed: opts.installed !== false, error: opts.statusError }; },
		runLarkCli: opts.noRunner ? undefined : async (args) => {
			calls.push(args);
			return opts.run ? await opts.run(args)
				: { ok: true, stdout: JSON.stringify({ ok: true, data: { items: [] } }), stderr: '' };
		},
		createTempJsonFile: opts.withTempFile ? async (json: string) => {
			if (opts.tempFileFails) { throw new Error('磁盘满了'); }
			const p = `C:\\tmp\\feishu content ${created.length + 1}.json`;
			created.push(`${p} :: ${json}`);
			return p;
		} : undefined,
		deleteTempFile: opts.withTempFile ? async (p: string) => { deleted.push(p); } : undefined,
	};
	registerFeishuDriveTools(ctx);
	const tool = (name: string): IBuiltinToolRegistration => {
		const t = registered.find(r => r.definition.name === name);
		assert.ok(t, `未注册 ${name}`);
		return t!;
	};
	return { tool, calls, created, deleted, status: () => statusCalls, names: registered.map(r => r.definition.name) };
}

const call = (t: IBuiltinToolRegistration, args: Record<string, unknown>): Promise<any> =>
	t.handler(args, undefined, 'agent-1');

async function textOf(r: unknown): Promise<string> {
	const arr = Array.isArray(r) ? r as Array<{ text?: string }>
		: (r as { content?: Array<{ text?: string }> })?.content ?? [];
	return String(arr[0]?.text ?? '');
}

suite('飞书工具 · 注册与归属', () => {

	test('注册 5 个工具且名字与 bundled 定义完全一致（名字漂移会让 stub 顶掉真 handler）', () => {
		const { names } = makeTool({});
		assert.deepStrictEqual(names.sort(), [
			'feishu_doc_read',
			'feishu_drive_add_comment',
			'feishu_drive_list_comment_replies',
			'feishu_drive_list_comments',
			'feishu_drive_reply_comment',
		].sort());
	});

	test('★ 写操作标 Cautious、读操作标 Safe（会在别人文档上留痕的必须更谨慎）', () => {
		const { tool } = makeTool({});
		assert.strictEqual(tool('feishu_doc_read').definition.securityLevel, 'safe');
		assert.strictEqual(tool('feishu_drive_list_comments').definition.securityLevel, 'safe');
		assert.strictEqual(tool('feishu_drive_list_comment_replies').definition.securityLevel, 'safe');
		assert.strictEqual(tool('feishu_drive_reply_comment').definition.securityLevel, 'cautious');
		assert.strictEqual(tool('feishu_drive_add_comment').definition.securityLevel, 'cautious');
	});
});

suite('飞书工具 · 参数归一化（纯函数）', () => {

	test('parseDocTarget：URL 走 --url 分支，裸 token 补默认 docx', () => {
		assert.deepStrictEqual(parseDocTarget({ file_id: DOC_URL }), { url: DOC_URL, type: undefined });
		assert.deepStrictEqual(parseDocTarget({ doc_id: 'Abc123' }), { token: 'Abc123', type: 'docx' });
		assert.deepStrictEqual(parseDocTarget({ file_token: 'Abc123', file_type: 'sheet' }), { token: 'Abc123', type: 'sheet' });
		assert.deepStrictEqual(parseDocTarget({ url: WIKI_URL, file_type: 'wiki' }), { url: WIKI_URL, type: 'wiki' });
	});

	test('★★ 参数名兼容：bundled 用 file_id/doc_id，上游用 file_token/doc_token —— 两套都必须认', () => {
		const asBundled = parseDocTarget({ file_id: 'X' });
		const asUpstream = parseDocTarget({ file_token: 'X' });
		assert.deepStrictEqual(asBundled, asUpstream, '两种命名必须得到同一结果，否则模型换名字调用就"参数缺失"');
		assert.deepStrictEqual(parseDocTarget({ doc_token: 'Y' }), parseDocTarget({ doc_id: 'Y' }));
		assert.deepStrictEqual(parseDocTarget({}), { type: undefined }, '什么都没给 ⇒ 空（由 handler 报参数缺失）');
	});

	test('normalizeDocType：base 是 bitable 的别名（CLI 文档明确写了这个兼容）', () => {
		assert.strictEqual(normalizeDocType('base'), 'bitable');
		assert.strictEqual(normalizeDocType('DOCX'), 'docx');
		assert.strictEqual(normalizeDocType(''), undefined);
		assert.strictEqual(normalizeDocType('doc/x'), undefined, '非法类型不该透传给 CLI');
	});

	test('buildReplyElements：纯文本 → text 元素；已是 JSON 数组则透传；空 ⇒ undefined', () => {
		assert.strictEqual(buildReplyElements('你好'), '[{"type":"text","text":"你好"}]');
		assert.strictEqual(buildReplyElements('  '), undefined);
		const raw = '[{"type":"mention_user","mention_user":{"user_id":"ou_1"}}]';
		assert.strictEqual(buildReplyElements(raw), raw, '要支持 mention/link 元素的逃生口');
		assert.strictEqual(buildReplyElements('[不是 JSON'), '[{"type":"text","text":"[不是 JSON"}]', '不是 JSON 就当纯文本');
	});
});

suite('飞书工具 · CLI 参数拼装（纯函数）', () => {

	test('读文档：docs +fetch，必须 markdown 格式（xml 会给模型一堆块结构）', () => {
		assert.deepStrictEqual(buildDocReadArgs({ doc_id: DOC_URL }),
			['docs', '+fetch', '--doc', DOC_URL, '--doc-format', 'markdown', '--detail', 'with-ids']);
	});

	test('★★ 列评论：默认 `--solved-status all`（CLI 默认只给未解决 ⇒ 会静默漏读）', () => {
		const argv = buildListCommentsArgs({ file_id: DOC_URL });
		assert.deepStrictEqual(argv, ['drive', '+list-comments', '--url', DOC_URL, '--solved-status', 'all']);
		assert.ok(!argv.includes('--comment-scope'), '没指定范围就不该限制');
	});

	test('列评论：is_whole 兼容映射成 --comment-scope whole；显式 scope 优先', () => {
		assert.ok(buildListCommentsArgs({ file_id: DOC_URL, is_whole: true }).includes('whole'));
		assert.ok(buildListCommentsArgs({ file_id: DOC_URL, comment_scope: 'partial' }).includes('partial'));
		assert.ok(buildListCommentsArgs({ file_id: DOC_URL, comment_scope: 'partial', is_whole: true })
			.includes('partial'), '显式 scope 应压过 is_whole');
	});

	test('列评论：裸 token 必须带 --type（CLI 对裸 token 要求类型）；分页参数透传', () => {
		const argv = buildListCommentsArgs({ file_token: 'Tok1', file_type: 'sheet', page_size: 20, page_token: 'p2' });
		assert.deepStrictEqual(argv.slice(0, 5), ['drive', '+list-comments', '--token', 'Tok1', '--type']);
		assert.ok(argv.includes('sheet'));
		assert.ok(argv.includes('--page-size') && argv.includes('20'));
		assert.ok(argv.includes('--page-token') && argv.includes('p2'));
	});

	test('列回复 / 回复：都带 --comment-id；回复带 --content JSON', () => {
		assert.deepStrictEqual(buildListRepliesArgs({ file_id: DOC_URL, comment_id: 'c1' }),
			['drive', '+list-replies', '--url', DOC_URL, '--comment-id', 'c1']);
		const reply = buildAddReplyArgs({ file_id: DOC_URL, comment_id: 'c1', content: '收到' });
		assert.deepStrictEqual(reply, ['drive', '+add-reply', '--url', DOC_URL, '--comment-id', 'c1',
			'--content', '[{"type":"text","text":"收到"}]']);
	});

	test('★★ 内容走 `@file`：argv 里只有路径（cmd + `.cmd` shim 下唯一稳的方式）', () => {
		const path = 'C:\\tmp\\feishu content 1.json';   // 路径含空格：验证仍安全（不含引号/&）
		assert.deepStrictEqual(buildAddReplyArgs({ file_id: DOC_URL, comment_id: 'c1', content: 'x' }, path),
			['drive', '+add-reply', '--url', DOC_URL, '--comment-id', 'c1', '--content', `@${path}`]);
		const add = buildAddCommentArgs({ file_id: DOC_URL, content: 'x' }, 'C:\\t\\c.json');
		assert.ok(add.includes('@C:\\t\\c.json'));
		assert.ok(!add.some(a => a.startsWith('[')),
			'走文件时 argv 里不得再出现内联 JSON —— 其引号/& 会被 cmd 解析破坏（实测 --content 收到截断串）');
	});

	test('★ 发评论：用 `--doc`（不是 `--url`）+ `--full-comment`；block_id 可锚定', () => {
		const argv = buildAddCommentArgs({ file_id: DOC_URL, content: '这条给作者' });
		assert.deepStrictEqual(argv, ['drive', '+add-comment', '--doc', DOC_URL,
			'--content', '[{"type":"text","text":"这条给作者"}]', '--full-comment']);
		assert.ok(buildAddCommentArgs({ file_id: 'Tok', file_type: 'docx', content: 'x' }).includes('--type'));
		assert.ok(buildAddCommentArgs({ file_id: DOC_URL, content: 'x', block_id: 'b1' }).includes('--block-id'));
	});
});

suite('飞书工具 · 输出解析与渲染（纯函数）', () => {

	test('★★ parseLarkItems 容错四种包法（data.items / items / 数组根 / 单对象）', () => {
		assert.strictEqual(parseLarkItems(JSON.stringify({ data: { items: [{ a: 1 }] } })).items.length, 1);
		assert.strictEqual(parseLarkItems(JSON.stringify({ items: [1, 2] })).items.length, 2);
		assert.strictEqual(parseLarkItems(JSON.stringify([1, 2, 3])).items.length, 3);
		assert.strictEqual(parseLarkItems(JSON.stringify({ data: { comment_id: 'c1' } })).items.length, 1);
		assert.deepStrictEqual(parseLarkItems('不是 JSON').items, [], '解析不出 ⇒ 空数组（不抛）');
	});

	test('extractText：text_run 元素拼接优先，其次 content.text / text', () => {
		assert.strictEqual(extractText({ content: { elements: [{ text_run: { text: 'a' } }, { text_run: { text: 'b' } }] } }), 'ab');
		assert.strictEqual(extractText({ content: { text: 'plain' } }), 'plain');
		assert.strictEqual(extractText({ text: 'top' }), 'top');
		assert.strictEqual(extractText(undefined), '');
	});

	test('formatComments：带 comment_id（后续调用要用）+ 整篇/已解决标记 + 引用文本', () => {
		const out = formatComments([
			{
				comment_id: 'c1', is_whole: false, is_solved: true,
				quote: { quote: '第三章的开头' },
				reply_list: { replies: [{ content: { elements: [{ text_run: { text: '这里写错了' } }] } }] },
			},
		]);
		assert.match(out, /共 1 条评论/);
		assert.match(out, /comment_id=c1/);
		assert.match(out, /局部/);
		assert.match(out, /已解决/);
		assert.match(out, /第三章的开头/);
		assert.match(out, /这里写错了/, '第一条回复就是评论正文，必须展示');
	});

	test('★ formatComments：认不出结构时退化为截断 JSON（比空行/报错更有用）', () => {
		const out = formatComments([{ 奇怪字段: 'x'.repeat(600) }]);
		assert.match(out, /奇怪字段/, '结构不认识也要把原始信息给模型');
		assert.ok(out.length < 700, '必须截断，不能把整包 JSON 灌进上下文');
	});

	test('formatComments / formatReplies：空列表给明确说明（区分"没有"与"没读到"）', () => {
		assert.match(formatComments([]), /没有评论/);
		assert.match(formatReplies([], 'c9'), /评论 c9 下没有回复/);
	});
});

suite('飞书工具 · 失败映射（纯函数）', () => {

	test('★★ CLI 未装/命令找不到 ⇒ 附安装指引（不静默降级成网页抓取）', () => {
		const out = describeCliFailure('读取文档', { ok: false, stdout: '', stderr: "spawn lark-cli ENOENT" });
		assert.ok(out.includes(LARK_CLI_MISSING_HINT), '必须给出安装/路径指引');
	});

	test('★★ 整篇/已解决评论不接受回复 ⇒ 指向 feishu_drive_add_comment（不是丢裸错误码）', () => {
		const out = describeCliFailure('回复评论', { ok: false, stdout: '', stderr: 'code=1069302 is_whole comment' });
		assert.match(out, /feishu_drive_add_comment/);
		assert.match(out, /不接受回复/);
	});

	test('权限/未登录类错误 ⇒ 用 error.hint（只回 code 对用户没用）', () => {
		const out = describeCliFailure('列出评论', { ok: false, stdout: '', stderr: '' },
			{ error: { hint: '没有该文档的阅读权限，请让所有者添加你为协作者', code: 3380002 } });
		assert.match(out, /阅读权限/);
		assert.match(out, /3380002/);
	});
});

suite('飞书工具 · handler（注入式端到端）', () => {

	test('★★ CLI 未装 ⇒ 明确指引且**不执行** CLI（避免无谓 spawn 与误导性报错）', async () => {
		const { tool, calls, status } = makeTool({ installed: false, statusError: '未找到 lark-cli' });
		const out = await textOf(await call(tool('feishu_doc_read'), { doc_id: DOC_URL }));
		assert.ok(out.includes(LARK_CLI_MISSING_HINT));
		assert.match(out, /未找到 lark-cli/, '要把探测到的原因一并说明');
		assert.deepStrictEqual(calls, [], '未装就不该执行');
		assert.strictEqual(status(), 1);
	});

	test('★ CLI 状态有 30s 记忆化：连续调用不重复探测（一次对话可能连调 5 个飞书工具）', async () => {
		const { tool, status } = makeTool({ run: () => ({ ok: true, stdout: JSON.stringify({ ok: true, data: { items: [] } }), stderr: '' }) });
		await call(tool('feishu_drive_list_comments'), { file_id: DOC_URL });
		await call(tool('feishu_drive_list_comments'), { file_id: DOC_URL });
		assert.strictEqual(status(), 1, `应只探测一次，实际 ${status()} 次`);
	});

	test('★★ 读文档：走既有 parseFeishuDocFetch，返回 markdown 正文（不是丢掉正文说"内容为空"）', async () => {
		const { tool, calls } = makeTool({
			run: () => ({
				ok: true, stderr: '',
				stdout: JSON.stringify({ ok: true, data: { document: { document_id: 'Abc', content: '# 标题\n\n正文一段\n' } } }),
			}),
		});
		const out = await textOf(await call(tool('feishu_doc_read'), { doc_id: DOC_URL }));
		assert.match(out, /# 标题/);
		assert.match(out, /正文一段/);
		assert.ok(calls[0].includes('markdown'), '必须要求 markdown 格式');
	});

	test('★ 读文档失败（ok:false + hint）⇒ 可读原因，不返回空内容', async () => {
		const { tool } = makeTool({
			run: () => ({ ok: true, stderr: '', stdout: JSON.stringify({ ok: false, error: { hint: '文档不存在或无权访问' } }) }),
		});
		const out = await textOf(await call(tool('feishu_doc_read'), { doc_id: DOC_URL }));
		assert.match(out, /读取文档失败/);
		assert.match(out, /无权访问|不存在/);
	});

	test('★★ 列评论：渲染出 comment_id 并确实带上 `--solved-status all`', async () => {
		const { tool, calls } = makeTool({
			run: () => ({
				ok: true, stderr: '',
				stdout: JSON.stringify({
					ok: true,
					data: { items: [{ comment_id: 'c7', is_whole: false, reply_list: { replies: [{ content: { elements: [{ text_run: { text: '建议改这里' } }] } }] } }] },
				}),
			}),
		});
		const out = await textOf(await call(tool('feishu_drive_list_comments'), { file_id: DOC_URL }));
		assert.match(out, /comment_id=c7/);
		assert.match(out, /建议改这里/);
		assert.ok(calls[0].includes('--solved-status'), '默认必须显式要 all');
	});

	test('★ JSON 里 code != 0 但退出码为 0 ⇒ 仍判失败（CLI 有时这么报业务错误）', async () => {
		const { tool } = makeTool({
			run: () => ({ ok: true, stdout: JSON.stringify({ code: 3380002, msg: 'no permission' }), stderr: '' }),
		});
		const out = await textOf(await call(tool('feishu_drive_list_comments'), { file_id: DOC_URL }));
		assert.match(out, /失败/);
		assert.match(out, /no permission|3380002/);
	});

	test('★ 参数缺失：不执行 CLI、直接给可执行提示（不要浪费一次调用去撞错）', async () => {
		const { tool, calls } = makeTool({});
		assert.match(await textOf(await call(tool('feishu_doc_read'), {})), /需要 doc_id/);
		assert.match(await textOf(await call(tool('feishu_drive_list_comments'), {})), /需要 file_id/);
		assert.match(await textOf(await call(tool('feishu_drive_list_comment_replies'), { file_id: DOC_URL })), /需要 comment_id/);
		assert.match(await textOf(await call(tool('feishu_drive_reply_comment'), { file_id: DOC_URL, comment_id: 'c1', content: '  ' })), /非空的 content/);
		assert.match(await textOf(await call(tool('feishu_drive_add_comment'), { file_id: DOC_URL })), /非空的 content/);
		assert.deepStrictEqual(calls, [], '参数不全时不该执行 CLI');
	});

	test('★ 写操作成功 ⇒ 只回确认（不要把创建结果整包 JSON 灌回上下文）', async () => {
		const { tool } = makeTool({
			run: () => ({ ok: true, stderr: '', stdout: JSON.stringify({ ok: true, data: { comment_id: 'new1', huge: 'x'.repeat(2000) } }) }),
		});
		const replied = await textOf(await call(tool('feishu_drive_reply_comment'), { file_id: DOC_URL, comment_id: 'c1', content: '收到' }));
		assert.match(replied, /已回复评论 c1/);
		assert.ok(replied.length < 80, `确认文案要短，实际 ${replied.length} 字`);
		const added = await textOf(await call(tool('feishu_drive_add_comment'), { file_id: DOC_URL, content: '总结一下' }));
		assert.match(added, /已在该文档上新增评论/);
	});

	test('★ 回复失败（1069302）⇒ handler 回传可执行指引', async () => {
		const { tool } = makeTool({
			run: () => ({ ok: false, stdout: '', stderr: 'code=1069302 is_whole' }),
		});
		const out = await textOf(await call(tool('feishu_drive_reply_comment'), { file_id: DOC_URL, comment_id: 'c1', content: 'x' }));
		assert.match(out, /feishu_drive_add_comment/);
	});

	test('★★ 写操作走临时文件：内容原样落盘并以 @file 传入，且**成功/失败都要删**（内容可能敏感）', async () => {
		const ok = makeTool({
			withTempFile: true,
			run: () => ({ ok: true, stderr: '', stdout: JSON.stringify({ ok: true, data: {} }) }),
		});
		const content = '收到 & 处理「引号」';
		await call(ok.tool('feishu_drive_reply_comment'), { file_id: DOC_URL, comment_id: 'c1', content });
		assert.strictEqual(ok.created.length, 1);
		assert.match(ok.created[0], /收到 & 处理「引号」/, '原始内容应写进文件（而不是被转义破坏）');
		const path = ok.created[0].split(' :: ')[0];
		assert.ok(ok.calls[0].includes(`@${path}`), `argv 必须用 @file，实际：${JSON.stringify(ok.calls[0])}`);
		assert.deepStrictEqual(ok.deleted, [path], '用完必须删除');

		const bad = makeTool({ withTempFile: true, run: () => ({ ok: false, stdout: '', stderr: 'boom' }) });
		await call(bad.tool('feishu_drive_add_comment'), { file_id: DOC_URL, content: 'x' });
		assert.strictEqual(bad.deleted.length, 1, '失败路径也必须清理临时文件');
	});

	test('★ 临时文件创建失败 ⇒ 退回内联 JSON（不因清理能力异常而拒绝服务）', async () => {
		const { tool, calls, created, deleted } = makeTool({ withTempFile: true, tempFileFails: true });
		const out = await textOf(await call(tool('feishu_drive_add_comment'), { file_id: DOC_URL, content: 'x' }));
		assert.strictEqual(created.length, 0);
		assert.deepStrictEqual(deleted, [], '没创建就不用删');
		assert.ok(calls[0].includes('[{"type":"text","text":"x"}]'), '应退回内联 JSON');
		assert.match(out, /已在该文档上新增评论/, '退回后仍应正常完成');
	});

	test('非桌面宿主（无 CLI 执行能力）⇒ 明确说明，而不是假装成功', async () => {
		const { tool } = makeTool({ noRunner: true });
		const out = await textOf(await call(tool('feishu_drive_list_comments'), { file_id: DOC_URL }));
		assert.match(out, /无法执行 lark-cli/);
	});
});
