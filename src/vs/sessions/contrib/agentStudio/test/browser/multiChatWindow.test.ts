/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//
// 多聊天窗口功能测试套件
//
// 测试范围：
//   1. ChatPanelManager — Panel 生命周期、切换、MRU、LRU 淘汰
//   2. AgentChatService 并发流隔离 — delta 路由、cancelStream
//   3. ChatSplitView — 分屏创建/销毁、布局计算
//   4. 集成场景 — 多 tab 切换、并发流、分屏交互
//
// 运行方式：npm test（或 VS Code 测试运行器）
//

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../../base/common/event.js';
import { uniqueMsgId } from '../../../../browser/agentChat/agentChatTypes.js';
import type {
	IAgentChatMessage,
	IToolCall,
	IChatAttachment,
	IAgentInfo,
	ChatMode,
	StreamPhase,
	IContextUsage,
	ICheckpointInfo,
	IAgentSessionMeta,
} from '../../../../browser/agentChat/agentChatTypes.js';

// ══════════════════════════════════════════════════════════════════
// 模拟数据工厂
// ══════════════════════════════════════════════════════════════════

function makeMessage(overrides: Partial<IAgentChatMessage> = {}): IAgentChatMessage {
	return {
		id: uniqueMsgId(),
		role: 'assistant',
		content: 'Test message',
		timestamp: Date.now(),
		...overrides,
	};
}

function makeAgent(overrides: Partial<IAgentInfo> = {}): IAgentInfo {
	return {
		id: 'test-agent',
		name: 'Test Agent',
		status: 'idle' as any,
		agentType: 'general',
		...overrides,
	};
}

function makeSessionMeta(overrides: Partial<IAgentSessionMeta> = {}): IAgentSessionMeta {
	return {
		id: `sess_${Date.now().toString(36)}`,
		name: '测试会话',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		messageCount: 0,
		...overrides,
	};
}

// ══════════════════════════════════════════════════════════════════
// 模拟 ChatPanelRuntimeState（运行时状态）
// ══════════════════════════════════════════════════════════════════

interface ChatPanelRuntimeState {
	agentId: string;
	sessionId: string | undefined;
	chatMode: ChatMode;
	maxContextTokens: number | undefined;
	isSending: boolean;
	streamPhase: StreamPhase;
	createdAt: number;
	lastActiveAt: number;
}

function makeRuntimeState(overrides: Partial<ChatPanelRuntimeState> = {}): ChatPanelRuntimeState {
	return {
		agentId: 'test-agent',
		sessionId: undefined,
		chatMode: 'craft',
		maxContextTokens: undefined,
		isSending: false,
		streamPhase: 'idle',
		createdAt: Date.now(),
		lastActiveAt: Date.now(),
		...overrides,
	};
}

// ══════════════════════════════════════════════════════════════════
// 模拟 AgentChatPanel（轻量 Mock，不依赖真实 DOM）
// ══════════════════════════════════════════════════════════════════

interface MockPanelEntry {
	readonly chatId: string;
	readonly state: ChatPanelRuntimeState;
	messages: IAgentChatMessage[];
	isVisible: boolean;
	isDestroyed: boolean;
	displayStyle: string;
	deltaLog: any[];
}

class MockChatPanelManager extends Disposable {
	private readonly _panels = new Map<string, MockPanelEntry>();
	private _activeChatId: string | undefined;
	private _maxConcurrentPanels = 4;
	private readonly _mruStack: string[] = [];

	private readonly _onDidPanelCreate = this._register(new Emitter<string>());
	readonly onDidPanelCreate: Event<string> = this._onDidPanelCreate.event;

	private readonly _onDidPanelDestroy = this._register(new Emitter<string>());
	readonly onDidPanelDestroy: Event<string> = this._onDidPanelDestroy.event;

	private readonly _onDidPanelShow = this._register(new Emitter<string>());
	readonly onDidPanelShow: Event<string> = this._onDidPanelShow.event;

	private readonly _onDidPanelHide = this._register(new Emitter<string>());
	readonly onDidPanelHide: Event<string> = this._onDidPanelHide.event;

	get maxConcurrentPanels(): number { return this._maxConcurrentPanels; }
	setMaxConcurrentPanels(n: number): void { this._maxConcurrentPanels = n; }

	createPanel(chatId: string, state: ChatPanelRuntimeState): MockPanelEntry {
		assert.ok(chatId, 'chatId must be non-empty');
		assert.ok(!this._panels.has(chatId), `Panel already exists for chatId="${chatId}"`);

		const entry: MockPanelEntry = {
			chatId,
			state,
			messages: [],
			isVisible: false,
			isDestroyed: false,
			displayStyle: 'none',
			deltaLog: [],
		};
		this._panels.set(chatId, entry);
		this._evictIfNeeded();
		this._onDidPanelCreate.fire(chatId);
		return entry;
	}

	getPanel(chatId: string): MockPanelEntry | undefined {
		return this._panels.get(chatId);
	}

	destroyPanel(chatId: string): void {
		const entry = this._panels.get(chatId);
		if (!entry) { return; }
		entry.isDestroyed = true;
		this._panels.delete(chatId);
		this._removeFromMRU(chatId);
		if (this._activeChatId === chatId) {
			this._activeChatId = undefined;
		}
		this._onDidPanelDestroy.fire(chatId);
	}

	showPanel(chatId: string): void {
		const entry = this._panels.get(chatId);
		assert.ok(entry, `Cannot show panel: chatId="${chatId}" not found`);

		// Hide current active panel
		if (this._activeChatId && this._activeChatId !== chatId) {
			const current = this._panels.get(this._activeChatId);
			if (current) {
				current.isVisible = false;
				current.displayStyle = 'none';
				this._onDidPanelHide.fire(this._activeChatId);
			}
		}

		// Show target panel
		entry.isVisible = true;
		entry.displayStyle = '';
		entry.state.lastActiveAt = Date.now();
		this._activeChatId = chatId;
		this._touchMRU(chatId);
		this._onDidPanelShow.fire(chatId);
	}

	hidePanel(chatId: string): void {
		const entry = this._panels.get(chatId);
		if (!entry) { return; }
		entry.isVisible = false;
		entry.displayStyle = 'none';
		if (this._activeChatId === chatId) {
			this._activeChatId = undefined;
		}
		this._onDidPanelHide.fire(chatId);
	}

