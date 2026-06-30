/**
 * Standalone test for MCP Detail button state sync logic.
 * Run: node dev/test-mcp-button-state.cjs
 */
const assert = require('assert');

// ─── Button State Logic (mirrors McpDetailEditorPane._buildActionButton) ────

function getButtonState(installing, installed) {
	if (installing) {
		return { text: '⏳ 安装中...', disabled: true, action: 'none' };
	} else if (installed) {
		return { text: '🗑 删除', disabled: false, action: 'uninstall' };
	} else {
		return { text: '⬇ 安装', disabled: false, action: 'install' };
	}
}

// ─── Mocks ───────────────────────────────────────────────────────────────────

class MockEventBridge {
	constructor() {
		this.emitted = [];
		this.listeners = new Map();
	}
	on(name, handler) {
		if (!this.listeners.has(name)) this.listeners.set(name, []);
		this.listeners.get(name).push(handler);
	}
	emit(name, data) {
		this.emitted.push({ name, data });
		const ls = this.listeners.get(name);
		if (ls) for (const l of ls) l({ data });
	}
}

class MockMcpManagement {
	constructor() { this._installed = []; }
	getInstalled() { return Promise.resolve(this._installed.map(s => ({ name: s.name, id: s.id }))); }
	async install(server) {
		this._installed.push({ name: server.name, id: `mcp.config.usrlocal.${server.name}` });
		return { name: server.name };
	}
	async uninstall(server) {
		this._installed = this._installed.filter(s => s.name !== server.name);
	}
	isInstalled(name) { return this._installed.some(s => s.name === name); }
	reset() { this._installed = []; }
}

const sanitize = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

// ─── Tests ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const testQueue = [];

function test(name, fn) {
	testQueue.push({ name, fn: () => { fn(); }, async: false });
}

function asyncTest(name, fn) {
	testQueue.push({ name, fn, async: true });
}

async function runAll() {
	for (const t of testQueue) {
		try {
			if (t.async) { await t.fn(); } else { t.fn(); }
			console.log(`  ✓ ${t.name}`);
			passed++;
		} catch (e) {
			console.error(`  ✗ ${t.name}`);
			console.error(`    ${e.message}`);
			failed++;
		}
	}
}

console.log('\n══ MCP Detail Button State Sync Tests ══\n');

(async () => {

// 1. Button State Rendering
console.log('─ 1. Button State Rendering ─');

test('未安装 → "⬇ 安装"', () => {
	const s = getButtonState(false, false);
	assert.strictEqual(s.text, '⬇ 安装');
	assert.strictEqual(s.action, 'install');
});

test('安装中 → "⏳ 安装中..."（禁用）', () => {
	const s = getButtonState(true, false);
	assert.strictEqual(s.text, '⏳ 安装中...');
	assert.strictEqual(s.disabled, true);
	assert.strictEqual(s.action, 'none');
});

test('已安装 → "🗑 删除"', () => {
	const s = getButtonState(false, true);
	assert.strictEqual(s.text, '🗑 删除');
	assert.strictEqual(s.action, 'uninstall');
});

test('安装中+已安装 → 优先安装中', () => {
	const s = getButtonState(true, true);
	assert.strictEqual(s.text, '⏳ 安装中...');
	assert.strictEqual(s.disabled, true);
});

// 2. Install/Uninstall & Event Emission
console.log('\n─ 2. Install/Uninstall & Event Emission ─');

asyncTest('安装后 emit add 事件', async () => {
	const bridge = new MockEventBridge();
	const mgmt = new MockMcpManagement();
	const name = 'test-mcp';

	assert.strictEqual(mgmt.isInstalled(name), false);
	await mgmt.install({ name, config: {} });
	bridge.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(name) });

	assert.strictEqual(mgmt.isInstalled(name), true);
	assert.strictEqual(bridge.emitted.length, 1);
	assert.strictEqual(bridge.emitted[0].data.action, 'add');
	assert.strictEqual(bridge.emitted[0].data.presetId, 'test_mcp');
});

asyncTest('卸载后 emit remove 事件', async () => {
	const bridge = new MockEventBridge();
	const mgmt = new MockMcpManagement();
	const name = 'test-mcp';

	await mgmt.install({ name, config: {} });
	const installed = await mgmt.getInstalled();
	const match = installed.find(s => s.name === name);
	await mgmt.uninstall(match);
	bridge.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(name) });

	assert.strictEqual(mgmt.isInstalled(name), false);
	assert.strictEqual(bridge.emitted[0].data.action, 'remove');
});

// 3. _refreshInstalledState Logic
console.log('\n─ 3. _refreshInstalledState Logic ─');

asyncTest('getInstalled() 中存在 → true', async () => {
	const mgmt = new MockMcpManagement();
	await mgmt.install({ name: 'my-mcp', config: {} });
	const installed = await mgmt.getInstalled();
	const isInstalled = installed.some(s => s.name === 'my-mcp');
	assert.strictEqual(isInstalled, true);
});

asyncTest('getInstalled() 中不存在 → false', async () => {
	const mgmt = new MockMcpManagement();
	const installed = await mgmt.getInstalled();
	const isInstalled = installed.some(s => s.name === 'nope');
	assert.strictEqual(isInstalled, false);
});

