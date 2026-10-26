// @vssaros/dsh-agents — 群聊 `@` 提及：纯函数层单测（2026-10-26）
//   跑法：node dsh-plugins/vssaros-agents/test/mentions.test.mjs
//
// 为什么单独一条：这套逻辑是"字符串 + 光标位置"的计算，最容易出的不是崩溃而是**边界错**：
//   邮箱被当成 mention、@ 到前缀相近的 id、编辑后 offset 漂移、Backspace 逐字删……
//   这些在真机上很难用肉眼验，用断言钉住最省事。
import assert from 'node:assert/strict';
import {
	ALL_LABEL, activeMentionQuery, collectMentions, deleteSelectedMention,
	escapeRe, mentionCandidates, mentionRuns, mentionedAgentIds, rebaseMentions, selectMention,
} from '../lib/mentions.js';

let pass = 0;
const fails = [];
const check = (name, fn) => {
	try { fn(); pass += 1; }
	catch (e) { fails.push(`${name} → ${String(e && e.message || e).split('\n')[0]}`); }
};

const MEMBERS = [
	{ id: 'code-architect', name: 'Code Architect' },
	{ id: 'coder', name: 'Coder' },
	{ id: 'coder-2', name: 'Coder Two' },
	{ id: 'writer', name: 'Writer' },
];

/* ── activeMentionQuery ─────────────────────────────────────────────── */
check('@ 刚打出来就开弹（caret 紧跟 @）', () => {
	assert.deepEqual(activeMentionQuery('@', 1), { start: 0, end: 1, query: '' });
});
check('@ + 部分名字 → query 是那一段', () => {
	assert.deepEqual(activeMentionQuery('hi @cod', 7), { start: 3, end: 7, query: 'cod' });
});
check('★ 邮箱不触发（@ 前一字符是词字符）', () => {
	assert.equal(activeMentionQuery('a@b', 3), undefined);
	assert.equal(activeMentionQuery('mail me at a@b.com', 19), undefined);
});
check('★ 空格后的 @ 正常触发（词边界只在词字符后才拦）', () => {
	assert.deepEqual(activeMentionQuery('a @b', 4), { start: 2, end: 4, query: 'b' });
});
check('★ 往回超过 34 字符不触发（防止乱弹）', () => {
	const long = '@' + 'x'.repeat(40);
	assert.equal(activeMentionQuery(long, long.length), undefined);
});
check('query 里出现 # 或 @ 或换行 ⇒ 放弃', () => {
	assert.equal(activeMentionQuery('@a#b', 4), undefined);
	assert.equal(activeMentionQuery('@a@b', 4), undefined);
	assert.equal(activeMentionQuery('@a\nb', 4), undefined);
});
check('★ 打 `@ ` 立刻关闭（空白即终止 token，不是等 filter 无匹配）', () => {
	assert.equal(activeMentionQuery('@ ', 2), undefined);
	assert.equal(activeMentionQuery('hi @a b', 7), undefined);
	assert.equal(activeMentionQuery('hi @a\tb', 7), undefined);
});
check('caret 在 @ 之前时不触发', () => {
	assert.equal(activeMentionQuery('@abc', 0), undefined);
});

/* ── selectMention ──────────────────────────────────────────────────── */
check('选中后插入 @id + 尾空格，caret 落到空格之后', () => {
	const r = selectMention('hello @co', { start: 6, end: 9, query: 'co' }, 'code-architect');
	assert.equal(r.value, 'hello @code-architect ');
	assert.equal(r.caret, r.value.length);
});
check('后面本来就有一个空格 ⇒ 不重复补', () => {
	const r = selectMention('@co 后续', { start: 0, end: 3, query: 'co' }, 'coder');
	assert.equal(r.value, '@coder 后续');
	assert.equal(r.caret, '@coder'.length + 1);
});
check('插在句子中间时后半段保留', () => {
	const r = selectMention('请 @co 看一下', { start: 2, end: 5, query: 'co' }, 'coder');
	assert.equal(r.value, '请 @coder 看一下');
});

