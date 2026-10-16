/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Saros. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * chat-surface header 的三项增强 + 方案 B 布局定稿（2026-10-11 UI 对比评审）：
 *   ① `client.workspace.js` —— 工作区 chip（补齐原生侧有、dsh 侧没有的信息缺口）；
 *   ② `client.sessions.js`  —— 新建会话 / 历史会话提到 header（原先只藏在 ⚙ 菜单）；
 *   ③ `client.preset.js`    —— **放开**官方只读 preset label（`header.actions` / id=agent-preset）：
 *                             头部要显示"当前会话跑的是哪个 preset"的标签（2026-10-11 需求反转）；
 *                             我们自己那枚 header 切换 chip 仍是移除状态（切换入口在 hero）。
 *   ④ `client.skin.js`      —— 隐藏 dsh 头部的会话文本（面包屑 nav）；
 *   ⑤ 布局（方案 B）        —— **上下文在左**（工作区 chip 占 actions）/ **动作在右**（＋/🕘/⚙ 占 utilities）。
 * 外加页面桥新命令（`openSession` / `newChat` / `openAgentMarket` / `openAgentRoster`）的校验与 preload 面。
 *
 * 测法同 `dshChatSurfaceUsage.test.ts`：假 react 树真渲染 + 假 ctx 捕获注册，再叠源码级契约。
 */

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import { pathToFileURL } from 'node:url';
import { join } from '../../../../../base/common/path.js';
import { validatePageCommand } from '../../common/dshPageBridgeProtocol.js';

const LIB = 'dsh-plugins/vssaros-chat-surface/lib';
const ENTRY_REL = `${LIB}/client.js`;
const PRELOAD_REL = 'src/vs/sessions/contrib/dshHarness/electron-browser/preload-dshView.ts';

function read(rel: string): string {
	const abs = join(process.cwd(), rel);
	assert.ok(existsSync(abs), `源码不存在（路径基准变了？）：${abs}`);
	return readFileSync(abs, 'utf8');
}

/** 迷你 createElement：函数组件直接调用（= React 行为），否则记成普通对象。 */
function makeElement(type: unknown, props: unknown, ...children: unknown[]): any {
	const next = { ...(props ?? {}), children } as Record<string, unknown>;
	return typeof type === 'function' ? (type as (p: unknown) => unknown)(next) : { type, props: props ?? {}, children };
}

/** 页面里 `document` 恒存在（下拉注册全局监听要用）；Node 里给最小替身。 */
(globalThis as { document?: unknown }).document = (globalThis as { document?: unknown }).document ?? {
	addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => undefined,
};

/**
 * 假 react：hook 按调用序存值（`cursor` 每次渲染归零、`hooks` 跨渲染保留 ⇒ 可驱动开合状态）。
 * `useEffect` **立即执行一次**（= React 挂载后跑 effect）：历史菜单的行就是在 effect 里按 open 态读取的，
 * 不跑 effect 就永远看不到菜单内容。清理函数这里不调用（每个用例都是独立实例）。
 */
function makeReact(store: { hooks: unknown[]; cursor: number; dirty: boolean }): Record<string, any> {
	return {
		Fragment: 'Fragment',
		createElement: makeElement,
		useRef: () => ({ current: null }),
		useEffect: (fn: () => unknown) => {
			store.cursor++;
			try { fn(); } catch { /* 环境缺失（如无 document）时忽略，与真实 React 的报错无关 */ }
		},
		useState: (init: unknown) => {
			const at = store.cursor++;
			if (store.hooks.length <= at) {
				store.hooks[at] = typeof init === 'function' ? (init as () => unknown)() : init;
			}
			return [store.hooks[at], (next: unknown) => {
				store.hooks[at] = typeof next === 'function' ? (next as (p: unknown) => unknown)(store.hooks[at]) : next;
				store.dirty = true;
			}];
		},
	};
}

/** 装载 chunk 并**真的执行 install()**，返回导出、被注册的组件与每次注册的 spec。 */
function loadChunk(rel: string, ctx: Record<string, any>, state: Record<string, unknown>) {
	let definition: any;
	new Function('window', read(rel))({ __ModuleLoader__: { load: (d: any) => { definition = d; } } });
	const store = { hooks: [] as unknown[], cursor: 0, dirty: false };
	const react = makeReact(store);
	const mod: Record<string, any> = definition.factory((id: string) => {
		if (id === 'react') { return react; }
		throw new Error(`unexpected require: ${id}`);
	});
	const registrations: { slot: string; spec: any; component: any }[] = [];
	let currentSlot = '';
	const fullCtx = {
		...ctx,
		slots: {
			inject: (slot: string, factory: () => unknown) => { currentSlot = slot; factory(); },
			register: (spec: any, component: any) => { registrations.push({ slot: currentSlot, spec, component }); return () => undefined; },
		},
	};
	mod.install(fullCtx, { state, bridge: ctx.__bridge, ...(ctx.__shell || {}) });
	/**
	 * 渲染 + **flush**：effect 里 setState 时重渲染（最多 3 轮）——
	 * 历史菜单的行就是"打开后 effect 读快照 → setState"这条链，不 flush 就只看到空菜单。
	 */
	const render = (slotIndex: number, props: Record<string, unknown> = {}) => {
		let tree: unknown = null;
		for (let pass = 0; pass < 3; pass++) {
			store.cursor = 0;
			store.dirty = false;
			tree = registrations[slotIndex].component({ useDisclosure: undefined, ...props });
			if (!store.dirty) { break; }
		}
		return tree;
	};
	// ⚠ factory 直接返回 `module.exports`（不是 `{ exports }` 包装）。
	return { exports: mod, registrations, render };
}

/**
 * 装载入口 chunk（`client.js`）拿它的导出 —— 它不 require 任何模块（`fitMenuSize` /
 * `createMenuCoordinator` 是 factory 作用域的纯函数，挂在 `exports.__test` 上）。
 */
function loadEntryExports(): Record<string, any> {
	let definition: any;
	new Function('window', read(ENTRY_REL))({ __ModuleLoader__: { load: (d: any) => { definition = d; } } });
	return definition.factory(() => { throw new Error('client.js 不应 require 任何模块'); });
}

/** 从假 react 树里按 `data-*` 属性找节点。 */
function findByAttr(node: any, attr: string, value?: string): any {
	if (!node || typeof node !== 'object') { return null; }
	const props = node.props || {};
	if (props[attr] !== undefined && (value === undefined || String(props[attr]) === value)) { return node; }
	for (const child of node.children ?? []) {
		const hit = findByAttr(child, attr, value);
		if (hit) { return hit; }
	}
	return null;
}
/** 收集树里所有含指定 `data-*` 的节点。 */
function findAll(node: any, attr: string, out: any[] = []): any[] {
	if (!node || typeof node !== 'object') { return out; }
	if ((node.props || {})[attr] !== undefined) { out.push(node); }
	for (const child of node.children ?? []) { findAll(child, attr, out); }
	return out;
}

const WS = {
	items: [
		{ workspaceId: 'ws-1', path: 'g:\\SarosWorkspace\\sarosis-agents-client', title: 'sarosis-agents-client', sessionIds: ['s-a'] },
		{ workspaceId: 'ws-2', path: '/home/u/other-repo', title: 'other-repo', sessionIds: ['s-b'] },
	],
};
const SESSIONS = {
	byId: {
		's-a': { title: '会话 A', projectionValues: { agentPreset: 'standard' }, updatedAt: 300 },
		's-b': { title: '会话 B', projectionValues: { agentPreset: 'ptc' }, updatedAt: 100 },
		's-c': { title: '', updatedAt: 250 },
	},
	archivedSessionIds: ['s-b'],
};

