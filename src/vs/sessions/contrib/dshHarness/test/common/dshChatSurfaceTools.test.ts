/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * chat-surface 的 `client.tools.js` —— **不再遮蔽官方 write/edit 工具卡**（用户要求），
 * 只把官方卡的「打开文件」通路（`ctx.sidebarRight.openResource`，右栏在聊天框里被隐藏）
 * 改接到 VsSaros 编辑器（页面桥 `window.vssarosDsh.openFile`）。
 *
 * 两段测法（与 `dshChatSurfaceUsage.test.ts` 同）：① 假 ctx/shell 直接跑 install，验行为与回落；
 * ② 源码级契约断言（不许再出现遮蔽注册；chunk 必须在入口的 PART_CHUNKS 里）。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { join } from '../../../../../base/common/path.js';
import { DSH_CHAT_ONLY_CSS } from '../../common/dshPageBridgeProtocol.js';

const TOOLS_REL = 'dsh-plugins/vssaros-chat-surface/lib/client.tools.js';
const ENTRY_REL = 'dsh-plugins/vssaros-chat-surface/lib/client.js';

/** 读仓库内文件（测试从仓库根跑 ⇒ 路径相对 cwd ✓）。 */
function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 用假 `window.__ModuleLoader__` 取出 chunk 的模块导出（factory 直接返回 `module.exports`）。 */
function loadToolsChunk(): Record<string, any> {
	let definition: any;
	new Function('window', read(TOOLS_REL))({ __ModuleLoader__: { load: (d: any) => { definition = d; } } });
	return definition.factory(() => { throw new Error('client.tools.js 不应 require 任何模块'); });
}

