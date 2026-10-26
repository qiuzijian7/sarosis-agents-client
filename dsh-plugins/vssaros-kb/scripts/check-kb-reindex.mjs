/*
 * 守卫：**重建索引**（2026-10-25）。
 *
 * 用**临时库**跑（绝不碰真实库的内核缓存），断言四件事：
 *   ① POST /api/reindex 真的重建出 `.kbkernel.json`
 *   ② 返回的 docs 数量与库里的笔记数一致
 *   ③ GET /api/reindex 暴露运行状态（页面据此显示"上次重建"）
 *   ④ **向量索引如实标注不支持**（dsh 侧没有 embedding provider，不能假装能重建）
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-reindex.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KB = new URL('../lib/index.js', import.meta.url).href;
const FND = new URL('../../vssaros-foundation/lib/index.js', import.meta.url).href;
const mod = await import(KB);
const fnd = await import(FND);
const foundation = fnd.createFoundationService();

let handler;
const noop = () => () => {};
const ctx = new Proxy({}, {
	get(_t, key) {
		if (key === 'inject') {
			return (deps, cb) => {
				if (Array.isArray(deps) && deps.includes('webServer')) {
					cb({
						effect: fn => { fn(); return noop(); },
						connection: { requestRejection: () => undefined },
						webServer: { register: spec => { handler = spec.handler; return noop(); } },
					});
				} else if (Array.isArray(deps) && deps.includes('vssarosFoundation')) {
					cb({ vssarosFoundation: foundation });
				}
				return noop();
			};
		}
		if (key === 'effect') { return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } }; }
		if (key === 'get') { return n => (n === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

// 临时库：两篇笔记 + 空的「库」目录（pageSnapshotOf 需要一个像样的库结构）
const vault = mkdtempSync(join(tmpdir(), 'kb-reindex-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记', 'sub'), { recursive: true });
writeFileSync(join(vault, '笔记', 'a.md'), '---\ntitle: A\n---\n\n# A\n\n内容一段。\n', 'utf8');
writeFileSync(join(vault, '笔记', 'sub', 'b.md'), '# B\n\n另一个内容。\n', 'utf8');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-reindex-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path, method = 'GET', body = '') => {
	const out = [];
	const req = { method, url: path };
	if (method === 'POST') {
		req[Symbol.asyncIterator] = async function* () { if (body) { yield Buffer.from(body); } };
	}
	await handler(req, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

await call('/x/kb/api/view-data');   // 预热 LAST_VAULT_DIRS

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const run = await call('/x/kb/api/reindex', 'POST');
t('重建索引返回 ok', run.ok === true, JSON.stringify(run).slice(0, 160));
t('统计到 2 篇笔记', run.docs === 2, 'docs=' + run.docs);
t('内核缓存已落盘（.kbkernel.json）', existsSync(join(vault, '.kbkernel.json')));
t('返回里带内核文件名', String(run.kernelFile || '').includes('.kbkernel.json'));

const status = await call('/x/kb/api/reindex');
t('状态路由可用且记录上次结果', status.ok === true && status.lastDocs === 2 && status.lastAt > 0,
	JSON.stringify(status).slice(0, 160));
t('向量索引如实标注不支持', status.vector && status.vector.supported === false && String(status.vector.reason || '').length > 0);

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（重建索引）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（重建索引：内核缓存 + 状态 + 向量能力边界）`);