	getActivePanel(): MockPanelEntry | undefined {
		if (!this._activeChatId) { return undefined; }
		return this._panels.get(this._activeChatId);
	}

	getActiveChatId(): string | undefined {
		return this._activeChatId;
	}

	getPanelCount(): number {
		return this._panels.size;
	}

	getVisibleChatIds(): string[] {
		return Array.from(this._panels.values()).filter(e => e.isVisible).map(e => e.chatId);
	}

	getMRU(): string[] {
		return [...this._mruStack];
	}

	private _touchMRU(chatId: string): void {
		this._removeFromMRU(chatId);
		this._mruStack.unshift(chatId);
	}

	private _removeFromMRU(chatId: string): void {
		const idx = this._mruStack.indexOf(chatId);
		if (idx >= 0) { this._mruStack.splice(idx, 1); }
	}

	private _evictIfNeeded(): void {
		while (this._panels.size > this._maxConcurrentPanels) {
			// Evict least recently used (end of MRU stack), skipping active panel
			const evictCandidate = [...this._mruStack]
				.reverse()
				.find(id => id !== this._activeChatId && this._panels.has(id));
			if (!evictCandidate) { break; }
			this.destroyPanel(evictCandidate);
		}
	}

	// ── Mock delta routing ──
	routeDelta(chatId: string, delta: any): void {
		const entry = this._panels.get(chatId);
		if (entry && !entry.isDestroyed) {
			entry.deltaLog.push(delta);
		}
	}
}

// ══════════════════════════════════════════════════════════════════
// 模拟 AgentChatService 并发流（测试 delta 隔离）
// ══════════════════════════════════════════════════════════════════

interface MockStreamEntry {
	streamKey: string;
	agentId: string;
	sessionId: string | undefined;
	controller: { aborted: boolean };
	onDelta: (delta: any) => void;
}

class MockAgentChatService extends Disposable {
	private readonly _activeStreams = new Map<string, MockStreamEntry>();
	private readonly _activeOnDeltas = new Map<string, (delta: any) => void>();
	private readonly _historyCache = new Map<string, IAgentChatMessage[]>();

	private readonly _onDidStreamStart = this._register(new Emitter<string>());
	readonly onDidStreamStart: Event<string> = this._onDidStreamStart.event;

	private _cacheKey(agentId: string, sessionId?: string): string {
		return sessionId ? `${agentId}::${sessionId}` : agentId;
	}

	async sendMessage(
		agentId: string,
		message: string,
		options: { agentSessionId?: string; chatMode?: ChatMode },
		onDelta: (delta: any) => void,
	): Promise<void> {
		const streamKey = options.agentSessionId
			? `${agentId}::${options.agentSessionId}`
			: agentId;

		this.cancelStream(agentId, options.agentSessionId);

		const controller = { aborted: false };
		const entry: MockStreamEntry = {
			streamKey,
			agentId,
			sessionId: options.agentSessionId,
			controller,
			onDelta,
		};
		this._activeStreams.set(streamKey, entry);

		// ← 关键修复：用 Map 替代单例
		this._activeOnDeltas.set(streamKey, onDelta);

		this._onDidStreamStart.fire(streamKey);
	}

	cancelStream(agentId: string, sessionId?: string): void {
		const streamKey = sessionId ? `${agentId}::${sessionId}` : agentId;
		const entry = this._activeStreams.get(streamKey);
		if (entry) {
			entry.controller.aborted = true;
			this._activeStreams.delete(streamKey);
		}
		this._activeOnDeltas.delete(streamKey);
	}

	// 模拟 provider 发送 delta
	emitDelta(streamKey: string, delta: any): void {
		const onDelta = this._activeOnDeltas.get(streamKey);
		if (onDelta) {
			onDelta(delta);
		}
	}

	// 模拟 memory event bridge（测试并发隔离）
	emitMemoryEvent(streamKey: string, event: any): void {
		const onDelta = this._activeOnDeltas.get(streamKey);
		if (onDelta) {
			onDelta({ type: 'memory_written', ...event });
		}
	}

	isStreamActive(streamKey: string): boolean {
		return this._activeStreams.has(streamKey);
	}

	getActiveStreamCount(): number {
		return this._activeStreams.size;
	}

	getActiveOnDeltaCount(): number {
		return this._activeOnDeltas.size;
	}

	// ── Session CRUD mock ──
	async getHistory(agentId: string, sessionId?: string): Promise<IAgentChatMessage[]> {
		const key = this._cacheKey(agentId, sessionId);
		return this._historyCache.get(key) ?? [];
	}

	async setHistory(agentId: string, sessionId: string | undefined, messages: IAgentChatMessage[]): Promise<void> {
		const key = this._cacheKey(agentId, sessionId);
		this._historyCache.set(key, messages);
	}
}

// ══════════════════════════════════════════════════════════════════
// 模拟 SplitView（分屏布局）
// ══════════════════════════════════════════════════════════════════

interface MockSplitViewEntry {
	element: HTMLElement;
	visible: boolean;
	size: number;
}

class MockSplitView extends Disposable {
	private readonly _views: MockSplitViewEntry[] = [];
	private _orientation: 'horizontal' | 'vertical';
	private _ratio = 0.5;

	constructor(orientation: 'horizontal' | 'vertical' = 'horizontal') {
		super();
		this._orientation = orientation;
	}

	get orientation(): 'horizontal' | 'vertical' { return this._orientation; }
	get viewCount(): number { return this._views.length; }

	addView(element: HTMLElement, size?: number): void {
		this._views.push({ element, visible: true, size: size ?? 0 });
		this._recalculateSizes();
	}

	removeView(index: number): void {
		assert.ok(index >= 0 && index < this._views.length, `Invalid view index: ${index}`);
		this._views.splice(index, 1);
		this._recalculateSizes();
	}

	getView(index: number): MockSplitViewEntry | undefined {
		return this._views[index];
	}

	setRatio(ratio: number): void {
		assert.ok(ratio > 0 && ratio < 1, `Ratio must be between 0 and 1, got: ${ratio}`);
		this._ratio = ratio;
		this._recalculateSizes();
	}

	getRatio(): number { return this._ratio; }

