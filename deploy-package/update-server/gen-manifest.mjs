// @ts-check
/**
 * 发版辅助：为某个安装包生成 manifest 条目（计算 sha256，写回 manifest.json）
 * ------------------------------------------------------------
 * 用法：
 *   node build/saros/update-server/gen-manifest.mjs \
 *     --platform win32-x64-user \
 *     --exe ".build/win32-x64/user-setup/VsSarosUserSetup.exe" \
 *     --version 1.2.3 \
 *     --url "https://github.com/owner/repo/releases/download/v1.2.3/VsSarosUserSetup.exe"
 *
 * commit 默认从 `git rev-parse HEAD` 读取（也可 --commit 显式指定）。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(__dirname, 'manifest.json');

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const platform = arg('platform');
const exePath = arg('exe');
const productVersion = arg('version');
const downloadUrl = arg('url');
let commit = arg('commit');

if (!platform || !exePath || !productVersion || !downloadUrl) {
	console.error('缺少参数。必填：--platform --exe --version --url（可选 --commit）');
	process.exit(1);
}

if (!commit) {
	try {
		commit = execSync('git rev-parse HEAD', { cwd: path.resolve(__dirname, '..', '..', '..') }).toString().trim();
	} catch {
		console.error('无法读取 git commit，请用 --commit 显式指定');
		process.exit(1);
	}
}

if (!fs.existsSync(exePath)) {
	console.error(`找不到安装包: ${exePath}`);
	process.exit(1);
}

const buf = fs.readFileSync(exePath);
const sha256hash = crypto.createHash('sha256').update(buf).digest('hex');

/** @type {Record<string, any>} */
let manifest = {};
if (fs.existsSync(MANIFEST_PATH)) {
	manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

manifest[platform] = {
	version: commit,
	productVersion,
	url: downloadUrl,
	sha256hash,
	timestamp: Date.now()
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(`✓ 已更新 manifest[${platform}]`);
console.log(`    commit:         ${commit}`);
console.log(`    productVersion: ${productVersion}`);
console.log(`    sha256:         ${sha256hash}`);
console.log(`    url:            ${downloadUrl}`);
console.log(`\n提示：把这行写入 GitHub Release body 以便 Worker 解析 sha256：`);
console.log(`    sha256-${platform}: ${sha256hash}`);
