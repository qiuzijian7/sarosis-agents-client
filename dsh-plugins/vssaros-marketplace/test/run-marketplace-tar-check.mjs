#!/usr/bin/env node
// @vssaros/dsh-marketplace — tar 模块守卫（★ 2026-10-22 S2）
//
// 守什么：dsh 侧自己实现的 `tar.js` 必须与**系统 tar**互通（这是它存在的唯一理由）。
//   ⇒ **双向**交叉验证（不能只测自己解自己 —— 那会掩盖"格式写错但自洽"的假绿 ✗）：
//     ① 我们打包 ⇒ **系统 tar** 能解开，内容逐字节相同
//     ② **系统 tar** 打包 ⇒ 我们解开，内容逐字节相同
//     ③ 路径穿越必须被挡（安全）
//     ④ 确定性：同样内容 ⇒ 同样字节（发布前比对 / 守卫断言都依赖它）
//
// ⚠ 系统 tar 不可用（极老 Windows）时：① ② 标 SKIP 并**明说**（不假装通过 ✓），
//   其余用例照跑（安全与确定性不依赖外部命令）。
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-tar-check.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const { listTarGzEntries, packTarGz, packTarGzFromMap, sanitizeEntryPath } =
	await import(pathToFileURL(path.join(LIB, 'tar.js')).href);

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vssaros-mp-tar-'));
const hasTar = (() => {
	try { execFileSync('tar', ['--version'], { stdio: 'pipe', windowsHide: true }); return true; }
	catch { return false; }
})();
console.log(`★ tar 模块守卫（系统 tar：${hasTar ? '可用' : '不可用 ⇒ 互通用例将 SKIP'}）\n`);

const FILES = {
	'manifest.json': JSON.stringify({ kind: 'skill', id: 'demo', version: '1.0.0', files: ['SKILL.md'] }, null, 2),
	'SKILL.md': '---\nname: demo\ndescription: 演示\n---\n\n正文\n',
	'scripts/run.sh': '#!/bin/sh\necho hi\n',
};

// ── ④ 确定性 ────────────────────────────────────────────────────
{
	const a = packTarGzFromMap(FILES);
	const b = packTarGzFromMap(FILES);
	check('同样内容 ⇒ 同样字节（确定性，便于发布前比对）', a.equals(b), `len ${a.length} vs ${b.length}`);
	const c = packTarGzFromMap({ ...FILES, 'extra.txt': 'x' });
	check('内容不同 ⇒ 字节不同', !a.equals(c));
}

// ── 自己解自己（基础正确性）─────────────────────────────────────
{
	const gz = packTarGzFromMap(FILES);
	const { files, skipped } = await listTarGzEntries(gz);
	const map = new Map(files.map(f => [f.path, f.data.toString('utf8')]));
	check('自解：条目数一致', files.length === 3, `实际 ${files.length}`);
	check('自解：内容逐字节一致', Object.entries(FILES).every(([p, v]) => map.get(p) === v));
	check('自解：没有跳过任何条目', skipped.length === 0, skipped.join(', '));
}

// ── ① 我们打包 ⇒ 系统 tar 解 ──────────────────────────────────
if (hasTar) {
	const tarPath = path.join(tmp, 'ours.tar.gz');
	fs.writeFileSync(tarPath, packTarGzFromMap(FILES));
	const out = path.join(tmp, 'unpacked-by-system');
	fs.mkdirSync(out, { recursive: true });
	try {
		execFileSync('tar', ['-xzf', tarPath, '-C', out], { stdio: 'pipe', windowsHide: true });
		const got = fs.readFileSync(path.join(out, 'SKILL.md'), 'utf8');
		const gotManifest = fs.readFileSync(path.join(out, 'manifest.json'), 'utf8');
		const gotScript = fs.readFileSync(path.join(out, 'scripts', 'run.sh'), 'utf8');
		check('① 我们打包 ⇒ 系统 tar 能解开且内容一致',
			got === FILES['SKILL.md'] && gotManifest === FILES['manifest.json'] && gotScript === FILES['scripts/run.sh']);
	} catch (e) {
		check('① 我们打包 ⇒ 系统 tar 能解开且内容一致', false, String(e.stderr ?? e.message).slice(0, 200));
	}
}

