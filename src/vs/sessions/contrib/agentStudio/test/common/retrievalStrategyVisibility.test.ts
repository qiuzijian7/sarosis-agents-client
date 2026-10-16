/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 系统提示词里的**工具指引段**必须随工具可见性联动 —— 这是同一病灶的**第三例**。
 *
 * 前两例（`tool_search` / `tool_describe`）在 2026-10-12 已修（`buildCompactToolSection` 里按
 * `bridgeVisible` 联动，注释写明"用词刻意避开 tool_search，好让守卫能断言"）。但那条守卫
 * **只盯那两个名字** ⇒ 抓不到「## Web Search Strategy」段：它原先**无条件**点名
 * `web_search` / `read_skill` / `execute_code` / `web_extract` ✗。
 *
 * 后果与那两例同构：工具被 focus 模式剪掉、或 agent 配了 `excludedTools` 时，提示词仍在教
 * 模型调一个**没下发 schema 的工具** ⇒ 模型照做 ⇒ 未知工具 / 幻觉（`agentDriverService` 里
 * 记着这条 P0 的实测代价）。
 *
 * 本文件两件事：① 钉住新函数 `buildRetrievalStrategyLines` 的 gate 与**动态重编号**；
 * ② 用一条**整类守卫**把"不可见工具名不得出现在工具段"钉死（覆盖面比先前那条守卫大）。
 */

import assert from 'assert';
import { buildCompactToolSection, buildRetrievalStrategyLines } from '../../common/systemPromptComposer.js';

const ALL = ['web_search', 'web_extract', 'read_skill', 'execute_code'];

suite('检索决策段 · 按工具可见性生成', () => {

	test('工具齐备 ⇒ 5 条规则都在，且编号连续', () => {
		const out = buildRetrievalStrategyLines(ALL).join('\n');
		assert.ok(out.includes('## Web Search Strategy'), out);
		for (const n of [1, 2, 3, 4, 5]) {
			assert.ok(new RegExp(`^${n}\\. `, 'm').test(out), `缺第 ${n} 条：${out}`);
		}
		assert.ok(out.includes('web_search'), out);
		assert.ok(out.includes('anysearch') && out.includes('read_skill') && out.includes('execute_code'), out);
		assert.ok(out.includes('web_extract'), out);
	});

	test('★ 不可见的工具不得被点名，且规则要**重编号**（不许跳号）', () => {
		const out = buildRetrievalStrategyLines(['web_extract']).join('\n');
		assert.ok(!out.includes('web_search'), `没下发 web_search 却仍点名：${out}`);
		assert.ok(!out.includes('anysearch') && !out.includes('read_skill') && !out.includes('execute_code'), out);
		assert.ok(/^1\. \*\*A specific URL is already known\*\*/m.test(out),
			`web_extract 那条应被重编号为第 1 条（gate 掉规则 1 后不能留空号）：${out}`);
		// 少了 web_search ⇒「别从规则 1 跳到规则 2」这句也失去前提（规则 2 都没了 ✗）
		assert.ok(!out.includes('Do not skip rule 1'), out);
	});

	test('anysearch 路径要求 read_skill **与** execute_code 同时可见', () => {
		assert.ok(!buildRetrievalStrategyLines(['read_skill', 'web_search']).join('\n').includes('anysearch'),
			'只有 read_skill、没有 execute_code ⇒ 不能教这条路径（跑不起来）✗');
		assert.ok(buildRetrievalStrategyLines(['read_skill', 'execute_code', 'web_search']).join('\n').includes('anysearch'));
	});

	test('规则 5（切换到另一个工具）只在至少两条路径并存时出现', () => {
		assert.ok(!buildRetrievalStrategyLines(['web_search']).join('\n').includes('Fallback'),
			'只有一条路径时"切换到另一个工具"自相矛盾 ✗');
		assert.ok(buildRetrievalStrategyLines(['web_search', 'web_extract']).join('\n').includes('Fallback'));
		// `read_skill` + `execute_code` 也算一条路径 ⇒ 与 web_search 并存时也应有规则 5
		assert.ok(buildRetrievalStrategyLines(['web_search', 'read_skill', 'execute_code']).join('\n').includes('Fallback'));
	});

	test('一个检索工具都没有 ⇒ 整段不出现（连标题也不出现）', () => {
		assert.deepStrictEqual(buildRetrievalStrategyLines(['file_read', 'terminal']), []);
	});
});

suite('工具段 · 整类守卫（不可见的工具名一律不得出现在提示词里）', () => {

	test('★ 最小工具集下，工具段不得点名任何未下发的工具', () => {
		const text = buildCompactToolSection(['file_read', 'file_write'], 'generic', { bridgeVisible: false });
		for (const name of ['web_search', 'web_extract', 'read_skill', 'execute_code', 'tool_search', 'tool_describe']) {
			assert.ok(!text.includes(name),
				`工具段点名了未下发的 ${name} ✗（模型会照它去调）—— 可见性联动漏了一处：\n${text.slice(0, 400)}`);
		}
	});

	test('桥接可见时仍照常教学（别把联动做成一刀切禁用）', () => {
		const text = buildCompactToolSection(['file_read', 'tool_search', 'web_search'], 'generic', { bridgeVisible: true });
		assert.ok(text.includes('tool_search'), `桥接可见时应保留 tool_search 指引：\n${text.slice(0, 300)}`);
		assert.ok(text.includes('web_search'));
	});
});