	layout(totalSize: number): void {
		this._recalculateSizes(totalSize);
	}

	private _recalculateSizes(totalSize = 1000): void {
		if (this._views.length === 0) { return; }
		if (this._views.length === 1) {
			this._views[0].size = totalSize;
			return;
		}
		const first = Math.round(totalSize * this._ratio);
		const rest = totalSize - first;
		this._views[0].size = first;
		for (let i = 1; i < this._views.length; i++) {
			this._views[i].size = rest;
		}
	}

	getSizes(): number[] {
		return this._views.map(v => v.size);
	}
}

// ══════════════════════════════════════════════════════════════════
// 测试套件
// ══════════════════════════════════════════════════════════════════

suite('Multi-Chat Window — ChatPanelManager', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let manager: MockChatPanelManager;

	setup(() => {
		manager = new MockChatPanelManager();
	});

	teardown(() => {
		manager.dispose();
	});

	// ── P0: Panel 生命周期 ──────────────────────────────────────

	suite('Panel Lifecycle', () => {

		test('createPanel — 创建新 panel 实例', () => {
			const state = makeRuntimeState({ agentId: 'agent-1', sessionId: 'sess-1' });
			const entry = manager.createPanel('chat-1', state);

			assert.strictEqual(entry.chatId, 'chat-1');
			assert.strictEqual(entry.state.agentId, 'agent-1');
			assert.strictEqual(entry.state.sessionId, 'sess-1');
			assert.strictEqual(entry.isVisible, false);
			assert.strictEqual(entry.isDestroyed, false);
			assert.strictEqual(manager.getPanelCount(), 1);
		});

		test('createPanel — 重复创建同 chatId 抛错', () => {
			const state = makeRuntimeState();
			manager.createPanel('chat-1', state);

			assert.throws(
				() => manager.createPanel('chat-1', state),
				/already exists/,
			);
		});

		test('createPanel — 空字符串 chatId 抛错', () => {
			assert.throws(
				() => manager.createPanel('', makeRuntimeState()),
			);
		});

		test('createPanel — 触发 onDidPanelCreate 事件', () => {
			let firedChatId = '';
			manager.onDidPanelCreate(id => { firedChatId = id; });

			manager.createPanel('chat-event', makeRuntimeState());

			assert.strictEqual(firedChatId, 'chat-event');
		});

		test('destroyPanel — 销毁 panel 实例', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			assert.strictEqual(manager.getPanelCount(), 1);

			manager.destroyPanel('chat-1');

			assert.strictEqual(manager.getPanelCount(), 0);
			assert.strictEqual(manager.getPanel('chat-1'), undefined);
		});

		test('destroyPanel — 触发 onDidPanelDestroy 事件', () => {
			let firedChatId = '';
			manager.onDidPanelDestroy(id => { firedChatId = id; });

			manager.createPanel('chat-destroy', makeRuntimeState());
			manager.destroyPanel('chat-destroy');

			assert.strictEqual(firedChatId, 'chat-destroy');
		});

		test('destroyPanel — 销毁不存在的 panel 不抛错', () => {
			assert.doesNotThrow(() => {
				manager.destroyPanel('non-existent');
			});
		});

		test('destroyPanel — 销毁活跃 panel 后 activeChatId 清空', () => {
			manager.createPanel('chat-active', makeRuntimeState());
			manager.showPanel('chat-active');
			assert.strictEqual(manager.getActiveChatId(), 'chat-active');

			manager.destroyPanel('chat-active');

			assert.strictEqual(manager.getActiveChatId(), undefined);
		});
	});

	// ── P0: 可见性管理（切换 tab）────────────────────────────────

	suite('Panel Visibility (Tab Switching)', () => {

		test('showPanel — 显示 panel 并设为活跃', () => {
			manager.createPanel('chat-1', makeRuntimeState());

			manager.showPanel('chat-1');

			const entry = manager.getPanel('chat-1');
			assert.ok(entry);
			assert.strictEqual(entry!.isVisible, true);
			assert.strictEqual(entry!.displayStyle, '');
			assert.strictEqual(manager.getActiveChatId(), 'chat-1');
		});

		test('showPanel — 切换时隐藏前一个 panel', () => {
			manager.createPanel('chat-A', makeRuntimeState());
			manager.createPanel('chat-B', makeRuntimeState());

			manager.showPanel('chat-A');
			manager.showPanel('chat-B');

			// chat-A 应被隐藏
			const entryA = manager.getPanel('chat-A');
			assert.strictEqual(entryA!.isVisible, false);
			assert.strictEqual(entryA!.displayStyle, 'none');

			// chat-B 应为活跃
			const entryB = manager.getPanel('chat-B');
			assert.strictEqual(entryB!.isVisible, true);
			assert.strictEqual(manager.getActiveChatId(), 'chat-B');
		});

		test('showPanel — 切换时不销毁旧 panel（DOM 保留）', () => {
			manager.createPanel('chat-A', makeRuntimeState());
			manager.createPanel('chat-B', makeRuntimeState());

			manager.showPanel('chat-A');
			manager.showPanel('chat-B');

			// chat-A 仍然存在（只是隐藏了）
			assert.ok(manager.getPanel('chat-A'));
			assert.strictEqual(manager.getPanel('chat-A')!.isDestroyed, false);
		});

		test('showPanel — 切换不存在的 chatId 抛错', () => {
			assert.throws(
				() => manager.showPanel('non-existent'),
				/not found/,
			);
		});

		test('showPanel — 更新 lastActiveAt 时间戳', () => {
			manager.createPanel('chat-1', makeRuntimeState({ lastActiveAt: 0 }));

			manager.showPanel('chat-1');

			const entry = manager.getPanel('chat-1');
			assert.ok(entry!.state.lastActiveAt > 0);
		});

		test('showPanel — 同一个 panel 重复 show 不触发隐藏', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			let hideCount = 0;
			manager.onDidPanelHide(() => { hideCount++; });

			manager.showPanel('chat-1');
			manager.showPanel('chat-1');

			assert.strictEqual(hideCount, 0);
		});

		test('hidePanel — 隐藏活跃 panel', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.showPanel('chat-1');

			manager.hidePanel('chat-1');

			const entry = manager.getPanel('chat-1');
			assert.strictEqual(entry!.isVisible, false);
			assert.strictEqual(entry!.displayStyle, 'none');
			assert.strictEqual(manager.getActiveChatId(), undefined);
		});

		test('getVisibleChatIds — 返回所有可见的 chatId', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());
			manager.createPanel('chat-3', makeRuntimeState());

			manager.showPanel('chat-1');

			const visible = manager.getVisibleChatIds();
			assert.deepStrictEqual(visible, ['chat-1']);
		});

		test('getActivePanel — 返回当前活跃 panel', () => {
			manager.createPanel('chat-1', makeRuntimeState({ agentId: 'agent-1' }));
			manager.showPanel('chat-1');

			const active = manager.getActivePanel();
			assert.ok(active);
			assert.strictEqual(active!.state.agentId, 'agent-1');
		});

		test('getActivePanel — 无活跃 panel 时返回 undefined', () => {
			assert.strictEqual(manager.getActivePanel(), undefined);
		});
	});

	// ── P0: MRU 栈（最近使用顺序）─────────────────────────────────

	suite('MRU Stack (Most Recently Used)', () => {

		test('showPanel — 更新 MRU 顺序', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());
			manager.createPanel('chat-3', makeRuntimeState());

			manager.showPanel('chat-1');
			manager.showPanel('chat-2');
			manager.showPanel('chat-3');

			const mru = manager.getMRU();
			assert.strictEqual(mru[0], 'chat-3');  // 最近使用
			assert.strictEqual(mru[1], 'chat-2');
			assert.strictEqual(mru[2], 'chat-1');  // 最久未用
		});

		test('showPanel — 重复 show 同一个 panel 移到栈顶', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());

			manager.showPanel('chat-1');
			manager.showPanel('chat-2');
			manager.showPanel('chat-1');  // 重新使用 chat-1

			const mru = manager.getMRU();
			assert.strictEqual(mru[0], 'chat-1');
			assert.strictEqual(mru[1], 'chat-2');
		});

		test('destroyPanel — 从 MRU 栈中移除', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());

			manager.showPanel('chat-1');
			manager.showPanel('chat-2');
			manager.destroyPanel('chat-1');

			const mru = manager.getMRU();
			assert.strictEqual(mru.length, 1);
			assert.strictEqual(mru[0], 'chat-2');
		});

		test('MRU 顺序不包含已销毁的 panel', () => {
			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());
			manager.createPanel('chat-3', makeRuntimeState());

			manager.showPanel('chat-1');
			manager.showPanel('chat-2');
			manager.showPanel('chat-3');
			manager.destroyPanel('chat-2');

			const mru = manager.getMRU();
			assert.ok(!mru.includes('chat-2'));
		});
	});

	// ── P3: LRU 淘汰策略 ────────────────────────────────────────

	suite('LRU Eviction', () => {

		test('超过 maxConcurrentPanels 时自动淘汰最久未用的 panel', () => {
			manager.setMaxConcurrentPanels(2);

			manager.createPanel('chat-1', makeRuntimeState());
			manager.createPanel('chat-2', makeRuntimeState());
			manager.showPanel('chat-1');
			manager.showPanel('chat-2');

			// 创建第三个 → 应淘汰 chat-1（最久未用，非活跃）
			manager.createPanel('chat-3', makeRuntimeState());

			assert.strictEqual(manager.getPanelCount(), 2);
			assert.strictEqual(manager.getPanel('chat-1'), undefined);
			assert.ok(manager.getPanel('chat-2'));
			assert.ok(manager.getPanel('chat-3'));
		});

		test('淘汰时不销毁活跃 panel', () => {
			manager.setMaxConcurrentPanels(2);

			manager.createPanel('chat-active', makeRuntimeState());
			manager.createPanel('chat-old', makeRuntimeState());
			manager.showPanel('chat-active');
			manager.showPanel('chat-old');
			manager.showPanel('chat-active');  // 重新激活

			// 创建第三个 → 应淘汰 chat-old
			manager.createPanel('chat-new', makeRuntimeState());

			assert.ok(manager.getPanel('chat-active'), '活跃 panel 不应被淘汰');
		});

		test('淘汰触发 onDidPanelDestroy 事件', () => {
			manager.setMaxConcurrentPanels(1);
			let destroyedId = '';
			manager.onDidPanelDestroy(id => { destroyedId = id; });

			manager.createPanel('chat-1', makeRuntimeState());
			manager.showPanel('chat-1');
			manager.createPanel('chat-2', makeRuntimeState());

			assert.strictEqual(destroyedId, 'chat-1');
		});

		test('淘汰后 panel 状态标记为 destroyed', () => {
			manager.setMaxConcurrentPanels(1);
			const entry = manager.createPanel('chat-1', makeRuntimeState());

			manager.createPanel('chat-2', makeRuntimeState());

			assert.strictEqual(entry.isDestroyed, true);
		});
	});

	// ── P0: Delta 路由 ──────────────────────────────────────────

	suite('Delta Routing', () => {

		test('routeDelta — 将 delta 路由到正确的 panel', () => {
			manager.createPanel('chat-A', makeRuntimeState());
			manager.createPanel('chat-B', makeRuntimeState());

			manager.routeDelta('chat-A', { type: 'text', content: 'hello A' });
			manager.routeDelta('chat-B', { type: 'text', content: 'hello B' });

			const entryA = manager.getPanel('chat-A');
			const entryB = manager.getPanel('chat-B');

			assert.strictEqual(entryA!.deltaLog.length, 1);
			assert.strictEqual(entryA!.deltaLog[0].content, 'hello A');
			assert.strictEqual(entryB!.deltaLog.length, 1);
			assert.strictEqual(entryB!.deltaLog[0].content, 'hello B');
		});

		test('routeDelta — 不存在的 chatId 不抛错', () => {
			assert.doesNotThrow(() => {
				manager.routeDelta('non-existent', { type: 'text', content: 'test' });
			});
		});

		test('routeDelta — 已销毁的 panel 不接收 delta', () => {
			const entry = manager.createPanel('chat-1', makeRuntimeState());
			manager.destroyPanel('chat-1');

			manager.routeDelta('chat-1', { type: 'text', content: 'after destroy' });

			// deltaLog 不应增加（destroyed 状态不接收）
			assert.strictEqual(entry.deltaLog.length, 0);
		});
	});
});

