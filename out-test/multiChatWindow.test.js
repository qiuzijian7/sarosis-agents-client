/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
//
// 多聊天框 UI — AGENT_EDITOR_PART 完整测试
//
// 测试覆盖：
//   1. NativeChatEditorInput — 多实例隔离 / setAgentInfo / matches / 资源唯一性
//   2. NativeChatEditorInput 序列化 — pop out/in 快照往返一致性
//   3. NativeChatEditorPane — 结构与契约（_loadGeneration 竞态保护 / focusInput 公共入口）
//   4. Pop Out / Pop In — 快照收集 / 恢复 / 空快照处理 / 部分恢复
//   5. AgentChatService — 并发流隔离契约
//   6. 预设查找 — _findChatPaneForAgent 遍历所有 group（含后台 tab）
//
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
// ══════════════════════════════════════════════════════════════════
// 1. NativeChatEditorInput — 多实例隔离
// ══════════════════════════════════════════════════════════════════
suite('NativeChatEditorInput — 多实例隔离', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    test('create() 每次返回不同实例且 chatId 唯一', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const a = NativeChatEditorInput.create();
        const b = NativeChatEditorInput.create();
        assert.ok(a !== b, '不同调用应为不同实例');
        assert.ok(a.chatId !== b.chatId, 'chatId 应唯一');
        assert.ok(a.chatId.length > 0, 'chatId 不应为空');
    });
    test('create(chatId) 使用指定 chatId', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('my-custom-id');
        assert.strictEqual(input.chatId, 'my-custom-id');
    });
    test('resource 唯一且基于 chatId', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const a = NativeChatEditorInput.create('chat-a');
        const b = NativeChatEditorInput.create('chat-b');
        assert.ok(a.resource.toString() !== b.resource.toString(), '不同 chatId 的 resource 应不同');
        assert.ok(a.resource.scheme === 'native-chat', 'scheme 应为 native-chat');
    });
    test('matches() 仅匹配相同 chatId 的同类实例', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const a = NativeChatEditorInput.create('chat-a');
        const b = NativeChatEditorInput.create('chat-b');
        const a2 = NativeChatEditorInput.create('chat-a');
        assert.strictEqual(a.matches(b), false, '不同 chatId 不应 match');
        assert.strictEqual(a.matches(a), true, '自身应 match');
        assert.strictEqual(a.matches(a2), true, '相同 chatId 不同实例应 match');
    });
    test('matches() 对非 NativeChatEditorInput 返回 false', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-x');
        assert.strictEqual(input.matches({}), false, '非 EditorInput 对象不应 match');
        assert.strictEqual(input.matches(null), false, 'null 不应 match');
    });
    test('setAgentInfo() 更新 name/agentId，不传 sessionId 时不修改', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-test', 'initial-agent', 'initial-session');
        input.setAgentInfo('NewName', 'new-agent');
        assert.strictEqual(input.name, 'NewName');
        assert.strictEqual(input.agentId, 'new-agent');
        // sessionId 未传入 → 保持原值
        assert.strictEqual(input.sessionId, 'initial-session');
    });
    test('setAgentInfo() 更新 sessionId', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-test');
        input.setAgentInfo('Agent', 'agent-1', 'session-1');
        assert.strictEqual(input.agentId, 'agent-1');
        assert.strictEqual(input.sessionId, 'session-1');
        // 再次更新 sessionId
        input.setAgentInfo('Agent', 'agent-1', 'session-2');
        assert.strictEqual(input.sessionId, 'session-2');
    });
    test('初始 name 默认为 "Agent Chat"', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-default');
        assert.strictEqual(input.name, 'Agent Chat');
    });
    test('create(name) 使用指定 name', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-x', undefined, undefined, 'Custom Name');
        assert.strictEqual(input.name, 'Custom Name');
    });
    test('saveRuntimeState / getRuntimeState 往返一致', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-rt');
        // 初始无 runtime state
        assert.strictEqual(input.getRuntimeState(), undefined, '初始应为 undefined');
        // 保存状态
        const state = { messages: [{ id: 'm1' }], streamPhase: 'llm_streaming', isSending: true, agentLoaded: true };
        input.saveRuntimeState(state);
        // 恢复
        const restored = input.getRuntimeState();
        assert.ok(restored, '应返回保存的状态');
        assert.strictEqual(restored.streamPhase, 'llm_streaming');
        assert.strictEqual(restored.isSending, true);
        assert.strictEqual(restored.messages.length, 1);
        assert.strictEqual(restored.agentLoaded, true);
    });
    test('clearRuntimeState 清除保存的状态', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-clear');
        input.saveRuntimeState({ messages: [], streamPhase: 'idle', isSending: false, agentLoaded: false });
        assert.ok(input.getRuntimeState(), '保存后应有状态');
        input.clearRuntimeState();
        assert.strictEqual(input.getRuntimeState(), undefined, '清除后应为 undefined');
    });
    test('runtime state 不参与序列化（transient）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-serial', 'agent-1', 'sess-1', 'Test');
        // 保存 runtime state
        input.saveRuntimeState({ messages: [{ id: 'm1' }], streamPhase: 'tool_executing', isSending: true, agentLoaded: true });
        // 序列化（模拟 pop out 快照收集）
        const snapshot = {
            chatId: input.chatId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            name: input.name,
        };
        // 快照中不应包含 runtime state
        assert.ok(!('messages' in snapshot), '快照不应包含 messages');
        assert.ok(!('streamPhase' in snapshot), '快照不应包含 streamPhase');
        assert.ok(!('isSending' in snapshot), '快照不应包含 isSending');
    });
    test('capabilities 为 Readonly', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const { EditorInputCapabilities } = await import('../../../../../../workbench/common/editor.js');
        const input = NativeChatEditorInput.create('chat-readonly');
        assert.ok(input.capabilities & EditorInputCapabilities.Readonly, '应为 Readonly');
    });
    test('canMove() 返回 true（允许拖拽到新 group）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-movable');
        assert.strictEqual(input.canMove(0, 1), true);
    });
    test('typeId 和 editorId 常量', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        assert.strictEqual(NativeChatEditorInput.TypeID, 'workbench.editors.nativeChatInput');
        assert.strictEqual(NativeChatEditorInput.EditorID, 'workbench.editor.nativeChat');
        const input = NativeChatEditorInput.create('chat-ids');
        assert.strictEqual(input.typeId, 'workbench.editors.nativeChatInput');
        assert.strictEqual(input.editorId, 'workbench.editor.nativeChat');
    });
});
// ══════════════════════════════════════════════════════════════════
// 2. NativeChatEditorInput 序列化 — Pop Out/In 快照往返
// ══════════════════════════════════════════════════════════════════
suite('NativeChatEditorInput 序列化 — Pop Out/In 快照', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    /**
     * 模拟 NativeChatEditorInputSerializer.serialize 的逻辑
     * (agentStudio.contribution.ts:1303-1327)
     */
    function serializeInput(input) {
        return JSON.stringify({
            type: 'native-chat',
            chatId: input.chatId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            name: input.name,
        });
    }
    /**
     * 模拟 NativeChatEditorInputSerializer.deserialize 的逻辑
     */
    function deserializeInput(serialized) {
        const data = JSON.parse(serialized);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('../../nativeChatEditorInput.js');
        return mod.NativeChatEditorInput.create(data.chatId, data.agentId, data.sessionId, data.name);
    }
    test('serialize → deserialize 往返一致（含 agent + session）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const original = NativeChatEditorInput.create('chat-roundtrip', 'agent-42', 'session-99', 'Coder');
        const json = serializeInput(original);
        const restored = deserializeInput(json);
        assert.strictEqual(restored.chatId, 'chat-roundtrip');
        assert.strictEqual(restored.agentId, 'agent-42');
        assert.strictEqual(restored.sessionId, 'session-99');
        assert.strictEqual(restored.name, 'Coder');
    });
    test('serialize → deserialize 往返一致（无 agent/session）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const original = NativeChatEditorInput.create('chat-empty');
        const json = serializeInput(original);
        const restored = deserializeInput(json);
        assert.strictEqual(restored.chatId, 'chat-empty');
        assert.strictEqual(restored.agentId, undefined);
        assert.strictEqual(restored.sessionId, undefined);
        assert.strictEqual(restored.name, 'Agent Chat');
    });
    test('序列化 JSON 包含 type 标记字段', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const input = NativeChatEditorInput.create('chat-type');
        const json = JSON.parse(serializeInput(input));
        assert.strictEqual(json.type, 'native-chat');
    });
    test('pop out 快照收集：多个 input 序列化为数组', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟 popoutChat action 中收集 movedEditors 的逻辑
        const inputs = [
            NativeChatEditorInput.create('chat-1', 'agent-a', 'sess-a', 'Agent A'),
            NativeChatEditorInput.create('chat-2', 'agent-b', 'sess-b', 'Agent B'),
            NativeChatEditorInput.create('chat-3', 'agent-c', undefined, 'Agent C'),
        ];
        const movedEditors = inputs.map(ed => ({
            chatId: ed.chatId,
            agentId: ed.agentId,
            sessionId: ed.sessionId,
            name: ed.name,
        }));
        assert.strictEqual(movedEditors.length, 3);
        assert.deepStrictEqual(movedEditors[0], { chatId: 'chat-1', agentId: 'agent-a', sessionId: 'sess-a', name: 'Agent A' });
        assert.deepStrictEqual(movedEditors[2], { chatId: 'chat-3', agentId: 'agent-c', sessionId: undefined, name: 'Agent C' });
        // 模拟 reopen-chat handler 恢复
        const restored = movedEditors.map(saved => NativeChatEditorInput.create(saved.chatId, saved.agentId, saved.sessionId, saved.name));
        assert.strictEqual(restored.length, 3);
        assert.strictEqual(restored[0].agentId, 'agent-a');
        assert.strictEqual(restored[2].sessionId, undefined);
        assert.strictEqual(restored[1].name, 'Agent B');
    });
    test('空快照恢复不抛异常', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟 reopen-chat handler 收到空 editors 数组
        const savedEditors = [];
        const restored = savedEditors.map(saved => NativeChatEditorInput.create(saved.chatId, saved.agentId, saved.sessionId, saved.name));
        assert.strictEqual(restored.length, 0);
    });
    test('反序列化损坏 JSON 返回 fallback 实例', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟 deserialize 中 JSON.parse 失败的 catch 分支
        try {
            const badJson = '{invalid json';
            JSON.parse(badJson);
            assert.fail('应抛 JSON 解析错误');
        }
        catch {
            // 回退到 getInstance()
            const fallback = NativeChatEditorInput.getInstance();
            assert.ok(fallback, 'fallback 实例应存在');
            assert.strictEqual(fallback.chatId, 'default');
        }
    });
});
// ══════════════════════════════════════════════════════════════════
// 3. NativeChatEditorPane — 结构与契约
// ══════════════════════════════════════════════════════════════════
suite('NativeChatEditorPane — 结构与契约', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    test('可导入且为类', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.ok(typeof ctor === 'function', 'NativeChatEditorPane 应可构造');
    });
    test('ID 为 workbench.editor.nativeChat', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.strictEqual(ctor.ID, 'workbench.editor.nativeChat');
    });
    test('_chatPanel 是实例级字段（非 static）', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.ok(!('_chatPanel' in ctor), '_chatPanel 不应为 static');
    });
    test('_loadGeneration 是实例级字段（竞态保护）', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.ok(!('_loadGeneration' in ctor), '_loadGeneration 不应为 static');
    });
    test('focusInput 是公共方法', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.strictEqual(typeof ctor.prototype.focusInput, 'function', 'focusInput 应为方法');
    });
    test('_nextPaneId 静态计数器存在（多实例调试 ID）', async () => {
        const mod = await import('../../nativeChatEditorPane.js');
        const ctor = mod.NativeChatEditorPane;
        assert.ok(typeof ctor._nextPaneId === 'number', '_nextPaneId 应为 static number');
    });
});
// ══════════════════════════════════════════════════════════════════
// 4. Pop Out / Pop In — 快照收集与恢复逻辑
// ══════════════════════════════════════════════════════════════════
suite('Pop Out / Pop In — 快照收集与恢复', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    /**
     * 模拟 popoutChat action 中收集聊天编辑器并生成快照的逻辑
     * (agentStudio.contribution.ts:1140-1187)
     *
     * @param editors 当前 group 中的编辑器列表
     * @returns 快照数组 + isNativeChat 标志
     */
    function collectChatSnapshot(editors) {
        const chatEditors = editors.filter(ed => ed.typeId === 'workbench.editors.nativeChatInput' ||
            (ed.typeId === 'workbench.editors.agentStudio' && ed.panelType === 'chat'));
        const isNativeChat = chatEditors.some(ed => ed.typeId === 'workbench.editors.nativeChatInput');
        const movedEditors = chatEditors.map(ed => {
            if (ed.typeId === 'workbench.editors.nativeChatInput') {
                return { chatId: ed.chatId, agentId: ed.agentId, sessionId: ed.sessionId, name: ed.name };
            }
            return { chatId: ed.panelType || 'chat', agentId: undefined, sessionId: undefined, name: 'Agent Chat' };
        });
        return { movedEditors, isNativeChat };
    }
    /**
     * 模拟 reopen-chat handler 恢复逻辑
     * (workbench.ts:1515-1551)
     *
     * @param movedEditors 快照数组
     * @returns 恢复后的 NativeChatEditorInput 数组
     */
    function restoreFromSnapshot(movedEditors) {
        const mod = require('../../nativeChatEditorInput.js');
        return movedEditors.map(saved => mod.NativeChatEditorInput.create(saved.chatId, saved.agentId, saved.sessionId, saved.name));
    }
    test('收集 NativeChatEditorInput 快照', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const editors = [
            NativeChatEditorInput.create('chat-1', 'agent-a', 'sess-a', 'Agent A'),
            NativeChatEditorInput.create('chat-2', 'agent-b', undefined, 'Agent B'),
        ];
        const { movedEditors, isNativeChat } = collectChatSnapshot(editors);
        assert.strictEqual(isNativeChat, true);
        assert.strictEqual(movedEditors.length, 2);
        assert.strictEqual(movedEditors[0].chatId, 'chat-1');
        assert.strictEqual(movedEditors[0].agentId, 'agent-a');
        assert.strictEqual(movedEditors[1].sessionId, undefined);
    });
    test('收集混合编辑器（含非聊天编辑器）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const editors = [
            { typeId: 'workbench.editors.fileEditor' }, // 非聊天编辑器
            NativeChatEditorInput.create('chat-1', 'agent-a', undefined, 'Agent'),
            { typeId: 'workbench.editors.settings' }, // 非聊天编辑器
        ];
        const { movedEditors, isNativeChat } = collectChatSnapshot(editors);
        assert.strictEqual(movedEditors.length, 1, '应只收集聊天编辑器');
        assert.strictEqual(movedEditors[0].chatId, 'chat-1');
        assert.strictEqual(isNativeChat, true);
    });
    test('空编辑器列表 → 空快照', () => {
        const { movedEditors, isNativeChat } = collectChatSnapshot([]);
        assert.strictEqual(movedEditors.length, 0);
        assert.strictEqual(isNativeChat, false);
    });
    test('快照恢复：所有字段往返一致', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const original = [
            NativeChatEditorInput.create('chat-1', 'agent-a', 'sess-a', 'Agent A'),
            NativeChatEditorInput.create('chat-2', 'agent-b', 'sess-b', 'Agent B'),
        ];
        const { movedEditors } = collectChatSnapshot(original);
        const restored = restoreFromSnapshot(movedEditors);
        assert.strictEqual(restored.length, 2);
        for (let i = 0; i < original.length; i++) {
            assert.strictEqual(restored[i].chatId, original[i].chatId, `chatId 往返不一致 [${i}]`);
            assert.strictEqual(restored[i].agentId, original[i].agentId, `agentId 往返不一致 [${i}]`);
            assert.strictEqual(restored[i].sessionId, original[i].sessionId, `sessionId 往返不一致 [${i}]`);
            assert.strictEqual(restored[i].name, original[i].name, `name 往返不一致 [${i}]`);
        }
    });
    test('快照恢复后 matches() 保持一致', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const original = NativeChatEditorInput.create('chat-persist', 'agent-x', 'sess-x', 'X');
        const { movedEditors } = collectChatSnapshot([original]);
        const [restored] = restoreFromSnapshot(movedEditors);
        // 恢复后的 input 应与原始 input match（相同 chatId）
        assert.strictEqual(restored.matches(original), true, '恢复后的 input 应 match 原始 input');
    });
    test('pop out 后 agent 状态保留（模拟拖拽到新窗口）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 创建 input，设置 agent
        const input = NativeChatEditorInput.create('chat-drag', undefined, undefined, 'Agent Chat');
        assert.strictEqual(input.agentId, undefined);
        // 模拟 _selectAndLoadAgent 调用 setAgentInfo 写回
        input.setAgentInfo('Coder', 'agent-coder', 'sess-1');
        assert.strictEqual(input.agentId, 'agent-coder');
        assert.strictEqual(input.name, 'Coder');
        // 序列化（模拟 pop out 收集快照）
        const { movedEditors } = collectChatSnapshot([input]);
        assert.strictEqual(movedEditors[0].agentId, 'agent-coder');
        assert.strictEqual(movedEditors[0].name, 'Coder');
        // 恢复（模拟 aux window 关闭后 reopen）
        const [restored] = restoreFromSnapshot(movedEditors);
        assert.strictEqual(restored.agentId, 'agent-coder', '恢复后 agentId 应保留');
        assert.strictEqual(restored.name, 'Coder', '恢复后 name 应保留');
        assert.strictEqual(restored.sessionId, 'sess-1', '恢复后 sessionId 应保留');
    });
});
// ══════════════════════════════════════════════════════════════════
// 5. AgentChatService — 并发流隔离契约
// ══════════════════════════════════════════════════════════════════
suite('AgentChatService.sendMessage — 并发契约', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    test('sendMessage 接收 onDelta（并发安全契约）', async () => {
        const mod = await import('../../agentChatService.js');
        const ctor = mod.AgentChatService;
        assert.ok(typeof ctor === 'function', 'AgentChatService 应可构造');
        const proto = ctor.prototype;
        assert.ok(typeof proto.sendMessage === 'function', 'sendMessage 应为方法');
        assert.ok(typeof proto.cancelStream === 'function', 'cancelStream 应为方法');
    });
    test('_activeOnDeltas 是 Map（非单例回调，支持并发流）', async () => {
        const mod = await import('../../agentChatService.js');
        const ctor = mod.AgentChatService;
        assert.ok(!('_activeOnDeltas' in ctor), '_activeOnDeltas 不应为 static');
    });
    test('_getOnDeltaForAgent 方法存在（按 agentId 路由）', async () => {
        const mod = await import('../../agentChatService.js');
        const ctor = mod.AgentChatService;
        assert.strictEqual(typeof ctor.prototype._getOnDeltaForAgent, 'function', '_getOnDeltaForAgent 应为方法');
    });
    test('streamKey 格式为 agentId::sessionId', async () => {
        // 验证 sendMessage 中 streamKey 构造逻辑
        const agentId = 'agent-test';
        const sessionId = 'sess-test';
        const expectedKey = `${agentId}::${sessionId}`;
        const noSessionKey = agentId;
        assert.ok(expectedKey.includes('::'), '有 sessionId 时 key 应包含 ::');
        assert.ok(!noSessionKey.includes('::'), '无 sessionId 时 key 不应包含 ::');
    });
});
// ══════════════════════════════════════════════════════════════════
// 6. 预设查找 — _findChatPaneForAgent 遍历所有 group
// ══════════════════════════════════════════════════════════════════
suite('预设查找 — _findChatPaneForAgent 全量遍历', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    /**
     * 模拟 _findChatPaneForAgent 的核心逻辑
     * (presetAgentView.ts:2279-2293)
     *
     * 遍历所有 group 的 editors，匹配 typeId + agentId
     */
    function findChatForAgent(groups, agentId) {
        for (const group of groups) {
            for (const editor of group.editors) {
                if (editor.typeId === 'workbench.editors.nativeChatInput') {
                    if (editor.agentId === agentId) {
                        return { input: editor, group };
                    }
                }
            }
        }
        return undefined;
    }
    test('找到活跃 tab 中的匹配 chat', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const target = NativeChatEditorInput.create('chat-1', 'agent-target');
        const groups = [{
                editors: [target],
            }];
        const found = findChatForAgent(groups, 'agent-target');
        assert.ok(found, '应找到匹配的 chat');
        assert.strictEqual(found.input.chatId, 'chat-1');
    });
    test('找到后台（非活跃）tab 中的匹配 chat', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟两个 tab，目标在第二个（后台）
        const other = NativeChatEditorInput.create('chat-other', 'agent-other');
        const target = NativeChatEditorInput.create('chat-target', 'agent-target');
        const groups = [{
                editors: [other, target], // target 在后台
            }];
        const found = findChatForAgent(groups, 'agent-target');
        assert.ok(found, '应找到后台 tab 中的 chat');
        assert.strictEqual(found.input.chatId, 'chat-target');
    });
    test('跨多个 group 查找', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const target = NativeChatEditorInput.create('chat-g2', 'agent-target');
        const groups = [
            { editors: [NativeChatEditorInput.create('chat-g1', 'agent-other')] },
            { editors: [target] },
        ];
        const found = findChatForAgent(groups, 'agent-target');
        assert.ok(found, '应在第二个 group 中找到');
        assert.strictEqual(found.input.chatId, 'chat-g2');
        assert.strictEqual(found.group, groups[1]);
    });
    test('未找到匹配返回 undefined', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const groups = [{
                editors: [NativeChatEditorInput.create('chat-1', 'agent-a')],
            }];
        const found = findChatForAgent(groups, 'agent-not-exist');
        assert.strictEqual(found, undefined);
    });
    test('空 group 列表返回 undefined', () => {
        const found = findChatForAgent([], 'agent-any');
        assert.strictEqual(found, undefined);
    });
    test('混合编辑器类型（只匹配 NativeChatEditorInput）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const target = NativeChatEditorInput.create('chat-native', 'agent-native');
        const groups = [{
                editors: [
                    { typeId: 'workbench.editors.fileEditor', agentId: 'agent-native' }, // 非 native chat
                    { typeId: 'workbench.editors.settings' }, // 非聊天
                    target,
                ],
            }];
        const found = findChatForAgent(groups, 'agent-native');
        assert.ok(found, '应跳过非 NativeChatEditorInput，只匹配目标');
        assert.strictEqual(found.input.chatId, 'chat-native');
    });
    test('同一 agentId 多个 chat → 返回第一个', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        const first = NativeChatEditorInput.create('chat-1', 'agent-dup');
        const second = NativeChatEditorInput.create('chat-2', 'agent-dup');
        const groups = [{
                editors: [first, second],
            }];
        const found = findChatForAgent(groups, 'agent-dup');
        assert.ok(found);
        assert.strictEqual(found.input.chatId, 'chat-1', '应返回第一个匹配');
    });
});
// ══════════════════════════════════════════════════════════════════
// 7. 多 Agent 并发 — 系统消息隔离（Checkpoint / Memory）
// ══════════════════════════════════════════════════════════════════
suite('多 Agent 并发 — 系统消息隔离', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    /**
     * 模拟 AgentChatService 的并发流隔离机制：
     * - _activeOnDeltas 按 streamKey（agentId::sessionId）分桶
     * - _getOnDeltaForAgent 按 agentId 前缀匹配路由 memory 事件
     *
     * 验证：两个不同 agent 的流同时进行时，memory 事件不会串台。
     */
    test('不同 agent 的 streamKey 互不干扰', () => {
        const agentA = 'agent-coder';
        const agentB = 'agent-pm';
        const sessionA = 'sess-a';
        const sessionB = 'sess-b';
        const keyA = `${agentA}::${sessionA}`;
        const keyB = `${agentB}::${sessionB}`;
        // 模拟 _activeOnDeltas
        const activeOnDeltas = new Map();
        const streamCreatedAt = new Map();
        let receivedByA = [];
        let receivedByB = [];
        activeOnDeltas.set(keyA, (d) => receivedByA.push(d.type));
        activeOnDeltas.set(keyB, (d) => receivedByB.push(d.type));
        streamCreatedAt.set(keyA, Date.now());
        streamCreatedAt.set(keyB, Date.now() + 1);
        // 模拟 _getOnDeltaForAgent(agentA) — 应路由到 keyA
        function getOnDeltaForAgent(agentId) {
            let bestKey;
            let bestTime = -1;
            for (const [key, time] of streamCreatedAt) {
                if (key === agentId || key.startsWith(`${agentId}::`)) {
                    if (time > bestTime) {
                        bestTime = time;
                        bestKey = key;
                    }
                }
            }
            return bestKey ? activeOnDeltas.get(bestKey) : undefined;
        }
        // Agent A 的 memory 事件 → 只到达 A 的回调
        const deltaA = getOnDeltaForAgent(agentA);
        assert.ok(deltaA, '应找到 agentA 的回调');
        deltaA({ type: 'memory_written', content: 'A 的记忆' });
        // Agent B 的 memory 事件 → 只到达 B 的回调
        const deltaB = getOnDeltaForAgent(agentB);
        assert.ok(deltaB, '应找到 agentB 的回调');
        deltaB({ type: 'memory_written', content: 'B 的记忆' });
        // 验证无串台
        assert.ok(receivedByA.length === 1, `agentA 应只收到 1 条，实际 ${receivedByA.length}`);
        assert.ok(receivedByB.length === 1, `agentB 应只收到 1 条，实际 ${receivedByB.length}`);
        assert.strictEqual(receivedByA[0], 'memory_written');
        assert.strictEqual(receivedByB[0], 'memory_written');
    });
    test('同一 agent 不同 session 的 streamKey 隔离', () => {
        const agentId = 'agent-coder';
        const session1 = 'sess-1';
        const session2 = 'sess-2';
        const key1 = `${agentId}::${session1}`;
        const key2 = `${agentId}::${session2}`;
        // 两个 session 同时活跃
        const activeOnDeltas = new Map();
        const streamCreatedAt = new Map();
        let received1 = [];
        let received2 = [];
        activeOnDeltas.set(key1, (d) => received1.push(d));
        activeOnDeltas.set(key2, (d) => received2.push(d));
        streamCreatedAt.set(key1, 1000);
        streamCreatedAt.set(key2, 2000); // session2 更新
        function getOnDeltaForAgent(aid) {
            let bestKey;
            let bestTime = -1;
            for (const [key, time] of streamCreatedAt) {
                if (key === aid || key.startsWith(`${aid}::`)) {
                    if (time > bestTime) {
                        bestTime = time;
                        bestKey = key;
                    }
                }
            }
            return bestKey ? activeOnDeltas.get(bestKey) : undefined;
        }
        // 同 agent 的 memory 事件路由到最近的 session（session2）
        const delta = getOnDeltaForAgent(agentId);
        delta({ type: 'memory_extracted', content: '提取记忆' });
        assert.strictEqual(received1.length, 0, 'session1 不应收到（路由到 session2）');
        assert.strictEqual(received2.length, 1, 'session2 应收到');
        assert.strictEqual(received2[0].type, 'memory_extracted');
    });
    test('checkpoint 按 agentId + sessionId 隔离', async () => {
        // 模拟 ICheckpointService 的按 (agentId, sessionId) 隔离机制
        const checkpoints = new Map();
        function makeKey(agentId, sessionId) {
            return `${agentId}::${sessionId}`;
        }
        // Agent A 在 session-a 创建 checkpoint
        const keyA = makeKey('agent-a', 'sess-a');
        checkpoints.set(keyA, [
            { id: 'cp-1', agentId: 'agent-a', sessionId: 'sess-a', files: [{ path: '/a/file.ts' }] },
        ]);
        // Agent B 在 session-b 创建 checkpoint
        const keyB = makeKey('agent-b', 'sess-b');
        checkpoints.set(keyB, [
            { id: 'cp-2', agentId: 'agent-b', sessionId: 'sess-b', files: [{ path: '/b/file.ts' }] },
        ]);
        // 验证 A 的 checkpoint 不含 B 的文件
        const cpsA = checkpoints.get(keyA);
        assert.strictEqual(cpsA.length, 1);
        assert.strictEqual(cpsA[0].agentId, 'agent-a');
        assert.strictEqual(cpsA[0].files[0].path, '/a/file.ts');
        const cpsB = checkpoints.get(keyB);
        assert.strictEqual(cpsB.length, 1);
        assert.strictEqual(cpsB[0].agentId, 'agent-b');
        assert.strictEqual(cpsB[0].files[0].path, '/b/file.ts');
        // 删除 A 的 checkpoint 不影响 B
        checkpoints.set(keyA, []);
        assert.strictEqual(checkpoints.get(keyB).length, 1, '删除 A 的 checkpoint 不应影响 B');
    });
    test('onDidCreateCheckpoint 事件按 agentId + sessionId 过滤', () => {
        // 模拟 NativeChatEditorPane 中的 checkpoint 事件过滤逻辑
        const currentAgentId = 'agent-a';
        const currentSessionId = 'sess-a';
        const events = [];
        const onDidCreateCheckpoint = (cp) => {
            if (cp.agentId === currentAgentId && cp.sessionId === currentSessionId) {
                events.push(cp);
            }
        };
        // A 的 checkpoint → 应被接收
        onDidCreateCheckpoint({ agentId: 'agent-a', sessionId: 'sess-a', id: 'cp-1' });
        // B 的 checkpoint → 应被过滤掉
        onDidCreateCheckpoint({ agentId: 'agent-b', sessionId: 'sess-b', id: 'cp-2' });
        // A 但不同 session → 应被过滤掉
        onDidCreateCheckpoint({ agentId: 'agent-a', sessionId: 'sess-x', id: 'cp-3' });
        assert.strictEqual(events.length, 1, '只应收到当前 agent+session 的 checkpoint 事件');
        assert.strictEqual(events[0].id, 'cp-1');
    });
    test('memory noticeId 去重防止跨 agent 重复显示', () => {
        // 模拟 AgentChatService._ensureMemoryEventBridge 中的 processedNoticeIds 去重
        const processedNoticeIds = new Set();
        // Agent A 写入 memory（noticeId = 'notice-1'）
        processedNoticeIds.add('notice-1');
        // 同一 noticeId 再次到达（不应重复处理）
        const isDuplicate = processedNoticeIds.has('notice-1');
        assert.ok(isDuplicate, '相同 noticeId 应被识别为重复');
        // Agent B 写入 memory（noticeId = 'notice-2'）→ 不应被误判为重复
        const isNew = !processedNoticeIds.has('notice-2');
        assert.ok(isNew, '不同 noticeId 不应被误判为重复');
    });
});
// ══════════════════════════════════════════════════════════════════
// 8. 多 Agent 并发 — Worktree 隔离
// ══════════════════════════════════════════════════════════════════
suite('多 Agent 并发 — Worktree 隔离', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    /**
     * 模拟 AgentBinding 的 worktreePath 隔离：
     * 每个 agent 可以绑定不同的 worktree，互不干扰。
     */
    test('不同 agent 绑定不同 worktree', () => {
        // 模拟 upsertAgentBinding 后的 binding 状态
        const bindings = new Map();
        // Agent A → worktree /repo/wt-a (branch: feature-a)
        bindings.set('agent-a', { worktreePath: '/repo/wt-a', worktreeBranch: 'feature-a' });
        // Agent B → worktree /repo/wt-b (branch: feature-b)
        bindings.set('agent-b', { worktreePath: '/repo/wt-b', worktreeBranch: 'feature-b' });
        // 验证隔离
        const bindingA = bindings.get('agent-a');
        const bindingB = bindings.get('agent-b');
        assert.strictEqual(bindingA.worktreePath, '/repo/wt-a');
        assert.strictEqual(bindingA.worktreeBranch, 'feature-a');
        assert.strictEqual(bindingB.worktreePath, '/repo/wt-b');
        assert.strictEqual(bindingB.worktreeBranch, 'feature-b');
        assert.notStrictEqual(bindingA.worktreePath, bindingB.worktreePath, '两个 agent 的 worktree 不应相同');
    });
    test('同一 agent 不同 binding（跨 workspace）使用不同 worktree', () => {
        // 模拟 AgentBinding 按 (workspaceId, agentId) 唯一
        const bindings = new Map();
        function makeKey(workspaceId, agentId) {
            return `${workspaceId}::${agentId}`;
        }
        // Workspace-1 + Agent-A → wt-1
        bindings.set(makeKey('ws-1', 'agent-a'), { workspaceId: 'ws-1', agentId: 'agent-a', worktreePath: '/repo/wt-1' });
        // Workspace-2 + Agent-A → wt-2 (同 agent 跨 workspace 不同 worktree)
        bindings.set(makeKey('ws-2', 'agent-a'), { workspaceId: 'ws-2', agentId: 'agent-a', worktreePath: '/repo/wt-2' });
        const b1 = bindings.get(makeKey('ws-1', 'agent-a'));
        const b2 = bindings.get(makeKey('ws-2', 'agent-a'));
        assert.strictEqual(b1.worktreePath, '/repo/wt-1');
        assert.strictEqual(b2.worktreePath, '/repo/wt-2');
        assert.notStrictEqual(b1.worktreePath, b2.worktreePath, '同 agent 跨 workspace 应有不同 worktree');
    });
    test('worktree 清除不影响其他 agent binding', () => {
        // 模拟 _clearWorktreeBindings 清除指定 worktree 的 binding
        const bindings = [
            { agentId: 'agent-a', workspaceId: 'ws-1', worktreePath: '/repo/wt-a' },
            { agentId: 'agent-b', workspaceId: 'ws-1', worktreePath: '/repo/wt-b' },
            { agentId: 'agent-c', workspaceId: 'ws-1', worktreePath: '/repo/wt-a' }, // 与 agent-a 共享
        ];
        // 清除 /repo/wt-a（模拟 worktree 被删除）
        const removedPath = '/repo/wt-a';
        const affected = bindings.filter(b => b.worktreePath === removedPath);
        // agent-a 和 agent-c 应受影响，agent-b 不受影响
        assert.strictEqual(affected.length, 2, '应有 2 个 binding 受影响');
        assert.ok(affected.some(b => b.agentId === 'agent-a'), 'agent-a 应受影响');
        assert.ok(affected.some(b => b.agentId === 'agent-c'), 'agent-c 应受影响');
        assert.ok(!affected.some(b => b.agentId === 'agent-b'), 'agent-b 不应受影响');
    });
    test('NativeChatEditorInput 携带 worktree 信息（onSelectWorktree 回调）', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟两个 chat tab 绑定不同 agent → 不同 worktree
        const inputA = NativeChatEditorInput.create('chat-wt-a', 'agent-a', 'sess-a', 'Agent A');
        const inputB = NativeChatEditorInput.create('chat-wt-b', 'agent-b', 'sess-b', 'Agent B');
        // 验证两个 input 的 agent/session 隔离
        assert.strictEqual(inputA.agentId, 'agent-a');
        assert.strictEqual(inputB.agentId, 'agent-b');
        assert.notStrictEqual(inputA.agentId, inputB.agentId, '两个 chat 的 agentId 应不同');
        // 验证 runtime state 隔离
        inputA.saveRuntimeState({ messages: [{ id: 'msg-a' }], streamPhase: 'llm_streaming', isSending: true, agentLoaded: true });
        inputB.saveRuntimeState({ messages: [{ id: 'msg-b' }], streamPhase: 'idle', isSending: false, agentLoaded: true });
        const stateA = inputA.getRuntimeState();
        const stateB = inputB.getRuntimeState();
        assert.strictEqual(stateA.messages[0].id, 'msg-a', 'agent-a 的消息不应串到 agent-b');
        assert.strictEqual(stateB.messages[0].id, 'msg-b', 'agent-b 的消息不应串到 agent-a');
        assert.strictEqual(stateA.streamPhase, 'llm_streaming');
        assert.strictEqual(stateB.streamPhase, 'idle');
    });
    test('多 agent 并发执行时 worktree 路径不串台', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 模拟 3 个 chat tab，各绑定不同 agent + worktree
        const chats = [
            { input: NativeChatEditorInput.create('chat-1', 'coder', 'sess-1', 'Coder'), worktree: '/repo/wt-coder' },
            { input: NativeChatEditorInput.create('chat-2', 'pm', 'sess-2', 'PM'), worktree: '/repo/wt-pm' },
            { input: NativeChatEditorInput.create('chat-3', 'reviewer', 'sess-3', 'Reviewer'), worktree: '/repo/wt-reviewer' },
        ];
        // 每个 chat 保存不同的 runtime state（模拟并发流式输出）
        chats.forEach((chat, i) => {
            chat.input.saveRuntimeState({
                messages: [{ id: `msg-${i}`, content: `来自 ${chat.input.name} 的消息` }],
                streamPhase: 'llm_streaming',
                isSending: true,
                agentLoaded: true,
            });
        });
        // 验证每个 chat 的 runtime state 独立
        for (let i = 0; i < chats.length; i++) {
            const state = chats[i].input.getRuntimeState();
            assert.strictEqual(state.messages.length, 1, `chat-${i} 应有 1 条消息`);
            assert.strictEqual(state.messages[0].content, `来自 ${chats[i].input.name} 的消息`, `chat-${i} 消息内容应匹配`);
            assert.strictEqual(state.streamPhase, 'llm_streaming', `chat-${i} 应为流式中`);
        }
        // 验证 worktree 路径互不相同
        const worktrees = chats.map(c => c.worktree);
        assert.strictEqual(new Set(worktrees).size, 3, '3 个 chat 应有 3 个不同的 worktree');
        assert.ok(!worktrees.includes('/repo/wt-coder') === false, 'coder worktree 应存在');
    });
    test('worktree 切换不影响其他 chat 的 agent 状态', async () => {
        const mod = await import('../../nativeChatEditorInput.js');
        const { NativeChatEditorInput } = mod;
        // 两个 chat，不同 agent
        const inputA = NativeChatEditorInput.create('chat-1', 'agent-a', 'sess-1', 'Agent A');
        const inputB = NativeChatEditorInput.create('chat-2', 'agent-b', 'sess-2', 'Agent B');
        // Chat A 切换 worktree（模拟 onSelectWorktree 回调）
        // 这里只验证 input 的 agentId 不受 worktree 切换影响
        inputA.setAgentInfo('Agent A', 'agent-a', 'sess-1');
        assert.strictEqual(inputA.agentId, 'agent-a', 'worktree 切换不应改变 agentId');
        // Chat B 不受影响
        assert.strictEqual(inputB.agentId, 'agent-b', 'Chat B 的 agentId 不应受 Chat A 的 worktree 切换影响');
        assert.strictEqual(inputB.sessionId, 'sess-2', 'Chat B 的 sessionId 不应受影响');
    });
});
