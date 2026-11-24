#!/usr/bin/env node
/**
 * sync-dsh-plugins.mjs — 插件级快包：把仓库 `dsh-plugins/` 按内容差异同步进**已有**暂存目录。
 *
 * 为什么需要它：发布流水线把 dsh 插件当纯资源拷贝到 `<appPath>/dsh-plugins/`（不进 asar，
 * 见 build/gulpfile.vscode.ts 的 dshPlugins 资源流），它们不参与 tsc / webpack。改几个插件时
 * 重跑整条编译链纯属浪费。本脚本只做「资源替换」，不碰内核产物。
 *
 * 与 strip-before-pack.mjs 的关系：那边的 `ensureDir('dsh-plugins', …, {refresh:true})` 是
 * **整目录 rm + cp**；本脚本按 sha256 只写差异文件，并复用同一份 `shippedDshPluginPath`
 * 过滤口径与逐文件完整性校验（缺一个文件 ⇒ 用户侧 import 失败 / 主页白屏）。
 *
 * 用法：
 *   node build/saros/sync-dsh-plugins.mjs [--staging <dir>] [--only a,b] [--sync-seed]
 *        [--dry] [--report <file>]
 *
 *   --staging    产物根，默认 ../VSCode-win32-x64（macOS 会自动下钻 *.app）
 *   --only       只同步指定插件目录（逗号分隔），根级文件（dsh-compat.json 等）始终同步
 *   --sync-seed  同时把 dsh-runtime/<bundled>/ 整目录刷新进暂存（bump 插件版本后需要）
 *   --dry        只统计不写盘
 *   --report     统计 JSON，默认 .build/pack-reports/quick-sync.json
 */

import { createHash } from 'node:crypto';
import {
	copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
	rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'dsh-plugins');
const args = process.argv.slice(2);
const has = name => args.includes(`--${name}`);
const option = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const only = new Set(String(option('only', '')).split(',').map(s => s.trim()).filter(Boolean));
const dry = has('dry');
const stagingArg = path.resolve(option('staging', path.join(ROOT, '../VSCode-win32-x64')));
const reportPath = path.resolve(option('report', path.join(ROOT, '.build/pack-reports/quick-sync.json')));

function fail(message) {
	console.error(`❌ ${message}`);
	process.exit(1);
}

/** 与 strip-before-pack.mjs 的 shippedDshPluginPath 同一判据。 */
function shipped(rel) {
	const parts = rel.split(/[\\/]/).filter(Boolean);
	if (parts.includes('node_modules')) { return false; }
	return !(parts.length >= 2 && parts[1] === 'dev'
		&& existsSync(path.join(SRC, parts[0], 'dev', 'package.json')));
}

/** `--only` 限定插件目录；根级文件（dsh-compat.json / preset-sync.mjs …）始终在范围内。 */
function inScope(rel) {
	if (!only.size) { return true; }
	const parts = rel.split(/[\\/]/);
	return parts.length === 1 || only.has(parts[0]);
}

/** 相对路径 -> 统一 `/` 分隔符，返回排序后的文件清单（目录也过 filter，可整棵排除 dev/）。 */
function walk(root, dir = '', out = []) {
	let entries;
	try {
		entries = readdirSync(path.join(root, dir), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const rel = dir ? `${dir}/${entry.name}` : entry.name;
		if (entry.isDirectory() && entry.name === 'node_modules') { continue; }
		if (!shipped(rel) || !inScope(rel)) { continue; }
		if (entry.isDirectory()) {
			walk(root, rel, out);
		} else if (entry.isFile()) {
			out.push(rel);
		}
	}
	return out.sort();
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');

/** 产物根 -> app 目录（Windows: resources/app；macOS: <Name>.app/Contents/Resources/app）。 */
function resolveAppRoot(dir) {
	const candidates = [dir];
	try {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.endsWith('.app')) { candidates.push(path.join(dir, entry.name)); }
		}
	} catch { /* 目录不可读 ⇒ 只试 dir 本身 */ }
	for (const candidate of candidates) {
		for (const sub of ['resources/app', 'Contents/Resources/app']) {
			if (existsSync(path.join(candidate, ...sub.split('/')))) {
				return path.join(candidate, ...sub.split('/'));
			}
		}
	}
	return null;
}

const appRoot = resolveAppRoot(stagingArg);
if (!appRoot) { fail(`找不到产物 app 目录：${stagingArg}（先跑一次全量 package-vscode 生成基线暂存）`); }
const DST = path.join(appRoot, 'dsh-plugins');
if (!existsSync(DST)) { fail(`暂存里没有 dsh-plugins/：${DST}`); }

