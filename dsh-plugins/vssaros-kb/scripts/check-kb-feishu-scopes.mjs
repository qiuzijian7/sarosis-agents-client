/*
 * 2026-11-10 真机事故守卫：`wiki +space-list` 返回飞书 `99991672`（bot 缺 wiki scope）。
 *
 * 旧行为两处都错：
 *   ① `/api/feishu-spaces` 把 CLI 原始 JSON 的末尾 800 字直接塞进 `error` ⇒ 设置页一坨乱码；
 *   ② `kb_feishu_spaces` 工具不检查退出码 ⇒ 权限错误被 parseSpaceList 变成 0 条，
 *      再回一句「确认已用用户身份登录」⇒ 伪装成"没登录 / 没有知识库" ✗。
 *
 * 夹具就是用户贴回来的那段真实错误（含 _notice 升级提示），跑纯函数 + 静态接线断言。
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-feishu-scopes.mjs
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const core = await import(new URL('../lib/core/feishuSpaces.js', import.meta.url).href);
const INDEX = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
const CORE = readFileSync(new URL('../lib/core/feishuSpaces.js', import.meta.url), 'utf8');
const CLIENT = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const TSX = readFileSync(new URL('../../../src/vs/sessions/contrib/agentStudio/webview/src/kbSideview/index.tsx', import.meta.url), 'utf8');
const BUNDLE = readFileSync(new URL('../lib/web/kbSideview.js', import.meta.url), 'utf8');

let pass = 0, fail = 0;
const check = (name, fn) => {
	try { fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

/** 用户 2026-11-10 21:27 贴回来的真实输出（补全外层，字段逐个照抄）。 */
const REAL_FAILURE = JSON.stringify({
	ok: false,
	error: {
		code: 99991672,
		msg: 'Access denied. One of the following scopes is required: [wiki:wiki, wiki:wiki:readonly, wiki:space:retrieve].',
		message: 'Access denied...%3Awiki%3Areadonly%2Cwiki%3Aspace%3Aretrieve',
		log_id: '202611102127148C8545FB89C9BC5E6F41',
		troubleshooter: '排查建议查看(Troubleshooting suggestions): https://open.feishu.cn/search?from=openapi&log_id=202611102127148C8545FB89C9BC5E6F41&code=99991672&method_id=6976461983962218497',
		missing_scopes: ['wiki:wiki', 'wiki:wiki:readonly', 'wiki:space:retrieve'],
		identity: 'bot',
		console_url: 'https://open.feishu.cn/page/scope-apply?clientID=cli_a860911d2e7f5013&scopes=wiki%3Awiki%2Cwiki%3Awiki%3Areadonly%2Cwiki%3Aspace%3Aretrieve',
	},
	_notice: {
		update: {
			command: 'lark-cli update', current: '1.0.98', latest: '1.0.99',
			message: 'lark-cli 1.0.99 available, current 1.0.98, run: lark-cli update',
		},
	},
});

check('解析器存在（纯函数，不在 Host 里）', () =>
	assert.equal(typeof core.describeLarkCliFailure, 'function'));

const f = core.describeLarkCliFailure('lark-cli: 拉取失败\n' + REAL_FAILURE, 1);

check('① 识别为 missing-scopes / 错误码 99991672 / bot 身份', () => {
	assert.equal(f.kind, 'missing-scopes');
	assert.equal(f.code, '99991672');
	assert.equal(f.identity, 'bot');
});
check('② 三个缺失 scope 一个不少', () =>
	assert.deepEqual(f.missingScopes, ['wiki:wiki', 'wiki:wiki:readonly', 'wiki:space:retrieve']));
