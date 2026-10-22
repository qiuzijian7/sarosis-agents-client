#!/usr/bin/env node
// @vssaros/dsh-marketplace — **健壮性 / 危险路径**守卫（★ 2026-10-22 补齐）
//
// 为什么单开一套：其余四套测的是"正常业务流"（装/升/卸/发布/只读面），
// 而**真正会毁数据的是异常路径**：
//   · id 越界（`../` 拼进 join ⇒ 文件写到数据根**外面**）✗
//   · 包被替换/传坏（sha256 对不上还照装）✗
//   · 恶意 tar（穿越条目）✗
//   · 网络/服务端异常时**假装成功** ✗
//   · 台账被写坏后**把用户数据覆盖成空** ✗
//
// 跑法：node dsh-plugins/vssaros-marketplace/test/run-marketplace-robustness-check.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(HERE, '..', 'lib');
const importLib = (name) => import(pathToFileURL(path.join(LIB, name)).href);

const { packTarGz, packTarGzFromMap, sanitizeEntryPath } = await importLib('tar.js');
const {
	assertSafeStoreId, installBundle, installedVersionOf, sha256Of, uninstallBundle,
} = await importLib('installers.js');
const { readInstalled, removeInstalled, upsertInstalled } = await importLib('installedLedger.js');
const { createMarketClient, tofTicketOf } = await importLib('marketClient.js');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
	if (ok) { pass++; console.log(`  ok   ${name}`); }
	else { fails.push(name); console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`); }
};

const tmpRoots = [];
const tmp = (prefix) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpRoots.push(dir);
	return dir;
};

const SKILL_FILES = {
	'SKILL.md': '---\nname: demo\n---\n\n正文\n',
	'scripts/run.sh': 'echo hi\n',
};

/**
 * **手工构造**一个含穿越条目的 `tar.gz`（绕过我们自己的打包器）。
 *
 * 为什么必须手工：`packTarGzFromMap` 在打包侧就会拒绝 `../`（那是好事），
 * 所以"攻击者塞给我们一个恶意包"只能用原始 ustar 字节造出来 ✓
 *
 * @param {string} name 条目名（故意带 `../`）
 * @param {string} content 内容
 */
function makeEvilTarGz(name, content) {
	const data = Buffer.from(content, 'utf8');
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, 'utf8');
	header.write('0000644\0', 100, 8, 'ascii');           // mode
	header.write('0000000\0', 108, 8, 'ascii');           // uid
	header.write('0000000\0', 116, 8, 'ascii');           // gid
	header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii'); // size
	header.write('00000000000\0', 136, 12, 'ascii');      // mtime
	header.write('        ', 148, 8, 'ascii');            // checksum 先填空格
	header.write('0', 156, 1, 'ascii');                   // typeflag = regular
	header.write('ustar\0' + '00', 257, 8, 'ascii');      // magic + version
	let sum = 0;
	for (const byte of header) { sum += byte; }
	header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');

	const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512, 0);
	return gzipSync(Buffer.concat([header, data, pad(data.length), Buffer.alloc(1024, 0)]));
}



console.log('★ 商城健壮性 / 危险路径\n');

// ── ① id 越界（这是最危险的一条：会写到数据根外面）──────────────────
{
	const dataRoot = tmp('vssaros-mp-safe-');
	const pkg = packTarGzFromMap(SKILL_FILES);

	const badIds = ['', '.', '..', '../evil', '..\\evil', 'a/b', 'a\\b', 'C:evil', '/abs', 'a\u0000b'];
	const accepted = [];
	for (const bad of badIds) {
		let threw = '';
		try { assertSafeStoreId(bad); } catch (e) { threw = String(e.message ?? e); }
		if (!threw) { accepted.push(JSON.stringify(bad)); }
	}
	check('① assertSafeStoreId 拒绝全部越界 id（空/./../分隔符/盘符/控制字符）',
		accepted.length === 0, `被放行的：${accepted.join(', ')}`);
	check('① 正常 slug 放行', assertSafeStoreId('normal-skill_1.2') === 'normal-skill_1.2');

	// 端到端：越界 id 必须**连目录都不建**
	let threwInstall = '';
	try {
		await installBundle({ dataRoot, kind: 'skill', storeId: '../escaped', version: '1.0.0', gzBuffer: pkg });
	} catch (e) { threwInstall = String(e.message ?? e); }
	const escaped = path.join(dataRoot, '..', 'escaped');
	check('① installBundle 拒绝越界 storeId（报错可读）',
		threwInstall.includes('不能含路径分隔符') || threwInstall.includes('不能是'), threwInstall);
	check('① 越界 id **没有在数据根外建出目录**', !fs.existsSync(escaped), escaped);

	let threwUninstall = '';
	try { await uninstallBundle({ dataRoot, kind: 'skill', storeId: '../escaped' }); }
	catch (e) { threwUninstall = String(e.message ?? e); }
	check('① uninstallBundle 也拒绝越界 id（否则 rm -rf 会删到外面）✗',
		threwUninstall.length > 0, threwUninstall || '(没报错!)');

	let threwVersion = '';
	try { await installedVersionOf({ dataRoot, kind: 'skill', storeId: '../escaped' }); }
	catch (e) { threwVersion = String(e.message ?? e); }
	check('① installedVersionOf 也拒绝越界 id', threwVersion.length > 0, threwVersion || '(没报错!)');
}

// ── ② sha256：对不上必须拒，且**不落任何文件** ────────────────────
{
	const dataRoot = tmp('vssaros-mp-sha-');
	const pkg = packTarGzFromMap(SKILL_FILES);
	const good = sha256Of(pkg);
	const wrong = 'f'.repeat(64);

	let threw = '';
	try {
		await installBundle({
			dataRoot, kind: 'skill', storeId: 'sha-skill', version: '1.0.0',
			gzBuffer: pkg, expectedSha256: wrong,
		});
	} catch (e) { threw = String(e.message ?? e); }
	check('② sha256 不匹配 ⇒ 报错且文案说明原因（损坏/被替换）',
		threw.includes('sha256') && (threw.includes('损坏') || threw.includes('替换')), threw);
	check('② sha256 不匹配时**没有落目录**（先验包再碰磁盘）',
		!fs.existsSync(path.join(dataRoot, 'skills', 'sha-skill')));

	// 大写 hex 也要能对上（服务端可能存大写）
	const up = await installBundle({
		dataRoot, kind: 'skill', storeId: 'sha-upper', version: '1.0.0',
		gzBuffer: pkg, expectedSha256: good.toUpperCase(),
	});
	check('② sha256 大小写不敏感（大写 hex 也认）', fs.existsSync(up.targetDir));

	// 不传 expectedSha256 ⇒ 不校验（服务端未登记 sha 的旧包）
	const noSha = await installBundle({
		dataRoot, kind: 'skill', storeId: 'sha-none', version: '1.0.0', gzBuffer: pkg,
	});
	check('② 不传 expectedSha256 ⇒ 不校验（兼容未登记 sha 的旧包）', fs.existsSync(noSha.targetDir));
}

// ── ③ 恶意包：打包侧与解包侧**都要**挡穿越 ────────────────────────
{
	// ③a 打包侧：我们自己的打包器不许产出穿越条目（否则自己的包就能伤人）
	let packThrew = '';
	try { packTarGzFromMap({ '../evil.txt': 'pwned', 'SKILL.md': '---\nname: x\n---\n' }); }
	catch (e) { packThrew = String(e.message ?? e); }
	check('③ 打包侧拒绝穿越条目（`../evil.txt` 直接报错）',
		packThrew.includes('穿越'), packThrew || '(没报错 ⇒ 我们的包能写出去 ✗)');

	// ③b 解包侧：**手工构造**一个含穿越条目的 tar.gz（绕过我们的打包器）
	//   —— 这才是攻击者真正能塞给我们的东西
	const evilGz = makeEvilTarGz('../evil.txt', 'pwned');
	const dataRoot = tmp('vssaros-mp-evil-');
	let threw = '';
	try { await installBundle({ dataRoot, kind: 'skill', storeId: 'evil-skill', version: '1.0.0', gzBuffer: evilGz }); }
	catch (e) { threw = String(e.message ?? e); }
	// 要么拒绝，要么规范化到包内 —— 但**绝不能**在数据根外出现文件
	let wroteOutside = false;
	const probes = [
		path.join(path.dirname(dataRoot), 'evil.txt'),
		path.join(dataRoot, '..', '..', 'evil.txt'),
		path.join(dataRoot, 'skills', 'evil.txt'),
	];
	for (const probe of probes) { if (fs.existsSync(probe)) { wroteOutside = true; } }
	check('③ 恶意 tar（穿越条目）⇒ **没有写到数据根外**', !wroteOutside, probes.join(' | '));
	check('③ 恶意 tar 被**明确拒绝**（不静默吞掉）', threw.length > 0, threw || '(没报错)');
	check('③ 被拒时也没留下半个安装目录',
		!fs.existsSync(path.join(dataRoot, 'skills', 'evil-skill')));

	// ⚠ `sanitizeEntryPath` 对越界输入是**抛错**（不是返回 null —— 静默丢弃会让
	//   一个恶意包"部分装成功"，那更糟 ✗）。这里逐个确认都会抛。
	const badPaths = ['../x', '..\\x', '/abs', 'C:\\x', ''];
	const notThrowing = badPaths.filter((p) => {
		try { sanitizeEntryPath(p); return true; } catch { return false; }
	});
	check('③ sanitizeEntryPath 对越界输入**一律抛错**（不静默丢弃）',
		notThrowing.length === 0, `未抛错的：${notThrowing.map(p => JSON.stringify(p)).join(', ')}`);
	check('③ 正常相对路径规范化放行',
		sanitizeEntryPath('a\\b/./c.txt') === 'a/b/c.txt');
}

// ── ④ 台账：写坏后不能把用户数据覆盖成空；并发写不丢 ──────────────
{
	const dataRoot = tmp('vssaros-mp-ledger-');
	const file = path.join(dataRoot, 'installed-packages.json');

	// 正常写入
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 'a', version: '1.0.0' });
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 'b', version: '2.0.0' });
	const both = await readInstalled(dataRoot);
	check('④ 台账写入两条', both.length === 2, JSON.stringify(both));

	// 坏 JSON：读要**降级为空**（不抛，页面还能开），但**不能顺手覆盖文件**
	fs.writeFileSync(file, '{ this is not json', 'utf8');
	const broken = await readInstalled(dataRoot);
	check('④ 台账是坏 JSON ⇒ 读回空数组（不抛、页面不白屏）', Array.isArray(broken) && broken.length === 0);
	check('④ 读坏台账**不覆盖原文件**（留证据可人工修）',
		fs.readFileSync(file, 'utf8').includes('this is not json'));

	// 一次成功写入应修复它
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 'c', version: '3.0.0' });
	const repaired = await readInstalled(dataRoot);
	check('④ 写一次即修复（坏文件被合法内容替换）', repaired.some(e => e.storeId === 'c'), JSON.stringify(repaired));

	// 并发 upsert：10 个不同 id 同时写 ⇒ 全都在（读-改-写串行化）
	await Promise.all(Array.from({ length: 10 }, (_, i) =>
		upsertInstalled(dataRoot, { kind: 'skill', storeId: `concurrent-${i}`, version: '1.0.0' })));
	const concurrent = await readInstalled(dataRoot);
	const gotAll = Array.from({ length: 10 }, (_, i) => `concurrent-${i}`)
		.every(id => concurrent.some(e => e.storeId === id));
	check('④ 并发 upsert 不丢条目（读-改-写串行）', gotAll, `共 ${concurrent.length} 条`);

	// 同 kind+storeId 覆盖（不产生重复行）
	await upsertInstalled(dataRoot, { kind: 'skill', storeId: 'a', version: '9.9.9' });
	const after = await readInstalled(dataRoot);
	check('④ 同 kind+storeId 是覆盖而非重复',
		after.filter(e => e.storeId === 'a').length === 1
		&& after.find(e => e.storeId === 'a').version === '9.9.9');

	// 删除
	await removeInstalled(dataRoot, 'skill', 'a');
	check('④ removeInstalled 生效', !(await readInstalled(dataRoot)).some(e => e.storeId === 'a'));
}

// ── ⑤ marketClient：网络/服务端异常必须**如实报**，不许假装成功 ────
{
	const creds = (ticket) => ({
		resolve: async (ref) => (ref === 'VSSAROS_TOF_TICKET_DSH' && ticket ? { value: ticket } : undefined),
		set: async () => { },
		unset: async () => { },
	});

	// 5a. fetch 直接抛（网线断了）
	{
		const m = createMarketClient({
			credentials: creds('tk'),
			config: { marketEndpoint: 'http://x' },
			fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
		});
		let msg = '';
		try { await m.list({ kind: 'skill' }); } catch (e) { msg = String(e.message ?? e); }
		check('⑤ 网络不可达 ⇒ 抛出且带原因（不返回空列表冒充成功）',
			msg.includes('ECONNREFUSED') || msg.includes('连不上') || msg.includes('fetch'), msg);
	}

	// 5b. 服务端 500（无 JSON body）
	{
		const m = createMarketClient({
			credentials: creds('tk'),
			config: { marketEndpoint: 'http://x' },
			fetchImpl: async () => ({ ok: false, status: 500, text: async () => '<html>oops</html>' }),
		});
		let msg = '';
		try { await m.list(); } catch (e) { msg = String(e.message ?? e); }
		check('⑤ 500 非 JSON ⇒ 文案含状态码（不吞成"未知错误"）', /500/.test(msg), msg);
	}

	// 5c. 200 但 body 不是 JSON
	{
		const m = createMarketClient({
			credentials: creds('tk'),
			config: { marketEndpoint: 'http://x' },
			fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>login page</html>' }),
		});
		let msg = '';
		try { await m.list(); } catch (e) { msg = String(e.message ?? e); }
		check('⑤ 200 但非 JSON（被网关/登录页拦截）⇒ 报错而不是静默空列表',
			msg.length > 0, msg || '(没报错 ⇒ 会静默空列表 ✗)');
	}

	// 5d. 没有票据 ⇒ 错误文案要说"怎么登录"
	{
		const m = createMarketClient({
			credentials: creds(''),
			config: { marketEndpoint: 'http://x' },
			fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{}' }),
		});
		let msg = '';
		try { await m.login(); } catch (e) { msg = String(e.message ?? e); }
		check('⑤ 无票据时 login 的报错**可执行**（提到 tof_signin / 登录）',
			/tof_signin|登录/.test(msg), msg);
	}
}

// ── ⑥ 发布：空目录 / 非法 kind 必须**发之前**就拒 ────────────────
{
	const { preparePublishBundle, PUBLISHABLE_KINDS } = await importLib('publisher.js');
	const dataRoot = tmp('vssaros-mp-pub-');

	// 空目录
	fs.mkdirSync(path.join(dataRoot, 'skills', 'empty-skill'), { recursive: true });
	let threw = '';
	try { await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'empty-skill', version: '1.0.0' }); }
	catch (e) { threw = String(e.message ?? e); }
	check('⑥ 空目录发布 ⇒ 打包前就拒（不传一个空包上去）', threw.length > 0, threw || '(没报错!)');

	// 非法 kind（workbench / 乱写）
	let badKind = '';
	try { await preparePublishBundle({ dataRoot, kind: 'workbench', localId: 'x', version: '1.0.0' }); }
	catch (e) { badKind = String(e.message ?? e); }
	check('⑥ 非法 kind ⇒ 明确说支持哪几类', badKind.includes('不支持') && badKind.includes(PUBLISHABLE_KINDS[0]), badKind);

	// 本地不存在
	let missing = '';
	try { await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'no-such', version: '1.0.0' }); }
	catch (e) { missing = String(e.message ?? e); }
	check('⑥ 本地没有这个资源 ⇒ 报错带路径', missing.includes('no-such'), missing);
}

// ── ⑦ 版本号：空/空白必须拒（别发一个 version:"" 上去）────────────
{
	const { preparePublishBundle } = await importLib('publisher.js');
	const dataRoot = tmp('vssaros-mp-ver-');
	fs.mkdirSync(path.join(dataRoot, 'skills', 'v-skill'), { recursive: true });
	fs.writeFileSync(path.join(dataRoot, 'skills', 'v-skill', 'SKILL.md'), '---\nname: v\n---\n\nx\n');
	let threw = '';
	try { await preparePublishBundle({ dataRoot, kind: 'skill', localId: 'v-skill', version: '   ' }); }
	catch (e) { threw = String(e.message ?? e); }
	check('⑦ 空白版本号 ⇒ 拒绝', threw.length > 0, threw || '(没报错!)');
}

for (const dir of tmpRoots) { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n[marketplace robustness] ${pass} passing / ${fails.length} failing`);
if (fails.length) { console.log('失败：' + fails.join('、')); }
process.exit(fails.length === 0 ? 0 : 1);