const sourceFiles = walk(SRC);
const targetFiles = walk(DST);
const sourceSet = new Set(sourceFiles);
const added = [];
const updated = [];
let unchanged = 0;

for (const rel of sourceFiles) {
	const from = path.join(SRC, ...rel.split('/'));
	const to = path.join(DST, ...rel.split('/'));
	let needWrite = !existsSync(to);
	if (!needWrite) {
		try {
			needWrite = statSync(from).size !== statSync(to).size || sha256(from) !== sha256(to);
		} catch {
			needWrite = true;
		}
	}
	if (!needWrite) { unchanged++; continue; }
	(existsSync(to) ? updated : added).push(rel);
	if (!dry) {
		mkdirSync(path.dirname(to), { recursive: true });
		copyFileSync(from, to);
	}
}

/** 仓库已删的文件必须一起删掉，否则旧 client.js / 旧 patch 会被打进包。 */
const removed = targetFiles.filter(rel => !sourceSet.has(rel));
if (!dry) {
	for (const rel of removed) {
		rmSync(path.join(DST, ...rel.split('/')), { force: true });
	}
}

console.log(`[sync-dsh] 暂存：${appRoot}`);
console.log(`[sync-dsh] 插件文件：新增 ${added.length} / 更新 ${updated.length} / 删除 ${removed.length} / 未变 ${unchanged}${dry ? '（dry，不写盘）' : ''}`);
if (only.size) { console.log(`[sync-dsh] 限定插件：${[...only].join(', ')}`); }

/** 逐文件复核（与 strip-before-pack.mjs 的 verifyDshPluginsComplete 同口径，写盘后必做）。 */
if (!dry) {
	const mismatches = [];
	for (const rel of sourceFiles) {
		const from = path.join(SRC, ...rel.split('/'));
		const to = path.join(DST, ...rel.split('/'));
		if (!existsSync(to) || sha256(from) !== sha256(to)) { mismatches.push(rel); }
	}
	if (mismatches.length) {
		fail(`同步后仍有 ${mismatches.length} 个文件与仓库不一致（例：${mismatches.slice(0, 5).join('、')}）⇒ 禁止出包`);
	}
	console.log(`[sync-dsh] ✅ 完整性：${sourceFiles.length} 个文件与仓库逐一对齐`);
}

/** seed 重建后需要把 dsh-runtime/<bundled>/ 一起刷新（含 profile-seed）。与 strip 的 refresh 同口径。 */
let seedRefreshed = false;
if (has('sync-seed')) {
	const compat = JSON.parse(readFileSync(path.join(SRC, 'dsh-compat.json'), 'utf8'));
	const version = compat.bundled;
	if (!version) { fail('dsh-compat.json 缺 bundled 字段'); }
	const seedSrc = path.join(ROOT, 'dsh-runtime', version);
	const seedDst = path.join(appRoot, 'dsh-runtime', version);
	if (!existsSync(path.join(seedSrc, 'profile-seed', 'seed.json'))) {
		fail(`仓库侧没有可用的 profile 种子：${path.join(seedSrc, 'profile-seed', 'seed.json')}（先跑 prepack-dsh-runtime）`);
	}
	if (!dry) {
		rmSync(seedDst, { recursive: true, force: true });
		mkdirSync(seedDst, { recursive: true });
		// 排除 prepack 删不掉而挪开的 *.deleting-<pid> 残留（超长路径会让 Inno 的 restartreplace 报错 3）
		cpSync(seedSrc, seedDst, {
			recursive: true,
			filter: src => !path.relative(seedSrc, src).split(/[\\/]/).some(part => /\.deleting-\d+$/.test(part)),
		});
		if (!existsSync(path.join(seedDst, 'profile-seed', 'seed.json'))) {
			fail('profile 种子没有刷进暂存');
		}
	}
	seedRefreshed = true;
	console.log(`[sync-dsh] ♻️  dsh-runtime/${version} 已刷新（含 profile-seed）`);
}

mkdirSync(path.dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({
	schemaVersion: 1,
	generatedAt: new Date().toISOString(),
	staging: stagingArg,
	appRoot,
	only: [...only],
	dry,
	files: { total: sourceFiles.length, added, updated, removed, unchanged },
	seedRefreshed,
	verified: !dry,
}, null, 2) + '\n', 'utf8');
console.log(`[sync-dsh] 报告：${reportPath}`);
