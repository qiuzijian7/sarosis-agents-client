/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * 渠道绑定持久化（2026-09-23 修「重启后 chat_id 绑定丢失」）的用例。
 *
 * 背景一句话：渲染进程沙箱里 `nodeRequire('fs')` 永远返回 undefined ⇒ 旧 file store
 * 永远返回 undefined ⇒ `BridgeEngine` 退化为内存 store ⇒ 绑定重启即丢。
 * 现在文件读写挪到主进程（`<userData>/bridge/<file>`），渲染层只保留内存缓存 + 异步水合 + 防抖落盘。
 *
 * 本文件用「假主进程」在内存里模拟那个目录，因此可以真的模拟**重启**：
 * 用完 store A 写入，再用 store B 读同一份「磁盘」，断言绑定还在。
 */

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import {
	BRIDGE_STORE_FILES,
	MAX_BRIDGE_STORE_WRITE_BYTES,
	bridgeStoreFilePath,
	isAllowedBridgeStoreFile,
	resolveBridgeStoreDir,
} from '../../common/bridgeStore.js';
import {
	createIpcBindingStore,
	createIpcSessionMapStore,
	mergeTwoLevel,
	type IIpcStoreBridge,
} from '../../browser/bridge/bridgeIpcStores.js';

const log = { info() { }, warn() { }, error() { }, debug() { }, trace() { } } as never;

const repoRoot = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const CHANNEL_REL = 'src/vs/sessions/contrib/agentStudio/electron-main/bridgeStoreChannel.ts';
const CHAT_BASE_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.base.ts';
const CHAT_DOWNLOADS_REL = 'src/vs/sessions/browser/agentChat/agentChatPanel.dropdowns.ts';
const HOST_REL = 'src/vs/sessions/contrib/agentStudio/browser/nativeChatEditorPane.ts';
const PANE_REL = 'src/vs/sessions/contrib/agentStudio/browser/agentSettingsEditorPane.ts';
const SERVICE_REL = 'src/vs/sessions/contrib/agentStudio/browser/bridge/bridgeService.ts';
const APP_REL = 'src/vs/code/electron-main/app.ts';

/** 假主进程：把 `<userData>/bridge` 目录模拟成内存 Map，并记录写入。 */
function fakeHost(initial: Record<string, string> = {}) {
	const files = new Map<string, string>(Object.entries(initial));
	const writes: Array<{ file: string; json: string }> = [];
	let readGate: Promise<void> | undefined;

	const bridge: IIpcStoreBridge = {
		invoke: async (channel: string, ...args: unknown[]) => {
			const payload = (args[0] ?? {}) as { file?: string; json?: string };
			if (channel === 'vscode:bridgeStoreRead') {
				if (readGate) { await readGate; }
				if (!isAllowedBridgeStoreFile(payload.file)) { return { ok: false, error: '不允许的存储文件' }; }
				const json = files.get(payload.file);
				return json === undefined ? { ok: true } : { ok: true, json };
			}
			if (channel === 'vscode:bridgeStoreWrite') {
				if (!isAllowedBridgeStoreFile(payload.file)) { return { ok: false, error: '不允许的存储文件' }; }
				// 与真实 handler 一致：写前必须可解析
				JSON.parse(payload.json ?? '');
				files.set(payload.file!, payload.json!);
				writes.push({ file: payload.file!, json: payload.json! });
				return { ok: true };
			}
			return { ok: false, error: `unknown channel ${channel}` };
		},
	};

	return { files, writes, bridge, holdReads: (gate: Promise<void>) => { readGate = gate; } };
}

// ─── 纯逻辑 ────────────────────────────────────────────────────────────────

