/*
 * 守卫：**查重**（2026-10-25）。
 *
 * 只检测、不改文件 —— 这条守卫锁住"检测能力本身"：
 *   ① 近似重复（同主题改写）能被找到，且相似度 ≥ 阈值
 *   ② 完全重复能被单独归类（exact）
 *   ③ 无关笔记**不会**被误报（误报会让人不敢用这个功能）
 *   ④ 参数化的 vault 不存在时如实报错
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-dedupe.mjs
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

const vault = mkdtempSync(join(tmpdir(), 'kb-dedupe-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记'), { recursive: true });

const base = 'UE5 的 GC 采用增量标记清扫，主要参数有 TimeLimit 与 MaxObjectsPerFrame，'
	+ '在移动端要特别注意每帧上限，否则会出现卡顿。实测 S1Game 项目在 8ms 限时下稳定。';
writeFileSync(join(vault, '笔记', 'gc-a.md'), '# GC A\n\n' + base, 'utf8');
// 近似重复：改动约 20% 文字
writeFileSync(join(vault, '笔记', 'gc-b.md'), '# GC B\n\n' + base.replace('实测 S1Game 项目在 8ms 限时下稳定', '线上项目在 8 毫秒限时下表现稳定'), 'utf8');
// 完全重复：正文与标题都一致（文件名不同）⇒ 应进 exact
writeFileSync(join(vault, '笔记', 'gc-c.md'), '# GC A\n\n' + base, 'utf8');
// 无关内容（注意要 ≥ 40 个字符，否则会被"太短不参与"过滤掉）
writeFileSync(join(vault, '笔记', 'other.md'),
	'# 投资\n\n康波周期与资产配置的关系，主要看利率与通胀的错位，和引擎、GC、渲染都无关。'
	+ '这一篇纯粹是另一条主题线，用来验证查重不会把不相干的笔记判成重复。', 'utf8');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-dedupe-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path) => {
	const out = [];
	await handler({ method: 'GET', url: path }, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

await call('/x/kb/api/view-data');

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const r = await call('/x/kb/api/dedupe');
t('查重返回 ok 且扫描到 4 篇', r.ok === true && r.scanned === 4, 'scanned=' + r.scanned);
t('找到近似重复对（≥ 1）', r.pairCount >= 1, 'pairCount=' + r.pairCount);
t('相似度不低于阈值', (r.pairs || []).every(p => p.similarity >= r.threshold),
	JSON.stringify((r.pairs || []).slice(0, 2)));
t('完全重复被单独归类', r.exactCount >= 1, 'exactCount=' + r.exactCount);
t('gc-a / gc-c 出现在同一条完全重复里',
	(r.exact || []).some(list => list.some(p => p.endsWith('gc-a.md')) && list.some(p => p.endsWith('gc-c.md'))),
	JSON.stringify(r.exact));
t('无关笔记没有被误报',
	!(r.pairs || []).some(p => (p.a.endsWith('other.md') || p.b.endsWith('other.md'))),
	JSON.stringify((r.pairs || []).filter(p => p.a.includes('other') || p.b.includes('other'))));

// 库 id 不存在 ⇒ 与其它路由一致：**回退到第一个库**（不是报错），页面不会因为拼错 id 就打不开
const fallback = await call('/x/kb/api/dedupe?vault=不存在的库');
t('库 id 不存在时回退到第一个库', fallback.ok === true && fallback.scanned === 4,
	JSON.stringify(fallback).slice(0, 120));

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（查重）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（查重：近似 / 完全重复 / 不误报）`);