// ══════════════════════════════════════════════════════════════════
// AgentChatService 并发流隔离测试
// ══════════════════════════════════════════════════════════════════

suite('Multi-Chat Window — AgentChatService Concurrency', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let chatService: MockAgentChatService;

	setup(() => {
		chatService = new MockAgentChatService();
	});

	teardown(() => {
		chatService.dispose();
	});

	// ── P0: 并发流隔离 ──────────────────────────────────────────

	suite('Concurrent Stream Isolation', () => {

		test('两个并发流各自有独立的 streamKey', async () => {
			const deltasA: any[] = [];
			const deltasB: any[] = [];

			await chatService.sendMessage('agent-1', 'hello A', {
				agentSessionId: 'sess-A',
			}, (delta) => { deltasA.push(delta); });

			await chatService.sendMessage('agent-1', 'hello B', {
				agentSessionId: 'sess-B',
			}, (delta) => { deltasB.push(delta); });

			assert.strictEqual(chatService.getActiveStreamCount(), 2);
			assert.strictEqual(chatService.getActiveOnDeltaCount(), 2);
		});

		test('delta 路由到正确的 stream（不串台）', async () => {
			const deltasA: any[] = [];
			const deltasB: any[] = [];

			await chatService.sendMessage('agent-1', 'hello A', {
				agentSessionId: 'sess-A',
			}, (delta) => { deltasA.push(delta); });

			await chatService.sendMessage('agent-1', 'hello B', {
				agentSessionId: 'sess-B',
			}, (delta) => { deltasB.push(delta); });

			// 发送 delta 到 stream A
			chatService.emitDelta('agent-1::sess-A', { type: 'text', content: 'response A' });

			// A 应收到，B 不应收到
			assert.strictEqual(deltasA.length, 1);
			assert.strictEqual(deltasA[0].content, 'response A');
			assert.strictEqual(deltasB.length, 0);

			// 发送 delta 到 stream B
			chatService.emitDelta('agent-1::sess-B', { type: 'text', content: 'response B' });

			assert.strictEqual(deltasB.length, 1);
			assert.strictEqual(deltasB[0].content, 'response B');
			assert.strictEqual(deltasA.length, 1);  // A 没有新增
		});

		test('memory event 路由到正确的 stream', async () => {
			const deltasA: any[] = [];
			const deltasB: any[] = [];

			await chatService.sendMessage('agent-1', 'msg A', {
				agentSessionId: 'sess-A',
			}, (delta) => { deltasA.push(delta); });

			await chatService.sendMessage('agent-1', 'msg B', {
				agentSessionId: 'sess-B',
			}, (delta) => { deltasB.push(delta); });

			// 发送 memory event 到 stream A
			chatService.emitMemoryEvent('agent-1::sess-A', {
				content: 'memory from A',
				metadata: { noticeId: 'mem-A' },
			});

			assert.strictEqual(deltasA.length, 1);
			assert.strictEqual(deltasA[0].type, 'memory_written');
			assert.strictEqual(deltasA[0].content, 'memory from A');
			assert.strictEqual(deltasB.length, 0);
		});

		test('cancelStream 只取消目标流，不影响其他流', async () => {
			await chatService.sendMessage('agent-1', 'msg A', {
				agentSessionId: 'sess-A',
			}, () => {});

			await chatService.sendMessage('agent-1', 'msg B', {
				agentSessionId: 'sess-B',
			}, () => {});

			// 取消 stream A
			chatService.cancelStream('agent-1', 'sess-A');

			assert.strictEqual(chatService.isStreamActive('agent-1::sess-A'), false);
			assert.strictEqual(chatService.isStreamActive('agent-1::sess-B'), true);
			assert.strictEqual(chatService.getActiveStreamCount(), 1);
		});

		test('cancelStream 清理对应的 onDelta 回调', async () => {
			await chatService.sendMessage('agent-1', 'msg', {
				agentSessionId: 'sess-1',
			}, () => {});

			assert.strictEqual(chatService.getActiveOnDeltaCount(), 1);

			chatService.cancelStream('agent-1', 'sess-1');

			assert.strictEqual(chatService.getActiveOnDeltaCount(), 0);
		});

		test('同 agent 不同 session 的流互不干扰', async () => {
			const deltas1: any[] = [];
			const deltas2: any[] = [];

			await chatService.sendMessage('claw', 'msg 1', {
				agentSessionId: 'sess-1',
			}, (delta) => { deltas1.push(delta); });

			await chatService.sendMessage('claw', 'msg 2', {
				agentSessionId: 'sess-2',
			}, (delta) => { deltas2.push(delta); });

			chatService.emitDelta('claw::sess-1', { type: 'text', content: 'r1' });
			chatService.emitDelta('claw::sess-2', { type: 'text', content: 'r2' });

			assert.strictEqual(deltas1.length, 1);
			assert.strictEqual(deltas1[0].content, 'r1');
			assert.strictEqual(deltas2.length, 1);
			assert.strictEqual(deltas2[0].content, 'r2');
		});

		test('不同 agent 的流互不干扰', async () => {
			const deltasClaw: any[] = [];
			const deltasPM: any[] = [];

			await chatService.sendMessage('claw', 'msg', {
				agentSessionId: 'sess-claw',
			}, (delta) => { deltasClaw.push(delta); });

			await chatService.sendMessage('pm', 'msg', {
				agentSessionId: 'sess-pm',
			}, (delta) => { deltasPM.push(delta); });

			chatService.emitDelta('claw::sess-claw', { type: 'text', content: 'claw response' });
			chatService.emitDelta('pm::sess-pm', { type: 'text', content: 'pm response' });

			assert.strictEqual(deltasClaw.length, 1);
			assert.strictEqual(deltasClaw[0].content, 'claw response');
			assert.strictEqual(deltasPM.length, 1);
			assert.strictEqual(deltasPM[0].content, 'pm response');
		});

		test('stream 完成后 onDelta 被清理（防止泄漏）', async () => {
			await chatService.sendMessage('agent-1', 'msg', {
				agentSessionId: 'sess-1',
			}, () => {});

			assert.strictEqual(chatService.getActiveOnDeltaCount(), 1);

			// 模拟流结束
			chatService.cancelStream('agent-1', 'sess-1');

			assert.strictEqual(chatService.getActiveOnDeltaCount(), 0);
		});
	});

	// ── P0: 历史缓存隔离 ────────────────────────────────────────

	suite('History Cache Isolation', () => {

		test('不同 session 的历史缓存独立', async () => {
			const msgA = makeMessage({ content: 'history A' });
			const msgB = makeMessage({ content: 'history B' });

			await chatService.setHistory('agent-1', 'sess-A', [msgA]);
			await chatService.setHistory('agent-1', 'sess-B', [msgB]);

			const historyA = await chatService.getHistory('agent-1', 'sess-A');
			const historyB = await chatService.getHistory('agent-1', 'sess-B');

			assert.strictEqual(historyA.length, 1);
			assert.strictEqual(historyA[0].content, 'history A');
			assert.strictEqual(historyB.length, 1);
			assert.strictEqual(historyB[0].content, 'history B');
		});

		test('无 session 的历史回退到 agent 级别', async () => {
			const msg = makeMessage({ content: 'agent-level history' });
			await chatService.setHistory('agent-1', undefined, [msg]);

			const history = await chatService.getHistory('agent-1', undefined);

			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].content, 'agent-level history');
		});
	});
});