suite('绑定存储 · 纯逻辑（白名单 / 路径拼接 / 合并）', () => {
	test('文件名白名单：只放行三个已知 JSON（杜绝任意路径读写）', () => {
		for (const f of BRIDGE_STORE_FILES) {
			assert.strictEqual(isAllowedBridgeStoreFile(f), true, `${f} 应在白名单`);
		}
		for (const bad of ['../../settings.json', 'C:\\Windows\\system32\\x.json', '', undefined, 42, 'bindings.json.bak']) {
			assert.strictEqual(isAllowedBridgeStoreFile(bad), false, `${String(bad)} 必须被拒 ✗✓`);
		}
	});

	test('目录与路径：<userData>/bridge，Windows 与 POSIX 都能拼（不依赖 node:path）', () => {
		assert.strictEqual(resolveBridgeStoreDir('C:\\Users\\q\\AppData\\Roaming\\VsSarosis'), 'C:\\Users\\q\\AppData\\Roaming\\VsSarosis\\bridge');
		assert.strictEqual(resolveBridgeStoreDir('/home/q/.config/VsSarosis/'), '/home/q/.config/VsSarosis/bridge');
		assert.strictEqual(bridgeStoreFilePath('C:\\a\\bridge', 'bindings.json'), 'C:\\a\\bridge\\bindings.json');
		assert.strictEqual(bridgeStoreFilePath('/a/bridge', 'sessionMap.json'), '/a/bridge/sessionMap.json');
		assert.ok(MAX_BRIDGE_STORE_WRITE_BYTES >= 1024 * 1024, '写入上限应足够容纳绑定表 ✓');
	});

	test('合并策略：默认 overlay 优先；显式 base 优先（两者都不丢对方独有键）', () => {
		const base = { feishu: { k: 'disk' } };
		const overlay = { feishu: { k: 'mem', n: 'mem-only' } };
		assert.deepStrictEqual(mergeTwoLevel(base, overlay), { feishu: { k: 'mem', n: 'mem-only' } });
		assert.deepStrictEqual(mergeTwoLevel(base, overlay, 'base'), { feishu: { k: 'disk', n: 'mem-only' } });
	});

	test('两层合并：overlay（内存改动）优先，且不丢 base（磁盘旧数据）', () => {
		const merged = mergeTwoLevel(
			{ feishu: { oc_old: 'agent-old', oc_share: 'agent-disk' } },
			{ feishu: { oc_new: 'agent-new', oc_share: 'agent-memory' } },
		);
		assert.deepStrictEqual(merged, { feishu: { oc_old: 'agent-old', oc_share: 'agent-memory', oc_new: 'agent-new' } });
	});
});

// ─── 持久化行为（核心回归）────────────────────────────────────────────────

