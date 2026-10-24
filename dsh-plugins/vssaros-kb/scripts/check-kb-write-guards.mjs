/*
 * 守卫（写入级）：把 `/api/doc`（保存）、`/api/asset/upload`（附件）、`/api/backup*`（备份）
 * 的**拒绝路径**逐条钉住（2026-10-24）。
 *
 * 为什么必须要有这一层：
 *   这三条是**会改用户文件**的接口。功能测试只能证明"正常情况能写"，证明不了
 *   "库区不会被写、库外不会被写、`../` 穿不出去、超限会被拒" —— 而后者才是真出事的地方。
 *
 * 手法与 `check-page-render-surfaces.mjs` 一致：假 ctx 抓出 handler，直接喂 req/res，
 * 用一个临时库（`笔记/` + `库/`）跑，不需要启动 Host、不碰真实知识库。
 *
 * 跑法：node dsh-plugins/vssaros-kb/scripts/check-kb-write-guards.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, utimesSync } from 'node:fs';
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

const root = mkdtempSync(join(tmpdir(), 'kb-write-'));
const vaultDir = join(root, 'vault1');
const notesDir = join(vaultDir, '笔记');
const libDir = join(vaultDir, '库');
mkdirSync(notesDir, { recursive: true });
mkdirSync(libDir, { recursive: true });
writeFileSync(join(notesDir, 'a.md'), '# a\n\n原始内容\n');
writeFileSync(join(libDir, 'b.md'), '# b\n\n库区内容\n');
const outside = mkdtempSync(join(tmpdir(), 'kb-outside-'));
writeFileSync(join(outside, 'secret.md'), 'secret\n');

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
		if (key === 'get') { return name => (name === 'vssarosFoundation' ? foundation : null); }
		if (key === 'tools') { return { register: noop }; }
		if (key === 'on') { return noop; }
		return undefined;
	},
});

// ⚠ `path` 必须给：真实环境（IDE 注入）的库就是带绝对路径的，插件的读写围栏靠它认定"哪些目录可写"。
//   不给 path ⇒ 只剩数据根，`vault1/` 不在里面 ⇒ 一切写入 403（第一版探针就是这样误报的）。
// `kbVaults` 按**真实注入形态**给：JSON 字符串（IDE 的 overlay 里就是单引号包着的一串 JSON）。
mod.apply(ctx, { dataRoot: root, hostHalf: true, kbVaults: JSON.stringify([{ id: 'vault1', name: '演示库', path: vaultDir }]) });
check('handler 抓得到', typeof handler === 'function');
if (typeof handler !== 'function') { process.exit(1); }

async function call(method, path, body) {
	let status = 0;
	let out = '';
	const res = { writeHead(s) { status = s; }, end(b) { out += (b === undefined || b === null) ? '' : String(b); } };
	const buf = body === undefined ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
	const req = {
		method,
		url: path,
		async *[Symbol.asyncIterator]() { if (buf) { yield buf; } },
	};
	await handler(req, res);
	let json = null;
	try { json = JSON.parse(out); } catch { /* 非 JSON 响应（如 HTML）忽略 */ }
	return { status, out, json };
}

const docA = join(notesDir, 'a.md').replace(/\\/g, '/');
const docB = join(libDir, 'b.md').replace(/\\/g, '/');
const secret = join(outside, 'secret.md').replace(/\\/g, '/');

// ── 1. 正常保存 ─────────────────────────────────────────────
{
	const r = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: docA, text: '# a\n\n改过一次\n' }));
	check('笔记区可写（200）', r.status === 200 && r.json?.ok === true, `status=${r.status} err=${r.json?.error ?? ''}`);
	check('内容真的落盘', readFileSync(docA, 'utf8').includes('改过一次'));
	check('返回了新 mtime', typeof r.json?.mtime === 'number' && r.json.mtime > 0);
	check('自动生成了备份', (r.json?.backup ?? '') !== '' && existsSync(r.json.backup));
}

// ── 2. 库区只读 ─────────────────────────────────────────────
{
	const before = readFileSync(docB, 'utf8');
	const r = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: docB, text: '改写库区' }));
	check('库区写入被拒（403）', r.status === 403, `status=${r.status}`);
	check('库区文件未被改动', readFileSync(docB, 'utf8') === before);
}

// ── 3. 库外路径 ─────────────────────────────────────────────
{
	const r = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: secret, text: 'x' }));
	check('库外写入被拒（403）', r.status === 403, `status=${r.status}`);
	check('库外文件未被改动', readFileSync(secret, 'utf8') === 'secret\n');
}

// ── 4. 扩展名 ───────────────────────────────────────────────
{
	const r = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: join(notesDir, 'x.txt').replace(/\\/g, '/'), text: 'x' }));
	check('非 .md 被拒（400）', r.status === 400, `status=${r.status}`);
}

