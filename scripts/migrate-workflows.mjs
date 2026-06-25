#!/usr/bin/env node
/**
 * migrate-workflows.mjs
 * 将工作流从工作区级 .sarosworkspace/workflows/ 迁移到用户级 ~/.saros/workflows/
 * 运行一次即可，迁移后原位置文件会被删除。
 */

import { statSync, readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const ROOT = resolve(__dirname, '..');

// 源目录：工作区根目录下的 .sarosworkspace/workflows/
const SRC_DIR = resolve(ROOT, '.sarosworkspace', 'workflows');
// 目标目录：用户主目录下的 .saros/workflows/
const DEST_DIR = join(homedir(), '.saros', 'workflows');

function migrate() {
	console.log(`[migrate] Source: ${SRC_DIR}`);
	console.log(`[migrate] Destination: ${DEST_DIR}`);

	// 检查源目录是否存在
	let srcExists = false;
	try {
		const stat = statSync(SRC_DIR);
		srcExists = stat.isDirectory();
	} catch {
		srcExists = false;
	}

	if (!srcExists) {
		console.log('[migrate] Source directory does not exist, nothing to migrate.');
		return;
	}

	// 创建目标目录
	try {
		mkdirSync(DEST_DIR, { recursive: true });
		console.log(`[migrate] Created destination directory: ${DEST_DIR}`);
	} catch (err) {
		console.error(`[migrate] Failed to create destination directory: ${err.message}`);
		process.exit(1);
	}

	// 读取源目录中的文件
	const files = readdirSync(SRC_DIR);
	const jsonFiles = files.filter(f => f.endsWith('.json'));

	if (jsonFiles.length === 0) {
		console.log('[migrate] No workflow files found in source directory.');
		return;
	}

	console.log(`[migrate] Found ${jsonFiles.length} workflow file(s) to migrate:`);

	let migrated = 0;
	let skipped = 0;

	for (const file of jsonFiles) {
		const srcPath = join(SRC_DIR, file);
		const destPath = join(DEST_DIR, file);

		// 检查目标文件是否已存在
		try {
			statSync(destPath);
			console.log(`  [skip] ${file} (already exists at destination)`);
			skipped++;
			continue;
		} catch {
			// 文件不存在，可以迁移
		}

		try {
			const content = readFileSync(srcPath, 'utf-8');
			// 验证 JSON 格式
			JSON.parse(content);
			// 写入目标文件
			writeFileSync(destPath, content, 'utf-8');
			console.log(`  [migrated] ${file}`);
			migrated++;
		} catch (err) {
			console.error(`  [error] Failed to migrate ${file}: ${err.message}`);
			continue;
		}
	}

	console.log(`\n[migrate] Migration complete: ${migrated} migrated, ${skipped} skipped.`);

	// 询问是否删除源目录
	console.log(`\n[migrate] To delete the source directory, run:`);
	console.log(`  rm -rf "${SRC_DIR}"`);
	console.log(`  Or on Windows PowerShell:`);
	console.log(`  Remove-Item -Recurse -Force "${SRC_DIR}"`);
}

migrate();