suite('绑定存储 · 重启后仍在（核心回归）', () => {
	test('★★★ 绑定写入磁盘 → 新实例（= 重启）读回同一份数据', async () => {
		const host = fakeHost();

		// 本次会话：绑定两个群
		const store = createIpcBindingStore(log, host.bridge);
		assert.ok(store, '有 IPC 桥时必须拿到持久化 store（不是 undefined）');
		await store!.hydrate();
		store!.setBinding('feishu', 'oc_111', 'agent-a');
		store!.setBinding('feishu', 'oc_222', 'agent-b');
		await store!.flushNow();

		assert.strictEqual(host.writes.length, 1, '防抖 + flushNow ⇒ 一次落盘 ✓');
		assert.strictEqual(host.writes[0].file, 'bindings.json');

		// 「重启」：同一份磁盘（host.files）构造全新 store
		const restarted = createIpcBindingStore(log, host.bridge);
		await restarted!.hydrate();
		assert.strictEqual(restarted!.getBinding('feishu', 'oc_111'), 'agent-a', '★★★ 重启后绑定必须还在 ✗✓');
		assert.strictEqual(restarted!.getBinding('feishu', 'oc_222'), 'agent-b');
		assert.deepStrictEqual(
			restarted!.listBindings('feishu').sort((a, b) => a.conversationId.localeCompare(b.conversationId)),
			[{ conversationId: 'oc_111', agentId: 'agent-a' }, { conversationId: 'oc_222', agentId: 'agent-b' }],
		);
	});

	test('★★★ 会话映射（sessionMap）同样跨重启保留；clear 也会落盘', async () => {
		const host = fakeHost();
		const store = createIpcSessionMapStore(log, host.bridge);
		await store!.hydrate();
		store!.set('feishu', 'oc_1', 'agent-a', 'session-1');
		await store!.flushNow();

		const restarted = createIpcSessionMapStore(log, host.bridge);
		await restarted!.hydrate();
		assert.deepStrictEqual(restarted!.get('feishu', 'oc_1'), { agentId: 'agent-a', agentSessionId: 'session-1' });

		// 解绑后重启：必须真的消失（否则旧会话被复用会串台）
		restarted!.clear('feishu', 'oc_1');
		await restarted!.flushNow();
		const again = createIpcSessionMapStore(log, host.bridge);
		await again!.hydrate();
		assert.strictEqual(again!.get('feishu', 'oc_1'), undefined);
		assert.deepStrictEqual(again!.list('feishu'), []);
	});

	test('★★ 水合期间发生的绑定改动不会被磁盘内容覆盖（merge + 补偿落盘）', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const host = fakeHost({ 'bindings.json': JSON.stringify({ feishu: { oc_old: 'agent-old' } }) });
		host.holdReads(gate);

		const store = createIpcBindingStore(log, host.bridge)!;
		store.setBinding('feishu', 'oc_new', 'agent-new');   // 此时水合尚未完成
		release();
		await store.hydrate();

		assert.strictEqual(store.getBinding('feishu', 'oc_old'), 'agent-old', '磁盘旧绑定要读回来 ✓');
		assert.strictEqual(store.getBinding('feishu', 'oc_new'), 'agent-new', '★ 水合期间的新绑定不能被覆盖 ✗✓');
		assert.ok(host.writes.length >= 1, '★ 水合完成后必须补偿落盘，否则新绑定随退出丢失 ✗✓');
	});

	test('★ 首次运行（文件不存在）不算错误：读回空、可正常写入', async () => {
		const host = fakeHost();
		const store = createIpcBindingStore(log, host.bridge)!;
		await store.hydrate();
		assert.deepStrictEqual(store.listBindings('feishu'), []);
		store.setBinding('feishu', 'oc_1', 'agent-a');
		await store.flushNow();
		assert.strictEqual(host.writes.length, 1);
	});

	test('★★ 会话映射的水合冲突：磁盘优先（启动瞬间新建的会话不能顶掉已持久化映射）', async () => {
		let release!: () => void;
		const gate = new Promise<void>(r => { release = r; });
		const host = fakeHost({
			'sessionMap.json': JSON.stringify({ feishu: { oc_1: { agentId: 'agent-a', agentSessionId: 'session-persisted' } } }),
		});
		host.holdReads(gate);

		const store = createIpcSessionMapStore(log, host.bridge)!;
		store.set('feishu', 'oc_1', 'agent-a', 'session-newly-created');  // 水合前的自动写入（尚不知已有映射）
		store.set('feishu', 'oc_2', 'agent-a', 'session-2');              // 新群：磁盘没有，应保留
		release();
		await store.hydrate();

		assert.deepStrictEqual(store.get('feishu', 'oc_1'), { agentId: 'agent-a', agentSessionId: 'session-persisted' },
			'★ 磁盘映射优先 —— 否则启动瞬间的自动写入会把老映射顶掉（串台）✗✓');
		assert.deepStrictEqual(store.get('feishu', 'oc_2'), { agentId: 'agent-a', agentSessionId: 'session-2' },
			'磁盘没有的键必须保留 ✓');
	});

	test('★ 桥不可用（非 Electron / preload 未注入）→ 返回 undefined，引擎沿用内存兜底', () => {
		assert.strictEqual(createIpcBindingStore(log, undefined), undefined);
		assert.strictEqual(createIpcSessionMapStore(log, undefined), undefined);
	});

	test('主进程写失败不抛错（绑定操作不能被存储故障打断）', async () => {
		const failing: IIpcStoreBridge = { invoke: async () => ({ ok: false, error: '磁盘只读' }) };
		const store = createIpcBindingStore(log, failing)!;
		await store.hydrate();
		store.setBinding('feishu', 'oc_1', 'agent-a');   // 不应抛
		await store.flushNow();
		assert.strictEqual(store.getBinding('feishu', 'oc_1'), 'agent-a', '内存态仍然生效 ✓');
	});
});

// ─── 接线守卫 ──────────────────────────────────────────────────────────────