check('③ 申请入口 console_url 与 log_id 都留着', () => {
	assert.ok(f.consoleUrl.includes('scope-apply') && f.consoleUrl.includes('cli_a860911d2e7f5013'));
	assert.equal(f.logId, '202611102127148C8545FB89C9BC5E6F41');
});
check('④ 附带 lark-cli 升级提示（1.0.98 → 1.0.99）', () => {
	assert.equal(f.notice?.current, '1.0.98');
	assert.equal(f.notice?.latest, '1.0.99');
	assert.equal(f.notice?.command, 'lark-cli update');
});
check('⑤ message 是可行动的中文提示：缺什么、去哪申请、要发版、备用用户身份', () => {
	for (const needle of ['缺少飞书知识库权限', 'wiki:space:retrieve', '发布新版本', '申请入口',
		'https://open.feishu.cn/page/scope-apply', 'auth login --as user', 'log_id', '1.0.99']) {
		assert.ok(f.message.includes(needle), `message 缺「${needle}」`);
	}
});
check('⑥ message 不再糊原始 JSON 噪声（troubleshooter / method_id / 原始字段）', () => {
	for (const noise of ['method_id=', 'troubleshooter', '"_notice"', '"ok":false', '"missing_scopes"']) {
		assert.ok(!f.message.includes(noise), `message 里混进了原始噪声「${noise}」`);
	}
	assert.ok(f.message.length < 900, 'message 太长，等于换了个方式糊一坨');
});
check('⑦ 原始输出仍保留在 detail 里供诊断，但不进 message', () => {
	assert.ok(f.detail.includes('99991672'));
	assert.ok(!f.message.includes('method_id'));
});
check('⑧ 错误字段在顶层（不是 error 里）也能解析', () => {
	const flat = core.describeLarkCliFailure(JSON.stringify({
		code: 99991672, missing_scopes: ['wiki:wiki'], identity: 'user',
		console_url: 'https://open.feishu.cn/page/scope-apply?clientID=cli_x',
	}), 1);
	assert.equal(flat.kind, 'missing-scopes');
	assert.equal(flat.identity, 'user');
	assert.deepEqual(flat.missingScopes, ['wiki:wiki']);
	assert.ok(flat.message.includes('当前 lark-cli 身份（user）'));
});
check('⑨ 非 scope 错误 → kind=other，给退出码/飞书错误码，不伪装成功', () => {
	const other = core.describeLarkCliFailure('boom\n' + JSON.stringify({ code: 19001, msg: 'invalid access token' }), 2);
	assert.equal(other.kind, 'other');
	assert.ok(other.message.includes('退出码 2') && other.message.includes('19001'));
	assert.ok(other.message.includes('invalid access token'));
	assert.ok(other.message.includes('lark-cli'), '仍要给 CLI 安装/登录指引');
});
check('⑩ 空输出也不抛，且给得出提示', () => {
	const empty = core.describeLarkCliFailure('', -1);
	assert.equal(empty.kind, 'other');
	assert.ok(empty.message.includes('退出码 -1'));
});

// ── 接线断言（防止"解析器写好了但没人用"） ──────────────────────────────────
check('⑪ /api/feishu-spaces 失败时用解析器 + 返回结构化字段', () => {
	assert.ok(INDEX.includes('describeLarkCliFailure'), '没 import 解析器');
	assert.ok(/errorKind:\s*f\.kind/.test(INDEX) && /missingScopes:\s*f\.missingScopes/.test(INDEX)
		&& /consoleUrl:\s*f\.consoleUrl/.test(INDEX), 'API 没返回结构化字段');
	assert.ok(!/String\(\(r\.stderr \|\| r\.stdout \|\| ''\)\)\.slice\(-800\)/.test(INDEX),
		'还在直接把原始 JSON 塞给前端');
});
check('⑫ kb_feishu_spaces 工具在 parse 之前检查退出码（不再伪装成空列表）', () => {
	const at = INDEX.indexOf("name: 'kb_feishu_spaces'");
	assert.ok(at > 0);
	const seg = INDEX.slice(at, at + 9000);
	assert.ok(/if \(listed\.code !== 0\)/.test(seg), '工具没检查退出码');
	assert.ok(seg.indexOf('if (listed.code !== 0)') < seg.indexOf('parseSpaceList('),
		'检查退出码必须排在 parseSpaceList 之前');
});
check('⑬ 前端两份设置页都展示解析后的文案', () => {
	assert.ok(TSX.includes("setOut('拉取飞书知识库失败：\\n'"), 'React 设置页没用换行分段展示');
	assert.ok(/why = String\(\(b && b\.error\) \|\| '未知原因'\)\.replace/.test(CLIENT), '面板设置页没压平可读文案');
});
check('⑭ 产物 bundle 已同步（改 TSX 不跑 sync 会红）', () => {
	const at = BUNDLE.indexOf('feishu-spaces');
	assert.ok(at > 0, 'bundle 里找不到 feishu-spaces 调用');
	// 中文在压缩产物里是 \uXXXX；新版的特征是「失败：」后带换行分段（旧版直接拼原始 error）
	const seg = BUNDLE.slice(at, at + 420);
	assert.ok(/\\uFF1A[\r\n]/.test(seg),
		'bundle 还是旧版 ⇒ 改完 TSX 没跑 build:kbSideview + sync-kb-sideview.mjs');
});

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
