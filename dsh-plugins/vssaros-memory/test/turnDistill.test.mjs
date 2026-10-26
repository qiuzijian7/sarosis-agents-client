/*---------------------------------------------------------------------------------------------
 *  turnDistill.test.mjs — **按回合摘要自动沉淀**（★ 2026-10-26，用户要求）
 *
 * ## 背景（为什么必须加这条路径）
 * 旧自动沉淀只认**显式句式**（`DISTILL_PATTERNS`：以后/记住/约定/注意/务必/always…）
 * ⇒ 普通对话一条候选都产不出来 ⇒ 账本实测 **106/106 `no-candidate`**、四层记忆恒 0
 * ⇒ 用户感受："聊了半天什么都没记住" ✗✗
 * 另一条 `summaryCandidatesOf` 只认 `compaction/summary`（上下文压缩时的模型摘要）
 * ⇒ 短会话永远等不到。
 *
 * ## 本测试钉住的不变量（保守优先，宁少不脏）
 *  ① 正常回合 ⇒ 恰好 1 条，`matched === 'turn-summary'`，文本形如「用户诉求 ⇒ 助手结论」
 *  ② 用户话太短（< 10 字，寒暄/单词）⇒ **不产**（否则全是噪音）
 *  ③ 助手回复太短（< 24 字，"好的/收到"）⇒ **不产**
 *  ④ 历史草稿已有同 digest ⇒ **不产**（去重）
 *  ⑤ 压缩检查点（`source.kind === 'compact-checkpoint'`）**不算用户话** ⇒ 不能当回合摘要输入
 *  ⑥ 超长输入 ⇒ 截断到 DISTILL_MAX_CHARS + 1（省略号）
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { turnCandidatesOf, TURN_MATCHED_TAG, DISTILL_MAX_CHARS } from '../lib/core/distill.js';
// ⚠ `auditDigestOf` 由 distill.js 内部从 audit.js 引入，**没有 re-export** ⇒ 测试要单独 import ✓
import { auditDigestOf } from '../lib/core/audit.js';

const results = [];
const check = (name, fn) => {
	try { const d = fn(); results.push({ name, ok: true, detail: d || '' }); }
	catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
};

const user = text => ({ type: 'user/message', data: { content: text, source: { kind: 'user' } } });
const userFromModel = text => ({ type: 'user/message', data: { content: text, source: { kind: 'compact-checkpoint' } } });
const assistant = text => ({ type: 'assistant/message', data: { content: [{ type: 'text', text }] } });

const USER_OK = '帮我把记忆链路的读取注入存储三件事都验证一遍';
const ASSIST_OK = '已定位三处断点：读取通道正常但分区错位、注入侧跨分区兜底、写入侧代理缺少 observe 方法。';

check('① 正常回合 ⇒ 恰好 1 条，带 turn-summary 标记', () => {
	const out = turnCandidatesOf([user(USER_OK), assistant(ASSIST_OK)], { sessionId: 's1', turn: 3, now: 1 });
	assert.equal(out.length, 1, '应恰好产 1 条');
	assert.equal(out[0].matched, TURN_MATCHED_TAG, '必须带 turn-summary 标记（便于与正则候选区分）');
	assert.ok(out[0].text.includes('⇒'), '文本应形如「用户诉求 ⇒ 助手结论」');
	assert.equal(out[0].source.sessionId, 's1');
	assert.equal(out[0].source.turn, 3);
	return out[0].text.slice(0, 60);
});

check('② 用户话太短 ⇒ 不产（寒暄不算记忆）', () => {
	assert.equal(turnCandidatesOf([user('你好'), assistant(ASSIST_OK)], {}).length, 0);
	return 'ok';
});

check('③ 助手回复太短 ⇒ 不产（"好的/收到"这类空回复）', () => {
	assert.equal(turnCandidatesOf([user(USER_OK), assistant('好的，收到。')], {}).length, 0);
	return 'ok';
});

check('④ 历史草稿已有同 digest ⇒ 不产（去重）', () => {
	const first = turnCandidatesOf([user(USER_OK), assistant(ASSIST_OK)], {});
	assert.equal(first.length, 1);
	const seen = new Set([first[0].digest]);
	assert.equal(turnCandidatesOf([user(USER_OK), assistant(ASSIST_OK)], { seenDigests: seen }).length, 0,
		'同一条回合摘要不能重复沉淀 ✗');
	return 'ok';
});

check('⑤ 压缩检查点不算用户话 ⇒ 不能当回合摘要输入', () => {
	const out = turnCandidatesOf([userFromModel('模型对整段对话的转述，长度足够长足够长足够长足够长'), assistant(ASSIST_OK)], {});
	assert.equal(out.length, 0, 'compact-checkpoint 是**模型写的摘要**，不是用户诉求 ⇒ 必须跳过 ✗');
	return 'ok';
});

check('⑥ 超长输入 ⇒ 截断到上限（不把整段对话塞进记忆）', () => {
	const longUser = '这是一个很长的需求描述'.repeat(60);
	const longAssistant = '这是很长的助手回复内容'.repeat(60);
	const out = turnCandidatesOf([user(longUser), assistant(longAssistant)], {});
	assert.equal(out.length, 1);
	assert.ok(out[0].text.length <= DISTILL_MAX_CHARS + 1,
		`应截断到 ${DISTILL_MAX_CHARS}(+省略号)，实际 ${out[0].text.length}`);
	assert.ok(out[0].digest === auditDigestOf(out[0].text), 'digest 必须与最终文本一致（否则去重会失效）');
	return `len=${out[0].text.length}`;
});

const failed = results.filter(r => !r.ok);
for (const r of results) { console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`); }
console.log('');
if (failed.length) { console.error(`✗ 按回合摘要自动沉淀测试失败：${failed.length}/${results.length}`); process.exit(1); }
console.log(`✓ 按回合摘要自动沉淀测试通过（${results.length} 项）`);
