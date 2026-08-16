#!/usr/bin/env node
// @ts-check
/**
 * set-all-versions.mjs — 一次性更新 product.json 和 package.json 版本号
 * ============================================================
 * 解决 set-version.mjs 和 set-package-version.mjs 分别调用 git rev-list
 * 导致 commitCount 可能不一致的问题。
 *
 * 版本号格式: {major}.{a}.{b}
 *   a = floor(commitCount / 65536)  — 进位段，每 65536 次提交 +1
 *   b = commitCount % 65536          — 余数段，范围 0-65535
 * 每段 < 65536，满足 Windows PE 版本资源 16 位限制。
 *
 * 用法:
 *   node build/saros/set-all-versions.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const PRODUCT_JSON_PATH = resolve(ROOT, 'product.json');
const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');

/**
 * 获取 git commit 总数（只调用一次，保证一致性）
 */
function getCommitCount(repo) {
	try {
		const count = execSync('git rev-list --count HEAD', {
			cwd: repo,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore'],
		}).trim();
		return parseInt(count, 10) || 0;
	} catch {
		return 0;
	}
}

/**
 * 根据 commitCount 计算版本号: {major}.{a}.{b}
 */
function computeVersion(commitCount, major = '2') {
	const a = Math.floor(commitCount / 65536);
	const b = commitCount % 65536;
	return `${major}.${a}.${b}`;
}

function main() {
	// 1. 一次性获取 commitCount（两个文件共享）
	const commitCount = getCommitCount(ROOT);
	const newVersion = computeVersion(commitCount);

	console.log(`📦 commitCount=${commitCount} → version=${newVersion}`);

	let changed = false;

	// 2. 更新 product.json（tab 缩进）
	try {
		const product = JSON.parse(readFileSync(PRODUCT_JSON_PATH, 'utf8'));
		if (product.version !== newVersion) {
			console.log(`  product.json: ${product.version || '(空)'} → ${newVersion}`);
			product.version = newVersion;
			writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(product, null, '\t') + '\n', 'utf8');
			changed = true;
		}
	} catch (e) {
		console.error(`❌ 更新 product.json 失败: ${e.message}`);
	}

	// 3. 更新 package.json（2 空格缩进）
	try {
		const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf8'));
		if (pkg.version !== newVersion) {
			console.log(`  package.json: ${pkg.version || '(空)'} → ${newVersion}`);
			pkg.version = newVersion;
			writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
			changed = true;
		}
	} catch (e) {
		console.error(`❌ 更新 package.json 失败: ${e.message}`);
	}

	if (!changed) {
		console.log('ℹ️  版本号无变化，跳过写入');
	}
}

main();
