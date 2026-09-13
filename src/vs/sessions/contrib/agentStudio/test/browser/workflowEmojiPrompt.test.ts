/*---------------------------------------------------------------------------------------------
 *  Unit tests for buildAnimatedEmojiVideoPrompt —— 动态表情包「单格视频」提示词组装。
 *
 *  背景（2026-09-12 用户需求「视频中，不要有半透明效果」）：
 *   绿幕合成 `C = a·F + (1−a)·B` 是**一个方程两个未知数** —— 半透明元素叠在绿幕上时
 *   抠像数学上欠定（经典 keyer 直接删掉 ✗；反混合只能勉强恢复且低 alpha 区放大压缩
 *   噪声 ✗；GIF 1-bit alpha 更表达不了 ✗）⇒ 必须在**生成源头**要求模型画成实心 ✓。
 *
 *  本测试锁死三件事（防止后缀口径漂移）：
 *   1. 不透明约束**恒存在**（与 chroma 开关无关）；
 *   2. 绿幕约束**仅**在开抠像时追加；
 *   3. 动作描述为空时不出现前导逗号（「， solid pure…」✗）。
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { buildAnimatedEmojiVideoPrompt, ANIMATED_EMOJI_OPAQUE_SUFFIX, ANIMATED_EMOJI_GREEN_SUFFIX } from '../../webview/src/features/workflowEditor/comfyHost/chromaCompose.js';

suite('buildAnimatedEmojiVideoPrompt（动态表情包视频提示词）', () => {

	test('★ 不透明约束恒追加（开抠像）', () => {
		const p = buildAnimatedEmojiVideoPrompt('wave hand', '', true);
		assert.ok(p.includes(ANIMATED_EMOJI_OPAQUE_SUFFIX), '缺少不透明约束后缀');
		assert.ok(p.includes('fully opaque'), '应含「fully opaque」正面肯定句');
		assert.ok(p.includes('no semi-transparent'), '应显式排除半透明');
	});

	test('★ 不透明约束恒追加（关抠像 —— 1-bit GIF 同样表达不了半透明）', () => {
		const p = buildAnimatedEmojiVideoPrompt('wave hand', '', false);
		assert.ok(p.includes(ANIMATED_EMOJI_OPAQUE_SUFFIX));
		assert.ok(!p.includes(ANIMATED_EMOJI_GREEN_SUFFIX), '关抠像不应追加绿幕约束');
	});

	test('绿幕约束仅在开抠像时追加', () => {
		assert.ok(buildAnimatedEmojiVideoPrompt('a', '', true).includes(ANIMATED_EMOJI_GREEN_SUFFIX));
		assert.ok(!buildAnimatedEmojiVideoPrompt('a', '', false).includes('pure green background'));
	});

	test('★ 顺序：全局动作 → 该格动作 → 不透明 → 绿幕', () => {
		const p = buildAnimatedEmojiVideoPrompt('global act', 'cell act', true);
		const iRaw = p.indexOf('global act');
		const iCell = p.indexOf('cell act');
		const iOpaque = p.indexOf(ANIMATED_EMOJI_OPAQUE_SUFFIX);
		const iGreen = p.indexOf(ANIMATED_EMOJI_GREEN_SUFFIX);
		assert.ok(iRaw >= 0 && iCell > iRaw, '该格动作应排在全局动作之后');
		assert.ok(iOpaque > iCell, '不透明约束应在动作描述之后（覆盖用户写的发光/透明效果）');
		assert.ok(iGreen > iOpaque, '绿幕约束应在不透明约束之后');
	});

	test('动作描述为空：不出现前导逗号', () => {
		const p = buildAnimatedEmojiVideoPrompt('', '', true);
		assert.ok(!p.startsWith(','), `不应以逗号开头：${p.slice(0, 24)}`);
		assert.ok(!p.startsWith(' '));
		assert.ok(p.startsWith('the character and every element'), '应直接以后缀正文开头');
	});

	test('空白动作描述按空处理（trim）', () => {
		const p = buildAnimatedEmojiVideoPrompt('   ', '  \n ', false);
		assert.ok(!p.startsWith(','));
		// 无动作描述时返回的是**去掉前导 ', '** 的后缀正文，故用正文片段断言。
		assert.ok(p.startsWith('the character'), `实际：${p.slice(0, 24)}`);
		assert.ok(p.includes('fully opaque'));
	});

	test('只有该格动作时也正确拼接', () => {
		const p = buildAnimatedEmojiVideoPrompt('', 'blink', true);
		assert.ok(p.startsWith('blink, the character'), `实际：${p.slice(0, 30)}`);
	});
});