suite('chat-surface header（①工作区 ②历史/新建 ③preset 去重）', () => {

	suite('① client.workspace.js 纯逻辑', () => {
		const t = loadChunk(`${LIB}/client.workspace.js`, {}, {}).exports.__test;

		test('baseName：posix / windows / 尾斜杠 / 非法输入', () => {
			assert.strictEqual(t.baseName('/home/u/repo'), 'repo');
			assert.strictEqual(t.baseName('g:\\SarosWorkspace\\sarosis-agents-client'), 'sarosis-agents-client');
			assert.strictEqual(t.baseName('/home/u/repo///'), 'repo');
			assert.strictEqual(t.baseName(''), null);
			assert.strictEqual(t.baseName(42), null);
		});

		test('workspaceIdOfSession：按 sessionIds 归属（与 alignWorkspace 同判据）', () => {
			assert.strictEqual(t.workspaceIdOfSession(WS, 's-a'), 'ws-1');
			assert.strictEqual(t.workspaceIdOfSession(WS, 's-b'), 'ws-2');
			assert.strictEqual(t.workspaceIdOfSession(WS, 'nope'), null);
			assert.strictEqual(t.workspaceIdOfSession(null, 's-a'), null);
		});

		test('workspaceLabel：title → 路径末段 → workspaceId（不猜别的）', () => {
			assert.strictEqual(t.workspaceLabel({ workspaceId: 'w', path: '/a/b', title: 'B 仓' }), 'B 仓');
			assert.strictEqual(t.workspaceLabel({ workspaceId: 'w', path: '/a/b', title: '   ' }), 'b');
			assert.strictEqual(t.workspaceLabel({ workspaceId: 'w', path: '' }), 'w');
			assert.strictEqual(t.workspaceLabel(null), null);
		});
	});

	suite('① 工作区 chip（渲染 + 切换）', () => {
		/**
		 * 两个记录器：`sent` = **经宿主**的切换（`bridge.switchWorktree(path)` ✓）；`pageSwitched` =
		 * 页面自己切（`ctx.uiWorkspace.openWorkspace(id)` ✗ —— 2026-10-14 起**不该有人调**，见下面那条）。
		 */
		function makeCtx(sent: string[], pageSwitched: string[], snapshot: unknown) {
			return {
				get: (name: string) => (name === 'workspaces' ? { list: { getSnapshot: () => snapshot, subscribe: () => () => undefined } } : undefined),
				uiWorkspace: { openWorkspace: (id: string) => { pageSwitched.push(id); return Promise.resolve(); } },
				__bridge: { switchWorktree: (path: string) => { sent.push(path); return Promise.resolve(); } },
			};
		}

		test('显示当前会话所属工作区；点另一个 → **经宿主** `bridge.switchWorktree(path)`（不页面自己切 ✗）', () => {
			const sent: string[] = [];
			const pageSwitched: string[] = [];
			const h = loadChunk(`${LIB}/client.workspace.js`, makeCtx(sent, pageSwitched, WS), {});
			// ★ 2026-10-15：工作区 + worktree 两枚 chip **已合并**为单枚入口
			//   （方案 C：单 chip + 扁平可搜索面板；mockup `doc/dsh-workspace-worktree-merge-mockup.html`）
			//   ⇒ 本槽现在只有**一条**注册（id `vssaros-context-entry`、order -27；两条数据源各自判据不变 ✓）。
			assert.deepStrictEqual(h.registrations.map(r => r.slot),
				['conversation.session.header.actions'],
				'合并后只剩一条注册（同一槽、单入口 ✓；旧的两条各自会渲染一枚 chip ✗）');
			assert.strictEqual(h.registrations.length, 1);
			const chip = h.render(0, { sessionId: 's-a' });
			const btn = findByAttr(chip, 'data-vssaros-context-chip');
			assert.ok(btn, '必须渲染合并入口');
			assert.ok(JSON.stringify(btn.children).includes('sarosis-agents-client'), 'chip 文案 = 当前工作区 title');
			// 点开面板 → 另一条工作区（行 key = `workspace:<workspaceId>` ✓，与 worktree 行同槽不同前缀 ✓）
			btn.props.onClick();
			const menu = h.render(0, { sessionId: 's-a' });
			const items = findAll(menu, 'data-vssaros-context-item')
				.filter((i: any) => String(i.props['data-vssaros-context-item']).indexOf('workspace:') === 0);
			assert.strictEqual(items.length, 2, '面板应列出全部工作区');
			items.find((i: any) => i.props['data-vssaros-context-item'] === 'workspace:ws-2').props.onClick();
			// ★ 2026-10-14 修：原来这里钉的是 `openWorkspace('ws-2')` —— 那正是**分叉**写法 ✗
			//   （页面换了选择、宿主 `slot.sessionId` 仍指着旧会话 ⇒ rename 推送 / preset 映射全错）。
			//   现在与 worktree 下拉**共用** `switchWorktree(path)`：宿主会在目标目录 `session.start`
			//   一个会话再 rebind 回来，两边一致 ✓。传的是**目录**（不是 workspaceId）。
			assert.deepStrictEqual(sent, ['/home/u/other-repo'],
				'必须经宿主切（宿主按 path 起/接管该目录的会话 → rebind 回推 ✓）');
			assert.deepStrictEqual(pageSwitched, [],
				'页面**不许**自己调 uiWorkspace.openWorkspace —— 那只会换页面选择，宿主仍绑着旧会话 ✗');
		});

		test('读不到任何工作区 ⇒ 不渲染（不显示假名字）', () => {
			const h = loadChunk(`${LIB}/client.workspace.js`, makeCtx([], [], { items: [] }), {});
			assert.strictEqual(h.render(0, { sessionId: 's-a' }), null);
		});
	});

	suite('① worktree chip（宿主推送 + 切换 worktree，方案 C）', () => {
		const PUSH = JSON.stringify([
			{ path: 'G:\\Repo', name: 'main', branch: 'main', isMain: true },
			{ path: 'G:\\Repo-wt\\feature-auth', name: 'feature-auth', branch: 'worktree/feature-auth', isMain: false },
		]);
		/** 最小 document 桩：chunk 在 Node 里没有 DOM（推送走 dataset + DOM 事件）。 */
		const withDocument = (pushed: string | undefined, run: () => void) => {
			const listeners = new Map<string, ((ev: any) => void)[]>();
			const doc: any = {
				documentElement: { dataset: pushed === undefined ? {} : { vssarosWorktrees: pushed } },
				addEventListener: (name: string, fn: any) => { listeners.set(name, [...(listeners.get(name) ?? []), fn]); },
				removeEventListener: (name: string, fn: any) => { listeners.set(name, (listeners.get(name) ?? []).filter(f => f !== fn)); },
			};
			const prev = (globalThis as any).document;
			(globalThis as any).document = doc;
			try { run(); } finally { (globalThis as any).document = prev; }
		};
		/** ctx：workspaces（空，避免工作区 chip 干涉）+ sessions（给 cwd）+ 页面桥的 switchWorktree。 */
		const makeCtx = (switches: string[], cwd: string | null) => ({
			get: (name: string) => {
				if (name === 'workspaces') { return { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => undefined } }; }
				if (name === 'sessions') { return { list: { getSnapshot: () => ({ byId: { 's-a': { cwd } } }), subscribe: () => () => undefined } }; }
				return undefined;
			},
			uiWorkspace: { openWorkspace: () => Promise.resolve() },
			__bridge: { switchWorktree: (path: string) => { switches.push(path); return Promise.resolve(); } },
		});

		test('纯逻辑：解析 / 路径比较 / 命名（与宿主同口径）', () => {
			const t = loadChunk(`${LIB}/client.workspace.js`, {}, {}).exports.__test;
			assert.strictEqual(t.parseWorktrees(PUSH).length, 2);
			assert.deepStrictEqual(t.parseWorktrees('not json'), [], '坏 JSON ⇒ 空（不猜）');
			assert.deepStrictEqual(t.parseWorktrees(JSON.stringify([{ nope: 1 }])), [], '缺 path 的条目丢掉');
			assert.deepStrictEqual(t.parseWorktrees(''), []);
			assert.ok(t.samePath('g:\\Repo\\', 'G:/Repo'), '分隔符 / 尾斜杠 / 大小写都不敏感');
			assert.ok(!t.samePath('G:\\Repo', 'G:\\Repo-wt'), '前缀相同不算同一目录');
			assert.strictEqual(t.worktreeLabel({ path: 'x', isMain: true }), '主工作区');
			assert.strictEqual(t.worktreeLabel({ path: '/a/b/feature-auth', name: 'feature-auth' }), 'feature-auth');
			assert.strictEqual(t.worktreeLabel(null), null);
		});

		test('渲染：chip 显示当前 worktree；菜单列出全部 + 如实说明"会新建会话"；选另一项 → switchWorktree(path)', () => {
			withDocument(PUSH, () => {
				const switches: string[] = [];
				const h = loadChunk(`${LIB}/client.workspace.js`, makeCtx(switches, 'G:\\Repo-wt\\feature-auth'), {});
				// ★ 合并后只有一条注册 ⇒ 一切都从 render(0) 拿（旧版的 render(1) = worktree chip 已不存在 ✓）。
				// 本用例的 ctx **没有工作区** ⇒ chip 文案应回落到当前 worktree 名（合并入口的回落口径 ✓）。
				const chip = h.render(0, { sessionId: 's-a' });
				const btn = findByAttr(chip, 'data-vssaros-context-chip');
				assert.ok(btn, '必须渲染合并入口');
				assert.ok(JSON.stringify(btn.children).includes('feature-auth'),
					'chip 文案 = 当前 worktree 名（读当前会话的 cwd；无工作区时回落到它 ✓）');
				btn.props.onClick();
				const menu = h.render(0, { sessionId: 's-a' }) as any;   // render 返回 unknown（假树），断言用 any 取 children
				const items = findAll(menu, 'data-vssaros-context-item')
					.filter((i: any) => String(i.props['data-vssaros-context-item']).indexOf('worktree:') === 0);
				assert.strictEqual(items.length, 2, '面板列出全部 worktree（与工作区组同槽、靠前缀区分 ✓）');
				assert.ok(JSON.stringify(menu.children).includes('新建会话'),
					'语义必须写在脸上：切换 worktree = 新建会话（历史独立）');
				items.find((i: any) => i.props['data-vssaros-context-item'] === 'worktree:G:\\Repo').props.onClick();
				assert.deepStrictEqual(switches, ['G:\\Repo'], '选主工作区 ⇒ bridge.switchWorktree(主目录)');
			});
		});

		test('没有推送（dataset 空）+ 没有工作区 ⇒ 不渲染，不显示假名字', () => {
			withDocument(undefined, () => {
				const h = loadChunk(`${LIB}/client.workspace.js`, makeCtx([], 'G:\\Repo'), {});
				// 合并口径：**两组长都空**才整体不渲染 ✓（任一有数据都要出入口 ✓）
				assert.strictEqual(h.render(0, { sessionId: 's-a' }), null);
			});
		});
	});

	suite('② client.sessions.js 纯逻辑', () => {
		const t = loadChunk(`${LIB}/client.sessions.js`, {}, {}).exports.__test;

		test('sessionRows：时间倒序、当前项标记、归档标记、limit', () => {
			const rows = t.sessionRows(SESSIONS, 's-a', 10);
			assert.deepStrictEqual(rows.map((r: any) => r.id), ['s-a', 's-c', 's-b']);
			assert.strictEqual(rows[0].isCurrent, true);
			assert.strictEqual(rows[0].preset, 'standard');
			assert.strictEqual(rows[2].archived, true);
			assert.strictEqual(rows[1].title, null, '空标题保持 null（由渲染层回落 id）');
			assert.strictEqual(t.sessionRows(SESSIONS, 's-a', 2).length, 2);
		});

		test('全都没有时间戳时保留快照键序（不强加假顺序）', () => {
			const snapshot = { byId: { z: {}, a: {}, m: {} } };
			assert.deepStrictEqual(t.sessionRows(snapshot, null, 10).map((r: any) => r.id), ['z', 'a', 'm']);
		});

		test('workspaceIdOfSession（本 chunk 内的副本，用于"新建会话落在当前工作区"）', () => {
			assert.strictEqual(t.workspaceIdOfSession(WS, 's-b'), 'ws-2');
		});
	});

	suite('② 新建 / 历史（渲染 + 两条通路都经宿主）', () => {
		function makeCtx(calls: string[], bridge: Record<string, unknown>) {
			return {
				__bridge: bridge,
				sessions: { list: { getSnapshot: () => SESSIONS } },
				get: (name: string) => (name === 'workspaces' ? { list: { getSnapshot: () => WS } } : undefined),
				uiWorkspace: { openWorkspace: () => Promise.resolve() },
				__calls: calls,
			};
		}

		test('＋ → bridge.newChat()（宿主开新对话页签）', () => {
			const calls: string[] = [];
			const h = loadChunk(`${LIB}/client.sessions.js`, makeCtx(calls, {
				newChat: () => { calls.push('newChat'); return Promise.resolve(); },
			}), {});
			// 方案 B：＋/🕘 属于"动作" ⇒ 与 ⚙ 同占**右侧** utilities 槽。
			assert.deepStrictEqual(h.registrations.map(r => r.slot), ['conversation.session.header.utilities']);
			const tree = h.render(0, { sessionId: 's-a' });
			findByAttr(tree, 'data-vssaros-new-chat').props.onClick();
			assert.deepStrictEqual(calls, ['newChat']);
		});

		test('🕘 → 列出会话，点非当前项 → bridge.openSession(id, preset)', () => {
			const calls: string[] = [];
			const h = loadChunk(`${LIB}/client.sessions.js`, makeCtx(calls, {
				openSession: (id: string, preset?: string) => { calls.push(`open:${id}:${preset}`); return Promise.resolve(); },
				newChat: () => Promise.resolve(),
			}), {});
			findByAttr(h.render(0, { sessionId: 's-a' }), 'data-vssaros-history-chip').props.onClick();
			const rows = findAll(h.render(0, { sessionId: 's-a' }), 'data-vssaros-session-item');
			assert.strictEqual(rows.length, 3);
			rows.find((r: any) => r.props['data-vssaros-session-item'] === 's-c').props.onClick();
			assert.deepStrictEqual(calls, ['open:s-c:undefined']);
		});

		test('点"当前会话"不发请求（幂等，避免无谓 rebind）', () => {
			const calls: string[] = [];
			const h = loadChunk(`${LIB}/client.sessions.js`, makeCtx(calls, {
				openSession: (id: string) => { calls.push(id); return Promise.resolve(); },
				newChat: () => Promise.resolve(),
			}), {});
			findByAttr(h.render(0, { sessionId: 's-a' }), 'data-vssaros-history-chip').props.onClick();
			const rows = findAll(h.render(0, { sessionId: 's-a' }), 'data-vssaros-session-item');
			rows.find((r: any) => r.props['data-vssaros-session-item'] === 's-a').props.onClick();
			assert.deepStrictEqual(calls, []);
		});

		test('旧桥（没有 newChat/openSession）⇒ 只记提示，不抛', () => {
			const state: Record<string, unknown> = {};
			const h = loadChunk(`${LIB}/client.sessions.js`, makeCtx([], {}), state);
			const tree = h.render(0, { sessionId: 's-a' });
			findByAttr(tree, 'data-vssaros-new-chat').props.onClick();  // 老桥
			findByAttr(tree, 'data-vssaros-history-chip').props.onClick();
			const rows = findAll(h.render(0, { sessionId: 's-a' }), 'data-vssaros-session-item');
			rows[1].props.onClick();
			assert.strictEqual(state.newChats, undefined);
			assert.strictEqual(state.sessionOpens, undefined);
		});
	});

	suite('③ 官方 preset 标签：头部显示（不再遮蔽）；header 里仍无我们的切换 chip', () => {
		test('★ 不遮蔽官方 label（头部要显示当前 preset 标签），hero 那枚 chip 仍在', () => {
			// 2026-10-11 需求反转：先前遮蔽官方只读 label（"头部别冒出 standard 文本"），
			// 现在要求"选不同 preset 时头部显示对应标签" ⇒ 放开官方那枚，不自绘。
			// 官方实现：`dsh-client-ui-agent-preset/lib/client.js:355-375` 的 `AgentPresetLabel` 读会话投影
			// `projectionValues.agentPreset`（无值渲染 null），名称取花名册的 name ⇒ 切换 preset 自动跟着变 ✓。
			// ⚠ 谁要是把 `id: "agent-preset"` + `priority: -1` 的遮蔽项加回来，头部就再没有 preset 标签了 ✗。
			const ctx = { remote: { agentPresets: { list: () => Promise.resolve({ ok: true, value: { presets: [] } }) } } };
			const h = loadChunk(`${LIB}/client.preset.js`, ctx, {});
			assert.strictEqual(h.registrations.some(r => r.spec.id === 'agent-preset'), false,
				'不得再注册 id=agent-preset 的遮蔽项（那会把官方标签一起藏掉 ⇒ 头部没有 preset 标签）');
			assert.strictEqual(h.registrations.some(r => r.slot === 'conversation.session.header.actions'), false,
				'header 的 actions 槽里不该有我们的注册（头部那枚标签交给官方）');
			assert.strictEqual(h.registrations.some(r => r.spec.id === 'vssaros-preset-chip'), false,
				'方案 B：header 里不得有 preset 切换 chip（切换入口在 hero）');
			const hero = h.registrations.find(r => r.spec.id === 'vssaros-preset-chip-hero');
			assert.ok(hero, 'hero 区那枚必须保留（空白会话屏的唯一切换入口）');
			assert.strictEqual(hero.slot, 'conversation.hero.agentPreset');
		});
	});

	suite('⑤ header 布局（方案 B）：上下文左 / 动作右', () => {
		test('槽位与顺序契约：合并入口→actions(-27)；＋/🕘→utilities(-3)；⚙→utilities(-2)', () => {
			const ws = read(`${LIB}/client.workspace.js`);
			assert.ok(/const SLOT = "conversation\.session\.header\.actions";/.test(ws),
				'工作区 chip（上下文）必须注册在左侧 actions 槽');
			// ★ 2026-10-15：两枚 chip（workspace-chip -30 / worktree-chip -20）已**合并**为单枚
			//   `vssaros-context-entry`（order -27；方案 C，见 client.workspace.js 头注释 —— 顺带
			//   消掉了原 workspace-chip 与官方 subagent-catalog 在 order -30 的历史 tie ✓）。
			//   旧断言还在认那两枚旧 id ⇒ 一直红 ✗ —— 改认新契约。
			assert.ok(/id: "vssaros-context-entry", order: -27/.test(ws), '合并入口在左侧首项（官方 preset 标签 -10 之左）');
			// ⚠ 否定断言要按**注册形态**写：旧 id 在注释里被提及是合法的（L19 在讲那笔历史 tie ✓），
			//   第一版直接全文否定 ⇒ 把自己弄红 ✗。
			assert.ok(!/id: "vssaros-workspace-chip"|id: "vssaros-worktree-chip"/.test(ws),
				'旧的两枚 chip 不应再有**注册**（注释里提到旧 id 是允许的 ✓）');
			// 顺序契约不变：list 槽按 order 升序 = 从左到右，官方 preset 标签是 -10 且改不了 ⇒ 我们必须更小。
			assert.ok(-27 < -10,
				'顺序契约：合并入口(-27) < 官方 preset 标签(-10) ⇒ 视觉上 standard mode 仍在最右 ✓');

			const sessions = read(`${LIB}/client.sessions.js`);
			assert.ok(/const SLOT = "conversation\.session\.header\.utilities";/.test(sessions),
				'＋/🕘（动作）必须注册在右侧 utilities 槽');
			assert.ok(/id: "vssaros-sessions", order: -3/.test(sessions));

			const settings = read(`${LIB}/client.settings.js`);
			assert.ok(/const UTILITIES_SLOT = "conversation\.session\.header\.utilities";/.test(settings),
				'⚙（动作）必须注册在右侧 utilities 槽');
			assert.ok(/id: "vssaros-settings", order: -2/.test(settings),
				'⚙ 排在 ＋/🕘（order -3）之后 ⇒ 右侧顺序为 [＋][🕘][⚙]');

			// 官方 `session-log-download`（那枚 `…`，`dsh-session-log-export/lib/client.js:291`）没传 order
			// ⇒ 默认 0。我们**必须取负值**才会排在它左边，于是它落到右侧最外（用户要求"三个点移到最右侧"）。
			// 这条断言把"负值"这个决策钉住：谁把它改成非负，谁就会把官方 `…` 又挪回中间。
			for (const src of [sessions, settings]) {
				assert.ok(/id: "vssaros-(sessions|settings)", order: -\d/.test(src),
					'我们的 utilities chip 必须用负 order（否则官方的默认 0 会排到我们左边）');
			}

			// 布局前提（官方 CSS，`dsh-client-ui-conversation/lib/client.js:15811-15827`）：
			// `.titleCluster{flex:1}` 里先是 crumbs（已被皮肤层隐藏）再是 actions，
			// `.headerUtilities{margin-left:20px}` 靠 titleCluster 的 flex:1 被推到最右
			// ⇒ **换槽即换位**，本次改动不需要（也不该有）任何定位 CSS。
		});
	});

	suite('⑥ Agents（「+」菜单新增行 + 选择面板 + 输入框 chip）', () => {
		const chunk = `${LIB}/client.agents.js`;

		/** 造 ctx：`commandUi` 捕获贡献行、remote 给 roster、sessions 给当前 preset、bridge 记账。 */
		const DEFAULT_ROSTER = [
			{ id: 'standard', name: 'standard', isDefault: true },
			{ id: 'ptc', name: 'ptc' },
			{ id: 'vssaros-dev-expert', name: 'VsSaros开发专家', description: '专用于开发 VsSaros' },
		];
		/**
		 * 造 ctx。`__shell.fetch` 是**假 fetch**（人格路由 `/x/agents/api/persona`）：
		 * GET 返回 `__persona.current`，POST 记账并按 body 更新它（`clear:true` ⇒ 置空）。
		 * 人格状态必须能注入 —— 那枚 chip 的可见性由它驱动（真实现走同源 fetch ✓）。
		 */
		const ctxWith = (contributions: any[], switches: string[], preset: string, opened: string[] = [], presets: any[] = DEFAULT_ROSTER, persona: any = null, fetchMode: 'ok' | 'transient' | 'unauthorized' = 'ok') => {
			const personaState: { current: any; calls: string[] } = { current: persona, calls: [] };
			/** 通知**全文**（`opened` 只留前 12 字，断言真实原因时不够 ✓）。 */
			const notifies: string[] = [];
			const fetchImpl = (url: string, init?: any) => {
				const method = (init && init.method) || 'GET';
				personaState.calls.push(`${method} ${url}` + (init && init.body ? ` ${init.body}` : ''));
				// 失败模式（2026-10-13 加）：'transient' = 会话还没跑起来（时序 ✓）；'unauthorized' = 真未授权 ✗
				if (fetchMode !== 'ok') {
					const transient = fetchMode === 'transient';
					return Promise.resolve({
						ok: false, status: transient ? 400 : 401,
						text: () => Promise.resolve(transient ? '会话不在运行：s-a' : 'unauthorized'),
						json: () => Promise.reject(new Error('no body')),
					});
				}
				let body: any = {};
				try { body = init && init.body ? JSON.parse(String(init.body)) : {}; } catch { body = {}; }
				if (method === 'POST') {
					personaState.current = body.clear ? null : { personaId: body.presetId, name: body.presetId };
				}
				return Promise.resolve({
					ok: true, status: 200,
					json: () => Promise.resolve(personaState.current ? { sessionId: 's-a', ...personaState.current } : { sessionId: 's-a', personaId: null }),
				});
			};
			return {
				effect: (fn: () => unknown) => fn(),
				// ⚠ 正门是 `commandUi`（贡献行），**不是** `inputTriggers`：加号菜单是 `toggleSource("command")`，
				//   第三方 trigger 源进去看不到（chunk 文件头 ①的错路警示 + 用户实测截图）。
				get: (name: string) => (name === 'commandUi'
					? { register: (c: any) => { contributions.push(c); return () => undefined; } }
					: undefined),
				remote: {
					agentPresets: {
						list: () => Promise.resolve({ ok: true, value: { presets } }),
					},
				},
				sessions: {
					list: {
						// `vssaros-persona` = agents 模块注册的人格投影（chip 的**首选**来源 ✓）；
						// 给 persona 的用例因此走投影路径，没给的走路由兜底路径 —— 两条都被覆盖 ✓。
						getSnapshot: () => ({
							byId: {
								's-a': {
									projectionValues: Object.assign(
										{ agentPreset: preset },
										persona ? { 'vssaros-persona': { personaId: persona.personaId, name: persona.name, atSeq: 1 } } : {},
									),
								},
							},
						}),
						subscribe: () => () => undefined,
					},
				},
				// `personaRetryMs: 0` ⇒ 重试不必等真定时器（生产默认 1.5s，见 chunk 里的常量 ✓）
				__shell: { fetch: fetchImpl, personaRetryMs: 0 },
				__persona: personaState,
				__notifies: notifies,
				__bridge: {
					switchPreset: (id: string) => { switches.push(id); return Promise.resolve(); },
					openAgentMarket: () => { opened.push('market'); return Promise.resolve(); },
					openAgentRoster: () => { opened.push('roster'); return Promise.resolve(); },
					// notify 也记账（空态提示行的行为要验：只解释、不切会话）—— 全文另存一份 ✓
					notify: (_kind: string, text: string) => { notifies.push(text); opened.push('notify:' + text.slice(0, 12)); },
					// 「切换 preset = 新建一个会话」：只认 presetId（命令名相同是刻意的 —— 与 header 的
					// 「新建会话」按钮同一通路，只多带一个 preset）。
					newChat: (presetId?: string) => { opened.push('newChat:' + (presetId || '(none)')); return Promise.resolve(); },
				},
			} as Record<string, any>;
		};

		test('贡献行：**两条**（Agent = 仅换人格 / Preset = 新建会话）+ options/onSelect', async () => {
			const contributions: any[] = [];
			const switches: string[] = [];
			loadChunk(chunk, ctxWith(contributions, switches, 'vssaros-dev-expert'), { sessionId: 's-a' });
			// 2026-10-11 用户要求：Commands 里两行 —— preset（新建会话）与 agent（仅换人格）。
			assert.strictEqual(contributions.length, 2, '必须注册两条贡献行（Agent + Preset）');
			const c = contributions[0];
			// 行名不得与 host 命令重名：官方文档"重名会在候选合成时 fail loud" ⇒ 用带前缀的唯一名。
			assert.strictEqual(c.name, 'vssaros-agents');
			assert.strictEqual(c.label(), 'Agent', '本行 = Agent（仅切换人格）');
			assert.ok(c.description().includes('人格'), '描述要说明"仅切换人格、会话继续"');
			// 图标必须是**组件**：官方字符串 kind 只认代码文件类型表（没有 "agent" 这类取值）。
			assert.strictEqual(typeof c.icon, 'function', '图标要传 React 组件，不能传字符串 kind');
			assert.ok(c.icon({ size: 14 }), '图标组件必须能渲染');
			assert.strictEqual(c.available({ sessionId: 's-a' }), true);
			// 列表用官方 popup：自带搜索框 + 分组标题 + 当前项高亮（不必自绘）。
			assert.strictEqual(c.ui.kind, 'popupSelect');
			assert.strictEqual(c.ui.searchLabels().placeholder, '搜索 Agent');
			const rows = await c.ui.options({ sessionId: 's-a' }, new AbortController().signal);
			// ★ 只列 VsSaros agent：内置 preset（standard / ptc / minimal / cordis）不得出现（2026-10-11 用户要求）。
			assert.deepStrictEqual(rows.map((r: any) => r.id), ['vssaros-dev-expert']);
			assert.deepStrictEqual(rows.map((r: any) => r.group.name), ['mine'], '只剩「我的 Agent」分组');
			assert.ok(!rows.some((r: any) => ['standard', 'ptc', 'minimal', 'cordis'].includes(r.id)),
				'内置 preset 不得出现在选项里（收窄成本弹层的语义：选一个 VsSaros Agent）');
			assert.strictEqual(rows.find((r: any) => r.id === 'vssaros-dev-expert').active, true, '当前 preset 那一行必须 active');
			assert.strictEqual(rows.find((r: any) => r.id === 'vssaros-dev-expert').badge, '我的');
			assert.ok(rows.find((r: any) => r.id === 'vssaros-dev-expert').detail.includes('VsSaros'), '描述进 detail（副文本）');
			// ★ 选 Agent = **仅换人格**（会话内继续）：不得再走 switchPreset（那会换绑到别的会话）。
			c.ui.onSelect({ id: 'vssaros-dev-expert' }, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(switches, [], 'onSelect 不得再 switchPreset（换人格不换会话）');
			const t2 = loadChunk(chunk, ctxWith([], [], 'standard'), {}).exports.__test;
			assert.deepStrictEqual(t2.personaRequest('s-a', 'vssaros-dev-expert'),
				{ sessionId: 's-a', presetId: 'vssaros-dev-expert' },
				'人格切换请求体：sessionId + presetId（agent id 的反查放宿主侧）');
		});

		test('★ Preset 行：只列 dsh 自带 preset；选中 = **新建一个会话**（bridge.newChat(presetId)）', async () => {
			const contributions: any[] = [];
			const switches: string[] = [];
			const opened: string[] = [];
			loadChunk(chunk, ctxWith(contributions, switches, 'standard', opened), { sessionId: 's-a' });
			const p = contributions.find((x: any) => x.name === 'vssaros-presets');
			assert.ok(p, '必须注册 Preset 行（Commands 里 preset / agent 两行）');
			assert.strictEqual(p.label(), 'Preset');
			assert.ok(p.description().includes('新建'), '描述要说明"切换 preset = 新建一个会话"');
			const rows = await p.ui.options({ sessionId: 's-a' }, new AbortController().signal);
			assert.deepStrictEqual(rows.map((r: any) => r.id), ['standard', 'ptc'],
				'只列 dsh 自带 preset（VsSaros agent 归 Agent 行）');
			assert.strictEqual(rows.some((r: any) => r.id === 'vssaros-dev-expert'), false,
				'VsSaros agent 不得出现在 Preset 行里');
			assert.strictEqual(rows.find((r: any) => r.id === 'standard').active, true, '当前 preset 要高亮');
			p.ui.onSelect({ id: 'ptc' }, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(opened, ['newChat:ptc'], '选 preset → bridge.newChat(presetId)（新建一个会话）');
			assert.deepStrictEqual(switches, [], '不得走 switchPreset（那是换绑当前视图，不是新建会话）');
		});

		test('★ 花名册缺 VsSaros agent 时给空态提示行；broken 的 preset 不静默丢弃', async () => {
			// ① 一个 VsSaros agent 都没有 —— 这正是实测现场（`@vssaros/dsh-agents` 未装进 profile）。
			const onlyBuiltin = [
				{ id: 'standard', name: 'standard', isDefault: true },
				{ id: 'ptc', name: 'ptc' },
				{ id: 'minimal', name: 'minimal' },
				{ id: 'cordis', name: 'cordis' },
			];
			const contributions: any[] = [];
			const switches: string[] = [];
			const opened: string[] = [];
			loadChunk(chunk, ctxWith(contributions, switches, 'standard', opened, onlyBuiltin), { sessionId: 's-a' });
			const rows = await contributions[0].ui.options({ sessionId: 's-a' }, new AbortController().signal);
			const hint = rows.find((r: any) => r.id === '__vssaros-agents-hint__');
			assert.ok(hint, '没有 VsSaros agent 时必须给空态提示行（否则用户以为 UI 漏了）');
			assert.strictEqual(hint.group.name, 'mine', '提示行归在「我的 Agent」组下');
			assert.strictEqual(hint.badge, undefined,
				'提示行不给徽标（官方 badge 是上标小字，与长 detail 挤在一行会互相咬）');
			assert.ok(hint.detail.includes('插件中心') && hint.detail.includes('agents'),
				'提示必须给出可照做的下一步（插件中心 → 随包插件 → agents）');
			assert.deepStrictEqual(rows.filter((r: any) => r.id !== '__vssaros-agents-hint__').map((r: any) => r.id), [],
				'内置 preset 一个都不该出现在选项里（弹层只列 VsSaros agent）');
			contributions[0].ui.onSelect(hint, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			assert.deepStrictEqual(switches, [], '选中提示行不得切 preset（切不存在的 preset 只会报错）');
			assert.ok(opened.some(o => o.startsWith('notify:')), '提示行要说清原因');

			// ② 加载失败的 preset 照实列出（dsh 花名册会留"带诊断的失败行"，上一版被 filter 掉 ⇒ 用户全无线索）
			const withBroken = [
				{ id: 'standard', name: 'standard', isDefault: true },
				{ id: 'vssaros-broken', name: '坏掉的 Agent', broken: true },
			];
			const c2: any[] = [];
			loadChunk(chunk, ctxWith(c2, [], 'standard', [], withBroken), { sessionId: 's-a' });
			const rows2 = await c2[0].ui.options({ sessionId: 's-a' }, new AbortController().signal);
			const brokenRow = rows2.find((r: any) => r.id === 'vssaros-broken');
			assert.ok(brokenRow, 'broken 的 preset 必须照实列出');
			assert.strictEqual(brokenRow.badge, '不可用');
			assert.ok(brokenRow.detail.includes('加载失败'));
			assert.strictEqual(rows2.some((r: any) => r.id === 'standard'), false,
				'内置 preset 不得出现（即使它正是当前 preset）');
			assert.strictEqual(rows2.some((r: any) => r.id === '__vssaros-agents-hint__'), false,
				'已有 VsSaros agent（哪怕 broken）时不再显示空态提示');
		});

		test('槽位契约：chip 在 input.left；面板在 input.overlay；标签在 session.header.actions', () => {
			const h = loadChunk(chunk, ctxWith([], [], 'standard'), {});
			assert.deepStrictEqual(h.registrations.map(r => r.slot),
				['conversation.input.left', 'conversation.input.overlay', 'conversation.session.header.actions']);
			// 官方工具行 DOM 顺序：`[permission][plan]` → `input.left` ⇒ 本槽就在 permission 右侧。
			assert.strictEqual(h.exports.__test.SLOT_CHIP, 'conversation.input.left');
			assert.strictEqual(h.exports.__test.SLOT_PANEL, 'conversation.input.overlay');
			assert.strictEqual(h.exports.__test.SLOT_HEADER, 'conversation.session.header.actions');
			// 不得去占 permission 槽（它是 single，并列会冲突）
			assert.ok(!h.registrations.some(r => r.slot === 'conversation.input.permission'), 'permission 是 single 槽，不能并列注册');
		});

		test('★ 头部 preset 标签：dsh 内置 preset 显示；**模式 preset（我们的副本）也显示**；跑真 agent 时不显示', async () => {
			// 2026-10-11 用户要求：用 `+` 菜单选中一个 VsSaros agent 后，头部那枚标签不要变成该 agent 的名字。
			// 做法：同 id（`agent-preset`）+ 更低 priority **接管**官方那枚只读标签（机制同 client.hideBridgePing.js），
			// 组件内条件渲染 —— 与输入框那枚 AgentChip **互补**（chip 报 agent，本标签只报 dsh preset）。
			const caseOf = async (preset: any) => {
				const h = loadChunk(chunk, ctxWith([], [], preset), { sessionId: 's-a' });
				h.render(2, { sessionId: 's-a' });                 // 第 3 个注册 = 头部标签（chip / 面板 / 标签）
				await new Promise(r => setTimeout(r, 0));          // roster 是异步的，等一拍
				return h.render(2, { sessionId: 's-a' }) as any;
			};
			const label = await caseOf('standard');
			assert.ok(label, '跑内置 preset 时头部标签必须渲染');
			assert.strictEqual(label.props['data-vssaros-preset-label'], '1');
			assert.ok(JSON.stringify(label.children).includes('standard'), '标签显示当前 preset 名');
			assert.ok(typeof label.props.title === 'string' && label.props.title.length > 0, '要有 title（同官方：描述 / hint）');

			// ★ 2026-10-13（用户报"header ui 中缺少 standard mode ui"）：**模式 preset** 必须显示 ——
			//   它是"当前模式"，没有别的地方报它 ✗（旧规则对任何 `vssaros-` 前缀都藏 ⇒ 头部一片空白 ✗✗）。
			const mode = await caseOf('vssaros-standard');
			assert.ok(mode, '模式 preset（vssaros-standard）必须在头部报出"当前模式" ✗ 否则头部空白');
			assert.ok(JSON.stringify(mode.children).includes('standard'), '文案要有 `standard`');
			assert.ok(!JSON.stringify(mode.children).includes('vssaros-'),
				'**不许**露出内部 id `vssaros-standard`（生成器已给 `name: standard` ✓；兜底也会去前缀 ✓）');

			assert.strictEqual(await caseOf('vssaros-dev-expert'), null,
				'跑 VsSaros **agent** 时头部标签不得显示该 agent 名（名字归 composer 那枚 chip ✓）');
			assert.strictEqual(await caseOf(undefined), null, '会话没有 preset 投影 ⇒ 与官方同口径，不渲染');
		});

		test('★ 官方 preset 标签：类名**现读** + 按需隐藏（standard 走官方形态；我们的 agent 时藏掉）', () => {
			// 2026-10-12 用户要求（截图红线那枚）：`standard` 要用**官方插件**渲染（官方形态 + hover 提示）。
			// 官方 `AgentPresetLabel`（`dsh-client-ui-agent-preset:355-375`）对**所有** preset 都渲染
			// （只有 `preset === undefined` 才返回 null），且名字取花名册 name ⇒ 对 VsSaros agent 就是 agent 名
			// ⇒ 不能"接着接管"，只能**官方渲染 + 按需隐藏**（body 标记 + 我们注入的一条 CSS）。
			// 上面那条用例（render(2)）现在覆盖的是**退回路径**（Node 里没有 document ⇒ 读不到官方类名 ⇒ 自绘）。
			const t = loadChunk(chunk, {}, {}).exports.__test;
			const fakeDoc = (tags: any[]) => ({ querySelectorAll: () => tags });
			const officialStyle = {
				dataset: { pluginCss: '@deepseek-ai/dsh-client-ui-agent-preset/AgentPresetLabel.module.css' },
				textContent: '.SVAs4q_label{border-radius:var(--dsw-radius-xs);max-width:180px} .SVAs4q_icon{opacity:.8}',
			};
			assert.strictEqual(t.findOfficialPresetLabelClass(fakeDoc([officialStyle])), 'SVAs4q_label',
				'从官方 style 标签的 CSS 文本里认出标签类名');
			assert.strictEqual(t.findOfficialPresetLabelClass(fakeDoc([
				{ dataset: { pluginCss: '@deepseek-ai/dsh-client-ui-other/x.css' }, textContent: '.other_label{}' },
			])), null, '别的插件的样式不得误认');
			assert.strictEqual(t.findOfficialPresetLabelClass(fakeDoc([
				{ dataset: {}, textContent: '.SVAs4q_label{}' },
			])), null, '没有 data-plugin-css 的不认（认错了会把别人的东西藏掉 ✗）');
			assert.strictEqual(t.findOfficialPresetLabelClass(fakeDoc([
				{ dataset: { pluginCss: 'x/AgentPresetLabel.module.css' }, textContent: 'no class here' },
			])), null, 'CSS 里取不到 `_label` 类名 ⇒ 退回自绘');
			assert.strictEqual(t.findOfficialPresetLabelClass(null), null);
			assert.strictEqual(t.presetLabelHideCss('SVAs4q_label'),
				'body[data-vssaros-agent-preset="1"] .SVAs4q_label{display:none!important}');
			// 源码级契约：必须"官方优先、读不到才退回自绘"，且退回时仍注册自绘标签（否则 agent 名会漏出来）
			const code = read(chunk);
			assert.ok(/findOfficialPresetLabelClass\(document\)/.test(code), '必须现读官方类名（不能硬编码哈希）');
			assert.ok(/data-vssaros-agent-preset/.test(code), '要靠 body 标记切换"藏 / 不藏"');
			assert.ok(/state\.officialPresetLabel = false;/.test(code) && /id: "agent-preset", order: -10, priority: -1/.test(code),
				'读不到官方类名时必须退回自绘标签（宁可少 hover 提示，也不漏 agent 名）');
			// ★ 2026-10-13（用户报"header 缺 standard mode ui"）：隐藏标记必须**排除模式 preset** ✗ ——
			//   生产路径走的是"官方标签渲染 + 按需隐藏"，标记对任何 `vssaros-` 前缀都生效时，
			//   `vssaros-standard` 的官方标签也被藏 ⇒ 头部一片空白 ✗✗（用户看到的就是这个）。
			assert.ok(/const mine = !!id && sourceOf\(\{ id \}\) === "mine" && !isModePreset\(id\);/.test(code),
				'隐藏标记必须排除模式 preset（否则 vssaros-standard 的"当前模式"标签被一起藏掉 ✗）');
			assert.ok(/const isModePreset = \(presetId\) => !!presetId && BUILTIN_PRESETS\.some\(/.test(code),
				'模式判据要由 BUILTIN_PRESETS 推导（写死单个 id ⇒ 将来同步别的官方预设时漏掉 ✗）');
		});

		test('★ 模式判据与生成器同源（`BUILTIN_PRESETS` + 前缀 == `preset-sync.mjs` 的 OUR_PRESET_ID / NAME）', async () => {
			// 为什么要跨文件钉：chunk 用"`vssaros-` + 官方预设名"判"这是模式不是 agent"，
			// 而 preset 的 id/name 由 `dsh-plugins/preset-sync.mjs` 生成 ⇒ 两边漂了就又会把模式当 agent 报 ✗
			// （2026-10-13 用户报的两处 UI 问题正是这个漂移的表现 ✓）。
			const gen = await import(pathToFileURL(join(process.cwd(), 'dsh-plugins/preset-sync.mjs')).href) as any;
			assert.strictEqual('vssaros-' + 'standard', gen.OUR_PRESET_ID,
				'生成器的 OUR_PRESET_ID 变了 ⇒ chunk 的模式判据要跟着改（否则模式又被当 agent 报 ✗）');
			assert.strictEqual(gen.OUR_PRESET_NAME, 'standard',
				'生成器给的显示名必须是 standard —— 界面（官方标签 / 兜底自绘）直接用它 ✓');
		});

		test('chip：**没人格时不显示**（入口归「+」菜单）；有人格时显示名字；✕ → 清除人格（会话继续）', async () => {
			// ★ 2026-10-11 用户要求"选完 agent 在 permission 右侧看到它" —— chip 由**人格状态**驱动
			// （不再是"会话 preset 是 vssaros-*"，那个条件在换人格模型下永远不成立 ⇒ 选完没反应 ✗）。
			// ★★ 同日最终口径（用户原话："移除输入框中的「选择 agent」按钮"）：**没人格就什么都不显示**。
			// 中间曾短暂改成无条件渲染虚线「选择 Agent」——那是排查期为了拿到一个"不依赖页面桥/IPC/通知"
			// 的自证物（当时连"槽有没有渲染"都测不出来），使命已完成 ⇒ 撤回，别再改回去。
			// 选 Agent 的入口仍是「+」菜单的 Commands →「Agent」行（同一功能）。
			const emptyOpened: string[] = [];
			const empty = loadChunk(chunk, ctxWith([], [], 'standard', emptyOpened, DEFAULT_ROSTER, null), { sessionId: 's-a' });
			empty.render(0, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			assert.strictEqual(empty.render(0, { sessionId: 's-a' }), null,
				'会话跑的是 dsh 自带 preset（不是我们的 agent）⇒ 不渲染 chip ✓（判据是"跑的是不是我们的 agent" ✓；'
				+ '用户要求移除的是那个**邀请你去选的占位按钮** ✗，不是"隐藏当前 agent" ✗）');

			// 连会话 id 都拿不到时：不渲染，但**必须自报** —— 这条正是"什么通知都没有"的对照面。
			const noSidOpened: string[] = [];
			const noSid = loadChunk(chunk, ctxWith([], [], 'standard', noSidOpened, DEFAULT_ROSTER, null), {});
			noSid.render(0, {});
			await new Promise(r => setTimeout(r, 0));
			assert.strictEqual(noSid.render(0, {}), null, '拿不到会话 id ⇒ 渲染不出来');
			assert.ok(noSidOpened.some(o => o.startsWith('notify:')),
				'拿不到会话 id 必须发一条通知（否则又是"什么都没有"，无法区分是哪一层的问题）');

			const switches: string[] = [];
			const ctx = ctxWith([], switches, 'standard', [], DEFAULT_ROSTER, { personaId: 'vssaros-dev-expert', name: 'VsSaros开发专家' });
			const h = loadChunk(chunk, ctx, { sessionId: 's-a' });
			h.render(0, { sessionId: 's-a' });                       // 首帧触发人格读取 + 订阅
			await new Promise(r => setTimeout(r, 0));
			const chip = h.render(0, { sessionId: 's-a' }) as any;   // render 返回 unknown（假树），断言用 any 取 props
			assert.ok(chip, '有人格时必须有 chip（permission 下拉框右侧那枚）');
			assert.strictEqual(chip.props['data-vssaros-agent-chip'], '1');
			assert.ok(JSON.stringify(chip.children).includes('VsSaros开发专家'), 'chip 显示人格名');
			const x = findByAttr(chip, 'data-vssaros-agent-chip-remove');
			assert.ok(x, '必须有一枚可点的 ✕（用户要求可删除）');
			x.props.onClick();
			await new Promise(r => setTimeout(r, 0));
			assert.ok(ctx.__persona.calls.some((c: string) => c.startsWith('POST /x/agents/api/persona') && c.includes('"clear":true')),
				'✕ 必须 POST {clear:true}（清除人格；不再 switchPreset 换会话）');
			assert.deepStrictEqual(switches, [], '✕ 不得 switchPreset（那会换绑到别的会话）');
		});

		test('★ chip 可见性：会话跑的是我们的 agent 就必须显示它（不需要先手动选一次）', async () => {
			// 2026-10-13 两轮：先修"跑我们的 agent 却没有 chip"（判据从"切换过人格"改回"跑我们的 agent" ✓），
			// 再修那次修复的**过度应用** ✗ —— `vssaros-standard` 是**官方 standard 的逐字副本**（见
			// `dsh-plugins/vssaros-agents/cordis.presets.yml` ✓）：它是**模式**，不是"某个 agent" ✗，
			// 被当 agent 报就会让 composer 冒出内部 id `vssaros-standard`（用户报"输入框不该显示它" ✗✗）。
			// 分工定死：**模式归头部**（官方标签，见下一条用例 ✓）、**agent 归 composer** ✓。
			const mode = ctxWith([], [], 'vssaros-standard', [], DEFAULT_ROSTER, null);
			const hm = loadChunk(chunk, mode, { sessionId: 's-a' });
			hm.render(0, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			assert.strictEqual(hm.render(0, { sessionId: 's-a' }), null,
				'模式 preset（vssaros-standard）**不得**出 chip：否则用户看到的是内部 id ✗');

			const c = ctxWith([], [], 'vssaros-dev-expert', [], DEFAULT_ROSTER, null);
			const h = loadChunk(chunk, c, { sessionId: 's-a' });
			h.render(0, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			const chip = h.render(0, { sessionId: 's-a' }) as any;
			assert.ok(chip, '跑我们的 **agent** 却没有 chip ⇒ 用户看不到当前 agent（2026-10-13 报障现场 ✗）');
			assert.strictEqual(chip.props['data-vssaros-agent-chip'], '1');
			assert.ok(JSON.stringify(chip.children).includes('VsSaros开发专家'), 'chip 用花名册里的显示名');
			assert.strictEqual(findByAttr(chip, 'data-vssaros-agent-chip-remove'), null,
				'没切换过人格时**不给 ✕**：它无处可清 ⇒ 那就成了用户明确要求移除的"占位按钮" ✗');
			// 花名册里有的 agent ⇒ 用花名册的**显示名**（不是 id）
			const c2 = ctxWith([], [], 'vssaros-dev-expert', [], DEFAULT_ROSTER, null);
			const h2 = loadChunk(chunk, c2, { sessionId: 's-a' });
			h2.render(0, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			const chip2 = h2.render(0, { sessionId: 's-a' }) as any;
			assert.ok(chip2 && JSON.stringify(chip2.children).includes('VsSaros开发专家'),
				'花名册里有该 agent 时必须用显示名（与选择面板同一份花名册 ✓）');
		});

		test('★★ 人格读取失败：时序性失败要**重试且报真原因**，真未授权才照实报', async () => {
			// 2026-10-13 用户贴的旧文案：「Agent 人格读取失败（/x/agents/api/persona 不可达或未授权）—— chip 只在
			// 选中过 agent 后才显示」✗ —— 真原因是"页面挂载早于 agent 注册" ⇒ 路由回 400「会话不在运行」
			// （一直躺在 `state.personaProbeError` 里），却被写成"不可达或未授权"，且**只试一次不重试** ✗。
			// ⚠ 用**真 agent**（不是模式 preset）：模式 preset 本来就不出 chip（见上一条用例 ✓）
			const c1 = ctxWith([], [], 'vssaros-dev-expert', [], DEFAULT_ROSTER, null, 'transient');
			const h1 = loadChunk(chunk, c1, { sessionId: 's-a' });
			h1.render(0, { sessionId: 's-a' });
			for (let i = 0; i < 14; i++) { await new Promise(r => setTimeout(r, 0)); }   // retryMs=0 ⇒ 把额度跑完
			assert.ok(c1.__persona.calls.length > 4, '时序性失败必须**重试**（旧版只试一次 ✗）');
			const msgs1 = c1.__notifies as string[];
			assert.strictEqual(msgs1.length, 1, '额度用尽后只照实报**一次**（不许刷屏 ✗）');
			assert.ok(/会话不在运行/.test(msgs1[0]), '通知必须带**真实原因**（不是笼统的"不可达/未授权" ✗）');
			assert.ok(!/不可达或未授权/.test(msgs1[0]), '旧文案不得复活（它正是本次报障的误导源 ✗）');
			assert.ok(h1.render(0, { sessionId: 's-a' }),
				'读取失败也不影响 chip：会话跑的是我们的 agent ⇒ 照常显示 ✓（读取只影响人设名 ✓）');

			const c2 = ctxWith([], [], 'vssaros-dev-expert', [], DEFAULT_ROSTER, null, 'unauthorized');
			const h2 = loadChunk(chunk, c2, { sessionId: 's-a' });
			h2.render(0, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			await new Promise(r => setTimeout(r, 0));
			const msgs2 = c2.__notifies as string[];
			assert.strictEqual(msgs2.length, 1, '真未授权：立刻报一次');
			assert.ok(/HTTP 401/.test(msgs2[0]), '真未授权要报出状态码与正文（HTTP 401 ✓）');
			assert.strictEqual(c2.__persona.calls.length, 2, '非时序性失败**不重试**（只试"带 token / 不带 token"两次 ✓）');
		});

		test('★ 人格切换失败：错误里必须带上路由的**原因正文**（不是干巴巴的 HTTP 400）', async () => {
			// 2026-10-11 实测现场：用户看到「切换人格失败：HTTP 400」，而那条 400 的正文里写着原因原话
			// （`会话不在运行，无法热切换：…` / `未知 preset：…` / `需要 sessionId` —— 模块路由的 catch
			// 就是 `res.end(String(e.message))`）。上一版把正文丢了 ⇒ 零信息错误、只能再猜一轮 ✗。
			const contributions: any[] = [];
			const opened: string[] = [];
			const ctx = ctxWith(contributions, [], 'standard', opened, DEFAULT_ROSTER, null);
			// 换掉假 fetch：模拟路由 400 + 纯文本原因（与真实现同形）。
			ctx.__shell.fetch = () => Promise.resolve({
				ok: false, status: 400, text: () => Promise.resolve('未知 preset：vssaros-nope'),
			} as any);
			const state: Record<string, any> = { sessionId: 's-a' };
			loadChunk(chunk, ctx, state);
			contributions[0].ui.onSelect({ id: 'vssaros-nope' }, { sessionId: 's-a' });
			await new Promise(r => setTimeout(r, 0));
			const err = String(state.agentsError || '');
			assert.ok(err.includes('HTTP 400'), '状态码要保留（便于区分 401 未授权 / 400 请求不合法）：' + err);
			assert.ok(err.includes('未知 preset'), '必须带上路由正文里的原因（否则等于没信息）：' + err);
			assert.ok(opened.some(o => o.startsWith('notify:')), '失败必须说出来');
		});

		test('面板（chip 点击路径）：**只列 dsh 自带 preset**（不含 VsSaros agent），选中 → switchPreset(id)，搜索可过滤', async () => {
			const contributions: any[] = [];
			const switches: string[] = [];
			// 面板走 chip 点击那条路（菜单路径现在是官方 popup）；这里直接用 state 上的把手打开，
			// 因为假 React 会把 chip 与面板的 hook 槽共享 ⇒ 同 harness 渲染两个组件会相互污染。
			const state: Record<string, any> = { sessionId: 's-a' };
			const h = loadChunk(chunk, ctxWith(contributions, switches, 'vssaros-dev-expert'), state);
			state.agentsPanelStore.setOpen(true);
			h.render(1, { sessionId: 's-a' });                             // 面板首帧（触发 roster 加载）
			await new Promise(r => setTimeout(r, 0));
			const panel = h.render(1, { sessionId: 's-a' }) as any;
			assert.ok(panel, '面板必须渲染');
			assert.strictEqual(panel.props['data-vssaros-agents-panel'], '1');
			// 文案：本面板是 **Agent 选择器** —— 占位符/空态都必须说 Agent。
			// 上一版照抄了 preset 行的占位符（"搜索 preset（dsh 自带）"）⇒ 面板里明明是「我的 Agent」，
			// 却让用户去搜 preset（2026-10-11 用户截图实测 ✗）。
			const search = findByAttr(panel, 'data-vssaros-agents-search') as any;
			assert.ok(search, '搜索框要带 `data-vssaros-agents-search` 标记（便于断言文案）');
			assert.strictEqual(search.props.placeholder, '搜索 Agent');
			const items = findAll(panel, 'data-vssaros-agent-item') as any[];
			// ★ 本面板是 **Agent 选择器**（composer 那枚 chip 打开）⇒ 只列 VsSaros agent；
			// dsh 自带 preset 的选择在 hero 那枚 preset chip 的下拉里（那边只列内置 preset）。
			assert.deepStrictEqual(items.map((n: any) => n.props['data-vssaros-agent-item']),
				['vssaros-dev-expert'], '面板只列 VsSaros agent');
			// 选中 = **仅换人格**（POST 人格路由），不得 switchPreset（那会换绑会话）
			items.find((n: any) => n.props['data-vssaros-agent-item'] === 'vssaros-dev-expert').props.onClick();
			assert.deepStrictEqual(switches, [], '选 agent 不得 switchPreset');
			// 搜索过滤（面板内搜索框是自绘面板相对官方原语的主要收益）
			const box = findAll(panel, 'placeholder')[0] as any;
			box.props.onChange({ target: { value: 'VsSaros' } });
			const filtered = findAll(h.render(1, { sessionId: 's-a' }), 'data-vssaros-agent-item');
			assert.deepStrictEqual(filtered.map((n: any) => n.props['data-vssaros-agent-item']), ['vssaros-dev-expert']);
			// 空态文案同口径（也说 Agent）：搜不中时给"没有匹配的 Agent"
			box.props.onChange({ target: { value: 'zzz-nope' } });
			const none = h.render(1, { sessionId: 's-a' }) as any;
			assert.ok(JSON.stringify(none.children).includes('没有匹配的 Agent'), '空态文案必须说 Agent');
		});

		test('底部动作：打开 Agent 商城 / 管理 Agent → 都走宿主桥命令（页面开不了编辑器）', async () => {
			const contributions: any[] = [];
			const opened: string[] = [];
			const state: Record<string, any> = { sessionId: 's-a' };
			const h = loadChunk(chunk, ctxWith(contributions, [], 'vssaros-dev-expert', opened), state);
			state.agentsPanelStore.setOpen(true);
			h.render(1, { sessionId: 's-a' });                             // 面板首帧（触发 roster 加载）
			await new Promise(r => setTimeout(r, 0));
			const panel = h.render(1, { sessionId: 's-a' });
			const actions = findAll(panel, 'data-vssaros-agents-action') as any[];
			assert.deepStrictEqual(actions.map((n: any) => n.props['data-vssaros-agents-action']), ['shop', 'manage']);
			actions[0].props.onClick();
			actions[1].props.onClick();
			assert.deepStrictEqual(opened, ['market', 'roster'], '两个动作必须分别调 openAgentMarket / openAgentRoster');
		});

		test('纯逻辑：分组判定（vssaros- 前缀 → 我的；内置 4 个 → 内置）/ 当前 preset / 过滤', () => {
			const t = loadChunk(chunk, ctxWith([], [], 'standard'), {}).exports.__test;
			assert.strictEqual(t.sourceOf({ id: 'standard' }), 'builtin');
			assert.strictEqual(t.sourceOf({ id: 'cordis' }), 'builtin');
			assert.strictEqual(t.sourceOf({ id: 'vssaros-dev-expert' }), 'mine');
			assert.deepStrictEqual(t.BUILTIN_PRESETS, ['standard', 'ptc', 'minimal', 'cordis']);
			assert.strictEqual(t.currentPreset({ projectionValues: { agentPreset: 'ptc' } }), 'ptc');
			assert.strictEqual(t.currentPreset({}), undefined);
			assert.strictEqual(t.matches({ id: 'a', name: 'PPT专家' }, 'ppt'), true);
			assert.strictEqual(t.matches({ id: 'a', name: 'PPT专家' }, 'zzz'), false);
			assert.strictEqual(t.matches({ id: 'a' }, ''), true, '空查询不过滤');
			// store：订阅式开合（触发菜单的 pick 与浮层之间就靠它）
			const store = t.createStore();
			let hits = 0;
			const off = store.subscribe(() => { hits++; });
			store.setOpen(true);
			store.setOpen(true);   // 同值不重复通知
			assert.strictEqual(store.isOpen(), true);
			assert.strictEqual(hits, 1);
			off();
			store.setOpen(false);
			assert.strictEqual(hits, 1, '退订后不再通知');
		});
	});

	suite('菜单视口适配与互斥（WebContentsView 裁切）', () => {
		const entry = loadEntryExports().__test;

		test('fitMenuSize：留边计算，且**永不超出视口**（聊天框很窄时以视口为准）', () => {
			assert.deepStrictEqual(entry.fitMenuSize({ width: 300, height: 200 }),
				{ overflowY: 'auto', overflowX: 'hidden', maxWidth: '276px', minWidth: '220px', maxHeight: '128px' });
			// 退化：视口比"留边后的下限"还小 ⇒ 夹到视口本身（宁贴边不溢出 ⇒ 不会被裁）；
			// minWidth 必须一起降到视口，否则窄框里 min > max 会让菜单反而被裁。
			assert.deepStrictEqual(entry.fitMenuSize({ width: 90, height: 50 }),
				{ overflowY: 'auto', overflowX: 'hidden', maxWidth: '90px', minWidth: '90px', maxHeight: '50px' });
			// 拿不到视口（非浏览器环境）⇒ 不下尺寸限制，只给滚动
			assert.deepStrictEqual(entry.fitMenuSize(null), { overflowY: 'auto', overflowX: 'hidden' });
			assert.ok(parseInt(entry.fitMenuSize({ width: 1000, height: 800 }).maxWidth) < 1000, '正常情况留边');
		});

		test('★ 菜单有最小宽度（否则被 `width:100%` 条目挤成每行 1–2 个字）', () => {
			assert.ok(parseInt(entry.fitMenuSize({ width: 900, height: 600 }).minWidth) >= 200,
				'正常视口下最小宽度必须够放一个菜单条目');
			assert.ok(parseInt(entry.fitMenuSize({ width: 260, height: 600 }).minWidth) <= 260,
				'最小宽度不得大于视口（否则窄框里仍被 WebContentsView 裁掉）');
		});

		test('createMenuCoordinator：开新菜单关掉其它；注销后不再被关', () => {
			const menus = entry.createMenuCoordinator();
			const closed: string[] = [];
			menus.register('a', () => closed.push('a'));
			menus.register('b', () => closed.push('b'));
			assert.strictEqual(menus.openedCount(), 2);
			menus.closeOthers('b');
			assert.deepStrictEqual(closed, ['a'], '只关别人，不关自己');
			assert.strictEqual(menus.openedCount(), 2, 'closeOthers 只负责"关"，注销由调用方做');
			menus.register('a', null);
			assert.strictEqual(menus.openedCount(), 1, '传 null ⇒ 注销');
			menus.closeOthers('b');
			assert.deepStrictEqual(closed, ['a'], '已注销的菜单不会再被关');
		});

		test('chunk 把 fitMenu 结果并进菜单 style，并在打开时登记互斥', () => {
			const closedOthers: string[] = [];
			const h = loadChunk(`${LIB}/client.workspace.js`, {
				...{
					get: (name: string) => (name === 'workspaces' ? { list: { getSnapshot: () => WS, subscribe: () => () => undefined } } : undefined),
					uiWorkspace: { openWorkspace: () => Promise.resolve() },
				},
				__shell: {
					fitMenu: () => ({ maxWidth: '123px', maxHeight: '45px', overflowY: 'auto' }),
					menus: { closeOthers: (id: string) => closedOthers.push(id), register: () => () => undefined },
				},
			}, {});
			findByAttr(h.render(0, { sessionId: 's-a' }), 'data-vssaros-context-chip').props.onClick();
			const menu = findAll(h.render(0, { sessionId: 's-a' }), 'role').find((n: any) => n.props.role === 'menu');
			assert.ok(menu, '菜单必须渲染');
			assert.strictEqual(menu.props.style.maxWidth, '123px', '菜单宽度必须夹到视口（否则被 WebContentsView 裁掉）');
			assert.strictEqual(menu.props.style.maxHeight, '45px');
			assert.strictEqual(menu.props.style.overflowY, 'auto');
			// 锚点方向（方案 B 之后工作区 chip 在**左侧**）：菜单必须向右展开，否则会越过视图左边缘、
			// 被 VsSaros 侧栏盖住（2026-10-11 实测截图：工作区菜单左半边被侧栏遮住）。
			assert.strictEqual(menu.props.style.left, 0, '左侧 chip 的菜单必须 left:0（向右展开）');
			assert.strictEqual(menu.props.style.right, undefined, '不得再写 right（那正是向左溢出的原因）');
			// ★ 2026-10-15：菜单互斥的 id 就是合并入口自己（`MENU_ID = "vssaros-context-entry"`，
			//   client.workspace.js L167/L261）—— 旧断言还认合并前的 'vssaros-workspace' ✗。
			assert.deepStrictEqual(closedOthers, ['vssaros-context-entry'], '打开前必须关掉其它菜单（菜单 id = 合并入口 ✓）');
		});

		test('★ preset 下拉（hero chip）必须**向右**展开（锚点在输入框左侧）', () => {
			// 现场（2026-10-11 用户截图）：菜单写 `right: 0` ⇒ 从 hero chip 向左展开，越过聊天视图左边缘被裁，
			// 截图里只剩 `dard` / `imal` / `dis` —— 就是 standard / minimal / cordis 被裁后的尾巴 ✗。
			// hero chip 在输入框**左侧** ⇒ 必须 `left: 0`；尺寸仍由 fitMenu 夹在视口内（上面那条契约管它）。
			const code = read(`${LIB}/client.preset.js`);
			const menuStyle = /role: "menu"[\s\S]{0,500}?position: "absolute", top: "100%", (left|right): 0/.exec(code);
			assert.ok(menuStyle, 'client.preset.js 的菜单必须有定位（absolute + top:100% + 水平锚点）');
			assert.strictEqual(menuStyle![1], 'left',
				'hero chip 的 preset 菜单必须 left:0（写 right:0 就会越过视图左边缘被裁）');
		});

		test('★ preset 下拉与 dsh 官方一致：纯条目列表（无分组标题 / 分隔线 / 自加动作行）', () => {
			// 官方那个 preset 菜单（`AgentPresetSeat` 的 `Menu`，`dsh-client-ui-agent-preset/lib/client.js:491-520`）
			// 就是**纯条目**：名称 + 一行描述。我们此前在下面自加了分隔线和「管理 Agent…（VsSaros Agent Studio）」
			// 一行（用户 2026-10-11 截图指出），还分了「内置 / 我的 Agent」两组 ⇒ 一律去掉。
			// 必须先剥注释：这个文件里就写着"已去掉『管理 Agent…』"这类说明，直接扫会误判 ✗（实测踩过）。
			const code = read(`${LIB}/client.preset.js`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
			assert.ok(!code.includes('管理 Agent…'), '不得再挂"管理 Agent…（VsSaros Agent Studio）"那一行（官方没有）');
			assert.ok(!/key: "h[12]"/.test(code), '不得再有「内置 / 我的 Agent」分组标题');
			assert.ok(!/key: "sep"/.test(code), '不得再有自加分隔线');
			assert.ok(/const builtins = roster\.filter\(\(p\) => isBuiltin\(p\.id\)\)/.test(code)
				&& /for \(const p of builtins\) \{ rows\.push\(item\(p\)\); \}/.test(code),
				'条目只能来自 dsh 自带 preset（VsSaros agent 的入口是 + 菜单 → Commands → Agents）');
		});

		test('源码契约：四个自绘菜单都夹了视口（新菜单别漏）', () => {
			for (const rel of ['client.workspace.js', 'client.sessions.js', 'client.preset.js', 'client.settings.js']) {
				const code = read(`${LIB}/${rel}`).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
				assert.ok(code.includes('shell.fitMenu ? shell.fitMenu() : {}'), `${rel} 的菜单必须合并 fitMenu（视口适配）`);
				assert.ok(code.includes('shell.menus.closeOthers('), `${rel} 打开菜单时必须登记互斥`);
			}
		});
	});

	suite('④ 隐藏 dsh 头部的会话标题（皮肤层）', () => {
		test('★ 面包屑 nav 被隐藏，且锚点是标题行唯一稳定的 data 钩子', () => {
			const skin = read(`${LIB}/client.skin.js`);
			assert.ok(
				/div:has\(> \[data-conversation-header-corner\]\) > div > nav\s*\{\s*display: none !important;/.test(skin),
				'皮肤层必须有"隐藏面包屑 nav"的规则（[data-conversation-header-corner] 是标题行里唯一的稳定 data 钩子）');
			assert.ok(!/ConversationRoot_module_css|_crumbs\b/.test(skin),
				'不得依赖 hash 化类名（dsh 改版会静默失效）—— 与皮肤层既有约定一致');
			assert.ok(skin.includes('> div > nav'),
				'必须收窄到 titleCluster > nav（保留同行里的动作位/工具位，别把别的 nav 一起藏了）');
		});

		test('★ 皮肤层必须保持"不改写官方已有节点形状"（用户/助手/过程/工具四类都无边框）', () => {
			// 2026-10-12 用户要求（对照官方截图）：**LLM 的回复不应有边框**。
			// 原规则是 2026-10-10 "批次①对齐原生"加的：
			//   `[data-chat-flow-kind="assistant-step"]{border:1px solid …!important;border-radius:10px 10px 10px 4px!important}`
			// 它把回复套成通栏描边卡片（实测截图就是这个框）⇒ 已删除。这条守卫防止再被加回来。
			// 同一个教训此前在**用户气泡**上已发生过一次（2026-10-10 撤掉对面 `data-chat-flow-kind="user"`
			// 的 background/border 覆写），所以这里把两类**消息本体**一起钉住。
			const code = read(`${LIB}/client.skin.js`)
				.replace(/\/\*[\s\S]*?\*\//g, '')   // 注释里就写着这两条被撤掉的规则，不剥会把守卫误判成违反 ✗
				.replace(/\/\/[^\n]*/g, '');
			assert.ok(!/assistant-step[\s\S]{0,60}border/.test(code),
				'助手消息（assistant-step）不得再有 border（用户 2026-10-12 对照官方截图要求去掉）');
			assert.ok(!/chat-flow-kind=\\?"user\\?"\][^}]{0,120}(background|border)/.test(code),
				'用户气泡同样不得被覆写（2026-10-10 已撤掉：官方那只右对齐紧凑气泡保持原样）');
			// ★ 2026-10-12 追加（用户"进行"）：过程组 / 工具卡也一并回到官方形状（无边框）。
			// 四类官方已有节点（user / assistant-step / turn-process / tool-call）现在**同一原则**：
			// 本层只读不改形状 ⇒ 官方改版时不会出现"我们和它对冲"。
			assert.ok(!/turn-process[\s\S]{0,80}border/.test(code), '过程组不得再有左边线（回归官方形状）');
			assert.ok(!/tool-call[\s\S]{0,80}border/.test(code), '工具卡不得再有描边（回归官方形状）');
			// 但"官方没有的层次"仍归本层 —— 别连着"不要边框"把增量一起删掉：
			assert.ok(/data-approval-key\]\{[^}]*border-left/.test(code), '审批卡的警示左边线仍归本层（官方没有这层）');
		});
	});

	suite('页面桥新命令（openSession / newChat）', () => {
		test('validatePageCommand：接受合法形状、拒绝越界/怪异值', () => {
			assert.deepStrictEqual(validatePageCommand({ method: 'newChat' }), { method: 'newChat' });
			assert.deepStrictEqual(validatePageCommand({ method: 'openSession', sessionId: 'vssaros-chat-x' }),
				{ method: 'openSession', sessionId: 'vssaros-chat-x' });
			assert.deepStrictEqual(validatePageCommand({ method: 'openSession', sessionId: 's-1', agentPreset: 'ptc' }),
				{ method: 'openSession', sessionId: 's-1', agentPreset: 'ptc' });
			for (const bad of [
				{ method: 'openSession' },
				{ method: 'openSession', sessionId: '' },
				{ method: 'openSession', sessionId: '../evil' },
				{ method: 'openSession', sessionId: 'a'.repeat(201) },
				{ method: 'openSession', sessionId: 'ok', agentPreset: 'a b' },
				{ method: 'openSession', sessionId: 'ok', agentPreset: 42 },
			]) {
				assert.strictEqual(validatePageCommand(bad), undefined, JSON.stringify(bad));
			}
			// ★ 2026-10-15（计划审阅进 IDE）：openMarkdown —— 内存态 markdown 的桥命令。
			//   页面是外部输入面 ⇒ text 必须非空 string + 上限；title 超形就丢（不为标题拒整份 ✗）。
			assert.deepStrictEqual(validatePageCommand({ method: 'openMarkdown', text: '# 计划\n内容' }),
				{ method: 'openMarkdown', text: '# 计划\n内容', title: undefined });
			assert.deepStrictEqual(validatePageCommand({ method: 'openMarkdown', text: 'x', title: 't' }),
				{ method: 'openMarkdown', text: 'x', title: 't' });
			for (const bad of [
				{ method: 'openMarkdown' },
				{ method: 'openMarkdown', text: '' },
				{ method: 'openMarkdown', text: 42 },
				{ method: 'openMarkdown', text: 'x'.repeat(513 * 1024) },
			]) {
				assert.strictEqual(validatePageCommand(bad), undefined, JSON.stringify(bad).slice(0, 60));
			}
		});

		test('preload 暴露 openSession/newChat（页面侧才能调）', () => {
			const preload = read(PRELOAD_REL);
			assert.ok(preload.includes("method: 'openSession'"), 'preload 必须暴露 openSession');
			assert.ok(preload.includes("method: 'newChat'"), 'preload 必须暴露 newChat');
			assert.ok(preload.includes("method: 'openMarkdown'"), 'preload 必须暴露 openMarkdown（计划审阅投编辑器 ✓，2026-10-15）');
		});

		test('★★ 在终端打开：先把 panel 展开（终端就落在编辑区下方的 panel）+ 失败保底不静默', () => {
		// 2026-10-13 用户三次纠正后定稿：终端**该落在文件编辑器区域下方的 panel** ✓。
		// **2026-10-14 第二次修正（有运行日志实证）**：判"面板能不能看见"**不许**用
		// `isVisible(Parts.PANEL_PART)` ✗ —— 它读 `PANEL_HIDDEN` 运行时状态（`layout.ts:1359-1360`），
		// 而 agents 布局隐藏 panel 只用 inline `display:none`（`agentLayoutWorkbench.ts:859-860`）⇒
		// 该状态从未置位 ⇒ **恒为 true** ⇒ 上一版的 `if (!before)` 永不触发（日志：`panel=已可见 location=panel`，
		// 用户连点两次 ⇒ `instanceId=1`、`2` 两个**看不见的终端** ✗✗）。
		const host = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
		// ⚠ 只禁"**用 isVisible 当可见性判据**"这个用法（老写法 `const before = …isVisible(…)` ✗）；
		//   `isVisible` 仍可以出现在"对齐状态"的兜底里（那里要的就是状态本身 ✓）。
		assert.ok(!host.includes('const before = this._layoutService.isVisible(Parts.PANEL_PART);'),
			'不许用 `isVisible(PANEL_PART)` 判面板可见性 ✗ —— 本布局下它**恒为 true**（状态从未置位，2026-10-14 日志实证）');
		assert.match(host, /getContainer\(mainWindow, Parts\.PANEL_PART\)/,
			'必须按 **DOM 真相**判（拿 panel 元素看 display / offsetHeight ✓）');
		assert.match(host, /el\.style\.display !== 'none' && el\.offsetHeight > 0/,
			'DOM 判据要同时认 inline `display:none` 与零高度 ✓（两者都 = 用户看不见）');
		assert.match(host, /document\.dispatchEvent\(new CustomEvent\('agent-studio:toggle-panel'\)\)/,
			'展开 panel 的唯一公开入口 = 标题栏那个按钮用的 DOM 事件（两个布局各有监听器，补齐了"可见性 + 高度 + 打开容器 + 清 display" ✓）');
		// ⚠ 那个事件是**切换**语义：状态与 DOM 不一致时第一次会走"隐藏"分支 ⇒ 必须**收敛**（最多两次，每次复核）
		assert.match(host, /for \(let attempt = 0; !panelShown && attempt < 2; attempt\+\+\)/,
			'必须收敛式派发（最多两次）—— 只派发一次在"状态谎报可见"时落到隐藏分支 ⇒ 面板不出 ✗✗');
		assert.match(host, /await firePanelToggle\(attempt > 0\)/,
			'第 2 轮要带"先由我们自己对齐状态"的兜底（布局侧回归时本路径仍能自愈 ✓）');
		assert.match(host, /if \(this\._layoutService\.isVisible\(Parts\.PANEL_PART\)\) \{[\s\S]{0,200}?setPartHidden\(true, Parts\.PANEL_PART\)/,
			'兜底对齐要在状态"谎报可见"时把它置为隐藏（否则那条切换事件永远走隐藏分支 ✗）');
		const fireAt = host.indexOf("agent-studio:toggle-panel'");
		const locAt = host.indexOf('const location = panelShown ?');
		assert.ok(locAt > fireAt,
			'位置要在**展开尝试之后**再定（先判后展开 ⇒ 读到旧状态，仍会误退到编辑区 ✗）');
		assert.match(host, /const location = panelShown \? TerminalLocation\.Panel : TerminalLocation\.Editor;/,
			'默认位置必须是 Panel（= 用户要的"编辑区下方" ✓）；只有面板**真的出不来**才退到编辑区');
		assert.ok(!/setPartHidden\(false, Parts\.PANEL_PART\)/.test(host),
			'展开**不许**用 `setPartHidden` ✗ —— 标准 Layout 那条路径不恢复高度/不打开容器 ⇒ "网格可见但高度 0"，正是真机症状 ✓');
		assert.match(host, /createTerminal\(\{\s*location,/, '创建终端要把 location 传下去（算了不用 = 白改 ✗）');
		assert.match(host, /if \(panelShown\) \{[\s\S]{0,400}?workbench\.action\.terminal\.focus/,
			'面板路径下要把焦点落到新终端（编辑区那份由创建动作自己打开 ✓）');
		assert.match(host, /打开终端失败：\{0\}（命令已复制到剪贴板/,
			'真失败必须给用户可行动作（剪贴板 + 提示），不许"点了没反应" ✗');
		// 聊天宿主那条 if/else-if 链的兜底：未处理的方法必须留痕（否则又是"零日志只能猜" ✗）
		const chat = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshChatInstanceHost.ts');
		assert.match(chat, /chat page command not handled by this host/,
			'链尾兜底必须留痕 —— 贡献点没加载时未处理的命令会静默消失 ✗');
	});

	test('★★ 看改动：diff 必须开在**文件编辑区**（不许落进点击时所在的聊天列）', () => {
		// 2026-10-14 用户要求「在文件编辑器窗口中显示 diff editor pane」。
		// 病根：扩展的 `openUncommittedDiff` 用 `vscode.diff` ⇒ 落**当前活动分组**，而用户是在聊天列
		// 里点的按钮 ⇒ diff 被开进那条窄的聊天列（真机截图：代码被换行挤成一列 ✗✗）。
		// 修法 = 分工：扩展新命令只**算**两条资源 URI（字符串 ✓ 可跨宿主边界 ✓），工作台显式落
		// `mainPart.activeGroup`（与本文件 `_open()`、「查看文件」跳转同一口径 ✓）。
		const host = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
		assert.match(host, /agentStudio\.getUncommittedDiff/,
			'必须走"扩展只算 URI"的新命令（否则只能落活动分组 ⇒ 开进聊天列 ✗）');
		assert.match(host, /original: \{ resource: URI\.parse\(found\.original\) \}[\s\S]{0,200}?modified: \{ resource: URI\.parse\(found\.modified\) \}/,
			'diff 两侧要用扩展返回的 URI 字符串（`URI.parse` ✓，不许自己拼 file:// ✗）');
		assert.match(host, /\}, this\._editorGroups\.mainPart\.activeGroup\);/,
			'diff 必须显式开在**文件编辑区**（`mainPart.activeGroup`）—— 不指定分组就会开进聊天列 ✗✗');
		assert.match(host, /agentStudio\.openUncommittedDiff/,
			'旧命令要留作兜底（扩展产物没重编译时至少开得出来 ✓）');
		assert.match(host, /page showUncommittedDiff: .*⇒ /,
			'这条链路从前零日志 ✗ ⇒ 必须留痕（否则"点了没反应"又只能猜 ✓）');
		// 扩展侧：新命令存在 + 返回的是可跨边界的字符串（不是 vscode.Uri 对象 ✗）
		const ext = read('extensions/agent-studio/src/extension.ts');
		assert.match(ext, /registerCommand\('agentStudio\.getUncommittedDiff'/,
			'扩展必须注册 `agentStudio.getUncommittedDiff`（删了它 ⇒ 工作台那条新路径永远 catch ✗）');
		assert.match(ext, /original: change\.originalUri\.toString\(\)[\s\S]{0,200}?modified: change\.uri\.toString\(\)/,
			'必须返回 `toString()` 字符串 —— 返回 `vscode.Uri` 对象跨扩展宿主边界不可靠 ✗');
		assert.match(ext, /vscode\.Uri\.parse\(found\.original\)/,
			'旧命令仍要自己开一次 diff（它内部只能落活动分组，注释里已写明这条限制 ✓）');
	});

	test('★ Agents 入口命令：形状校验 + preload 暴露 + 宿主消费（源码契约）', () => {
			assert.deepStrictEqual(validatePageCommand({ method: 'openAgentMarket' }), { method: 'openAgentMarket' });
			assert.deepStrictEqual(validatePageCommand({ method: 'openAgentRoster' }), { method: 'openAgentRoster' });
			assert.strictEqual(validatePageCommand({ method: 'openAgentMkt' }), undefined, '拼错的 method 必须被拒');
			const preload = read(PRELOAD_REL);
			assert.ok(preload.includes("method: 'openAgentMarket'"), 'preload 必须暴露 openAgentMarket');
			assert.ok(preload.includes("method: 'openAgentRoster'"), 'preload 必须暴露 openAgentRoster');
			// 宿主消费：商城 = 既有编辑器页命令；花名册 = 原生 Agent 列表视图（带资源管理页回落）。
			const host = read('src/vs/sessions/contrib/dshHarness/electron-browser/dshHarness.contribution.ts');
			assert.ok(host.includes("executeCommand('agentStudio.openMarket')"), '商城必须走既有命令 agentStudio.openMarket');
			assert.ok(host.includes("executeCommand('agentStudio.presetAgent.focus')"), '花名册优先显原生 Agent 列表视图');
			assert.ok(host.includes("executeCommand('agentStudio.openResourceManager')"), '列表视图不存在时回落资源管理页');
		});

		test('两个新 chunk 都在入口的 PART_CHUNKS 里（否则根本不装载）', () => {
			const entry = read(ENTRY_REL);
			assert.ok(entry.includes('./client.workspace.js'), 'PART_CHUNKS 缺少 workspace chunk');
			assert.ok(entry.includes('./client.sessions.js'), 'PART_CHUNKS 缺少 sessions chunk');
		});
	});
});
