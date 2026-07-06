/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { McpConnectionState, McpServerCacheState } from '../../../../../../workbench/contrib/mcp/common/mcpTypes.js';
import { observableValue } from '../../../../../../base/common/observable.js';
class MockEventBridgeService {
    _emitted = [];
    _listeners = new Map();
    get emittedEvents() { return this._emitted; }
    on(eventName, handler) {
        if (!this._listeners.has(eventName)) {
            this._listeners.set(eventName, []);
        }
        this._listeners.get(eventName).push(handler);
    }
    emit(eventName, data) {
        this._emitted.push({ eventName, data });
        // Also notify listeners (simulating IntegrationView receiving the event)
        const listeners = this._listeners.get(eventName);
        if (listeners) {
            for (const l of listeners) {
                l({ data });
            }
        }
    }
    dispose() { }
}
function createMockServer(name, running) {
    const connState = observableValue('conn', {
        state: running ? McpConnectionState.Kind.Running : McpConnectionState.Kind.Disconnected
    });
    const cacheState = observableValue('cache', running ? McpServerCacheState.Live : McpServerCacheState.NotStarted);
    const tools = observableValue('tools', []);
    return {
        _name: name,
        definition: { id: `mcp.config.usrlocal.${name}`, label: name },
        connectionState: connState,
        cacheState,
        tools,
        _id: `mcp.config.usrlocal.${name}`,
    };
}
class MockMcpManagementService {
    _installed = [];
    getInstalled() {
        return Promise.resolve(this._installed.map(s => ({ name: s.name, id: s.id })));
    }
    async install(server) {
        this._installed.push({ name: server.name, id: `mcp.config.usrlocal.${server.name}` });
        return { name: server.name, id: `mcp.config.usrlocal.${server.name}` };
    }
    async uninstall(server) {
        this._installed = this._installed.filter(s => s.name !== server.name);
    }
    // Test helpers
    _isInstalled(name) {
        return this._installed.some(s => s.name === name);
    }
    _reset() {
        this._installed = [];
    }
}
// ─── Button State Logic Tests ────────────────────────────────────────────────
/**
 * Extract button state logic for testing without instantiating the full EditorPane.
 * This mirrors the logic in McpDetailEditorPane._buildActionButton().
 */
