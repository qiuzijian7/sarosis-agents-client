#!/usr/bin/env node
/**
 * set-version.mjs — VsSarosis 版本号设置脚本
 *
 * 将 product.json 的 version 字段设置为 {major}.{a}.{b} 格式。
 *   a = floor(commitCount / 65536)  — 进位段，每 65536 次提交 +1
 *   b = commitCount % 65536          — 余数段，范围 0-65535
 * 这样每段均 < 65536，满足 Windows PE 版本资源 16 位限制。
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

	// 2. 解析当前版本，获取 major（固定为 2）
	const currentVersion = product.version || '2.0.0';
	const versionParts = currentVersion.split('.');
	const major = versionParts[0] || '2';

	// 3. 获取 commit count
	const commitCount = getCommitCount(ROOT);

	// 4. 设置新版本号: {major}.{a}.{b}
	//    a = floor(commitCount / 65536), b = commitCount % 65536
	//    每段均 < 65536，满足 Windows PE 版本资源 16 位限制
	const a = Math.floor(commitCount / 65536);
	const b = commitCount % 65536;
	const newVersion = `${major}.${a}.${b}`;

	// 如果版本号没有变化，跳过写入
	if (product.version === newVersion) {
		console.log(`ℹ️  版本号无变化: ${newVersion}`);
		return;
	}

	product.version = newVersion;

	// 5. 写回 product.json (保持 tab 格式)
	writeFileSync(PRODUCT_JSON_PATH, JSON.stringify(product, null, '\t') + '\n', 'utf8');

	console.log(`✅ 版本号已更新: ${currentVersion} → ${newVersion}`);
}

main();
