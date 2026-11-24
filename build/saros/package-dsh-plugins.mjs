#!/usr/bin/env node
/**
 * package-dsh-plugins.mjs — 生成「插件补丁包」：只含变更的 dsh 插件，不产出 EXE。
 *
 * 产物（默认 build/saros/update-server/downloads/plugins/）：
 *   <flat-name>-<version>-<sha12>.tgz   每个插件一个 tar.gz（prefix: package/，同源 seed 归档格式）
 *   plugins-manifest.json                版本清单 + sha256 + 兼容门槛 + 可选 Ed25519 签名
 *
 * ⚠ 密钥**绝不**放进下载目录（会被 /downloads/** 公开）：生成/读取的密钥统一放
 *   .build/plugin-signing/{plugin-signing-key.pem,public-key.pem}（.build 已被 gitignore）。
 *   公钥由开发者取出后内置进客户端，不通过更新服务器分发。
 *
 * 与 EXE 的关系：本脚本**不**调用 Inno Setup、不碰 staging、不改 update feed 的 exe 条目。
 * 客户端侧由 dshPluginPatchManager（P1）读取 /api/dsh-plugins 并按清单装进 dsh profile。
 *
 * 用法：
 *   node build/saros/package-dsh-plugins.mjs --only vssaros-bridge,vssaros-chat-surface
 *   node build/saros/package-dsh-plugins.mjs --base <commit>       # 自动取 diff 出的插件
 *   node build/saros/package-dsh-plugins.mjs --only x --sign-key key.pem
 *   node build/saros/package-dsh-plugins.mjs --generate-key          # 生成 Ed25519 密钥对
 *
 * 选项：--out <dir>、--min-client <version>、--sign-key <pem>、--generate-key、--dry
 *
 * 安全：插件包是可执行 JS。manifest 带 sha256 只防传输损坏，防不了篡改 —— 生产必须
 * --sign-key 且客户端内置 public-key.pem 验签；未签名时本脚本输出显式警告和 signed:false。
 */

import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign as ed25519Sign } from 'node:crypto';
import {
	existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync,
	statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as tar from 'tar';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGINS_ROOT = path.join(ROOT, 'dsh-plugins');
const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const option = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const outDir = path.resolve(option('out', path.join(ROOT, 'build/saros/update-server/downloads/plugins')));
const reportPath = path.join(ROOT, '.build/pack-reports/dsh-plugin-patch.json');
const KEY_DIR = path.join(ROOT, '.build/plugin-signing');
const dry = has('dry');

function fail(message) {
	console.error(`❌ ${message}`);
	process.exit(1);
}

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** manifest 的签名字节：去掉 signature 后按插入顺序稳定序列化；客户端必须用同一规则。 */
function canonicalPayload(manifest) {
	const { signature, ...rest } = manifest;
	return JSON.stringify(rest);
}

if (has('generate-key')) {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519');
	mkdirSync(KEY_DIR, { recursive: true });
	const keyPath = path.join(KEY_DIR, 'plugin-signing-key.pem');
	const pubPath = path.join(KEY_DIR, 'public-key.pem');
	writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
	writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
	console.log(`[plugin-patch] 生成密钥对（不在下载目录）：\n  私钥（CI 凭据，勿入库）${keyPath}\n  公钥（客户端内置）${pubPath}`);
	process.exit(0);
}

const compat = readJson(path.join(PLUGINS_ROOT, 'dsh-compat.json'));
const bundled = compat.bundled;
const productVersion = readJson(path.join(ROOT, 'product.json')).version;
const minClient = option('min-client', productVersion);
if (!bundled) { fail('dsh-plugins/dsh-compat.json 缺 bundled 字段'); }

/** 解析要打包的插件目录名：--only 优先，否则从 git diff / 未跟踪文件里提取。 */
function resolveChangedPlugins() {
	const only = String(option('only', '')).split(',').map(s => s.trim()).filter(Boolean);
	if (only.length) { return [...new Set(only)].sort(); }
	const base = option('base', 'HEAD');
	let changed = [];
	try {
		changed = execFileSync('git', ['diff', '--name-only', base], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/);
		changed = changed.concat(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split(/\r?\n/));
	} catch (e) {
		fail(`读取 git 差异失败：${String(e?.message ?? e).split('\n')[0]}`);
	}
	const dirs = new Set();
	for (const raw of changed) {
		const rel = raw.replace(/\\/g, '/').trim();
		const m = /^dsh-plugins\/([^/]+)\//.exec(rel);
		if (m) { dirs.add(m[1]); }
	}
	return [...dirs].sort();
}

const pluginDirs = resolveChangedPlugins();
if (!pluginDirs.length) { fail('没有检测到变更的 dsh 插件；用 --only <pkg>[,<pkg>] 显式指定'); }

/** 静态校验：与 vssaros-plugin-resources/lib/pluginPackage.js 同源的三条硬规则。 */
function validatePlugin(dir, pkg) {
	if (!pkg.name || !pkg.version || !/^\d+\.\d+\.\d+/.test(pkg.version)) {
		fail(`${dir} 的 package.json 缺合法 name/version`);
	}
	for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
		for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
			if (typeof spec === 'string' && /^file:/i.test(spec)) {
				fail(`${pkg.name} 的 ${field}.${name} 是 file: 依赖（跨机器会断），禁止进补丁包`);
			}
		}
	}
	for (const script of ['preinstall', 'install', 'postinstall']) {
		if (pkg.scripts?.[script]) {
			fail(`${pkg.name} 含 ${script} 安装脚本，禁止进补丁包`);
		}
	}
}