suite('绑定存储 · 接线守卫', () => {
	test('★★★ bridgeService 必须用主进程 IPC 存储（旧 file store 在生产环境永远不可用）', () => {
		const svc = read(SERVICE_REL);
		assert.ok(svc.includes('createIpcBindingStore(this._log)'), '★ 绑定必须接 IPC store ✗✓');
		assert.ok(svc.includes('createIpcSessionMapStore(this._log)'), '★ 会话映射必须接 IPC store ✗✓');
		assert.ok(/bindingsStore: .*createIpcBindingStore\(this\._log\).*\?\?/.test(svc),
			'★ IPC 必须优先于 file store（否则又退回内存态）✗✓');
		assert.ok(/sessionMapStore: .*createIpcSessionMapStore\(this\._log\).*\?\?/.test(svc),
			'★ 同上：sessionMap 的兜底顺序不能反 ✗✓');
	});

	test('★★★ app.ts 必须注册 BridgeStoreChannel（否则渲染层 invoke 永远失败）', () => {
		const app = read(APP_REL);
		assert.ok(app.includes("electron-main/bridgeStoreChannel.js'"), 'app.ts 必须 import 通道 ✓');
		assert.ok(/this\._register\(new BridgeStoreChannel\(/.test(app), '★ 必须注册（漏了 = 绑定又变内存态）✗✓');
	});

	test('★★★ 水合等待接线（IPC 读盘是异步的；不等就会「重启后列表为空」）', () => {
		const svc = read(SERVICE_REL);
		assert.ok(svc.includes('ensureBindingsLoaded(): Promise<void>;'), 'IBridgeService 必须暴露 ensureBindingsLoaded ✗✓');
		assert.ok(/async ensureBindingsLoaded\(\): Promise<void> \{/.test(svc), '必须实现该方法 ✗✓');
		assert.ok(svc.includes('this._bindingsStore?.hydrate()') && svc.includes('this._sessionMapStore?.hydrate()'),
			'必须 await 两个 store 的水合 ✗✓');

		const base = read(CHAT_BASE_REL);
		assert.ok(base.includes('_onEnsureBindingsLoaded?: () => Promise<void>'), '面板必须声明该 hook ✗✓');
		assert.ok(base.includes('this._onEnsureBindingsLoaded = opts.onEnsureBindingsLoaded;'), '必须从 opts 接上 ✗✓');

		const dd = read(CHAT_DOWNLOADS_REL);
		assert.ok(dd.includes('this._onEnsureBindingsLoaded().then(() => renderList())'),
			'★ 面板必须在渲染后等水合、再重绘绑定列表（否则首次打开是空表）✗✓');

		const host = read(HOST_REL);
		assert.ok(host.includes('onEnsureBindingsLoaded: () => this._bridgeService.ensureBindingsLoaded()'),
			'host 必须注入 ✗✓');

		const pane = read(PANE_REL);
		assert.ok(pane.includes('ensureBindingsLoaded().then(') && pane.includes('_bindingsHydrated'),
			'editorpane 也要等水合后重绘（否则只修了一半）✗✓');
	});

	test('★★ 主进程 handler：文件名白名单 + 写前 JSON 校验 + 落盘目录来自 userData（不是 cwd）', () => {
		const ch = read(CHANNEL_REL);
		assert.ok(ch.includes("validatedIpcMain.handle('vscode:bridgeStoreRead'"), '必须有读 handler ✓');
		assert.ok(ch.includes("validatedIpcMain.handle('vscode:bridgeStoreWrite'"), '必须有写 handler ✓');
		assert.ok(ch.includes('isAllowedBridgeStoreFile'), '★ 必须走白名单校验（不能变成任意文件读写）✗✓');
		assert.ok(ch.includes('JSON.parse(json)'), '★ 写前必须校验可解析（防写坏文件）✗✓');
		assert.ok(ch.includes("app.getPath('userData')"), '★ 必须用 userData 目录（cwd 随启动方式变化）✗✓');
		// 只在**代码**里断言（注释里会解释历史缺陷、必然提到 process.cwd()）
		const codeOnly = ch.split(/\r?\n/).filter(l => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
		assert.ok(!codeOnly.includes('process.cwd()'), '★ 不得再依赖 cwd（代码里也不许）✗✓');
	});
});
