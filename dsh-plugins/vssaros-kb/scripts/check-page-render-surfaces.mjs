/*
 * 守卫（渲染级）：三形态**真渲染**一遍，断言 HTML 形状（2026-10-21，规范见 doc/workbench-authoring-standard.md）。
 *
 * 与 check-page-surfaces.mjs 的分工：
 *   · 那个看**源码接线**（选了哪个脚本、attrs 有没有、kind 有没有被改）；
 *   · 这个看**真输出**（`renderPage` 真跑一遍，`?surface=` 三种各一份 HTML）。
 *   ⇒ 只有这一层能咬住"接线看着对、但渲染抛错回 500"或"目录版里还是混进了目录块以外的正文块"。
 *
 * 为什么能不起 Host：插件的页面路由是 `ctx.inject(['webServer','connection'], …)` 注册的 ⇒
 * 用**假 ctx** 把 handler 抓出来直接调（与探针同一条思路）；foundation 用**真服务**
 * （renderShell / escapeHtml 都在它那，假不了 —— 最初这一层就因为没给 foundation 而三态全 500 ✓）。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-page-render-surfaces.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB_INDEX = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const FOUNDATION = fileURLToPath(new URL('../../vssaros-foundation/lib/index.js', import.meta.url));

let pass = 0;
const failed = [];
function check(name, cond, detail = '') {
	if (cond) { pass += 1; console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`); }
	else { failed.push(name); console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`); }
}

const mod = await import('file:///' + KB_INDEX.replace(/\\/g, '/'));
const fnd = await import('file:///' + FOUNDATION.replace(/\\/g, '/'));
const foundation = fnd.createFoundationService();

// ── 夹具：一个真实库根（两篇笔记 + 库/笔记两节）─────────────────────────
const root = mkdtempSync(join(tmpdir(), 'kb-surface-'));
let handler;
try {
	const vaultDir = join(root, 'vault1');
	mkdirSync(join(vaultDir, '笔记'), { recursive: true });
	mkdirSync(join(vaultDir, '库'), { recursive: true });
	writeFileSync(join(vaultDir, '笔记', 'hello.md'), '# hello\n\n正文一行。\n');
	writeFileSync(join(vaultDir, '笔记', 'second.md'), '# second\n\n第二篇。\n');

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
			if (key === 'effect') {
				return fn => { try { const d = fn(); return typeof d === 'function' ? d : noop(); } catch { return noop(); } };
			}
			if (key === 'get') { return name => (name === 'vssarosFoundation' ? foundation : null); }
			if (key === 'tools') { return { register: noop }; }
			if (key === 'on') { return noop; }
			return undefined;
		},
	});

	mod.apply(ctx, { dataRoot: root, hostHalf: true, kbVaults: [{ id: 'vault1', name: '演示库' }] });
	check('页面路由抓得到（ctx.inject 形状没变）', typeof handler === 'function');
	if (typeof handler !== 'function') { throw new Error('no handler'); }

	async function render(query, base = '/x/kb/') {
		let html = '';
		const res = {
			status: 0,
			writeHead(status) { this.status = status; },
			end(body) { html += body ?? ''; },
		};
		await handler({ url: base + query }, res);
		return { status: res.status, html };
	}

	// ★ 2026-10-24（产品决定：知识库主入口用新版）：`/x/kb/`（**含带 `?surface=` 的**，
	//   宿主 `dshPluginPage.ts` 会自己注入）一律出 **React 侧栏页**；经典 SSR 三态退到
	//   `/x/kb/classic`（仍走 renderPage）⇒ 下面的经典断言改探 classic。
	const bare = await render('');
	const sideviewWithParam = await render('?surface=sideview');   // 宿主真实进入形态
	const full = await render('?surface=full', 'classic');
	const sideview = await render('?surface=sideview', '/x/kb/classic');
	const editor = await render('?surface=editor', '/x/kb/classic');
	const unknown = await render('?surface=nonsense', '/x/kb/classic');

	check('三种表面都 200', [full, sideview, editor].every(r => r.status === 200),
		`${full.status}/${sideview.status}/${editor.status}`);
	check('full 打标', full.html.includes('data-vssaros-surface="full"'));
	check('sideview 打标', sideview.html.includes('data-vssaros-surface="sideview"'));
	check('editor 打标', editor.html.includes('data-vssaros-surface="editor"'));
	check('未知 surface 回落完整页', unknown.html.includes('data-vssaros-surface="full"'));

	// 2026-10-24：钉住"裸主页 = React 壳"这条产品决定（否则将来有人把接管改回去，没人会发现 ✗）
	check('裸 /x/kb/ 出 React 壳（注入数据 + bundle 都在）',
		bare.html.includes('__KB_SIDEVIEW_DATA__') && bare.html.includes('kbSideview.js'));
	check('裸 /x/kb/ 不再出经典三态页（无 data-vssaros-surface）',
		!bare.html.includes('data-vssaros-surface'));
	// ★ 宿主真实进入形态：`dshPluginPage.ts` 会注入 `?surface=sideview` ⇒ 这条必须也出 React 壳，
	//   否则真机上"改了代码页面不变"（2026-10-24 踩过：按 surface 分流把新版整条路堵死了）。
	check('/x/kb/?surface=sideview 也出 React 壳（宿主注入参数时不能退回旧页）',
		sideviewWithParam.html.includes('__KB_SIDEVIEW_DATA__') && !sideviewWithParam.html.includes('data-vssaros-surface'));

	check('full 有目录块', full.html.includes('data-vault-block'));
	check('full 有页内预览脚本', full.html.includes('data-preview-title'));
	check('sideview 有目录块', sideview.html.includes('data-vault-block'));
	check('sideview 有可点条目', sideview.html.includes('data-doc-row'));
	check('sideview 无页内预览脚本（正文不进目录页）', !sideview.html.includes('data-preview-title'));
	check('editor 有正文占位锚点', editor.html.includes('data-doc-view-body'));
	check('editor 无目录块', !editor.html.includes('data-vault-block'));
	check('editor 无目录脚本', !editor.html.includes('data-doc-row'));
	check('三态 kind 仍是 kb（探针锚点）',
		[full, sideview, editor].every(r => r.html.includes('data-vssaros-page="kb"')));
	check('diag 行三态都在（data-vssaros-kb-scan）',
		[full, sideview, editor].every(r => r.html.includes('data-vssaros-kb-scan')));

	// 选中项契约（目录页写 / 正文页读，键名必须同一串）
	const src = readFileSync(KB_INDEX, 'utf8');
	check('选中键名两侧一致（vssaros.wb.kb.sel）', (src.match(/vssaros\.wb\.kb\.sel/g) ?? []).length >= 2);
	check('目录侧经 openModulePage 打开正文页', src.includes("bridge.openModulePage('/x/kb/')"));
} finally {
	try { rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录清不掉不影响结论 */ }
}

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项未通过：${failed.join(' / ')}`);
	process.exit(1);
}
console.log(`✓ 全部 ${pass} 项通过`);
