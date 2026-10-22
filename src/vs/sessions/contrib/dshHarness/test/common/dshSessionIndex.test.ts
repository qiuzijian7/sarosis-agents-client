/*---------------------------------------------------------------------------------------------
 *  dsh 会话索引解析（`common/dshSessionIndex.ts`）行为网
 *
 *  现场（2026-10-19 用户截图）：dsh 里新建的聊天会话不出现在左侧「历史会话」——
 *  侧栏读的是 IDE 自己的 `chat-history` 索引，而 dsh 会话只存在于 projcache 里。
 *  加这条同步前的**唯一**可离线验证的一环就是解析：字段包装 `{ver,seq,val}`、时间取哪个、
 *  坏文件怎么退化 —— 全部钉死，别让"时间取成了事件序号"这类错静默发出（侧栏会乱序）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildDshSessionList, parseDshSessionRecord } from '../../common/dshSessionIndex.js';

/** 造一份最小可用的 projcache 内容（形状照真机 2026-10-19 实测）。 */
function makeCache(opts: {
	cwd?: string;
	title?: string;
	preset?: string;
	createdAt?: number;
	lastPromptAt?: number;
	turns?: number;
	seq?: number;
} = {}): string {
	const seq = opts.seq ?? 19;
	const rows: Record<string, unknown> = {};
	if (opts.title !== undefined) { rows.title = { ver: 1, seq, val: opts.title }; }
	if (opts.preset !== undefined) { rows.agentPreset = { ver: 1, seq, val: opts.preset }; }
	if (opts.turns !== undefined) { rows.sessionStats = { ver: 1, seq, val: { turns: opts.turns, steps: 1 } }; }
	if (opts.lastPromptAt !== undefined) { rows.sessionListMetadata = { ver: 1, seq, val: { blank: false, lastPromptAt: opts.lastPromptAt } }; }
	return JSON.stringify({
		version: 1,
		record: {
			identity: { formatVersion: 4, createdAt: opts.createdAt, cwd: opts.cwd ?? 'G:\\Repo' },
			rows,
		},
	});
}

suite('dsh 会话索引 · 解析', () => {

	test('正常一条：id 去后缀、标题/preset/turns/cwd/时间都取到', () => {
		const s = parseDshSessionRecord('vssaros-chat-chat-1-abc.json', makeCache({
			cwd: 'G:\\SarosWorkspace\\x', title: 'Test', preset: 'vssaros-standard',
			createdAt: 1000, lastPromptAt: 5000, turns: 3,
		}));
		assert.ok(s, '应当解析出来');
		assert.strictEqual(s!.id, 'vssaros-chat-chat-1-abc', 'id = 文件名去掉 .json ✓');
		assert.strictEqual(s!.title, 'Test');
		assert.strictEqual(s!.agentPreset, 'vssaros-standard');
		assert.strictEqual(s!.turns, 3);
		assert.strictEqual(s!.cwd, 'G:\\SarosWorkspace\\x');
		assert.strictEqual(s!.updatedAt, 5000, '★ 时间取 lastPromptAt（不是 createdAt，更不是 seq ✗）');
	});

	test('★ `seq` 不是时间：seq 巨大但 lastPromptAt 很小 ⇒ 仍用 lastPromptAt', () => {
		const s = parseDshSessionRecord('a.json', makeCache({ lastPromptAt: 2000, seq: 999999 }));
		assert.strictEqual(s!.updatedAt, 2000, '投影行的 seq 是事件序号 ⇒ 拿它当时间会让侧栏乱序 ✗');
	});

	test('没有 lastPromptAt ⇒ 回退 identity.createdAt', () => {
		const s = parseDshSessionRecord('a.json', makeCache({ createdAt: 1234 }));
		assert.strictEqual(s!.updatedAt, 1234);
	});

	test('两个时间都没有 ⇒ 0（不伪造成 now，排序时沉底）', () => {
		const s = parseDshSessionRecord('a.json', makeCache({}));
		assert.strictEqual(s!.updatedAt, 0);
	});

	test('标题缺失 ⇒ 空串（不编"新对话"这种假名字）', () => {
		const s = parseDshSessionRecord('a.json', makeCache({}));
		assert.strictEqual(s!.title, '');
	});

	test('★ 没有 cwd ⇒ 整条丢弃（落不了分组；塞进"未分组"是假事实）', () => {
		const text = JSON.stringify({ version: 1, record: { identity: { createdAt: 1 }, rows: { title: { val: 'x' } } } });
		assert.strictEqual(parseDshSessionRecord('a.json', text), undefined);
	});

	test('cwd 只在 workingDirectory 投影里时也能取到（回退口径）', () => {
		const text = JSON.stringify({
			version: 1,
			record: { identity: { createdAt: 1 }, rows: { workingDirectory: { val: 'G:\\W' }, title: { val: 't' } } },
		});
		const s = parseDshSessionRecord('a.json', text);
		assert.strictEqual(s!.cwd, 'G:\\W');
	});

	test('坏 JSON / 缺 record / 缺 rows ⇒ undefined（坏文件只丢自己）', () => {
		assert.strictEqual(parseDshSessionRecord('a.json', '{ not json'), undefined);
		assert.strictEqual(parseDshSessionRecord('a.json', '{"version":1}'), undefined);
		assert.strictEqual(parseDshSessionRecord('a.json', '{"version":1,"record":{"identity":{"cwd":"G:\\\\W"}}}'), undefined);
	});

	test('空格子 / 非字符串标题 ⇒ 空串（不把 "   " 画成标题）', () => {
		const a = parseDshSessionRecord('a.json', makeCache({ title: '   ' }));
		assert.strictEqual(a!.title, '');
		const text = JSON.stringify({ version: 1, record: { identity: { cwd: 'G:\\W' }, rows: { title: { val: 42 } } } });
		assert.strictEqual(parseDshSessionRecord('a.json', text)!.title, '');
	});
});

suite('dsh 会话索引 · 列表', () => {

	test('按 updatedAt 降序；同一时间按 id 稳定排序（刷新时列表不跳 ✗）', () => {
		const list = buildDshSessionList([
			{ id: 'b.json', text: makeCache({ lastPromptAt: 100 }) },
			{ id: 'a.json', text: makeCache({ lastPromptAt: 200 }) },
			{ id: 'c.json', text: makeCache({ lastPromptAt: 200 }) },
		]);
		assert.deepStrictEqual(list.map(s => s.id), ['a', 'c', 'b'], '200 的两条按 id（a<c）稳定 ✓');
	});

	test('坏条目被跳过，不影响其它（侧栏不能整块空白）', () => {
		const list = buildDshSessionList([
			{ id: 'ok.json', text: makeCache({ title: 'ok', lastPromptAt: 1 }) },
			{ id: 'bad.json', text: 'garbage' },
		]);
		assert.deepStrictEqual(list.map(s => s.id), ['ok']);
	});

	test('空输入 ⇒ 空数组', () => {
		assert.deepStrictEqual(buildDshSessionList([]), []);
	});
});
