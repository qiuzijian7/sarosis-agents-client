/**
 * P1 · 移植等价守卫（零硬编码期望条数）。
 *
 * 以上游 14 个纯逻辑测试的**实际运行结果**当基线，逐例与 JS 化版本对照：
 * exit code、✓ 数、✗ 数三者必须一致，且基线本身必须 exit 0 / 0 失败。
 * 另检查：源/产物哈希漂移、产物残留、以及 mirror 内是否混入 @deepseek-ai/* 运行时依赖。
 *
 * 用法：node port/run-check.mjs   （先跑 port-core.mjs 生成产物）
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const MIRROR = join(ROOT, 'port', 'mirror');
const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));

let failures = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => { console.error(`  ✗ ${msg}`); failures += 1; };
const sha = (text) => createHash('sha256').update(text).digest('hex');

console.log('── 1) 产物完整性与漂移 ──');
let drift = 0;
for (const [rel, hash] of Object.entries(manifest.sourceHashes)) {
	const file = join(ROOT, rel);
	if (!existsSync(file) || sha(readFileSync(file, 'utf8')) !== hash) { bad(`上游源已变：${rel}`); drift += 1; }
}
for (const [rel, hash] of Object.entries(manifest.outputHashes)) {
	const file = join(ROOT, rel);
	if (!existsSync(file) || sha(readFileSync(file, 'utf8')) !== hash) { bad(`产物被改或缺失：${rel}`); drift += 1; }
}
if (drift === 0) ok(`${Object.keys(manifest.sourceHashes).length} 个源 + ${Object.keys(manifest.outputHashes).length} 个产物哈希一致`);

function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(abs));
		else if (entry.name.endsWith('.js')) out.push(abs);
	}
	return out;
}
const jsFiles = existsSync(MIRROR) ? walk(MIRROR) : [];
if (jsFiles.length !== manifest.generated.length) bad(`产物数不一致：磁盘 ${jsFiles.length} / manifest ${manifest.generated.length}`);
else ok(`产物数一致（${jsFiles.length}）`);

console.log('── 2) 零宿主运行时依赖 ──');
let deps = manifest.hostDeps.length;
for (const file of jsFiles) {
	const src = readFileSync(file, 'utf8');
	const hits = [...src.matchAll(/\bfrom\s*['"](@deepseek-ai\/[^'"]+)['"]/g)].map((m) => m[1]);
	for (const hit of hits) { bad(`${relative(ROOT, file).split(sep).join('/')} 依赖 ${hit}`); deps += 1; }
}
if (deps === 0) ok('port/mirror 内无 @deepseek-ai/* 运行时 import');

console.log('── 3) 上游基线 ↔ JS 化对照 ──');
function run(file, home) {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	env.DSH_HOME = home;
	const r = spawnSync(process.execPath, [file], {
		cwd: ROOT, env, encoding: 'utf8', timeout: 120_000, windowsHide: true,
	});
	const out = `${r.stdout || ''}${r.stderr || ''}`;
	return {
		code: typeof r.status === 'number' ? r.status : -1,
		pass: (out.match(/✓/g) || []).length,
		fail: (out.match(/✗/g) || []).length,
		out,
	};
}

const scratch = mkdtempSync(join(tmpdir(), 'tf-port-check-'));
let matched = 0;
let totalUp = 0;
let totalPort = 0;
try {
	for (const name of manifest.baselineTests) {
		const up = join(ROOT, 'test', `${name}.test.js`);
		const port = join(ROOT, 'test', `port-${name}.test.js`);
		if (!existsSync(port)) { bad(`缺少移植测试：test/port-${name}.test.js`); continue; }
		const a = run(up, join(scratch, `${name}-up`));
		const b = run(port, join(scratch, `${name}-port`));
		totalUp += a.pass;
		totalPort += b.pass;
		const same = a.code === b.code && a.pass === b.pass && a.fail === b.fail;
		const good = same && a.code === 0 && a.fail === 0 && a.pass > 0;
		if (good) { matched += 1; ok(`${name}: ${a.pass} 断言等价（exit ${a.code}）`); }
		else {
			bad(`${name}: 上游 exit=${a.code} ✓${a.pass} ✗${a.fail} / 移植 exit=${b.code} ✓${b.pass} ✗${b.fail}`);
			const diff = b.out.split('\n').filter((line) => /✗|Error|Cannot find|ERR_/.test(line)).slice(0, 4);
			for (const line of diff) console.error(`      ${line.trim()}`);
		}
	}
} finally {
	try { rmSync(scratch, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log('── 4) 状态机复用探针（本仓 vssaros-workitem ledger）──');
let bridgeOk = false;
const bridgeFile = join(HERE, 'run-bridge-check.mjs');
if (!existsSync(bridgeFile)) bad('缺少 port/run-bridge-check.mjs');
else {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	const r = spawnSync(process.execPath, [bridgeFile], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
	const out = `${r.stdout || ''}${r.stderr || ''}`;
	const summary = out.split('\n').filter((line) => line.includes('[bridge]')).pop();
	if (r.status === 0) { bridgeOk = true; ok(`状态机复用通过${summary ? `（${summary.trim()}）` : ''}`); }
	else {
		bad(`状态机复用探针 exit=${r.status}`);
		for (const line of out.split('\n').filter((x) => /✗ |Error: |Cannot find |ERR_/.test(x)).slice(0, 4)) console.error(`      ${line.trim()}`);
	}
}

console.log('── 5) 外部包内核副本（workbench/lib/core）──');
let copyOk = false;
const copies = manifest.workbenchCopies ?? [];
const copyHashes = manifest.workbenchHashes ?? {};
if (copies.length === 0) bad('manifest 里没有内核副本（先跑 port-core.mjs）');
else {
	let copyDrift = 0;
	for (const [rel, hash] of Object.entries(copyHashes)) {
		const file = join(ROOT, rel);
		if (!existsSync(file) || sha(readFileSync(file)) !== hash) { bad(`副本被改或缺失：${rel}`); copyDrift += 1; }
	}
	if (copyDrift === 0) { copyOk = true; ok(`${copies.length} 个内核副本与 mirror 逐字一致`); }
}

console.log('── 6) 上游 UI 机械移植（workbench/lib/client.teamflow.ui.js）──');
let uiOk = false;
const uiManifestFile = join(HERE, 'ui-manifest.json');
if (!existsSync(uiManifestFile)) bad('缺少 port/ui-manifest.json（先跑 port-ui.mjs）');
else {
	const ui = JSON.parse(readFileSync(uiManifestFile, 'utf8'));
	let uiDrift = 0;
	if (ui.upstreamHead !== manifest.upstreamHead) { bad(`UI 移植基于 ${String(ui.upstreamHead).slice(0, 12)}，内核基于 ${manifest.upstreamHead.slice(0, 12)}（两份上游版本不一致）`); uiDrift += 1; }
	for (const [rel, hash] of Object.entries(ui.sources || {})) {
		const file = join(ROOT, rel);
		if (!existsSync(file) || sha(readFileSync(file)) !== hash) { bad(`上游 UI 源已变：${rel}（重跑 port-ui.mjs 并复核补丁）`); uiDrift += 1; }
	}
	const outFile = join(ROOT, ui.output || '');
	if (!existsSync(outFile) || sha(readFileSync(outFile)) !== ui.outputSha256) { bad(`UI 产物被手改或缺失：${ui.output}（只能由 port-ui.mjs 生成）`); uiDrift += 1; }
	if (uiDrift === 0) { uiOk = true; ok(`${Object.keys(ui.sources || {}).length} 个上游 UI 源 + 产物哈希一致 · 补丁 ${(ui.patches || []).map((p) => p.id).join(' / ')}`); }
}

console.log(`\n[P1/P2/P3] ${matched}/${manifest.baselineTests.length} 组等价 · 上游 ${totalUp} 断言 / JS 化 ${totalPort} 断言 · 漂移 ${drift} · 宿主依赖 ${deps} · 状态机复用 ${bridgeOk ? 'OK' : 'FAIL'} · 内核副本 ${copyOk ? 'OK' : 'FAIL'} · UI 移植 ${uiOk ? 'OK' : 'FAIL'} · upstream ${manifest.upstreamHead.slice(0, 12)}`);
process.exit(failures === 0 && matched === manifest.baselineTests.length && bridgeOk && copyOk && uiOk ? 0 : 1);