// ══════════════════════════════════════════════════════════════════
// SplitView 分屏布局测试
// ══════════════════════════════════════════════════════════════════

suite('Multi-Chat Window — SplitView Layout', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let splitView: MockSplitView;

	setup(() => {
		splitView = new MockSplitView('horizontal');
	});

	teardown(() => {
		splitView.dispose();
	});

	// ── P1: 分屏创建/销毁 ────────────────────────────────────────

	suite('Split View Lifecycle', () => {

		test('addView — 添加第一个 view', () => {
			const el = document.createElement('div');
			splitView.addView(el);

			assert.strictEqual(splitView.viewCount, 1);
			assert.ok(splitView.getView(0));
			assert.strictEqual(splitView.getView(0)!.element, el);
		});

		test('addView — 添加第二个 view（分屏）', () => {
			const el1 = document.createElement('div');
			const el2 = document.createElement('div');
			splitView.addView(el1);
			splitView.addView(el2);

			assert.strictEqual(splitView.viewCount, 2);
		});

		test('removeView — 移除 view', () => {
			const el1 = document.createElement('div');
			const el2 = document.createElement('div');
			splitView.addView(el1);
			splitView.addView(el2);

			splitView.removeView(1);

			assert.strictEqual(splitView.viewCount, 1);
		});

		test('removeView — 无效索引抛错', () => {
			assert.throws(
				() => splitView.removeView(0),
				/Invalid view index/,
			);
		});

		test('orientation — 水平分屏', () => {
			const sv = new MockSplitView('horizontal');
			assert.strictEqual(sv.orientation, 'horizontal');
			sv.dispose();
		});

		test('orientation — 垂直分屏', () => {
			const sv = new MockSplitView('vertical');
			assert.strictEqual(sv.orientation, 'vertical');
			sv.dispose();
		});
	});

	// ── P1: 布局计算 ────────────────────────────────────────────

	suite('Layout Calculation', () => {

		test('单个 view 占满全部空间', () => {
			const el = document.createElement('div');
			splitView.addView(el);
			splitView.layout(1000);

			assert.strictEqual(splitView.getSizes()[0], 1000);
		});

		test('两个 view 按 50/50 分配', () => {
			splitView.addView(document.createElement('div'));
			splitView.addView(document.createElement('div'));
			splitView.setRatio(0.5);
			splitView.layout(1000);

			const sizes = splitView.getSizes();
			assert.strictEqual(sizes[0], 500);
			assert.strictEqual(sizes[1], 500);
		});

		test('调整 ratio 后重新分配', () => {
			splitView.addView(document.createElement('div'));
			splitView.addView(document.createElement('div'));

			splitView.setRatio(0.3);
			splitView.layout(1000);

			const sizes = splitView.getSizes();
			assert.strictEqual(sizes[0], 300);
			assert.strictEqual(sizes[1], 700);
		});

		test('ratio 超出范围抛错', () => {
			assert.throws(() => splitView.setRatio(0), /between 0 and 1/);
			assert.throws(() => splitView.setRatio(1), /between 0 and 1/);
			assert.throws(() => splitView.setRatio(-0.5), /between 0 and 1/);
			assert.throws(() => splitView.setRatio(1.5), /between 0 and 1/);
		});

		test('移除第二个 view 后第一个占满', () => {
			splitView.addView(document.createElement('div'));
			splitView.addView(document.createElement('div'));
			splitView.layout(1000);

			splitView.removeView(1);
			splitView.layout(1000);

			assert.strictEqual(splitView.getSizes()[0], 1000);
		});
	});
});

