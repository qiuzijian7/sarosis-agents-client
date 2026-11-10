/*
 * 知识库「文件夹根目录」配置：纯逻辑 + store 单根模式的行为守卫（2026-11-10）。
 *
 * 用户裁决：① 选中的根**直接当唯一库根**（不再套 `<vaultId>/`）；② 顶层区真名 `数据源/`
 * `知识库列表/`；③ **以 dsh 侧配置为准，移除 IDE 侧配置和逻辑**。
 *
 * 为什么必须有它（两个只在跑起来才现形的真 bug，都是本脚本当场抓到的）：
 *   ① `normalizeRootPath` 原先把 `isAbsolute` 放在 `resolve()` **之后** ⇒ 相对路径被悄悄转成
 *      `<cwd>/relative/x`，校验形同虚设（工具卡会把内容写到宿主进程的当前目录 ✗）；
 *   ② `listVaults` 只按 `<vaultId>/` 扫容器 ⇒ 配置成根之后仍显示「还没有知识库」；
 *      页面指纹同理恒空 ⇒ 缓存永不失效。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-root-config.mjs
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// 直接用 file: URL 动态 import（Windows 盘符路径不要经 pathToFileURL 二次拼接）。
const core = await import(new URL('../lib/core/kbRootConfig.js', import.meta.url).href);
const store = await import(new URL('../lib/store.js', import.meta.url).href);
const { isVaultId } = await import(new URL('../lib/core/kb.js', import.meta.url).href);

let pass = 0, fail = 0;
const t = async (name, fn) => {
	try { await fn(); pass++; console.log('PASS  ' + name); }
	catch (e) { fail++; console.log('FAIL  ' + name + ' — ' + String(e?.message ?? e)); }
};

await t('相对路径被拒（resolve 之前判）', () => assert.equal(core.normalizeRootPath('relative/folder').ok, false));
await t('绝对路径通过且归一', () => assert.equal(core.normalizeRootPath('E:\\我的知识库').ok, true));
await t('非法字符被拒', () => assert.equal(core.normalizeRootPath('E:\\我的?知识库').ok, false));
await t('盘符根被拒', () => assert.equal(core.normalizeRootPath('E:\\').ok, false));
await t('vault id 过 isVaultId 形态', () => assert.equal(isVaultId(core.rootVaultIdOf('E:\\我的知识库')), true));
await t('配置序列化 round-trip + 坏 JSON 不抛', () => {
	const text = core.serializeRootConfig('E:\\我的知识库');
	assert.equal(core.parseRootConfig(text).path, core.normalizeRootPath('E:\\我的知识库').path);
	assert.equal(core.parseRootConfig('{bad json'), null);
});
await t('候选构造含默认位置与已有根', () => {
	const c = core.buildRootCandidates({ dataRoot: 'D:\\data', existing: [{ path: 'E:\\old', sections: ['数据源', '知识库列表'] }] });
	assert.ok(c.some(x => x.path.endsWith('knowledge-base') && x.recommended));
	assert.ok(c.some(x => x.path === 'E:\\old'));
});

const tmp = mkdtempSync(join(tmpdir(), 'kbroot-'));
try {
	const root = join(tmp, '我的知识库');
	mkdirSync(join(root, '数据源'), { recursive: true });
	mkdirSync(join(root, '知识库列表', 'AIAgent'), { recursive: true });
	writeFileSync(join(tmp, '.kb-root.json'), core.serializeRootConfig(root), 'utf8');

	await t('loadConfiguredRoot 从 dsh 侧 `.kb-root.json` 读回', () => {
		assert.equal(store.loadConfiguredRoot({ dataRoot: tmp }, tmp), root);
	});
	await t('kbRootOf 以 dsh 配置为准（不再读 IDE 幽灵设置）', () =>
		assert.equal(store.kbRootOf({ dataRoot: tmp }), root));
	await t('显式 config.kbRoot 优先级更高（dsh 侧显式配置）', () =>
		assert.equal(store.kbRootOf({ dataRoot: tmp, kbRoot: 'E:\\another' }), 'E:\\another'));
	await t('★ 根即唯一库根：listVaults 返回 root 本身', async () => {
		store.loadConfiguredRoot({ dataRoot: tmp }, tmp);
		const r = await store.listVaults(root, { withDocs: true, external: [] });
		assert.equal(r.singleRoot, true);
		assert.equal(r.vaults.length, 1);
		assert.equal(r.vaults[0].dir, root);
		assert.equal(r.vaults[0].source, 'root');
		assert.equal(r.vaults[0].id, core.rootVaultIdOf(root));
	});
	await t('★ 单根模式下页面快照能拿到那个库', async () => {
		store.loadConfiguredRoot({ dataRoot: tmp }, tmp);
		const snap = await store.pageSnapshotOf(root, { external: [] });
		assert.ok(Array.isArray(snap.vaults));
		assert.equal(snap.vaults.length, 1);
	});
	await t('未配置时保持旧扫盘行为（存量多库不受影响）', async () => {
		store.setConfiguredRoot('');
		const container = join(tmp, 'container');
		mkdirSync(join(container, '20260101000000-aaaaaa1'), { recursive: true });
		const r = await store.listVaults(container, { withDocs: false, external: [] });
		assert.equal(r.vaults.length, 1);
		assert.equal(r.vaults[0].id, '20260101000000-aaaaaa1');
	});
	await t('配置文件落在数据根（换根不会带走配置）', () =>
		assert.ok(readFileSync(join(tmp, '.kb-root.json'), 'utf8').includes('我的知识库')));
} finally {
	store.setConfiguredRoot('');
	rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) { process.exit(1); }