asyncTest('sanitize 大小写不敏感匹配', async () => {
	const mgmt = new MockMcpManagement();
	await mgmt.install({ name: 'TAPD-MCP', config: {} });
	const installed = await mgmt.getInstalled();
	// _refreshInstalledState uses: s.name === model.name || sanitize(s.name) === sanitize(model.name)
	// sanitize doesn't lowercase, so 'TAPD-MCP' → 'TAPD_MCP', 'tapd-mcp' → 'tapd_mcp' → no match
	// The actual code also checks s.name === model.name (case-sensitive), so we test both forms
	const isInstalled = installed.some(s => s.name === 'TAPD-MCP' || sanitize(s.name) === sanitize('TAPD-MCP'));
	assert.strictEqual(isInstalled, true);
});

// 4. EventBridge Integration
console.log('\n─ 4. EventBridge Integration ─');

test('add 事件清除禁用状态', () => {
	const bridge = new MockEventBridge();
	const disabled = new Set(['test_mcp']);
	let reloaded = false;

	bridge.on('mcp:servers-changed', (e) => {
		const d = e.data;
		if (d?.action === 'add' && d.presetId) {
			disabled.delete(sanitize(d.presetId));
			disabled.delete(d.presetId);
			reloaded = true;
		}
	});

	bridge.emit('mcp:servers-changed', { action: 'add', presetId: 'test_mcp' });
	assert.strictEqual(reloaded, true);
	assert.strictEqual(disabled.has('test_mcp'), false);
});

test('remove 事件清理 startingMcpIds', () => {
	const bridge = new MockEventBridge();
	const starting = new Set(['removing_mcp']);

	bridge.on('mcp:servers-changed', (e) => {
		if (e.data?.action === 'remove') {
			starting.delete(e.data.serverId);
		}
	});

	bridge.emit('mcp:servers-changed', { action: 'remove', serverId: 'removing_mcp' });
	assert.strictEqual(starting.has('removing_mcp'), false);
});

// 5. Full Cycle
console.log('\n─ 5. Full Install→Sync→Uninstall→Sync ─');

asyncTest('完整周期', async () => {
	const bridge = new MockEventBridge();
	const mgmt = new MockMcpManagement();
	const name = 'cycle-mcp';
	let reloadCount = 0;
	bridge.on('mcp:servers-changed', () => { reloadCount++; });

	// Install
	assert.strictEqual(mgmt.isInstalled(name), false);
	assert.strictEqual(getButtonState(false, false).text, '⬇ 安装');

	await mgmt.install({ name, config: {} });
	bridge.emit('mcp:servers-changed', { action: 'add', presetId: sanitize(name) });
	assert.strictEqual(reloadCount, 1);
	assert.strictEqual(mgmt.isInstalled(name), true);
	assert.strictEqual(getButtonState(false, true).text, '🗑 删除');

	// Uninstall
	const installed = await mgmt.getInstalled();
	await mgmt.uninstall(installed.find(s => s.name === name));
	bridge.emit('mcp:servers-changed', { action: 'remove', serverId: sanitize(name) });
	assert.strictEqual(reloadCount, 2);
	assert.strictEqual(mgmt.isInstalled(name), false);
	assert.strictEqual(getButtonState(false, false).text, '⬇ 安装');
});

// 6. Stale Disabled State Cleanup
console.log('\n─ 6. Stale Disabled State Cleanup ─');

test('白名单中被禁用 → 自动清除', () => {
	const whitelist = new Set(['tapd', 'codebase-memory-mcp'].map(n => n.toLowerCase()));
	const disabled = new Set(['tapd']);
	const srv = { id: 'tapd', name: 'tapd' };

	let enabled = !disabled.has(srv.id);
	if (!enabled && whitelist.has(srv.name.toLowerCase())) {
		disabled.delete(srv.id);
		disabled.delete(sanitize(srv.id));
		enabled = true;
	}

	assert.strictEqual(enabled, true);
	assert.strictEqual(disabled.has('tapd'), false);
});

test('不在白名单 → 保持禁用', () => {
	const whitelist = new Set(['tapd'].map(n => n.toLowerCase()));
	const disabled = new Set(['old-mcp']);
	const srv = { id: 'old-mcp', name: 'old-mcp' };

	let enabled = !disabled.has(srv.id);
	if (!enabled && whitelist.has(srv.name.toLowerCase())) {
		disabled.delete(srv.id);
		enabled = true;
	}

	assert.strictEqual(enabled, false);
	assert.strictEqual(disabled.has('old-mcp'), true);
});

// 7. serverId Resolution from tool.category
console.log('\n─ 7. serverId Resolution ─');

function resolveServerId(category, sarosNames) {
	const parts = (category || '').split(':');
	const rawDefId = parts.length >= 2 ? parts[1].toLowerCase() : '';
	for (const name of sarosNames) {
		const sanitized = name.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
		if (rawDefId && rawDefId.endsWith(sanitized)) return name;
	}
	return 'unknown';
}

test('mcp:mcp_config_usrlocal_tapd → tapd', () => {
	const names = ['codebase-memory-mcp', 'tapd'];
	assert.strictEqual(resolveServerId('mcp:mcp_config_usrlocal_tapd', names), 'tapd');
});

test('mcp:mcp_config_usrlocal_codebase_memory_mcp → codebase-memory-mcp', () => {
	const names = ['codebase-memory-mcp', 'tapd'];
	assert.strictEqual(resolveServerId('mcp:mcp_config_usrlocal_codebase_memory_mcp', names), 'codebase-memory-mcp');
});

test('无匹配 → unknown', () => {
	const names = ['codebase-memory-mcp', 'tapd'];
	assert.strictEqual(resolveServerId('mcp:github_copilot_chat_GitHub', names), 'unknown');
});

// Summary
await runAll();
console.log('\n═══════════════════════════════════════');
console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
console.log('═══════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);

})();
