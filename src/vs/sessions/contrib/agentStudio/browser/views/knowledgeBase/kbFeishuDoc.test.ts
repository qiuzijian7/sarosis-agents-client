/*---------------------------------------------------------------------------------------------
 *  飞书云文档导入（URL 判定 / CLI 输出解析 / 资源标签改写 / markdown 组装）单元测试。
 *
 *  运行（从仓库根目录）：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/browser/views/knowledgeBase/kbFeishuDoc.test.ts
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	composeFeishuDocMarkdown,
	extractFeishuMediaRefs,
	firstHeading,
	isFeishuDocUrl,
	parseFeishuDocFetch,
	planFeishuMediaKey,
	planFeishuMediaName,
	replaceFeishuMediaRefs,
} from './kbFeishuDoc.js';

suite('AgentStudio - kbFeishuDoc 飞书文档导入', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// ── URL 判定 ────────────────────────────────────────────────────────────
	test('识别 docx / docs(旧版) / wiki 链接', () => {
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/docx/AbCdEf123'), true);
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/docs/AbCdEf123'), true);
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/wiki/AbCdEf123?from=chat'), true);
		assert.strictEqual(isFeishuDocUrl('https://acme.larksuite.com/docx/AbCdEf123'), true);
	});

	test('非文档链接 / 非飞书域名不误判（避免抢走通用抓取）', () => {
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/sheets/AbCdEf'), false, '电子表格不在范围内');
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/base/AbCdEf'), false, '多维表格不在范围内');
		assert.strictEqual(isFeishuDocUrl('https://acme.feishu.cn/'), false);
		assert.strictEqual(isFeishuDocUrl('https://example.com/docx/abc'), false, '非飞书域名');
		assert.strictEqual(isFeishuDocUrl('not a url'), false);
	});

	// ── CLI 输出解析 ────────────────────────────────────────────────────────
	test('解析 docs +fetch 的 JSON（容忍前后杂项输出），标题取正文首个 # 标题', () => {
		const stdout = 'npm warn something\n'
			+ JSON.stringify({ ok: true, data: { document: { document_id: 'd1', content: '# 设计评审\n\n正文…' } } })
			+ '\nsome trailing noise';
		const r = parseFeishuDocFetch(stdout);
		assert.strictEqual(r.ok, true);
		assert.strictEqual(r.title, '设计评审');
		assert.strictEqual(r.content, '# 设计评审\n\n正文…');
	});

	test('ok:false 时提取 error.hint 作为可读原因（权限类错误）', () => {
		const stdout = JSON.stringify({ ok: false, error: { code: 'permission_denied', hint: '当前身份没有该文档的阅读权限' } });
		const r = parseFeishuDocFetch(stdout, '');
		assert.strictEqual(r.ok, false);
		assert.ok(r.error?.includes('没有该文档的阅读权限'));
		assert.ok(r.error?.includes('permission_denied'));
	});

	test('没有 content 视为失败；firstHeading 无标题返回 undefined', () => {
		assert.strictEqual(parseFeishuDocFetch(JSON.stringify({ ok: true, data: {} })).ok, false);
		assert.strictEqual(parseFeishuDocFetch('不是 JSON').ok, false);
		assert.strictEqual(firstHeading('没有标题的正文'), undefined);
	});

	// ── 内嵌资源抽取 ────────────────────────────────────────────────────────
	test('按出现顺序抽取 img / source / whiteboard，同资源去重', () => {
		const content = '<p>前</p><img token="t1" width="100"/><source token="t2" name="报告.pdf"/>'
			+ '<whiteboard token="wb1"/><img token="t1"/>';
		const refs = extractFeishuMediaRefs(content);
		assert.strictEqual(refs.length, 3, '重复 token 只留一次');
		assert.deepStrictEqual(refs.map(r => r.kind), ['media', 'media', 'whiteboard']);
		assert.deepStrictEqual(refs.map(r => r.token), ['t1', 't2', 'wb1']);
		assert.strictEqual(refs[1].name, '报告.pdf');
		assert.strictEqual(refs[2].raw, '<whiteboard token="wb1"/>');
	});

	test('只带 url 的公开图片没有 token ⇒ 不下载也不动它', () => {
		const content = '<img url="https://cdn.example.com/a.png" width="1"/>';
		assert.strictEqual(extractFeishuMediaRefs(content).length, 0);
		assert.strictEqual(replaceFeishuMediaRefs(content, new Map()), content, '原样保留');
	});

	// ── 标签改写 ────────────────────────────────────────────────────────────
	test('改写为本地相对引用；未下载的换成可读占位，绝不留下 XML 标签', () => {
		const content = '文首\n<img token="t1"/>\n<whiteboard token="wb1"/>\n文末';
		const rel = new Map([
			[planFeishuMediaKey({ kind: 'media', token: 't1', raw: '' }), 'assets/评审/img-01.png'],
		]);
		const out = replaceFeishuMediaRefs(content, rel);
		assert.ok(out.includes('![图片](assets/评审/img-01.png)'), '已下载的用本地引用');
		assert.ok(out.includes('未能下载画板/思维导图：token wb1'), '未下载的给占位说明');
		assert.ok(!out.includes('<img') && !out.includes('<whiteboard'), '不得残留原始标签');
	});

	test('文件名规划：图片 img-NN、画板 board-NN，序号与标签顺序一致', () => {
		assert.strictEqual(planFeishuMediaName(0, { kind: 'media', token: 'a', raw: '' }), 'img-01');
		assert.strictEqual(planFeishuMediaName(1, { kind: 'whiteboard', token: 'b', raw: '' }), 'board-02');
		assert.strictEqual(planFeishuMediaName(9, { kind: 'media', token: 'c', raw: '' }), 'img-10');
	});

	// ── 组装 ────────────────────────────────────────────────────────────────
	test('组装 markdown：标题 + 来源/导入方式 + 正文；失败数如实报出', () => {
		const md = composeFeishuDocMarkdown({
			url: 'https://acme.feishu.cn/docx/x', title: '设计评审', body: '## 小节\n\n| a | b |\n| - | - |\n| 1 | 2 |',
			images: 2, mediaFailed: 1,
		});
		assert.ok(md.startsWith('# 设计评审\n'), '首个标题必须是文档标题');
		assert.ok(md.includes('原文：https://acme.feishu.cn/docx/x'));
		assert.ok(md.includes('已本地化图片 2 张') && md.includes('1 个资源未能下载'));
		assert.ok(md.includes('| a | b |'), '表格正文应原样保留');
		assert.ok(md.endsWith('\n'));
	});

	test('无图片时不谎报数量', () => {
		const md = composeFeishuDocMarkdown({ url: 'u', title: 't', body: '正文', images: 0 });
		assert.ok(md.includes('无本地图片'));
		assert.ok(!md.includes('未能下载'));
	});
});
