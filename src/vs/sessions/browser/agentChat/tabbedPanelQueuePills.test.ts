/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * 队列项 pill 的渲染契约（2026-09-18，用户需求「pill 发送到队列中时，队列中也要显示 pill」）。
 *
 * 为什么需要：入队时原来只留 `content` 纯文本 ✗（附件还被压成 `[2 个附件]` ✗）⇒ 用户排完队
 * 看不出这条带了什么 ✓。本测试锁住：① 有 `pills` ⇒ 逐个渲染（图标/名称/meta 齐全 ✓）；
 * ② 无 `pills` ⇒ **不多渲染空容器** ✗；③ 加了"主栏"之后**内容不能丢** ✗（防止改造时把
 * 原来的 `content` span 挤掉 ✓）。
 *
 * 运行（仓库未给 jsdom 运行器，需临时 preload）：
 *   npx mocha "out/vs/sessions/browser/agentChat/tabbedPanelQueuePills.test.js" \
 *     --require ./.tmp-jsdom-preload.cjs --ui=tdd --timeout=30000 --exit
 */
import assert from 'assert';
import { TabbedPanelManager } from './modules/tabbedPanel.js';
import type { IQueueItem } from './agentChatTypes.js';

/** 建一个可渲染的面板（`createDom()` 必须显式调用 ✓，与面板初始化路径一致 ✓）。 */
function createPanel(): { panel: TabbedPanelManager; container: HTMLElement } {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const panel = new TabbedPanelManager({
		container,
		textarea: null,
		isSending: true,   // 队列项只在"发送中"产生 ⇒ 用它更贴近真实状态 ✓
		onSendMessage: () => { /* noop */ },
	});
	panel.createDom();
	return { panel, container };
}

const item = (id: string, over: Partial<IQueueItem> = {}): IQueueItem => ({
	id,
	content: `msg-${id}`,
	timestamp: Date.now(),
	status: 'pending',
	...over,
});

suite('队列项 pill 渲染（2026-09-18）', () => {

	test('★★★ 有 pills ⇒ 逐个渲染（图标 / 名称 / meta 齐全）', () => {
		const { panel, container } = createPanel();
		panel.add(item('q1', {
			pills: [
				{ kind: 'image', label: 'shot.png', meta: '12 KB' },
				{ kind: 'snippet', label: 'code-snippet.txt', meta: '3 行' },
				{ kind: 'skill', label: 'code-review' },
			],
		}));

		const pills = container.querySelectorAll('.tbp-task-pill');
		assert.strictEqual(pills.length, 3, '三个 pill 必须各渲染一个元素');
		// 形态类名（CSS 配色与语义都挂它 ⇒ 丢了就"都一样" ✗）
		assert.ok(container.querySelector('.tbp-task-pill-image'), 'image 形态类名必须存在');
		assert.ok(container.querySelector('.tbp-task-pill-snippet'), 'snippet 形态类名必须存在');
		assert.ok(container.querySelector('.tbp-task-pill-skill'), 'skill 形态类名必须存在');
		// 文本与 meta
		const texts = Array.from(container.querySelectorAll('.tbp-task-pill-label')).map(el => el.textContent);
		assert.deepStrictEqual(texts, ['shot.png', 'code-snippet.txt', 'code-review'], '名称必须原样展示');
		const metas = Array.from(container.querySelectorAll('.tbp-task-pill-meta')).map(el => el.textContent);
		assert.deepStrictEqual(metas, ['12 KB', '3 行'], '有 meta 的才渲染 meta（第三个没有 ✓）');
		// 图标：每个 pill 都必须有（缺图标 = 用户无法一眼分辨形态 ✗）
		for (const chip of Array.from(pills)) {
			assert.ok(chip.querySelector('.tbp-task-pill-icon')?.textContent, '每个 pill 都必须有图标');
		}
	});

	test('★★ 无 pills ⇒ 不渲染空容器（不得凭空多出一行 ✗）', () => {
		const { panel, container } = createPanel();
		panel.add(item('q2'));
		assert.strictEqual(container.querySelectorAll('.tbp-task-pill').length, 0, '无 pill 时不得渲染 pill ✗');
		assert.strictEqual(container.querySelectorAll('.tbp-task-pills').length, 0, '无 pill 时不得留下空的 pills 容器 ✗');
	});

	test('★★★ 加了主栏后内容不能丢（回归保护：content 仍须渲染 ✓）', () => {
		const { panel, container } = createPanel();
		panel.add(item('q3', { content: '带附件的正文', pills: [{ kind: 'file', label: 'a.ts' }] }));
		const contents = Array.from(container.querySelectorAll('.tbp-task-content')).map(el => el.textContent);
		assert.ok(contents.includes('带附件的正文'), `正文必须仍在 DOM 中，实际 = ${JSON.stringify(contents)}`);
		// pills 必须在**同一行项**里（不能串到别的行 ✗）
		const row = container.querySelector('.tbp-task-item') as HTMLElement | null;
		assert.ok(row?.querySelector('.tbp-task-pill'), 'pill 必须挂在对应队列行内');
		assert.ok(row?.querySelector('.tbp-task-pills'), 'pill 容器也必须在该行内');
	});

	test('★★ 纯附件（无文本）⇒ content 允许为空，但 pill 必须仍在（用户要求"能看出带了什么" ✓）', () => {
		const { panel, container } = createPanel();
		panel.add(item('q4', { content: '', pills: [{ kind: 'image', label: 'pasted.png' }] }));
		assert.strictEqual(container.querySelectorAll('.tbp-task-pill').length, 1, '无文本时 pill 必须仍然渲染 ✓');
		const contentEl = container.querySelector('.tbp-task-content');
		assert.strictEqual(contentEl?.textContent, '', 'content 允许为空（pill 已表达清楚 ✓）');
	});
});
