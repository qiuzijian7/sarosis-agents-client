/*
 * 守卫：**`/api/view-data` 缓存**（2026-10-25）。
 *
 * 这条路由每次挂载都要扫两遍目录 + 读全库正文算双链（首次实测 ~200ms），
 * 而"打开面板 → 进设置 → 回来"几秒内会重复请求同一份内容。
 *
 * 断言四件事（全部用临时库）：
 *   ① 首次 `cached:false`
 *   ② 立刻再请求 `cached:true`（命中）
 *   ③ **新增笔记后不再命中**且篇数 +1（`sig` 看目录 mtime）
 *   ④ `?refresh=1` 无条件绕过缓存
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-view-cache.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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

const vault = mkdtempSync(join(tmpdir(), 'kb-vcache-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记'), { recursive: true });
writeFileSync(join(vault, '笔记', 'a.md'), '# A\n\n[[b]]\n', 'utf8');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-vcache-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path) => {
	const out = [];
	await handler({ method: 'GET', url: path }, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const first = await call('/x/kb/api/view-data');
t('首次请求未命中缓存', first.ok === true && first.cached === false, 'cached=' + first.cached);
t('首次数到 1 篇', first.data && first.data.noteCount === 1, 'noteCount=' + (first.data && first.data.noteCount));

const second = await call('/x/kb/api/view-data');
t('立刻再请求命中缓存', second.cached === true, 'cached=' + second.cached);
t('命中时内容一致', JSON.stringify(second.data) === JSON.stringify(first.data));

// 新增一篇 ⇒ 目录 mtime 变 ⇒ 必须失效（否则用户新建笔记后树里看不到）
writeFileSync(join(vault, '笔记', 'b.md'), '# B\n', 'utf8');
const third = await call('/x/kb/api/view-data');
t('新增笔记后缓存失效', third.cached === false, 'cached=' + third.cached);
t('篇数已变成 2', third.data && third.data.noteCount === 2, 'noteCount=' + (third.data && third.data.noteCount));

const forced = await call('/x/kb/api/view-data?refresh=1');
t('refresh=1 无条件绕过缓存', forced.cached === false, 'cached=' + forced.cached);

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（view-data 缓存）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（view-data 缓存：命中 / 失效 / 强制刷新）`);
