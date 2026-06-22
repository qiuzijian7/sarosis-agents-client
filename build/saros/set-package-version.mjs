#!/usr/bin/env node
/**
 * set-package-version.mjs — 自动更新 package.json 版本号
 *
 * 版本号格式: {major}.{minor}.{commitCount}
 * 与 build/saros/set-version.mjs 保持一致的版本号规则
 *
 * 用法:
 *   node build/saros/set-package-version.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = resolve(ROOT, 'package.json');

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

function main() {
	// 1. 读取 package.json
	let pkg;
	try {
		const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
		pkg = JSON.parse(raw);
	} catch (e) {
		console.error(`❌ 无法读取 package.json: ${e.message}`);
		process.exit(1);
	}

	// 2. 解析当前版本，获取 major.minor
	const currentVersion = pkg.version || '2.1.0';
	const versionParts = currentVersion.split('.');
	const major = versionParts[0] || '2';
	const minor = versionParts[1] || '1';

	// 3. 获取 commit count
	const commitCount = getCommitCount(ROOT);

	// 4. 设置新版本号
	const newVersion = `${major}.${minor}.${commitCount}`;

	// 如果版本号没有变化，跳过
	if (pkg.version === newVersion) {
		console.log(`ℹ️  版本号无变化: ${newVersion}`);
		return;
	}

	pkg.version = newVersion;

	// 5. 写回 package.json (保持 2 空格缩进，符合原文件风格)
	writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

	console.log(`✅ package.json 版本号已更新: ${currentVersion} → ${newVersion}`);
}

main();