/* ── rebaseMentions ─────────────────────────────────────────────────── */
check('★ 在 token 前面插字 ⇒ 整体后移', () => {
	const before = '@coder 你好';
	const after = '嗨 ' + before;
	const moved = rebaseMentions(before, after, [{ start: 0, end: 6, label: 'coder' }]);
	assert.deepEqual(moved, [{ start: 2, end: 8, label: 'coder' }]);
});
check('★ 在 token 后面插字 ⇒ offset 不变', () => {
	const before = '@coder 你';
	const after = '@coder 你好';
	const same = rebaseMentions(before, after, [{ start: 0, end: 6, label: 'coder' }]);
	assert.deepEqual(same, [{ start: 0, end: 6, label: 'coder' }]);
});
check('★ 把 token 本身改坏 ⇒ 丢弃（宁可不高亮，不要错位 chip）', () => {
	const before = '@coder 你';
	const after = '@codex 你';
	assert.deepEqual(rebaseMentions(before, after, [{ start: 0, end: 6, label: 'coder' }]), []);
});

/* ── mentionRuns ────────────────────────────────────────────────────── */
check('切成 普通/mention 片段', () => {
	const runs = mentionRuns('你好 @coder 看下', [{ start: 3, end: 9, label: 'coder' }]);
	assert.deepEqual(runs.map((r) => r.text), ['你好 ', '@coder', ' 看下']);
	assert.ok(runs[1].mention, '中间那段应带 mention 标记');
});
check('★ 脏 offset（slice 对不上）被跳过，仍能渲染全文', () => {
	const runs = mentionRuns('你好 @coder', [{ start: 0, end: 6, label: 'coder' }]);
	assert.equal(runs.length, 1);
	assert.equal(runs[0].text, '你好 @coder');
	assert.equal(runs[0].mention, undefined);
});

/* ── deleteSelectedMention ──────────────────────────────────────────── */
check('★ Backspace 在 token 尾部 ⇒ 整块删（含尾空格）', () => {
	const value = '@coder 你好';
	const r = deleteSelectedMention(value, [{ start: 0, end: 6, label: 'coder' }], 7, 7, 'Backspace');
	assert.equal(r.value, '你好');
	assert.equal(r.caret, 0);
});
check('★ Backspace 在 token 前面 ⇒ 不命中（交给默认行为）', () => {
	const r = deleteSelectedMention('@coder', [{ start: 0, end: 6, label: 'coder' }], 0, 0, 'Backspace');
	assert.equal(r, undefined);
});
check('Delete 在 token 开头 ⇒ 整块删', () => {
	const r = deleteSelectedMention('@coder 你好', [{ start: 0, end: 6, label: 'coder' }], 0, 0, 'Delete');
	assert.equal(r.value, '你好');
});
check('选中区间覆盖 token ⇒ 一并删', () => {
	const r = deleteSelectedMention('a @coder b', [{ start: 2, end: 8, label: 'coder' }], 1, 10, 'Backspace');
	assert.equal(r.value, 'a');
});

/* ── mentionCandidates ──────────────────────────────────────────────── */
check('按名字/id 过滤（大小写不敏感）', () => {
	const items = mentionCandidates(MEMBERS, 'cod');
	const ids = items.map((i) => (i.kind === 'bot' ? i.agent.id : 'all'));
	assert.deepEqual(ids, ['code-architect', 'coder', 'coder-2']);
});
check('★ 空 query ⇒ 全部 + @所有人 排第一', () => {
	const items = mentionCandidates(MEMBERS, '');
	assert.equal(items[0].kind, 'all');
	assert.equal(items[0].label, ALL_LABEL);
	assert.ok(items.length >= 4);
});
check('★ 没有成员 ⇒ 不提供 @所有人', () => {
	const items = mentionCandidates([], '');
	assert.deepEqual(items, []);
});
check('输中文「所有人」也能命中 @所有人', () => {
	const items = mentionCandidates(MEMBERS, '所有');
	assert.equal(items[0].kind, 'all');
});

/* ── collectMentions / mentionedAgentIds ────────────────────────────── */
check('扫出 id 型 mention（带正确 offset）', () => {
	const ms = collectMentions('hi @coder 在吗', MEMBERS);
	assert.deepEqual(ms.map((m) => [m.label, m.start, m.end]), [['coder', 3, 9]]);
});
check('★ 前缀相近的 id 不误判（@coder 不该命中 @coder-2）', () => {
	const ms = collectMentions('@coder-2 你好', MEMBERS);
	assert.deepEqual(ms.map((m) => m.label), ['coder-2']);
});
check('★ 多个 mention 按位置排序', () => {
	const ms = collectMentions('@writer 和 @coder', MEMBERS);
	assert.deepEqual(ms.map((m) => m.label), ['writer', 'coder']);
});
check('@所有人', () => {
	const ms = collectMentions('@@', MEMBERS); // 无
	assert.deepEqual(ms, []);
	const all = collectMentions('@' + ALL_LABEL + ' 开会', MEMBERS);
	assert.deepEqual(all.map((m) => m.kind), ['all']);
});
check('★ 收件人：@所有人 ⇒ 全群；否则只取被 @ 的（去重保序）', () => {
	assert.deepEqual(mentionedAgentIds('@' + ALL_LABEL, MEMBERS), ['code-architect', 'coder', 'coder-2', 'writer']);
	assert.deepEqual(mentionedAgentIds('@coder @coder @writer', MEMBERS), ['coder', 'writer']);
	assert.deepEqual(mentionedAgentIds('没有 at', MEMBERS), []);
});

