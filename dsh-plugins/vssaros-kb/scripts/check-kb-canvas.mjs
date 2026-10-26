/*
 * 守卫：**导图（.canvas）路由**（2026-10-25）。
 *
 * 背景：IDE 侧「思维导图」是"在编辑器里打开 .canvas"；dsh 面板没有编辑器，
 * 所以改成**服务端解析 + 前端自己画**。这条守卫锁住解析契约：
 *   ① 清单能找到 .canvas
 *   ② 解析出 nodes/edges（含 source.file → 可跳笔记）
 *   ③ 坏 JSON 如实报错（不抛栈）
 *   ④ 非 .canvas 扩展名拒绝
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-canvas.mjs
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

const vault = mkdtempSync(join(tmpdir(), 'kb-canvas-'));
mkdirSync(join(vault, '库'), { recursive: true });
mkdirSync(join(vault, '笔记', '图'), { recursive: true });
writeFileSync(join(vault, '笔记', 'a.md'), '# A\n', 'utf8');

const good = {
	nodes: [
		{ id: 'n1', type: 'text', width: 200, height: 60, x: 0, y: 0, content: '根节点', source: { file: 'a.md', line: 1 } },
		{ id: 'n2', type: 'text', width: 200, height: 60, x: 320, y: 0, content: '子节点' },
	],
	edges: [{ id: 'e1', fromNode: 'n1', toNode: 'n2', label: '包含' }],
};
const canvasPath = join(vault, '笔记', '图', 'demo.canvas');
writeFileSync(canvasPath, JSON.stringify(good), 'utf8');
const badPath = join(vault, '笔记', '图', 'broken.canvas');
writeFileSync(badPath, '{ this is not json', 'utf8');
const notCanvas = join(vault, '笔记', 'a.md');

mod.apply(ctx, {
	dataRoot: mkdtempSync(join(tmpdir(), 'kb-canvas-root-')),
	hostHalf: true,
	kbVaults: JSON.stringify([{ id: 'demo', name: '临时库', path: vault }]),
});

const call = async (path) => {
	const out = [];
	await handler({ method: 'GET', url: path }, { writeHead() {}, end(b) { out.push(String(b ?? '')); } });
	return JSON.parse(out.join('') || '{}');
};

await call('/x/kb/api/view-data');   // 预热读围栏

let pass = 0;
const failed = [];
const t = (name, ok, extra = '') => {
	if (ok) { pass += 1; return; }
	failed.push(name);
	console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`);
};

const list = await call('/x/kb/api/canvas-list');
t('清单返回 ok 且有 2 个 .canvas', list.ok === true && Array.isArray(list.files) && list.files.length === 2,
	'files=' + (list.files || []).length);
t('清单项带绝对路径与相对路径', (list.files || []).every(f => f.abs && f.rel));

const one = await call('/x/kb/api/canvas?uri=' + encodeURIComponent(canvasPath.replace(/\\/g, '/')));
t('解析出 2 个节点 / 1 条边', one.ok === true && one.nodes.length === 2 && one.edges.length === 1,
	JSON.stringify({ n: one.nodes && one.nodes.length, e: one.edges && one.edges.length }));
t('节点带 source.file（可跳笔记）', (one.nodes || []).some(n => n.file === 'a.md'));
t('边带标签', (one.edges || []).some(e => e.label === '包含'));
t('返回导图名（去扩展名）', one.name === 'demo', 'name=' + one.name);
// 2026-10-25：视图侧要把 source.file（相对「笔记」）折回绝对路径 ⇒ 服务端必须给 notesRoot
t('返回 notesRoot（供视图折算节点路径）',
	typeof one.notesRoot === 'string' && one.notesRoot.replace(/\\/g, '/').endsWith('/笔记'),
	'notesRoot=' + one.notesRoot);

const broken = await call('/x/kb/api/canvas?uri=' + encodeURIComponent(badPath.replace(/\\/g, '/')));
t('坏 JSON 如实报错', broken.ok === false && String(broken.error || '').includes('解析'));

const wrongExt = await call('/x/kb/api/canvas?uri=' + encodeURIComponent(notCanvas.replace(/\\/g, '/')));
t('非 .canvas 被拒绝', wrongExt.ok === false);

console.log('='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项（导图路由）`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过（导图路由：清单 / 解析 / 错误 / 扩展名）`);