// ── 5. mtime 冲突 ───────────────────────────────────────────
{
	// 把文件 mtime 往前拨 10 秒，再用"读入时"的旧值去写 ⇒ 必须 409
	const past = Date.now() / 1000 - 10;
	utimesSync(docA, past, past);
	const r = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: docA, text: '冲突内容', expectedMtime: Date.now() }));
	check('mtime 不符 ⇒ 409 conflict', r.status === 409 && r.json?.conflict === true, `status=${r.status}`);
	check('冲突时不写盘', !readFileSync(docA, 'utf8').includes('冲突内容'));
	// 不带 expectedMtime ⇒ 强制覆盖
	const force = await call('POST', '/x/kb/api/doc', JSON.stringify({ uri: docA, text: '强制覆盖\n' }));
	check('不带 expectedMtime 可强制写', force.status === 200 && readFileSync(docA, 'utf8').includes('强制覆盖'));
}

// ── 6. 备份列表 / 恢复 ──────────────────────────────────────
{
	const list = await call('GET', '/x/kb/api/backup?doc=' + encodeURIComponent(docA));
	check('备份列表 200 且有条目', list.status === 200 && (list.json?.items?.length ?? 0) > 0, `items=${list.json?.items?.length}`);
	const name = list.json?.items?.[0]?.name ?? '';

	const bad = await call('POST', '/x/kb/api/backup/restore', JSON.stringify({ doc: docA, name: '../../secret.md.bak' }));
	check('恢复：带路径的备份名被拒（400）', bad.status === 400, `status=${bad.status}`);

	const noSuch = await call('POST', '/x/kb/api/backup/restore', JSON.stringify({ doc: docA, name: 'nope.md.bak' }));
	check('恢复：不存在的备份（404）', noSuch.status === 404, `status=${noSuch.status}`);

	const ok = await call('POST', '/x/kb/api/backup/restore', JSON.stringify({ doc: docA, name }));
	check('恢复：正常备份可恢复（200）', ok.status === 200 && ok.json?.ok === true, `status=${ok.status}`);
	const restored = readFileSync(docA, 'utf8');
	check('恢复后内容变回旧版本', !restored.includes('强制覆盖'));
	let hasPre = false;
	try { hasPre = readdirSync(join(notesDir, '.kb-backup')).some(f => f.includes('.pre-restore.md.bak')); } catch { hasPre = false; }
	check('恢复前留了 pre-restore 备份', hasPre);
}

// ── 7. 附件上传 ─────────────────────────────────────────────
{
	const bad = await call('POST', '/x/kb/api/asset/upload?doc=' + encodeURIComponent(docA) + '&name=x.exe', Buffer.from('MZ'));
	check('上传：非法扩展名被拒（400）', bad.status === 400, `status=${bad.status}`);

	const libUp = await call('POST', '/x/kb/api/asset/upload?doc=' + encodeURIComponent(docB) + '&name=x.png', Buffer.from('png'));
	check('上传：库区被拒（403）', libUp.status === 403, `status=${libUp.status}`);

	const okUp = await call('POST', '/x/kb/api/asset/upload?doc=' + encodeURIComponent(docA) + '&name=shot.png', Buffer.from('png-bytes'));
	check('上传：笔记区成功（200）', okUp.status === 200 && okUp.json?.ok === true, `status=${okUp.status}`);
	check('上传：落点在 _assets 且 rel 是相对路径',
		(okUp.json?.abs ?? '').includes('/笔记/_assets/') && (okUp.json?.rel ?? '').startsWith('_assets/'),
		okUp.json?.rel ?? '');
	check('上传：字节一致', existsSync(okUp.json?.abs ?? '') && readFileSync(okUp.json.abs, 'utf8') === 'png-bytes');

	const wrong = await call('GET', '/x/kb/api/asset/upload?doc=' + encodeURIComponent(docA) + '&name=x.png');
	check('上传：GET 被拒（405）', wrong.status === 405, `status=${wrong.status}`);
}

// ── 8. 附件读取的围栏 ───────────────────────────────────────
{
	const leak = await call('GET', '/x/kb/api/asset?uri=' + encodeURIComponent(secret));
	check('asset：库外路径被拒（404）', leak.status === 404, `status=${leak.status}`);

	const good = await call('GET', '/x/kb/api/asset?uri=' + encodeURIComponent(docA.replace(/\.md$/, '.md')));
	check('asset：非白名单类型被拒（.md 不是素材 ⇒ 404）', good.status === 404, `status=${good.status}`);
}

console.log('\n' + '='.repeat(60));
if (failed.length) {
	console.log(`✗ ${failed.length} 项失败 / 共 ${pass + failed.length} 项`);
	for (const f of failed) { console.log('   - ' + f); }
	process.exit(1);
} else {
	console.log(`✓ 全部 ${pass} 项写护栏通过`);
}