/* ── escapeRe ───────────────────────────────────────────────────────── */
check('escapeRe 转义正则元字符', () => {
	// `-` 在字符类外面不是元字符，不该被转义（转义了也能用，但输出不干净）
	assert.equal(escapeRe('a.b-c'), 'a\\.b-c');
	assert.ok(new RegExp(escapeRe('x.y')).test('x.y'));
	assert.ok(!new RegExp('^' + escapeRe('x.y') + '$').test('xzy'), '转义后不该再匹配任意字符');
});

/* ── 服务端：normalizeMentions 的防守性校验 ───────────────────────────
   客户端给的 offset 一律当成**不可信输入**：slice 对不上、id 不是成员、重复 ⇒ 丢弃那一条。
   这类校验在真机上极难复现（要伪造请求），用单测钉住最划算。 */
{
	const { normalizeMentions, parseMentions } = await import('../lib/groups.js');
	const TEXT = 'hi @coder 和 @code-architect 还有 @所有人';

	/* ⚠ offset 一律用 indexOf 算 —— 手数下标必然出错（我第一次就把 `@所有人` 写成 32/36，
	   实际是 31/35，白红一条）。 */
	const at = (label) => {
		const start = TEXT.indexOf('@' + label);
		return { start, end: start + 1 + label.length };
	};
	check('★ 服务端：合法 mentions 全保留（含 @所有人）', () => {
		const out = normalizeMentions([
			{ ...at('coder'), label: 'coder', agentId: 'coder' },
			{ ...at('code-architect'), label: 'code-architect', agentId: 'code-architect' },
			{ ...at('所有人'), label: '所有人', kind: 'all' },
		], TEXT, ['coder', 'code-architect'], [{ id: 'coder' }, { id: 'code-architect' }]);
		assert.deepEqual(out.map((m) => m.label), ['coder', 'code-architect', '所有人']);
	});
	check('★ 服务端：slice 对不上的 offset 被丢弃（防伪造/防漂移）', () => {
		const out = normalizeMentions([{ start: 0, end: 9, label: 'coder' }], TEXT, ['coder'], [{ id: 'coder' }]);
		assert.deepEqual(out, []);
	});
	check('★ 服务端：不是本群成员 / 不存在的 agent ⇒ 丢弃', () => {
		const out = normalizeMentions([
			{ start: 3, end: 9, label: 'coder' },
		], TEXT, ['architect'], [{ id: 'coder' }]);
		assert.deepEqual(out, []);
	});
	check('服务端：重复 id 只留一条；输出按 start 排序', () => {
		const out = normalizeMentions([
			{ start: 12, end: 27, label: 'code-architect' },
			{ start: 3, end: 9, label: 'coder' },
			{ start: 3, end: 9, label: 'coder' },
		], TEXT, ['coder', 'code-architect'], [{ id: 'coder' }, { id: 'code-architect' }]);
		assert.deepEqual(out.map((m) => m.label), ['coder', 'code-architect']);
	});
	check('★ 服务端 parseMentions（回退路径）也有边界：@coder 不命中 coder-2', () => {
		const pool = [{ id: 'coder', name: 'Coder' }, { id: 'coder-2', name: 'Coder Two' }];
		assert.deepEqual(parseMentions('@coder-2 你好', ['coder', 'coder-2'], pool).map((a) => a.id), ['coder-2']);
		assert.deepEqual(parseMentions('@coder 你好', ['coder', 'coder-2'], pool).map((a) => a.id), ['coder']);
	});
}

/* ── 汇总 ──────────────────────────────────────────────────────────── */
const total = pass + fails.length;
if (fails.length) {
	console.log(`\n✗ ${fails.length}/${total} 失败：`);
	fails.forEach((f) => console.log('   - ' + f));
} else {
	console.log(`✓ mentions 单测 ${pass}/${total} 全部通过`);
}
process.exitCode = fails.length ? 1 : 0;
