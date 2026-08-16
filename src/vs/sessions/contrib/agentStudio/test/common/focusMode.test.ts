/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Sarosis. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Focus Mode 测试 — 对齐 Hermes-Agent `TOOLSETS['coding']` 自动 focus 模式切换。
 *
 * 覆盖：
 *   - detectFocusMode: 无工作区 / 无代码信号
 *   - detectFocusModeWithProbe: 代码工作区检测
 *   - 模式判定: auto / focus / manual
 *   - marker 匹配: 普通文件 + glob 模式 (*.csproj)
 */

import assert from 'assert';
import {
	detectFocusMode, detectFocusModeWithProbe, IFileProbe,
} from '../../common/focusMode.js';

// ─── 测试辅助工具 ──────────────────────────────────────────────────────────

class MockFileProbe implements IFileProbe {
	constructor(private folders: Map<string, string[]>) { }

	async exists(path: string): Promise<boolean> {
		// 简化实现
		return false;
	}

	async listFolder(path: string): Promise<readonly string[]> {
		return this.folders.get(path) ?? [];
	}
}

// ─── detectFocusMode (no probe) ───────────────────────────────────────────

suite('FocusMode — detectFocusMode', () => {

	test('empty folders returns auto mode', async () => {
		const result = await detectFocusMode([]);
		assert.strictEqual(result.mode, 'auto');
		assert.strictEqual(result.recommendedToolsets.length, 0);
		assert.strictEqual(result.reason, 'No workspace folders');
	});

	test('non-existent path returns auto mode', async () => {
		// checkFileExists 总是返回 false（占位实现）
		const result = await detectFocusMode(['/nonexistent/path/that/does/not/exist']);
		assert.strictEqual(result.mode, 'auto');
		assert.strictEqual(result.recommendedToolsets.length, 0);
	});
});

// ─── detectFocusModeWithProbe ─────────────────────────────────────────────

suite('FocusMode — detectFocusModeWithProbe', () => {

	test('Node.js workspace (package.json) triggers focus mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/node-project', ['package.json', 'src/', 'README.md']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/node-project'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.recommendedToolsets.includes('core'));
		assert.ok(result.recommendedToolsets.includes('mcp'));
		assert.ok(result.detectedSignals.some(s => s.includes('Node.js')));
	});

	test('.NET workspace (*.csproj) triggers focus mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/dotnet-app', ['MyApp.csproj', 'Program.cs']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/dotnet-app'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.detectedSignals.some(s => s.includes('.NET')));
	});

	test('Python workspace (pyproject.toml) triggers focus mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/python-app', ['pyproject.toml', 'main.py']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/python-app'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.detectedSignals.some(s => s.includes('Python')));
	});

	test('Rust workspace (Cargo.toml) triggers focus mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/rust-app', ['Cargo.toml', 'src/', 'main.rs']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/rust-app'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.detectedSignals.some(s => s.includes('Rust')));
	});

	test('empty folder triggers auto mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/empty', []],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/empty'], probe);
		assert.strictEqual(result.mode, 'auto');
		assert.strictEqual(result.recommendedToolsets.length, 0);
	});

	test('non-code folder (only docs) triggers auto mode', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/docs', ['README.md', 'CHANGELOG.md', 'docs/']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/docs'], probe);
		assert.strictEqual(result.mode, 'auto');
	});

	test('multiple workspace folders — at least one code signal triggers focus', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/docs', ['README.md']],
			['/workspace/code', ['package.json']],
		]));
		const result = await detectFocusModeWithProbe(
			['/workspace/docs', '/workspace/code'],
			probe,
		);
		assert.strictEqual(result.mode, 'focus');
	});

	test('multiple code signals in single folder are all detected', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/fullstack', ['package.json', 'tsconfig.json', '.git/', 'README.md']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/fullstack'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.detectedSignals.length >= 3, 'should detect multiple signals');
	});

	test('Saros workspace detected (vssaros.config.json)', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/vssaros-app', ['vssaros.config.json', 'agents/']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/vssaros-app'], probe);
		assert.strictEqual(result.mode, 'focus');
		assert.ok(result.detectedSignals.some(s => s.includes('Saros')));
		// Saros 推荐包含 kanban
		assert.ok(result.recommendedToolsets.includes('kanban'));
	});
});

// ─── 推荐工具集 ───────────────────────────────────────────────────────────

suite('FocusMode — recommended toolsets', () => {

	test('always includes core, tool-search, mcp, codebase, memory, skill', async () => {
		const probe = new MockFileProbe(new Map([
			['/workspace/test', ['package.json']],
		]));
		const result = await detectFocusModeWithProbe(['/workspace/test'], probe);
		const required = ['core', 'tool-search', 'mcp', 'codebase', 'memory', 'skill'];
		for (const ts of required) {
			assert.ok(result.recommendedToolsets.includes(ts),
				`focus mode should recommend ${ts}`);
		}
	});
});