/** 与 strip-before-pack.mjs 的 shippedDshPluginPath 同口径；补丁包额外排除 test/。 */
function archiveFilter(srcDir, entry) {
	const parts = entry.split(/[\\/]/).filter(p => p && p !== '.');
	if (parts.includes('node_modules') || parts.includes('.git')) { return false; }
	if (parts[0] === 'test') { return false; }
	if (parts[0] === 'dev' && existsSync(path.join(srcDir, 'dev', 'package.json'))) { return false; }
	return true;
}

const plugins = [];
mkdirSync(outDir, { recursive: true });
// 防御：早期版本曾把私钥写进下载目录，历史残留必须清掉（/downloads/** 会公开它）。
rmSync(path.join(outDir, 'plugin-signing-key.pem'), { force: true });
rmSync(path.join(outDir, 'public-key.pem'), { force: true });

for (const dirName of pluginDirs) {
	const srcDir = path.join(PLUGINS_ROOT, dirName);
	const manifestFile = path.join(srcDir, 'package.json');
	if (!existsSync(manifestFile)) { fail(`插件目录没有 package.json：${dirName}`); }
	const pkg = readJson(manifestFile);
	validatePlugin(dirName, pkg);

	const flat = pkg.name.replace(/^@/, '').replace(/\//g, '-');
	const temp = path.join(outDir, `.${flat}-${pkg.version}.part.tgz`);
	rmSync(temp, { force: true });
	if (dry) {
		console.log(`[plugin-patch] (dry) ${pkg.name}@${pkg.version} ← ${dirName}`);
		continue;
	}
	await tar.c({
		cwd: srcDir,
		file: temp,
		gzip: true,
		portable: true,
		prefix: 'package',
		follow: false,
		filter: entry => archiveFilter(srcDir, entry),
	}, ['.']);
	// 归档必须含 package/package.json，否则 dsh plugin add 装不上（与 seed-package.mjs 同判据）。
	let hasManifest = false;
	await tar.t({
		file: temp,
		onReadEntry: e => {
			if (e.path === 'package/package.json' || e.path === 'package/./package.json') { hasManifest = true; }
		},
	});
	if (!hasManifest) { rmSync(temp, { force: true }); fail(`${pkg.name} 归档里没有 package/package.json`); }

	const digest = sha256(temp);
	const fileName = `${flat}-${pkg.version}-${digest.slice(0, 12)}.tgz`;
	const target = path.join(outDir, fileName);
	rmSync(target, { force: true });
	renameSync(temp, target);
	plugins.push({
		name: pkg.name,
		version: pkg.version,
		url: `/downloads/plugins/${fileName}`,
		sha256: digest,
		size: statSync(target).size,
		source: `dsh-plugins/${dirName}`,
	});
	console.log(`[plugin-patch] ✓ ${pkg.name}@${pkg.version} → ${fileName}（${statSync(target).size} B）`);
}

if (dry) {
	console.log(`[plugin-patch] dry：${pluginDirs.length} 个插件，未写盘`);
	process.exit(0);
}

const manifest = {
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	platform: `${process.platform === 'win32' ? 'win32' : process.platform}-${process.arch}`,
	requires: { minClient, bundled },
	signature: null,
	plugins,
};

const signKeyPath = option('sign-key', '');
if (signKeyPath) {
	const keyPath = path.resolve(signKeyPath);
	if (!existsSync(keyPath)) { fail(`找不到签名私钥：${keyPath}`); }
	const privateKey = readFileSync(keyPath, 'utf8');
	manifest.signature = `ed25519:${ed25519Sign(null, Buffer.from(canonicalPayload(manifest), 'utf8'), privateKey).toString('base64')}`;
	mkdirSync(KEY_DIR, { recursive: true });
	const pubPath = path.join(KEY_DIR, 'public-key.pem');
	writeFileSync(pubPath, createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }));
	console.log(`[plugin-patch] ✓ manifest 已 Ed25519 签名，公钥写入 ${pubPath}`);
} else {
	console.warn('[plugin-patch] ⚠ 未签名（无 --sign-key）：只允许内网开发验证；生产必须签名并把 updateUrl 切 HTTPS');
}

const manifestFile = path.join(outDir, 'plugins-manifest.json');
writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({
	schemaVersion: 1,
	generatedAt: manifest.generatedAt,
	outDir,
	signed: !!manifest.signature,
	requires: manifest.requires,
	plugins: plugins.map(({ name, version, sha256: digest, size }) => ({ name, version, sha256: digest, size })),
	totalBytes: plugins.reduce((sum, p) => sum + p.size, 0),
}, null, 2) + '\n', 'utf8');
console.log(`[plugin-patch] 清单：${manifestFile}（${plugins.length} 个插件，${plugins.reduce((s, p) => s + p.size, 0)} B）`);
console.log(`[plugin-patch] 报告：${reportPath}`);
