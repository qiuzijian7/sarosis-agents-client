#!/usr/bin/env node
/**
 * set-version.mjs — VsSarosis 版本号设置脚本
 *
 * 将 product.json 的 version 字段设置为 {major}.{minor}.{commitCount} 格式。
 * 其中 major.minor 来自 product.json 当前版本的前两位，commitCount 来自 git rev-list --count HEAD。
 *
 * 用法:
 *   node build/saros/set-version.mjs
 *
 * 应在构建前运行此脚本。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const PRODUCT_JSON_PATH = resolve(ROOT, 'product.json');

function getCommitCount(repo) {
	try {
		const count = execSync('git rev-list --count HEAD', {
			cwd: repo,
			encoding: 'utf8',
			stdio: ['pipe', 'pipe', 'ignore']
		}).trim();
		return parseInt(count, 10) || 0;
	} catch {
		return 0;
	}
}

function main() {
	// 1. 读取 product.json
	let product;
	try {
		const raw = readFileSync(PRODUCT_JSON_PATH, 'utf8');
		product = JSON.parse(raw);
	} catch (e) {
		console.error(`❌ 无法读取 product.json: ${e.message}`);
		process.exit(1);
	}

	// 2. 解析当前版本，获取 major.minor
	const currentVersion = product.version || '2.1.0';
	const versionParts = currentVersion.split('.');
	const major = versionParts[0] || '2';
	const minor = versionParts[1] || '1';

	// 3. 获取 commit count
	const commitCount = getCommitCount(ROOT);

	// 4. 设置新版本号
	const newVersion = `${major}.${minor}.${commitCount}`;
	product.version = newVersion;

	// 5. 写回 product.json (保持 tab 格式)
	writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(product, null, '\t') + '\n', 'utf8');

	console.log(`✅ 版本号已更新: ${currentVersion} → ${newVersion}`);
}

main();