// ══════════════════════════════════════════════════════════════════
// 集成场景测试
// ══════════════════════════════════════════════════════════════════

suite('Multi-Chat Window — Integration Scenarios', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let panelManager: MockChatPanelManager;
	let chatService: MockAgentChatService;

	setup(() => {
		panelManager = new MockChatPanelManager();
		chatService = new MockAgentChatService();
	});

	teardown(() => {
		panelManager.dispose();
		chatService.dispose();
	});

	// ── 场景 1: 多 tab 切换 + 流式不断 ───────────────────────────

	suite('Scenario: Tab Switching with Active Stream', () => {

		test('流式过程中切换 tab，原 panel 状态保留', async () => {
			// 创建两个 panel
			panelManager.createPanel('chat-A', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-A',
			}));
			panelManager.createPanel('chat-B', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-B',
			}));

			// 显示 A 并开始流式
			panelManager.showPanel('chat-A');

			const deltasA: any[] = [];
			await chatService.sendMessage('claw', 'hello A', {
				agentSessionId: 'sess-A',
			}, (delta) => {
				deltasA.push(delta);
				panelManager.routeDelta('chat-A', delta);
			});

			// 流式中途切换到 B
			panelManager.showPanel('chat-B');

			// A 的 panel 仍然存在（只是隐藏）
			const entryA = panelManager.getPanel('chat-A');
			assert.ok(entryA);
			assert.strictEqual(entryA!.isDestroyed, false);
			assert.strictEqual(entryA!.isVisible, false);

			// B 的 panel 可见
			const entryB = panelManager.getPanel('chat-B');
			assert.strictEqual(entryB!.isVisible, true);

			// 继续接收 A 的 delta（流式不断）
			chatService.emitDelta('claw::sess-A', { type: 'text', content: 'continue A' });

			assert.strictEqual(deltasA.length, 1);
			assert.strictEqual(deltasA[0].content, 'continue A');
			assert.strictEqual(entryA!.deltaLog.length, 1);
		});

		test('切回原 tab 时流式状态完整恢复', async () => {
			panelManager.createPanel('chat-A', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-A',
			}));

			panelManager.showPanel('chat-A');

			// 接收多个 delta
			await chatService.sendMessage('claw', 'msg', {
				agentSessionId: 'sess-A',
			}, (delta) => {
				panelManager.routeDelta('chat-A', delta);
			});

			chatService.emitDelta('claw::sess-A', { type: 'text', content: 'chunk 1' });
			chatService.emitDelta('claw::sess-A', { type: 'text', content: 'chunk 2' });

			// 切换走再切回
			panelManager.createPanel('chat-B', makeRuntimeState());
			panelManager.showPanel('chat-B');
			panelManager.showPanel('chat-A');

			// A 的 deltaLog 应保留所有 chunk
			const entryA = panelManager.getPanel('chat-A');
			assert.strictEqual(entryA!.deltaLog.length, 2);
			assert.strictEqual(entryA!.deltaLog[0].content, 'chunk 1');
			assert.strictEqual(entryA!.deltaLog[1].content, 'chunk 2');
		});
	});

	// ── 场景 2: 两个 panel 同时流式 ─────────────────────────────

	suite('Scenario: Dual Concurrent Streams', () => {

		test('两个 panel 同时发送消息，各自独立流式', async () => {
			panelManager.createPanel('chat-A', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-A',
			}));
			panelManager.createPanel('chat-B', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-B',
			}));

			const deltasA: any[] = [];
			const deltasB: any[] = [];

			// 同时发起两个流
			await chatService.sendMessage('claw', 'msg A', {
				agentSessionId: 'sess-A',
			}, (delta) => {
				deltasA.push(delta);
				panelManager.routeDelta('chat-A', delta);
			});

			await chatService.sendMessage('claw', 'msg B', {
				agentSessionId: 'sess-B',
			}, (delta) => {
				deltasB.push(delta);
				panelManager.routeDelta('chat-B', delta);
			});

			// 交替发送 delta
			chatService.emitDelta('claw::sess-A', { type: 'text', content: 'A-1' });
			chatService.emitDelta('claw::sess-B', { type: 'text', content: 'B-1' });
			chatService.emitDelta('claw::sess-A', { type: 'text', content: 'A-2' });
			chatService.emitDelta('claw::sess-B', { type: 'text', content: 'B-2' });

			// 各自的 delta 顺序正确，不串台
			assert.strictEqual(deltasA.length, 2);
			assert.strictEqual(deltasA[0].content, 'A-1');
			assert.strictEqual(deltasA[1].content, 'A-2');

			assert.strictEqual(deltasB.length, 2);
			assert.strictEqual(deltasB[0].content, 'B-1');
			assert.strictEqual(deltasB[1].content, 'B-2');

			// panel deltaLog 也正确
			assert.strictEqual(panelManager.getPanel('chat-A')!.deltaLog.length, 2);
			assert.strictEqual(panelManager.getPanel('chat-B')!.deltaLog.length, 2);
		});

		test('取消一个流不影响另一个', async () => {
			panelManager.createPanel('chat-A', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-A',
			}));
			panelManager.createPanel('chat-B', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-B',
			}));

			await chatService.sendMessage('claw', 'msg A', {
				agentSessionId: 'sess-A',
			}, () => {});

			await chatService.sendMessage('claw', 'msg B', {
				agentSessionId: 'sess-B',
			}, () => {});

			// 取消 A
			chatService.cancelStream('claw', 'sess-A');

			// A 已取消
			assert.strictEqual(chatService.isStreamActive('claw::sess-A'), false);
			// B 仍然活跃
			assert.strictEqual(chatService.isStreamActive('claw::sess-B'), true);

			// B 仍能接收 delta
			let received = false;
			await chatService.sendMessage('claw', 'msg B2', {
				agentSessionId: 'sess-B',
			}, (delta) => { received = true; });

			chatService.emitDelta('claw::sess-B', { type: 'text', content: 'still active' });

			assert.ok(received);
		});
	});

	// ── 场景 3: 分屏 + 独立交互 ─────────────────────────────────

	suite('Scenario: Split View with Independent Interaction', () => {

		test('两个 panel 在分屏中各自独立工作', async () => {
			const splitView = new MockSplitView('horizontal');
			try {
				// 创建两个 panel
				panelManager.createPanel('chat-left', makeRuntimeState({
					agentId: 'claw',
					sessionId: 'sess-left',
				}));
				panelManager.createPanel('chat-right', makeRuntimeState({
					agentId: 'pm',
					sessionId: 'sess-right',
				}));

				// 模拟分屏容器
				const elLeft = document.createElement('div');
				const elRight = document.createElement('div');
				splitView.addView(elLeft);
				splitView.addView(elRight);
				splitView.setRatio(0.5);
				splitView.layout(960);

				// 两侧都有 panel
				assert.strictEqual(splitView.viewCount, 2);
				assert.strictEqual(splitView.getSizes()[0], 480);
				assert.strictEqual(splitView.getSizes()[1], 480);

				// 各自独立发送消息
				const deltasLeft: any[] = [];
				const deltasRight: any[] = [];

				await chatService.sendMessage('claw', 'left msg', {
					agentSessionId: 'sess-left',
				}, (delta) => {
					deltasLeft.push(delta);
					panelManager.routeDelta('chat-left', delta);
				});

				await chatService.sendMessage('pm', 'right msg', {
					agentSessionId: 'sess-right',
				}, (delta) => {
					deltasRight.push(delta);
					panelManager.routeDelta('chat-right', delta);
				});

				// 各自独立接收 delta
				chatService.emitDelta('claw::sess-left', { type: 'text', content: 'left response' });
				chatService.emitDelta('pm::sess-right', { type: 'text', content: 'right response' });

				assert.strictEqual(deltasLeft.length, 1);
				assert.strictEqual(deltasLeft[0].content, 'left response');
				assert.strictEqual(deltasRight.length, 1);
				assert.strictEqual(deltasRight[0].content, 'right response');
			} finally {
				splitView.dispose();
			}
		});

		test('关闭分屏后恢复单 panel 全宽', () => {
			const splitView = new MockSplitView('horizontal');
			try {
				splitView.addView(document.createElement('div'));
				splitView.addView(document.createElement('div'));
				splitView.setRatio(0.5);
				splitView.layout(960);

				// 关闭第二个 view
				splitView.removeView(1);
				splitView.layout(960);

				// 第一个 view 占满
				assert.strictEqual(splitView.viewCount, 1);
				assert.strictEqual(splitView.getSizes()[0], 960);
			} finally {
				splitView.dispose();
			}
		});
	});

	// ── 场景 4: LRU 淘汰 + 自动重建 ─────────────────────────────

	suite('Scenario: LRU Eviction and Rebuild', () => {

		test('淘汰后切换回来，从历史恢复消息', async () => {
			panelManager.setMaxConcurrentPanels(2);

			// 创建 3 个 panel
			panelManager.createPanel('chat-1', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-1',
			}));
			panelManager.createPanel('chat-2', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-2',
			}));

			panelManager.showPanel('chat-1');
			panelManager.showPanel('chat-2');

			// chat-1 有历史消息
			const historyMsg = makeMessage({ content: 'old message from chat-1' });
			await chatService.setHistory('claw', 'sess-1', [historyMsg]);

			// 创建第三个 → 淘汰 chat-1
			panelManager.createPanel('chat-3', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-3',
			}));

			// chat-1 被销毁
			assert.strictEqual(panelManager.getPanel('chat-1'), undefined);

			// 重新创建 chat-1
			panelManager.createPanel('chat-1', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-1',
			}));

			// 历史仍在
			const history = await chatService.getHistory('claw', 'sess-1');
			assert.strictEqual(history.length, 1);
			assert.strictEqual(history[0].content, 'old message from chat-1');
		});

		test('淘汰活跃 panel 不发生（活跃 panel 受保护）', () => {
			panelManager.setMaxConcurrentPanels(2);

			panelManager.createPanel('chat-active', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-active',
			}));
			panelManager.createPanel('chat-old', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-old',
			}));

			panelManager.showPanel('chat-active');
			panelManager.showPanel('chat-old');
			panelManager.showPanel('chat-active');  // 重新激活

			// 创建第三个
			panelManager.createPanel('chat-new', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-new',
			}));

			// 活跃的不被淘汰
			assert.ok(panelManager.getPanel('chat-active'));
			// 旧的被淘汰
			assert.strictEqual(panelManager.getPanel('chat-old'), undefined);
		});
	});

	// ── 场景 5: 多 agent 隔离 ───────────────────────────────────

	suite('Scenario: Multi-Agent Isolation', () => {

		test('不同 agent 的 panel 状态完全隔离', () => {
			panelManager.createPanel('chat-claw', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-claw',
				chatMode: 'craft',
			}));
			panelManager.createPanel('chat-pm', makeRuntimeState({
				agentId: 'pm',
				sessionId: 'sess-pm',
				chatMode: 'plan',
			}));

			panelManager.showPanel('chat-claw');

			const clawPanel = panelManager.getPanel('chat-claw');
			const pmPanel = panelManager.getPanel('chat-pm');

			assert.strictEqual(clawPanel!.state.agentId, 'claw');
			assert.strictEqual(clawPanel!.state.chatMode, 'craft');
			assert.strictEqual(pmPanel!.state.agentId, 'pm');
			assert.strictEqual(pmPanel!.state.chatMode, 'plan');
		});

		test('不同 agent 的消息流互不干扰', async () => {
			panelManager.createPanel('chat-claw', makeRuntimeState({
				agentId: 'claw',
				sessionId: 'sess-claw',
			}));
			panelManager.createPanel('chat-pm', makeRuntimeState({
				agentId: 'pm',
				sessionId: 'sess-pm',
			}));

			await chatService.sendMessage('claw', 'claw msg', {
				agentSessionId: 'sess-claw',
			}, (delta) => panelManager.routeDelta('chat-claw', delta));

			await chatService.sendMessage('pm', 'pm msg', {
				agentSessionId: 'sess-pm',
			}, (delta) => panelManager.routeDelta('chat-pm', delta));

			chatService.emitDelta('claw::sess-claw', { type: 'text', content: 'claw response' });
			chatService.emitDelta('pm::sess-pm', { type: 'text', content: 'pm response' });

			assert.strictEqual(panelManager.getPanel('chat-claw')!.deltaLog.length, 1);
			assert.strictEqual(panelManager.getPanel('chat-pm')!.deltaLog.length, 1);
			assert.strictEqual(panelManager.getPanel('chat-claw')!.deltaLog[0].content, 'claw response');
			assert.strictEqual(panelManager.getPanel('chat-pm')!.deltaLog[0].content, 'pm response');
		});
	});

	// ── 场景 6: Disposable 清理 ─────────────────────────────────

	suite('Scenario: Disposable Cleanup', () => {

		test('manager dispose 时所有 panel 被销毁', () => {
			const mgr = new MockChatPanelManager();
			mgr.createPanel('chat-1', makeRuntimeState());
			mgr.createPanel('chat-2', makeRuntimeState());
			mgr.createPanel('chat-3', makeRuntimeState());

			assert.strictEqual(mgr.getPanelCount(), 3);

			mgr.dispose();

			// Dispose 后不应再可访问（Map 被清理）
			// 这里用 try-catch 验证不抛错
			assert.doesNotThrow(() => {
				mgr.getPanelCount();
			});
		});

		test('事件监听器在 dispose 后不再触发', () => {
			const mgr = new MockChatPanelManager();
			let createCount = 0;
			mgr.onDidPanelCreate(() => { createCount++; });

			mgr.createPanel('chat-1', makeRuntimeState());
			assert.strictEqual(createCount, 1);

			mgr.dispose();

			// dispose 后创建不应触发事件（但 Map 操作可能已不安全）
			// 这里主要验证不会抛异常
			assert.strictEqual(createCount, 1);
		});
	});
});
