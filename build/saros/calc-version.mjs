#!/usr/bin/env node
// @ts-check
/**
 * calc-version.mjs — 计算并输出版本号（供蓝盾流水线 calc_version 步骤调用）
 * ============================================================
 * 版本号格式: {major}.{a}.{b}
 *   major = 2（固定）
 *   a = floor(commitCount / 65536)
 *   b = commitCount % 65536
 *
 * 每段 < 65536，满足 Windows PE 版本资源 16 位限制。
 *
 * 输出: 仅打印版本号到 stdout（如 "2.2.25878"）
 *
 * 用法:
 *   node build/saros/calc-version.mjs
 *
 * 蓝盾流水线中 calc_version 步骤配置:
 *   BUILD_VERSION=$(node build/saros/calc-version.mjs)
 *   echo "##set-var BUILD_VERSION=$BUILD_VERSION"
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');

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

const commitCount = getCommitCount(ROOT);
const major = 2;
const a = Math.floor(commitCount / 65536);
const b = commitCount % 65536;
const version = `${major}.${a}.${b}`;

// 仅输出版本号，方便蓝盾流水线捕获
process.stdout.write(version);