suite('chat-surface 工具卡（官方卡 + 打开通路改接）', () => {
	const chunk = loadToolsChunk();

	suite('file:// URL → 路径', () => {
		const toPath = chunk.__test.fileUrlToPath;

		test('Windows 盘符 / POSIX / UNC 三种形态', () => {
			assert.strictEqual(toPath('file:///C:/a/b.ts'), 'C:/a/b.ts');
			assert.strictEqual(toPath('file:///home/u/a.ts'), '/home/u/a.ts');
			assert.strictEqual(toPath('file://server/share/a.ts'), '//server/share/a.ts');
		});

		test('百分号编码、查询串、片段', () => {
			assert.strictEqual(toPath('file:///C:/a%20b/c.ts'), 'C:/a b/c.ts');
			assert.strictEqual(toPath('file:///C:/a/b.ts?x=1#frag'), 'C:/a/b.ts');
		});

		test('非 file URL / 空 / 非字符串 ⇒ null（调用方回落官方实现）', () => {
			for (const bad of ['https://x/y.ts', 'untitled:x', '', 'file://', undefined, 42, {}]) {
				assert.strictEqual(toPath(bad), null, String(bad));
			}
		});
	});

	suite('★ dsh-resource:// 地址（官方"点文件"的**真实**形态）→ 路径', () => {
		const toPath = chunk.__test.dshResourceUrlToPath;
		const CWD = 'C:/ws/proj';

		test('工作区内：相对路径用会话 cwd 折绝对（官方 fileAddressFor 就是这么编码的）', () => {
			assert.deepStrictEqual(toPath('dsh-resource://file/session/s1/src/a.ts', CWD), { path: 'C:/ws/proj/src/a.ts', line: undefined });
			assert.deepStrictEqual(toPath('dsh-resource://file/session/s1/src/a.ts', 'C:/ws/proj/'), { path: 'C:/ws/proj/src/a.ts', line: undefined }, 'cwd 末尾的斜杠不该拼出双斜杠');
			assert.strictEqual(toPath('dsh-resource://file/session/s1/src/a%20b/c.ts', CWD).path, 'C:/ws/proj/src/a b/c.ts', '百分号编码要解码');
			assert.deepStrictEqual(toPath('dsh-resource://file/session/s1/src/a.ts#L24', CWD), { path: 'C:/ws/proj/src/a.ts', line: 24 }, '#L24 片段要认成行号');
			assert.strictEqual(toPath('dsh-resource://file/session/s1/src/a.ts#L24-L30', CWD).line, 24, '区间取起始行');
		});

		test('工作区外：地址保留绝对路径 ⇒ 原样用（不再拼 cwd）', () => {
			assert.deepStrictEqual(toPath('dsh-resource://file/session/s1/C:/other/x.ts', CWD), { path: 'C:/other/x.ts', line: undefined });
			assert.deepStrictEqual(toPath('dsh-resource://file/session/s1//tmp/x.ts', undefined), { path: '/tmp/x.ts', line: undefined }, 'POSIX 绝对路径 + 没有 cwd 也用');
		});

		test('拿不到 cwd 的相对路径 / 非 session 作用域 / 其它协议 ⇒ null（回落官方，不猜）', () => {
			assert.strictEqual(toPath('dsh-resource://file/session/s1/src/a.ts', undefined), null, '没有 cwd 就不猜工作区（猜错会打开另一个文件）');
			assert.strictEqual(toPath('dsh-resource://file/session/s1/src/a.ts', ''), null);
			assert.strictEqual(toPath('dsh-resource://file/workspace-file/ws1/C:/a.ts', CWD), null, '别的 scope 留给官方预览器');
			assert.strictEqual(toPath('dsh-resource://file/session/s1/', CWD), null, '空路径');
			for (const bad of ['file:///C:/a.ts', 'https://x/a.ts', 'dsh-resource://other/x', '', undefined, 42]) {
				assert.strictEqual(toPath(bad, CWD), null, String(bad));
			}
		});
	});

	suite('install：改接 vs 回落', () => {
		// `options` 必须可选：官方调用点就有不带 options 的形态（`ctx.sidebarRight.openResource(url)`），
		// 我们的替换函数也按可选实现。
		function makeFake(calls: { url: unknown; options?: unknown }[]) {
			const service = { openResource: (url: unknown, options?: unknown) => { calls.push({ url, options }); } };
			return service;
		}

		test('★ dsh-resource:// → 走页面桥（用会话 cwd 折绝对），并记 openFileHits（"路由真的走通"）', async () => {
			// 这是 2026-10-12 修的那条：官方聊天里**所有**"点文件"都给 `dsh-resource://file/session/<sid>/<path>`，
			// 老代码只认 `file://` ⇒ 从不匹配 ⇒ 回落被 chat-only CSS 隐藏的右栏 ⇒ 点了什么都没发生。
			const official: { url: unknown; options?: unknown }[] = [];
			const opened: { path: string; range: any }[] = [];
			const service = makeFake(official);
			const state: Record<string, unknown> = { sessionId: 's1' };
			const sessions = { list: { getSnapshot: () => ({ byId: { s1: { cwd: 'C:/ws/proj' } } }) } };
			chunk.install(
				{ get: (name: string) => (name === 'sidebarRight' ? service : name === 'sessions' ? sessions : undefined) },
				{ state, bridge: { openFile: (path: string, range: any) => { opened.push({ path, range }); } } },
			);

			service.openResource('dsh-resource://file/session/s1/src/a.ts', { params: { line: 7 } });
			assert.deepStrictEqual(opened, [{ path: 'C:/ws/proj/src/a.ts', range: { startLine: 7 } }], '相对路径要折成绝对（桥只收绝对路径）');
			assert.strictEqual(official.length, 0, '已交给 VsSaros ⇒ 不得再走（隐藏的）右栏');
			assert.strictEqual(state.openFileHits, undefined, '计数等桥 resolve 之后再记（不许先谎报）');
			await new Promise(r => setTimeout(r, 0));
			assert.strictEqual(state.openFileHits, 1, '桥成功 ⇒ 计一次：这是"点了真的到了编辑器"的可观测信号');
			assert.strictEqual(state.openFilePath, 'C:/ws/proj/src/a.ts');

			// 没有 cwd（拿不到 sessions 服务）⇒ 相对路径不猜 ⇒ 原样回落官方
			const official2: { url: unknown; options?: unknown }[] = [];
			const service2 = makeFake(official2);
			const state2: Record<string, unknown> = { sessionId: 's1' };
			chunk.install({ get: (n: string) => (n === 'sidebarRight' ? service2 : undefined) }, { state: state2, bridge: { openFile: () => undefined } });
			service2.openResource('dsh-resource://file/session/s1/src/a.ts');
			assert.deepStrictEqual(official2.map(o => o.url), ['dsh-resource://file/session/s1/src/a.ts'], '拿不到 cwd 时回落官方');
		});

		test('file URL → 走页面桥、不再走（隐藏的）右栏；行号透传为 startLine', () => {
			const official: { url: unknown; options: unknown }[] = [];
			const opened: { path: string; range: any }[] = [];
			const service = makeFake(official);
			const state: Record<string, unknown> = {};
			chunk.install(
				{ get: (name: string) => (name === 'sidebarRight' ? service : undefined) },
				{ state, bridge: { openFile: (path: string, range: any) => { opened.push({ path, range }); } } },
			);
			assert.strictEqual(state.openFileRoute, true, '改接应如实标记生效');
			assert.strictEqual(state.fsToolCard, false, '不再自绘工具卡');

			service.openResource('file:///C:/a/b.ts', { params: { line: 12 } });
			assert.deepStrictEqual(opened, [{ path: 'C:/a/b.ts', range: { startLine: 12 } }]);
			assert.strictEqual(official.length, 0, '已交给 VsSaros ⇒ 不得再走右栏');

			service.openResource('file:///C:/a/b.ts');
			assert.strictEqual(opened[1].range, undefined, '无行号时不传 range');
		});

		test('非 file URL / 非法入参 ⇒ 原样回落官方实现（不改变别的行为）', () => {
			const official: { url: unknown; options: unknown }[] = [];
			const service = makeFake(official);
			const state: Record<string, unknown> = {};
			chunk.install(
				{ get: () => service },
				{ state, bridge: { openFile: () => undefined } },
			);
			service.openResource('https://example.com/x.ts');
			service.openResource('file://');
			assert.deepStrictEqual(official.map(o => o.url), ['https://example.com/x.ts', 'file://']);
		});

		test('取不到桥（或取不到服务）⇒ 不改服务、如实记 false', () => {
			const official: unknown[] = [];
			const service = makeFake([]);
			const before = service.openResource;
			const state: Record<string, unknown> = {};
			chunk.install({ get: () => service }, { state, bridge: {} });
			assert.strictEqual(state.openFileRoute, false);
			assert.strictEqual(service.openResource, before, '桥不可用时不得改动服务');

			const state2: Record<string, unknown> = {};
			chunk.install({ get: () => undefined }, { state: state2, bridge: { openFile: () => undefined } });
			assert.strictEqual(state2.openFileRoute, false);
			assert.strictEqual(official.length, 0);
		});

		test('服务对象被冻结 ⇒ 不谎报生效（state 记 false）', () => {
			const service = Object.freeze({ openResource: () => undefined });
			const state: Record<string, unknown> = {};
			chunk.install({ get: () => service }, { state, bridge: { openFile: () => undefined } });
			assert.strictEqual(state.openFileRoute, false);
		});
	});

	suite('契约（源码级）', () => {
		const source = read(TOOLS_REL);
		const entry = read(ENTRY_REL);
		/** 去掉块/行注释 ⇒ 只对**活代码**断言（注释里会刻意保留旧做法作教训）。 */
		const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

		test('★ 必须认官方地址 `dsh-resource://file/`（只认 file:// ⇒ 这条通路整体失效）', () => {
			// 这条守卫是"点了没反应"那类静默失效的网：前缀/计数任一被删，聊天里点文件就又变成"什么都不发生"。
			// ⚠ 注意 `code` 会把 `//` 之后当行注释砍掉，而**地址字面量本身就含 `//`** ⇒ 字面量只能在 `source`
			// 上断言（用 `code` 会永远红，本守卫第一版就栽在这），标识符则用 `code`（防被注释糊弄）。
			assert.ok(source.includes('dsh-resource://file/'),
				'官方文件地址前缀不见了 ⇒ 聊天里的文件链接会再次静默失效（回落被 chat-only CSS 隐藏的右栏）');
			assert.ok(code.includes('DSH_RESOURCE_FILE_PREFIX'),
				'地址前缀常量不见了（只认 file:// 就等于这条通路整体失效）');
			assert.ok(code.includes('openFileHits'),
				'没有"路由真的走通"的计数 ⇒ 只能断言"服务被替换过"，那正是这次假绿的成因');
			assert.ok(code.includes('dshResourceUrlToPath'),
				'地址解析函数不见了 ⇒ 请恢复 `dshResourceUrlToPath`（含 cwd 折绝对与 #L 片段解析）');
		});

		test('★ 不得再注册 tool.call.toolview（= 不再遮蔽官方 write/edit 卡）', () => {
			assert.ok(!code.includes('tool.call.toolview'),
				'本 chunk 不得再用 tool.call.toolview 遮蔽官方工具卡（用户要求直接用官方卡）');
			assert.ok(!code.includes('VssarosFsToolCard') && !code.includes('priority: -10'),
				'自绘工具卡的实现与负优先级注册都应删除');
			assert.ok(code.includes('openResource'), '本 chunk 现在的职责是改接「打开文件」通路');
		});

		test('chunk 仍在入口的 PART_CHUNKS 里（否则改接逻辑根本不生效）', () => {
			assert.ok(entry.includes('./client.tools.js'), 'client.js 的 PART_CHUNKS 必须仍包含本 chunk');
		});

		test('改接的前提仍在：聊天框确实隐藏了右栏（否则改接可由「不隐藏」替代）', () => {
			assert.ok(DSH_CHAT_ONLY_CSS.includes('data-slot="rightbar"'),
				'chat-only CSS 若不再隐藏右栏，请重新评估这条打开通路改接是否还需要');
		});
	});
});
