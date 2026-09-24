/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import {
	extractSarosMediaIds,
	replaceSarosMediaRefs,
	SAROS_MEDIA_SCHEME,
} from './mediaRefResolver.js';

const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';

suite('mediaRefResolver — saros-media:// 短引用纯变换（2026-09-25 修「重启后图片消失」✓）', () => {

	suite('extractSarosMediaIds', () => {
		test('无引用 ⇒ 空数组 ✓', () => {
			assert.deepStrictEqual(extractSarosMediaIds(''), []);
			assert.deepStrictEqual(extractSarosMediaIds('已生成 1 张图片'), []);
		});

		test('单个引用 ✓', () => {
			assert.deepStrictEqual(
				extractSarosMediaIds(`图片引用：\n  - ${SAROS_MEDIA_SCHEME}abc123`),
				['abc123'],
			);
		});

		test('多个引用保持首次出现顺序 ✓ + 去重 ✓', () => {
			const text = `${SAROS_MEDIA_SCHEME}id1 ${SAROS_MEDIA_SCHEME}id2 ${SAROS_MEDIA_SCHEME}id1`;
			assert.deepStrictEqual(extractSarosMediaIds(text), ['id1', 'id2'],
				'同一 id 出现两次只取一次 ✓（否则同一资源重复请求后端 ✗）');
		});

		test('id 字符集：字母/数字/下划线/短横线 ✓', () => {
			assert.deepStrictEqual(extractSarosMediaIds(`${SAROS_MEDIA_SCHEME}a_B-9`), ['a_B-9']);
		});
	});

	suite('replaceSarosMediaRefs', () => {
		test('全部命中 ⇒ 全部替换 + resolved 计数 ✓', () => {
			const text = `图1 ${SAROS_MEDIA_SCHEME}a\n图2 ${SAROS_MEDIA_SCHEME}b`;
			const r = replaceSarosMediaRefs(text, new Map([['a', 'data:image/png;base64,AAA'], ['b', 'data:image/png;base64,BBB']]));
			assert.strictEqual(r.resolved, 2);
			assert.ok(r.text.includes('data:image/png;base64,AAA') && r.text.includes('data:image/png;base64,BBB'));
			assert.ok(!r.text.includes(SAROS_MEDIA_SCHEME), '替换后不应残留短引用 ✓');
		});

		test('缺失的 id **保留短引用**（解析失败不丢信息 ✓✓）', () => {
			const text = `${SAROS_MEDIA_SCHEME}ok ${SAROS_MEDIA_SCHEME}missing`;
			const r = replaceSarosMediaRefs(text, new Map([['ok', 'data:image/png;base64,OK']]));
			assert.strictEqual(r.resolved, 1, '只计成功替换的 ✓');
			assert.ok(r.text.includes(`${SAROS_MEDIA_SCHEME}missing`), '失败的 id 必须原样保留 ✓✓');
		});

		test('同一 id 多处出现 ⇒ 全部替换 ✓', () => {
			const text = `${SAROS_MEDIA_SCHEME}x 与 ${SAROS_MEDIA_SCHEME}x`;
			const r = replaceSarosMediaRefs(text, new Map([['x', 'data:X']]));
			assert.strictEqual(r.resolved, 1);
			assert.deepStrictEqual(r.text, 'data:X 与 data:X');
		});

		test('无引用 ⇒ 原文返回 + resolved=0 ✓', () => {
			const r = replaceSarosMediaRefs('纯文本', new Map([['x', 'y']]));
			assert.strictEqual(r.text, '纯文本');
			assert.strictEqual(r.resolved, 0);
		});
	});

	suite('★★ 接线断言（钉"断点已修"的不变量 ✓ 防回退 ✗✓）', () => {
		const src = readFileSync(PANE_REL, 'utf8');

		test('① 历史重载必须解析短引用（重启后图片不消失 ✓✓）', () => {
			assert.ok(src.includes('_resolveMediaRefsInHistory'), '历史解析方法必须存在 ✓');
			// 包装入口的调用点：onOpenSession ✓ 切 agent ✓ 启动 init ✓（≥3 处）
			const wrapperCalls = src.split('this._setMessagesAndResolveMediaRefs(').length - 1;
			assert.ok(wrapperCalls >= 3,
				`setMessages 走历史的路径必须经包装入口（实际 ${wrapperCalls} 处 ✗ —— onOpenSession/切agent/init 三处缺一不可 ✗✓）`);
			// 任务板 reload 路径（setMessages 在两个分支里 ⇒ 直接调解析 ✓）
			assert.ok(src.includes('void this._resolveMediaRefsInHistory(adapted)'),
				'_reloadChatHistory 也必须解析 ✗✓（否则任务板刷新后图片消失 ✗）');
		});

		test('② 迟交兜底也要解析（当轮就显示 ✓）', () => {
			const fnIdx = src.indexOf('private _applyLateToolDelta(');
			assert.ok(fnIdx > 0, '_applyLateToolDelta 必须存在 ✓');
			const body = src.slice(fnIdx, fnIdx + 2000);
			assert.ok(body.includes('_resolveMediaRefsInToolResult'),
				'_applyLateToolDelta 必须对 tool_result 解析短引用 ✗✓（否则跨流补发的图片不显示 ✗）');
		});

		test('③ 解析逻辑必须走纯模块（可单测 ✓ 不内联正则 ✗）', () => {
			assert.ok(src.includes("from './mediaRefResolver.js'"), 'pane 必须引用纯模块 ✓');
			assert.ok(src.includes('extractSarosMediaIds') && src.includes('replaceSarosMediaRefs'),
				'pane 必须用纯函数（否则两处正则各自漂移 ✗✓）');
		});
	});
});
