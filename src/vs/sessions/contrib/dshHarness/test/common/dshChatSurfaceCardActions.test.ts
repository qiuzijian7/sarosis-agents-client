/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * chat-surface 的 `client.cardActions.js` —— 交付卡上的动作与**条目点击接管**。
 *
 * 起因（2026-10-13 用户报障，两条）：
 *  ① 点卡片里的文件条目**没有在编辑器里显示修改对比**：dsh 自己的行点击打开的是它内部的右侧
 *     预览列 ✗，而我们的 chat-only UI 把那列隐藏了 ⇒ 用户端就是"点了没反应"。
 *  ② 「定位」报 `[Saros][revealInExplorer] No explorer view available.`（IDE 侧，见
 *     `src/vs/sessions/contrib/files/browser/revealCommands.contribution.ts`）。
 *
 * 测法（与 `dshChatSurfaceTools.test.ts` 同）：① 假 DOM 直接跑 `__test` 里的纯函数；
 * ② 源码级接线断言（捕获阶段接管 / 放行自家按钮 / 走 `showUncommittedDiff` / 幂等）。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';

const CHUNK_REL = 'dsh-plugins/vssaros-chat-surface/lib/client.cardActions.js';
const REVEAL_REL = 'src/vs/sessions/contrib/files/browser/revealCommands.contribution.ts';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 用假 `window.__ModuleLoader__` 取出 chunk 的模块导出。 */
function loadChunk(): Record<string, any> {
	let definition: any;
	new Function('window', read(CHUNK_REL))({ __ModuleLoader__: { load: (d: any) => { definition = d; } } });
	return definition.factory(() => { throw new Error('client.cardActions.js 不应 require 任何模块'); });
}

/** 一张假卡片：`rows` 是条目（每个条目一个 `button[aria-describedby]` → hidden span 里的路径）。 */
function fakeCard(rows: { id: string; text: string }[]) {
	const described: Record<string, { textContent: string }> = {};
	const buttons = rows.map(r => {
		described[r.id] = { textContent: r.text };
		return {
			getAttribute: (name: string) => (name === 'aria-describedby' ? r.id : null),
			contains: () => false,
		};
	});
	return {
		card: { querySelectorAll: (sel: string) => (/button\[aria-describedby\]/.test(sel) ? buttons : []), hasAttribute: () => false, setAttribute: () => undefined, addEventListener: () => undefined },
		buttons,
		setDocument: () => { (globalThis as any).document = { getElementById: (id: string) => described[id] ?? null }; },
	};
}

suite('chat-surface 卡片动作（条目点击 → 看改动）', () => {
	const chunk = loadChunk();
	const src = read(CHUNK_REL);

	suite('pathOfRow：只认"被点的那一行"', () => {
		test('点中某一行（或其内部元素）⇒ 返回该行的绝对路径', () => {
			const f = fakeCard([
				{ id: 'a', text: 'G:\\ws\\a.js' },
				{ id: 'b', text: 'G:\\ws\\b.js' },
			]);
			f.setDocument();
			assert.strictEqual(chunk.__test.pathOfRow(f.card, f.buttons[1]), 'G:\\ws\\b.js');
			// 行内深层元素（span 之类）也要认：contains(target) 为真即视为命中该行
			const inside = { nodeType: 1 };
			(f.buttons[0] as any).contains = (t: unknown) => t === inside;
			assert.strictEqual(chunk.__test.pathOfRow(f.card, inside), 'G:\\ws\\a.js');
		});

		test('★ 不回落"第一个文件"：点卡片头部/展开按钮 ⇒ 空串（否则点哪都开第 1 个文件的 diff ✗）', () => {
			const f = fakeCard([
				{ id: 'a', text: 'G:\\ws\\a.js' },
				{ id: 'b', text: 'G:\\ws\\b.js' },
			]);
			f.setDocument();
			assert.strictEqual(chunk.__test.pathOfRow(f.card, { nodeType: 1 }), '');
			assert.strictEqual(chunk.__test.pathOfRow(f.card, undefined), '');
		});

		test('描述文本不是绝对路径 / 取不到 ⇒ 空串（调用方据此放行事件）', () => {
			const f = fakeCard([
				{ id: 'a', text: 'src/rel/a.js' },
				{ id: 'b', text: '' },
			]);
			f.setDocument();
			assert.strictEqual(chunk.__test.pathOfRow(f.card, f.buttons[0]), '');
			assert.strictEqual(chunk.__test.pathOfRow(f.card, f.buttons[1]), '');
			// 绝对路径的三种形态都认（Windows 盘符 / UNC / POSIX）
			const g = fakeCard([
				{ id: 'w', text: 'C:\\ws\\w.js' },
				{ id: 'u', text: '\\\\server\\share\\u.js' },
				{ id: 'p', text: '/home/u/p.js' },
			]);
			g.setDocument();
			for (const id of [0, 1, 2]) {
				assert.ok(chunk.__test.pathOfRow(g.card, g.buttons[id]), String(id));
			}
		});
	});

	suite('接线守卫（源码级）', () => {
		test('★ 条目点击在**捕获阶段**接管，并放行我们自己的按钮', () => {
			assert.match(src, /addEventListener\("click", \(e\) => \{[\s\S]{0,400}?\}, true\)/,
				'必须在捕获阶段接管（dsh 自己的行监听在目标阶段；晚一步就抢不到）');
			assert.match(src, /t\.closest\("\[" \+ ACTION_ATTR \+ "\]"\)/,
				'必须放行自家按钮 —— 捕获阶段先于目标自身的监听器，不排除会把「定位」也改道成"打开 diff" ✗✗');
			assert.match(src, /bridge\.showUncommittedDiff\(rowPath\)/,
				'条目点击必须复用「看改动」那条通道（宿主转扩展命令做 HEAD ↔ 工作区 diff，失败回退打开文件）');
			assert.match(src, /data-vssaros-card-row-wired/,
				'接线必须幂等（MutationObserver 每次流式增量都会重跑 decorate）');
		});

		test('★ 「定位」在会话窗口里要有第三级回退（不许只剩一句 warn）', () => {
			const reveal = read(REVEAL_REL);
			assert.match(reveal, /showItemInFolder\(localPath\)/,
				'两个 in-app 视图都拿不到时必须回退到系统文件管理器（用户报的正是"点了没反应"）');
			// ⚠ 用 lastIndexOf：这处修复的**注释里也引用了那句 warn 文案**（L120），
			// 用 indexOf 会指向注释 ⇒ 断言假失败（实测踩过一次；与"注释里别写会被扫描的字符序列"同源）。
			assert.ok(reveal.indexOf('showItemInFolder(localPath)') < reveal.lastIndexOf('No explorer view available'),
				'回退必须发生在最后那句 warn **之前**（顺序反了就等于没加）');
		});
	});
});
