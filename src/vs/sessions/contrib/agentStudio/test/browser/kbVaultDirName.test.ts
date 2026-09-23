/*---------------------------------------------------------------------------------------------
 *  Vault 目录命名与占用判定（纯函数）单元测试 —— 2026-09-23
 *
 *  需求（用户）：新建知识库也要「可读目录名」/「知识库目录未被占用时直接复用它」，
 *  不再固定用 21 位时间戳 ID 当目录名（`20260922123131-827wo3k/`）。
 *
 *  运行：
 *      node src/vs/sessions/contrib/agentStudio/test/browser/run-browser-test.mjs \
 *          src/vs/sessions/contrib/agentStudio/test/browser/kbVaultDirName.test.ts
 *--------------------------------------------------------------------------------------------*/
import * as assert from 'assert';

import {
	sanitizeVaultDirName, parentDirOf, isKbDirOccupied, nextVaultDirName,
} from '../../browser/knowledge/kbVaultState.js';

suite('Vault 目录命名（sanitizeVaultDirName）', () => {
	test('Windows 非法字符 → 下划线（含斜杠，避免误建子目录）', () => {
		assert.strictEqual(sanitizeVaultDirName('a<b>c:d"e/f\\g|h?i*j'), 'a_b_c_d_e_f_g_h_i_j');
	});

	test('结尾的点与空格被剥离（Windows 会静默丢弃）', () => {
		assert.strictEqual(sanitizeVaultDirName('我的知识库. '), '我的知识库');
		assert.strictEqual(sanitizeVaultDirName('  带空白的名字  '), '带空白的名字');
	});

	test('空 / 全非法 ⇒ 回退「知识库」（不产生空目录名）', () => {
		assert.strictEqual(sanitizeVaultDirName(''), '知识库');
		assert.strictEqual(sanitizeVaultDirName('   '), '知识库');
		assert.strictEqual(sanitizeVaultDirName('...'), '知识库');
	});

	test('超长截断（路径预算保护）', () => {
		const out = sanitizeVaultDirName('x'.repeat(200));
		assert.strictEqual(out.length, 80);
	});

	test('中文与常规字符原样保留', () => {
		assert.strictEqual(sanitizeVaultDirName('AI Agent 学习库-2026'), 'AI Agent 学习库-2026');
	});
});

suite('父目录与占用判定（parentDirOf / isKbDirOccupied）', () => {
	test('parentDirOf 兼容两种分隔符并容忍结尾分隔符', () => {
		assert.strictEqual(parentDirOf('C:\\a\\b'), 'C:\\a');
		assert.strictEqual(parentDirOf('/a/b/'), '/a');
		assert.strictEqual(parentDirOf('b'), '', '无父级 ⇒ 空串');
	});

	test('★ 某 Vault 的根就是 kbDir ⇒ 已占用（不能再把新 Vault 铺在同一层）', () => {
		assert.strictEqual(isKbDirOccupied('E:\\Vault', ['E:\\Vault']), true);
	});

	test('★ 某 Vault 的根在 kbDir 之下 ⇒ 已占用（kbDir 是它们的公共父目录）', () => {
		// 旧行为遗留：kbDir/20260922123131-827wo3k
		assert.strictEqual(isKbDirOccupied('E:\\Vault', ['E:\\Vault\\20260922123131-827wo3k']), true);
	});

	test('★ 完全无关 ⇒ 未占用（新建时可直接复用 kbDir）', () => {
		assert.strictEqual(isKbDirOccupied('E:\\Vault', ['D:\\other', 'E:\\Vault2\\x']), false);
	});

	test('大小写与结尾分隔符不敏感；空路径保守视为占用', () => {
		assert.strictEqual(isKbDirOccupied('E:\\VAULT\\', ['e:\\vault']), true);
		assert.strictEqual(isKbDirOccupied('', ['E:\\Vault']), true, 'kbDir 未知时不冒险复用');
	});

	test('父目录判定不会被「同名前缀」误伤', () => {
		// E:\Vault2 的父目录是 E:\，不是 E:\Vault ⇒ 不应判为占用
		assert.strictEqual(isKbDirOccupied('E:\\Vault', ['E:\\Vault2']), false);
	});
});

suite('目录名去重（nextVaultDirName）', () => {
	test('未占用 ⇒ 直接用 base', () => {
		assert.strictEqual(nextVaultDirName('我的知识库', () => false), '我的知识库');
	});

	test('被占用 ⇒ 追加序号（2、3…），保证不撞其它 Vault', () => {
		const taken = new Set(['我的知识库', '我的知识库 2']);
		assert.strictEqual(nextVaultDirName('我的知识库', d => taken.has(d)), '我的知识库 3');
	});

	test('空 base ⇒ 回退「知识库」（不产生无名目录）', () => {
		assert.strictEqual(nextVaultDirName('', () => false), '知识库');
	});
});
