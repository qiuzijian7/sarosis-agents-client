#!/usr/bin/env node
// CLI 探测、环境净化、引擎表与插件入口（apply）的测试。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import {
	cleanEnv, executableNames, findExecutable, isSensitiveEnvName,
	probeVersion, searchDirs,
} from '../lib/core/discover.js';
import {
	ENGINES, customRoute, engineTable, isLocalAgentRoute, validateCustom,
} from '../lib/core/engines.js';
import { apply, scanRoutes } from '../lib/index.js';

const fails = [];
let passed = 0;
const check = (name, fn) => {
	try { fn(); passed++; console.log(`  ✓ ${name}`); }
	catch (error) { fails.push(name); console.error(`  ✗ ${name} — ${error.message}`); }
};

check('cleanEnv 剔除 provider key 与本产品前缀，保留普通变量', () => {
	const env = {
		PATH: '/bin', HOME: '/home/u', SAFE: 'keep',
		OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-y',
		CLAUDE_CODE_OAUTH_TOKEN: 'oauth', GEMINI_API_KEY: 'g',
		DSH_HOME: '/dsh', VSSAROS_DATA_ROOT: '/data',
		ELECTRON_RUN_AS_NODE: '1',
	};
	const out = cleanEnv(env);
	assert.deepEqual(out, { PATH: '/bin', HOME: '/home/u', SAFE: 'keep' });
	assert.ok(isSensitiveEnvName('dsh_token'));
	assert.ok(!isSensitiveEnvName('PATH'));
});

check('Windows 可执行名补齐 .cmd/.exe/.bat，非 Windows 不加', () => {
	assert.deepEqual(executableNames('codex', 'win32'), ['codex', 'codex.cmd', 'codex.exe', 'codex.bat']);
	assert.deepEqual(executableNames('codex', 'linux'), ['codex']);
	assert.deepEqual(executableNames('codex.cmd', 'win32'), ['codex.cmd']);
});

check('searchDirs 去重、Windows 补 APPDATA/npm', () => {
	const dirs = searchDirs({ PATH: ['/a', '/b', '/a'].join(delimiter), APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32');
	assert.deepEqual(dirs.slice(0, 2), ['/a', '/b']);
	assert.ok(dirs.includes(join('C:\\Users\\u\\AppData\\Roaming', 'npm')));
	assert.equal(new Set(dirs).size, dirs.length);
});

check('findExecutable 只做文件检查，找不到返回 undefined', () => {
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-la-discover-'));
	try {
		writeFileSync(join(dir, 'mycli'), '');
		assert.equal(findExecutable('mycli', [dir], 'linux'), join(dir, 'mycli'));
		assert.equal(findExecutable('missing', [dir], 'linux'), undefined);
		assert.equal(findExecutable('', [dir], 'linux'), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

check('probeVersion 取首个非空行、失败返回 undefined', () => {
	assert.equal(probeVersion('x', ['--version'], () => ({ stdout: '\n  v1.2.3\n', stderr: '' })), 'v1.2.3');
	assert.equal(probeVersion('x', ['--version'], () => { throw new Error('ENOENT'); }), undefined);
});

check('validateCustom 拒绝空格/换行/非法路径', () => {
	assert.deepEqual(validateCustom({ name: 'My CLI', command: 'mycli', args: ['acp'] }), []);
	assert.ok(validateCustom({ name: '', command: 'mycli' }).some((p) => p.includes('名称')));
	assert.ok(validateCustom({ name: 'x', command: 'mycli --acp' }).some((p) => p.includes('空格')));
	assert.ok(validateCustom({ name: 'x', command: '~/bin/cli', args: ['a\0b'] }).some((p) => p.includes('args')));
	assert.ok(validateCustom({ name: 'x', command: 'C:\\Program Files\\x.exe' }).some((p) => p.includes('空格')));
});

check('engineTable 收录合法自定义 agent 并生成 acp route', () => {
	const table = engineTable([{ id: 'x1', name: 'X', command: 'xcli', args: ['acp'] }]);
	assert.equal(table[customRoute('x1')].kind, 'acp');
	assert.deepEqual(table[customRoute('x1')].args, ['acp']);
	assert.equal(engineTable([{ id: 'bad', name: 'X', command: 'has space' }])[customRoute('bad')], undefined);
	assert.ok(Object.keys(ENGINES).every(isLocalAgentRoute));
	assert.equal(isLocalAgentRoute('codebuddy/xxx'), false);
});

check('scanRoutes 只为「本机装了」的内置 CLI 注册路由', () => {
	const resolve = (command) => (command === 'codex' ? '/fake/codex' : undefined);
	assert.deepEqual(scanRoutes([], ['/fake'], resolve), ['vssaros-codex-cli']);
	assert.deepEqual(scanRoutes([], ['/none'], () => undefined), []);
});

/** 假 cordis ctx：记录 registerAdapter 与 effect 的 disposer。 */
function fakeCtx(withLlm = true) {
	const state = { registered: [], tools: [], effects: [], disposed: false, approvalOutcome: 'allowed-once' };
	const llm = withLlm ? {
		registerAdapter(routes, adapter) {
			const handle = () => { state.disposed = true; };
			handle.replace = () => {};
			state.registered.push({ routes, adapter });
			return handle;
		},
	} : undefined;
	const ctx = {
		inject(_names, callback) {
			callback({
				llm,
				tools: {
					register(def) { state.tools.push(def); return () => { state.toolDisposed = true; }; },
				},
				get(name) {
					return name === 'approval' ? { request: async () => state.approvalOutcome } : undefined;
				},
				effect(factory) { state.effects.push(factory); return () => {}; },
			});
		},
	};
	return { ctx, state };
}


check('apply 默认关闭 ⇒ 不注册任何路由（fail-closed）', () => {
	const { ctx, state } = fakeCtx();
	apply(ctx);
	assert.equal(state.registered.length, 0);
});

check('apply 在无 registerAdapter 的老 runtime 上明确不注册', () => {
	const { ctx, state } = fakeCtx(false);
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-la-apply-'));
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(dir, 'codex'), '');
		process.env.PATH = dir;
		apply(ctx, { enabled: true });
		assert.equal(state.registered.length, 0);
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

check('apply 打开后注册路由，effect disposer 撤销并 dispose adapter', () => {
	const { ctx, state } = fakeCtx();
	const dir = mkdtempSync(join(tmpdir(), 'vssaros-la-apply-'));
	const oldPath = process.env.PATH;
	try {
		writeFileSync(join(dir, 'codex'), '');
		process.env.PATH = dir;
		apply(ctx, { enabled: true });
		assert.equal(state.registered.length, 1);
		assert.ok(state.registered[0].routes.includes('vssaros-codex-cli'));
		assert.equal(state.tools.length, 1, 'P1 应注册 approve_agent_action');
		assert.equal(state.tools[0].name, 'approve_agent_action');
		assert.equal(typeof state.registered[0].adapter.stream, 'function');
		assert.equal(state.effects.length, 1);
		const disposer = state.effects[0]();
		assert.equal(typeof disposer, 'function');
		disposer();
		assert.equal(state.disposed, true);
		assert.equal(state.registered[0].adapter.live.size, 0);
	} finally {
		process.env.PATH = oldPath;
		rmSync(dir, { recursive: true, force: true });
	}
});

console.log(`\n${fails.length ? `✗ ${fails.length} 项失败 / ${passed} 项通过` : `✓ 全部 ${passed} 项通过`}`);
if (fails.length) process.exitCode = 1;