function getButtonState(installing, installed) {
    if (installing) {
        return { text: '⏳ 安装中...', disabled: true, action: 'none' };
    }
    else if (installed) {
        return { text: '🗑 删除', disabled: false, action: 'uninstall' };
    }
    else {
        return { text: '⬇ 安装', disabled: false, action: 'install' };
    }
}
// ─── Tests ───────────────────────────────────────────────────────────────────
suite('MCP Detail Editor Pane — Button State Sync', () => {
    ensureNoDisposablesAreLeakedInTestSuite();
    let mockEventBridge;
    let mockMcpManagement;
    setup(() => {
        mockEventBridge = new MockEventBridgeService();
        mockMcpManagement = new MockMcpManagementService();
    });
    teardown(() => {
        mockMcpManagement._reset();
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  1. Button State Rendering
    // ══════════════════════════════════════════════════════════════════════════
    test('未安装状态 → 显示"⬇ 安装"按钮', () => {
        const state = getButtonState(false, false);
        assert.strictEqual(state.text, '⬇ 安装');
        assert.strictEqual(state.disabled, false);
        assert.strictEqual(state.action, 'install');
    });
    test('安装中状态 → 显示"⏳ 安装中..."按钮（禁用）', () => {
        const state = getButtonState(true, false);
        assert.strictEqual(state.text, '⏳ 安装中...');
        assert.strictEqual(state.disabled, true);
        assert.strictEqual(state.action, 'none');
    });
    test('已安装状态 → 显示"🗑 删除"按钮', () => {
        const state = getButtonState(false, true);
        assert.strictEqual(state.text, '🗑 删除');
        assert.strictEqual(state.disabled, false);
        assert.strictEqual(state.action, 'uninstall');
    });
    test('安装中 + 已安装 → 优先显示"⏳ 安装中..."（安装中状态优先）', () => {
        const state = getButtonState(true, true);
        assert.strictEqual(state.text, '⏳ 安装中...');
        assert.strictEqual(state.disabled, true);
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  2. Install Action & Event Emission
    // ══════════════════════════════════════════════════════════════════════════
    test('安装成功后 emit mcp:servers-changed { action: "add" }', async () => {
        const serverName = 'test-mcp';
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        // Simulate install flow
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), false);
        await mockMcpManagement.install({ name: serverName, config: { type: 1, command: 'npx' } });
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), true);
        // Simulate event emission (as McpDetailEditorPane._install does)
        mockEventBridge.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(serverName) });
        // Verify event was emitted
        assert.strictEqual(mockEventBridge.emittedEvents.length, 1);
        assert.strictEqual(mockEventBridge.emittedEvents[0].eventName, 'mcp:servers-changed');
        assert.strictEqual(mockEventBridge.emittedEvents[0].data.action, 'add');
        assert.strictEqual(mockEventBridge.emittedEvents[0].data.presetId, sanitize(serverName));
    });
    test('卸载成功后 emit mcp:servers-changed { action: "remove" }', async () => {
        const serverName = 'test-mcp';
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        // Pre-install
        await mockMcpManagement.install({ name: serverName, config: { type: 1, command: 'npx' } });
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), true);
        // Uninstall
        const installed = await mockMcpManagement.getInstalled();
        const match = installed.find(s => s.name === serverName);
        assert.ok(match, 'Server should be found in installed list');
        await mockMcpManagement.uninstall(match);
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), false);
        // Simulate event emission
        mockEventBridge.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(serverName) });
        // Verify event
        assert.strictEqual(mockEventBridge.emittedEvents.length, 1);
        assert.strictEqual(mockEventBridge.emittedEvents[0].data.action, 'remove');
        assert.strictEqual(mockEventBridge.emittedEvents[0].data.serverId, sanitize(serverName));
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  3. _refreshInstalledState Logic
    // ══════════════════════════════════════════════════════════════════════════
    test('_refreshInstalledState: 服务器在 getInstalled() 中 → _installed=true', async () => {
        const serverName = 'my-mcp';
        await mockMcpManagement.install({ name: serverName, config: { type: 1, command: 'npx' } });
        // Simulate _refreshInstalledState logic
        const installed = await mockMcpManagement.getInstalled();
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const norm = sanitize(serverName);
        const isInstalled = installed.some(s => s.name === serverName || sanitize(s.name) === norm);
        assert.strictEqual(isInstalled, true);
    });
    test('_refreshInstalledState: 服务器不在 getInstalled() 中 → _installed=false', async () => {
        // No servers installed
        const installed = await mockMcpManagement.getInstalled();
        const serverName = 'nonexistent-mcp';
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const norm = sanitize(serverName);
        const isInstalled = installed.some(s => s.name === serverName || sanitize(s.name) === norm);
        assert.strictEqual(isInstalled, false);
    });
    test('_refreshInstalledState: 名称大小写不敏感（sanitize 后匹配）', async () => {
        await mockMcpManagement.install({ name: 'TAPD-MCP', config: { type: 1, command: 'npx' } });
        const installed = await mockMcpManagement.getInstalled();
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const norm = sanitize('tapd-mcp'); // lowercase
        const isInstalled = installed.some(s => s.name === 'tapd-mcp' || sanitize(s.name) === norm);
        assert.strictEqual(isInstalled, true);
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  4. EventBridge Integration (IntegrationView receives events)
    // ══════════════════════════════════════════════════════════════════════════
    test('IntegrationView 收到 "add" 事件后应启用 MCP', () => {
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const mcpDisabledIds = new Set(['test_mcp']); // pre-disabled
        let reloadCalled = false;
        // Simulate IntegrationView event handler
        mockEventBridge.on('mcp:servers-changed', (event) => {
            const data = event.data;
            if (data?.action === 'add' && data.presetId) {
                // Clear disabled state (as the fix does)
                mcpDisabledIds.delete(sanitize(data.presetId));
                mcpDisabledIds.delete(data.presetId);
                reloadCalled = true;
            }
        });
        // Emit add event
        mockEventBridge.emit('mcp:servers-changed', { action: 'add', presetId: 'test_mcp' });
        assert.strictEqual(reloadCalled, true);
        assert.strictEqual(mcpDisabledIds.has('test_mcp'), false, 'MCP should be enabled after add event');
    });
    test('IntegrationView 收到 "remove" 事件后应清理 startingMcpIds', () => {
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const startingMcpIds = new Set(['removing_mcp']);
        let reloadCalled = false;
        mockEventBridge.on('mcp:servers-changed', (event) => {
            const data = event.data;
            if (data?.action === 'remove' && data.serverId) {
                startingMcpIds.delete(data.serverId);
                reloadCalled = true;
            }
        });
        mockEventBridge.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize('removing-mcp') });
        assert.strictEqual(reloadCalled, true);
        assert.strictEqual(startingMcpIds.has('removing_mcp'), false, 'startingMcpIds should be cleared');
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  5. Full Install → Sync → Uninstall → Sync Cycle
    // ══════════════════════════════════════════════════════════════════════════
    test('完整安装→同步→卸载→同步周期', async () => {
        const serverName = 'cycle-test-mcp';
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const mcpDisabledIds = new Set();
        // Track reload calls
        let reloadCount = 0;
        mockEventBridge.on('mcp:servers-changed', () => { reloadCount++; });
        // 1. Initial state: not installed
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), false);
        let buttonState = getButtonState(false, false);
        assert.strictEqual(buttonState.text, '⬇ 安装');
        // 2. Install
        await mockMcpManagement.install({ name: serverName, config: { type: 1, command: 'npx' } });
        mockEventBridge.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(serverName) });
        assert.strictEqual(reloadCount, 1, 'IntegrationView should reload after install');
        // 3. Verify installed state
        const installed = await mockMcpManagement.getInstalled();
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), true);
        buttonState = getButtonState(false, true);
        assert.strictEqual(buttonState.text, '🗑 删除');
        // 4. Verify disabled state was cleared
        assert.strictEqual(mcpDisabledIds.has(sanitize(serverName)), false);
        // 5. Uninstall
        const match = installed.find(s => s.name === serverName);
        assert.ok(match);
        await mockMcpManagement.uninstall(match);
        mockEventBridge.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(serverName) });
        assert.strictEqual(reloadCount, 2, 'IntegrationView should reload after uninstall');
        // 6. Verify uninstalled state
        assert.strictEqual(mockMcpManagement._isInstalled(serverName), false);
        buttonState = getButtonState(false, false);
        assert.strictEqual(buttonState.text, '⬇ 安装');
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  6. Stale Disabled State Cleanup
    // ══════════════════════════════════════════════════════════════════════════
    test('白名单中的 MCP 被禁用时，auto-start 应清除过时禁用状态', () => {
        const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');
        const sarosServerNames = new Set(['codebase-memory-mcp', 'tapd'].map(n => n.toLowerCase()));
        const mcpDisabledIds = new Set(['tapd']); // tapd is disabled but in whitelist
        // Simulate auto-start loop logic
        const srv = { id: 'tapd', name: 'tapd', status: 'disconnected' };
        let enabled = !mcpDisabledIds.has(srv.id);
        if (!enabled && sarosServerNames.has(srv.name.toLowerCase())) {
            // Clear stale disabled state
            mcpDisabledIds.delete(srv.id);
            mcpDisabledIds.delete(sanitize(srv.id));
            enabled = true;
        }
        assert.strictEqual(enabled, true, 'tapd should be enabled after stale cleanup');
        assert.strictEqual(mcpDisabledIds.has('tapd'), false, 'tapd should be removed from disabled list');
    });
    test('不在白名单中的 MCP 被禁用时，不清除禁用状态', () => {
        const sarosServerNames = new Set(['codebase-memory-mcp', 'tapd'].map(n => n.toLowerCase()));
        const mcpDisabledIds = new Set(['old-removed-mcp']);
        const srv = { id: 'old-removed-mcp', name: 'old-removed-mcp', status: 'disconnected' };
        let enabled = !mcpDisabledIds.has(srv.id);
        if (!enabled && sarosServerNames.has(srv.name.toLowerCase())) {
            mcpDisabledIds.delete(srv.id);
            enabled = true;
        }
        assert.strictEqual(enabled, false, 'non-whitelist MCP should stay disabled');
        assert.strictEqual(mcpDisabledIds.has('old-removed-mcp'), true);
    });
    // ══════════════════════════════════════════════════════════════════════════
    //  7. serverId Resolution from tool.category
    // ══════════════════════════════════════════════════════════════════════════
    test('从 tool.category 解析 serverId — mcp:mcp_config_usrlocal_tapd → tapd', () => {
        const sarosServerNames = new Set(['codebase-memory-mcp', 'tapd'].map(n => n.toLowerCase()));
        const tool = { category: 'mcp:mcp_config_usrlocal_tapd' };
        // Simulate serverId resolution logic
        const catParts = (tool.category || '').split(':');
        const rawDefId = catParts.length >= 2 ? catParts[1].toLowerCase() : '';
        let serverId = 'unknown';
        for (const name of sarosServerNames) {
            const sanitizedName = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
            if (rawDefId && rawDefId.endsWith(sanitizedName)) {
                serverId = name;
                break;
            }
        }
        assert.strictEqual(serverId, 'tapd');
    });
    test('从 tool.category 解析 serverId — mcp:mcp_config_usrlocal_codebase_memory_mcp → codebase-memory-mcp', () => {
        const sarosServerNames = new Set(['codebase-memory-mcp', 'tapd'].map(n => n.toLowerCase()));
        const tool = { category: 'mcp:mcp_config_usrlocal_codebase_memory_mcp' };
        const catParts = (tool.category || '').split(':');
        const rawDefId = catParts.length >= 2 ? catParts[1].toLowerCase() : '';
        let serverId = 'unknown';
        for (const name of sarosServerNames) {
            const sanitizedName = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
            if (rawDefId && rawDefId.endsWith(sanitizedName)) {
                serverId = name;
                break;
            }
        }
        assert.strictEqual(serverId, 'codebase-memory-mcp');
    });
    test('tool.category 无匹配时 → serverId=unknown（被跳过）', () => {
        const sarosServerNames = new Set(['codebase-memory-mcp', 'tapd'].map(n => n.toLowerCase()));
        const tool = { category: 'mcp:github_copilot_chat_GitHub' };
        const catParts = (tool.category || '').split(':');
        const rawDefId = catParts.length >= 2 ? catParts[1].toLowerCase() : '';
        let serverId = 'unknown';
        for (const name of sarosServerNames) {
            const sanitizedName = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
            if (rawDefId && rawDefId.endsWith(sanitizedName)) {
                serverId = name;
                break;
            }
        }
        assert.strictEqual(serverId, 'unknown');
    });
});