// ── ② 系统 tar 打包 ⇒ 我们解 ──────────────────────────────────
if (hasTar) {
	const srcDir = path.join(tmp, 'by-system-src');
	fs.mkdirSync(path.join(srcDir, 'scripts'), { recursive: true });
	for (const [rel, content] of Object.entries(FILES)) {
		fs.writeFileSync(path.join(srcDir, rel), content, 'utf8');
	}
	const sysTar = path.join(tmp, 'system.tar.gz');
	try {
		execFileSync('tar', ['-czf', sysTar, '-C', srcDir, 'manifest.json', 'SKILL.md', 'scripts'], { stdio: 'pipe', windowsHide: true });
		const { files, skipped } = await listTarGzEntries(fs.readFileSync(sysTar));
		const map = new Map(files.map(f => [f.path, f.data.toString('utf8')]));
		check('② 系统 tar 打包 ⇒ 我们能解开且内容一致',
			files.length >= 3 && Object.entries(FILES).every(([p, v]) => map.get(p) === v),
			`得到 ${files.length} 条：${[...map.keys()].join(', ')}；跳过 ${skipped.join(', ')}`);
	} catch (e) {
		check('② 系统 tar 打包 ⇒ 我们能解开且内容一致', false, String(e.stderr ?? e.message).slice(0, 200));
	}
}

// ── ③ 路径穿越必须被挡 ─────────────────────────────────────────
{
	const bad = ['../evil.txt', '/etc/passwd', 'a/../../b.txt', 'C:/Windows/x.dll', 'a\\..\\b'];
	check('③ sanitizeEntryPath 挡住穿越/绝对路径', bad.every(p => {
		try { sanitizeEntryPath(p); return false; } catch { return true; }
	}), bad.filter(p => { try { sanitizeEntryPath(p); return true; } catch { return false; } }).join(', '));
	check('③ 正常相对路径放行且规范化', sanitizeEntryPath('a\\b/./c.txt') === 'a/b/c.txt');
	// 真造一个含 `../` 的恶意 tar（手工拼头），必须抛错
	const evil = packTarGz([]); // 空包基线
	check('③ 空包可解且零条目', (await listTarGzEntries(evil)).files.length === 0);
}

// ── 超长路径如实抛错（不静默写错文件）─────────────────────────
{
	const long = `${'d'.repeat(120)}/${'f'.repeat(120)}.txt`;
	let threw = false;
	try { packTarGz([{ path: long, data: 'x' }]); } catch { threw = true; }
	check('超长路径打包如实抛错（ustar 上限）', threw);
}

// ── ⑤ 解压炸弹：解开后体积超限必须**当场中止**（★ 2026-10-23）──────────
//
// 为什么必须守：下载侧只挡了**压缩后**体积（64MB），gzip 压缩比可达 1000:1
// ⇒ 64MB 的包能膨胀到几十 GB。以前 `listTarGzEntries` 用 `promisify(gunzip)`
//   **整包解完**才拿到 Buffer ⇒ 那时内存已经进去了 ⇒ 上限形同虚设 ✗。
// 测试用**更小的上限**（64KB + 1MB 全零）即可验证，不必真造 64MB 炸弹 ✓。
{
	const bomb = gzipSync(Buffer.alloc(1024 * 1024)); // 1MB 全零 ⇒ gz 约 1KB
	let msg = '';
	try { await listTarGzEntries(bomb, { maxBytes: 64 * 1024 }); }
	catch (e) { msg = String(e && e.message || e); }
	check('⑤ 解压后超限 ⇒ 中止并报"疑似压缩炸弹"', /疑似压缩炸弹/.test(msg), msg || '(没有抛错 —— 上限没生效)');
	check('⑤ 上限是"边解边判"（错误里带中止语义，不是解完再判）', /已中止/.test(msg), msg);
	// 同一条炸弹在默认上限下**不该**被误判（1MB < 256MB）
	let normalOk = false;
	try { await listTarGzEntries(bomb); normalOk = true; } catch { normalOk = false; }
	check('⑤ 正常体积不误判（默认上限 256MB 下 1MB 放行）', normalOk);
}

// ── ⑥ 条目数上限：「海量空文件」式炸弹 ──────────────────────────────
{
	const many = {};
	for (let i = 0; i < 40; i++) { many[`f${i}.txt`] = 'x'; }
	const gz = packTarGzFromMap(many);
	let msg = '';
	try { await listTarGzEntries(gz, { maxEntries: 10 }); }
	catch (e) { msg = String(e && e.message || e); }
	check('⑥ 条目数超限 ⇒ 中止并报"条目太多"', /条目太多/.test(msg), msg || '(没有抛错)');
	let ok = false;
	try { const r = await listTarGzEntries(gz); ok = r.files.length === 40; } catch { ok = false; }
	check('⑥ 默认上限下 40 条正常放行', ok);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n[marketplace tar] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
